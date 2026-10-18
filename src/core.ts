/**
 * pi-easy-bg — core logic (no pi imports; unit-testable)
 *
 * Everything here is plain Node: state files, ids, log tails, status resolution,
 * task spawning, watch patterns and formatting. The pi integration lives in
 * `extensions/easy-bg.ts`.
 */

/**
 * pi-easy-bg — background shell tasks for pi
 *
 * User interface:  /easy-bg (bare form = run)
 * Model interface: single tool `easy_bg` (action: run | status | logs | stop | clear)
 *
 * Design goals:
 *  - Return immediately: the chat is never blocked by a long command
 *  - Parallelism lives in the harness: one run can start several tasks; one status returns all
 *  - Event-driven delivery: results arrive on their own, without model-side polling
 *  - Results never leak into unrelated turns: the card is display-only, delivery waits for
 *    an idle-and-quiet window (see NOTIFY modes below)
 *  - Persistent state: survives pi restarts and session switches (heartbeat + adoption)
 *  - Bounded output: per-task byte cap, process-group kill, ANSI-stripped tails
 *
 * Reference specification: https://github.com/mattshen/my-docs/issues/62
 *
 * Turn off the model-facing tool:  pi --no-easy-bg-tool
 * Override the state directory:    EASY_BG_DIR=/path
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const VERSION = "1.0.2";
export const DEFAULT_TIMEOUT_SEC = Number(process.env.EASY_BG_TIMEOUT_SEC) || 600;
export const DEFAULT_MAX_BYTES = Number(process.env.EASY_BG_MAX_BYTES) || 20 * 1024 * 1024;
export const MAX_RUNNING_TASKS = 8;
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const RETENTION_COUNT = 50;
export const TICK_MS = 1500;
// 输出上限检查频率：必须远快于 TICK_MS，否则爆发型输出（yes / urandom）会先写满磁盘
export const CAP_CHECK_MS = 100;
export const LEASE_MS = 5000;
export const ADOPT_STALE_MS = 20000;
export const TAIL_BYTES = 64 * 1024;
export const NOTIFY_TAIL_LINES = 20;
// auto 模式：只有在“用户空闲且静默”持续这么久之后才主动 report，避免打断/污染用户正在做的 foreground 任务
export const QUIET_MS = Number(process.env.EASY_BG_QUIET_MS) || 8000;
// 内存去重账本上限。它只是“同一进程内”的防抖；权威去重依据是磁盘上的 task.notified，
// 所以到顶时整体清空是安全的（最坏情况只是多走一次已处理判断），但可防单调增长。
export const NOTIFY_KEYS_MAX = 5000;
export const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export type TaskStatus = "running" | "done" | "failed" | "killed" | "timeout" | "output_cap" | "exited";
export type KillReason = "user" | "timeout" | "output_cap";
export type NotifyMode = "auto" | "now" | "park" | "manual";

export const NOTIFY_MODES: NotifyMode[] = ["auto", "now", "park", "manual"];
// auto = 不打断前台：安全边界才投递；now = 完成即开 turn；park = 永远等你 /easy-bg now；manual = 完全不进上下文
export const DEFAULT_NOTIFY: NotifyMode = NOTIFY_MODES.includes((process.env.EASY_BG_NOTIFY ?? "") as NotifyMode) ? (process.env.EASY_BG_NOTIFY as NotifyMode) : "auto";

export interface Task {
	id: string;
	name?: string;
	command: string;
	cwd: string;
	pid: number;
	session: string;
	startedAt: number;
	endedAt?: number;
	exitCode?: number | null;
	status: TaskStatus;
	timeoutSec: number;
	maxBytes: number;
	watch?: string;
	notify: boolean;
	notifyMode?: NotifyMode;
	notified?: boolean;
	parkedAt?: number;
	handledAt?: number;
	// 用户已 /easy-bg now，但当时 agent 不空闲：等空闲后立刻投递（仍然开独立 turn，不 followUp 插入当前 turn）
	wantedAt?: number;
	patternNotified?: boolean;
	killReason?: KillReason;
	capped?: boolean;
	note?: string;
	claimedBy?: string;
	claimedAt?: number;
}

export const STATUS_LABEL: Record<TaskStatus, string> = {
	running: "RUNNING",
	done: "DONE",
	failed: "FAIL",
	killed: "KILLED",
	timeout: "TIMEOUT",
	output_cap: "OUTPUT_CAP",
	exited: "EXITED",
};

export function isTerminal(status: TaskStatus): boolean {
	return status !== "running";
}

export function dir(): string {
	const base = process.env.EASY_BG_DIR || path.join(os.homedir(), ".pi", "agent", "easy-bg");
	fs.mkdirSync(base, { recursive: true });
	return base;
}

export function taskDir(id: string): string {
	return path.join(dir(), id);
}

export function tasksFile(): string {
	return path.join(dir(), "tasks.json");
}

export function readTasks(): Task[] {
	try {
		const raw = JSON.parse(fs.readFileSync(tasksFile(), "utf8"));
		return Array.isArray(raw) ? (raw as Task[]).filter((t) => t && typeof t.id === "string") : [];
	} catch {
		return [];
	}
}

export function writeTasks(tasks: Task[]): void {
	const file = tasksFile();
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(tasks, null, 1));
	fs.renameSync(tmp, file);
}

export function withTasks(mutator: (tasks: Task[]) => void): Task[] {
	const tasks = readTasks();
	mutator(tasks);
	writeTasks(tasks);
	return tasks;
}

// id = 唯一短串（bg-3f9a2c）：clear / GC / 跨重启 / 多实例都不会复用，
// stop / log 支持唯一前缀（例：bg-3f）。不再用可读递增号。
export function nextId(tasks: Task[]): string {
	const taken = new Set(tasks.map((t) => t.id));
	for (let i = 0; i < 8; i++) {
		const id = `bg-${randomBytes(3).toString("hex")}`;
		if (!taken.has(id)) return id;
	}
	return `bg-${Date.now().toString(16)}${process.pid.toString(16)}`;
}

export function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

export function readExitCode(t: Task): number | undefined {
	try {
		const raw = fs.readFileSync(path.join(taskDir(t.id), "exit"), "utf8").trim();
		const code = Number.parseInt(raw, 10);
		return Number.isFinite(code) ? code : undefined;
	} catch {
		return undefined;
	}
}

export function logPath(t: Task): string {
	return path.join(taskDir(t.id), "out.log");
}

export function logSize(t: Task): number {
	try {
		return fs.statSync(logPath(t)).size;
	} catch {
		return 0;
	}
}

// 把日志截断到最多 keep 字节，保留尾部（诊断价值更高）
export function truncateTail(t: Task, keep: number): void {
	const file = logPath(t);
	try {
		const size = fs.statSync(file).size;
		if (size <= keep) return;
		const fd = fs.openSync(file, "r");
		const buf = Buffer.alloc(keep);
		fs.readSync(fd, buf, 0, keep, size - keep);
		fs.closeSync(fd);
		fs.writeFileSync(file, buf);
	} catch {
		/* best effort */
	}
}

export function tailText(t: Task, lines: number): string {
	try {
		const fd = fs.openSync(logPath(t), "r");
		const size = fs.fstatSync(fd).size;
		const len = Math.min(size, TAIL_BYTES);
		const buf = Buffer.alloc(len);
		fs.readSync(fd, buf, 0, len, size - len);
		fs.closeSync(fd);
		const text = buf.toString("utf8").replace(ANSI, "");
		return text.split("\n").filter((l) => l.trim()).slice(-lines).join("\n");
	} catch {
		return "";
	}
}

export function elapsed(t: Task): string {
	const end = t.endedAt ?? Date.now();
	const sec = Math.max(0, Math.round((end - t.startedAt) / 1000));
	if (sec < 90) return `${sec}s`;
	if (sec < 5400) return `${Math.round(sec / 60)}m`;
	return `${(sec / 3600).toFixed(1)}h`;
}

function escapeRegex(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * `substring` -> literal match; `/body/flags` -> regex.
 *
 * Only non-stateful flags are kept: `g`/`y` make `.test()` remember `lastIndex`,
 * so a repeated tick would alternate between match and miss. Unknown letters are
 * dropped instead of throwing (a bad flag must not break the observation loop),
 * and a malformed body falls back to a literal match. Matching is always
 * case-insensitive, as documented.
 */
export function compileWatch(pattern: string): RegExp {
	const m = pattern.match(/^\/(.*)\/([a-z]*)$/);
	if (!m) return new RegExp(escapeRegex(pattern), "i");
	const allowed = new Set(["d", "i", "m", "s"]);
	const flags = [...new Set([...m[2].split("").filter((f) => allowed.has(f)), "i"])].join("");
	try {
		return new RegExp(m[1], flags);
	} catch {
		return new RegExp(escapeRegex(pattern), "i");
	}
}

export function killTask(t: Task, reason: KillReason): void {
	if (isTerminal(t.status)) return;
	t.killReason = reason;
	for (const sig of ["SIGTERM", "SIGKILL"] as const) {
		try {
			process.kill(-t.pid, sig);
			break;
		} catch {
			try {
				process.kill(t.pid, sig);
				break;
			} catch {
				/* already gone */
			}
		}
	}
}

export function resolveTerminal(t: Task): void {
	const code = readExitCode(t);
	if (code !== undefined) {
		t.exitCode = code;
		try {
			t.endedAt = t.endedAt ?? fs.statSync(path.join(taskDir(t.id), "exit")).mtimeMs;
		} catch {
			t.endedAt = t.endedAt ?? Date.now();
		}
		// killReason 必须优先于退出码：harness 发起的 SIGTERM 会让 wrapper 的 EXIT trap 记下 0，
		// 若先看 code===0 就会把 KILLED/TIMEOUT/OUTPUT_CAP 全部错报成 DONE。
		t.status =
			t.killReason === "timeout" ? "timeout"
			: t.killReason === "output_cap" ? "output_cap"
			: t.killReason === "user" ? "killed"
			: code === 0 ? "done"
			: "failed";
		return;
	}
	t.status = t.killReason === "timeout" ? "timeout" : t.killReason === "output_cap" ? "output_cap" : t.killReason === "user" ? "killed" : "exited";
	t.endedAt = t.endedAt ?? Date.now();
}

export interface StartContext {
	cwd: string;
	sessionId: string;
	sessionFile?: string;
	modelId?: string;
	thinkingLevel?: string;
}

export interface StartSpec {
	command: string;
	name?: string;
	timeoutSec?: number;
	maxBytes?: number;
	watch?: string;
	notify?: boolean;
	notifyMode?: NotifyMode;
}

export function startTask(sc: StartContext, spec: StartSpec, sid: string): Task {
	const command = spec.command.trim();
	if (!command) throw new Error("empty command");
	if (readTasks().filter((t) => t.status === "running").length >= MAX_RUNNING_TASKS) {
		throw new Error(`task limit reached (${MAX_RUNNING_TASKS} running); stop one first`);
	}

	const tasks = readTasks();
	const id = nextId(tasks);
	const home = taskDir(id);
	fs.mkdirSync(home, { recursive: true });
	const out = path.join(home, "out.log");
	const exit = path.join(home, "exit");
	const script = path.join(home, "cmd.sh");
	// 用 trap EXIT 记录退出码：否则 `set -e` 中途失败或脚本内 `exit N` 会跳过捕获，
	// exit 文件缺失 → 任务被误判为 EXITED 而不是 FAIL。
	const trapExit = `trap '__easy_bg_st=$?; printf "%s\\n" "$__easy_bg_st" > ${JSON.stringify(exit)}' EXIT`;
	// 以 #! 开头 = 用户写的是完整脚本（任意语言）：落地为可执行文件，交给内核按 shebang 执行
	if (/^#!/.test(command)) {
		const userScript = path.join(home, "run.user");
		fs.writeFileSync(userScript, `${command}\n`);
		fs.chmodSync(userScript, 0o755);
		fs.writeFileSync(script, `#!/bin/sh\n${trapExit}\n${JSON.stringify(userScript)}\n`);
	} else {
		fs.writeFileSync(script, `#!/bin/sh\n${trapExit}\n${command}\n`);
	}

	const fd = fs.openSync(out, "a");
	const child = spawn(process.env.EASY_BG_SHELL || "/bin/bash", [script], {
		cwd: sc.cwd,
		detached: true,
		stdio: ["ignore", fd, fd],
		env: {
			...process.env,
			EASY_BG_ID: id,
			EASY_BG_LOG: out,
			EASY_BG_TASK_DIR: home,
			PI_SESSION_ID: sid,
			PI_SESSION_FILE: sc.sessionFile ?? "",
			PI_MODEL: sc.modelId ?? "",
			PI_REASONING_LEVEL: sc.thinkingLevel ?? "",
		},
	});
	child.unref();
	fs.closeSync(fd);
	if (!child.pid) throw new Error("spawn failed");

	const task: Task = {
		id,
		name: spec.name?.trim() || undefined,
		command,
		cwd: sc.cwd,
		pid: child.pid,
		session: sid,
		startedAt: Date.now(),
		status: "running",
		timeoutSec: spec.timeoutSec ?? DEFAULT_TIMEOUT_SEC,
		maxBytes: spec.maxBytes ?? DEFAULT_MAX_BYTES,
		watch: spec.watch,
		notify: spec.notify !== false,
		notifyMode: spec.notifyMode,
		claimedBy: sid,
		claimedAt: Date.now(),
	};
	withTasks((all) => all.push(task));
	return task;
}

// 前缀歧义保护：id 变短后，bg-3f 可能命中多个任务。
export function ambiguousIn(all: Task[], ref: string): Task[] {
	const q = (ref ?? "").trim();
	if (!q) return [];
	return all.filter((t) => t.id.startsWith(q) || (t.name ?? "").startsWith(q));
}

// 按 id / 唯一前缀 / name 查找；空引用返回本会话最近一个任务
export function findTask(all: Task[], ref: string, sid: string): Task | undefined {
	const q = ref.trim();
	if (!q) return [...all].reverse().find((t) => t.session === sid);
	return all.find((t) => t.id === q) ?? all.find((t) => t.id.startsWith(q)) ?? [...all].reverse().find((t) => t.name === q);
}

export function summaryLine(t: Task): string {
	const bits = [
		STATUS_LABEL[t.status].padEnd(10),
		elapsed(t).padStart(6),
		(t.status === "done" || t.status === "failed") && t.exitCode !== undefined ? `exit=${t.exitCode}` : "        ",
	];
	const label = t.name ? `${t.name}: ${t.command}` : t.command;
	return `${t.id}  ${bits.join("  ")}  ${label.replace(/\s*\n\s*/g, " \u23ce ").replace(/\t/g, " ").slice(0, 120)}`;
}

export function wakeText(t: Task): string {
	const head = `[easy-bg] ${t.id}${t.name ? ` "${t.name}"` : ""} ${STATUS_LABEL[t.status]} ${t.exitCode !== undefined ? `exit=${t.exitCode}` : ""} in ${elapsed(t)}`;
	const tail = tailText(t, NOTIFY_TAIL_LINES);
	const cappedNote = logSize(t) > NOTIFY_TAIL_LINES * 4000 ? `\n(log is ${Math.round(logSize(t) / 1024)}KB total — run /easy-bg log ${t.id} for more)` : "";
	return `${head}\n${tail ? `${tail}\n` : ""}${cappedNote}`.trim();
}

export function commandHint(id: string): string {
	return `/easy-bg log ${id}`;
}

