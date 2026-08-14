# DoFlow Skills Reference

## Quick Command Reference

| Topic | Commands |
|---|---|
| Development cycles | `/do-flow "topic"`, `/do-brainstorm "topic"` |
| Design & architecture | `/do-design "feature"`, `/do-constitution` |
| Planning & implementation | `/do-plan`, `/do-execute-plan` |
| Testing & code review | `/do-test --type all`, `/do-code-review` |
| Analysis & diagnostics | `/do-diagnose path --type bug|perf|security|refactor` |
| Documentation & research | `/do-document path --type api|guide|impl|index|research` |

## Full Command Reference

| Skill | Description |
|---|---|
| `/do-flow "topic"` | Full-cycle development: brainstorm → design → plan → execute → test → code-review |
| `/do-brainstorm "topic" [--strategy systematic|agile|enterprise] [--depth shallow|normal|deep]` | Discover requirements through Socratic dialogue; seeds requirement.md in a branch-coupled feature dir |
| `/do-git [intent] [args...] [--confirm]` | Cycle-aware git operations via named intents: start, save, sync, ship, release, hotfix, backport, status |
| `/do-test --type all` | Run the project's build and test suite |
| `/do-diagnose [target] [--type bug|perf|security|refactor]` | Unified diagnostics, root-cause investigation, and code remediation |
| `/do-document [target] [--type api|guide|impl|index|research]` | Unified technical documentation, architecture indexing, and web research |

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

The full installed skill set is: `do`, `do-brainstorm`, `do-code-review`, `do-constitution`, `do-design`, `do-diagnose`, `do-document`, `do-execute-plan`, `do-flow`, `do-git`, `do-plan`, and `do-test`.

## Agents

Agents are specialist perspectives used by planning and review workflows. Their definitions live in `core/shared/agent-specs/`.

| Area | Typical perspectives |
|---|---|
| Architecture | system, infrastructure, frontend, backend, security |
| Analysis | quality, performance, security, cost |
