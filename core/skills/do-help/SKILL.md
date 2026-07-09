---
name: do-help
description: "List all available DoFlow skills and their functionality"
disable-model-invocation: true
effort: low
---

# do-help

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-help
```

## Metadata
- Category: `utility`
- Complexity: `low`
- Effort: `low`

## Triggers
- Command discovery and reference lookup requests
- Framework exploration and capability understanding needs
- Documentation requests for available DoFlow skills

## Behavioral Flow
1. **Display**: Present complete skill list with descriptions
2. **Complete**: End interaction after displaying information

Key behaviors:
- Information display only - no execution or implementation
- Reference documentation mode without action triggers

Here is a complete list of all available DoFlow (`/do-*`) skills.

| Skill | Description |
|---|---|
| `/do` | DoFlow command dispatcher, session announcement, and skill recommendation |
| `/do-analyze` | Comprehensive code analysis across quality, security, performance, and architecture domains |
| `/do-brainstorm` | Interactive requirements discovery through Socratic dialogue and systematic exploration |
| `/do-build` | Build, compile, and package projects with intelligent error handling and optimization |
| `/do-cleanup` | Systematically clean up code, remove dead code, and optimize project structure |
| `confidence-check` | Mandatory pre-implementation confidence gate before any code edit, refactor, or config change |
| `/do-constitution` | Create or amend the per-repo constitution, overlaying the base; versions it and propagates a pointer into the agent context file |
| `/do-design` | Design system architecture, APIs, and component interfaces with comprehensive specifications |
| `/do-document` | Generate focused documentation for components, functions, APIs, and features |
| `/do-estimate` | Provide development estimates for tasks, features, or projects with intelligent analysis |
| `/do-execute-plan` | Execute tasks.md via pm-agent orchestration over named specialists, with the implement-phase prerequisite gate |
| `/do-explain` | Provide clear explanations of code, concepts, and system behavior with educational clarity |
| `/do-flow` | Auto-chain the doflow spec-driven flow (constitution→spec→plan→tasks→implement→review), pausing only at defined approval gates |
| `/do-git` | Git operations with intelligent commit messages and workflow optimization |
| `/do-help` | List all available DoFlow skills and their functionality |
| `/do-implement` | Feature and code implementation with intelligent persona activation and MCP integration |
| `/do-improve` | Apply systematic improvements to code quality, performance, and maintainability |
| `/do-index` | Generate comprehensive project documentation and knowledge base with intelligent organization |
| `/do-load` | Session lifecycle management with native project memory loading (compact summary, agent-docs, MEMORY.md) |
| `/do-pm` | Project manager orchestration for routing and coordinating complex workflows |
| `/do-plan` | Generate the implementation plan (HOW) from spec.md, with a Constitution Check gate |
| `/do-reflect` | Task reflection and validation using native self-review |
| `/do-research` | Deep web research with adaptive planning and evidence-based reporting |
| `/do-review` | Review the implemented change against spec.md and tasks.md — code quality plus spec/task traceability |
| `/do-save` | Session lifecycle management with native file-based session context persistence |
| `/do-select-tool` | Intelligent MCP tool selection based on complexity scoring and operation analysis |
| `/do-spawn` | Meta-system task orchestration with intelligent breakdown and delegation |
| `/do-spec` | Create a feature specification (WHAT/WHY); seeds spec.md in a branch-coupled feature dir |
| `/do-spec-panel` | Multi-expert specification review and improvement using renowned specification and software engineering experts |
| `/do-task` | Execute complex tasks with intelligent workflow management and delegation |
| `/do-tasks` | Generate a dependency-ordered tasks.md with [P] parallel and [US#] traceability markers from plan.md |
| `/do-test` | Execute tests with coverage analysis and automated quality reporting |
| `/do-troubleshoot` | Diagnose and resolve issues in code, builds, deployments, and system behavior |
| `token-efficiency` | Activate compressed, symbol-based communication when context usage is high or brevity is requested |
| `code-conventions` | Language-aware coding convention router for Java, Python, JavaScript, and TypeScript |
| `java-conventions` | Java coding conventions and naming standards for enterprise financial services projects |
| `parallel-agents` | Fan out 2+ independent tasks/files/investigations concurrently without shared state or overlapping write scope |

## Boundaries
**Will:**
- Display comprehensive list of available DoFlow skills
- Provide clear descriptions of each skill's functionality
- Present information in readable tabular format
- Show all available DoFlow framework flags and their usage
- Provide flag usage examples and priority rules

**Will Not:**
- Execute any commands or create any files
- Activate implementation modes or start projects
- Engage TodoWrite or any execution tools

---

**Note:** This list is manually generated and may become outdated. If you suspect it is inaccurate, please consider regenerating it or contacting a maintainer.
