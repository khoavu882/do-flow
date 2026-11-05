# DoFlow Constitution

**Version:** 1.0.0 · **Ratified:** 2026-10-27 · **Last amended:** 2026-10-27

<!-- SYNC IMPACT REPORT (filled by /do-constitution on each change):
     version: (none) → 1.0.0 · changed: P5 "Parallel when write sets are disjoint" downgraded from MUST to SHOULD for this repo (person-approved 2026-10-27; P1-P4 and P6 stay MUST, base CONSTITUTION_BASE.md 1.1.0 unchanged) · propagated to: the planning stage's exit gate reads this overlay and prints one downgrade note with this version; agent context pointer not written (CLAUDE.md and AGENTS.md are gitignored in this repo) -->

> Persistent, cross-feature rules every phase and agent inherits. This is the **tier-2**
> per-repo overlay on top of `CONSTITUTION_BASE.md`; these rules take precedence on conflict.
> The overlay is performed by the chain skill reading both files — see `DOFLOW_CHAIN.md` →
> "Two-tier constitution" for what is computed and what is convention. Bump the version (semver)
> on any change and fill the Sync Impact Report above.

## Principles

### P5 — Parallel when write sets are disjoint
**Tier:** SHOULD
A plan may run tasks in sequence for a stated reason; parallelism is a working practice, not a
correctness rule. Tasks with shared write sets or dependencies still run sequentially.

## Constraints
- Every other base principle (P1-P4, P6) applies unchanged as MUST.

## Governance
- Amendments: bump semver, fill the Sync Impact Report, re-run dependent gates.
- `/do-plan`'s Constitution Check MUST evaluate against both tiers together (these rules taking
  precedence). A MUST FAIL refuses the planning stage's exit; a SHOULD FAIL is advisory.
