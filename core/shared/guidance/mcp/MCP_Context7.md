# Context7 MCP Server

**Purpose**: Official library documentation lookup and framework pattern guidance

## Triggers
- Import statements: `import`, `require`, `from`, `use`
- Framework keywords: React, Vue, Angular, Next.js, Express, etc.
- Library-specific questions about APIs or best practices
- Need for official documentation patterns vs generic solutions
- Version-specific implementation requirements

## Choose When
- **Over WebSearch**: When you need curated, version-specific documentation
- **Over native knowledge**: When implementation must follow official patterns
- **For frameworks**: React hooks, Vue composition API, Angular services
- **For libraries**: Correct API usage, authentication flows, configuration
- **For compliance**: When adherence to official standards is mandatory

## Works Best With
- **Sequential**: Context7 provides docs → Sequential analyzes implementation strategy

## Examples
```
"implement React useEffect" → Context7 (official React patterns)
"add authentication with Auth0" → Context7 (official Auth0 docs)
"migrate to Vue 3" → Context7 (official migration guide)
"optimize Next.js performance" → Context7 (official optimization patterns)
"just explain this function" → Native Claude (no external docs needed)
```

## Tool IDs

For a skill that calls context7 explicitly rather than relying on the ambient triggers above:
- `mcp__context7__resolve-library-id` — resolve a library/framework name to its context7 id
- `mcp__context7__query-docs` — fetch docs for a resolved id
- **Availability:** `ToolSearch("select:mcp__context7__resolve-library-id")` finding no match means
  context7 isn't connected this session — skip the call, note it in the caller's own report, never
  halt on it.