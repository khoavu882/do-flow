# [PROJECT NAME] Constitution

**Version:** 0.1.0 · **Ratified:** [DATE] · **Last amended:** [DATE]

<!-- SYNC IMPACT REPORT (filled by /do-constitution on each change):
     version: [old] → [new] · changed: [...] · propagated to: [...] -->

> Persistent, cross-feature rules every phase and agent inherits. This is the **tier-2**
> per-repo overlay on top of `CONSTITUTION_BASE.md`; these rules take precedence on conflict.
> The overlay is performed by the chain skill reading both files — see `DOFLOW_CHAIN.md` →
> "Two-tier constitution" for what is computed and what is convention. Bump the version (semver)
> on any change and fill the Sync Impact Report above.

## Principles

<!-- One `### <ID> — <name>` heading per principle. A principle is MUST unless its body has
     `**Tier:** SHOULD`. An ID equal to a base one (P1–P6) replaces that base principle. -->

### R1 — [PRINCIPLE_1_NAME]
**Tier:** MUST
[PRINCIPLE_1_STATEMENT — testable and non-negotiable.]

### R2 — [PRINCIPLE_2_NAME]
**Tier:** SHOULD
[PRINCIPLE_2_STATEMENT.]

## Constraints
- [stack / tooling / process constraint specific to this repo].

## Governance
- Amendments: bump semver, fill the Sync Impact Report, re-run dependent gates.
- `/do-plan`'s Constitution Check MUST evaluate against both tiers together (these rules taking
  precedence). A MUST principle marked FAIL or left without a row refuses the planning stage's exit;
  a SHOULD FAIL is advisory.
