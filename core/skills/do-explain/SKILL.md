---
name: do-explain
description: "Provide clear explanations of code, concepts, and system behavior with educational clarity"
when_to_use: Trigger automatically for read-only explanations of code, architecture, system behavior, errors, APIs, framework concepts, or project workflows. Do not edit files in auto mode.
argument-hint: "[target] [--level basic|intermediate|advanced] [--format text|examples|interactive] [--context domain]"
disable-model-invocation: false
user-invocable: true
effort: medium
---

# do-explain

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-explain [target] [--level basic|intermediate|advanced] [--format text|examples|interactive] [--context domain]
```

## Metadata
- Category: `workflow`
- Complexity: `standard`
- Effort: `medium`
- Suggested MCP/tooling: `sequential`, `context7`
- Suggested specialist roles: `educator`, `architect`, `security`

## Triggers
- Code understanding and documentation requests for complex functionality
- System behavior explanation needs for architectural components
- Educational content generation for knowledge transfer
- Framework-specific concept clarification requirements

## Behavioral Flow
1. **Analyze**: Examine target code, concept, or system for comprehensive understanding
2. **Assess**: Determine audience level and appropriate explanation depth and format
3. **Structure**: Plan explanation sequence with progressive complexity and logical flow
4. **Generate**: Create clear explanations with examples, diagrams, and interactive elements
5. **Validate**: Verify explanation accuracy and educational effectiveness

Key behaviors:
- Multi-persona coordination for domain expertise (educator, architect, security)
- Framework-specific explanations via Context7 integration
- Systematic analysis via Sequential MCP for complex concept breakdown
- Adaptive explanation depth based on audience and complexity

## Key Patterns
- **Progressive Learning**: Basic concepts → intermediate details → advanced implementation
- **Framework Integration**: Context7 documentation → accurate official patterns and practices
- **Multi-Domain Analysis**: Technical accuracy + educational clarity + security awareness
- **Interactive Explanation**: Static content → examples → interactive exploration

## Boundaries
**Will:**
- Provide clear, comprehensive explanations with educational clarity
- Auto-activate relevant personas for domain expertise and accurate analysis
- Generate framework-specific explanations with official documentation integration

**Will Not:**
- Generate explanations without thorough analysis and accuracy verification
- Override project-specific documentation standards or reveal sensitive details
- Bypass established explanation validation or educational quality requirements
