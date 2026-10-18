# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
