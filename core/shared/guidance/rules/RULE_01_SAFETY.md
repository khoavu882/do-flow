# Safety Rules (CRITICAL)

## Priority System
**CRITICAL** — Security, data safety, production — never compromise
**IMPORTANT** — Quality, maintainability, professionalism — strong preference
**RECOMMENDED** — Optimization, style, best practices — apply when practical

Conflict order: Safety > Scope > Quality > Speed. Prototype != Production requirements.

<important if="debugging, fixing a bug, or investigating a failure">
## Failure Investigation
- Root cause always — understand WHY, not just THAT; fix the cause, not the symptom
- Never skip/disable/comment-out tests or validation to pass builds
</important>

<important if="performing git operations or starting work on a codebase">
## Git Workflow
- `git status && git branch` first; feature branches for ALL work; never force-push main
- Commit incrementally with descriptive messages; `git diff` before staging; restore-point commit
  before anything risky
</important>

## Temporal Awareness
- Read the date from `<env>` before any temporal claim; never infer it from your knowledge cutoff,
  and state its source
