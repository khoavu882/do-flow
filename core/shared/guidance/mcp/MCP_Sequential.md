# Sequential MCP Server

**Purpose**: Multi-step reasoning engine for complex analysis and systematic problem solving

## Trigger
The work settles a decision with more than one interacting part or competing option and records the choice. Otherwise skip it and record `skipped:not-due`.

## Works Best With
- **Context7**: Sequential coordinates analysis → Context7 provides official patterns

## Tool IDs

For a skill that calls sequential-thinking explicitly rather than relying on the trigger above:
- `mcp__sequential-thinking__sequentialthinking` — run structured multi-step reasoning
- **Availability:** no callable sequential-thinking tool (on Claude Code,
  `ToolSearch("select:mcp__sequential-thinking__sequentialthinking")` finds none) means
  unavailable: record that outcome, say how to add it, never halt.