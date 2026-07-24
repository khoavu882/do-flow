---
name: do-pm
description: "Classify an ambiguous or multi-part request and route each part to the right existing skill or specialist agent, instead of picking manually. Use when a request bundles 2+ unrelated asks (different files/domains/no shared root cause), when it's unclear which /do-* skill or agent fits, or when the user explicitly asks who/what should handle a multi-service or multi-task request. Not for a single, already-obvious task — route that directly instead."
argument-hint: "[request] [--depth shallow|normal|deep] [--agent name]"
effort: high
---

# do-pm

Request classifier and delegator — invoke when a request is ambiguous, spans multiple unrelated
domains, or it's unclear which skill/agent should own it. Absorbs `do-spawn` (deep hierarchical
breakdown) and `do-task` (explicit per-part validation) — both merged here, see `--depth` below.

## Invocation
```text
/do-pm [request] [--depth shallow|normal|deep] [--agent name]
```

## Behavioral Flow
1. **Verify referenced targets exist** — before classifying, check that any file, service, script,
   or subsystem named in the request is real (`grep`/`find`/`ls` in the current repo, and sibling
   repos if this is a multi-repo workspace). If it doesn't exist, stop and say so rather than
   building a routing plan against an unverified premise — do not proceed to step 2 regardless.
2. **Classify the request**:
   - **State/status question** ("where were we", "current status") → answer directly from
     `state.md`/`git log`; no delegation needed.
   - **Vague/exploratory** ("I want to build X", "how should I approach Y") → route to
     `/do-brainstorm`.
   - **Workflow resume** (references `plan.md`, "execute plan", "next task") → route to
     `/do-execute-plan`.
   - **Review request** ("review my changes", "MR/PR review") → route to `/do-code-review`.
   - **Single, already-obvious task** → route directly to the one matching skill/agent; skip the
     rest of this flow.
   - **Multi-domain / multi-part request** (2+ asks with different files, domains, or no shared
     root cause) → continue to step 3.
3. **Decompose**, depth-dependent:
   - `--depth shallow` (default for 2-3 parts with no cross-part dependency): a flat table — one
     row per part, its domain, and the skill/agent it routes to.
   - `--depth normal`: the shallow table, plus an explicit **dependency check** — state whether
     parts share a root cause or files, or must be sequenced (e.g. "contract design before backend
     implementation"), not just "independent, so parallel."
   - `--depth deep` (requests spanning many services/components): a full Epic → Story → Task
     hierarchy, one Story per component/service, with a dependency graph and per-task delegation —
     enough structure to hand straight to `/do-plan`.
4. **Delegate** — for each part, name the actual skill (`/do-implement`, `/do-document`,
   `/do-troubleshoot`, etc.) or, when no skill fits, a real Agent-tool `subagent_type`
   (`backend-architect`, `security-engineer`, `quality-engineer`, `root-cause-analyst`,
   `performance-engineer`, `technical-writer`, `refactoring-expert`, `code-reviewer`, ...) — never
   an undefined role name. Note `confidence-check` as a required gate before any part that edits
   files.
5. **State the completion gate per part** — tests pass, `confidence-check` cleared, root cause
   confirmed before a fix is proposed — so "done" is defined per part, not just "routed."
6. **Report and stop** — output the classification + delegation table (and dependency graph at
   `--depth deep`). This is routing output only — `/do-pm` does not perform the delegated work
   itself. If 2+ parts are independent and dependency-ready, suggest `/parallel-agents` to fan them
   out; otherwise state the required order.

## Boundaries
**Will:** classify and decompose a request, verify referenced targets exist first, name concrete
skills/agents to delegate to, state dependencies and completion gates per part.
**Will Not:** perform the delegated work itself (write code, docs, or run diagnosis) — routing
output only. Auto-trigger — `disable-model-invocation: true` means only an explicit `/do-pm`
invocation runs this, never organic prompt-matching.

## Next Step
Invoke the delegated skills/agents individually, or via `/parallel-agents` once 2+ parts are
independent and dependency-ready to run concurrently.
