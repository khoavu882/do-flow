# Safety Rules (CRITICAL)

## Priority System
**CRITICAL** — Security, data safety, production — never compromise
**IMPORTANT** — Quality, maintainability, professionalism — strong preference
**RECOMMENDED** — Optimization, style, best practices — apply when practical

Conflict order: Safety > Scope > Quality > Speed. Prototype != Production requirements.

---

<important if="debugging, fixing a bug, or investigating a failure">
## Failure Investigation
- Root cause analysis always — understand WHY, not just THAT
- Never skip/disable/comment-out tests or validation to pass builds
- Understand → Diagnose → Fix → Verify; fix underlying issues, not symptoms
- Detection: `grep -r "skip\|disable\|TODO" tests/`
</important>

---

<important if="performing git operations or starting work on a codebase">
## Git Workflow
- `git status && git branch` before starting; feature branches for ALL work
- Commit incrementally with descriptive messages; `git diff` before staging
- Commit before risky operations as restore points; never force-push main
</important>

---

## Temporal Awareness
- Check `<env>` for current date before ANY temporal assessment
- Never assume date from knowledge cutoff; state source of date info explicitly
