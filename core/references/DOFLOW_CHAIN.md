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
| `skills/` | Chain skills: `do-brainstorm` (also creates the feature branch/dir and writes `requirement.md`), `do-design` (writes `design.md`), `do-plan` (also writes the dependency-ordered task checklist inside `plan.md`), `do-execute-plan` (also supports `--contracts` to scaffold cross-service contract stubs from the task list), `do-code-review`. `do-constitution` is standalone, not part of the numbered chain. |
| `scripts/doflow/bash/` | Deterministic helpers — `do-paths.sh` (path/number resolver, `--json`), `do-prereqs.sh` (gate check) |
| `hooks/`               | `pre-implement-gate.sh` — PreToolUse(Edit\|Write) backstop for the one hard gate |
| `templates/doflow/`    | `requirement-template.md` / `design-template.md` / `plan-template.md` (its own "Tasks" subsection folds in what used to be a separate tasks template, and supports an optional `depends-on:` field per task for external-service dependencies) / `state-template.md` / `constitution-template.md` — seeded into each feature dir. A shared pool across skills, not per-skill `assets/` — see note below. |
| `references/`          | `CONSTITUTION_BASE.md` — tier-1 global constitution base |

> Paths above are relative to the installed root (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}`, or a
> project's `.claude/` in project scope). In the `do-flow` source repo itself, every path here
> sits one level deeper, under `core/` (e.g. `core/skills/`) — stripped by `bin/mappings.conf` on
> install, same as every other file this chain's skills reference with a `core/...` dev-tree
> fallback in their own Behavioral Flow.

## Core design rules

- **Deterministic / generative split:** all path math, feature numbering, and existence checks
  live in `scripts/bash/*.sh` (`--json` output); skill prompts only reason. No filesystem math in
  prompts.
- **Branch-coupled state (git repos) / directory-scan fallback (non-git roots):** in a git repo,
  the active feature is derived from the branch (`feat/NNN-slug`), not a separate state file.
  Outside a git repo (e.g. doflow installed at a multi-service container root, above the actual
  git sub-repos), `do-paths.sh` falls back to scanning `agent-docs/doflow/` directly — one
  candidate auto-selects, 2+ candidates surface via `candidate_slugs` for the calling skill to
  disambiguate with `AskUserQuestion`. Artifacts live in `<repo>/agent-docs/doflow/NNN-slug/`
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
