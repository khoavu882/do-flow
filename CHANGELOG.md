# Changelog

All notable changes to DoFlow are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [2.1.0] - 2026-07-15

### Added

- `--contracts` flag on `/do-execute-plan`: scaffolds `agent-docs/doflow/<slug>/contracts/<service>/`
  (`code/`, `data/`, `mock/`, plus a `manifest.yaml`) for services a plan depends on but doesn't
  build itself, derived from `plan.md`'s task list — lets cross-service work proceed against an
  agreed contract instead of blocking on the dependency. Standalone and idempotent; does not
  change `--dry-run`'s existing no-op/preview semantics.
- `depends-on:` — new optional field on `plan.md` tasks (alongside `owner:`/`files:`), populated by
  `/do-plan` to mark a task's dependency on an external service with no owning task in the same
  plan. Read by `--contracts` to decide which services to scaffold.
- **C4 System Overview section** in `design-template.md` (Context + Container Mermaid diagrams),
  produced by `/do-design` as the visual complement to its existing Architecture Approach section.

### Fixed

- **Non-git root feature resolution:** `do-paths.sh` previously derived the active feature
  exclusively from the git branch, so a non-git root (e.g. doflow installed at a multi-service
  container root, above the actual git sub-repos) always reported `feature_slug: null` —
  a false "no active feature" gate failure regardless of whether `requirement.md`/`design.md`/
  `plan.md` genuinely existed. Now falls back to scanning `agent-docs/doflow/` directly: one
  candidate auto-selects; zero is genuinely no active feature; two or more surfaces via a new
  `candidate_slugs` field for the calling skill to disambiguate with `AskUserQuestion` (new
  `--slug=<slug>` override forces resolution after disambiguating). `do-brainstorm`, `do-design`,
  `do-plan`, `do-execute-plan`, and `do-flow` all updated to detect and resolve this case
  themselves, so a disambiguation made in one phase actually propagates to the next instead of
  silently creating a duplicate feature directory.
- `--contracts`'s idempotency no longer silently overwrites a contract scaffold when the source
  `plan.md` tasks have changed since it was generated — now warns instead of clobbering
  potentially manually-edited `code`/`data`/`mock` content.
- Candidate-slug scanning no longer misfires on a stray non-numeric directory under
  `agent-docs/doflow/` (a `notes/` folder, `.archive/`, a manual-cleanup leftover).
- Fully qualified previously-bare `contracts/<service>/...` path references to
  `agent-docs/doflow/<slug>/contracts/<service>/...` throughout `do-execute-plan`'s skill files.
- Installed docs (`DOFLOW_CHAIN.md`, `pm-agent.md`, two hook-script comments) no longer contain
  dev-tree-only `core/`-prefixed paths that read as broken once actually installed — confirmed
  live against a real installed copy, not just theoretically.

### Changed

- `do-execute-plan/SKILL.md`'s `--contracts` algorithm extracted to a co-located `contracts.md`,
  read only when `--contracts` is the active flag (progressive disclosure per Anthropic's Agent
  Skills best practices) — `SKILL.md` no longer pays that token cost on every other invocation
  (`--next`/`--phase`/`--all`/`--resume`/`--dry-run`). 105 → 87 lines.

## [2.0.0] - 2026-07-15

### Changed

- **Breaking (installed framework content):** consolidated the doflow spec-driven chain.
  `do-spec` merged into `do-brainstorm` (which now creates the feature branch/dir and writes
  `requirement.md` as part of its own Socratic-discovery flow); `do-tasks` merged into `do-plan`
  (writes the dependency-ordered task checklist as a rigid subsection inside `plan.md`, no
  separate `tasks.md`). `do-design` gained the same concrete resolver/file-write treatment,
  writing `design.md`. Artifact root renamed `agent-docs/specs/<slug>/` →
  `agent-docs/doflow/<slug>/`. The implement-phase hard gate now requires `requirement.md`,
  `design.md`, and `plan.md` (previously `plan.md`+`tasks.md` only — `design.md` is newly
  mandatory). `do-flow`'s auto-chain sequence and gate names updated to match; `do-constitution`
  no longer runs as an implicit phase-0 of `do-flow` — it stays a standalone, manually-invoked
  skill. In-flight `agent-docs/specs/<slug>/` feature directories from before this change are
  not auto-migrated.
- **Breaking:** retired `/do-load` and `/do-save`. Session-memory restoration
  (`last-compact-summary.md`, `uncommitted-warning.txt`) is now handled automatically by
  `user-prompt-submit.sh` — direct injection on the first prompt, no manual command needed.
  `pm-agent` reads/writes the underlying files directly.
- **Breaking (installed framework content):** replaced the `do-review` chain phase (code quality
  + `requirement.md`/`plan.md` traceability) with `do-code-review`, a portable, tool-agnostic
  code-quality skill covering 13 languages via dispatch rules, per-language rule files, and
  deterministic analyzer scripts (`pr_analyzer.py`, `code_quality_checker.py`,
  `review_report_generator.py`). `do-code-review` does not check requirement/task traceability —
  the doflow chain's Gate-B review step is now code-quality only. Every chain skill
  (`do-flow`, `do-brainstorm`, `do-execute-plan`, `do-pm`, `do-help`) and doc reference to
  `/do-review` was repointed to `/do-code-review`.
- **Breaking (installed framework content):** renamed `core/reference/` → `core/references/`;
  removed the standalone `JAVA_CODING_RULE.md`/`CODE_REVIEW_CHECKLIST.md` reference docs and the
  `code-conventions`/`java-conventions` skills (superseded by `do-code-review`'s per-language
  rule files). Removed the now-redundant `code-reviewer` agent (14 agents remain);
  `do-code-review` is self-contained and does not dispatch to it.

### Removed

- `do-spec`, `do-tasks`, `do-load`, `do-save`, `do-review`, `code-conventions`, `java-conventions`
  skills.
- `code-reviewer` agent.
- `core/reference/JAVA_CODING_RULE.md`, `core/reference/CODE_REVIEW_CHECKLIST.md`.

## [1.0.1] - 2026-07-13

### Fixed

- Retry `EAGAIN` on stdin reads left non-blocking by raw-mode prompts, instead of failing the
  prompt closed (`src/prompt.js`, `src/mcp.js`).

## [1.0.0] - 2026-07-09

### Added

- First public DoFlow release.
- Added the `doflow` CLI installer for Claude, Codex, and Gemini configuration targets.
- Added shared core rules, skills, agents, hooks, MCP configuration, and documentation.
- Added Node test coverage for install, update, rollback, diff, backup, MCP, and hook workflows.
