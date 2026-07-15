# Reference

Complete reference for skills, agents, hooks, behavioral flags, and rules.

---

## Skills

Claude Code skills in DoFlow use three invocation modes:

- **Manual command**: invoked by typing `/skill-name`; used for side effects, commits, implementation execution, and explicit workflow control.
- **Hybrid**: invoked directly or auto-loaded by Claude when the request clearly matches; auto mode is read-only unless the user explicitly asks for edits.
- **Auto-loaded policy**: hidden from the slash menu and loaded by Claude as background guidance.

| Skill | Invocation | Description |
|-------|-----------|-------------|
| `do` | `/do [command] [args...]` | Command dispatcher, session-start announcement, and skill recommendation engine |
| `confidence-check` | Auto-loaded | Mandatory pre-implementation confidence gate before any code edit, refactor, or config change |
| `do-analyze` | `/do-analyze [target] [--focus quality\|security\|performance\|architecture] [--depth shallow\|normal\|deep]` | Code quality, security, performance, and architecture analysis |
| `do-brainstorm` | `/do-brainstorm [topic/idea] [--strategy systematic\|agile\|enterprise]` | Interactive Socratic requirements discovery; seeds `requirement.md` in a branch-coupled feature dir |
| `do-build` | `/do-build [target] [--type dev\|prod\|test] [--clean] [--optimize]` | Compile and package project artifacts |
| `do-cleanup` | `/do-cleanup [target] [--type code\|imports\|files\|all] [--safe\|--aggressive]` | Remove dead code and clutter |
| `do-code-review` | `/do-code-review` | Automated code-quality review across 13 languages — SOLID violations, code smells, security/performance findings |
| `do-constitution` | `/do-constitution [principle inputs] [--amend]` | Create or amend the per-repo (tier-2) constitution overlaying the base; bumps semver, writes a Sync Impact Report |
| `do-design` | `/do-design [target] [--type architecture\|api\|component\|database]` | Architecture, API, and component design (HOW at the system-shape level); writes `design.md` |
| `do-document` | `/do-document [target] [--type inline\|external\|api\|guide]` | Generate documentation |
| `do-estimate` | `/do-estimate [target] [--type time\|effort\|complexity]` | Task and feature estimation |
| `do-execute-plan` | `/do-execute-plan [--next\|--phase N\|--all\|--resume\|--dry-run\|--contracts] [--safe]` | Execute `plan.md`'s embedded task checklist via pm-agent orchestration over named specialists, gated by the implement-phase prerequisite hook |
| `do-explain` | `/do-explain [target] [--level basic\|intermediate\|advanced]` | Deep code and system behavior explanation |
| `do-flow` | `/do-flow [feature description] [--from brainstorm\|design\|plan\|implement\|test\|review]` | Auto-chain the doflow spec-driven flow (brainstorm→design→plan→implement→test→review), pausing only at defined approval gates |
| `do-git` | `/do-git [operation] [args] [--smart-commit]` | Smart git operations with conventional commit messages |
| `do-help` | `/do-help` | Command reference and skill discovery |
| `do-implement` | `/do-implement [feature-description] [--type component\|api\|service\|feature]` | Execute implementation with agent delegation |
| `do-improve` | `/do-improve [target] [--type quality\|performance\|maintainability\|style]` | Apply systematic improvements |
| `do-index` | `/do-index [target] [--type docs\|api\|structure\|readme]` | Generate project knowledge base |
| `do-plan` | `/do-plan [--strategy systematic\|agile] [--depth normal\|deep] [--parallel]` | Generate the implementation plan (HOW) and task checklist from `requirement.md` + `design.md`, with a Constitution Check gate |
| `do-pm` | `/do-pm [request] [--strategy brainstorm\|direct\|wave]` | Project management orchestration and PDCA cycle |
| `do-reflect` | `/do-reflect [--type task\|session\|completion]` | Task reflection and quality assessment |
| `do-research` | `/do-research "[query]" [--depth quick\|standard\|deep\|exhaustive]` | Deep web research in an isolated forked context (`deep-research-agent`) |
| `do-select-tool` | `/do-select-tool [operation] [--analyze] [--explain]` | Optimal MCP vs native tool selection |
| `do-spawn` | `/do-spawn [complex-task] [--strategy sequential\|parallel\|adaptive]` | Delegate complex tasks to sub-agents |
| `do-spec-panel` | `/do-spec-panel [specification_content\|@file] [--mode discussion\|critique\|socratic]` | Specification quality review panel |
| `do-task` | `/do-task [action] [target] [--strategy systematic\|agile\|enterprise]` | Multi-agent task coordination |
| `do-test` | `/do-test [target] [--type unit\|integration\|e2e\|all]` | Run tests with coverage analysis |
| `do-troubleshoot` | `/do-troubleshoot [issue] [--type bug\|build\|performance\|deployment]` | Diagnose build and runtime failures |
| `parallel-agents` | `/parallel-agents [tasks]` or Auto-loaded | Coordinate concurrent agents for independent tasks with disjoint context or write scope |
| `token-efficiency` | Auto-loaded | Compressed output when context usage is high or `--uc` is requested |

### Invocation Modes

| Mode | Skills | Contract |
|------|--------|----------|
| Manual command | `do`, `do-brainstorm`, `do-build`, `do-cleanup`, `do-constitution`, `do-design`, `do-execute-plan`, `do-git`, `do-help`, `do-implement`, `do-improve`, `do-index`, `do-pm`, `do-plan`, `do-reflect`, `do-spawn`, `do-spec-panel`, `do-task`, `do-test` | Human chooses timing with `/skill-name` (`disable-model-invocation: true`). Use for side-effectful workflows, implementation, cleanup, commits, build actions, planning, and explicit orchestration. |
| Hybrid read-only | `do-analyze`, `do-code-review`, `do-document`, `do-estimate`, `do-explain`, `do-flow`, `do-select-tool`, `do-troubleshoot`, `parallel-agents` | Claude may auto-load for matching requests (`disable-model-invocation: false`). Auto mode analyzes, drafts, verifies, recommends, or coordinates only. File edits require explicit user request and `confidence-check` first; `do-flow` additionally stops at its own approval gates before implementation or commit. |
| Auto-loaded policy | `confidence-check`, `token-efficiency` | Background guidance only (`user-invocable: false`). Users normally do not invoke these directly. |
| Forked research | `do-research` | Runs isolated research (`context: fork`, `agent: deep-research-agent`) when invoked or selected for a matching research task. |

### Doflow Chain (spec-driven delivery)

`do-brainstorm` → `do-design` → `do-plan` → `do-execute-plan` → `do-code-review` form the normal feature delivery path (merged into core; no longer a separate opt-in extension). `do-constitution` sets repo-level rules but is invoked standalone, outside the numbered chain. `do-flow` auto-chains the chain phases in sequence, pausing only at its three approval gates (unresolved requirement clarifications, before implementation, before commit/merge):

```bash
# Discover and record the feature requirement (WHAT/WHY) — seeds requirement.md in a branch-coupled feature dir
/do-brainstorm "feature description"

# Design the system shape (architecture, APIs, data model) — writes design.md
/do-design

# Generate the implementation plan (HOW) + dependency-ordered task checklist from requirement.md + design.md, with a Constitution Check gate
/do-plan --strategy systematic

# Execute plan.md's task checklist via pm-agent orchestration, gated by the implement-phase prerequisite hook
/do-execute-plan --next --safe

# Review the resulting diff for code quality before commit or merge
/do-code-review

# Or auto-chain the whole flow end to end
/do-flow "feature description"
```

`do-execute-plan` is gated by `pre-implement-gate.sh`, which blocks source edits until `requirement.md`, `design.md`, and `plan.md` all exist. `do-code-review` is review-only and reports code-quality findings (SOLID violations, code smells, security/async/resource issues) across 13 languages before summaries.

Hybrid read-only skills such as `do-analyze`, `do-document`, `do-estimate`, `do-explain`, `do-code-review`, `do-select-tool`, and `do-troubleshoot` can be invoked directly or auto-loaded by Claude when the request clearly matches. In auto mode, they analyze, draft, verify, or recommend only; implementation edits require an explicit user request and the `confidence-check` gate first.

`parallel-agents` coordinates from the main context. It may dispatch isolated agents only after proving the tasks are independent, have no sequential dependency, and do not share write scope.

`confidence-check` is mandatory before implementation-class work:

- Creating or editing source files
- Refactoring existing code
- Fixing bugs through code or test changes
- Adding, removing, or upgrading dependencies
- Changing runtime configuration or architecture
- Executing generated implementation workflows

It should not block pure explanation, read-only review, estimation, brainstorming, or requirements discovery.

### PM Orchestration

`do-pm` is the project manager layer for broad or multi-step requests. It can coordinate discovery, planning, implementation, validation, review, and session notes from a single prompt:

```bash
/do-pm "
Goal: modernize the dashboard filters.
Scope: UI controls, query-state handling, tests, and browser verification.
Validation: run frontend tests and verify the dashboard in Playwright.
Deliverable: working implementation, validation output, review notes, and follow-up actions.
" --strategy wave --verbose
```

Strategy guide:

| Strategy | Use When |
|----------|----------|
| `brainstorm` | The goal is vague and requirements need discovery before implementation |
| `direct` | The task is clear and small enough for a focused pass |
| `wave` | The task spans multiple phases, domains, or validation gates |

`do-pm` routes plan-execution requests to `/do-execute-plan` and review requests to `/do-code-review`. Use `/do-task` instead when you already have one bounded task with a clear start and stop.

---

## Agents

| Agent | Specialization |
|-------|---------------|
| `backend-architect` | Backend systems, APIs, data integrity |
| `deep-research-agent` | Comprehensive multi-source research |
| `devops-architect` | Infrastructure, CI/CD, reliability |
| `frontend-architect` | UI/UX, accessibility, frontend performance |
| `performance-engineer` | Bottleneck identification and optimization |
| `pm-agent` | PDCA self-improvement workflow execution |
| `python-expert` | Python best practices and modern patterns |
| `quality-engineer` | Testing strategy and systematic edge case detection |
| `refactoring-expert` | Code quality improvement and technical debt |
| `requirements-analyst` | Requirements discovery and specification |
| `root-cause-analyst` | Systematic problem investigation |
| `security-engineer` | Vulnerability assessment, OWASP, threat modeling |
| `system-architect` | Scalable system design and architecture |
| `technical-writer` | Documentation for technical and non-technical audiences |

Invoke by describing the task naturally — Claude selects the appropriate agent. For explicit routing: `@agent-security "..."` or use the `Agent` tool directly.

---

## Hooks

| Hook | Event | Action |
|------|-------|--------|
| `session-start.sh` | `SessionStart` | Captures git branch, SHA, last 5 commits to `sessions/{id}/git-context.json` |
| `user-prompt-submit.sh` | `UserPromptSubmit` | Injects git context on first prompt only via `additionalContext` |
| `pre-bash-guard.sh` | `PreToolUse(Bash)` | Blocks dangerous patterns; reads `blocked-patterns.conf` |
| `mcp-tool-guard.sh` | `PreToolUse(mcp__*)` | Blocks MCP tool calls matching `mcp-policy.conf`; ships with zero active patterns |
| `pre-implement-gate.sh` | `PreToolUse(Edit\|Write\|MultiEdit)` | Doflow chain's hard gate — blocks source edits until `requirement.md`, `design.md`, and `plan.md` all exist |
| `post-edit-lint.sh` | `PostToolUse(Edit\|Write)` | Collects edited file paths to `edited-files.txt` |
| `stop-check.sh` | `Stop` | Batch lint dispatch; blocks if last assistant response has TODO/stub |
| `pre-compact.sh` | `PreCompact` | Outputs git state as `custom_instructions` for the compaction LLM |
| `post-compact.sh` | `PostCompact` | Saves AI-generated compact summary to `projects/{cwd_hash}/last-compact-summary.md` |
| `session-end.sh` | `SessionEnd` | Logs END, writes uncommitted-warning, deletes session dir, trims log |
| `subagent-audit.sh` | `SubagentStart` / `SubagentStop` | Pure observability — logs which specialist agents actually run; no deny path |
| `skill-config-audit.sh` | `ConfigChange` | Pure observability — logs skill-file mutations regardless of which tool made them; no deny path |

**Blocked operations** (always denied, no override):
```
git push --force        (git push --force-with-lease is allowed)
git reset --hard
git clean -fd
rm -rf /  rm -rf ~/  rm -rf $HOME
DROP TABLE / DROP DATABASE / DROP SCHEMA
DELETE FROM <table> ;   (no WHERE clause)
TRUNCATE TABLE
curl <url> | bash  /  wget <url> | bash
```

**State directories** (in `~/.config/doflow/session-env/`):
```
sessions/{session_id}/     — private per Claude Code window
  git-context.json         — branch, sha, commits, uncommitted count
  injected                 — flag: additionalContext already sent this session
  edited-files.txt         — paths collected by post-edit-lint.sh

projects/{cwd_hash}/       — shared per project directory, across all agents
  last-compact-summary.md  — AI-generated summary from last /compact
  uncommitted-warning.txt  — written if session ended with dirty tree
  meta.json                — last_agent, last_active, compacted_at, branch
```

Override base path: `XDG_CONFIG_HOME=/custom/path` (defaults to `~/.config`).
Override agent identity: `DOFLOW_AGENT=codex` (defaults to `claude-code`).

---

## MCP Servers

| Server | Flag | Purpose |
|--------|------|---------|
| Context7 | `--c7` / `--context7` | Library documentation lookup for any framework/SDK |
| Sequential Thinking | `--seq` / `--sequential` | Structured multi-step reasoning and hypothesis testing |
| Chrome DevTools | `--chrome` / `--devtools` | Browser inspection, Lighthouse performance, network analysis |
| Playwright | `--play` / `--playwright` | Browser automation, E2E scenarios, accessibility testing |

Composite flags:
- `--all-mcp` → all 4 servers
- `--no-mcp` → disable all, native tools only

---

## Behavioral Flags

### Analysis Depth

| Flag | Token Budget | MCPs Enabled |
|------|-------------|-------------|
| `--think` | ~4K | Sequential |
| `--think-hard` | ~10K | Sequential + Context7 |
| `--ultrathink` | ~32K | All installed |

### Execution Control

| Flag | Description |
|------|-------------|
| `--delegate [auto]` | Sub-agent parallel processing (auto-triggers at >7 dirs or >50 files) |
| `--concurrency [n]` | Max concurrent operations (1–15) |
| `--loop` | Iterative improvement cycles with validation gates |
| `--iterations [n]` | Number of improvement cycles (1–10) |
| `--safe-mode` | Maximum validation, conservative execution |
| `--validate` | Pre-execution risk assessment |
| `--uc` / `--ultracompressed` | 30–50% output compression via symbol system |

### Common Combinations

```bash
# Standard analysis
/do-analyze src/ --focus quality --think

# Deep security audit
/do-analyze src/ --focus security --think-hard --verbose

# Implement against official documentation
/do-implement "feature" --c7 --seq

# Token-efficient large codebase scan
/do-analyze large-codebase/ --uc --delegate

# Iterative improvement
/do-improve src/ --type quality --loop --iterations 3

# Planned implementation with review gate
/do-brainstorm "feature description"
/do-design
/do-plan --strategy systematic
/do-execute-plan --next --safe
/do-code-review

# Parallel investigation when failures are independent
/parallel-agents "three unrelated failing test files: auth refresh, billing export, dashboard filter state"
```

---

## Rules

Four rule files loaded into every session via `CLAUDE.md`:

**RULE_01_SAFETY — Critical** (never compromise)
- Root cause analysis always — understand WHY before fixing
- Never skip or disable tests to pass builds
- `git status && git branch` before starting; feature branches for all work
- Force-push to main is never allowed

**RULE_02_WORKFLOW — Important**
- Parallel by default — batch independent operations; never read-one-by-one then edit-one-by-one
- Start it = Finish it — no TODO stubs, no "not implemented" throws
- Validate before execution, verify after; run lint/typecheck before marking complete
- Build ONLY what's asked — no bonus features, no enterprise bloat

**RULE_03_QUALITY — Recommended**
- Follow language naming standards (camelCase JS, snake_case Python)
- No marketing language — no "blazingly fast", no invented metrics
- Push back on bad approaches; evidence-based claims only
- Tests in `tests/`, scripts in `scripts/`, reports in `agent-docs/`

**RULE_04_QUESTIONS — Important**
- Ask only for genuine user-owned decisions; when you have enough to act, act
- Clarifications use structured multiple-choice (Claude Code: `AskUserQuestion`; Codex/Gemini: question file)
- 2–4 meaningful mutually-exclusive options + mandatory "Other"; no filler options
- Validate answers for contradictions/ambiguity before proceeding

**Conflict resolution priority:** Safety > Scope > Quality > Speed
