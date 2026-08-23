# Spec: orchestrator context modes per edge + event-bus emission

Design document for issue #9. Written spec-first, opencode-`specs/` style: the shape is agreed
here before any implementation PR opens. Nothing in this file changes runtime behavior; it is
the contract future orchestrator work implements and tests pin.

## Problem

The orchestrator currently treats every edge (skill→runtime, skill→skill, harness→skill) with
one implicit context strategy: full guidance context re-read at each hop. Three failure modes
follow at scale:

1. **Context bloat on deep chains** — a nine-stage workflow re-imports the same guidance per
   stage; budget pressure grows linearly with chain depth rather than with new information.
2. **No event trail for cross-skill handoffs** — when skill B starts because skill A finished,
   nothing records that causal edge outside ad-hoc prose in the evidence ledger.
3. **Harness asymmetry is invisible** — Claude (native subagents), Codex (AGENTS.md pointer),
   and Gemini (`@file` imports) carry context differently, but the orchestrator models none of
   that difference.

## Context modes

Every orchestrator edge declares one of four modes. The mode is data (registry-declared per
workflow stage edge in `workflows.json`), never inferred at runtime from prose.

| Mode | Carries | Costs | Use for |
|---|---|---|---|
| `full` | Complete guidance + state summary | Highest | Stage boundaries where safety requires total recall (verification, release) |
| `delta` | State diff since parent edge + pointers | Medium | Sequential stages in one chain (brainstorm→design→plan) |
| `pointer` | `.doflow/guidance/` paths only | Low | Handoffs to skills that self-load what they need |
| `bare` | Task statement alone | Minimal | Router/classifier calls that must not be anchored by prior context |

Rules:

- Mode lives on the EDGE (parent stage → child stage), not on the skill. The same skill can
  receive `delta` from one parent and `bare` from another.
- Default when undeclared: `pointer` (safe, cheap, matches today's effective behavior most
  closely — the entry file already points into `.doflow/guidance/`).
- A mode may be overridden per harness class in `harnesses.json` ONLY as a narrowing (e.g.
  `bare` stays `bare`; `full` may narrow to `delta`) — never widened. This encodes harness
  context-carriage differences without a second taxonomy.
- Budget check: before handing off, the orchestrator sums the projected token estimate of the
  edge's payload against the task's remaining budget from readiness state; overflow downgrades
  the mode one step (`full→delta→pointer→bare`) and records the downgrade in the run ledger.
  Silent truncation is forbidden.

## Event bus

A single append-only event stream under neutral state (`.doflow/state/events.jsonl`, same
partitioning discipline as the existing run ledger), written at ONE place: the dispatcher seam.
Skills never write events directly — they already cannot reach past the seam, which is what
makes this trustworthy.

Event envelope (superset of today's run-ledger metadata record):

```
{ ts, verb, edge: {from, to, mode}, task, actor: {harness, skill}, outcome, refs }
```

- `edge.from/to` are skill ids or `user` / `runtime`. `mode` present only on handoff events.
- Emission points: dispatch start/end (existing), handoff accepted (new), mode downgrade (new),
  verification verdict change (new).
- Consumers read the file; no daemon, no socket. A later reader can reconstruct any chain's
  context provenance — which is the audit property the evidence ledger wanted but structured.

## Non-goals

- No cross-process pub/sub, no network transport. The "bus" is an append-only file plus the
  seam discipline.
- No change to the four-state readiness verdicts or risk-tiered verification.
- No per-skill memory systems; context is still materialized fresh per invocation.

## Implementation staging (each independently shippable)

1. **Modes as data**: extend `workflows.json` edges with optional `contextMode`; loader
   validation; orchestrator honors it; default `pointer`. No event changes yet.
2. **Budget downgrade**: token estimator (cheap heuristic first: chars/4) + downgrade rule +
   ledger record.
3. **Handoff events**: seam writes handoff/downgrade records; guard asserts metadata-only
   payloads (same invariant as the run ledger).
4. **Harness narrowing**: `harnesses.json` per-class mode ceilings; capability-map row regenerates.

Stages 1–2 unblock most of the value; 3–4 are refinements. Each stage lands with its own tests
and updates this file's status line.

## Status

- Stage 1: not started
- Stage 2: not started
- Stage 3: not started
- Stage 4: not started
