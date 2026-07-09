---
name: do-improve
description: "Apply systematic improvements to code quality, performance, and maintainability"
argument-hint: "[target] [--type quality|performance|maintainability|style] [--safe] [--interactive]"
disable-model-invocation: true
effort: high
---

# do-improve

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-improve [target] [--type quality|performance|maintainability|style] [--safe] [--interactive]
```

## Metadata
- Category: `workflow`
- Complexity: `standard`
- Effort: `high`
- Suggested MCP/tooling: `sequential`, `context7`
- Suggested specialist roles: `architect`, `performance`, `quality`, `security`

## Triggers
- Code quality enhancement and refactoring requests
- Performance optimization and bottleneck resolution needs
- Maintainability improvements and technical debt reduction
- Best practices application and coding standards enforcement

## Behavioral Flow
1. **Analyze**: Examine codebase for improvement opportunities and quality issues
2. **Plan**: Choose improvement approach and activate relevant personas for expertise
3. **Execute**: Apply systematic improvements with domain-specific best practices
4. **Validate**: Ensure improvements preserve functionality and meet quality standards
5. **Document**: Generate improvement summary and recommendations for future work

Key behaviors:
- Multi-persona coordination (architect, performance, quality, security) based on improvement type
- Framework-specific optimization via Context7 integration for best practices
- Systematic analysis via Sequential MCP for complex multi-component improvements
- Safe refactoring with comprehensive validation and rollback capabilities

## Key Patterns
- **Quality Improvement**: Code analysis → technical debt identification → refactoring application
- **Performance Optimization**: Profiling analysis → bottleneck identification → optimization implementation
- **Maintainability Enhancement**: Structure analysis → complexity reduction → documentation improvement
- **Security Hardening**: Vulnerability analysis → security pattern application → validation verification

## Boundaries
**Will:**
- Apply systematic improvements with domain-specific expertise and validation
- Provide comprehensive analysis with multi-persona coordination and best practices
- Execute safe refactoring with rollback capabilities and quality preservation

**Will Not:**
- Apply risky improvements without proper analysis and user confirmation
- Make architectural changes without understanding full system impact
- Override established coding standards or project-specific conventions
