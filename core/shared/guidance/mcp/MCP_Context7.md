# Context7 MCP Server

**Purpose**: Official library documentation lookup and framework pattern guidance

## Trigger
The work is about to state, as fact, the behaviour, interface, configuration or version detail of a named library, framework, API, SDK, CLI tool or service. Otherwise skip it and record `skipped:not-due`.

## Works Best With
- **Sequential**: Context7 provides docs → Sequential analyzes implementation strategy

## Tool IDs

For a skill that calls context7 explicitly rather than relying on the trigger above:
- `mcp__context7__resolve-library-id` — resolve a library/framework name to its context7 id
- `mcp__context7__query-docs` — fetch docs for a resolved id
- **Availability:** no callable context7 tool (on Claude Code,
  `ToolSearch("select:mcp__context7__resolve-library-id")` finds none) means unavailable: record
  that outcome, say how to add it, never halt.