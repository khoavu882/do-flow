---
name: do
description: "DoFlow universal dispatcher and request router — session announcement, multi-part task decomposition, capability routing, and development estimation"
argument-hint: "[command|request] [--depth shallow|normal|deep] [--estimate] [--tools]"
effort: low
---

# do

Universal command dispatcher, task decomposer, capability router, and development estimator for DoFlow.

## Invocation
```text
/do [command|request] [--depth shallow|normal|deep] [--estimate] [--tools]
```

## Behavioral Flow

1. **Session & Command Dispatch**:
   - If invoked with no arguments or `--help`, announce DoFlow session status and display the core command reference.
   - If `$1` matches a known `/do-*` skill (`do-flow`, `do-brainstorm`, `do-design`, `do-plan`, `do-execute-plan`, `do-test`, `do-code-review`, `do-git`, `do-constitution`, `do-diagnose`, `do-document`), forward to that skill directly.

2. **Multi-Part / Ambiguous Request Routing (`--depth`)**:
   - When a request bundles 2+ unrelated asks across different files or domains, verify referenced files exist first.
   - Classify and decompose into independent or sequenced work packages.
   - For detailed decomposition and dependency graph formatting, consult `references/pm_routing.md`.

3. **Capability & Tool Selection (`--tools`)**:
   - When determining the optimal search, graph, or testing tool for an information need, query the
     Capability Router — run `doflow capabilities` (add `--json` to parse, `--check` for a deep smoke
     check). It reports which provider is actually available on *this* machine; Semble and Graphify
     degrade to Ripgrep when absent, and a static table cannot know that.
   - Consult `references/tool_matrix.md` for the intent→capability map and the two fallback layers.
     Treat the router's output as authoritative when the two disagree.

4. **Scope & Effort Estimation (`--estimate`)**:
   - When asked for sizing, complexity, or timeline estimates, produce confidence-banded ranges anchored against git history and file scope.
   - Consult `references/estimation.md` for sizing breakdowns. Stops after producing the estimate; never begins edits.

## Core Command Reference
| Command | Purpose | Lifecycle Role |
| :--- | :--- | :--- |
| `/do-flow` | Auto-chain spec-driven lifecycle end-to-end | Orchestration |
| `/do-brainstorm` | Interactive requirements discovery (`requirement.md`) | Phase 1 (WHY/WHAT) |
| `/do-design` | Architecture, APIs, and component interfaces (`design.md`) | Phase 2 (HOW System) |
| `/do-plan` | Implementation plan & task checklist (`plan.md`) | Phase 3 (HOW Tasks) |
| `/do-execute-plan` | Execute tasks via specialist subagents with prerequisite gates | Phase 4 (BUILD) |
| `/do-test` | Run builds, test suites, and coverage verification | Phase 5 (VERIFY) |
| `/do-code-review` | Automated code quality, SOLID, and PR review | Phase 6 (AUDIT) |
| `/do-git` | Git branch, commit, and PR lifecycle management | Lifecycle |
| `/do-constitution` | Create or amend two-tier repository governance | Governance |
| `/do-diagnose` | Diagnose bugs, performance, security, and refactoring needs | Diagnostics |
| `/do-document` | Generate guides, API docs, architecture indices, or web research | Knowledge |

## Boundaries
**Will:** Announce session status, route single and multi-part requests, select optimal retrieval tools, and generate scoped estimates.
**Will Not:** Directly perform code edits or modify source files (delegates to specialist skills).
