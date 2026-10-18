#!/usr/bin/env node
/**
 * Integration test: drives a real pi process over RPC and checks the extension end to end.
 *
 * Unit tests (test/core.test.ts) cover pure logic. They cannot catch problems in the
 * integration layer -- and two real bugs (`dir is not defined`, `fs is not defined`)
 * lived exactly there: an exception inside an event handler silently disabled the whole
 * extension while every unit test stayed green.
 *
 * This script therefore uses only slash commands (no model calls, so it is fast and
 * deterministic) and asserts on the persistent state plus the extension's own events:
 *
 *   done / failed / timeout / output_cap / killed / exited-by-`set -e` / shebang exit code
 *   park (auto keeps an unhandled result)  ·  manual (marks it handled)
 *   clear (keeps running tasks and unhandled results)  ·  clear --all
 *   no `extension_error` on any event
 *
 * Isolation: `pi -ne` disables extension discovery, so the installed copy of this package
 * is ignored and only this working copy is loaded via `-e`. EASY_BG_DIR points at a
 * temporary directory; the user's settings and state are untouched.
 *
 * Usage: npm run integration-test            (needs `pi` on PATH)
 *        node scripts/integration-test.mjs --verbose
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repo = path.resolve(import.meta.dirname, "..");
const verbose = process.argv.includes("--verbose");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-easy-bg-it-state-"));
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-easy-bg-it-cwd-"));
const MAX_BYTES = 600;

const log = (...a) => verbose && console.log("   ", ...a);

let pass = 0;
const failures = [];
function check(name, ok, detail) {
	if (ok) {
		pass++;
		console.log(`✔ ${name}`);
	} else {
		failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
		console.log(`✘ ${name}${detail ? ` — ${detail}` : ""}`);
	}
}

// ---------------------------------------------------------------------------
// pi process
// ---------------------------------------------------------------------------

const child = spawn("pi", ["-ne", "-e", repo, "--mode", "rpc", "--no-session"], {
	cwd: workDir,
	env: { ...process.env, EASY_BG_DIR: stateDir, EASY_BG_QUIET_MS: "999999", EASY_BG_MAX_BYTES: String(MAX_BYTES) },
	stdio: ["pipe", "pipe", "pipe"],
});

const events = [];
const errors = [];
let buffer = "";
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
	buffer += chunk;
	let i;
	while ((i = buffer.indexOf("\n")) >= 0) {
		const line = buffer.slice(0, i).trim();
		buffer = buffer.slice(i + 1);
		if (!line.startsWith("{")) continue;
		try {
			const e = JSON.parse(line);
			events.push(e);
			if (e.type === "extension_error") errors.push(`${e.event}: ${e.error}`);
		} catch {
			/* ignore non-JSON noise */
		}
	}
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => {
	const text = String(c).trim();
	if (text && !text.startsWith("[easy-bg]")) errors.push(text);
	log("stderr:", text);
});

const send = (message) => child.stdin.write(`${JSON.stringify({ type: "prompt", message })}\n`);

const tasks = () => {
	const file = path.join(stateDir, "tasks.json");
	if (!fs.existsSync(file)) return [];
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch {
		return [];
	}
};
const byName = (name) => tasks().find((t) => t.name === name);
const logSizeOf = (t) => {
	try {
		return fs.statSync(path.join(stateDir, t.id, "out.log")).size;
	} catch {
		return 0;
	}
};

async function waitFor(label, predicate, timeoutMs = 25_000) {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		const value = predicate();
		if (value) return value;
		await new Promise((r) => setTimeout(r, 150));
	}
	throw new Error(`timeout waiting for ${label}`);
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

try {
	await waitFor("extension banner", () => events.some((e) => JSON.stringify(e).includes("easy-bg v")), 20_000);
	check("extension loads", true);

	// MAX_RUNNING_TASKS is 8: stay at or below it, and start the long-running task only
	// after the short ones have settled.
	send("/easy-bg --name ok echo OK");
	send("/easy-bg --name fail bash -c 'exit 3'");
	send("/easy-bg --name tmo --timeout 1 sleep 10");
	send(`/easy-bg --name cap bash -c 'seq 1 300000'`);
	send("/easy-bg --name sete set -e\nfalse");
	send("/easy-bg --name sheb #!/usr/bin/env python3\nimport sys\nsys.exit(5)");
	send("/easy-bg --name manual --notify manual echo done-manual");
	send("/easy-bg --name parked echo unhandled-result");

	await waitFor("ok done", () => byName("ok")?.status === "done");
	check("exit 0 -> DONE", byName("ok")?.exitCode === 0);

	await waitFor("fail", () => byName("fail")?.status === "failed");
	check("exit 3 -> FAIL", byName("fail")?.exitCode === 3);

	await waitFor("timeout", () => byName("tmo")?.status === "timeout", 30_000);
	check("--timeout -> TIMEOUT (not DONE exit=0)", byName("tmo")?.status === "timeout");

	const cap = await waitFor("output cap", () => (byName("cap")?.status === "output_cap" ? byName("cap") : undefined));
	check("output cap -> OUTPUT_CAP", cap.status === "output_cap" && cap.capped === true);
	check("log truncated to the cap", logSizeOf(cap) <= MAX_BYTES, `${logSizeOf(cap)} bytes`);

	const sete = await waitFor("set -e", () => (byName("sete")?.status ? byName("sete") : undefined));
	check("set -e failure keeps its exit code", sete.status === "failed" && sete.exitCode === 1, `status=${sete.status} exit=${sete.exitCode}`);

	const sheb = await waitFor("shebang", () => (byName("sheb")?.status ? byName("sheb") : undefined));
	check("shebang script runs and reports exit code", sheb.status === "failed" && sheb.exitCode === 5, `status=${sheb.status} exit=${sheb.exitCode}`);
	check("shebang command stored as an executable run.user", fs.existsSync(path.join(stateDir, sheb.id, "run.user")));

	await waitFor("manual handled", () => byName("manual")?.handledAt);
	check("--notify manual marks the result handled without a card", Boolean(byName("manual")?.handledAt));

	const parked = await waitFor("parked", () => (byName("parked")?.parkedAt ? byName("parked") : undefined));
	check("auto parks the result without delivering it", Boolean(parked.parkedAt) && !parked.handledAt);
	check("park shows a display-only card", events.some((e) => e.type === "entry_appended" && e.entry?.customType === "easy-bg-result"));

	// start the long-running task only now, so the 8-task limit is never hit
	send("/easy-bg --name kill sleep 30");
	const killTask = await waitFor("kill running", () => (byName("kill")?.status === "running" ? byName("kill") : undefined));
	check("running task stays RUNNING", killTask?.status === "running");
	send(`/easy-bg stop ${killTask.id}`);
	const killed = await waitFor("killed", () => (byName("kill")?.status === "killed" ? byName("kill") : undefined));
	check("stop -> KILLED", killed.status === "killed");

	// `clear` is conservative by design: it keeps running tasks, unhandled results and
	// other sessions. In auto mode every finished task is an unhandled result, so the only
	// thing it may drop here is the `--notify manual` one (already handled).
	const unhandledBefore = tasks().filter((t) => t.parkedAt && !t.handledAt).map((t) => t.name).sort();
	send("/easy-bg --name keepalive sleep 30");
	await waitFor("keepalive", () => byName("keepalive")?.status === "running");

	const before = tasks().length;
	send("/easy-bg clear");
	await waitFor("clear", () => tasks().length < before);
	const afterClear = tasks();
	check("clear keeps the running task", afterClear.some((t) => t.name === "keepalive" && t.status === "running"));
	check("clear drops the handled task", !afterClear.some((t) => t.name === "manual"));
	check(
		"clear keeps every unhandled result",
		unhandledBefore.every((name) => afterClear.some((t) => t.name === name && !t.handledAt)),
		`kept ${afterClear.filter((t) => t.parkedAt && !t.handledAt).length}/${unhandledBefore.length}`,
	);

	send("/easy-bg clear --all");
	await waitFor("clear --all", () => tasks().length === 1, 10_000);
	const afterAll = tasks();
	check("clear --all drops finished tasks, handled or not", afterAll.length === 1, JSON.stringify(afterAll.map((t) => t.name)));
	check("clear --all keeps the running task", afterAll[0].name === "keepalive" && afterAll[0].status === "running");

	check("no extension_error during the whole run", errors.length === 0, errors.slice(0, 3).join(" | "));
} catch (error) {
	failures.push(`harness: ${error?.message ?? error}`);
	console.log(`\n✘ ${error?.message ?? error}`);
	if (verbose) console.log(errors.join("\n"));
} finally {
	// stop anything still running, then remove the temporary state
	try {
		for (const t of tasks()) if (t.status === "running") send(`/easy-bg stop ${t.id}`);
		await new Promise((r) => setTimeout(r, 1200));
	} catch {
		/* ignore */
	}
	try {
		child.stdin.end();
		child.kill("SIGTERM");
	} catch {
		/* ignore */
	}
	await new Promise((r) => setTimeout(r, 400));
	fs.rmSync(stateDir, { recursive: true, force: true });
	fs.rmSync(workDir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) {
	console.log("\nFailures:");
	for (const f of failures) console.log(`  - ${f}`);
	process.exit(1);
}
