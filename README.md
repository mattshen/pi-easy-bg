# pi-easy-bg

Background shell tasks for [pi](https://pi.dev): start long commands without blocking the chat, then inspect their status and logs when you need them.

```
/easy-bg --name build make -j8
  bg-3f9a2c RUNNING 2s                       ← you keep typing

  # later (completion is silent):
/easy-bg ls                                     # DONE exit=0
/easy-bg inspect bg-3f9a2c                      # read output
/easy-bg handle bg-3f9a2c                       # ask the model to handle it
```

## Why

pi's built-in `bash` tool is synchronous: one command owns the turn until it returns. For anything longer than a few seconds — builds, test suites, fetches, CI checks — the chat is stuck, and asking the model to poll (`sleep` → `tail` → `sleep`) keeps the turn blocked and floods the context.

`pi-easy-bg` moves the waiting out of the turn:

- **Start returns immediately.** The command runs detached in its own process group.
- **Parallelism lives in the harness.** One call starts N commands; one `status` reports all of them.
- **Completion is silent.** You or the agent explicitly check status/logs and handle results when needed; no automatic turn or result card.
- **Survives restarts.** State and logs are on disk; a later session adopts tasks that are still running.

## Install

```bash
pi install git:github.com/mattshen/pi-easy-bg
```

Or try it for one run:

```bash
pi -e git:github.com/mattshen/pi-easy-bg
```

Uninstall: `pi remove git:github.com/mattshen/pi-easy-bg`.

## Quick start

```bash
/easy-bg --name build make -j8                  # start, returns at once
/easy-bg ls                                     # what is running / finished
/easy-bg inspect bg-3f9a2c 80                   # tail 80 lines without handling
/easy-bg stop bg-3f9a2c                         # kill the whole process group
/easy-bg handle                                 # hand unhandled finished results to the model
```

Start several tasks in one model-tool call:

```json
{ "action": "run", "name": "ci", "command": ["pnpm lint", "pnpm test", "pnpm build"] }
```

## Results

Task completion does not notify or open a turn. `/easy-bg ls` and `inspect` read status and logs without handling; `/easy-bg handle [id]` sends unhandled finished results to the model in a new turn (queued as a follow-up if busy). Without an id, it handles all unhandled finished results in this session. The agent can call `easy_bg` with `action=handle` to receive results in its current turn. Handled tasks remain listed until cleared or pruned. Avoid polling in a tight loop.

## Task states

| State | Meaning | Exit code shown |
|---|---|---|
| `RUNNING` | still working | no |
| `DONE` | ended by itself, exit 0 | yes |
| `FAIL` | ended by itself, non-zero exit | yes |
| `KILLED` | you stopped it (`/easy-bg stop`) | no |
| `TIMEOUT` | `--timeout` expired | no |
| `OUTPUT_CAP` | log grew past `EASY_BG_MAX_BYTES` | no |
| `EXITED` | process vanished, no exit code available (`kill -9`, OOM) | no |

Termination reasons win over exit codes: a task killed with SIGTERM is `KILLED`/`TIMEOUT`, not `DONE exit=0`.

## Multi-line commands, any language

The command text is written to a file verbatim — no re-quoting, no escaping — so multi-line scripts and heredocs work:

```bash
/easy-bg --name report python3 - <<'PY'
import json
print(json.dumps([{"model": "5090", "price": 2299}], indent=2))
PY
```

Start the text with `#!` and it is treated as a complete script, executed by the kernel via that shebang (`python3`, `node`, `bash`, anything):

```bash
/easy-bg --name check #!/usr/bin/env python3
import sys
print("python", sys.version_info[:2])
sys.exit(4)          # -> FAIL exit=4
```

Exit codes are captured with an `EXIT` trap, so `set -e` failures and explicit `exit N` / `sys.exit(N)` are reported correctly instead of degrading to `EXITED`.

## User commands

| Command | Purpose |
|---|---|
| `/easy-bg <command>` | Start a task (bare form of `run`) |
| `/easy-bg run [flags] <command>` | Same, explicit |
| `/easy-bg ls` | List running and finished tasks |
| `/easy-bg inspect <id> [lines]` | Tail a log without handling (default 40 lines) |
| `/easy-bg stop <id>` | Kill the task's process group |
| `/easy-bg handle [id]` | Hand unhandled finished results to the model (all, or one) |
| `/easy-bg clear` | Drop **this session's** already-handled finished tasks |
| `/easy-bg clear --all` | Drop every finished task, all sessions, including unhandled results |
| `/easy-bg help` | Usage |

Flags: `--name <label>`, `--timeout <sec|0>`.

`<id>` accepts a unique prefix (`bg-3f`). An ambiguous prefix lists the candidates instead of guessing.

`clear` keeps running tasks, unhandled results, and other sessions' tasks. `clear --all` removes finished tasks across sessions.

## Model tool

One tool, `easy_bg`, with an `action` enum — easy for small models to use correctly:

| action | Arguments |
|---|---|
| `run` | `command: string[]` (1..N, one task each), `name?`, `timeout?` |
| `status` | — (aggregate of this session's tasks) |
| `handle` | `tasks?` (up to 10 ids/unique prefixes; omitted = up to 10 unhandled finished results in this session), or `task?` for one; `lines?` (default 30, max 100 per task) |
| `inspect` | `task` (id or unique prefix), `lines?` (default 30, max 400) |
| `stop` | `task` |
| `clear` | — |

After `run`, the agent can do other work or end its turn. `handle` returns status and output in the **current turn**, marking finished tasks handled; running tasks selected explicitly stay unhandled. Explicit ids may refer to other sessions; without ids, it takes up to 10 unhandled finished tasks from this session, oldest first (unlike the unlimited slash command). Each task returns at most 4,000 log characters; use `inspect` for more. If the agent has ended its turn, it needs a new user message to call the tool. `pi --no-easy-bg-tool` hides the tool.

## Configuration

| Setting | Default | Via |
|---|---|---|
| State directory | `~/.pi/agent/easy-bg/` | `EASY_BG_DIR` |
| Timeout | 600s (`0` = none) | `--timeout`, `EASY_BG_TIMEOUT_SEC` |
| Output cap | 20 MiB | `EASY_BG_MAX_BYTES` |
| Shell for non-shebang commands | `/bin/bash` | `EASY_BG_SHELL` |
| Concurrent tasks | 8 | constant |
| Retention | 7 days / 50 finished tasks | constants |
| Hide the model tool | off | `pi --no-easy-bg-tool` |
| Kill tasks when pi exits | off (tasks are adopted later) | `pi --easy-bg-kill-all` |

## State layout

```
~/.pi/agent/easy-bg/
├── tasks.json              # metadata, atomic write (tmp + rename)
└── bg-<6hex>/
    ├── cmd.sh              # sh wrapper: EXIT trap + your command
    ├── run.user            # only for `#!` commands: the script itself, chmod 0755
    ├── out.log             # stdout + stderr
    └── exit                # exit code written by the wrapper's trap
```

Task ids are random and checked against current records for collisions. A later pi session can adopt running tasks after their heartbeat lease expires.

## Development

```bash
git clone https://github.com/mattshen/pi-easy-bg
cd pi-easy-bg
npm run verify                    # import check + unit tests, no install step (Node >= 22.18)
pi -e .                           # load the working copy for one run
```

`src/core.ts` holds every piece of plain logic (state files, ids, log tails, status
resolution, task spawning, formatting) and imports nothing from pi, so it
is unit-testable with `node --test`. `extensions/easy-bg.ts` provides the tool,
slash command, and task observation loop.

### Known limitations

- The output cap is enforced by polling the log size (`CAP_CHECK_MS`, 100 ms). A command
  that writes extremely fast (for example `yes`) can exceed the cap between two checks.
  Measurement: a bare `yes` against a 400-byte cap peaks around 80 MiB before the process
  group is killed and the log is truncated back to the cap. With the default 20 MiB cap
  this is not a practical concern, but it is not a kernel-level limit.
- Tasks are killed by process group, so a command that deliberately detaches itself
  (`setsid`, `nohup … &`) escapes the kill.
- Terminal state is recorded when the wrapper process exits, not when all descendants
  exit: `cmd &` without `wait` ends the task while children keep running.

## Documentation

- [User manual](docs/user-manual.md) — commands and troubleshooting
- [examples/demo-task.sh](examples/demo-task.sh) — a 10-second task that prints three offers, useful for trying the whole flow
- Reference specification: [mattshen/my-docs#62](https://github.com/mattshen/my-docs/issues/62)

## License

MIT © Matt Shen
