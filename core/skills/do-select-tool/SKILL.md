---
name: do-select-tool
description: "Intelligent MCP tool selection based on complexity scoring and operation analysis"
when_to_use: Trigger automatically for read-only tool-routing decisions, MCP/native tool selection, complexity scoring, or when the user asks which tool or workflow should handle an operation.
argument-hint: "[operation] [--analyze] [--explain]"
disable-model-invocation: false
user-invocable: true
effort: low
---

# do-select-tool

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-select-tool [operation] [--analyze] [--explain]
```

## Metadata
- Category: `special`
- Complexity: `high`
- Effort: `low`
- Suggested MCP/tooling: native (`Grep`, `Glob`, `Read`, `Edit`), `sequential`

## Triggers
- Operations requiring optimal tool selection between MCP servers and native tools
- Meta-system decisions needing complexity analysis and capability matching
- Tool routing decisions requiring performance vs accuracy trade-offs
- Operations benefiting from intelligent tool capability assessment

## Behavioral Flow
1. **Parse**: Analyze operation type, scope, file count, and complexity indicators
2. **Score**: Apply multi-dimensional complexity scoring across various operation factors
3. **Match**: Compare operation requirements against available MCP servers and native tool capabilities
4. **Select**: Choose optimal tool based on scoring matrix and performance requirements
5. **Validate**: Verify selection accuracy and provide confidence metrics

Key behaviors:
- Complexity scoring based on file count, operation type, language, and framework requirements
- Performance assessment evaluating speed vs accuracy trade-offs for optimal selection
- Decision logic matrix with direct mappings and threshold-based routing rules
- Tool capability matching for MCP servers (specialized capability) vs native tools (fast pattern/file operations)

## Key Patterns
- **Direct Mapping**: Deep reasoning → Sequential, Library docs → Context7, Browser/UI verification → Playwright / Chrome DevTools, Symbol search & pattern edits → native (Grep / Glob / Read / Edit), Cross-session memory → native files (`agent-docs/`, Claude memory)
- **Complexity Thresholds**: Score >0.6 → MCP server, Score <0.4 → Native tools, 0.4-0.6 → Feature-based
- **Performance Trade-offs**: Speed requirements → Native tools, Specialized capability → MCP server
- **Fallback Strategy**: MCP server → Native tools degradation chain

## Boundaries
**Will:**
- Analyze operations and provide optimal tool selection between MCP servers and native tools
- Apply complexity scoring based on file count, operation type, and requirements
- Provide sub-100ms decision time with >95% selection accuracy

**Will Not:**
- Override explicit tool specifications when user has clear preference
- Select tools without proper complexity analysis and capability matching
- Compromise performance requirements for convenience or speed
