---
name: do-brainstorm
description: "Interactive requirements discovery through Socratic dialogue and systematic exploration"
argument-hint: "[topic/idea] [--strategy systematic|agile|enterprise] [--depth shallow|normal|deep] [--parallel]"
disable-model-invocation: true
effort: medium
---

# do-brainstorm

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-brainstorm [topic/idea] [--strategy systematic|agile|enterprise] [--depth shallow|normal|deep] [--parallel]
```

## Metadata
- Category: `orchestration`
- Complexity: `advanced`
- Effort: `medium`
- Suggested MCP/tooling: `sequential`, `context7`, `playwright`
- Suggested specialist roles: `architect`, `analyzer`, `frontend`, `backend`, `security`, `devops`, `project-manager`

## Summary
> **Context Framework Note**: This file provides behavioral instructions for Claude Code when users type `/do-brainstorm` patterns. This is NOT an executable command - it's a context trigger that activates the behavioral patterns defined below.

## Triggers
- Ambiguous project ideas requiring structured exploration
- Requirements discovery and specification development needs
- Concept validation and feasibility assessment requests
- Cross-session brainstorming and iterative refinement scenarios

## Behavioral Flow
1. **Explore**: Transform ambiguous ideas through Socratic dialogue and systematic questioning
2. **Analyze**: Coordinate multiple personas for domain expertise and comprehensive analysis
3. **Validate**: Apply feasibility assessment and requirement validation across domains
4. **Specify**: Generate concrete specifications with cross-session persistence capabilities
5. **Handoff**: Create actionable briefs ready for implementation or further development

Key behaviors:
- Multi-persona orchestration across architecture, analysis, frontend, backend, security domains
- Advanced MCP coordination with intelligent routing for specialized analysis
- Systematic execution with progressive dialogue enhancement and parallel exploration
- Cross-session persistence with comprehensive requirements discovery documentation

## Key Patterns
- **Socratic Dialogue**: Question-driven exploration → systematic requirements discovery
- **Multi-Domain Analysis**: Cross-functional expertise → comprehensive feasibility assessment
- **Progressive Coordination**: Systematic exploration → iterative refinement and validation
- **Specification Generation**: Concrete requirements → actionable implementation briefs

## Boundaries
**Will:**
- Transform ambiguous ideas into concrete specifications through systematic exploration
- Coordinate multiple personas and MCP servers for comprehensive analysis
- Provide cross-session persistence and progressive dialogue enhancement

**Will Not:**
- Make implementation decisions without proper requirements discovery
- Override user vision with prescriptive solutions during exploration phase
- Bypass systematic exploration for complex multi-domain projects

## CRITICAL BOUNDARIES
**STOP AFTER REQUIREMENTS DISCOVERY**

This skill produces a REQUIREMENTS SPECIFICATION ONLY.

**Explicitly Will NOT**:
- Create architecture diagrams or system designs (use `/do-design`)
- Generate implementation code (use `/do-implement`)
- Make architectural decisions
- Design database schemas or API contracts
- Create technical specifications beyond requirements

**Output**: Requirements document with:
- Clarified user goals
- Functional requirements
- Non-functional requirements
- User stories / acceptance criteria
- Open questions for user

**Next Step**: After brainstorm completes, use `/do-design` for architecture or `/do-plan` for implementation planning.
