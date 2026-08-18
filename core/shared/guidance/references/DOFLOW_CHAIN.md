# DoFlow Chain — Spec-Driven Delivery

A spec-kit-style, phase-gated delivery loop (`do-brainstorm → do-design → do-plan →
do-execute-plan → do-test → do-code-review`) on top of the rest of the `/do-*` skills and the five
specialist agents (`core-implementer`, `quality-guardian`, `research-writer`, `spec-analyst`,
`system-architect`). Discipline borrowed from spec-kit; enforcement done with the harness's real
hooks rather than a prompt-read registry. The implement-gate hook is registered in
`settings.json`. `do-constitution` sits outside the numbered chain — a standalone,
still-invocable skill that maintains the persistent rules every phase inherits, not a phase
itself. `do-implement` sits outside the numbered chain too, for the opposite reason: it is the
no-artifacts-required escape hatch for implementing directly from a description or
`do-code-review` findings when there is no `plan.md` task checklist to orchestrate — `do-execute-plan`
remains the chain's own implementation phase.

## Layout

| Path | Holds |
|------|-------|
| `skills/` | Chain skills: `do-brainstorm` (also creates the feature branch/dir, writes `requirement.md`, optionally captures a PBI/ticket ID), `do-design` (writes `design.md`), `do-plan` (also writes the dependency-ordered task checklist inside `plan.md`, plus a Repo Branch Plan for multi-repo features), `do-execute-plan` (also supports `--scaffold` to emit a reviewable code scaffold under the feature dir — the source layout, signatures and test stubs the three artifacts imply, plus a per-dependency-service contract frame — and lazily creates/tracks each repo's branch as it's first touched; a non-local dependency with a `external-contract:` field gets a frame generated from that doc instead of the default silent skip), `do-test`, `do-code-review`. `do-constitution` is standalone, not part of the numbered chain. |
| `scripts/doflow/` | The runtime seam. Skills call `bin/doflow-run <verb>` and never name a helper: the dispatcher decides which `bash/*.sh` helper or Node command serves each verb. The dispatcher owns the verb namespace and is the only place it is written down — an inventory here is the drift this row used to produce. |
| `hooks/`               | `pre-implement-gate.sh` — PreToolUse(Edit\|Write) backstop for the one hard gate |
| `templates/doflow/`    | `requirement-template.md` (optional `**Ticket:**` header field) / `design-template.md` / `plan-template.md` (its own "Tasks" subsection folds in what used to be a separate tasks template, supports optional `depends-on:` and `external-contract:` fields per task, and a Repo Branch Plan table for multi-repo features) / `state-template.md` (Repo Branch Status table) / `constitution-template.md` / `external-contract-template.md` (pinned structure for a `external-contract:` target — a documented external dependency `--scaffold` can generate a mechanical frame from) — seeded into each feature dir. A shared pool across skills, not per-skill `assets/` — see note below. |
| `references/`          | `CONSTITUTION_BASE.md` — tier-1 global constitution base |

> Paths above are relative to the installed root (`${CLAUDE_CONFIG_DIR:-$HOME/.claude}` globally,
> or a project's own `.claude/` in project scope). Chain skills' resolver lookups check the global
> config dir first, then walk upward from `$PWD` for a project-scoped `.claude/` install.

## Core design rules

- **Deterministic / generative split, through one seam:** all path math, feature numbering,
  existence checks, grading and verification happen behind `bin/doflow-run <verb>` (`--json`
  output); skill prompts resolve the seam once, then call verbs and reason about what comes back.
  No filesystem math in prompts, and no skill reaching past the dispatcher to a helper by name.
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
- **Two-tier constitution — what is computed vs. what is convention.**
  `references/CONSTITUTION_BASE.md` (tier-1, global) is overlaid by
  `<repo>/agent-docs/constitution.md` (tier-2, per-repo), and tier-2 takes precedence. **That
  overlay is performed by the chain skill reading both files — no component merges them.** This is
  the canonical statement; other places point here rather than restating it.

  | Step | What happens | Guarantee |
  |------|--------------|-----------|
  | Locate tier-1 | `do-paths.sh` searches two candidates, first hit wins; `null` if none | **computed** |
  | Locate tier-2 | `do-paths.sh` emits the path plus `has_constitution_local` | **computed** |
  | Read both files | the chain skill opens them | agent-performed |
  | Overlay; tier-2 takes precedence on conflict | the chain skill reconciles them in its own reasoning | **convention** |
  | "Tier-2 may not weaken P1 (Safety)" | a rule stated to the agent | **convention, unvalidated** |
  | Constitution Check verdict | recorded in `plan.md` §2 "Constitution Check" | **advisory — blocks nothing** |
  | Propagate pointer to the agent context file | `sync-context.sh` writes a marker block | **computed** |

  Both path lookups run unconditionally, whether or not `do-constitution` has ever been invoked.
  Nothing detects a conflict between the tiers, and nothing validates the P1 rule — so avoid
  describing this model as *resolved* (there is no merged artifact) or *enforced* (nothing blocks).
  The convention is still load-bearing: it is how the rules actually reach a feature's planning.
- **`templates/doflow/` is a shared template pool, not the Agent Skills standard's
  `references/`/`assets/` pattern.** The standard nests bundled resources one level inside their
  owning skill (`skill-name/assets/*`); these templates sit outside any single skill's directory
  and are pulled in by four different skills (`do-brainstorm`, `do-design`, `do-plan`,
  `do-constitution`) via a hardcoded relative path in each one's own Behavioral Flow. Intentional
  — a shared pool avoids duplicating the same templates into four separate `skill/assets/`
  folders — but noted explicitly so it isn't mistaken for the standard's per-skill `references/`
  shape, which has a different purpose (on-demand knowledge a skill loads into its own reasoning,
  not scaffold files it copies out as new artifacts).
