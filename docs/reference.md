# DoFlow Skills Reference

## Quick Skill Reference

| Topic | Skills |
|---|---|
| Development cycles | `/do-flow "topic"`, `/do-brainstorm "topic"` |
| Design & architecture | `/do-design "feature"`, `/do-constitution` |
| Planning & implementation | `/do-plan`, `/do-execute-plan` |
| Testing & code review | `/do-test`, `/do-code-review` |
| Analysis & diagnostics | `/do-diagnose path --focus quality\|security\|performance\|architecture` |
| Documentation & research | `/do-document path --type api\|guide\|impl\|index\|research` |

## Full Skill Reference

Arguments below mirror each skill's `argument-hint`; `test/guards/reachability.test.js` asserts they
stay in sync, so a flag documented here always exists.

| Skill | Description |
|---|---|
| `/do [command\|request] [--depth shallow\|normal\|deep] [--estimate]` | Universal dispatcher, intent routing, tool capability selection, and estimation |
| `/do-flow [feature description] [--from brainstorm\|design\|plan\|implement\|test\|review]` | Full-cycle development: brainstorm → design → plan → execute → test → code-review |
| `/do-brainstorm [topic/idea] [--depth shallow\|normal\|deep]` | Discover requirements through Socratic dialogue; seeds requirement.md in a branch-coupled feature dir |
| `/do-design [target] [--type architecture\|api\|component\|database]` | Design system architecture, APIs, and component interfaces; writes design.md |
| `/do-plan [--depth shallow\|normal\|deep]` | Generate implementation plan and dependency-ordered task checklist; writes plan.md |
| `/do-execute-plan [--scope next\|phase:N\|all\|resume] [--review[=false]] [--scaffold]` | Execute plan.md task checklist with specialist subagents and readiness gates |
| `/do-test [target] [--clean] [--watch]` | Execute project builds, automated test suites, and coverage verification |
| `/do-code-review [target]` | Code review automation: analyze complexity, risk, SOLID compliance, and code smells |
| `/do-implement [description of the change] [--from-review]` | Direct, standalone implementation from a description or `/do-code-review` findings — no chain artifacts required |
| `/do-git [intent] [args...] [--confirm]` | Cycle-aware git operations via named intents: start, save, sync, ship, release, hotfix, backport, status |
| `/do-constitution [principle inputs] [--amend]` | Create or amend the per-repo tier-2 constitution overlay and sync impact reports |
| `/do-diagnose [target\|issue] [--focus quality\|security\|performance\|architecture] [--fix]` | Unified diagnostics, root-cause investigation, and targeted code remediation |
| `/do-document [target\|query] [--type api\|guide\|impl\|index\|research] [--depth shallow\|normal\|deep]` | Unified technical documentation, architecture indexing, and deep web research |

## Runtime & Diagnostics Commands

These are `doflow` CLI commands, not slash-command skills. Installation and lifecycle commands
(`install`, `update`, `status`, `rollback`, `remove`) are documented in [Setup](setup.md).

| Command | Description |
|---|---|
| `doflow doctor [--json]` | Health check: harness adapters, capability providers, index freshness, and the project's detected build and test commands. Health means a provider **answered a probe**, not that its binary is on `PATH` — an installed provider that cannot answer reports `UNHEALTHY`, and one that declares no probe reports `UNVERIFIED`. Exits 1 when a provider is installed but does not answer |
| `doflow capabilities [--json] [--check]` | Which provider currently backs each abstract capability on this machine. `--check` runs a deep smoke check instead of a presence check |
| `doflow readiness --task-class <class> --task-id <id> [--verification-plan <text>] [--scope <text>] [--invariants <text>] [--user-decision-pending] [--json]` | Evaluate a task's readiness contract. Classes: `bug`, `feature`, `refactor`, `trivial-edit`, `dependency-change`. Returns one of four states — `READY`, `NEEDS_EVIDENCE`, `NEEDS_USER_DECISION`, `BLOCKED` — never a number. The four trailing flags are inputs the **caller states** rather than evidence the gate measured, so they are reported straight back as `callerAsserted` (JSON) and `Caller-stated:` (text), and a requirement satisfied that way links no evidence |
| `doflow evidence --task-id <id> [--action list\|add] [--kind <k>] [--provenance extracted\|inferred\|asserted] [--provider <p>] [--capability <c>] [--locator <file[:line]\|uri>] [--content <text>] [--batch <file>] [--json]` | List a task's recorded evidence, or record it with `--action add`: one item from the flags, or a whole stage batch from `--batch` (a JSON array, or an object whose only key is `evidence`; `--batch=-` reads stdin — the `=` spelling is required, since a bare `-` reads as the next flag). Per item `kind`, `provenance` and `source` (`--provider` + `--capability`) are required and none is defaulted; `extracted` additionally requires a locator, `inferred` and `asserted` require content, and `generated-analysis`/`user-statement` may never be `extracted`. Freshness is measured at the write — HEAD commit and file hash — never accepted from the caller. A batch is validated whole, so one rejected item writes nothing. `--confidence`, `--score`, `--relevance` and every other score-shaped flag are refused by name: relevance is a property of a search, not of a fact |
| `doflow trace [--days N] [--json]` | Trajectory of the current or most recent workflow, read from the run ledger |
| `doflow stats [--days N] [--json]` | Aggregate local run-ledger usage: runs per verb, failures, duration percentiles |
| `doflow discover [--days N] [--json]` | Missed capability opportunities in recorded runs. Exits 1 when there is a finding; an analysis it cannot settle from the recorded metadata reports `UNKNOWN` rather than "clear" |
| `doflow classify --task-class <id> [--calling-skill <skill-id>] [--rationale <text>] [--proposed-by <who>] [--json]` | Validate a proposed task class against the workflow registry and return its workflow. A class the registry does not declare is **rejected** with the valid set and a suggestion — never coerced to `feature`. With `--calling-skill`, it also checks that the class's workflow has a stage the caller can occupy, and rejects it when it does not; without it, fit is reported as `NOT_EVALUATED` rather than assumed. Exits 1 on a rejection, 2 when no class was proposed |
| `doflow workflow --task-class <id> [--json]` | Resolve a class to its ordered stages, their gates, which stages mutate source, and which readiness templates gate them. Exits 2 on an unknown class |
| `doflow route --intent <id> [--query <text>] [--check] [--json]` | Resolve an information need to a provider that is healthy on this machine, with the concrete command or MCP tool to run. Exits 1 when no provider can answer |
| `doflow claim --task-id <id> [--action list\|add\|link] [--statement <text>] [--claim-id <id>] [--evidence-id <id>] [--relation supports\|contradicts] [--json]` | Record a proposition, link evidence to it, or list what is recorded. A new claim starts as a `hypothesis` and can only become `supported` through linked evidence — there is deliberately no way to assert one supported. Linking an evidence id the ledger does not hold is refused (exit 2) rather than graded, so record the evidence first |
| `doflow context-pack --task-id <id> [--task-class <c>] [--objective <text>] [--json]` | Compile a task's recorded evidence and claims into the context block a stage is handed. Exits 1 on an empty pack: nothing recorded is not the same as nothing needed |
| `doflow retrieval-plan --task-id <id> [--action declare\|report] [--need <intent>[,<intent>]…] [--stage <stage-id>] [--json]` | `--action declare` records the information needs a stage intends to resolve and the provider the capability router resolves each to, **before** retrieval runs; a need no provider can answer is recorded as declared-unresolvable, never dropped. The default `--action report` emits every declared item as `RETRIEVED`, `EMPTY`, `UNREACHED` or `UNVERIFIED` — `EMPTY` means the provider answered with nothing, `UNREACHED` means it was never asked, `UNVERIFIED` means it answered but its index could not be located, so the answer carries no weight. On report, `--need` names the intents the caller states were actually asked; a declared need nothing recorded and nobody names is `UNREACHED` rather than being upgraded to a negative finding. Exits 1 when any declared item is `UNREACHED` or `UNVERIFIED`. Each distinct provider's index freshness is probed **once per plan** at declare time and cached under `providers{}`, never once per need; a need stores only the provider id, so two needs cannot disagree about one index. Freshness qualifies an answer and never routes one: `UNKNOWN` turns an empty answer into `UNVERIFIED`, `STALE` leaves it `EMPTY` with a staleness marker and the provider's rebuild command, and `FRESH`/`NOT_APPLICABLE` leave it `EMPTY` |
| `doflow verify --task-id <id> [--action contract\|report] [--risk <level>] [--json]` | `--action contract` compiles the verification contract before implementation (FR-009); the default runs it and reports. Exits 1 on `FAIL` **and** on `INCONCLUSIVE` — a verdict over zero evidence is not a pass |
| `doflow recover --error <message> [--failed-check <name>]… [--iteration N] [--agent <name>] [--json]` | Classify a verification failure into one of eleven classes and return the targeted action for it. Exits 0 when a bounded retry is available, 1 when the loop must stop |
| `doflow scaffold [--slug <name>] [--json]` | Emit the reviewable code scaffold the active feature's `requirement.md`, `design.md` and `plan.md` imply, under that feature's own `scaffold/` directory. Signatures, types and stubs only — never a write into the source tree. Exits 1 when the scaffold is incomplete or blocked, so a partial result is never reported as success. This is what `/do-execute-plan --scaffold` runs |

`readiness`, `evidence`, `claim`, `context-pack` and `retrieval-plan` read per-project state under the invoking
repo's `.doflow/state/`; run them from the project the task belongs to, or pass `-g` for the global
scope. `capabilities` reports on the machine and is scope-independent; `doctor` reports on both, so
index freshness and command detection follow the same project scope.

`--task-id` and `--task-class` are **required**, not defaulted. Readiness, evidence, claims and a
context pack all belong to one named task under one named contract; substituting `default` or
`feature` for an argument the caller omitted produces a confident verdict about a task or a
contract nobody asked about, which is exactly the failure mode the runtime is being corrected for.
Every refusal names the valid set.

An evidence `--kind` is one of ten: `exact-search`, `semantic-retrieval`, `structural`,
`historical`, `documentation`, `test-result`, `runtime-observation`, `user-statement`, `diff`,
`generated-analysis`. An unknown one is refused with all ten named. The ledger mints the record's
`id` and measures its `freshness`, so neither is accepted from the caller, and `supports` /
`contradicts` belong to `claim --action link`, which updates both sides of the relationship rather
than leaving a claim unaware of the evidence pointing at it.

Every command in this table is also a verb on the runtime seam — `doflow-run <verb>` — which is how
skills reach them. The two spellings run the same implementation; the seam additionally records a
metadata line in the run ledger.

`trace`, `stats` and `discover` read the run ledger at `<config>/state/runs/YYYY-MM-DD.jsonl`,
which `doflow-run` appends to once per dispatched verb. They locate it the way the dispatcher does
— nearest `.doflow` walking up from the working directory, or the global one — so they work from a
subdirectory. Records are metadata only: a verb, a capability, a provider, an exit code, a
duration, counts and byte volumes. No argument value, command output or file content is recorded.
An empty ledger is a normal state and is reported as "no conclusion can be drawn", never as a
clean bill of health.

`scaffold` resolves which feature is active the same way every chain skill does — from the working
directory, branch-derived in a git repo — so run it from the project root. Where a non-git root
holds more than one feature directory it cannot choose: it exits 2 naming every candidate, and
`--slug <name>` re-runs against the one you pick.

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
