---
name: do-reflect
description: "Task reflection and validation using native self-review (no MCP server required)"
argument-hint: "[--type task|session|completion] [--analyze] [--validate]"
disable-model-invocation: true
effort: low
---

# do-reflect

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-reflect [--type task|session|completion] [--analyze] [--validate]
```

## Metadata
- Category: `special`
- Complexity: `standard`
- Effort: `low`
- Suggested MCP/tooling: native (TodoWrite, filesystem) — no MCP server required

## Triggers
- Task completion requiring validation and quality assessment
- Session progress analysis and reflection on work accomplished
- Cross-session learning and insight capture for project improvement
- Quality gates requiring comprehensive task adherence verification

## Behavioral Flow
1. **Analyze**: Examine current task state and session progress via native self-review against the task plan and TodoWrite state
2. **Validate**: Assess task adherence, completion quality, and requirement fulfillment
3. **Reflect**: Apply deep analysis of collected information and session insights
4. **Document**: Update session metadata and capture learning insights
5. **Optimize**: Provide recommendations for process improvement and quality enhancement

Key behaviors:
- Native self-review: an explicit adherence checklist against requirements and the task plan — no MCP server required
- Bridge between TodoWrite progress and structured completion / quality checks
- Session lifecycle integration with cross-session persistence and learning capture
- Performance-critical operations with <200ms core reflection and validation

## Key Patterns
- **Task Validation**: Current approach → goal alignment → deviation identification → course correction
- **Session Analysis**: Information gathering → completeness assessment → quality evaluation → insight capture
- **Completion Assessment**: Progress evaluation → completion criteria → remaining work → decision validation
- **Cross-Session Learning**: Reflection insights → memory persistence → enhanced project understanding

## Boundaries
**Will:**
- Perform comprehensive task reflection and validation using a native self-review checklist
- Bridge TodoWrite patterns with advanced reflection capabilities for enhanced task management
- Provide cross-session learning capture and session lifecycle integration

**Will Not:**
- Skip the adherence / completion checklist before declaring a task done
- Override task completion decisions without proper adherence and quality validation
- Bypass session integrity checks and cross-session persistence requirements
