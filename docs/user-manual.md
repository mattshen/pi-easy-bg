# pi-easy-bg — User Manual

This manual is the reference for every command, mode and failure case. The text follows
ASD-STE100 (Simplified Technical English): short sentences, active voice, one action per
sentence, consistent terms. A Chinese quick reference is at the end.

## 2.1 What this tool does

`easy-bg` runs a shell command in the background. pi does not wait for the command. You can keep talking in the chat.
When the command finishes, `easy-bg` shows a display-only card. You or the model can check the status and log when needed.

Use `easy-bg` for commands that take more than about ten seconds, for example: a build, a test suite, a fetch job, a linter, a dev server, or a CI check.

After the model starts a task, it can do other work or end its turn. It must not wait or check repeatedly. By default, the result does not start another model turn; check it with `easy_bg` `status`, `results`, or `logs` when needed.

Do not use `easy-bg` for a short command. Use the built-in `bash` tool for that.

#### Multi-line commands and other languages

The command can have more than one line. You can use any language. easy-bg writes your text to a file and runs it. It does not add quotes or escapes.

A multi-line bash command:

```
/easy-bg --name build set -eu
make clean
make -j8
echo "build done"
```

A Python command with a heredoc:

```
/easy-bg --name report python3 - <<'PY'
import json
rows = [{"model": "5090", "price": 2299}]
print(json.dumps(rows, indent=2))
PY
```

A full script with a shebang. easy-bg runs it with the program in the `#!` line. You do not add the interpreter yourself:

```
/easy-bg --name check #!/usr/bin/env python3
import sys
print("python", sys.version_info[:2])
sys.exit(0)
```

The same works for `#!/usr/bin/env node`, `#!/bin/bash`, and other programs.

The exit code is saved in these cases too:

- your script uses `set -e` and stops in the middle;
- your script calls `exit 3` or `sys.exit(3)`.

The task then shows `FAIL exit=3`.

## 2.2 Start a task

Type the command after `/easy-bg`:

```
/easy-bg make -j8 build
/easy-bg pnpm test
/easy-bg npx tsc --noEmit
```

pi answers with a task id, for example `bg-abaeb2`. The id is unique and it is never reused. You can pass a short prefix later, for example `bg-ab`, if only one task matches.

You can give the task a name. A name makes the task easy to find:

```
/easy-bg --name build make -j8 build
```

**When does a task end?** easy-bg waits for its own wrapper process, not for every child process. The table shows the difference.

| You run | Result |
|---|---|
| `sleep 30 && echo DONE` | The output comes after 30 seconds. The task ends after 30 seconds. |
| `sleep 30 & echo DONE` | The output comes now. The task ends now. The `sleep` process stays alive for up to 30 more seconds. |
| `sleep 30 & echo DONE; wait` | The output comes now. The task ends after 30 seconds, because `wait` waits for the child process. |

Use `&&` (or `;`) when you want the task to finish after the command. Put a process in the background with `&` only when you want it to keep running outside the task.

You can start several tasks one after another. pi keeps at most **8** running tasks. A short command does not need `easy-bg`; use the built-in `bash` tool instead.

## 2.3 Check the tasks

Run this at any time:

```
/easy-bg ls
```

This shows one line for each task:

```
bg-abaeb2  DONE          10s         exit=0  bash demo-task.sh
bg-9f2c7a  RUNNING      15s                 make -j8 build
```

- The status word tells you the state. See section 2.7.
- The time tells you how long the task ran or runs. It comes from the exit marker, not from the check time. A check runs every 1.5 seconds, so a status can be up to 1.5 seconds late.
- The footer of the chat shows the same status words as `ls`: `bg: bg-9f2c7a RUNNING 15s`. A finished task shows `bg: bg-abaeb2 DONE exit=0` for ten minutes. Parked results show `bg: 1 result(s) parked → /easy-bg now`. If more than three tasks match, the footer shows the last three and `(+2)`.

`/easy-bg ls` does not use any model tokens. You can run it often.

The model can check tasks with `easy_bg` `action=status`. To read multiple results and summarize them in the **current turn**, it can call `action=results` with `tasks: ["bg-...", "bg-..."]`. The tool returns each task's status, exit code and recent output. With no `tasks`, it returns the latest 10 finished tasks in this session. Each task has up to 4,000 characters of output. An explicit id can also select a running task and its current output. This read-only call does not start another turn or mark tasks handled. If the model has already ended its turn, a new user message is needed before it can call `results`. There is no `/easy-bg results` slash command: `/easy-bg now` is the explicit user command that starts a model turn.

## 2.4 Read the output

```
/easy-bg log bg-9f2c7a        # last 40 lines
/easy-bg log bg-9f 200        # a short prefix is enough, if only one task matches
```

The log file stays on disk. You can also open it yourself:

```
~/.pi/agent/easy-bg/bg-9f2c7a/out.log
```

## 2.5 Stop a task

```
/easy-bg stop bg-9f2c7a
```

This sends a signal to the **whole process group**. The command and all its child processes stop. No process stays behind.

If the prefix matches more than one task, pi prints `ambiguous id prefix` and lists the tasks. Nothing stops. Type more characters.

## 2.6 Results and interruptions

A finished task does not take over the chat. This is the default behaviour (`--notify park`):

1. The task finishes. pi shows a small result card. The card does not start a model turn. The footer shows `bg: 1 result(s) parked → /easy-bg now`.
2. You can check the task with `/easy-bg ls` and `/easy-bg log <id>`; the model can check it with `easy_bg` `status` and `logs` during a later turn.
3. The card stays display-only. Even when you are idle, pi does not ask the model to act. Use `/easy-bg now [id]` if you want to hand the result to the model.

The card looks like this:

```
■ background [easy-bg] bg-d713db "rtx5090-price" DONE exit=0 in 10s
  [result 1/3] ASUS ROG Strix RTX 5090 OC 32GB     | $2,489 AUD | in stock: yes
  [result 2/3] Gigabyte Aorus MASTER RTX 5090 32GB | $2,299 AUD | in stock: only 2 left
  [result 3/3] ZOTAC RTX 5090 SOLID DX 32GB        | $1,999 AUD | in stock: CN warehouse
  [13:01:23] 3 offers collected in 10s. spread=$490
  … 省略 7 行更早输出（Ctrl+O 展开）
  /easy-bg now bg-d713db   立即交给模型 · /easy-bg log bg-d713db 看全文
```

`DONE` is green, `FAIL` / `TIMEOUT` / `KILLED` are red, `RUNNING` is yellow. The card shows the newest lines. Press `Ctrl+O` to see all saved lines (the last 12).

The card is only for you. It does not go into the model context, and it does not attach to your next question. So a result from an old task never mixes with the new work you are doing.

The card stays out of the model context until you explicitly hand it over. It does not interrupt your work. You can also inspect it yourself without involving the model.

#### Clean up finished tasks

`/easy-bg clear` does not delete every finished task. It keeps four kinds of records:

| Record | `clear` | `clear --all` |
|---|---|---|
| The task is still running | kept (always) | kept (always) |
| This session, result already handled | **deleted** | deleted |
| This session, result not handled yet | kept | deleted |
| A task from another pi session | kept | deleted |

pi tells you what it did, for example: `3 cleared · 1 unhandled kept → /easy-bg now · 1 from other sessions kept → /easy-bg clear --all · 1 running untouched`.

A running task is never deleted. If pi deleted it, you could not stop it and you could not get its result.

| You do | Result |
|---|---|
| `/easy-bg now` | pi starts a turn for the results now. It handles all parked results. |
| `/easy-bg now bg-ab` | Only that task. If the prefix matches more than one task, pi lists the tasks. |
| `/easy-bg ls` or `/easy-bg log <id>` | Inspect status or output yourself, without a model turn. |

#### When does the model get a result?

The model can inspect tasks explicitly with `easy_bg` `status`, `results`, and `logs`. These actions do not start new turns. Three opt-in paths can send a result or signal to the model:

| Path | Condition |
|---|---|
| `/easy-bg now [id]` | You explicitly hand over a parked result. If the model is busy, pi queues it until idle. |
| `--notify now` | You choose an automatic turn when the task ends. |
| `--watch <pattern>` | You choose a one-time automatic turn when output matches. |

Pick a mode for one task:

| `--notify` | Behaviour |
|---|---|
| `park` (default) | Show the card only. Inspect status/logs, or use `/easy-bg now`. |
| `now` | Start a turn when the task ends. Use this only if you want an automatic wake-up. |
| `manual` | No card and no message. Status and logs remain available. Same as `--no-notify`. |

Tasks from another pi session do not automatically send a result to this model.

The status words are:

| Word | Meaning | Exit code shown? |
|---|---|---|
| `RUNNING` | The task is still working. | no |
| `DONE` | The command ended by itself with exit code 0. | yes |
| `FAIL` | The command ended by itself with a non-zero exit code. | yes |
| `KILLED` | You stopped it with `/easy-bg stop`. | no |
| `TIMEOUT` | pi stopped it because `--timeout` ran out. | no |
| `OUTPUT_CAP` | pi stopped it because the log grew too large (`EASY_BG_MAX_BYTES`). | no |
| `EXITED` | The process disappeared and there is no exit code (for example `kill -9`, or the system killed it). | no |

If pi stopped a task, the status shows that reason, not the exit code of the killed process. See 2.7.

If the task output matches a pattern you gave, one early card appears too:

```
/easy-bg --watch /error|FAILED/i pnpm test
```

You can use `/easy-bg ls` to check a task without model tokens. Avoid tight polling loops; check when you need the result.

## 2.7 Status words

| Word | Meaning | What you do |
|---|---|---|
| `RUNNING` | The command is still running | Wait, or stop it |
| `DONE` | Exit code 0 | Read the log if you need it |
| `FAIL` | Exit code is not 0 | Read the log: `/easy-bg log <id>` |
| `KILLED` | You stopped the task | None |
| `TIMEOUT` | pi stopped the task after the time limit | Start it again with a longer limit |
| `OUTPUT_CAP` | pi stopped the task because the log got too big | Make the command quieter, or raise the cap |
| `EXITED` | The process is gone, but the exit code is not available | Read the log |

## 2.8 Options for one task

| Option | Effect | Default |
|---|---|---|
| `--name <text>` | Gives the task a label | none |
| `--timeout <seconds>` | pi stops the task after this time. `0` = no limit | 600 |
| `--watch <text or /regex/flags>` | pi sends one early message when the output matches | none |
| `--notify park\|now\|manual` | How the finished result is displayed or delivered. See 2.6 | `park` |
| `--no-notify` | Same as `--notify manual` | off |

Examples:

```
/easy-bg --timeout 0 --name api npm run dev
/easy-bg --timeout 1800 --name e2e npx playwright test
/easy-bg --watch /panic/i --no-notify make bench
```

For a running dev server, always use `--timeout 0`. Otherwise pi stops it after 600 seconds.

## 2.9 Options for the whole tool

| You set | Effect |
|---|---|
| `EASY_BG_DIR=/path` | Puts the state and the logs in another directory |
| `EASY_BG_TIMEOUT_SEC` | Changes the default time limit |
| `EASY_BG_MAX_BYTES` | Changes the default log limit (20 MiB) |
| `EASY_BG_KEY="ctrl+shift+b"` | Adds a shortcut that shows the task list |
| `pi --no-easy-bg-tool` | Only you can use the tool. The model cannot |
| `pi --easy-bg-kill-all` | pi stops all its tasks when it exits |
| `EASY_BG_NOTIFY=park\|now\|manual` | Changes the default delivery mode (invalid values fall back to `park`) |

Limits that do not change: 8 running tasks, 7 days or 50 finished tasks in the record. Run `/easy-bg clear` to delete the finished records and their logs.

## 2.10 When you close pi

pi leaves running tasks alive and tells you how many are running. When you start pi again later, the new pi takes over those tasks. It watches them and tells you when they finish.

If you want pi to stop its tasks on exit, start pi with `--easy-bg-kill-all`.

## 2.11 Problems and what to do

| You see | Cause | What you do |
|---|---|---|
| `no such task: bg-7f3` | The id does not exist, or `/easy-bg clear` deleted it | Run `/easy-bg ls` |
| `ambiguous id prefix "bg-ab"` | More than one task starts with those characters | Type more characters. The answer lists the tasks. |
| `task limit reached (8 running)` | Too many running tasks | Run `/easy-bg stop <id>` |
| A log line `[easy-bg] timeout 600s, killing task group` | easy-bg stopped the task | Normal. Start it again with a bigger `--timeout`, or `--timeout 0` |
| The task shows `EXITED` and no exit code | Something outside pi stopped the task, so the exit code is not available | Read the log |
| The task stays alive when pi closes or crashes | pi does not stop tasks | Nothing. A later pi session takes it over. See 2.10 |
| The task shows `TIMEOUT` | The command needs more time | Start it again with a bigger `--timeout`, or `--timeout 0` |
| The task shows `OUTPUT_CAP` | The command writes too much output | Make the command quieter, or set a bigger `EASY_BG_MAX_BYTES` |
| No message and no card | You used `--no-notify` / `--notify manual`, or you changed `EASY_BG_DIR` | Run `/easy-bg ls` |
| The card appears but the model does not act | Normal: parked results never start a model turn | Run `/easy-bg now`, or ask the model to check `status` and `logs` |
| A result came back while I was doing something else | By design: the card never enters your next turn | Ignore it, or run `/easy-bg now` when you want it |
| The card has no `■ background` line, or the card shows every log line | pi runs an older copy of the extension, or the extension failed to load | On start, pi shows `easy-bg v2.0.0 · /easy-bg help · notify: park|now|manual` at startup. If those are missing, read the start-up line `Failed to load extension "…"` and restart pi with `/quit` (a plain `/reload` may keep an old instance) |
| The model waits with `sleep`/`tail` after starting a task | The model polled in a loop | Ask it to do other work or end its turn, then check the task later with `status` and `logs` |
| The model does not answer the wake-up message | The message waits for the running turn | Wait for the current answer |

## 2.12 中文速查

| 命令 | 作用 |
|---|---|
| `/easy-bg <命令>` | 启动一个后台任务，立即返回唯一 id（如 `bg-abaeb2`，永不复用） |
| `/easy-bg --name build --timeout 0 <命令>` | 具名、不限时（dev server 用 `--timeout 0`） |
| `/easy-bg --watch /error/i <命令>` | 输出命中模式时提前通知一次 |
| `/easy-bg ls` | 列出全部任务（不吃 token，可频繁用） |
| `/easy-bg log <id> [行数]` | 看尾部日志，默认 40 行（`id` 可用唯一前缀，如 `bg-ab`） |
| `/easy-bg clear` | Clear finished tasks of this session. Keeps results you have not handled yet, and keeps other sessions. |
| `/easy-bg clear --all` | Clear every finished task from every session, including unhandled results. |
| `/easy-bg stop <id>` | 终止整个进程组（前缀不唯一时会列出候选并拒绝执行） |
| `/easy-bg now [id]` | 主动把 parked 的结果交给模型处理（默认不会自动投递） |
| `Ctrl+O` | 展开结果卡片看全部日志行；卡片默认只显示最近 5 行 |
| `/easy-bg clear` | 删除已结束任务的记录与日志 |
| `/easy-bg help` | 看用法与默认值 |

任务结束时只通知一次；`RUNNING / DONE / FAIL / KILLED / TIMEOUT / OUTPUT_CAP / EXITED` 的中文含义见 2.7 表。最多 8 个任务同时在跑；日志默认上限 20 MiB，超时默认 600 秒。退出 pi 后任务继续跑，下一次启动 pi 会接管。每条命令自己 `&` 出的子进程不会延长任务存活区间，需要时写 `wait`（见 2.2 末）。

Tab 补全会列出子命令、选项和带状态的 id（例如 `bg-9f2c7a · DONE · make -j8 build`）。
