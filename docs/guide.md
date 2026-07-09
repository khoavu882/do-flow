# Guide

Practical workflows for Claude Code. Each flow shows the commands in order — copy and adapt to your project.

Claude may auto-load hybrid read-only skills such as `do-analyze`, `do-review`, `do-document`, `do-estimate`, `do-explain`, `do-select-tool`, `do-troubleshoot`, and `parallel-agents` when your request clearly matches. Auto mode is analysis or coordination only. Any file edit, refactor, dependency change, or implementation workflow must pass the auto-loaded `confidence-check` gate first.

This guide is the canonical workflow example source. README links here instead of duplicating the full flows.

## Current Source Map

| Behavior | Source |
|----------|--------|
| Skill invocation, arguments, auto/manual behavior | `core/skills/*/SKILL.md` |
| Agent personas and review roles | `core/agents/*.md` |
| Safety, workflow, and quality rules | `core/rules/*.md`, loaded through `core/CLAUDE.md` |
| Hook behavior and blocked shell patterns | `core/hooks/*.sh`, `core/hooks/blocked-patterns.conf` |
| MCP server usage notes | `core/mcp/*.md`, `core/.mcp.json` |
| Cross-tool install mapping | `bin/mappings.conf` |
| Public reference table | `docs/reference.md` |

When a workflow example conflicts with one of those source files, update the source behavior first, then update this guide.

## Skill Invocation Model

| Mode | How to Use | Examples |
|------|------------|----------|
| Manual command | Type `/skill-name`; used for side effects or explicit orchestration | `/do-implement`, `/do-git`, `/do-execute-plan`, `/do-cleanup` |
| Hybrid read-only | Type `/skill-name` or let Claude auto-load it; auto mode does not edit files | `/do-analyze`, `/do-review`, `/do-document`, `/do-troubleshoot`, `/parallel-agents` |
| Auto-loaded policy | Claude loads it as background guidance; normally not user-invoked | `confidence-check`, `code-conventions`, `java-conventions`, `token-efficiency` |
| Forked research | Runs in an isolated context and returns a summarized result | `/do-research` |

---

## Flow A — Feature from Idea to Commit

Starting from a vague idea and ending at a committed, tested feature.

Primary source skills: `do-brainstorm`, `do-design`, `do-spec`, `do-plan`, `do-tasks`, `do-execute-plan`, `do-analyze`, `do-review`, `do-git`. `confidence-check` auto-loads before implementation-class edits. `do-spec` through `do-review` are the five phases of the doflow chain (`constitution → spec → plan → tasks → implement → review`); `/do-flow` can auto-chain those phases with three approval gates instead of invoking each one manually, as shown below.

```bash
# Session start — git context already injected by SessionStart hook
/do-load  # Restore cross-session memories (run this after any /compact)

# Step 1: Discover and clarify requirements through Socratic dialogue
/do-brainstorm "user authentication with JWT and refresh tokens"

# Step 2: Get specialist input before designing
@agent-security "define security requirements for JWT auth — what could go wrong?"

# Step 3: Design with the requirements in mind
/do-design "feature architecture for JWT auth service" --think-hard --c7

# Step 4: Architecture review
@agent-system-architect "review this design for scalability and maintainability issues"

# Step 5: Record the agreed spec (WHAT/WHY) — folds in the brainstorm/design output above
/do-spec "JWT auth service with refresh token rotation"

# Step 6: Generate the implementation plan (HOW) from the spec
/do-plan --strategy systematic

# Step 7: Decompose the plan into a dependency-ordered task list
/do-tasks

# Step 8: Preview the execution order before changing files
/do-execute-plan --dry-run

# Step 9: Execute one dependency-ready task at a time
# confidence-check auto-loads before implementation-class edits
/do-execute-plan --next --safe

# Step 10: Validate the completed slice before shipping
/do-analyze src/auth --focus security --depth deep
/do-test --type unit --coverage

# Step 11: Review merge readiness — code quality plus spec/task traceability
/do-review --scope changed --format mr

# Step 12: Commit cleanly
/do-git "implement JWT auth with refresh token rotation"
```

---

## Flow A.1 — Resume a Generated Plan

Use this when `/do-plan` and `/do-tasks` already produced `plan.md`/`tasks.md` for the active feature and you want controlled implementation without re-planning.

State source: `/do-execute-plan` treats `agent-docs/specs/<slug>/tasks.md` (and its `state.md`) as the source of truth. It should stop on unclear requirements, failed validation, or dependency conflicts, then report the blocker and next action.

```bash
# Inspect the generated plan and saved execution state
/do-execute-plan --dry-run

# Continue from the next pending task
/do-execute-plan --resume --next --safe

# Run a whole phase only when the dry run shows clear dependencies
/do-execute-plan --phase 2

# Stop for review before committing
/do-review --scope changed --format mr
```

---

## Flow A.2 — One-Prompt PM Orchestration

Use `/do-pm` when you want the project manager layer to drive discovery, planning, execution, validation, and review from one request. This works best when the goal is clear enough to start but broad enough to need coordination.

Routing source: `core/skills/do-pm/SKILL.md` maps workflow execution requests to `/do-execute-plan` and review requests to `/do-review`.

```bash
/do-pm "
Goal: add JWT authentication with refresh token rotation.
Scope: backend auth service, login/logout endpoints, token tests, and docs.
Validation: run unit tests and review changed files before commit.
Deliverable: implemented feature, test results, review findings, and next-session notes.
" --strategy wave --verbose
```

For smaller but still coordinated work, use `--strategy direct`:

```bash
/do-pm "Update API docs for the billing endpoints and verify MkDocs builds" --strategy direct
```

For vague product ideas, start with discovery:

```bash
/do-pm "I want role-based access control, but I am not sure what model fits this app" --strategy brainstorm
```

`/do-pm` should pause when requirements are risky or underspecified. For large work, it may execute in phases and checkpoint progress instead of forcing every step into one uninterrupted pass.

---

## Flow B — Bug Investigation

Primary source skills: `do-troubleshoot`, `confidence-check`, `do-test`, `do-git`. In auto mode, `do-troubleshoot` diagnoses first and must not apply fixes until the user requests edits.

```bash
# Paste the error — root-cause-analyst agent activates automatically
/do-troubleshoot "NullPointerException in UserService.validateToken() — line 147"

# Framework rule: understand WHY before proposing a fix (never disable tests)
# Claude must identify root cause before suggesting anything

# Start fixing only after root cause is explained
# confidence-check auto-loads before code or test edits
/do-troubleshoot --fix

# Verify nothing regressed
/do-test --type unit --coverage

# Commit with an accurate message
/do-git --smart-commit
```

---

## Flow C — Code Quality Sprint

Use this when you want deliberate improvement work rather than review-only findings. `do-analyze` is hybrid and read-only in auto mode; `do-improve` and `do-cleanup` are manual commands because they can edit files.

```bash
# Scan first — understand before changing
/do-analyze src/ --focus quality --scope module

# Deep dive into flagged areas
/do-analyze src/service/ --focus security --think-hard

# Apply safe, automated fixes
/do-improve src/ --type quality --safe

# Iterative refinement with validation gates between cycles
/do-improve src/ --type quality --loop --iterations 3

# Clean up dead code (dry-run first to preview)
/do-cleanup src/ --dry-run
/do-cleanup src/
```

---

## Flow D — Large Codebase Analysis

When a codebase is too large to analyze in one pass, use read-only analysis first. If the domains are independent, use `parallel-agents` to coordinate isolated investigations from the main session. The coordinator must prove the work has no shared root cause, sequential dependency, or overlapping write scope before dispatching agents.

Source skills: `do-analyze` for scoped read-only review and `parallel-agents` for main-session coordination. `parallel-agents` is intentionally not `context: fork`; it coordinates from the active session and dispatches isolated agents only after the independence gate passes.

```bash
# Read-only module analysis
/do-analyze src/auth/ --focus security --think
/do-analyze src/api/ --focus performance --think
/do-analyze src/frontend/ --focus quality --think

# Coordinate independent follow-up investigations
/parallel-agents "
Investigate these independent analysis findings:
1. auth token refresh race in src/auth
2. slow reporting query in src/api/reports
3. dashboard filter state reset in src/frontend
"

# Synthesize findings into a refactoring plan
/do-design "refactoring plan based on analysis findings" --think-hard
```

Use `parallel-agents` for independent read-only investigations or disjoint implementation slices. Do not use it when one fix may resolve multiple failures, when agents would edit the same files, or when full-system reasoning is needed before decomposition.

---

## Flow E — Research Before Implementation

Use this when implementation depends on current framework behavior, tradeoffs, or external documentation. `do-research` keeps the research context isolated; implementation still goes through `confidence-check`.

```bash
# Research runs in a forked context — won't pollute main conversation
/do-research "Spring Boot reactive WebFlux vs MVC — performance tradeoffs at 10K req/s" --depth deep

# Design with the research findings in mind
/do-design "reactive API layer for high-throughput financial transactions"

@agent-backend-architect "review this design for potential bottlenecks and failure modes"

# Implement against official documentation
# confidence-check auto-loads before implementation begins
/do-implement "reactive payment service"
```

---

## Flow F — Documentation Update

Use this for README, API docs, guides, reference pages, and workflow examples.

Source skill: `do-document`. Documentation edits still count as file edits, so the confidence gate should run before changing files. For this repo, run `mkdocs build` after changing `docs/*.md`.

```bash
# Draft or update docs for a specific target
/do-document "Update reference and example workflow docs for hybrid skills"

# Review the docs-only diff
/do-review --scope changed

# Optional: run your documentation build if configured
# mkdocs build
```

`do-document` is hybrid. Claude may auto-load it when you ask for documentation, but auto mode should draft or explain only. Editing documentation files requires an explicit request, and `confidence-check` should run first because it is still a file edit.

---

## Using Agents

Agents are specialist personas invoked via the `Agent` tool. Each has domain-specific knowledge beyond what a generalist provides.

```bash
# Security review with actual OWASP depth
@agent-security "review PaymentService for vulnerabilities"

# Merge request review with language-aware conventions
/do-review --scope changed --format mr

# Financial-services review — java-conventions auto-loads for .java files
/do-review --scope branch --format mr

# Backend architecture decisions
@agent-backend-architect "design the repository pattern for UserService"

# Root cause analysis (automatically activated for error-paste tasks)
@agent-root-cause-analyst "investigate why this query is running for 12 seconds"

# Requirements discovery before implementation
@agent-requirements-analyst "extract functional requirements from this product brief"
```

---

## Using MCP Flags

Add flags to any skill invocation to activate MCP servers:

```bash
# Official library documentation lookup
/do-implement "Redis session store" --c7

# Structured multi-step reasoning for complex design
/do-design "distributed transaction pattern" --seq

# Combined: official docs + structured reasoning
/do-implement "Spring Boot reactive service" --c7 --seq

# All MCP servers (maximum depth — use sparingly)
/do-analyze src/ --all-mcp

# Native tools only — fastest execution
/do-implement "simple utility function" --no-mcp
```

---

## Multi-Tool Workflows

When you use Claude, Copilot/Codex, and Gemini together:

```bash
# Phase 1: Research (Claude — deep reasoning)
/do-research "Redis vs PostgreSQL for session storage at 100K concurrent users"

# Phase 2: Architecture (Gemini — broad context)
# "Using system-architect agent: design session service based on research findings: [paste]"

# Phase 3: Implementation (Claude — execution)
/do-implement "Redis-backed session service with TTL and graceful degradation" --c7

# Phase 4: Code review (Copilot inline — same rules apply)
# "Using code-reviewer agent: review this session service before I commit"

# Phase 5: Commit (Claude — hooks enforce safety)
/do-git "add Redis session service with TTL-based expiry"
```

All three tools apply the same `rules/` and `agents/`. The handoff is consistent.

---

## Keyboard Shortcuts (Claude Code)

| Shortcut | Action |
|----------|--------|
| `ctrl+shift+t` | Toggle todos panel |
| `ctrl+shift+o` | Toggle transcript |
| `ctrl+e` | Open external editor |
| `ctrl+r` | Search command history |
| `ctrl+s` | Stash current input |
| `shift+tab` | Cycle input mode (plan/auto/edit) |
