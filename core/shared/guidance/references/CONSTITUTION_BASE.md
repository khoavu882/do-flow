# Base Constitution (tier-1)

**Version:** 1.0.1 · **Scope:** all repos using the doflow chain

> The universal, non-negotiable rules every feature inherits. This is the **tier-1 base**;
> each repo's `agent-docs/constitution.md` (tier-2) overlays it and **takes precedence on
> conflict**. `do-paths.sh` locates both tiers and reports whether tier-2 exists; the overlay
> itself is performed by the chain skill reading both files, and `/do-plan`'s Constitution Check
> records an **advisory** verdict. See `DOFLOW_CHAIN.md` → "Two-tier constitution" for what is
> computed and what is convention.

## Principles

Each states the norm; the arrow points at the always-loaded rule that carries the detail.

### P1 — Safety over speed
Security, data integrity, and production safety are never traded for velocity; a destructive or
irreversible action needs explicit confirmation. → `rules/RULES.md` RULE_01.

### P2 — Evidence over assumptions
A claim is backed by a test, a run, or a document, never guessed; a failure is root-caused before
it is fixed. → `rules/RULES.md` RULE_01, `PRINCIPLES.md`.

### P3 — Finish what you start
No TODO stubs, mocks, or "not implemented" throws in delivered code: done means validated, not
compiling. → `rules/RULES.md` RULE_02.

### P4 — Scope discipline (YAGNI)
Build only what the spec asks — no bonus features, no speculative abstraction.
→ `rules/RULES.md` RULE_02.

### P5 — Parallel when write sets are disjoint
Shared write sets/dependencies run sequentially.
→ `rules/RULES.md` RULE_02.

### P6 — Professional honesty
No invented metrics, no marketing language; state "untested / needs validation" plainly and push
back on a bad approach with evidence. → `rules/RULES.md` RULE_03.

## Governance
- This base is versioned (semver). Tier-2 repo constitutions may **add** or **override** principles,
  but may not weaken P1 (Safety). *This constraint is stated to the reading agent; nothing
  validates it, so a tier-2 file that weakened P1 would not be rejected by any check.*
- `/do-plan` MUST evaluate its Constitution Check against both tiers together (tier-2 taking
  precedence) and record PASS/FAIL. The verdict is **advisory** — it is recorded in `plan.md`
  §2 "Constitution Check" and blocks nothing. Gate scope: `DOFLOW_CHAIN.md`.
