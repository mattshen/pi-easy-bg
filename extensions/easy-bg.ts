/**
 * pi-easy-bg — pi integration
 *
 * Registers `/easy-bg` and the `easy_bg` model tool. Tasks are observed on disk;
 * results are read only on explicit request. Plain logic lives in `src/core.ts`.
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
	DEFAULT_TIMEOUT_SEC,
	LEASE_MS,
	MAX_RUNNING_TASKS,
	MAX_HANDLE_TASKS,
	HANDLE_LOG_CHARS,
	RETENTION_COUNT,
	RETENTION_MS,
	STATUS_LABEL,
	TAIL_BYTES,
	TICK_MS,
	alive,
	acknowledgeTasks,
	ambiguousIn,
	commandHint,
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
	selectHandleTasks,
	startTask,
	summaryLine,
	tailText,
	taskDir,
	truncateTail,
	tasksFile,
	withTasks,
} from "../src/core.ts";
import type { StartContext, Task } from "../src/core.ts";

export default function (pi: ExtensionAPI) {
	pi.registerFlag("no-easy-bg-tool", { description: "Do not expose the easy_bg tool to the model (keep only /easy-bg)" });
	pi.registerFlag("easy-bg-kill-all", { description: "Kill all easy-bg tasks when this pi session exits" });

	let latestCtx: ExtensionContext | undefined;
	let started = false;
	let timers: ReturnType<typeof setInterval>[] = [];
	let gcAt = 0;

	const startContext = (ctx: ExtensionContext): StartContext => ({
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile() ?? undefined,
		modelId: ctx.model?.id ?? undefined,
		thinkingLevel: ctx.thinkingLevel ?? undefined,
	});

	const head = (t: Task) => `[easy-bg] ${t.id}${t.name ? ` "${t.name}"` : ""} ${STATUS_LABEL[t.status]} ${t.exitCode !== undefined ? `exit=${t.exitCode}` : ""} in ${elapsed(t)}`;

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

	// 只有显式 /easy-bg handle 才开启 turn；agent 的 action=handle 在当前 turn 返回。
	const handleFinished = (ctx: ExtensionContext, filter?: (t: Task) => boolean): number => {
		const sid = ctx.sessionManager.getSessionId();
		const pending = readTasks().filter((t) => t.session === sid && isTerminal(t.status) && !t.handledAt && (!filter || filter(t)));
		if (!pending.length) return 0;
		const body = pending.map((t) => `\u25b8 ${head(t)}\n${tailText(t, 12) || "(no output)"}`).join("\n\n");
		if (!openTurn(`Please handle these background results (${pending.length}), separately from earlier requests:\n\n${body}\n\nFor more output, use /easy-bg inspect <id> or easy_bg action=inspect.`, ctx)) return 0;
		withTasks((all) => acknowledgeTasks(all, new Set(pending.map((t) => t.id))));
		return pending.length;
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
		withTasks((all) => {
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
			}
		});

		if (now - gcAt > 5 * 60 * 1000) {
			gcAt = now;
			prune();
		}
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
			action: Type.Union([Type.Literal("run"), Type.Literal("status"), Type.Literal("handle"), Type.Literal("inspect"), Type.Literal("stop"), Type.Literal("clear")], { description: "run: start tasks; status: list tasks; handle: hand up to 10 results to this turn and mark finished tasks handled; inspect: read one log without handling; stop: kill a task; clear: drop handled finished records" }),
			command: Type.Optional(Type.Array(Type.String(), { description: "For action=run: one or more shell commands. Each command becomes its own background task (parallelism handled here, not by issuing parallel calls)." })),
			name: Type.Optional(Type.String({ description: "Optional short label for the task" })),
			task: Type.Optional(Type.String({ description: "Task id (e.g. bg-1) for inspect/stop, or one task to handle" })),
			tasks: Type.Optional(Type.Array(Type.String(), { description: `For handle: task ids or unique prefixes (up to ${MAX_HANDLE_TASKS}). Omit to handle up to ${MAX_HANDLE_TASKS} unhandled finished tasks in this session.` })),
			lines: Type.Optional(Type.Number({ description: "Log lines to return (default 30; max 400 for inspect, 100 per task for handle)" })),
			timeout: Type.Optional(Type.Number({ description: `Kill after N seconds (default ${DEFAULT_TIMEOUT_SEC}; 0 = no timeout)` })),
		});

		pi.registerTool(
			defineTool({
				name: "easy_bg",
				label: "Background task",
				description:
					"Run shell commands in the background without blocking the chat. Completion is silent: use action=status or action=inspect to check, then action=handle to read results in this CURRENT turn and mark finished tasks handled. Without ids, handle takes up to 10 unhandled finished tasks in this session; pass tasks=[ids] to select specific tasks, including running ones (which remain unhandled). Humans use /easy-bg ls, inspect and handle; only explicit /easy-bg handle opens a turn. Do not wait or poll in a loop.",
				promptSnippet: "Start background shell tasks; check with status/inspect, handle results in the current turn",
				promptGuidelines: [
					"Prefer easy_bg over bash for commands that take more than ~10 seconds.",
					"After easy_bg run, do other useful work or end your turn. Completion is silent; use status/inspect/handle when you need results. Do not sleep/tail/poll in a loop.",
					"When asked to summarize background tasks, use action=handle to read their output in this turn; pass tasks=[ids] to select specific tasks. Use status for a quick check or inspect to read a single log without handling it.",
				],
				parameters: params,
				prepareArguments: (raw: any) => {
					const args = raw && typeof raw === "object" ? raw : {};
					if (args.watch !== undefined || args.notify !== undefined) throw new Error("watch/notify options have been removed; use status/inspect/handle to check results");
					const command = args.command ?? args.commands ?? args.cmd ?? args.commands_string;
					const out: any = {
						action: args.action ?? (command ? "run" : "status"),
					};
					if (command !== undefined) {
						out.command = Array.isArray(command) ? command.map(String) : [String(command)];
					}
					if (args.tasks !== undefined) out.tasks = Array.isArray(args.tasks) ? args.tasks.map(String) : [String(args.tasks)];
					for (const key of ["name", "task"] as const) if (args[key] !== undefined) out[key] = String(args[key]);
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
							const created = commands.map((c, i) => startTask(startContext(ctx), { command: c, name: args.name && commands.length === 1 ? args.name : args.name ? `${args.name}-${i + 1}` : undefined, timeoutSec: args.timeout }, sid));
							const text = created.map((t) => `${t.id} RUNNING: ${t.command.replace(/\s*\n\s*/g, " \u23ce ").slice(0, 160)} (log: ${logPath(t)})`).join("\n") + `\nStarted ${created.length} task(s). Completion is silent; use status/inspect to check or handle to process results.`;
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

					if (args.action === "handle") {
						const refs = args.tasks?.length ? args.tasks : args.task ? [args.task] : undefined;
						const selection = selectHandleTasks(readTasks(), sid, refs);
						if (selection.error) return fail(selection.error);
						if (!selection.tasks.length) return { content: [{ type: "text" as const, text: "no unhandled finished tasks in this session; use action=status to check tasks" }], details: { tasks: [] } };
						const n = Math.min(Math.max(Math.trunc(args.lines ?? 30) || 30, 1), 100);
						const blocks = selection.tasks.map((t) => {
							const tail = tailText(t, n);
							const clipped = tail.length > HANDLE_LOG_CHARS;
							const output = clipped ? `… (earlier output omitted; use action=inspect for more)\n${tail.slice(-HANDLE_LOG_CHARS)}` : tail || "(no output)";
							return `${summaryLine(t)}\nlog: ${logPath(t)}\n${output}`;
						});
						if (selection.omitted) blocks.push(`… ${selection.omitted} more unhandled result(s) remain; call handle again or pass tasks=[ids].`);
						// 运行中任务仍保持未处理；终态结果已放入当前工具响应。
						const ids = new Set(selection.tasks.map((t) => t.id));
						withTasks((all) => acknowledgeTasks(all, ids));
						return {
							content: [{ type: "text" as const, text: blocks.join("\n\n") }],
							details: { tasks: selection.tasks.map((t) => ({ id: t.id, status: t.status, exitCode: t.exitCode ?? null, log: logPath(t) })), omitted: selection.omitted },
						};
					}

					if (args.action === "inspect") {
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
							if (!isTerminal(t.status) || t.session !== sid || !t.handledAt) continue;
							fs.rmSync(taskDir(t.id), { recursive: true, force: true });
							all.splice(i, 1);
							cleared++;
						}
					});
					return { content: [{ type: "text" as const, text: `${cleared} handled task(s) cleared; unhandled results and running tasks kept` }], details: { cleared } };
				},
			}),
		);
	}

	const ambiguous = (ref: string) => ambiguousIn(readTasks(), ref);

	function parseRunArgs(input: string) {
		const opts: { name?: string; timeoutSec?: number } = { timeoutSec: DEFAULT_TIMEOUT_SEC };
		let error: string | undefined;
		let rest = input.trim();
		for (;;) {
			const m = rest.match(/^--(name|timeout)[=\s]+(\S+)\s*/);
			if (m) {
				rest = rest.slice(m[0].length).trim();
				if (m[1] === "name") opts.name = m[2];
				else opts.timeoutSec = Math.max(0, Number.parseInt(m[2], 10) || 0);
				continue;
			}
			if (/^--(?:watch|notify|no-notify)(?:[=\s]|$)/.test(rest)) {
				error = "watch/notify options have been removed; use ls/inspect/handle to check results";
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
		description: "Background shell tasks: /easy-bg <cmd> | ls | inspect <id> [n] | handle [id] | stop <id> | clear | help",
		getArgumentCompletions: (prefix) => {
			try {
				const subs = ["ls", "inspect", "handle", "stop", "clear", "clear --all", "help", "--name", "--timeout"];
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
			if (sub === "inspect") {
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
			if (sub === "handle") {
				const ref = restTokens[0];
				if (ref && ambiguous(ref).length > 1) {
					card(`ambiguous id prefix "${ref}" — be more specific`, ambiguous(ref).map(summaryLine));
					return;
				}
				const wanted = ref ? new Set(ambiguous(ref).map((t) => t.id)) : undefined;
				const matches = (t: Task) => !wanted || wanted.has(t.id);
				const n = handleFinished(ctx, matches);
				if (ctx.hasUI) ctx.ui.notify(n ? `easy-bg: ${n} result(s) handed to the model` : "easy-bg: nothing to handle", n ? "info" : "warning");
				return;
			}
			if (["clear", "clean"].includes(sub)) {
				// 默认仅清本 session 已处理的终态；--all 清全部终态（含未处理）。
				const allSessions = restTokens.includes("--all") || restTokens.includes("-a");
				let cleared = 0;
				let keptUnhandled = 0;
				let keptOther = 0;
				withTasks((list) => {
					for (let i = list.length - 1; i >= 0; i--) {
						const t = list[i];
						if (!isTerminal(t.status)) continue;
						const mine = t.session === sid;
						const unhandled = !t.handledAt;
						if (!allSessions) {
							if (!mine) { keptOther++; continue; }
							if (unhandled) { keptUnhandled++; continue; }
						}
						fs.rmSync(taskDir(t.id), { recursive: true, force: true });
						list.splice(i, 1);
						cleared++;
					}
				});
				const bits = [`${cleared} cleared`];
				if (keptUnhandled) bits.push(`${keptUnhandled} unhandled kept → /easy-bg handle`);
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
						'/easy-bg run [--name X] [--timeout 0] <command>',
						"/easy-bg ls                        list tasks",
						"/easy-bg inspect <id> [lines]      view a task log without marking it handled",
						"/easy-bg stop <id>                 kill a task process group",
						"/easy-bg handle [id]              send unhandled results to the model in a new turn",
						"agent tool: easy_bg action=handle tasks=[ids] handles results in the current turn",
						"completion is silent; ls/inspect read without handling; handle marks finished results handled",
						"/easy-bg clear                     drop finished tasks of THIS session (keeps unhandled results)",
						"/easy-bg clear --all               drop every finished task, all sessions, including unhandled results",
						`ids look like bg-3f9a2c; stop / inspect / handle accept a unique prefix (bg-3f)`,
						`defaults: timeout ${DEFAULT_TIMEOUT_SEC}s, cap ${Math.round(DEFAULT_MAX_BYTES / 1024 / 1024)}MB, max ${MAX_RUNNING_TASKS} running`,
						`state: ${tasksFile()}`,
					],
				);
				return;
			}

			if (["now", "deal", "flush", "results", "log", "logs", "tail"].includes(sub)) {
				ctx.ui.notify(`unknown easy-bg subcommand "${sub}"; use /easy-bg ${["log", "logs", "tail"].includes(sub) ? "inspect <id>" : "handle [id]"}`, "warning");
				return;
			}

			const runInput = sub === "run" ? input.slice(head.length).trim() : input;
			const { opts, command, error } = parseRunArgs(runInput);
			if (error) {
				ctx.ui.notify(error, "warning");
				return;
			}
			if (!command) {
				ctx.ui.notify("usage: /easy-bg [--name X] [--timeout 0] <command>", "warning");
				return;
			}
			try {
				const task = startTask(ctx, { command, ...opts }, sid);
				card(`${task.id} started: ${command}`, [`RUNNING pid=${task.pid} cwd=${task.cwd}`, `log: ${logPath(task)}`, `/easy-bg inspect ${task.id}`]);
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
		latestCtx = ctx;
		if (ctx.hasUI) ctx.ui.setStatus("easy-bg", undefined); // clear status left by older versions
		dir();
		prune();
		const sid = ctx.sessionManager.getSessionId();
		const staleIds = new Set(readTasks().filter((t) => t.status === "running" && !alive(t.pid)).map((t) => t.id));
		if (staleIds.size) withTasks((all) => {
			for (const t of all) if (staleIds.has(t.id)) resolveTerminal(t);
		});
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
			capTimer.unref?.();
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		for (const t of timers) clearInterval(t);
		timers = [];
		started = false;
		const running = readTasks().filter((t) => t.status === "running" && t.session === ctx.sessionManager.getSessionId());
		if (running.length) {
			console.log(`[easy-bg] ${running.length} background task(s) left running; a future pi session may adopt them`);
			if (pi.getFlag("easy-bg-kill-all")) {
				withTasks((all) => {
					for (const t of all) if (t.status === "running" && t.session === ctx.sessionManager.getSessionId()) killTask(t, "user");
				});
				console.log("[easy-bg] --easy-bg-kill-all: killed them");
			}
		}
	});
}
