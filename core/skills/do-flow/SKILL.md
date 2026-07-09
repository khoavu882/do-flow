---
name: do-flow
description: "Auto-chain the doflow spec-driven flow (constitution → spec → plan → tasks → implement → review), pausing only at defined approval gates"
argument-hint: "[feature description] [--from constitution|spec|plan|tasks|implement|review]"
disable-model-invocation: false
effort: high
---

# do-flow

Runs the doflow spec-driven chain end-to-end without requiring a manual `/do-X` invocation for
every phase. It does not replace or modify `do-constitution`, `do-spec`, `do-plan`, `do-tasks`,
`do-execute-plan`, or `do-review` — it runs their existing Behavioral Flows in sequence, the same
way `do-review` already runs `code-reviewer`/`security-engineer` rather than reimplementing them.

## Invocation
```text
/do-flow [feature description] [--from constitution|spec|plan|tasks|implement|review]
```

## Behavioral Flow
1. **Resolve state** — `do-paths.sh --json`. Determine the starting phase:
   - No active feature (trunk branch): start at `do-constitution` (skip if
     `agent-docs/constitution.md` already exists — the constitution is repo-level, not
     per-feature) then `do-spec`.
   - On a `feat/NNN-slug` branch: resume from the first missing artifact —
     `!has_spec` → `do-spec`; `has_spec && !has_plan` → `do-plan`;
     `has_plan && !has_tasks` → `do-tasks`; both present → Gate A (step 4).
   - `--from <phase>` overrides auto-detection to deliberately re-run a specific phase.
2. **Run phases in sequence**, invoking each phase skill's own Behavioral Flow directly:
   `do-constitution` → `do-spec` → [**Gate 0**] → `do-plan` → `do-tasks` → [**Gate A**] →
   `do-execute-plan` → `do-review` → [**Gate B**].
3. **Report progress after each auto-advanced phase** — one line: phase name + artifact path
   (e.g. `spec.md written → agent-docs/specs/003-foo/spec.md`) — so the user can follow along
   without needing to intervene.
4. **Stop at exactly three points; auto-advance everywhere else:**

   - **Gate 0 — unresolved `[NEEDS CLARIFICATION]` markers** (after `do-spec`): `do-spec` caps
     these at 3. If any remain unresolved, stop and surface them via `AskUserQuestion` (one
     question per marker, or grouped if closely related) before continuing to `do-plan`. Patch
     resolved answers into `spec.md` directly; do not re-run `do-spec`.
   - **Gate A — before implementation** (after `do-tasks`, before `do-execute-plan`): this is the
     auto-chain's *conversational* checkpoint on top of the already-existing hard hook gate
     (`pre-implement-gate.sh`, which blocks source edits until `plan.md` + `tasks.md` exist and
     remains the real enforcement regardless of what happens here). Ask via `AskUserQuestion`:
     "`plan.md` and `tasks.md` are ready. Proceed to implementation?" with options `Proceed` /
     `Let me review plan.md and tasks.md first` / `Stop here`.
   - **Gate B — before commit/merge** (after `do-review`): no enforcement hook exists for this
     today — `/do-git` is a separate, always-manually-invoked skill. Ask via `AskUserQuestion`,
     framed by the review's own approval status (e.g. if `CHANGES REQUESTED`, foreground
     "address findings first" rather than offering a bare proceed option): "Review result:
     `<status>`. Proceed to `/do-git` for commit/merge?"

5. **Never skip a gate on an ambiguous answer** — an unanswered or unclear response to any
   `AskUserQuestion` means stop and ask again, per this repo's `RULE_04_QUESTIONS`.

## Boundaries
**Will:**
- Auto-advance through constitution/spec/plan/tasks/implement/review without requiring a manual
  re-invocation at each phase boundary.
- Stop at exactly three points: unresolved spec clarifications, before implementation, before
  commit/merge.
- Compose with the existing `pre-implement-gate.sh` hard gate rather than bypass or duplicate it.

**Will Not:**
- Modify `do-constitution`, `do-spec`, `do-plan`, `do-tasks`, `do-execute-plan`, or `do-review`.
- Touch `/do-brainstorm` or `/do-design` — those remain separate, manually-invoked discovery tools.
- Add a new hook-level enforcement gate for commit/merge — Gate B is conversational only. A
  hook-level version would be a separate, future proposal.
- Silently proceed past a gate on an ambiguous or missing answer.

**Next Step:** after `do-flow` completes (or pauses at a gate), `/do-git` to commit/merge once
Gate B is cleared.
