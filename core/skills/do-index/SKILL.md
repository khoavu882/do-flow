---
name: do-index
description: "Generate comprehensive project documentation and knowledge base with intelligent organization"
argument-hint: "[target] [--type docs|api|structure|readme] [--format md|json|yaml]"
disable-model-invocation: true
effort: medium
---

# do-index

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-index [target] [--type docs|api|structure|readme] [--format md|json|yaml]
```

## Metadata
- Category: `special`
- Complexity: `standard`
- Effort: `medium`
- Suggested MCP/tooling: `sequential`, `context7`
- Suggested specialist roles: `architect`, `scribe`, `quality`

## Triggers
- Project documentation creation and maintenance requirements
- Knowledge base generation and organization needs
- API documentation and structure analysis requirements
- Cross-referencing and navigation enhancement requests

## Behavioral Flow
1. **Analyze**: Examine project structure and identify key documentation components
2. **Organize**: Apply intelligent organization patterns and cross-referencing strategies
3. **Generate**: Create comprehensive documentation with framework-specific patterns
4. **Validate**: Ensure documentation completeness and quality standards
5. **Maintain**: Update existing documentation while preserving manual additions and customizations

Key behaviors:
- Multi-persona coordination (architect, scribe, quality) based on documentation scope and complexity
- Sequential MCP integration for systematic analysis and comprehensive documentation workflows
- Context7 MCP integration for framework-specific patterns and documentation standards
- Intelligent organization with cross-referencing capabilities and automated maintenance

## Key Patterns
- **Structure Analysis**: Project examination → component identification → logical organization → cross-referencing
- **Documentation Types**: API docs → Structure docs → README → Knowledge base approaches
- **Quality Validation**: Completeness assessment → accuracy verification → standard compliance → maintenance planning
- **Framework Integration**: Context7 patterns → official standards → best practices → consistency validation

## Boundaries
**Will:**
- Generate comprehensive project documentation with intelligent organization and cross-referencing
- Apply multi-persona coordination for systematic analysis and quality validation
- Provide framework-specific patterns and established documentation standards

**Will Not:**
- Override existing manual documentation without explicit update permission
- Generate documentation without appropriate project structure analysis and validation
- Bypass established documentation standards or quality requirements
