import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";

import {
	ANSI,
	DEFAULT_NOTIFY,
	MAX_HANDLE_TASKS,
	NOTIFY_MODES,
	STATUS_LABEL,
	acknowledgeTasks,
	ambiguousIn,
	compileWatch,
	elapsed,
	findTask,
	footerTasks,
	isTerminal,
	killTask,
	nextId,
	readExitCode,
	resolveTerminal,
	selectHandleTasks,
	truncateTail,
	startTask,
	summaryLine,
	tailText,
	taskDir,
	writeTasks,
} from "../src/core.ts";
import type { Task, TaskStatus } from "../src/core.ts";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

let stateDir: string;

beforeEach(() => {
	stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-easy-bg-test-"));
	process.env.EASY_BG_DIR = stateDir;
});

afterEach(() => {
	// startTask's detached wrapper may write its exit marker during cleanup.
	fs.rmSync(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 30 });
});

function makeTask(over: Partial<Task> = {}): Task {
	const t: Task = {
		id: "bg-abcdef",
		command: "echo hi",
		cwd: "/tmp",
		pid: process.pid,
		session: "session-1",
		startedAt: Date.now() - 5_000,
		status: "running",
		timeoutSec: 60,
		maxBytes: 1024 * 1024,
		notify: true,
		...over,
	};
	return t;
}

function writeLog(id: string, content: string): void {
	const dir = taskDir(id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "out.log"), content);
}

function writeExit(id: string, code: number): void {
	const dir = taskDir(id);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(dir, "exit"), `${code}\n`);
}

// ---------------------------------------------------------------------------
// status model
// ---------------------------------------------------------------------------

describe("status model", () => {
	test("park is the default and auto is not a supported mode", () => {
		assert.equal(DEFAULT_NOTIFY, "park");
		assert.deepEqual(NOTIFY_MODES, ["now", "park", "manual"]);
	});

	test("isTerminal is false only for running", () => {
		const terminal: TaskStatus[] = ["done", "failed", "killed", "timeout", "output_cap", "exited"];
		assert.equal(isTerminal("running"), false);
		for (const s of terminal) assert.equal(isTerminal(s), true, s);
	});

	test("every status has a label", () => {
		const statuses: TaskStatus[] = ["running", "done", "failed", "killed", "timeout", "output_cap", "exited"];
		assert.deepEqual(Object.keys(STATUS_LABEL).sort(), [...statuses].sort());
		assert.equal(STATUS_LABEL.running, "RUNNING");
		assert.equal(STATUS_LABEL.output_cap, "OUTPUT_CAP");
	});
});

// ---------------------------------------------------------------------------
// watch patterns
// ---------------------------------------------------------------------------

describe("compileWatch", () => {
	test("plain text is a literal substring, not a regex", () => {
		const re = compileWatch("a.b(c");
		assert.ok(re.test("xx a.b(c yy"));
		assert.equal(re.test("aXb(c"), false);
	});

	test("slash form is a regex", () => {
		const re = compileWatch("/err(or)?/i");
		assert.ok(re.test("ERROR: boom"));
		assert.equal(re.test("nothing"), false);
	});

	test("stateful flags are dropped so repeated tests stay stable", () => {
		const re = compileWatch("/boom/g");
		assert.equal(re.flags.includes("g"), false);
		assert.equal(re.test("boom"), true);
		assert.equal(re.test("boom"), true);
	});

	test("duplicate or invalid flags do not throw", () => {
		assert.doesNotThrow(() => compileWatch("/boom/ii"));
		assert.doesNotThrow(() => compileWatch("/boom/zz"));
	});
});

// ---------------------------------------------------------------------------
// ids
// ---------------------------------------------------------------------------

describe("nextId", () => {
	test("has the documented shape", () => {
		assert.match(nextId([]), /^bg-[0-9a-f]{6}$/);
	});

	test("never collides with an existing id", () => {
		const used: Task[] = Array.from({ length: 40 }, (_, i) => makeTask({ id: `bg-${i.toString(16).padStart(6, "0")}` }));
		const taken = new Set(used.map((t) => t.id));
		for (let i = 0; i < 50; i++) assert.equal(taken.has(nextId(used)), false);
	});
});

// ---------------------------------------------------------------------------
// log tails
// ---------------------------------------------------------------------------

describe("tailText", () => {
	test("returns the last N lines", () => {
		const t = makeTask({ id: "bg-tail01" });
		writeLog(t.id, ["l1", "l2", "l3", "l4", "l5"].join("\n"));
		assert.equal(tailText(t, 2), "l4\nl5");
		assert.equal(tailText(t, 99), "l1\nl2\nl3\nl4\nl5");
	});

	test("strips ANSI escapes", () => {
		const t = makeTask({ id: "bg-tail02" });
		writeLog(t.id, "\u001b[31mred\u001b[0m text");
		const out = tailText(t, 5);
		assert.equal(out, "red text");
		assert.equal(ANSI.test("\u001b[31mx\u001b[0m"), true);
	});

	test("missing log is empty, not a throw", () => {
		assert.equal(tailText(makeTask({ id: "bg-nolog" }), 5), "");
	});
});

describe("truncateTail", () => {
	test("keeps the last N bytes (errors live at the end)", () => {
		const t = makeTask({ id: "bg-crop01" });
		writeLog(t.id, "A".repeat(500) + "ERROR_AT_END");
		truncateTail(t, 50);
		const out = fs.readFileSync(path.join(taskDir(t.id), "out.log"), "utf8");
		assert.equal(Buffer.byteLength(out), 50);
		assert.ok(out.endsWith("ERROR_AT_END"));
	});

	test("does nothing when the log is already small", () => {
		const t = makeTask({ id: "bg-crop02" });
		writeLog(t.id, "tiny");
		truncateTail(t, 1000);
		assert.equal(fs.readFileSync(path.join(taskDir(t.id), "out.log"), "utf8"), "tiny");
	});

	test("missing log is a no-op", () => {
		assert.doesNotThrow(() => truncateTail(makeTask({ id: "bg-nolog2" }), 10));
	});
});

// ---------------------------------------------------------------------------
// terminal resolution: termination reason wins over exit code
// ---------------------------------------------------------------------------

describe("resolveTerminal", () => {
	const cases: Array<{ name: string; exit?: number; reason?: Task["killReason"]; status: TaskStatus; code?: number }> = [
		{ name: "exit 0 -> done", exit: 0, status: "done", code: 0 },
		{ name: "exit 3 -> failed", exit: 3, status: "failed", code: 3 },
		{ name: "SIGTERM trap writes 0, timeout wins", exit: 0, reason: "timeout", status: "timeout", code: 0 },
		{ name: "SIGTERM trap writes 0, user stop wins", exit: 0, reason: "user", status: "killed", code: 0 },
		{ name: "SIGTERM trap writes 0, cap wins", exit: 0, reason: "output_cap", status: "output_cap", code: 0 },
		{ name: "timeout without exit file", reason: "timeout", status: "timeout" },
		{ name: "no exit file, no reason -> exited", status: "exited" },
	];

	for (const c of cases) {
		test(c.name, () => {
			const t = makeTask({ id: `bg-${Math.random().toString(16).slice(2, 8)}` });
			if (c.exit !== undefined) writeExit(t.id, c.exit);
			if (c.reason) t.killReason = c.reason;
			resolveTerminal(t);
			assert.equal(t.status, c.status);
			if (c.code !== undefined) assert.equal(t.exitCode, c.code);
			assert.equal(typeof t.endedAt, "number");
		});
	}
});

describe("readExitCode", () => {
	test("reads a number and tolerates junk", () => {
		const t = makeTask({ id: "bg-exit01" });
		writeExit(t.id, 42);
		assert.equal(readExitCode(t), 42);

		const bad = makeTask({ id: "bg-exit02" });
		fs.mkdirSync(taskDir(bad.id), { recursive: true });
		fs.writeFileSync(path.join(taskDir(bad.id), "exit"), "nope");
		assert.equal(readExitCode(bad), undefined);
	});
});

// ---------------------------------------------------------------------------
// formatting
// ---------------------------------------------------------------------------

describe("summaryLine", () => {
	test("flattens multi-line commands", () => {
		const line = summaryLine(makeTask({ command: "set -eu\nmake clean\nmake -j8" }));
		assert.equal(line.includes("\n"), false);
		assert.ok(line.includes("⏎"));
	});

	test("shows exit code only for done/failed", () => {
		assert.ok(summaryLine(makeTask({ status: "done", exitCode: 0 })).includes("exit=0"));
		assert.ok(summaryLine(makeTask({ status: "failed", exitCode: 3 })).includes("exit=3"));
		assert.equal(summaryLine(makeTask({ status: "timeout", exitCode: 0 })).includes("exit="), false);
		assert.equal(summaryLine(makeTask({ status: "killed", exitCode: 0 })).includes("exit="), false);
	});

	test("truncates long commands", () => {
		const line = summaryLine(makeTask({ command: "x".repeat(400) }));
		assert.ok(line.length < 200);
	});
});

describe("elapsed", () => {
	test("formats seconds from start to end", () => {
		const t = makeTask({ startedAt: 1_000, endedAt: 13_000 });
		assert.equal(elapsed(t), "12s");
	});
});

// ---------------------------------------------------------------------------
// id addressing
// ---------------------------------------------------------------------------

describe("ambiguousIn / findTask", () => {
	const tasks: Task[] = [
		makeTask({ id: "bg-aaaaaa", name: "build", session: "s1" }),
		makeTask({ id: "bg-aaaabbb", name: "test", session: "s1" }),
		makeTask({ id: "bg-cccccc", name: "deploy", session: "s2" }),
	];

	test("prefix collisions are reported, not guessed", () => {
		assert.equal(ambiguousIn(tasks, "bg-aaaa").length, 2);
		assert.equal(ambiguousIn(tasks, "bg-cc").length, 1);
		assert.equal(ambiguousIn(tasks, "nothing").length, 0);
	});

	test("empty reference matches nothing", () => {
		assert.deepEqual(ambiguousIn(tasks, ""), []);
	});

	test("findTask resolves exact id, prefix and name", () => {
		assert.equal(findTask(tasks, "bg-cccccc", "s1")?.name, "deploy");
		assert.equal(findTask(tasks, "bg-cccc", "s1")?.name, "deploy");
		assert.equal(findTask(tasks, "deploy", "s1")?.name, "deploy");
	});

	test("empty reference prefers the caller's own session", () => {
		assert.equal(findTask(tasks, "", "s2")?.session, "s2");
		assert.equal(findTask(tasks, "", "s1")?.session, "s1");
	});
});

// ---------------------------------------------------------------------------
// batch handling and footer lifecycle
// ---------------------------------------------------------------------------

describe("selectHandleTasks", () => {
	const tasks = [
		makeTask({ id: "bg-aaaaaa", status: "done", session: "s1", endedAt: 100, parkedAt: 101 }),
		makeTask({ id: "bg-aaaabb", status: "failed", session: "s1", endedAt: 200, parkedAt: 201 }),
		makeTask({ id: "bg-cccccc", status: "running", session: "s1" }),
		makeTask({ id: "bg-dddddd", status: "done", session: "s2", endedAt: 300 }),
		makeTask({ id: "bg-eeeeee", status: "done", session: "s1", endedAt: 400, parkedAt: 401, handledAt: 450 }),
	];

	test("default returns only pending parked tasks in this session without mutating them", () => {
		const original = structuredClone(tasks);
		const selected = selectHandleTasks(tasks, "s1");
		assert.deepEqual(selected.tasks.map((t) => t.id), ["bg-aaaaaa", "bg-aaaabb"]);
		assert.equal(selected.omitted, 0);
		assert.deepEqual(tasks, original);
		assert.equal(selected.tasks[0].handledAt, undefined);
	});

	test("explicit ids include running or cross-session tasks, deduplicated", () => {
		const selected = selectHandleTasks(tasks, "s1", ["bg-cccc", "bg-ddd", "bg-cccc"]);
		assert.deepEqual(selected.tasks.map((t) => t.id), ["bg-cccccc", "bg-dddddd"]);
	});

	test("ambiguous, unknown and empty ids fail rather than returning other results", () => {
		assert.match(selectHandleTasks(tasks, "s1", ["bg-aaaa"]).error ?? "", /ambiguous/);
		assert.match(selectHandleTasks(tasks, "s1", ["bg-missing"]).error ?? "", /no such task/);
		assert.match(selectHandleTasks(tasks, "s1", [" "]).error ?? "", /non-empty/);
	});

	test("default caps pending results oldest first; explicit requests have a limit", () => {
		const many = Array.from({ length: MAX_HANDLE_TASKS + 2 }, (_, i) =>
			makeTask({ id: `bg-${String(i).padStart(6, "0")}`, status: "done", endedAt: i + 1, parkedAt: i + 2, session: "s1" }));
		const selected = selectHandleTasks(many, "s1");
		assert.equal(selected.tasks.length, MAX_HANDLE_TASKS);
		assert.equal(selected.tasks[0].id, "bg-000000");
		assert.equal(selected.omitted, 2);
		assert.match(selectHandleTasks(many, "s1", many.map((t) => t.id)).error ?? "", /at most/);
	});

	test("acknowledgment removes completed tasks from footer but keeps them in ls data", () => {
		const now = 500;
		assert.deepEqual(footerTasks(tasks, now).parked.map((t) => t.id), ["bg-aaaaaa", "bg-aaaabb"]);
		acknowledgeTasks(tasks, new Set(["bg-aaaaaa", "bg-cccccc"]), now);
		assert.equal(tasks[0].handledAt, now);
		assert.equal(tasks[2].handledAt, undefined); // running task still awaits its final result
		assert.deepEqual(footerTasks(tasks, now).parked.map((t) => t.id), ["bg-aaaabb"]);
		assert.deepEqual(footerTasks(tasks, now).fresh.map((t) => t.id), ["bg-aaaabb", "bg-dddddd"]);
		assert.equal(tasks[0].status, "done"); // ls can still show it
		assert.deepEqual(selectHandleTasks(tasks, "s1").tasks.map((t) => t.id), ["bg-aaaabb"]);
	});
});

// ---------------------------------------------------------------------------
// task creation
// ---------------------------------------------------------------------------

describe("startTask", () => {
	const ctx = () => ({ cwd: "/tmp", sessionId: "s1", sessionFile: "/tmp/s.jsonl", modelId: "m", thinkingLevel: "off" });

	test("wrapper uses an EXIT trap so set -e and exit N keep their code", () => {
		const t = startTask(ctx(), { command: "set -e\nfalse" }, "s1");
		const wrapper = fs.readFileSync(path.join(taskDir(t.id), "cmd.sh"), "utf8");
		assert.ok(wrapper.includes("trap '"));
		assert.ok(wrapper.includes("EXIT"));
		assert.ok(wrapper.includes("set -e"));
		assert.equal(fs.existsSync(path.join(taskDir(t.id), "run.user")), false);
	});

	test("shebang commands become an executable run.user", () => {
		const t = startTask(ctx(), { command: "#!/usr/bin/env python3\nprint(1)" }, "s1");
		const user = path.join(taskDir(t.id), "run.user");
		assert.equal(fs.existsSync(user), true);
		assert.equal(fs.readFileSync(user, "utf8").startsWith("#!/usr/bin/env python3"), true);
		assert.ok((fs.statSync(user).mode & 0o111) !== 0, "run.user must be executable");
		const wrapper = fs.readFileSync(path.join(taskDir(t.id), "cmd.sh"), "utf8");
		assert.ok(wrapper.includes("run.user"));
	});

	test("rejects empty commands", () => {
		assert.throws(() => startTask(ctx(), { command: "   " }, "s1"), /empty command/);
	});

	test("records the task in tasks.json", () => {
		writeTasks([]);
		const t = startTask(ctx(), { command: "true", name: "smoke" }, "s1");
		const saved = JSON.parse(fs.readFileSync(path.join(stateDir, "tasks.json"), "utf8")) as Task[];
		const found = saved.find((x) => x.id === t.id);
		assert.ok(found);
		assert.equal(found?.name, "smoke");
		assert.equal(found?.session, "s1");
	});

	afterEach(() => {
		// never leave detached processes behind
		const f = path.join(stateDir, "tasks.json");
		if (!fs.existsSync(f)) return;
		for (const t of JSON.parse(fs.readFileSync(f, "utf8")) as Task[]) {
			if (t.status === "running") killTask(t, "user");
		}
	});
});
