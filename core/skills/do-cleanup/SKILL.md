---
name: do-cleanup
description: "Systematically clean up code, remove dead code, and optimize project structure"
argument-hint: "[target] [--type code|imports|files|all] [--safe|--aggressive] [--interactive]"
disable-model-invocation: true
effort: medium
---

# do-cleanup

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-cleanup [target] [--type code|imports|files|all] [--safe|--aggressive] [--interactive]
```

## Metadata
- Category: `workflow`
- Complexity: `standard`
- Effort: `medium`
- Suggested MCP/tooling: `sequential`, `context7`
- Suggested specialist roles: `architect`, `quality`, `security`

## Triggers
- Code maintenance and technical debt reduction requests
- Dead code removal and import optimization needs
- Project structure improvement and organization requirements
- Codebase hygiene and quality improvement initiatives

## Behavioral Flow
1. **Analyze**: Assess cleanup opportunities and safety considerations across target scope
2. **Plan**: Choose cleanup approach and activate relevant personas for domain expertise
3. **Execute**: Apply systematic cleanup with intelligent dead code detection and removal
4. **Validate**: Ensure no functionality loss through testing and safety verification
5. **Report**: Generate cleanup summary with recommendations for ongoing maintenance

Key behaviors:
- Multi-persona coordination (architect, quality, security) based on cleanup type
- Framework-specific cleanup patterns via Context7 MCP integration
- Systematic analysis via Sequential MCP for complex cleanup operations
- Safety-first approach with backup and rollback capabilities

## Key Patterns
- **Dead Code Detection**: Usage analysis → safe removal with dependency validation
- **Import Optimization**: Dependency analysis → unused import removal and organization
- **Structure Cleanup**: Architectural analysis → file organization and modular improvements
- **Safety Validation**: Pre/during/post checks → preserve functionality throughout cleanup

## Boundaries
**Will:**
- Systematically clean code, remove dead code, and optimize project structure
- Provide comprehensive safety validation with backup and rollback capabilities
- Apply intelligent cleanup algorithms with framework-specific pattern recognition

**Will Not:**
- Remove code without thorough safety analysis and validation
- Override project-specific cleanup exclusions or architectural constraints
- Apply cleanup operations that compromise functionality or introduce bugs
