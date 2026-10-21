# pi-easy-bg

Background shell tasks for [pi](https://pi.dev): start long commands without blocking the chat, then inspect their status and logs when you need them.

```
/easy-bg --name build make -j8
  bg-3f9a2c RUNNING 2s                       ← you keep typing

  ■ background [easy-bg] bg-3f9a2c "build" DONE exit=0 in 47s
    … build output …
    /easy-bg ls · /easy-bg log bg-3f9a2c · /easy-bg now bg-3f9a2c (optional)
```

## Why

pi's built-in `bash` tool is synchronous: one command owns the turn until it returns. For anything longer than a few seconds — builds, test suites, fetches, CI checks — the chat is stuck, and asking the model to poll (`sleep` → `tail` → `sleep`) keeps the turn blocked and floods the context.

`pi-easy-bg` moves the waiting out of the turn:

- **Start returns immediately.** The command runs detached in its own process group.
- **Parallelism lives in the harness.** One call starts N commands; one `status` reports all of them.
- **Results are visible but passive.** A task shows a display-only card when it finishes; you or the agent can explicitly inspect its status and log.
- **Results never hijack your work by default.** The card does not enter model context or start a turn. Opt in to `now` or `watch` only if you want an automatic wake-up.
- **Survives restarts.** State and logs are on disk; a later session adopts tasks that are still running.

## Install

```bash
pi install git:github.com/mattshen/pi-easy-bg
```

Or try it for one run:

```bash
pi -e git:github.com/mattshen/pi-easy-bg
```

Manual install: copy `extensions/easy-bg.ts` into `~/.pi/agent/extensions/` and run `/reload`.

Uninstall: `pi remove git:github.com/mattshen/pi-easy-bg`.

## Quick start

```bash
/easy-bg --name build make -j8                  # start, returns at once
/easy-bg ls                                     # what is running / finished
/easy-bg log bg-3f9a2c 80                       # tail 80 lines
/easy-bg stop bg-3f9a2c                         # kill the whole process group
/easy-bg now                                    # hand parked results to the model now
```

Start several at once (one call, not N tool calls):

```bash
/easy-bg --name test bash -c 'pnpm test'
```

With the model-facing tool, one call can fan out:

```json
{ "action": "run", "name": "ci", "command": ["pnpm lint", "pnpm test", "pnpm build"] }
```

## Delivery modes

The default is `park`: a finished task shows a **display-only** card. It does not enter model context, attach to your next question, or start a turn. People can check `/easy-bg ls` and `/easy-bg log <id>`; agents can call `easy_bg` with `action=status`, `results` (several tasks at once), or `logs`. These actions do not start another turn. Avoid polling in a tight loop: check when you next need the result.

| `--notify` | Behaviour |
|---|---|
| `park` *(default)* | Card only. Check status/logs yourself, or explicitly deliver with `/easy-bg now`. |
| `now` | Opt in to a model turn when the task finishes. |
| `manual` | No card or message. Same as `--no-notify`; status/logs remain available. |

`/easy-bg now [id]` explicitly hands parked results to the model (queued until idle if it is busy). `--watch <pattern>` explicitly wakes the model once on matching output. These and `--notify now` are the only automatic wake-ups; there is no idle-time delivery.

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
| `/easy-bg log <id> [lines]` | Tail a log (default 40 lines) |
| `/easy-bg stop <id>` | Kill the task's process group |
| `/easy-bg now [id]` | Deliver parked results (all, or one) |
| `/easy-bg clear` | Drop **this session's** already-handled finished tasks |
| `/easy-bg clear --all` | Drop every finished task, all sessions, including unhandled results |
| `/easy-bg help` | Usage |

Flags: `--name <label>`, `--timeout <sec|0>`, `--watch <substring|/regex/flags>`, `--notify <park|now|manual>`, `--no-notify`.

`<id>` accepts a unique prefix (`bg-3f`). An ambiguous prefix lists the candidates instead of guessing.

`clear` never deletes a running task, never deletes an unhandled result, and never touches other pi sessions unless you pass `--all`. It reports what it did, e.g. `3 cleared · 1 unhandled kept → /easy-bg now · 1 from other sessions kept → /easy-bg clear --all · 1 running untouched`.

## Model tool

One tool, `easy_bg`, with an `action` enum — easy for small models to use correctly:

| action | Arguments |
|---|---|
| `run` | `command: string[]` (1..N, one task each), `name?`, `timeout?`, `watch?`, `notify?` |
| `status` | — (aggregate of this session's tasks) |
| `results` | `tasks?` (up to 10 ids/unique prefixes; omitted = latest 10 finished tasks in this session), or `task?` for one; `lines?` (default 30, max 100 per task) |
| `logs` | `task` (id or unique prefix), `lines?` (default 30, max 400) |
| `stop` | `task` |
| `clear` | — |

After `run`, the model can do other work or end its turn. When asked to summarize multiple tasks, it can use `results` to read their status and output in one tool response, then answer in the **same turn**. `results` is read-only: it does not open another turn or mark results handled. Explicit ids can include running tasks (with partial output) or tasks from another session; with no ids, only finished tasks in this session are selected. At most 4,000 characters of output per task are included; use `logs` for more. If the agent has already ended its turn, a new user message is needed before it can call the tool. `pi --no-easy-bg-tool` hides the tool and leaves only the slash commands.

## Configuration

| Setting | Default | Via |
|---|---|---|
| State directory | `~/.pi/agent/easy-bg/` | `EASY_BG_DIR` |
| Timeout | 600s (`0` = none) | `--timeout`, `EASY_BG_TIMEOUT_SEC` |
| Output cap | 20 MiB | `EASY_BG_MAX_BYTES` |
| Shell for non-shebang commands | `/bin/bash` | `EASY_BG_SHELL` |
| Default delivery mode | `park` | `EASY_BG_NOTIFY` (`park`, `now`, `manual`) |
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

Task ids are random and never reused, so logs and dedupe keys can not collide after `clear`, GC, or a restart. Running tasks are adopted by the next pi session that sees them (heartbeat lease).

## Development

```bash
git clone https://github.com/mattshen/pi-easy-bg
cd pi-easy-bg
npm run verify                    # import check + unit tests, no install step (Node >= 22.18)
pi -e .                           # load the working copy for one run
```

`src/core.ts` holds every piece of plain logic (state files, ids, log tails, status
resolution, task spawning, watch patterns, formatting) and imports nothing from pi, so it
is unit-testable with `node --test`. `extensions/easy-bg.ts` is only the pi integration
(tool, slash command, cards, observation loop, delivery).

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

- [User manual](docs/user-manual.md) — every command, mode and failure mode
- [examples/demo-task.sh](examples/demo-task.sh) — a 10-second task that prints three offers, useful for trying the whole flow
- Reference specification: [mattshen/my-docs#62](https://github.com/mattshen/my-docs/issues/62)

## License

MIT © Matt Shen
