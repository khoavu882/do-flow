# DoFlow Constitution

**Version:** 0.1.0 · **Ratified:** 2026-08-18 · **Last amended:** 2026-08-18

<!-- SYNC IMPACT REPORT (filled by /do-constitution on each change):
     version: (none) → 0.1.0 · changed: initial ratification — added 5 repo-specific principles
     (Single Source of Truth, Registry-Adapter Parity, Neutral State Ledger, No Build Step,
     Cross-Harness Equivalence) and repo constraints · propagated to: CLAUDE.md (DOFLOW pointer
     block) -->

> Persistent, cross-feature rules every phase and agent inherits. This is the **tier-2**
> per-repo overlay on top of `CONSTITUTION_BASE.md`; these rules take precedence on conflict.
> The overlay is performed by the chain skill reading both files — see `DOFLOW_CHAIN.md` →
> "Two-tier constitution" for what is computed and what is convention. Bump the version (semver)
> on any change and fill the Sync Impact Report above.

## Principles

### P1 — Single source of truth
Cross-harness content (guidance, skills, agent specs, scripts, templates) lives once, in
`core/shared/`. Never fork or duplicate content per-harness because two harnesses place it
differently — projecting it correctly is the adapter's job (`src/adapters/<harness>/index.js`),
not a reason to copy the content itself.

### P2 — Registry-adapter parity
A claim in `core/registry/*.yaml` (harness capability, asset projection, contract) must be backed
by real, working adapter code. The guard suite (`test/guards/*.test.js`, G1–G10) is the
enforcement mechanism — a guard finding means the doc/registry/skill went stale relative to
reality; fix the stale side, never weaken the guard to make it pass.

### P3 — Neutral state ledger is authoritative
File ownership (what DoFlow manages vs. user content) is tracked only in the neutral state
ledger under `<project>/.doflow/state/` (or `~/.doflow/state/` for `-g`). Never infer ownership
from a harness's own config format, and never let `update`/`remove`/`rollback` touch a file the
ledger doesn't record as DoFlow-owned.

### P4 — No build step, plain Node
This project ships as plain Node (`>=18`) with no bundler and no TypeScript compile step. New
functionality must run directly under `node`; do not introduce build tooling, transpilation, or a
new package-manager dependency to work around this constraint.

### P5 — Cross-harness equivalence
A behavior change to one harness's adapter (`src/adapters/<harness>/index.js`) must be evaluated
against the other six harnesses for whether they need the same change. Skipping a harness is
allowed only with an explicit, recorded reason (e.g., the harness genuinely lacks the capability) —
silent divergence between harnesses is a defect.

## Constraints
- Runtime: Node `>=18`, no bundler, no TypeScript.
- Tests: `npm test` (node --test) must stay green; `test/code-review-fixtures.sh` is a separate
  regression suite for `do-code-review`'s Python analyzer and is not part of `npm test`.
- Registry files under `core/registry/*.yaml` are plain JSON despite the `.yaml` extension —
  don't reformat them into real YAML.
- Adding a harness requires all three of: a registry entry, a new adapter implementing the
  six-function contract (`discover, render, plan, apply, remove, verify`), and dispatch wiring —
  partial additions fail the guard suite by design.

## Governance
- Amendments: bump semver, fill the Sync Impact Report, re-run dependent gates (`npm test`).
- `/do-plan`'s Constitution Check MUST evaluate against both tiers together (these rules taking
  precedence). Its verdict is advisory — recorded, not blocking.
