# pi-easy-bg

给 [pi](https://pi.dev) 用的后台任务扩展：长命令不阻塞对话，结果自己回来——不用轮询，也不会抢走你正在做的事。

```
/easy-bg --name build make -j8
  bg-3f9a2c RUNNING 2s                       ← 你可以继续输入

  ■ background [easy-bg] bg-3f9a2c "build" DONE exit=0 in 47s
    … 构建输出 …
    /easy-bg now bg-3f9a2c   交给模型处理 · /easy-bg log bg-3f9a2c
```

## 为什么

pi 内置的 `bash` 工具是同步的：一条命令独占整个 turn 直到返回。编译、测试、抓数据这类命令会让对话卡住；让模型自己轮询（`sleep` → `tail` → `sleep`）则既占着 turn，又把日志反复灌进上下文。

`pi-easy-bg` 把"等待"移出 turn：

- **启动立即返回**，命令在独立进程组里跑。
- **并行由 harness 负责**：一次调用起 N 个任务，一次 `status` 聚合返回。
- **事件驱动**：任务结束自己上报，模型不需要轮询。
- **结果不劫持你**：卡片只上屏（不进上下文、不附着到你下一个问题），投递要等你"空闲且静默"。
- **跨重启**：状态与日志落盘，后续 pi 会话可以接管仍在跑的任务。

## 安装

```bash
pi install git:github.com/mattshen/pi-easy-bg
```

只试用一次：

```bash
pi -e git:github.com/mattshen/pi-easy-bg
```

手动安装：把 `extensions/easy-bg.ts` 复制到 `~/.pi/agent/extensions/`，然后 `/reload`。

卸载：`pi remove git:github.com/mattshen/pi-easy-bg`。

## 快速上手

```bash
/easy-bg --name build make -j8                  # 启动，立刻返回
/easy-bg ls                                     # 运行中 / 已完成
/easy-bg log bg-3f9a2c 80                       # 看最后 80 行
/easy-bg stop bg-3f9a2c                         # 杀掉整个进程组
/easy-bg now                                    # 立刻把 parked 结果交给模型
```

一次起多个（一次调用，而不是 N 次工具调用）：

```json
{ "action": "run", "name": "ci", "command": ["pnpm lint", "pnpm test", "pnpm build"] }
```

## 投递模式

任务完成永远不会抢走对话。`park` 只把结果做成**只上屏**的卡片（不进模型上下文，也不附着到你下一个问题），随后 `auto` 在你停下来之后交给模型。

| `--notify` | 行为 |
|---|---|
| `auto`（默认） | 出卡片；用户在 `EASY_BG_QUIET_MS`（默认 8s）内保持空闲且静默后投递 |
| `now` | 任务一结束就开 turn。只在"我就等这一个结果"时用 |
| `park` | 只出卡片，永不自动投递，由你用 `/easy-bg now` 决定 |
| `manual` | 什么都不做（连卡片都不出）。等同 `--no-notify` |

"空闲且静默"指下面三条**连续**成立满静默窗口：

1. 没有 turn 在跑（不 streaming、不执行工具）；
2. 没有排队消息（你没有连发第二条）；
3. 编辑器为空（有草稿就不投递；纯空白算空）。

结果进入模型上下文只有四条路径：

| # | 路径 | 条件 |
|---|---|---|
| A | `--notify now` | 任务结束，无其它条件 |
| B | `--notify auto` | 空闲静默窗口满 |
| C | `/easy-bg now [id]` | 总是可用；模型忙时排队成一个**独立 turn** |
| D | `--watch <pattern>` | 输出匹配（每任务一次） |

投递永远开**独立 turn**（`sendUserMessage`），不会用 `followUp` 插进你当前正在进行的 turn。

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
| `/easy-bg log <id> [lines]` | 看日志尾部（默认 40 行） |
| `/easy-bg stop <id>` | 杀掉任务进程组 |
| `/easy-bg now [id]` | 投递 parked 结果（全部或指定一个） |
| `/easy-bg clear` | 清理**本会话**已处理过的终态任务 |
| `/easy-bg clear --all` | 清理所有会话的全部终态任务（含未处理结果） |
| `/easy-bg help` | 用法 |

选项：`--name <label>`、`--timeout <sec|0>`、`--watch <substring|/regex/flags>`、`--notify <auto|now|park|manual>`、`--no-notify`。

`<id>` 支持唯一前缀（`bg-3f`）；前缀不唯一时会列出候选而不是猜一个。

`clear` 永不删除运行中的任务，永不删除未处理结果，也不会碰其他 pi 会话——除非显式 `--all`。它会报告做了什么，例如 `3 cleared · 1 unhandled kept → /easy-bg now · 1 from other sessions kept → /easy-bg clear --all · 1 running untouched`。

## 模型工具

只有 `easy_bg` 一个工具，用 `action` 枚举——弱模型也能用对：

| action | 参数 |
|---|---|
| `run` | `command: string[]`（1..N，每个一项任务）、`name?`、`timeout?`、`watch?`、`notify?` |
| `status` | —（本会话任务聚合） |
| `logs` | `task`（id 或唯一前缀）、`lines?`（默认 30，最大 400） |
| `stop` | `task` |
| `clear` | — |

`run` 之后工具会提示模型结束本轮——结果自己回来。`pi --no-easy-bg-tool` 可隐藏该工具，只保留斜杠命令。

## 配置

| 项 | 默认 | 途径 |
|---|---|---|
| 状态目录 | `~/.pi/agent/easy-bg/` | `EASY_BG_DIR` |
| 超时 | 600s（`0` = 不限） | `--timeout`、`EASY_BG_TIMEOUT_SEC` |
| 输出上限 | 20 MiB | `EASY_BG_MAX_BYTES` |
| 非 shebang 命令的 shell | `/bin/bash` | `EASY_BG_SHELL` |
| 默认投递模式 | `auto` | `EASY_BG_NOTIFY` |
| 自动投递前的静默窗口 | 8s | `EASY_BG_QUIET_MS` |
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

任务 id 随机且永不复用，所以 `clear`、GC、重启之后日志目录与去重键都不会相撞。运行中的任务会被下一个看到它的 pi 会话接管（心跳租约）。

## 开发

```bash
git clone https://github.com/mattshen/pi-easy-bg
cd pi-easy-bg
node --test test/core.test.ts     # 34 个单元测试，无需安装依赖（Node >= 22.18）
pi -e .                           # 临时加载工作副本
```

`src/core.ts` 放所有纯逻辑（状态文件、id、日志尾部、状态判定、启动任务、watch 模式、格式化），不 import 任何 pi 包，因此可用 `node --test` 直接单测；`extensions/easy-bg.ts` 只做 pi 集成（工具、斜杠命令、卡片、观测循环、投递）。

### 已知限制

- 输出上限靠轮询日志大小实现（`CAP_CHECK_MS` = 100ms）。极快的输出（例如 `yes`）可能在两次检查之间超出上限。实测：400 字节上限下裸 `yes` 峰值约 80 MiB，随后进程组被杀、日志截断回上限。默认 20 MiB 上限下不是实际问题，但这**不是**内核级限制。
- 按进程组杀任务，所以命令自己 `setsid` / `nohup … &` 脱离进程组时会逃过清理。
- 终态在 wrapper 进程退出时记录，而不是所有子孙退出：`cmd &` 不加 `wait` 会让任务提前结束、子进程继续跑。

## 文档

- [用户手册](docs/user-manual.md) — 每条命令、每种模式与失败情形
- [examples/demo-task.sh](examples/demo-task.sh) — 跑 10 秒、打印三条报价的练习脚本
- 参考规范：[mattshen/my-docs#62](https://github.com/mattshen/my-docs/issues/62)

## 许可

MIT © Matt Shen
