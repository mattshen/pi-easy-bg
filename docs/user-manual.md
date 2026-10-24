# pi-easy-bg — User Manual

Run long shell commands without blocking pi's chat. Completion is **silent**: no result card, notification, or automatic model turn. Check tasks when you need their results. Use built-in `bash` for short commands.

## Start and check

```text
/easy-bg --name build make -j8          # start; returns a task id
/easy-bg ls                             # list running and finished tasks
/easy-bg inspect bg-3f9a2c 80           # last 80 log lines; read-only
/easy-bg stop bg-3f9a2c                 # signal the process group
/easy-bg handle                         # hand this session's unhandled finished results to the model
/easy-bg handle bg-3f9a2c               # hand one unhandled finished result to the model
```

`/easy-bg <command>` is shorthand for `/easy-bg run <command>`. `--name <label>` sets a label. `--timeout <seconds>` sets the time limit (default 600; `0` means no limit, useful for a dev server). Commands return immediately; up to 8 tasks can run at once. Task ids are random (`bg-3f9a2c`); commands accept a unique id prefix. An ambiguous prefix is rejected.

A command can span lines, including heredocs. easy-bg writes the text to a script file without re-quoting it. If it begins with `#!`, the kernel runs it using that shebang. The wrapper records exit codes even for `set -e` and `exit N`.

```text
/easy-bg --name report python3 - <<'PY'
print("done")
PY
```

The wrapper determines when the task finishes. A command like `sleep 30 & echo done` can finish immediately while `sleep` continues; add `wait` to keep the task open until the child exits.

## Read and handle results

`/easy-bg ls` lists recorded tasks without using model tokens. `/easy-bg inspect <id> [lines]` reads a log (40 lines by default) without marking the task handled. You can also read `~/.pi/agent/easy-bg/<id>/out.log` directly.

`/easy-bg handle` sends **all** unhandled finished results in the current session to the model in a new turn; an id limits it to one. When the model is busy, the requested turn is queued as a follow-up. Finished tasks are marked handled when the request is accepted. They remain in `ls` until cleared or pruned. A running task is not handed over by the slash command.

The agent can use the `easy_bg` tool instead:

| `action` | Effect |
|---|---|
| `run` | Start one or more commands with `command: string[]`; optional `name`, `timeout` |
| `status` | List tasks in this session (and running tasks) |
| `inspect` | Read one log with `task` and optional `lines` (default 30, max 400); does not handle |
| `handle` | Return status and log output in the **current** turn, marking finished tasks handled |
| `stop` | Signal one task's process group (`task`) |
| `clear` | Delete this session's handled finished records and logs |

Without `tasks`, tool `handle` takes the oldest **up to 10** unhandled finished tasks in this session; repeat it for the rest. Set `tasks: ["bg-...", ...]` (or `task` for one) to choose specific ids, including other sessions' or running tasks. Running tasks return partial output but stay unhandled. Each task returns up to 4,000 log characters (default 30, max 100 lines); use `inspect` for more. The agent cannot call the tool after its turn ends until another user message starts a turn. Avoid tight polling loops: do other work, or check back later.

## Status and cleanup

| Status | Meaning |
|---|---|
| `RUNNING` | Still running |
| `DONE` / `FAIL` | Exited with code 0 / non-zero |
| `KILLED` | Stopped with `stop` |
| `TIMEOUT` | Time limit reached |
| `OUTPUT_CAP` | Log size limit reached |
| `EXITED` | Process vanished without a recorded exit code |

A stop reason takes precedence over the recorded exit code. Status observation can lag by up to 1.5 seconds.

`/easy-bg clear` keeps running tasks, this session's unhandled results, and all other sessions' records. `/easy-bg clear --all` deletes finished records across sessions, **including unhandled results**, but keeps running tasks. Automatic pruning also removes finished tasks and logs after 7 days or beyond the 50 most recent finished tasks, even if unhandled.

## Configuration

| Setting | Default |
|---|---|
| `EASY_BG_DIR` (state/log directory) | `~/.pi/agent/easy-bg/` |
| `EASY_BG_TIMEOUT_SEC` | 600 seconds |
| `EASY_BG_MAX_BYTES` | 20 MiB per task |
| `EASY_BG_SHELL` (non-shebang commands) | `/bin/bash` |
| `EASY_BG_KEY` | unset (optional shortcut to list tasks) |
| `pi --no-easy-bg-tool` | model tool enabled |
| `pi --easy-bg-kill-all` | tasks keep running on exit |

When pi closes, running tasks normally keep running; a later session can adopt them after the lease expires. `stop` signals the process group, but children that deliberately detach (`setsid`, `nohup … &`) can escape it. The output cap is checked periodically, so very fast output can briefly exceed the cap before the log is truncated.

## Problems

| Symptom | What to do |
|---|---|
| No result appears | Normal. Use `ls`, `inspect`, or `handle`. |
| `no such task` | Check `ls`; the record may have been cleared or pruned. |
| `ambiguous id prefix` | Type more of the id. |
| Task limit (8 running) | Stop an unneeded task. |
| `TIMEOUT` | Increase `--timeout`, or set it to `0`. |
| `OUTPUT_CAP` | Reduce output or raise `EASY_BG_MAX_BYTES`. |
| `EXITED` | Inspect the log; no exit code was recorded. |

## 中文速查

任务完成时**不通知、不自动开启模型轮次**。人用 `/easy-bg ls` 看状态、`/easy-bg inspect <id>` 只读看日志；`/easy-bg handle [id]` 主动把结果交给模型（不带 id 交付本会话全部未处理的完成结果）。agent 在当前轮使用 `easy_bg action=handle`，省略 id 时每次最多 10 条；运行中的任务不会标记为已处理。`/easy-bg clear` 保留未处理结果，`clear --all` 会删除它们。最多并行 8 个任务，默认超时 600 秒，日志上限 20 MiB。退出 pi 后任务默认继续运行。
