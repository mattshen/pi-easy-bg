/**
 * pi-easy-bg — pi integration
 *
 * Registers `/easy-bg`, the `easy_bg` model tool, status cards, the observation
 * loop and result delivery. Plain logic lives in `src/core.ts`.
 */

import * as fs from "node:fs";
import { Type } from "typebox";
import { Box, Text } from "@earendil-works/pi-tui";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	ANSI,
	ADOPT_STALE_MS,
	CAP_CHECK_MS,
	DEFAULT_MAX_BYTES,
	DEFAULT_NOTIFY,
	DEFAULT_TIMEOUT_SEC,
	LEASE_MS,
	MAX_RUNNING_TASKS,
	MAX_RESULT_TASKS,
	RESULT_LOG_CHARS,
	NOTIFY_KEYS_MAX,
	NOTIFY_MODES,
	NOTIFY_TAIL_LINES,
	RETENTION_COUNT,
	RETENTION_MS,
	STATUS_LABEL,
	TAIL_BYTES,
	TICK_MS,
	VERSION,
	alive,
	ambiguousIn,
	commandHint,
	compileWatch,
	dir,
	elapsed,
	findTask,
	isTerminal,
	killTask,
	logPath,
	logSize,
	readExitCode,
	readTasks,
	resolveTerminal,
	selectResultTasks,
	startTask,
	summaryLine,
	tailText,
	taskDir,
	truncateTail,
	tasksFile,
	wakeText,
	withTasks,
	writeTasks,
} from "../src/core.ts";
import type { KillReason, NotifyMode, StartContext, Task, TaskStatus } from "../src/core.ts";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-easy-bg-tool", { description: "Do not expose the easy_bg tool to the model (keep only /easy-bg)" });
	pi.registerFlag("easy-bg-kill-all", { description: "Kill all easy-bg tasks when this pi session exits" });

	let latestCtx: ExtensionContext | undefined;
	let started = false;
	let timers: ReturnType<typeof setInterval>[] = [];
	let notified = new Set<string>();
	// 记账：key = <kind>:<id>:<startedAt>；到上限整体清空（磁盘 task.notified 才是权威）
	const remember = (key: string) => {
		if (notified.size >= NOTIFY_KEYS_MAX) notified.clear();
		notified.add(key);
	};
	// 任务记录被删除时同步删掉它的 key，避免账本指向不存在的任务（也顺带控增长）
	const forget = (id: string, startedAt?: number) => {
		notified.delete(`wake:${id}:${startedAt}`);
		notified.delete(`adopt:${id}:${startedAt}`);
	};
	let lastStatusLine: string | undefined;
	let gcAt = 0;

	const startContext = (ctx: ExtensionContext): StartContext => ({
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
		modelId: ctx.model?.id ?? undefined,
		thinkingLevel: ctx.thinkingLevel ?? undefined,
	});

	const log = (msg: string) => {
		console.log(`[easy-bg] ${msg}`);
		pi.sendMessage({ customType: "easy-bg-notice", content: msg, display: true });
	};

	const head = (t: Task) => `[easy-bg] ${t.id}${t.name ? ` "${t.name}"` : ""} ${STATUS_LABEL[t.status]} ${t.exitCode !== undefined ? `exit=${t.exitCode}` : ""} in ${elapsed(t)}`;

	const modeOf = (t: Task): NotifyMode => {
		if (t.notify === false) return "manual";
		if (t.notifyMode && !NOTIFY_MODES.includes(t.notifyMode)) return "park"; // legacy auto tasks stay passive
		return t.notifyMode ?? DEFAULT_NOTIFY;
	};

	const openTurn = (text: string, ctx: ExtensionContext): boolean => {
		try {
			if (ctx.isIdle()) pi.sendUserMessage(text);
			else pi.sendUserMessage(text, { deliverAs: "followUp" });
			return true;
		} catch (error: any) {
			console.error(`[easy-bg] delivery failed: ${error?.message ?? error}`);
			return false;
		}
	};

	// park：只上屏（appendEntry 不进 LLM 上下文、不进消息队列）。
	// 为什么不用 sendMessage(deliverAs:"nextTurn")：那会让结果无条件塞进用户的下一轮提问，
	// 而用户那时可能正在做完全无关的 foreground 任务 —— 上下文被无关日志挤占、注意力被拉走。
	const park = (t: Task, note?: string): boolean => {
		try {
			pi.appendEntry("easy-bg-result", {
				title: `${STATUS_LABEL[t.status]}${t.exitCode !== undefined ? ` exit=${t.exitCode}` : ""} · ${elapsed(t)}${note ? ` · ${note}` : ""}`,
				status: t.status === "running" ? "running" : t.status === "done" ? "done" : "error",
				head: t.name ? `${t.id} "${t.name}"` : t.id,
				lines: tailText(t, 12).split("\n").filter((l) => l.trim()),
				hint: `/easy-bg now ${t.id}   立即交给模型 · /easy-bg log ${t.id} 看全文`,
				ts: Date.now(),
			});
			return true;
		} catch (error: any) {
			console.error(`[easy-bg] park failed for ${t.id}: ${error?.message ?? error}`);
			return false;
		}
	};

	// flush：仅在用户显式 /easy-bg now 时，把 parked 结果交给模型
	const flushParked = (ctx: ExtensionContext, filter?: (t: Task) => boolean): number => {
		const sid = ctx.sessionManager.getSessionId();
		const pending = readTasks().filter((t) => t.session === sid && isTerminal(t.status) && t.notified && t.parkedAt && !t.handledAt && (!filter || filter(t)));
		if (pending.length === 0) return 0;
		// park 卡片只上屏不进上下文，所以这里必须自带数据（否则模型看不见结果）
		const body = pending.map((t) => `\u25b8 ${head(t)}\n${tailText(t, 12) || "(no output)"}`).join("\n\n");
		// 独立 turn：本条消息自成一轮，明确告知与上一轮话题无关，避免模型把两件事混在一起
		if (!openTurn(`Background result(s) ready (${pending.length}) — 独立的后台任务结果，与上一轮对话无关；请只处理这个：\n\n${body}\n\n需要更多日志用 /easy-bg log <id> 或 easy_bg action=logs。`, ctx)) return 0;
		const ids = new Set(pending.map((t) => t.id));
		withTasks((all) => {
			for (const t of all) if (ids.has(t.id)) { t.handledAt = Date.now(); delete t.wantedAt; }
		});
		return pending.length;
	};

	const renderStatus = (ctx: ExtensionContext, tasks: Task[]) => {
		const running = tasks.filter((t) => t.status === "running");
		const fresh = tasks.filter((t) => isTerminal(t.status) && t.endedAt && Date.now() - t.endedAt < 10 * 60 * 1000);
		const parked = tasks.filter((t) => t.parkedAt && !t.handledAt);
		// 状态词与 ls/log 保持一致：运行中也显示 RUNNING；计时跟在状态后，终态带 exit code
		const fmt = (t: Task, withTime: boolean) =>
			`${t.id} ${STATUS_LABEL[t.status]}${withTime ? ` ${elapsed(t)}` : (t.status === "done" || t.status === "failed") && t.exitCode !== undefined ? ` exit=${t.exitCode}` : ""}${t.status === "running" && t.killReason ? ` \u2192${t.killReason}` : ""}`;
		const list = (items: Task[], withTime: boolean) => {
			const shown = items.slice(-3);
			const more = items.length - shown.length;
			return `${shown.map((t) => fmt(t, withTime)).join(", ")}${more > 0 ? ` (+${more})` : ""}`;
		};
		const parts: string[] = [];
		if (parked.length) parts.push(`${parked.length} result(s) parked \u2192 /easy-bg now`);
		if (running.length) parts.push(list(running, true));
		else if (fresh.length) parts.push(list(fresh, false));
		const text = parts.length ? `bg: ${parts.join(" \u00b7 ")}` : undefined;
		if (text !== lastStatusLine) {
			lastStatusLine = text;
			try {
				ctx.ui.setStatus("easy-bg", text);
			} catch {
				/* no footer in this mode */
			}
		}
	};

	// 输出上限：杀进程组 + 把日志截断到 maxBytes（保留尾部，错误通常在末尾）。
	// 由高频的 cap 循环调用，不能依赖 1.5s 的 tick —— `yes` 在 1.5s 内可写出数十 GB。
	const enforceCap = (t: Task) => {
		if (!t.capped) {
			t.capped = true;
			try {
				fs.appendFileSync(logPath(t), `\n[easy-bg] output cap ${t.maxBytes}B reached, killing task group\n`);
			} catch {}
			killTask(t, "output_cap");
		}
		// 幂等截断：SIGTERM 之后进程可能还会写一小段，后续检查继续兜住
		truncateTail(t, t.maxBytes);
	};

	const tick = () => {
		const ctx = latestCtx;
		if (!ctx) return;
		const sid = ctx.sessionManager.getSessionId();
		const now = Date.now();
		const tasks = withTasks((all) => {
			for (const t of all) {
				try {
					if (t.status === "running" && t.session === sid && now - (t.claimedAt ?? 0) > LEASE_MS) {
						t.claimedBy = sid;
						t.claimedAt = now;
					}
					if (t.status !== "running") continue;

					const code = readExitCode(t);
					if (code !== undefined || !alive(t.pid)) {
						resolveTerminal(t);
						continue;
					}

					const size = logSize(t);
					if (size > t.maxBytes) {
						enforceCap(t);
						continue;
					}
					if (t.timeoutSec > 0 && now - t.startedAt > t.timeoutSec * 1000) {
						try {
							fs.appendFileSync(logPath(t), `\n[easy-bg] timeout ${t.timeoutSec}s, killing task group\n`);
						} catch {}
						killTask(t, "timeout");
						continue;
					}
					if (t.watch && !t.patternNotified) {
						const text = tailText(t, 200);
						if (text && compileWatch(t.watch).test(text)) {
							t.patternNotified = true;
							const id = t.id;
							const watchLabel = t.watch;
							queueMicrotask(() => {
								const list = readTasks();
								const task = list.find((x) => x.id === id);
								if (!task) return;
								park(task, `watch 命中 ${watchLabel}`);
								if (latestCtx) {
									openTurn(`[easy-bg] ${id} output matched watch pattern ${watchLabel} (${STATUS_LABEL[task.status]}, ${elapsed(task)}):\n${tailText(task, 8)}`, latestCtx);
								}
								writeTasks(list);
							});
						}
					}
				} catch (error: any) {
					console.error(`[easy-bg] task ${t.id} tick error: ${error?.message ?? error}`);
				}
			}

			// 认领上一任会话遗留、心跳过期的任务（pi 重启 / crash 后继续监控）
			for (const t of all) {
				if (t.status !== "running") continue;
				if (t.session === sid) continue;
				if (now - (t.claimedAt ?? t.startedAt) < ADOPT_STALE_MS) continue;
				t.session = sid;
				t.claimedBy = sid;
				t.claimedAt = now;
				t.note = "adopted";
			}
		});

		const adopted = tasks.filter((t) => t.note === "adopted" && !notified.has(`adopt:${t.id}:${t.startedAt}`));
		for (const t of adopted) {
			remember(`adopt:${t.id}:${t.startedAt}`);
			if (ctx.hasUI) ctx.ui.notify(`easy-bg adopted ${t.id} from a previous session: ${t.command.slice(0, 60)}`, "info");
		}

		for (const t of tasks.filter((x) => x.status !== "running" && x.notify && !x.notified && x.session === sid)) {
			const key = `wake:${t.id}:${t.startedAt}`;
			if (notified.has(key)) continue;
			remember(key);
			const live = readTasks().find((x) => x.id === t.id);
			if (!live) continue;
			const mode = modeOf(live);
			if (mode === "manual") {
				withTasks((all) => {
					const cur = all.find((x) => x.id === t.id);
					if (cur) { cur.notified = true; cur.handledAt = Date.now(); }
				});
				continue;
			}
			if (mode === "now") {
				const ok = openTurn(wakeText(live), ctx);
				withTasks((all) => {
					const cur = all.find((x) => x.id === t.id);
					if (cur) { cur.notified = true; if (ok) cur.handledAt = Date.now(); }
				});
				continue;
			}
			const ok = park(live);
			withTasks((all) => {
				const cur = all.find((x) => x.id === t.id);
				if (cur) { cur.notified = true; if (ok) cur.parkedAt = Date.now(); }
			});
			if (ctx.hasUI) ctx.ui.notify(`${live.id} ${STATUS_LABEL[live.status]} — 已上屏，不进上下文；用 /easy-bg ls、log 检查，或 /easy-bg now 交给模型`, "info");
		}

		// 只有显式 /easy-bg now 曾排队的结果，才在 agent 空闲后投递。
		if (ctx.isIdle() && !ctx.hasPendingMessages()) {
			flushParked(ctx, (t) => !!t.wantedAt);
		}

		if (now - gcAt > 5 * 60 * 1000) {
			gcAt = now;
			prune();
		}
		renderStatus(ctx, readTasks());
	};

	function prune(): void {
		withTasks((all) => {
			const done = all.filter((t) => isTerminal(t.status)).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
			const drop = new Set<string>();
			done.forEach((t, i) => {
				if (i >= RETENTION_COUNT || (t.endedAt ?? 0) < Date.now() - RETENTION_MS) drop.add(t.id);
			});
			if (drop.size === 0) return;
			for (let i = all.length - 1; i >= 0; i--) {
				const id = all[i].id;
				if (!drop.has(id)) continue;
				all.splice(i, 1);
				fs.rmSync(taskDir(id), { recursive: true, force: true });
			}
		});
	}

	// ---- 状态卡片（不进 LLM 上下文）----
	// park 结果卡片（appendEntry = 只上屏、不进 LLM 上下文、不进消息队列）
	// 折叠时保留最近的行（结果通常在末尾）；Ctrl+O 展开全部
	pi.registerEntryRenderer<{ title?: string; head?: string; lines?: string[]; hint?: string; status?: "done" | "running" | "error"; ts?: number }>("easy-bg-result", (entry, { expanded }, theme) => {
		const d = entry.data ?? {};
		const color: string = d.status === "done" ? "success" : d.status === "running" ? "warning" : "error";
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(`${theme.fg(color, "\u25a0 background")} ${theme.fg("toolTitle", `[easy-bg] ${d.head ?? "task"}`)} ${theme.fg(color, d.title ? ` ${d.title}` : "")}`, 0, 0));
		const lines = d.lines ?? [];
		const KEEP = 5;
		const shown = expanded ? lines : lines.slice(-KEEP);
		for (const line of shown) box.addChild(new Text(theme.fg("muted", `  ${line}`), 0, 0));
		if (!expanded && lines.length > KEEP) box.addChild(new Text(theme.fg("dim", `  \u2026 \u7701\u7565 ${lines.length - KEEP} \u884c\u66f4\u65e9\u8f93\u51fa\uff08Ctrl+O \u5c55\u5f00\uff09`), 0, 0));
		box.addChild(new Text(theme.fg("dim", `  ${d.hint ?? ""}`), 0, 0));
		return box;
	});

	pi.registerEntryRenderer<{ lines: string[]; title: string; ts: number }>("easy-bg", (entry, _options, theme) => {
		const data = entry.data ?? { title: "easy-bg", lines: [], ts: Date.now() };
		const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
		box.addChild(new Text(theme.fg("accent", `easy-bg · ${data.title}`), 0, 0));
		for (const line of data.lines) {
			const id = line.match(/^(bg-\S+)/)?.[1];
			const kind = /RUNNING/.test(line) ? "warning" : /FAIL|TIMEOUT|OUTPUT_CAP|KILLED|EXITED/.test(line) ? "error" : /DONE/.test(line) ? "success" : "muted";
			box.addChild(new Text(`${theme.fg(kind as any, line)}${id ? theme.fg("dim", `   ${commandHint(id)}`) : ""}`, 0, 0));
		}
		return box;
	});

	const card = (title: string, lines: string[]) => pi.appendEntry("easy-bg", { title, lines, ts: Date.now() });

	// ---- 模型侧：单个 action-based tool（弱并行模型也只需顺序调用）----
	if (!pi.getFlag("no-easy-bg-tool")) {
		const params = Type.Object({
			action: Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("results"), Type.Literal("logs"), Type.Literal("stop"), Type.Literal("clear")], { description: "run: start tasks; status: list tasks; results: read up to 10 tasks and their output in this turn (no new turn); logs: tail one task; stop: kill a task; clear: drop handled finished records" }),
			command: Type.Optional(Type.Array(Type.String(), { description: "For action=run: one or more shell commands. Each command becomes its own background task (parallelism handled here, not by issuing parallel calls)." })),
			name: Type.Optional(Type.String({ description: "Optional short label for the task" })),
			task: Type.Optional(Type.String({ description: "Task id (e.g. bg-1) for logs/stop, or one result" })),
			tasks: Type.Optional(Type.Array(Type.String(), { description: `For results: task ids or unique prefixes (up to ${MAX_RESULT_TASKS}). Omit to read the latest finished tasks in this session.` })),
			lines: Type.Optional(Type.Number({ description: "Log lines to return (default 30; max 400 for logs, 100 per task for results)" })),
			timeout: Type.Optional(Type.Number({ description: `Kill after N seconds (default ${DEFAULT_TIMEOUT_SEC}; 0 = no timeout)` })),
			watch: Type.Optional(Type.String({ description: "Explicitly wake the chat when output matches this substring or /regex/flags (once)" })),
			notify: Type.Optional(Type.Union([Type.Literal("park"), Type.Literal("now"), Type.Literal("manual")], { description: "park (default): display-only result card; inspect with status/logs or /easy-bg ls/log, or explicitly hand it to the model with /easy-bg now. now: start a turn when the task finishes (opt-in). manual: no card or message." })),
		});

		pi.registerTool(
			defineTool({
				name: "easy_bg",
				label: "Background task",
				description:
					"Run shell commands in the background without blocking the chat. Use for anything longer than ~10 seconds (builds, test suites, fetches, watchers). One run call can start several commands at once. By default a completed task shows a display-only card; it NEVER starts a model turn or enters the model context automatically. Check completion with action=status, or use action=results to read up to 10 tasks and their logs in one tool response and summarize them in this turn. Omit tasks to read the latest finished tasks in this session; pass tasks to select specific ids (including running tasks). Results is read-only: it never starts a turn or marks results handled. Humans can inspect with /easy-bg ls and /easy-bg log. Do not block the chat by waiting or polling in a loop. Only use notify=now or watch when the user explicitly wants an automatic wake-up.",
				promptSnippet: "Start background shell tasks; inspect completion and logs explicitly (no automatic turn by default)",
				promptGuidelines: [
					"Prefer easy_bg over bash for commands that take more than ~10 seconds.",
					"After easy_bg run, do other useful work or end your turn. Do not sleep/tail/poll in a loop; by default results are parked and never open a model turn automatically.",
					"When asked to summarize multiple background tasks, use action=results with tasks=[ids] to read their statuses and output in one call, then synthesize an answer in this same turn. For a quick check use status; for a longer single log use logs. None of these open another turn.",
				],
				parameters: params,
				prepareArguments: (raw: any) => {
					const args = raw && typeof raw === "object" ? raw : {};
					const command = args.command ?? args.commands ?? args.cmd ?? args.commands_string;
					const out: any = {
						action: args.action ?? (command ? "run" : "status"),
					};
					if (command !== undefined) {
						out.command = Array.isArray(command) ? command.map(String) : [String(command)];
					}
					if (args.tasks !== undefined) out.tasks = Array.isArray(args.tasks) ? args.tasks.map(String) : [String(args.tasks)];
					for (const key of ["name", "task", "watch", "notify"] as const) if (args[key] !== undefined) out[key] = String(args[key]);
					const id = args.task ?? args.id;
					if (id !== undefined) out.task = String(id);
					const lines = args.lines ?? args.tail;
					if (lines !== undefined) out.lines = Number(lines) || 30;
					const timeout = args.timeout ?? args.timeoutSec;
					if (timeout !== undefined) out.timeout = Number(timeout);
					return out;
				},
				async execute(_toolCallId, args, _signal, _onUpdate, ctx) {
					const sid = ctx.sessionManager.getSessionId();
					latestCtx = ctx;
					const fail = (message: string) => ({ content: [{ type: "text" as const, text: message }], details: { error: message }, isError: true });

					if (args.action === "run") {
						const commands = (args.command ?? []).map((c) => String(c)).filter((c) => c.trim());
						if (commands.length === 0) return fail("easy_bg run needs at least one command");
						if (readTasks().filter((t) => t.status === "running").length + commands.length > MAX_RUNNING_TASKS) return fail(`task limit is ${MAX_RUNNING_TASKS} running; stop one first`);
						try {
							const created = commands.map((c, i) => startTask(startContext(ctx), { command: c, name: args.name && commands.length === 1 ? args.name : args.name ? `${args.name}-${i + 1}` : undefined, timeoutSec: args.timeout, watch: args.watch, notifyMode: args.notify as NotifyMode | undefined }, sid));
							const text = created.map((t) => `${t.id} RUNNING: ${t.command.replace(/\s*\n\s*/g, " \u23ce ").slice(0, 160)} (log: ${logPath(t)})`).join("\n") + `\nStarted ${created.length} task(s). By default, completion only shows a card; check later with action=status/logs or ask the user to use /easy-bg ls/log. No automatic model turn. Do not wait or poll in a loop.`;
							return { content: [{ type: "text" as const, text }], details: { ids: created.map((t) => t.id) } };
						} catch (error: any) {
							return fail(error?.message ?? String(error));
						}
					}

					if (args.action === "status") {
						const all = readTasks();
						const mine = all.filter((t) => t.session === sid || t.status === "running");
						if (mine.length === 0) return { content: [{ type: "text" as const, text: "no easy-bg tasks" }], details: { tasks: [] } };
						const lines = mine.map((t) => {
							const detail = t.status === "running" ? tailText(t, 3).split("\n").filter(Boolean).join(" | ").slice(0, 200) : tailText(t, 2).split("\n").filter(Boolean).join(" | ").slice(0, 200);
							return `${summaryLine(t)}\n   log: ${logPath(t)}${detail ? `\n   last: ${detail}` : ""}`;
						});
						return { content: [{ type: "text" as const, text: lines.join("\n") }], details: { tasks: mine.map((t) => ({ id: t.id, status: t.status, exitCode: t.exitCode ?? null, elapsed: elapsed(t), log: logPath(t) })) } };
					}

					if (args.action === "results") {
						const refs = args.tasks?.length ? args.tasks : args.task ? [args.task] : undefined;
						const selection = selectResultTasks(readTasks(), sid, refs);
						if (selection.error) return fail(selection.error);
						if (!selection.tasks.length) return { content: [{ type: "text" as const, text: "no finished easy-bg tasks in this session; use action=status to check running tasks" }], details: { tasks: [] } };
						const n = Math.min(Math.max(Math.trunc(args.lines ?? 30) || 30, 1), 100);
						const blocks = selection.tasks.map((t) => {
							const tail = tailText(t, n);
							const clipped = tail.length > RESULT_LOG_CHARS;
							const output = clipped ? `… (earlier output omitted; use action=logs for more)\n${tail.slice(-RESULT_LOG_CHARS)}` : tail || "(no output)";
							return `${summaryLine(t)}\nlog: ${logPath(t)}\n${output}`;
						});
						if (selection.omitted) blocks.push(`… ${selection.omitted} older finished task(s) omitted; pass tasks=[ids] to select them.`);
						return {
							content: [{ type: "text" as const, text: blocks.join("\n\n") }],
							details: { tasks: selection.tasks.map((t) => ({ id: t.id, status: t.status, exitCode: t.exitCode ?? null, log: logPath(t) })), omitted: selection.omitted },
						};
					}

					if (args.action === "logs") {
						const amb = ambiguous(args.task ?? "");
						if (amb.length > 1) return fail(`ambiguous id prefix "${args.task}", be more specific: ${amb.map((t) => `${t.id} (${t.status})`).join(", ")}`);
						const t = findTask(readTasks(), args.task ?? "", sid);
						if (!t) return fail(`no such task: ${args.task ?? "(none given)"}`);
						const n = Math.min(Math.max(args.lines ?? 30, 1), 400);
						return { content: [{ type: "text" as const, text: tailText(t, n) || `(no output yet; ${logSize(t)} bytes in ${logPath(t)})` }], details: { id: t.id, status: t.status } };
					}

					if (args.action === "stop") {
						const amb = ambiguous(args.task ?? "");
						if (amb.length > 1) return fail(`ambiguous id prefix "${args.task}", be more specific: ${amb.map((t) => `${t.id} (${t.status})`).join(", ")}`);
						const t = findTask(readTasks(), args.task ?? "", sid);
						if (!t) return fail(`no such task: ${args.task ?? "(none given)"}`);
						withTasks((all) => {
							const cur = all.find((x) => x.id === t.id);
							if (cur) killTask(cur, "user");
						});
						return { content: [{ type: "text" as const, text: `sent SIGTERM to ${t.id} process group` }], details: { id: t.id } };
					}

					let cleared = 0;
					withTasks((all) => {
						for (let i = all.length - 1; i >= 0; i--) {
							const t = all[i];
							if (!isTerminal(t.status) || t.session !== sid || (t.parkedAt && !t.handledAt)) continue;
							forget(t.id, t.startedAt);
							fs.rmSync(taskDir(t.id), { recursive: true, force: true });
							all.splice(i, 1);
							cleared++;
						}
					});
					return { content: [{ type: "text" as const, text: `${cleared} finished task(s) cleared; unhandled parked results and running tasks kept` }], details: { cleared } };
				},
			}),
		);
	}

	const ambiguous = (ref: string) => ambiguousIn(readTasks(), ref);

	function parseRunArgs(input: string) {
		const opts: { name?: string; timeoutSec?: number; watch?: string; notify: boolean; notifyMode?: NotifyMode } = { timeoutSec: DEFAULT_TIMEOUT_SEC, notify: true };
		let error: string | undefined;
		let rest = input.trim();
		for (;;) {
			const m = rest.match(/^--(name|timeout|watch|notify)[=\s]+(\S+)\s*/);
			if (m) {
				rest = rest.slice(m[0].length).trim();
				if (m[1] === "name") opts.name = m[2];
				else if (m[1] === "timeout") opts.timeoutSec = Math.max(0, Number.parseInt(m[2], 10) || 0);
				else if (m[1] === "notify") {
					if (NOTIFY_MODES.includes(m[2] as NotifyMode)) opts.notifyMode = m[2] as NotifyMode;
					else error = `invalid notify mode "${m[2]}"; choose park, now or manual`;
				}
				else opts.watch = m[2];
				continue;
			}
			if (rest.startsWith("--no-notify")) {
				opts.notify = false;
				rest = rest.slice("--no-notify".length).trim();
				continue;
			}
			break;
		}
		return { opts, command: rest, error };
	}

	function stopById(ref: string, sid: string): string {
		const amb = ambiguous(ref);
		if (amb.length > 1) return `ambiguous "${ref}", be more specific: ${amb.map((t) => `${t.id} (${t.status})`).join(", ")}`;
		const t = findTask(readTasks(), ref, sid);
		if (!t) return `no such task: ${ref}`;
		withTasks((all) => {
			const cur = all.find((x) => x.id === t.id);
			if (cur) killTask(cur, "user");
		});
		return `sent SIGTERM to ${t.id} process group (${t.command.slice(0, 80)})`;
	}

	pi.registerCommand("easy-bg", {
		description: "Background shell tasks: /easy-bg <cmd> | ls | log <id> [n] | stop <id> | clear | help",
		getArgumentCompletions: (prefix) => {
			try {
				const subs = ["ls", "log", "stop", "now", "clear", "clear --all", "help", "--name", "--timeout", "--watch", "--notify", "--no-notify"];
				const ids = readTasks().map((t) => ({ id: t.id, status: t.status, cmd: t.command }));
				// AutocompleteItem 要求 label 必填：pi 的 applyCompletion 会读 item.label.endsWith("/")。
				const items = subs.filter((s) => s.startsWith(prefix)).map((s) => ({ value: s, label: s, description: "easy-bg subcommand/flag" }));
				const idItems = ids
					.filter((t) => t.id.startsWith(prefix) || t.cmd.includes(prefix) || (t.id === prefix && t.status !== "running"))
					.slice(-8)
					.map((t) => ({ value: t.id, label: t.id, description: `${t.status} · ${t.cmd.slice(0, 40)}` }));
				return [...items, ...idItems];
			} catch {
				return null;
			}
		},
		handler: async (args, ctx) => {
			latestCtx = ctx;
			const sid = ctx.sessionManager.getSessionId();
			const input = args.trim();
			const [head, ...restTokens] = input.split(/\s+/);
			const sub = (head ?? "").toLowerCase();

			if (input === "" || ["ls", "list", "status", "ps"].includes(sub)) {
				const all = readTasks();
				card(all.length ? `running + finished (${all.filter((t) => t.status === "running").length} running)` : "no tasks", all.map(summaryLine));
				return;
			}
			if (["log", "logs", "tail"].includes(sub)) {
				const ref = restTokens[0] ?? "";
				const amb = ambiguous(ref);
				if (amb.length > 1) {
					card(`ambiguous id prefix "${ref}" — be more specific`, amb.map(summaryLine));
					return;
				}
				const n = Number.parseInt(restTokens[1] ?? "40", 10) || 40;
				const t = findTask(readTasks(), ref, sid);
				if (!t) {
					ctx.ui.notify(`no such task: ${ref}`, "warning");
					return;
				}
				card(`${t.id} · ${STATUS_LABEL[t.status]} · ${(logSize(t) / 1024).toFixed(0)}KB · ${logPath(t)}`, tailText(t, n).split("\n"));
				return;
			}
			if (["stop", "kill"].includes(sub)) {
				const msg = stopById(restTokens.join(" "), sid);
				card(msg, []);
				return;
			}
			if (["now", "deal", "handle", "flush"].includes(sub)) {
				const ref = restTokens[0];
				if (ref && ambiguous(ref).length > 1) {
					card(`ambiguous id prefix "${ref}" — be more specific`, ambiguous(ref).map(summaryLine));
					return;
				}
				const wanted = ref ? new Set(ambiguous(ref).map((t) => t.id)) : undefined;
				const matches = (t: Task) => !wanted || wanted.has(t.id);
				if (!ctx.isIdle() || ctx.hasPendingMessages()) {
					// 不 followUp 插入当前 turn：登记需求，等当前 turn 结束、真正空闲时开独立 turn
					let marked = 0;
					withTasks((all) => {
						for (const t of all) {
							if (t.parkedAt && !t.handledAt && matches(t)) { t.wantedAt = Date.now(); marked++; }
						}
					});
					if (ctx.hasUI) ctx.ui.notify(marked ? `easy-bg: ${marked} result(s) queued — will be handled in a separate turn as soon as this one ends` : "easy-bg: nothing parked to handle", marked ? "info" : "warning");
					return;
				}
				const n = flushParked(ctx, matches);
				if (ctx.hasUI) ctx.ui.notify(n ? `easy-bg: ${n} parked result(s) handed to the model now` : "easy-bg: nothing parked to handle", n ? "info" : "warning");
				return;
			}
			if (["clear", "clean"].includes(sub)) {
				// 方案 A：默认只清「本 session 的、已处理过的」终态任务。
				// - running 永不清理（进程还在跑，清掉记录 = 失去 stop 与结果）
				// - 未处理结果（parked && !handled）默认保留：见 R17，结果不该被静默丢弃
				// - 其他 session 的记录默认不碰（多个 pi 会话共享同一 stateDir）
				// --all：清所有 session 的全部终态，含未处理结果
				const allSessions = restTokens.includes("--all") || restTokens.includes("-a");
				let cleared = 0;
				let keptUnhandled = 0;
				let keptOther = 0;
				withTasks((list) => {
					for (let i = list.length - 1; i >= 0; i--) {
						const t = list[i];
						if (!isTerminal(t.status)) continue;
						const mine = t.session === sid;
						const unhandled = !!t.parkedAt && !t.handledAt;
						if (!allSessions) {
							if (!mine) { keptOther++; continue; }
							if (unhandled) { keptUnhandled++; continue; }
						}
						forget(t.id, t.startedAt);
						fs.rmSync(taskDir(t.id), { recursive: true, force: true });
						list.splice(i, 1);
						cleared++;
					}
				});
				const bits = [`${cleared} cleared`];
				if (keptUnhandled) bits.push(`${keptUnhandled} unhandled kept → /easy-bg now`);
				if (keptOther) bits.push(`${keptOther} from other sessions kept → /easy-bg clear --all`);
				const running = readTasks().filter((t) => t.status === "running").length;
				if (running) bits.push(`${running} running untouched`);
				if (!cleared && !keptUnhandled && !keptOther && !running) bits[0] = "nothing to clear";
				if (ctx.hasUI) ctx.ui.notify(`easy-bg: ${bits.join(" · ")}`, cleared ? "info" : "warning");
				else card("clear", [bits.join(" · ")]);
				return;
			}
			if (sub === "help") {
				card(
					"usage",
					[
						"/easy-bg <command>                 start a background task (bare form)",
						'/easy-bg run [--name X] [--timeout 0] [--watch /re/] <command>',
						"/easy-bg ls                        list tasks",
						"/easy-bg log <id> [lines]          tail a task log",
						"/easy-bg stop <id>                 kill a task process group",
						"/easy-bg now [id]                explicitly hand parked results to the model",
						"agent tool: easy_bg action=results tasks=[ids] reads multiple results in the current turn; no /easy-bg results command",
						"park (default): result card only; check with /easy-bg ls/log or easy_bg status/logs; never opens a model turn automatically",
						"notify modes (park|now|manual) via --notify; EASY_BG_NOTIFY sets the default",
						"/easy-bg clear                     drop finished tasks of THIS session (keeps unhandled results)",
						"/easy-bg clear --all               drop every finished task, all sessions, including unhandled results",
						`ids look like bg-3f9a2c; stop / log accept a unique prefix (bg-3f)`,
						`defaults: timeout ${DEFAULT_TIMEOUT_SEC}s, cap ${Math.round(DEFAULT_MAX_BYTES / 1024 / 1024)}MB, max ${MAX_RUNNING_TASKS} running`,
						`state: ${tasksFile()}`,
					],
				);
				return;
			}

			const runInput = sub === "run" ? input.slice(head.length).trim() : input;
			const { opts, command, error } = parseRunArgs(runInput);
			if (error) {
				ctx.ui.notify(error, "warning");
				return;
			}
			if (!command) {
				ctx.ui.notify("usage: /easy-bg [--name X] [--timeout 0] [--watch re] <command>", "warning");
				return;
			}
			try {
				const task = startTask(ctx, { command, ...opts, notify: opts.notify }, sid);
				card(`${task.id} started: ${command}`, [`RUNNING pid=${task.pid} cwd=${task.cwd}`, `log: ${logPath(task)}`, `/easy-bg log ${task.id}`]);
				if (ctx.hasUI) ctx.ui.notify(`easy-bg ${task.id} started: ${command.slice(0, 70)}`, "info");
			} catch (error: any) {
				ctx.ui.notify(error?.message ?? String(error), "error");
			}
		},
	});

	// 可选快捷键（默认不注册，避免抢编辑器按键）：EASY_BG_KEY="ctrl+shift+b"
	const key = process.env.EASY_BG_KEY;
	if (key) {
		pi.registerShortcut(key as any, {
			description: "easy-bg: list tasks",
			handler: async (ctx) => {
				latestCtx = ctx;
				const all = readTasks();
				card(`running + finished (${all.filter((t) => t.status === "running").length} running)`, all.length ? all.map(summaryLine) : ["no tasks"]);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		try {
			ctx.ui.notify(`easy-bg v${VERSION} · /easy-bg help · notify: park|now|manual`, "info");
		} catch {
			/* ignore */
		}
		latestCtx = ctx;
		dir();
		prune();
		const sid = ctx.sessionManager.getSessionId();
		const staleIds = new Set(readTasks().filter((t) => t.status === "running" && !alive(t.pid)).map((t) => t.id));
		if (staleIds.size) withTasks((all) => {
			for (const t of all) if (staleIds.has(t.id)) resolveTerminal(t);
		});
		const running = readTasks().filter((t) => t.status === "running");
		if (running.length && ctx.hasUI) ctx.ui.notify(`easy-bg: ${running.length} background task(s) still running`, "info");
		if (!started) {
			started = true;
			const timer = setInterval(() => {
				try {
					tick();
				} catch (error: any) {
					console.error(`[easy-bg] tick error: ${error?.message ?? error}`);
				}
			}, TICK_MS);
			timers.push(timer);
			// 高频只做 size 检查：正常情况只是一次 statSync，不写 tasks.json
			const capTimer = setInterval(() => {
				try {
					for (const t of readTasks()) {
						if (t.status !== "running") continue;
						if (logSize(t) > t.maxBytes) {
							withTasks((all) => {
								const cur = all.find((x) => x.id === t.id);
								if (cur && cur.status === "running") enforceCap(cur);
							});
						}
					}
				} catch (error: any) {
					console.error(`[easy-bg] cap check error: ${error?.message ?? error}`);
				}
			}, CAP_CHECK_MS);
			timers.push(capTimer);
			timer.unref?.();
		}
		renderStatus(ctx, readTasks());
		if (staleIds.size) card("tasks from a previous pi run whose process is gone", readTasks().filter((t) => staleIds.has(t.id)).map(summaryLine));
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const t of timers) clearInterval(t);
		timers = [];
		started = false;
		const running = readTasks().filter((t) => t.status === "running" && t.session === ctx.sessionManager.getSessionId());
		if (running.length) {
			log(`${running.length} background task(s) left running: ${running.map((t) => `${t.id} (${t.command.slice(0, 40)})`).join(", ")} — a future pi session will adopt them`);
			if (pi.getFlag("easy-bg-kill-all")) {
				withTasks((all) => {
					for (const t of all) if (t.status === "running" && t.session === ctx.sessionManager.getSessionId()) killTask(t, "user");
				});
				log("--easy-bg-kill-all: killed them");
			}
		}
	});
}
