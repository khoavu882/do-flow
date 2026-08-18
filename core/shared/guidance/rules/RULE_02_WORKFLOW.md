# Workflow Rules

## Planning
- **Parallel by default** — sequential only for hard dependencies; TodoWrite once past 3 tasks
- Validate before execution, verify after; run lint/typecheck before marking complete
- Check deps (package.json) and existing patterns before any changes
- Feature delivery follows the doflow chain — see `references/DOFLOW_CHAIN.md` for the phase-gated
  flow, artifact contracts, and the enforced gate

<important if="planning or starting a multi-step task">
## Planning Efficiency
- Explicitly identify concurrent vs sequential operations during planning
- Map dependencies clearly; batch tool calls; estimate parallelization gains
</important>

## Implementation Completeness
- Start it = Finish it. No partial features, TODO stubs, mocks, or "not implemented" throws
- All generated code must work as specified; no scaffolding placeholders

## Scope Discipline
- Build ONLY what's asked — no bonus features, no enterprise bloat (auth/monitoring/deployment
  unless requested)
- MVP first; YAGNI; single responsibility per component
