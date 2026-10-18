#!/usr/bin/env node
/**
 * Static sanity check for the split between src/core.ts and extensions/easy-bg.ts.
 *
 * esbuild does not report undefined identifiers, so a missing import only shows up at
 * runtime -- and an error inside an event handler can silently disable the whole
 * extension (a missing `dir` import once stopped the observation timers). This script
 * catches two classes of mistakes before they reach a user:
 *
 *   1. core exports that the extension uses but does not import
 *   2. node builtins the extension uses but does not import
 *
 * No dependencies; run with `npm run check` or `node scripts/check-imports.mjs`.
 */
import * as fs from "node:fs";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const core = fs.readFileSync(path.join(root, "src/core.ts"), "utf8");
const ext = fs.readFileSync(path.join(root, "extensions/easy-bg.ts"), "utf8");

const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const exported = new Set(
	[...core.matchAll(/^export\s+(?:function|const|interface|type)\s+(\w+)/gm)].map((m) => m[1]),
);
const imported = new Set();
for (const m of ext.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}/g)) {
	for (const part of m[1].split(",")) {
		const name = part.trim().split(/\s+as\s+/).pop()?.trim();
		if (name) imported.add(name);
	}
}
const localDecls = new Set(
	[...ext.matchAll(/^\s*(?:const|let|function)\s+(\w+)/gm)].map((m) => m[1]),
);

const extCode = stripComments(ext);
const problems = [];

for (const name of exported) {
	if (imported.has(name) || localDecls.has(name)) continue;
	if (new RegExp(`\\b${name}\\b`).test(extCode)) problems.push(`core export used but not imported: ${name}`);
}

const builtins = { fs: "node:fs", path: "node:path", os: "node:os" };
for (const [name, spec] of Object.entries(builtins)) {
	const usesIt = new RegExp(`\\b${name}\\.`).test(extCode);
	const importsIt = new RegExp(`import\\s+\\*\\s+as\\s+${name}\\s+from\\s+"${spec}"`).test(ext);
	if (usesIt && !importsIt) problems.push(`node builtin used but not imported: ${name} (${spec})`);
}
for (const [name, spec] of [["spawn", "node:child_process"], ["randomBytes", "node:crypto"]]) {
	const usesIt = new RegExp(`\\b${name}\\(`).test(extCode);
	const importsIt = new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*"${spec}"`).test(ext);
	if (usesIt && !importsIt) problems.push(`node builtin used but not imported: ${name} (${spec})`);
}

if (problems.length) {
	console.error("check-imports: FAIL");
	for (const p of problems) console.error(`  - ${p}`);
	process.exit(1);
}
console.log(`check-imports: ok (${exported.size} core exports, ${imported.size} imported symbols)`);
