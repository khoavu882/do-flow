# Rules

## RULE_01 Safety
Conflict order: Safety > Scope > Quality > Speed. Prototype != Production requirements.
- Read the date from the environment before any temporal claim; never infer it from your knowledge cutoff, and state its source.

## RULE_02 Workflow
- **Parallel when write sets are disjoint; otherwise sequential.** Use task lists past 3 tasks when available.
- Run lint/typecheck before marking complete.
- Check deps (package.json) and existing patterns before any changes.
- Feature delivery follows the doflow chain — see `references/DOFLOW_CHAIN.md` for the phase-gated flow, artifact contracts, and the enforced gate.
- Start it = Finish it. No partial features, TODO stubs, mocks, or "not implemented" throws.
- All generated code must work as specified; no scaffolding placeholders.

**Scope Discipline**
- Build ONLY what's asked — no bonus features, no enterprise bloat (auth/monitoring/deployment unless requested).
- MVP first; YAGNI; single responsibility per component.

## RULE_03 Quality
**Naming**: Follow language standards (camelCase JS, snake_case Python); no mixed conventions
**Files**: Follow the repository's existing layout; only if none exists, use `tests/` for tests, `scripts/` for scripts and `agent-docs/` for reports.
**Workspace**: Remove temp files, debug scripts, build artifacts after use; never leave clutter in VCS

**Professional Honesty**
- No marketing language ("blazingly fast", "100% secure", "magnificent")
- No invented sources, figures, citations or quotes; leave out what you cannot trace; state "untested/MVP/needs validation" honestly
- If you are not sure, say so plainly and name what is unknown; do not present a guess as established
- Warn when a claim may be outdated: information from memory or an old source can have changed since it was written
- Never attribute a statement or view to a real person unless you have verified it; otherwise omit the name
- Push back on bad approaches

## RULE_04 Questions
- Ask ONLY for genuine user-owned decisions unresolved by the request, the code, or sensible defaults.
- Enough to act → act; don't ask to confirm the obvious (see RULE_02 Scope Discipline).
- One question that unblocks beats three that re-litigate settled choices.

**Non-Interactive Fallback**
When no native interactive question tool (one that presents options and returns the user's choice) is available in the current session:
- Do NOT generate `{stage}-questions.md` files or halt execution waiting for manual file edits.
- Adopt the recommended default choice, record the adopted decision and rationale in the stage notes or artifact, and proceed with execution.
- If no sensible default exists and execution cannot safely proceed without user input, report the specific ambiguity and halt.

## Flags and runtime
What the user typed beats auto-detection. A flag is declared in the `argument-hint` of every skill that consumes it; shared flags are `--depth` and `--type`.
The runtime enforces readiness gating (a four-state verdict, never a number), recovery bounds (it sets the retry bound, not you), run tracing (where a run stopped is read from its record, never reconstructed) and capability routing (a provider healthy on this machine, not a habitual tool).
