# DoFlow Chain — Spec-Driven Delivery

A spec-kit-style, phase-gated delivery loop (`do-brainstorm → do-design → do-plan →
do-execute-plan → do-test → do-code-review`) on top of the rest of the `/do-*` skills and the seven
specialist agents (`core-implementer`, `delivery-lead`, `quality-guardian`,
`research-writer`, `reviewer`, `spec-analyst`, `system-architect`). Discipline borrowed from
spec-kit; enforcement done with the harness's real hooks rather than a prompt-read registry.
The implement-gate hook is registered in
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
| `shared/hooks/policies/` | `mcp-tool-guard.sh`: MCP policy; `pre-bash-guard.sh`: command denials; `pre-implementation-gate.sh`: artifact/readiness edit gate; `stop-check.sh`: blocks stopping on unfinished-work markers. Harnesses with hook support call these; support differs per harness. |
| `templates/doflow/` | `constitution-template.md` (tier-2); `data-model-template.md`; `design-template.md`; `external-contract-template.md`; `intent-template.md`; `plan-template.md`; `question-log-template.md`; `requirement-template.md`; `specs-template.md`; `state-template.md`. Chain skills seed feature dirs from a shared pool, not per-skill `assets/`. |
| `guidance/references/` | `ARTIFACT_FORMAT.md`, `ARTIFACT_VOICE.md`, `CONSTITUTION_BASE.md` (global tier-1), `DIAGRAM_GUIDE.md`, `DOFLOW_CHAIN.md`, `EVIDENCE_LEDGER.md`, `MODEL_SELECTION.md`, `ORCHESTRATION.md`, `RESEARCH_CONFIG.md`, `WORKFLOW_HANDOFF.md`. |

> Except `skills/`, use resolver roots: `.doflow/` at/above `$PWD`, then `$HOME/.doflow/`; skills install per harness in its skills dir.

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
  disambiguate using the platform-specific RULE_04 mechanism in `rules/RULES.md`. Artifacts live in
  `<repo>/agent-docs/doflow/NNN-slug/`
  either way.
- **Pre-chain intent — an input, not a phase.** An idea that has not been committed to yet goes in
  `<repo>/agent-docs/intent/<kebab-description>.md`, from `templates/doflow/intent-template.md`. It is
  deliberately outside everything the rule above describes: no branch, no slug, no feature directory,
  nothing resolves its path, and it carries neither closed vocabulary because nothing has been decided.
  Intents are **not numbered** — `NNN-` marks a feature that has started, and an intent that is never
  built would consume a number and leave a gap.

  It is **not a phase**, and adding it to the phase list would break it: a phase resolves against a
  feature directory, which resolves against a branch, so the intent would come to require the branch it
  exists to precede. Instead the discovery stage reads one when given its path, and records it in
  `requirement.md`'s `**Intent:**` field — the argument that does so is declared in `/do-brainstorm`'s
  own `argument-hint`, which is where a single-skill argument is owned. Discovery without an intent is
  unchanged and is the ordinary case.
- **Implement gate (hard):** Denies source edits for started features missing `requirement.md`/`design.md`/`plan.md` (`missing-artifacts`), or held tasks without READY at their workflow's first source-mutating stage (`readiness-missing`, `readiness-not-ready`, `readiness-wrong-template`, or `readiness-store-conflict` when a linked worktree's copy differs from the main checkout's). Other blockers: `shared/hooks/policies/`, and the planning stage's exit, which refuses a constitution MUST conflict ("Two-tier constitution" below); all other chain gates are advisory/skippable.
- **Two-tier constitution — what is computed vs. what is convention.**
  `references/CONSTITUTION_BASE.md` (tier-1, global) is overlaid by
  `<repo>/agent-docs/constitution.md` (tier-2, per-repo), and tier-2 takes precedence. **That
  overlay is performed by the chain skill reading both files — no component writes a merged file.** This is
  the canonical statement; other places point here rather than restating it.

  | Step | What happens | Guarantee |
  |------|--------------|-----------|
  | Locate tier-1 | `do-paths.sh` searches two candidates, first hit wins; `null` if none | **computed** |
  | Locate tier-2 | `do-paths.sh` emits the path plus `has_constitution_local` | **computed** |
  | Read both files | the chain skill opens them | agent-performed |
  | Overlay; tier-2 takes precedence on conflict | the chain skill reconciles them; the exit check overlays them by principle id | **convention**; **computed** for the check |
  | "Tier-2 may not weaken P1 (Safety)" | a rule stated to the agent | **convention, unvalidated** |
  | Constitution Check verdict | one PASS/FAIL row per principle in `plan.md` §2; the `do-plan` stage's handoff refuses a MUST marked FAIL or without a row | **computed — blocks the planning exit** |
  | Propagate pointer to the agent context file | `sync-context.sh` writes a marker block | **computed** |

  Both path lookups run unconditionally, whether or not `do-constitution` has ever been invoked.
  The model judges each principle; the runtime enforces only the record, MUST unless a principle
  says `**Tier:** SHOULD`, with no waiver. Nothing validates the P1 rule, and no merged artifact
  exists, so avoid describing the overlay as *resolved*.
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
