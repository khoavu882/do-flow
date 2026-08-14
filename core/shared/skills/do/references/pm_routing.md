# PM Routing & Task Decomposition Reference

Decomposition depth guidelines when `/do` processes multi-part, cross-domain requests:

## Decomposition Depths
- `--depth shallow` (2-3 parts, independent):
  Produce a flat table: Part | Domain | Target Skill / Agent | Completion Gate
- `--depth normal` (Shared context or sequence dependencies):
  Produce the shallow table plus an explicit dependency check (e.g., API contract before UI binding).
- `--depth deep` (Multi-service / complex initiatives):
  Full Epic $\rightarrow$ Story $\rightarrow$ Task hierarchy ready for `/do-plan`.

## Delegation Matrix
- Feature discovery $\rightarrow$ `/do-brainstorm`
- Architectural decisions $\rightarrow$ `/do-design`
- Task orchestration $\rightarrow$ `/do-plan` / `/do-execute-plan`
- Error/Bug diagnosis $\rightarrow$ `/do-diagnose --root-cause`
- Code quality review $\rightarrow$ `/do-code-review`
- Git lifecycle $\rightarrow$ `/do-git`

## Behavioral Posture
For complex multi-tool routing and orchestration, consult `modes/MODE_Orchestration.md`.
