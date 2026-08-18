# DoFlow Constitution

**Version:** 0.1.0 · **Ratified:** 2026-08-18 · **Last amended:** 2026-08-18

<!-- SYNC IMPACT REPORT (filled by /do-constitution on each change):
     version: (none) → 0.1.0 · changed: file did not exist; created from
     templates/doflow/constitution-template.md and seeded with the single principle supplied
     on the invocation (structured logging on all services). This was invoked as --amend, but
     has_constitution_local was false, so step 3's create arm was taken — there was no prior
     version to bump and no prior text to amend. · propagated to: CLAUDE.md (DOFLOW pointer
     block); advisory at /do-plan's Constitution Check. -->

> Persistent, cross-feature rules every phase and agent inherits. This is the **tier-2**
> per-repo overlay on top of `CONSTITUTION_BASE.md`; these rules take precedence on conflict.
> The overlay is performed by the chain skill reading both files — see `DOFLOW_CHAIN.md` →
> "Two-tier constitution" for what is computed and what is convention. Bump the version (semver)
> on any change and fill the Sync Impact Report above.

## Principles

### P-R1 — Structured logging on all services
Every service emits machine-parseable structured log records — one object per event with an
explicit level, a timestamp, and a correlation/request identifier — never free-form interpolated
strings. Testable: a log call that concatenates values into a message string instead of attaching
them as fields is a violation, and a service with no correlation identifier on its request-scoped
logs is a violation.

## Constraints
- [stack / tooling / process constraint specific to this repo].

## Governance
- Amendments: bump semver, fill the Sync Impact Report, re-run dependent gates.
- `/do-plan`'s Constitution Check MUST evaluate against both tiers together (these rules taking
  precedence). Its verdict is advisory — recorded, not blocking.
