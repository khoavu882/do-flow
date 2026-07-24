# DoFlow Chain — Spec-Driven Delivery

A spec-kit-style, phase-gated delivery loop (`do-brainstorm → do-design → do-plan →
do-execute-plan → do-test → do-code-review`) on top of the rest of the `/do-*` skills and the 14
specialist agents. Discipline borrowed from spec-kit; enforcement done with the harness's real
hooks rather than a prompt-read registry. The implement-gate hook is registered in
`settings.json`. `do-constitution` sits outside the numbered chain — a standalone,
still-invocable skill that maintains the persistent rules every phase inherits, not a phase
itself.

## Layout

| Path | Holds |
|------|-------|
| `skills/` | Chain skills: `do-brainstorm` (also creates the feature branch/dir, writes `requirement.md`, optionally captures a PBI/ticket ID), `do-design` (writes `design.md`), `do-plan` (also writes the dependency-ordered task checklist inside `plan.md`, plus a Repo Branch Plan for multi-repo features), `do-execute-plan` (also supports `--contracts` to generate a per-dependency-service code frame — signatures + type shapes, inferred language — from the task list, and lazily creates/tracks each repo's branch as it's first touched; a non-local dependency with a `contract-doc:` field gets a frame generated from that doc instead of the default silent skip), `do-code-review`. `do-constitution` is standalone, not part of the numbered chain. |
| `scripts/doflow/bash/` | Deterministic helpers — `do-paths.sh` (path/number resolver, `--json`), `do-prereqs.sh` (gate check) |
| `hooks/`               | `pre-implement-gate.sh` — PreToolUse(Edit\|Write) backstop for the one hard gate |
| `templates/doflow/`    | `requirement-template.md` (optional `**Ticket:**` header field) / `design-template.md` / `plan-template.md` (its own "Tasks" subsection folds in what used to be a separate tasks template, supports optional `depends-on:` and `contract-doc:` fields per task, and a Repo Branch Plan table for multi-repo features) / `state-template.md` (Repo Branch Status table) / `constitution-template.md` / `contract-doc-template.md` (pinned structure for a `contract-doc:` target — a documented external dependency `--contracts` can generate a mechanical frame from) — seeded into each feature dir. A shared pool across skills, not per-skill `assets/` — see note below. |
| `references/`          | `CONSTITUTION_BASE.md` — tier-1 global constitution base |

> Paths above are relative to the installed root (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}` globally,
> or a project's own `.claude/` in project scope). Chain skills' resolver lookups check the global
> config dir first, then walk upward from `$PWD` for a project-scoped `.claude/` install.

## Core design rules

- **Deterministic / generative split:** all path math, feature numbering, and existence checks
  live in `scripts/bash/*.sh` (`--json` output); skill prompts only reason. No filesystem math in
  prompts.
- **Branch-coupled state (git repos) / directory-scan fallback (non-git roots):** in a git repo,
  the active feature is derived from the branch (`feat/NNN-slug`), not a separate state file.
  Outside a git repo (e.g. doflow installed at a multi-service container root, above the actual
  git sub-repos), `do-paths.sh` falls back to scanning `agent-docs/doflow/` directly — one
  candidate auto-selects, 2+ candidates surface via `candidate_slugs` for the calling skill to
  disambiguate using the platform-specific `RULE_04_QUESTIONS.md` mechanism. Artifacts live in
  `<repo>/agent-docs/doflow/NNN-slug/`
  either way.
- **One hard gate:** source edits are blocked when a feature is started but `requirement.md`,
  `design.md`, or `plan.md` is missing. Every other gate is advisory/skippable (solo,
  low-ceremony).
- **Two-tier constitution:** `references/CONSTITUTION_BASE.md` (global) overlaid by
  `<repo>/agent-docs/constitution.md` (per-repo); local wins. Resolved unconditionally by
  `do-paths.sh` regardless of whether `do-constitution` has ever been invoked.
- **`templates/doflow/` is a shared template pool, not the Agent Skills standard's
  `references/`/`assets/` pattern.** The standard nests bundled resources one level inside their
  owning skill (`skill-name/assets/*`); these templates sit outside any single skill's directory
  and are pulled in by four different skills (`do-brainstorm`, `do-design`, `do-plan`,
  `do-constitution`) via a hardcoded relative path in each one's own Behavioral Flow. Intentional
  — a shared pool avoids duplicating the same templates into four separate `skill/assets/`
  folders — but noted explicitly so it isn't mistaken for the standard's per-skill `references/`
  shape, which has a different purpose (on-demand knowledge a skill loads into its own reasoning,
  not scaffold files it copies out as new artifacts).
