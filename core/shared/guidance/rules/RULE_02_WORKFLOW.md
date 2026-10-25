# Workflow Rules

## Planning
- **Parallel when write sets are disjoint; otherwise sequential.** Use task lists past 3 tasks when available.
- Validate before execution, verify after; run lint/typecheck before marking complete.
- Check deps (package.json) and existing patterns before any changes.
- Feature delivery follows the doflow chain — see `references/DOFLOW_CHAIN.md` for the phase-gated flow, artifact contracts, and the enforced gate.

## Implementation Completeness
- Start it = Finish it. No partial features, TODO stubs, mocks, or "not implemented" throws.
- All generated code must work as specified; no scaffolding placeholders.

## Scope Discipline
- Build ONLY what's asked — no bonus features, no enterprise bloat (auth/monitoring/deployment unless requested).
- MVP first; YAGNI; single responsibility per component.
