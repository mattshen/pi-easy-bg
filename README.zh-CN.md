# pi-easy-bg

给 [pi](https://pi.dev) 用的后台任务扩展：长命令不阻塞对话，任务完成后按需查看状态和日志。

```
/easy-bg --name build make -j8
  bg-3f9a2c RUNNING 2s                       ← 你可以继续输入

  # 稍后主动查看（完成时不提示）：
/easy-bg ls                                     # DONE exit=0
/easy-bg inspect bg-3f9a2c                      # 看输出
/easy-bg handle bg-3f9a2c                       # 交给模型处理
```

## 为什么

pi 内置的 `bash` 工具是同步的：一条命令独占整个 turn 直到返回。编译、测试、抓数据这类命令会让对话卡住；让模型自己轮询（`sleep` → `tail` → `sleep`）则既占着 turn，又把日志反复灌进上下文。

`pi-easy-bg` 把"等待"移出 turn：

- **启动立即返回**，命令在独立进程组里跑。
- **并行由 harness 负责**：一次调用起 N 个任务，一次 `status` 聚合返回。
- **完成时静默**：人或 agent 按需查看状态、日志，主动处理结果；不会自动开 turn 或显示结果卡片。
- **跨重启**：状态与日志落盘，后续 pi 会话可以接管仍在跑的任务。

## 安装

```bash
pi install git:github.com/mattshen/pi-easy-bg
```

只试用一次：

```bash
pi -e git:github.com/mattshen/pi-easy-bg
```

卸载：`pi remove git:github.com/mattshen/pi-easy-bg`。

## 快速上手

```bash
/easy-bg --name build make -j8                  # 启动，立刻返回
/easy-bg ls                                     # 运行中 / 已完成
/easy-bg inspect bg-3f9a2c 80                   # 查看最后 80 行，不标记已处理
/easy-bg stop bg-3f9a2c                         # 杀掉整个进程组
/easy-bg handle                                 # 把未处理的完成结果交给模型
```

一次起多个（一次调用，而不是 N 次工具调用）：

```json
{ "action": "run", "name": "ci", "command": ["pnpm lint", "pnpm test", "pnpm build"] }
```

## 处理结果

任务完成时不提示、不开 turn。`/easy-bg ls`、`inspect` 只读查看；`/easy-bg handle [id]` 开启 turn 将未处理的完成结果交给模型（模型忙时排为 follow-up）。不带 id 时交付本会话所有未处理的完成结果。agent 可用 `easy_bg` 的 `action=handle` 在**当前轮**读取结果。已处理的记录仍在 `ls` 中，直到清理或淘汰。避免紧密轮询。

## 任务状态

| 状态 | 含义 | 是否显示退出码 |
|---|---|---|
| `RUNNING` | 正在运行 | 否 |
| `DONE` | 自己结束，退出码 0 | 是 |
| `FAIL` | 自己结束，退出码非 0 | 是 |
| `KILLED` | 你 `/easy-bg stop` 掉的 | 否 |
| `TIMEOUT` | `--timeout` 到期 | 否 |
| `OUTPUT_CAP` | 日志超过 `EASY_BG_MAX_BYTES` | 否 |
| `EXITED` | 进程消失且拿不到退出码（`kill -9`、OOM） | 否 |

终止原因优先于退出码：被 SIGTERM 杀掉的任务显示 `KILLED`/`TIMEOUT`，而不是 `DONE exit=0`。

## 多行命令与任意语言

命令文本**原样**写入文件，不做任何重新加引号或转义，所以多行脚本与 heredoc 都能用：

```bash
/easy-bg --name report python3 - <<'PY'
import json
print(json.dumps([{"model": "5090", "price": 2299}], indent=2))
PY
```

命令以 `#!` 开头时视为完整脚本，交给内核按 shebang 执行（`python3`、`node`、`bash`，任何解释器）：

```bash
/easy-bg --name check #!/usr/bin/env python3
import sys
print("python", sys.version_info[:2])
sys.exit(4)          # -> FAIL exit=4
```

退出码用 `EXIT` trap 捕获，所以 `set -e` 中途失败、显式 `exit N` / `sys.exit(N)` 都能正确上报，不会退化成 `EXITED`。

## 命令

| 命令 | 用途 |
|---|---|
| `/easy-bg <command>` | 启动任务（`run` 的简写） |
| `/easy-bg run [flags] <command>` | 同上，显式形式 |
| `/easy-bg ls` | 列出运行中与已完成任务 |
| `/easy-bg inspect <id> [lines]` | 只读查看日志尾部（默认 40 行） |
| `/easy-bg stop <id>` | 杀掉任务进程组 |
| `/easy-bg handle [id]` | 交付未处理的完成结果（全部或指定一个） |
| `/easy-bg clear` | 清理**本会话**已处理过的终态任务 |
| `/easy-bg clear --all` | 清理所有会话的全部终态任务（含未处理结果） |
| `/easy-bg help` | 用法 |

选项：`--name <label>`、`--timeout <sec|0>`。

`<id>` 支持唯一前缀（`bg-3f`）；前缀不唯一时会列出候选而不是猜一个。

`clear` 保留运行中任务、未处理结果及其他会话记录；`clear --all` 可清理所有会话的终态任务。

## 模型工具

只有 `easy_bg` 一个工具，用 `action` 枚举——弱模型也能用对：

| action | 参数 |
|---|---|
| `run` | `command: string[]`（1..N，每个一项任务）、`name?`、`timeout?` |
| `status` | —（本会话任务聚合） |
| `handle` | `tasks?`（最多 10 个 id/唯一前缀；省略则取本会话最多 10 个待处理结果）、`task?`（单个任务）、`lines?`（默认 30，每任务最多 100 行） |
| `inspect` | `task`（id 或唯一前缀）、`lines?`（默认 30，最大 400） |
| `stop` | `task` |
| `clear` | — |

`run` 后模型可以做别的事或结束本轮。`handle` 在**当前轮**返回状态和输出，并标记终态任务已处理；显式指定运行中任务只读部分输出，不标记处理，也可以指定其他会话的任务。省略 id 时取本会话最早的最多 10 个未处理完成结果（斜杠命令则不限数）。每任务最多返回 4000 字符日志；更多内容用 `inspect`。若模型已结束本轮，须等新用户消息再调用工具。`pi --no-easy-bg-tool` 可隐藏工具。

## 配置

| 项 | 默认 | 途径 |
|---|---|---|
| 状态目录 | `~/.pi/agent/easy-bg/` | `EASY_BG_DIR` |
| 超时 | 600s（`0` = 不限） | `--timeout`、`EASY_BG_TIMEOUT_SEC` |
| 输出上限 | 20 MiB | `EASY_BG_MAX_BYTES` |
| 非 shebang 命令的 shell | `/bin/bash` | `EASY_BG_SHELL` |
| 并发任务上限 | 8 | 常量 |
| 终态保留 | 7 天 / 50 条 | 常量 |
| 隐藏模型工具 | 关 | `pi --no-easy-bg-tool` |
| pi 退出时杀任务 | 关（留给后续会话接管） | `pi --easy-bg-kill-all` |

## 状态目录布局

```
~/.pi/agent/easy-bg/
├── tasks.json              # 元数据，原子写（tmp + rename）
└── bg-<6hex>/
    ├── cmd.sh              # sh wrapper：EXIT trap + 你的命令
    ├── run.user            # 仅 `#!` 命令：脚本本体，chmod 0755
    ├── out.log             # stdout + stderr
    └── exit                # wrapper 的 trap 写入的退出码
```

任务 id 随机生成，并检查当前记录中的碰撞。心跳租约过期后，新会话可接管仍在运行的任务。

## 开发

```bash
git clone https://github.com/mattshen/pi-easy-bg
cd pi-easy-bg
npm run verify                    # import check + 单元测试，无需安装依赖（Node >= 22.18）
pi -e .                           # 临时加载工作副本
```

`src/core.ts` 放纯逻辑（状态文件、id、日志尾部、状态判定、启动任务、格式化），不 import pi 包，可用 `node --test` 单测；`extensions/easy-bg.ts` 提供工具、斜杠命令和任务观测循环。

### 已知限制

- 输出上限靠轮询日志大小实现（`CAP_CHECK_MS` = 100ms）。极快的输出（例如 `yes`）可能在两次检查之间超出上限。实测：400 字节上限下裸 `yes` 峰值约 80 MiB，随后进程组被杀、日志截断回上限。默认 20 MiB 上限下不是实际问题，但这**不是**内核级限制。
- 按进程组杀任务，所以命令自己 `setsid` / `nohup … &` 脱离进程组时会逃过清理。
- 终态在 wrapper 进程退出时记录，而不是所有子孙退出：`cmd &` 不加 `wait` 会让任务提前结束、子进程继续跑。

## 文档

- [用户手册](docs/user-manual.md) — 命令和故障排查
- [examples/demo-task.sh](examples/demo-task.sh) — 跑 10 秒、打印三条报价的练习脚本
- 参考规范：[mattshen/my-docs#62](https://github.com/mattshen/my-docs/issues/62)

## 许可

MIT © Matt Shen
