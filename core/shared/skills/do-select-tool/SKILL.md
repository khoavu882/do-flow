---
name: do-select-tool
description: "Intelligent MCP tool selection based on complexity scoring and operation analysis"
when_to_use: Trigger automatically for read-only tool-routing decisions, MCP/native tool selection, complexity scoring, or when the user asks which tool or workflow should handle an operation.
argument-hint: "[operation] [--analyze] [--explain]"
user-invocable: true
effort: low
---

# do-select-tool

Decides native tool vs. MCP server for a described operation — a routing decision, not an
execution. Distinct from `/do-pm` (routes a *request* to a skill/agent) — this routes an
*operation* to a specific tool.

## Invocation
```text
/do-select-tool [operation] [--analyze] [--explain]
```

## Behavioral Flow
1. **Classify the operation**: symbol search/pattern edit (→ native `Grep`/`Glob`/`Read`/`Edit`),
   library/framework documentation lookup (→ `context7`), multi-step reasoning or hypothesis
   testing (→ `sequential-thinking`), browser/UI verification (→ `playwright` or
   `chrome-devtools` depending on whether it's automated testing or live debugging),
   cross-session memory (→ native files: `agent-docs/`, this session's memory system).
2. **Score complexity** if the mapping in step 1 is ambiguous (spans multiple categories or an
   unfamiliar operation type): file count touched, whether it needs semantic understanding vs.
   literal pattern match, whether a specialized MCP capability is actually required or native
   tools can do it faster.
3. **Prefer native when it's sufficient** — MCP tool overhead (connection, larger context) only
   pays off when the operation genuinely needs that server's specialized capability; a simple
   grep-able pattern stays native even if an MCP server *could* also do it.
4. **`--explain`**: state the reasoning (which factor decided it), not just the tool name.
   **`--analyze`**: score without committing to a recommendation — useful when comparing two
   plausible tools.
5. **Respect an explicit user preference** — if the user already named a tool, don't override it;
   this skill is for when the choice is genuinely open.

## Boundaries
**Will:** classify an operation and recommend native vs. MCP tool with reasoning; score
complexity when the mapping is ambiguous.
**Will Not:** execute the operation itself (routing decision only); override an explicit user tool
preference; recommend an MCP server that isn't actually connected in this session.
