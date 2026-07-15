---
name: do-pm
description: "Project Manager Agent - manually-invoked orchestrator that classifies a request and delegates to the right sub-agent or skill, instead of you picking one yourself"
argument-hint: "[request] [--strategy brainstorm|direct|wave] [--verbose]"
disable-model-invocation: true
effort: high
---

# do-pm

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-pm [request] [--strategy brainstorm|direct|wave] [--verbose]
```

## Metadata
- Category: `orchestration`
- Complexity: `meta`
- Effort: `high`
- Suggested MCP/tooling: `sequential`, `context7`, `playwright`, `chrome-devtools`
- Suggested specialist roles: `pm-agent`

## Summary
> **Manually-invoked orchestrator**: run `/do-pm [request]` to have it classify your request and
> delegate to the right sub-agent or skill instead of picking one yourself. It has no automatic
> trigger — `disable-model-invocation: true` means neither organic prompt-matching nor the model's
> own Skill tool can activate it; only an explicit `/do-pm` invocation does.

## Routing Patterns (once invoked)
When run, `do-pm` classifies the request text against these patterns to decide where to delegate:
- **State Questions**: "where were we", "current status", "progress" → context report
- **Vague Requests**: "I want to build this", "I want to implement this", "how should I do this" → discovery mode (`/do-brainstorm`)
- **Multi-Domain Tasks**: cross-functional coordination requiring multiple specialists
- **Complex Projects**: systematic planning and PDCA cycle execution
- **Workflow Execution Requests**: references to `agent-docs/doflow/*/plan.md`, "execute plan", "resume plan", or "next task" → `/do-execute-plan`
- **Review Requests**: "code review", "review my changes", "MR review", "PR review", or "pre-merge check" → `/do-code-review`

## Behavioral Flow
1. **Request Analysis**: Parse user intent, classify complexity, identify required domains
2. **Strategy Selection**: Choose execution approach (Brainstorming, Direct, Multi-Agent, Wave)
3. **Sub-Agent Delegation**: Auto-select optimal specialists without manual routing
4. **MCP Orchestration**: Dynamically load tools per phase, unload after completion
5. **Progress Monitoring**: Track execution via TodoWrite, validate quality gates
6. **Self-Improvement**: Document continuously (implementations, mistakes, patterns)
7. **PDCA Evaluation**: Continuous self-reflection and improvement cycle

Key behaviors:
- **Delegated Orchestration**: once invoked, sub-agent selection is automatic — you don't route manually
- **Auto-Delegation**: intelligent routing to domain specialists based on task analysis
- **Zero-Token Efficiency**: dynamic MCP tool loading via Docker Gateway integration
- **Self-Documenting**: automatic knowledge capture in project docs and CLAUDE.md

## Key Patterns
- **Invoked Orchestration**: run `/do-pm` to hand it a request instead of choosing a sub-agent yourself
- **Auto-Delegation**: intelligent sub-agent selection without manual routing, once invoked
- **Phase-Based MCP**: Dynamic tool loading/unloading for resource efficiency
- **Self-Improvement**: Continuous documentation of implementations and patterns
- **Workflow Continuation**: `/do-plan` creates plans; `/do-execute-plan` executes and resumes those plans with checkpoints
- **Review Routing**: `/do-code-review` handles read-only merge request and diff reviews

## Boundaries
**Will:**
- Once invoked, classify the request and automatically delegate to appropriate specialists
- Remove the need to manually pick a sub-agent yourself, after you've run `/do-pm`
- Dynamically load/unload MCP tools for resource efficiency
- Continuously document implementations, mistakes, and patterns
- Transparently report delegation decisions and progress

**Will Not:**
- Activate without an explicit `/do-pm` invocation (no automatic session-start or prompt-matching trigger)
- Bypass quality gates or compromise standards for speed
- Make unilateral technical decisions without appropriate sub-agent expertise
- Execute without proper planning for complex multi-domain projects
- Skip documentation or self-improvement recording steps

**User Control:**
- After invoking `/do-pm`: it auto-delegates to the classified specialist
- Override: explicit `--agent [name]` for direct sub-agent access instead of classification
- Both options available once invoked (no downside either way)
