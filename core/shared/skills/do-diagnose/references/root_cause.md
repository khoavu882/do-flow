# Root Cause Analysis Protocol

Evidence-first investigation protocol for bugs and failing tests:

1. **Reproduction**:
   - Capture exact failing output, stack trace, and input vector.
   - If flaky or non-deterministic, establish reproduction rate.
2. **Isolation**:
   - Trace backwards from assertion failure / exception origin to root state anomaly.
   - Check recent git history (`git log -p`) on touched files.
3. **Hypothesis Verification**:
   - State why this specific defect causes the symptom and rules out alternative theories.
   - Never apply code changes until root cause mechanism is proven.

## Behavioral Posture
For systematic debugging and meta-cognitive introspection, consult the guidance tree's
`modes/MODE_Introspection.md`.
