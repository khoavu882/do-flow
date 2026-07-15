# DoFlow Chain — Spec-Driven Delivery

A spec-kit-style, phase-gated delivery loop (`do-brainstorm → do-design → do-plan →
do-execute-plan → do-test → do-code-review`) on top of the rest of the `/do-*` skills and the 14
specialist agents. Discipline borrowed from spec-kit; enforcement done with the harness's real
hooks rather than a prompt-read registry. The implement-gate hook is registered in
`core/settings.json`. `do-constitution` sits outside the numbered chain — a standalone,
still-invocable skill that maintains the persistent rules every phase inherits, not a phase
itself.

## Layout

| Path | Holds |
|------|-------|
| `core/skills/` | Chain skills: `do-brainstorm` (also creates the feature branch/dir and writes `requirement.md`), `do-design` (writes `design.md`), `do-plan` (also writes the dependency-ordered task checklist inside `plan.md`), `do-execute-plan`, `do-code-review`. `do-constitution` is standalone, not part of the numbered chain. |
| `core/scripts/doflow/bash/` | Deterministic helpers — `do-paths.sh` (path/number resolver, `--json`), `do-prereqs.sh` (gate check) |
| `core/hooks/`               | `pre-implement-gate.sh` — PreToolUse(Edit\|Write) backstop for the one hard gate |
| `core/templates/doflow/`    | `requirement-template.md` / `design-template.md` / `plan-template.md` (its own "Tasks" subsection folds in what used to be a separate tasks template) / `state-template.md` / `constitution-template.md` — seeded into each feature dir. A shared pool across skills, not per-skill `assets/` — see note below. |
| `core/references/`          | `CONSTITUTION_BASE.md` — tier-1 global constitution base |

## Core design rules

- **Deterministic / generative split:** all path math, feature numbering, and existence checks
  live in `scripts/bash/*.sh` (`--json` output); skill prompts only reason. No filesystem math in
  prompts.
- **Branch-coupled state:** the active feature is derived from the git branch (`feat/NNN-slug`),
  not a separate state file. Artifacts live in `<repo>/agent-docs/doflow/NNN-slug/`.
- **One hard gate:** source edits are blocked when a feature is started but `requirement.md`,
  `design.md`, or `plan.md` is missing. Every other gate is advisory/skippable (solo,
  low-ceremony).
- **Two-tier constitution:** `references/CONSTITUTION_BASE.md` (global) overlaid by
  `<repo>/agent-docs/constitution.md` (per-repo); local wins. Resolved unconditionally by
  `do-paths.sh` regardless of whether `do-constitution` has ever been invoked.
- **`core/templates/doflow/` is a shared template pool, not the Agent Skills standard's
  `references/`/`assets/` pattern.** The standard nests bundled resources one level inside their
  owning skill (`skill-name/assets/*`); these templates sit outside any single skill's directory
  and are pulled in by four different skills (`do-brainstorm`, `do-design`, `do-plan`,
  `do-constitution`) via a hardcoded relative path in each one's own Behavioral Flow. Intentional
  — a shared pool avoids duplicating the same templates into four separate `skill/assets/`
  folders — but noted explicitly so it isn't mistaken for the standard's per-skill `references/`
  shape, which has a different purpose (on-demand knowledge a skill loads into its own reasoning,
  not scaffold files it copies out as new artifacts).
