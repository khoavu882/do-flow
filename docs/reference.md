# DoFlow Skills Reference

## Quick Command Reference

| Topic | Commands |
|---|---|
| Development cycles | `/do-flow "topic"`, `/do-brainstorm "topic"` |
| Design & architecture | `/do-design "feature"`, `/do-constitution` |
| Planning & implementation | `/do-plan`, `/do-execute-plan`, `/do-implement "task"` |
| Testing & code review | `/do-test --type all`, `/do-code-review` |
| Analysis & improvements | `/do-analyze path --focus quality`, `/do-improve path --type quality` |

## Full Command Reference

| Skill | Description |
|---|---|
| `/do-flow "topic"` | Full-cycle development: brainstorm → design → plan → execute → test → code-review |
| `/do-brainstorm "topic" [--strategy systematic|agile|enterprise] [--depth shallow|normal|deep]` | Discover requirements through Socratic dialogue; seeds requirement.md in a branch-coupled feature dir |
| `/do-git [intent] [args...] [--confirm]` | Cycle-aware git operations via named intents: start, save, sync, ship, release, hotfix, backport, status |
| `/do-test --type all` | Run the project's test suite |

## Git Lifecycle Intents

The `/do-git` skill now provides cycle-aware commands:

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

The full installed skill set is: `confidence-check`, `do`, `do-analyze`, `do-brainstorm`, `do-build`, `do-code-review`, `do-constitution`, `do-design`, `do-document`, `do-estimate`, `do-execute-plan`, `do-explain`, `do-flow`, `do-git`, `do-help`, `do-implement`, `do-improve`, `do-index`, `do-plan`, `do-pm`, `do-reflect`, `do-research`, `do-select-tool`, `do-spec-panel`, `do-test`, `do-troubleshoot`, `parallel-agents`, and `subagent-driven`.

## Agents

Agents are specialist perspectives used by planning and review workflows. Their definitions live in `core/shared/agent-specs/`.

| Area | Typical perspectives |
|---|---|
| Architecture | system, infrastructure, frontend, backend, security |
| Analysis | quality, performance, security, cost |
