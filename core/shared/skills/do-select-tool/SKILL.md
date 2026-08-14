---
name: do-select-tool
description: "Capability-driven tool routing and progressive retrieval planning using DoFlow CapabilityRouter"
when_to_use: Trigger automatically for read-only tool-routing decisions, information retrieval planning, capability selection, or when determining whether to use native search, Semble, Graphify, Git, or MCP tools.
argument-hint: "[operation] [--analyze] [--explain]"
user-invocable: true
effort: low
disallowed-tools: Edit, Write, NotebookEdit
---

# do-select-tool

Routes an information need or operation to the optimal capability and provider using DoFlow's **Capability Router** (`core/registry/capabilities.yaml` and `core/registry/routes.yaml`).

Distinct from `/do-pm` (which routes user requests to skills/agents) — this routes an **information need** to a specific tool or retrieval plan.

## Invocation
```text
/do-select-tool [operation] [--analyze] [--explain]
```

## Abstract Capabilities & Default Routing Matrix

| Information Intent | Preferred Capability | Primary Provider | Fallback Chain |
|---|---|---|---|
| Exact symbol, path, or regex pattern | `code.exact-search` | `native.rg` (Ripgrep/Grep) | — |
| Natural-language concept or behavior | `code.semantic-search` | `semble.search` (Semble) | `code.exact-search` (`native.rg`) |
| Call graph, dependencies, caller/callee | `code.relationships` | `graphify.query` (Graphify) | `code.exact-search` (`native.rg`) |
| Change blast radius / impact analysis | `code.impact-analysis` | `graphify.query` (Graphify) | `code.relationships` → `code.exact-search` |
| Git commit rationale, blame, history | `history.search` | `git.native` (Git CLI) | — |
| Behavioral test execution | `behavior.verify` | `native.test` (Test Runner) | — |
| High-output CLI command execution | `command.compress` | `rtk` (Rust Token Killer) | Raw uncompressed command |
| External API/framework documentation | `docs.lookup` | `context7` MCP | Web search / Native docs |
| Multi-step structured reasoning | `reasoning.structured`| `sequential-thinking` MCP | In-context chain of thought |

## Behavioral Flow

1. **Map to Intent & Capability**:
   - Translate the described operation into an abstract capability and intent.
   - Example: *"Where is invoice timeout handled?"* → `locate-concept` (`code.semantic-search`).
   - Example: *"Find all references to validatePayment"* → `locate-known-symbol` (`code.exact-search`).

2. **Apply Progressive Escalation (Do not fan out blindly)**:
   - Use the single most specific tool for the job.
   - If the exact identifier is known, **prefer native exact search** immediately.
   - If the query is conceptual or natural language, **prefer semantic search (Semble)**.
   - If the query asks for call trees or architectural blast radius, **prefer structural graph queries (Graphify)**.

3. **Evaluate Availability & Fallbacks**:
   - If a specialized tool (e.g. Semble or Graphify) is missing or unindexed, cleanly fall back to `native.rg` or Git.
   - Never halt or fail because an optional tool is absent.

4. **Formatting Output**:
   - **Recommendation**: State the chosen capability, resolved provider, and concrete command/MCP tool invocation.
   - **`--explain`**: Provide the rationale explaining why this capability was selected and what fallback was considered.
   - **`--analyze`**: Compare viable capabilities and their context/token trade-offs without committing.

5. **Respect Explicit User Preference**:
   - If the user explicitly asks for a specific tool (e.g. *"Use grep to find..."*), honor that choice directly.

## Boundaries
**Will:** classify information needs, map them to abstract capabilities, construct progressive retrieval plans, and report tool choices with fallbacks.
**Will Not:** execute the operation itself (routing decision only); override an explicit user tool choice; fan out multiple redundant searches for a single question.
