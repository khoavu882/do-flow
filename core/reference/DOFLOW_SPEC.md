# DoFlow Spec-Driven Delivery Chain

A spec-kit-style, phase-gated delivery loop (`constitution → spec → plan → tasks → implement →
review`) on top of the rest of the `/do-*` skills and the 15 specialist agents. Discipline
borrowed from spec-kit; enforcement done with the harness's real hooks rather than a prompt-read
registry. The implement-gate hook is registered in `core/settings.json`.

## Layout

| Path | Holds |
|------|-------|
| `core/skills/` | Phase skills: `do-constitution`, `do-spec`, `do-plan`, `do-tasks`, `do-execute-plan`, `do-review` |
| `core/scripts/doflow/bash/` | Deterministic helpers — `do-paths.sh` (path/number resolver, `--json`), `do-prereqs.sh` (gate check) |
| `core/hooks/` | `pre-implement-gate.sh` — PreToolUse(Edit\|Write) backstop for the one hard gate |
| `core/templates/doflow/` | `spec / plan / tasks / constitution` markdown templates seeded into each feature dir |
| `core/reference/` | `CONSTITUTION_BASE.md` — tier-1 global constitution base |

## Core design rules

- **Deterministic / generative split:** all path math, feature numbering, and existence checks live in
  `scripts/bash/*.sh` (`--json` output); skill prompts only reason. No filesystem math in prompts.
- **Branch-coupled state:** the active feature is derived from the git branch (`feat/NNN-slug`), not a
  separate state file. Artifacts live in `<repo>/agent-docs/specs/NNN-slug/`.
- **One hard gate:** source edits are blocked when a feature is started but `plan.md`/`tasks.md` are
  missing. Every other gate is advisory/skippable (solo, low-ceremony).
- **Two-tier constitution:** `reference/CONSTITUTION_BASE.md` (global) overlaid by
  `<repo>/agent-docs/constitution.md` (per-repo); local wins.
