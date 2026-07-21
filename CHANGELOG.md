# Changelog

All notable changes to DoFlow are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [Unreleased]

### Added

- **`--contracts` now generates a `default/` artifact per dependency**, alongside the existing
  `code/`/`data/`/`mock/` frames: a compilable default implementation of the dependency's
  interface, so a reviewer (or the consuming task's own in-scope code) has something to read and
  compile against immediately, not just a shape to hand-implement first. Every method resolves to
  one pinned, language-family-specific "not implemented" signal (a new Default-Implementation
  Grammar table in `contracts.md` — e.g. Java/Kotlin throw `UnsupportedOperationException`, C#
  throws `NotImplementedException`, Python raises `NotImplementedError`, Go returns a zero value +
  error) — never real business logic, never a guessed behavior. Generated for both local-inference and documented
  (`contract-doc:`) dependencies alike; skipped entirely for the `inferred_language: unresolved`
  (generic-pseudocode) case, which has no execution semantics to carry a "not implemented" signal.
  This is the new default `--contracts` behavior, no flag required — `generation_hash` now also
  covers `default/`'s generated content, so a contract frame generated before this change is
  correctly flagged stale (not silently treated as current) the next time `--contracts` runs.

## [2.3.0] - 2026-07-17

### Added

- **`do-document --type feature`**: generates feature-level documentation (C4 context/container
  diagrams, sequence diagrams, a data model section, an API spec section) backed by new reference
  templates (`api-reference.md`, `feature-flow.md`, `user-guide.md`), alongside expanded usage
  examples and tool-coordination notes in `do-document/SKILL.md`.
- **`contract-doc:` field for `/do-plan` tasks**: an optional field, set alongside `depends-on:`,
  for a dependency with no local repo (a vendor API, a SaaS integration) that nonetheless has a
  documented contract. Points to a doc built from the new `templates/doflow/contract-doc-template.md`
  (pinned `## Methods`/`## Types`/optional `## Webhook` structure, reusing `--contracts`'s own
  generic-pseudocode grammar). When set, `/do-execute-plan --contracts` mechanically generates a
  real frame from that doc — `code/`/`data/`/`mock/`, rendered in the *consuming* task's own
  inferred language — instead of silently skipping the dependency, its default behavior when
  `contract-doc:` is absent. A non-compliant doc target surfaces an explicit warning rather than a
  silent skip or a guessed frame; multiple tasks referencing the same non-local dependency must
  agree on `contract-doc:` (same target, or none) or the same warning applies.

### Changed

- `--contracts` service-boundary detection is now generic: instead of matching a `files:`/
  `depends-on:` path against a fixed three-name root list (`sources/`, `sources-rf/`, `clients/`),
  it walks up to the nearest ancestor that is a distinct git repo or contains a known build/
  package manifest — the same signal step 4's language inference already uses — falling back to
  the path's own containing directory (never the consuming repo's own root) when no such ancestor
  exists. This means `--contracts` now works in any consuming repo's layout, not only one shaped
  like a specific multi-service container workspace. `integration_style` (`network`/`in-process`)
  is derived the same way — from how the boundary was found, not a named-root/known-monolith list.
  When a dependency's language can't be inferred, the generated frame is now structurally-valid
  generic pseudocode (`code/interface.pseudo`, `data/types.pseudo`, `mock/interface.pseudo` —
  fixed grammar, explicit banner comment) instead of a prose placeholder. Both are deliberate
  extensions of `--contracts`'s existing behavior, not bug fixes; the resolved-language success
  path (real native-language declarations) is unchanged.

## [2.2.0] - 2026-07-16

### Added

- **Cross-service branch management** for `/do-plan`/`/do-execute-plan`: when a feature spans
  multiple independent git repos, `do-plan` now derives a per-repo branch name (an optional
  PBI/ticket ID + the feature slug, e.g. `feat/EDP-147-some-feature`) and writes a Repo Branch Plan
  into `plan.md`, resolving each repo via a nearest-`.git` walk-up from task `files:`/`depends-on:`
  metadata rather than a hardcoded folder-name list. `do-execute-plan` lazily creates or checks out
  each repo's branch right before its first task, always checking for a dirty working tree before
  branch existence so it never silently continues over uncommitted work — and re-checks any repo
  left `blocked` rather than trusting a stale status. Status is tracked in a Repo Branch Status
  table in `state.md`. `do-brainstorm` gains an optional `**Ticket:**` header field, captured only
  when the user references a PBI/epic during discovery.

### Changed

- `--contracts` flag on `/do-execute-plan` now generates an actual code frame per dependency
  service — method/interface signatures and native-language type/DTO shapes only, zero
  implementation logic — instead of an empty `code/`/`data/`/`mock/` scaffold. Language is
  inferred from the dependency service's own repo (build/package manifest first, file-extension
  frequency fallback, generic placeholder if inconclusive), never hardcoded. This is a deliberate
  change to an already-shipped flag's behavior, not a bug fix; `manifest.yaml`'s `generation_hash`
  now also covers the inferred language and which signal produced it, so a change in the
  dependency service's own language/build setup between runs is still correctly detected as stale.

## [2.1.1] - 2026-07-15

### Fixed

- **Project-scoped resolver lookups:** the `RESOLVER`/`SYNC`/`PREREQ` bash snippets in
  `do-brainstorm`, `do-design`, `do-plan`, `do-execute-plan` (both its resolver and prereq-gate
  lookups), and `do-constitution` only checked the global config dir and the do-flow dev tree —
  neither matches a project-scoped install (a target project's own `.claude/`, e.g. doflow
  installed at a multi-service container workspace root). `/do-execute-plan --contracts` (and
  every other chain skill) failed to find `do-paths.sh` outright in this scope, reproduced against
  a real workspace. Now walks upward from `$PWD` looking for `.claude/scripts/doflow/bash/<script>`.
  `pre-implement-gate.sh` gets the equivalent fix via `${CLAUDE_PROJECT_DIR}` — the env var hook
  subprocesses actually receive (skills' own Bash calls do not, verified against official docs) —
  where it previously had no project-scoped fallback at all and silently fail-opened.
- **MCP config merge:** `mergeKnownServers` (backing both the global `~/.claude.json` and
  project-scoped `<dir>/.mcp.json` writers) reset a hand-edited known-server definition — a
  customized arg, an extra env var — back to its shipped `core/.mcp.json` default every time that
  server was reselected on install/update. Now only writes the shipped default the first time a
  name is newly selected; an already-present definition is left untouched.

### Changed

- Removed the dev-tree fallback branch (`core/scripts/doflow/bash/...`) from every resolver-lookup
  snippet above — it only ever matched inside the do-flow source repo itself, so it was dead
  code/token cost on every real install now that the project-scoped walk-up covers the do-flow
  repo's own dogfooded use equally well. Swept `core/` for the same core/-prefixed-path leak class
  already fixed once in 2.1.0 and found four more instances (`RULE_02_WORKFLOW.md`,
  `hooks/lib.sh`, `hooks/skill-config-audit.sh`, `scripts/doflow/bash/do-paths.sh`) plus the
  `DOFLOW_CHAIN.md` note describing the now-removed dev-tree special case.

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
