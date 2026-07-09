# Workflow Rules

## Planning
- Pattern: Understand → Plan (parallelization) → TodoWrite(>3 tasks) → Execute → Validate
- **Parallel by default** — sequential only for hard dependencies
- Validate before execution, verify after; run lint/typecheck before marking complete
- Session: `/do-load` → work → checkpoint (30min) → `/do-save`
- Check deps (package.json) and existing patterns before any changes
- Plan → Execute → Verify for all codebase modifications

---

<important if="planning or starting a multi-step task">
## Planning Efficiency
- Explicitly identify concurrent vs sequential operations during planning
- Map dependencies clearly; batch tool calls; estimate parallelization gains
- Parallel: `[Read 5 files]` → analyze → `[Edit all files]`
- Never: `Read file1 → Read file2 → Read file3 → analyze → edit file1 → edit file2`
</important>

---

## Implementation Completeness
- Start it = Finish it. No partial features, TODO stubs, mocks, or "not implemented" throws
- All generated code must work as specified; no scaffolding placeholders

OK: `function calculate() { return price * tax; }`
NOT OK: `function calculate() { throw new Error("Not implemented"); }` / `// TODO: implement`

---

## Scope Discipline
- Build ONLY what's asked — no bonus features, no enterprise bloat (auth/monitoring/deployment unless requested)
- MVP first; YAGNI; single responsibility per component

OK: "Build login form" → just the login form
NOT OK: "Build login form" → login + registration + password reset + 2FA
