---
name: do-task
description: "Execute complex tasks with intelligent workflow management and delegation"
argument-hint: "[action] [target] [--strategy systematic|agile|enterprise] [--parallel] [--delegate]"
disable-model-invocation: true
effort: high
---

# do-task

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-task [action] [target] [--strategy systematic|agile|enterprise] [--parallel] [--delegate]
```

## Metadata
- Category: `special`
- Complexity: `advanced`
- Effort: `high`
- Suggested MCP/tooling: `sequential`, `context7`, `playwright`
- Suggested specialist roles: `architect`, `analyzer`, `frontend`, `backend`, `security`, `devops`, `project-manager`

## Triggers
- Complex tasks requiring multi-agent coordination and delegation
- Projects needing structured workflow management and cross-session persistence
- Operations requiring intelligent MCP server routing and domain expertise
- Tasks benefiting from systematic execution and progressive enhancement

## Behavioral Flow
1. **Analyze**: Parse task requirements and determine optimal execution strategy
2. **Delegate**: Route to appropriate MCP servers and activate relevant personas
3. **Coordinate**: Execute tasks with intelligent workflow management and parallel processing
4. **Validate**: Apply quality gates and comprehensive task completion verification
5. **Optimize**: Analyze performance and provide enhancement recommendations

Key behaviors:
- Multi-persona coordination across architect, frontend, backend, security, devops domains
- Intelligent MCP server routing (Sequential, Context7, Playwright)
- Systematic execution with progressive task enhancement and cross-session persistence
- Advanced task delegation with hierarchical breakdown and dependency management

## Key Patterns
- **Task Hierarchy**: Epic-level objectives → Story coordination → Task execution → Subtask granularity
- **Strategy Selection**: Systematic (comprehensive) → Agile (iterative) → Enterprise (governance)
- **Multi-Agent Coordination**: Persona activation → MCP routing → parallel execution → result integration
- **Cross-Session Management**: Task persistence → context continuity → progressive enhancement

## Boundaries
**Will:**
- Execute complex tasks with multi-agent coordination and intelligent delegation
- Provide hierarchical task breakdown with cross-session persistence
- Coordinate multiple MCP servers and personas for optimal task outcomes

**Will Not:**
- Execute simple tasks that don't require advanced orchestration
- Compromise quality standards for speed or convenience
- Operate without proper validation and quality gates

## CRITICAL BOUNDARIES
**USER-INVOKED DISCRETE TASK EXECUTION**

This skill executes specific tasks when explicitly invoked by user.

**Difference from /do-pm**:
- `/do-pm` = session-level orchestration (background monitoring, continuous)
- `/do-task` = user-invoked discrete execution (explicit start/end)

**Behavior**:
- User invokes `/do-task [description]`
- Execute the specific task using multi-agent coordination
- **STOP when task is complete** - do not continue to next tasks without user input

**Completion Criteria**:
- Task objective achieved
- All sub-tasks marked completed in TodoWrite
- Validation passed

**Output**: Task completion report with:
- What was accomplished
- Files modified
- Tests status (if applicable)

**Next Step**: User decides next action. May invoke another `/do-task` or use specific commands.
