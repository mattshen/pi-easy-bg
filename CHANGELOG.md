# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] - 2026-10-18

### Fixed

- **`/easy-bg clear` failed with `fs is not defined`.** The 1.0.1 split moved the two
  module blocks apart, and the extension kept using `fs.rmSync()` / `fs.appendFileSync()`
  while the `node:fs` import was dropped from its header. The command aborted halfway
  through the cleanup loop, so tasks were reported as "kept" instead of being removed.

### Added

- `scripts/check-imports.mjs` (`npm run check`, also part of `npm run verify`): reports
  core exports used by the extension but not imported, and node builtins used but not
  imported. esbuild does not flag undefined identifiers, and a throw inside an event
  handler can silently disable the whole extension, so this check runs before release.
  Verified in both directions: removing one import makes it fail with a precise message.

## [1.0.1] - 2026-10-18

### Added

- Unit tests (`test/core.test.ts`, 34 tests, `node --test`, no dependencies).
- `src/core.ts`: all plain logic split out of the extension. It imports nothing from pi,
  which is what makes the tests possible. `extensions/easy-bg.ts` is now only the pi
  integration.
- `truncateTail()`: the log is cut back to the cap after a kill, keeping the tail.

### Fixed

- **Output cap was checked only once per 1.5s tick.** A bare `yes` wrote **20.7 GB** into
  the log before the task was killed (enough to exhaust tmpfs and trigger the OOM killer).
  The cap is now enforced by a dedicated 100 ms loop, and the log is truncated
  immediately. Measured peak for the same test: 19.8 GiB -> 79.2 MiB, final size = cap.
- **`--watch` with invalid or duplicate flags threw.** `compileWatch()` forced `gi` back
  into the flag string, so `g` made `.test()` stateful (alternating match/miss across
  ticks) and an unknown letter such as `z` raised `Invalid flags`. Flags are now filtered
  to the non-stateful set, deduplicated, and a malformed body falls back to a literal
  match instead of throwing inside the observation loop.
- **Missing `dir` import broke `session_start`.** After the split, `session_start` threw
  `dir is not defined` on its first statement, so the tick and cap timers were never
  registered: tasks stayed `RUNNING` forever and the cap never fired. Added a static
  check for core exports used but not imported.
- Timers are now cleared on `session_shutdown` instead of leaking across reloads.

## [1.0.0] - 2026-10-18

First public release. Feature-complete against the reference specification
([mattshen/my-docs#62](https://github.com/mattshen/my-docs/issues/62)).

### Added

- Background execution: `/easy-bg <command>` and the `easy_bg` model tool
  (`run` / `status` / `logs` / `stop` / `clear`).
- Fan-out in one call: `command: string[]` starts one task per entry.
- Delivery modes `auto` / `now` / `park` / `manual` (`--notify`, `EASY_BG_NOTIFY`).
- Display-only result cards (`appendEntry` + `registerEntryRenderer`) that never
  enter the model context or attach to the user's next turn.
- Quiet-window auto delivery: results are handed over only after the user has been
  idle and quiet for `EASY_BG_QUIET_MS` (default 8s), each in its own turn.
- `/easy-bg now [id]` — explicit delivery, queued as a separate turn when the agent
  is busy instead of being spliced into the current turn.
- Seven task states with termination reason taking precedence over exit code
  (`RUNNING`, `DONE`, `FAIL`, `KILLED`, `TIMEOUT`, `OUTPUT_CAP`, `EXITED`).
- Multi-line commands and any language: the command text is written verbatim;
  `#!` scripts are executed by the kernel via their shebang.
- Exit codes captured through an `EXIT` trap, so `set -e` and explicit
  `exit N` / `sys.exit(N)` are reported correctly.
- Process-group termination (`detached` + `kill(-pid)`) with graceful fallback.
- Persistent state with atomic writes, heartbeat lease and adoption of tasks
  left running by a previous session.
- Bounded output: per-task byte cap, ANSI-stripped tails, retention by age/count.
- Grouped cleanup: `clear` keeps running tasks, unhandled results and other
  sessions' records; `clear --all` overrides.
- Unique ids (`bg-<6hex>`) plus unique-prefix addressing with ambiguity reporting.
- Footer status line using the same status words as `ls`.
- `/easy-bg help`, shell-style autocomplete, and a startup banner with the version.
