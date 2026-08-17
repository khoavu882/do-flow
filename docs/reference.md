# DoFlow Skills Reference

## Quick Skill Reference

| Topic | Skills |
|---|---|
| Development cycles | `/do-flow "topic"`, `/do-brainstorm "topic"` |
| Design & architecture | `/do-design "feature"`, `/do-constitution` |
| Planning & implementation | `/do-plan`, `/do-execute-plan` |
| Testing & code review | `/do-test --type all`, `/do-code-review` |
| Analysis & diagnostics | `/do-diagnose path --type bug\|perf\|security\|refactor` |
| Documentation & research | `/do-document path --type api\|guide\|impl\|index\|research` |

## Full Skill Reference

Arguments below mirror each skill's `argument-hint`; `test/guards/reachability.test.js` asserts they
stay in sync, so a flag documented here always exists.

| Skill | Description |
|---|---|
| `/do [command\|request] [--depth shallow\|normal\|deep] [--estimate] [--tools]` | Universal dispatcher, intent routing, tool capability selection, and estimation |
| `/do-flow [feature description] [--from brainstorm\|design\|plan\|implement\|test\|review]` | Full-cycle development: brainstorm → design → plan → execute → test → code-review |
| `/do-brainstorm [topic/idea] [--strategy systematic\|agile\|enterprise] [--depth shallow\|normal\|deep]` | Discover requirements through Socratic dialogue; seeds requirement.md in a branch-coupled feature dir |
| `/do-design [target] [--type architecture\|api\|component\|database] [--format diagram\|spec\|code]` | Design system architecture, APIs, and component interfaces; writes design.md |
| `/do-plan [--strategy systematic\|agile\|enterprise] [--depth normal\|deep]` | Generate implementation plan and dependency-ordered task checklist; writes plan.md |
| `/do-execute-plan [--next\|--phase N\|--all\|--resume\|--contracts] [--sync] [--review\|--no-review]` | Execute plan.md task checklist with specialist subagents and readiness gates |
| `/do-test [target] [--type unit\|integration\|e2e\|build\|all] [--coverage] [--watch] [--clean]` | Execute project builds, automated test suites, and coverage verification |
| `/do-code-review [target]` | Code review automation: analyze complexity, risk, SOLID compliance, and code smells |
| `/do-implement [description of the change] [--from-review]` | Direct, standalone implementation from a description or `/do-code-review` findings — no chain artifacts required |
| `/do-git [intent] [args...] [--confirm]` | Cycle-aware git operations via named intents: start, save, sync, ship, release, hotfix, backport, status |
| `/do-constitution [principle inputs] [--amend]` | Create or amend the per-repo tier-2 constitution overlay and sync impact reports |
| `/do-diagnose [target\|issue] [--type bug\|perf\|security\|refactor] [--focus quality\|security\|performance\|architecture] [--iterations n] [--validate] [--trace] [--fix]` | Unified diagnostics, root-cause investigation, and targeted code remediation |
| `/do-document [target\|query] [--type api\|guide\|impl\|index\|research] [--depth shallow\|normal\|deep]` | Unified technical documentation, architecture indexing, and deep web research |

## Runtime & Diagnostics Commands

These are `doflow` CLI commands, not slash-command skills. Installation and lifecycle commands
(`install`, `update`, `status`, `rollback`, `remove`) are documented in [Setup](setup.md).

| Command | Description |
|---|---|
| `doflow doctor [--json]` | System health check: harness adapters, external tools, and a smoke check of every runtime capability's provider |
| `doflow capabilities [--json] [--check]` | Which provider currently backs each abstract capability on this machine. `--check` runs a deep smoke check instead of a presence check |
| `doflow readiness --task-class <class> --task-id <id> [--json]` | Evaluate a task's readiness contract. Classes: `bug`, `feature`, `refactor`, `trivial-edit`, `dependency-change` |
| `doflow evidence --task-id <id> [--json]` | Show evidence items recorded for a task |

`readiness` and `evidence` read per-project state under the invoking repo's `.doflow/state/`; run
them from the project the task belongs to, or pass `-g` for the global scope. `capabilities` and
`doctor` report on the machine and are scope-independent.

## Git Lifecycle Intents

The `/do-git` skill provides cycle-aware commands:

- **start** - Begin a new task on the appropriate branch type
- **save** - Stage and commit with intelligent message from diff
- **sync** - Sync local branches with remote state
- **ship** - Ship current feature to integration branch
- **release** - Full release ritual: cut branch, bump version, merge to production, create tag
- **hotfix** - Create and propagate hotfix across all live lines
- **backport** - Cherry-pick a commit to another branch
- **status** - Report repository state and lifecycle position

Raw git operations still work via passthrough: `/do-git status`, `/do-git log --oneline`, etc.

## Full Skill List

The full installed skill set is: `do`, `do-brainstorm`, `do-code-review`, `do-constitution`, `do-design`, `do-diagnose`, `do-document`, `do-execute-plan`, `do-flow`, `do-git`, `do-implement`, `do-plan`, and `do-test`.

## Specialist Agent Archetypes

Specialist agent archetypes provide dedicated perspectives for planning, execution, and validation. Their definitions live in `core/shared/agent-specs/`:

| Archetype | Responsibilities | Default Mode |
|---|---|---|
| `spec-analyst` | Requirements elicitation, user story breakdown, effort estimation | Read-only |
| `system-architect` | System architecture, boundary design, API contracts, infrastructure | Read-only |
| `core-implementer` | Polyglot implementation, clean refactoring, algorithmic speedup | Workspace-write |
| `quality-guardian` | Automated test suites, security vulnerability auditing, root-cause diagnosis | Read-only |
| `research-writer` | Multi-hop cited web research, architecture indexing, technical documentation | Read-only |
