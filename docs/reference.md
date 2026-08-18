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
| `/do-execute-plan [--next\|--phase N\|--all\|--resume\|--scaffold] [--sync] [--review\|--no-review]` | Execute plan.md task checklist with specialist subagents and readiness gates |
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
| `doflow doctor [--json]` | Health check: harness adapters, capability providers, index freshness, and the project's detected build and test commands. Health means a provider **answered a probe**, not that its binary is on `PATH` — an installed provider that cannot answer reports `UNHEALTHY`, and one that declares no probe reports `UNVERIFIED`. Exits 1 when a provider is installed but does not answer |
| `doflow capabilities [--json] [--check]` | Which provider currently backs each abstract capability on this machine. `--check` runs a deep smoke check instead of a presence check |
| `doflow readiness --task-class <class> --task-id <id> [--json]` | Evaluate a task's readiness contract. Classes: `bug`, `feature`, `refactor`, `trivial-edit`, `dependency-change` |
| `doflow evidence --task-id <id> [--json]` | Show evidence items recorded for a task |
| `doflow trace [--days N] [--json]` | Trajectory of the current or most recent workflow, read from the run ledger |
| `doflow stats [--days N] [--json]` | Aggregate local run-ledger usage: runs per verb, failures, duration percentiles |
| `doflow discover [--days N] [--json]` | Missed capability opportunities in recorded runs. Exits 1 when there is a finding; an analysis it cannot settle from the recorded metadata reports `UNKNOWN` rather than "clear" |

`readiness` and `evidence` read per-project state under the invoking repo's `.doflow/state/`; run
them from the project the task belongs to, or pass `-g` for the global scope. `capabilities`
reports on the machine and is scope-independent; `doctor` reports on both, so index freshness and
command detection follow the same project scope.

`trace`, `stats` and `discover` read the run ledger at `<config>/state/runs/YYYY-MM-DD.jsonl`,
which `doflow-run` appends to once per dispatched verb. They locate it the way the dispatcher does
— nearest `.doflow` walking up from the working directory, or the global one — so they work from a
subdirectory. Records are metadata only: a verb, a capability, a provider, an exit code, a
duration, counts and byte volumes. No argument value, command output or file content is recorded.
An empty ledger is a normal state and is reported as "no conclusion can be drawn", never as a
clean bill of health.

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
