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
| `/do-execute-plan [--scope next\|phase:N\|all\|resume] [--review] [--scaffold]` | Execute plan.md task checklist with specialist subagents and readiness gates |
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
| `doflow doctor [--json]` | Health check: harness adapters, capability providers, index freshness, and the project's detected build and test commands. Health means a provider **answered a probe**, not that its binary is on `PATH` — an installed provider that cannot answer reports `UNHEALTHY`, and one that declares no probe reports `UNVERIFIED`. Its `[Runtime Reach]` section lists, per installed harness and scope, whether the skills' resolver finds a dispatcher and runtime (`REACHED`, `NO-REACH` with the install command that fixes it, or `N/A`; in `--json`, `harnesses[].reach[]`). Reach is a static check of the installed files: it does not consider the other ways the dispatcher finds the CLI (`DOFLOW_CLI`, a `node_modules` install, a `doflow` on `PATH`). The adapter line of the text output reads `adapter PASS`; the JSON gains additive fields only. Exits 1 when a provider is installed but does not answer, or a harness has `NO-REACH` |
| `doflow capabilities [--json] [--check]` | Which provider currently backs each abstract capability on this machine. `--check` runs a deep smoke check instead of a presence check |
| `doflow readiness --task-class <class> --task-id <id> [--slug <name>] [--verification-plan <text>] [--scope <text>] [--invariants <text>] [--user-decision-pending] [--json]` | Evaluate a task's readiness contract. Classes: `bug`, `feature`, `refactor`, `trivial-edit`, `dependency-change`. Returns one of four states — `READY`, `NEEDS_EVIDENCE`, `NEEDS_USER_DECISION`, `BLOCKED` — never a number. The four trailing flags are inputs the **caller states** rather than evidence the gate measured, so they are reported straight back as `callerAsserted` (JSON) and `Caller-stated:` (text), and a requirement satisfied that way links no evidence. Every call records its evaluation, whatever its state, as the task's latest record under `.doflow/state/readiness/` (in a `<slug>/` subdirectory under the same rule as evidence, described below) and prints `Recorded:` with the path; `--json` adds `record` and `declaredScope`. A `--scope` that is a comma-separated list of repository-relative paths is also kept as the task's declared scope, which `verify` bounds a change by (`Declared scope:`); any other wording stays a statement. A previous record that cannot be read is moved to `<record>.unreadable` and a `Replaced:` line says so; a record written by a newer DoFlow is never replaced. The call exits 1 when it could not record the evaluation |
| `doflow evidence --task-id <id> [--slug <name>] [--action list\|add] [--kind <k>] [--provenance extracted\|inferred\|asserted] [--provider <p>] [--capability <c>] [--locator <file[:line]\|uri>] [--content <text>] [--batch <file>] [--json]` | List a task's recorded evidence, or record it with `--action add`: one item from the flags, or a whole stage batch from `--batch` (a JSON array, or an object whose only key is `evidence`; `--batch=-` reads stdin — the `=` spelling is required, since a bare `-` reads as the next flag). Per item `kind`, `provenance` and `source` (`--provider` + `--capability`) are required and none is defaulted; `extracted` additionally requires a locator, `inferred` and `asserted` require content, and `generated-analysis`/`user-statement` may never be `extracted`. Freshness is measured at the write — HEAD commit and file hash — never accepted from the caller. A batch is validated whole, so one rejected item writes nothing. `--confidence`, `--score`, `--relevance` and every other score-shaped flag are refused by name: relevance is a property of a search, not of a fact |
| `doflow-run render-diagrams [--slug=<slug>] [--artifact=<path>] [--format=png|svg] [--json]` (`render-diagrams.sh`) | Render a chain artifact's fenced Mermaid blocks to image files, styled by the shipped theme. A **faithful** render: same nodes, same edges, same labels, and the committed Markdown is never modified. Output lands in `<feature dir>/design/diagrams/` and is excluded from version control by an ignore rule the verb writes on first run. Requires `@mermaid-js/mermaid-cli` on `PATH`, an optional dependency DoFlow never installs: when it is absent the verb reports how to obtain it and exits 0, because it sits outside the chain and must never make a missing optional capability read as a broken run. Runs only when a user invokes it, never as part of a stage, which is why no skill names it and `test/guards/verb-reachability.test.js` allowlists the verb |
| `doflow trace [--days N] [--json]` | Trajectory of the current or most recent workflow, read from the run ledger |
| `doflow stats [--days N] [--json]` | Aggregate local run-ledger usage: runs per verb, failures, duration percentiles |
| `doflow indicators [--json]` | Per-stage and per-gate timings from the orchestration record, grouped by task class |
| `doflow discover [--days N] [--json]` | Missed capability opportunities in recorded runs. Exits 1 when there is a finding; an analysis it cannot settle from the recorded metadata reports `UNKNOWN` rather than "clear" |
| `doflow inventory [path] [-t <list>] [--json]` | Read-only cross-scope inventory: reads the global and the project ledger in **one** invocation and reports, per logical asset, every scope holding a copy, that copy's currency (`matches`, `diverged`, or `indeterminable` — the third means this scope holds no basis for judging the copy at all, whether because no fingerprint is recorded for it, because the scope's plan would remove it rather than rewrite it, because no plan was produced for that harness, or because the recorded row names no harness or no ownership identity — the two components the plan lookup is keyed by, so no planned change could ever be found for it; each copy states which, and none of the four is a weaker `diverged`), the precedence verdict naming the scope whose copy the harness loads, and any unmanaged file sharing a directory the harness loads wholesale. The verdict is derived from the harness's recorded order **and** resolution mode together (`core/registry/harnesses.json`), never from either alone, and is **withheld with its reason** where the mode is unestablished rather than defaulted to a guess. It states its own repair coverage: only a divergence is reachable by `doflow reconcile`, and a shadow, a withheld verdict, a copy nothing judged and an unmanaged file are each reported as having no remedy from it. A scope with nothing recorded is reported as holding nothing — the ordinary state of a repository never installed into — and is never an error. Takes no scope flag: reading both scopes is the whole point, so `-g` is refused rather than silently narrowing the answer. Exits 1 when there is any finding, including a withheld verdict or a copy this scope holds no basis for judging, because the caller cannot conclude the install is sound from either; 2 only when the registry, a ledger or a named harness cannot be resolved. Writes, moves and deletes nothing — the remedy on each entry is text to run, and the verb never runs it |
| `doflow classify --task-class <id> [--calling-skill <skill-id>] [--rationale <text>] [--proposed-by <who>] [--json]` | Validate a proposed task class against the workflow registry and return its workflow. A class the registry does not declare is **rejected** with the valid set and a suggestion — never coerced to `feature`. With `--calling-skill`, it also checks that the class's workflow has a stage the caller can occupy, and rejects it when it does not; without it, fit is reported as `NOT_EVALUATED` rather than assumed. Exits 1 on a rejection, 2 when no class was proposed |
| `doflow workflow --task-class <id> [--json]` | Resolve a class to its ordered stages, their gates, which stages mutate source, and which readiness templates gate them. Exits 2 on an unknown class |
| `doflow orchestrate --action start\|status\|catch-up\|handoff\|complete-stage\|skip-stage\|decide-gate\|annotate --task-id <id> [--task-class <c>] [--stage <id>[,<id>…]] [--gate <id>] [--node <id>] [--decision approve\|reject] [--note <text>] [--reason <text>] [--forced] [--verification-plan <text>] [--scope <text>] [--invariants <text>] [--json]` | Deterministic run-state machine over a class's stage list. `start` compiles the program; `catch-up` positions the run toward one or more comma-separated candidate stage ids, backfilling non-mutating stages/gates it walks past (marked `backfilled: true`) and refusing a candidate id the run's own compiled program doesn't contain (the class's workflow, when no run exists yet); each completed or skipped (optional-only) stage advances a persisted cursor under `.doflow/state/orchestration/`; gates pause the run (`AWAITING_GATE`) until approved or rejected, never auto-approved regardless of kind; `annotate` appends a history entry without touching cursor/state, for a stage re-run after its own handoff; `handoff` and `complete-stage` of a source-mutating gated stage (the `implementation` stage of `feature`, `bug`, `refactor`, `dependency-change` and `trivial-edit`) need a READY readiness record of the stage's template, made by `readiness` before the call (a `--task-class` that differs from the run's own is refused). Without one the call refuses before changing anything, names the `readiness` command that clears the refusal and says which harnesses also check at edit time; nothing is evaluated by the call, so `--verification-plan`, `--scope` and `--invariants` are not read and a note says so. The record and the run are looked for in this checkout, else in exactly one other checkout of the repository for the same feature, and a run found there is updated where it is. `--forced` requires `--note` and is refused on any action but `decide-gate`/`annotate`. Every transition is journaled — runs survive process death. Transition refusals exit 1 naming the expected node |
| `doflow research-request --task-id <feature-id> [--slug <name>] [--action open\|list\|resolve] [--stage-id <stage-id>] [--question <text>] [--reason user-request\|detected-gap] [--blocking true\|false] [--request-id <id>] [--outcome answered\|unresolved] [--claim-id <id>] [--evidence-id <id>] [--gap <text>] [--json]` | Stage-scoped external research on an existing feature run. `open` requires the current stage, a question and reason (detected gaps block by default); `list` is the default; `resolve` requires an open request and either a supported same-task claim with linked extracted external evidence for `answered`, or an explicit gap for `unresolved`. A blocking open/unresolved request refuses completion of its stage without moving the workflow cursor; research never approves a gate. Web and Context7 retrieval remain in the harness, not this runtime. |
| `doflow retrieve --query <text> [-k N] [--json]` | BM25 search over the installed guidance tree: `$DOFLOW_CONFIG_DIR/guidance/` when that is set, else the nearest `.doflow/guidance/` in the working directory or a directory above it, else `~/.doflow/guidance/` (a project `.doflow/` with no `guidance/` is skipped). It is served from an auto-refreshing content-addressed index under `index/guidance/` beside the chosen tree — only files whose sha256 changed since the last build are re-chunked. Returns ranked path, section title, score, and a snippet; `-k` caps results (default 5, max 25). Lexical-only by design until a dense provider is declared in models.json: an absent embedding provider degrades to lexical, never to a silent half-answer. Exits 1 when no guidance tree is installed |
| `doflow model-role --role <id> [--exclude <id,id>…] [--json]` | Resolve an abstract model role (`core/registry/models.json`: `triage`, `reasoning`, `review`) to ranked provider candidates. Ordering: installed backend first, then preferred-tier match (`tiers` on the provider), then fallback tier; `--exclude` drops ids entirely (e.g. the implementer when resolving `review`, whose policy requires a different family). Availability means the provider's CLI answered to a PATH lookup — unknown stays `?`, never guessed. Advisory only: DoFlow invokes no models; binding stays with each harness's native selection |
| `doflow route --intent <id> [--query <text>] [--check] [--json]` | Resolve an information need to a provider that is healthy on this machine, with the concrete command or MCP tool to run. Exits 1 when no provider can answer |
| `doflow claim --task-id <id> [--slug <name>] [--action list\|add\|link\|retract\|supersede] [--statement <text>] [--claim-id <id>] [--evidence-id <id>] [--replaced-by <id>] [--relation supports\|contradicts] [--json]` | Record a proposition, link evidence to it, retire it, or list what is recorded. A new claim starts as a `hypothesis` and can only become `supported` through linked evidence — there is deliberately no way to assert one supported. Linking an evidence id the ledger does not hold is refused (exit 2) rather than graded, so record the evidence first. `--action retract` and `--action supersede` move a claim to a terminal state so an obsolete conclusion stops blocking the readiness gate without anyone hand-editing state JSON. Nothing is deleted: the statement and its evidence links survive, and a terminal claim is never re-derived from its evidence on a later read. `supersede` requires `--replaced-by` to name a claim the store already holds, because a forward pointer to nothing is worse than no pointer |
| `doflow context-pack --task-id <id> [--slug <name>] [--task-class <c>] [--objective <text>] [--json]` | Compile a task's recorded evidence and claims into the context block a stage is handed. Exits 1 on an empty pack: nothing recorded is not the same as nothing needed |
| `doflow retrieval-plan --task-id <id> [--slug <name>] [--action declare\|report] [--need <intent>[,<intent>]…] [--stage <stage-id>] [--json]` | `--action declare` records the information needs a stage intends to resolve and the provider the capability router resolves each to, **before** retrieval runs; a need no provider can answer is recorded as declared-unresolvable, never dropped. The default `--action report` emits every declared item as `RETRIEVED`, `EMPTY`, `UNREACHED` or `UNVERIFIED` — `EMPTY` means the provider answered with nothing, `UNREACHED` means it was never asked, `UNVERIFIED` means it answered but its index could not be located, so the answer carries no weight. On report, `--need` names the intents the caller states were actually asked; a declared need nothing recorded and nobody names is `UNREACHED` rather than being upgraded to a negative finding. Exits 1 when any declared item is `UNREACHED` or `UNVERIFIED`. Each distinct provider's index freshness is probed **once per plan** at declare time and cached under `providers{}`, never once per need; a need stores only the provider id, so two needs cannot disagree about one index. Freshness qualifies an answer and never routes one: `UNKNOWN` turns an empty answer into `UNVERIFIED`, `STALE` leaves it `EMPTY` with a staleness marker and the provider's rebuild command, and `FRESH`/`NOT_APPLICABLE` leave it `EMPTY` |
| `doflow outcome --task-id <id> [--slug <name>] [--action record\|show] [--state COMPLETED\|BLOCKED\|ABANDONED\|INCONCLUSIVE] [--task-class <c>] [--stage <stage-id>] [--readiness <state>] [--verification <verdict>] [--json]` | `--action record` writes the task's terminal state from a closed four-state vocabulary — `COMPLETED`, `BLOCKED`, `ABANDONED`, `INCONCLUSIVE` — together with the basis it rests on; a state outside that set is refused with the valid one. `INCONCLUSIVE` carries verification's meaning: a verdict over zero evidence is not a pass, so `COMPLETED` is refused when the task's evidence ledger holds no records. `--task-class` is required on a write because the workflow's **terminal stage** is what records an outcome, and that stage is read from the workflow engine rather than decided here; a `--stage` that is not the terminal one is refused, naming the one that is. This verb never re-evaluates readiness and never re-runs verification: `--readiness` and `--verification` are the verdicts the run states it saw, validated against `readiness`'s and `verify`'s own vocabularies and reported back under `statedByCaller`; omit either and the basis records `NOT_RECORDED`, which is never read as a pass. `basis.evidenceCount` is a count of records and never a score, `basis.unreached[]` carries the declared needs the retrieval plan reports as `UNREACHED` plus verification's own gap, and `recordedAt` is stamped by the runtime and never accepted from the caller. The default `--action show` emits the recorded outcome and exits 1 only when none exists — a recorded `BLOCKED` exits 0, since "no outcome was recorded" and "the outcome was not a completion" are different answers |
| `doflow verify --task-id <id> [--slug <name>] [--action contract\|report] [--risk <level>] [--plan-path <path>] [--scope <path>[,<path>…]] [--json]` | `--action contract` compiles the verification contract before implementation; the default runs it and reports. Exits 1 on `FAIL` **and** on `INCONCLUSIVE` — a verdict over zero evidence is not a pass. `--plan-path` points at a feature's `plan.md` whose `doflow-verification` block overrides manifest detection, which is what lets a specs-and-scripts repository with no `package.json`, `go.mod` or `pom.xml` declare its own build and test commands instead of leaving every tier unresolved. For a feature with a decision register, the change-scope tier is bounded by the `files:` lists of the plan's tasks plus the feature folder, and measured from the merge base with the integration ref (the working tree alone, and the tier says so, when there is none); every file outside the bound is listed and the tier fails; paths under `.doflow/` never count as changes. The plan comes from `--plan-path`, else the feature folder in this checkout, else, when run in a linked worktree, the same folder in the main checkout; the first that exists is used, and a `--plan-path` that does not exist stops the search. `--scope <path>[,<path>…]` (repository-relative paths, a trailing `/` for a directory) bounds a change that has no plan and, given with a plan, is added to its bound without narrowing it; a scope stated on `readiness --scope` is used the same way, and a `--scope` that differs from it is refused. A `bound:` line under the tier names where the bound came from. The tier stays unresolved without a register, without a plan, or when the plan names no task files, unless a scope is declared, and then it names where it looked and the command that bounds the change. A report that would be `PASS` is `INCONCLUSIVE` while the task's run has its gated stage pending and no READY readiness record of that stage's template exists |
| `doflow recover --error <message> [--failed-check <name>]… [--iteration N] [--agent <name>] [--json]` | Classify a verification failure into one of eleven classes and return the targeted action for it. Exits 0 when a bounded retry is available, 1 when the loop must stop |
| `doflow scaffold [--slug <name>] [--json]` | Emit the reviewable code scaffold the active feature's `requirement.md`, `design.md` and `plan.md` imply, under that feature's own `scaffold/` directory. Signatures, types and stubs only — never a write into the source tree. Exits 1 when the scaffold is incomplete or blocked, so a partial result is never reported as success. This is what `/do-execute-plan --scaffold` runs |
| `doflow decision --action init\|add\|list\|compact [--slug <name>] [--json]` | Keep one decision register per feature under `decisions/`, resolved the way `scaffold` resolves the feature (working directory, or `--slug`). `init` creates `decisions/register.json` and both generated views for a feature that has none; a folder that already holds `requirement.md`, `design.md` or `plan.md` is refused (exit 1, `predates-register`) so older features stay untouched, and a rerun on an existing register writes nothing. `add` takes `--topic <key> --statement <one line, at most 280 chars> --channel question\|gate\|prompt\|default\|resolution --stage discovery\|design\|planning\|implementation\|verification\|review --rationale <text> [--supersedes DEC-###[,…]] [--refs <id>[,…]] [--source <locator>]`, or `--batch <file.json>` carrying an array of the same fields; any invalid item refuses the whole batch (exit 2) and nothing is written. Who decided follows from the channel (`question`, `gate`, `prompt` are the user; `default`, `resolution` are the agent) and cannot be passed. A topic holds one live decision: a new one on a live topic must name it in `--supersedes`, otherwise exit 1 (`topic-conflict`) and nothing is written. `list` returns live decisions by topic, `--all` every decision by id; `status` is a synonym. `compact` moves the lines of each chain artifact's `History` section into `decisions/history/<artifact>.md`, leaves its comments and one `Earlier entries:` pointer, and reports `unchanged` on a second run; every artifact is attempted, and a failure exits 1 (`compaction-failed`) with status `partial`, a `failed[]` list carrying each artifact's message, and the failed artifacts untouched; `moved` still reports the artifacts that succeeded, each by its feature-relative path such as `intention/requirement.md`. `decisions.md` and `decisions/archive.md` are generated from the register and never hand-edited. Exits 1 on `no-register`, `predates-register`, `topic-conflict`, `compaction-failed` and `register-locked` (the register lock timed out; retry), 2 on a usage error or an unresolvable feature |
| `doflow followup --action add\|list\|take\|settle\|promote\|report [--slug <name>] [--json]` | Record and manage what a feature left unfinished, in the project's own store: one write-once JSON event per change under `.doflow/state/lifecycle/events/` at the repository root (the first non-bare worktree, so every linked worktree shares one store), local to this machine and not shared. DoFlow never stages, commits or pushes that folder and writes no ignore rule for it. The first `followup`, `lifecycle`, `goal` or `failure --action settle --as imported` command copies an existing `agent-docs/lifecycle/events` once and leaves it untouched; a marker file, `.doflow/state/lifecycle/migrated.json`, records that the store is in place, and from then on the old folder is never read again, even when the store later empties. A store that already holds events gets the marker without a copy. While the old folder exists, every one of those commands prints one stderr line saying it can be deleted. `DOFLOW_RETENTION_HOURS` set to a positive whole number of hours makes each of those commands remove the event files of settled follow-ups and goals whose newest event is older, never open, taken or unfinished ones, and print one stderr count line (`retention: removed N event files older than H h`); unset keeps everything and an invalid value warns and removes nothing. `add` takes `--stage discovery\|design\|planning\|implementation\|verification\|review\|release\|maintain --statement <one line, at most 280 chars>` and records the feature from `--slug` or the branch; with no feature it needs `--source run\|release\|manual` (`run` also `--task-class <c> --task-id <id>`, `release` also requires `--release <tag>`); `--batch <file.json>` carries an array of `{statement, stage, source}` objects and any invalid item refuses the whole batch (exit 2). `list [--state open\|taken\|done\|dismissed\|all]` defaults to open, and a taken item shows `done` while its feature derives finished. `take --ids <FU-a,FU-b> --slug <name>` needs open items and a tracked feature. `settle --ids <FU-a> --as kept\|dismissed\|fix\|done` needs `--reason` for `dismissed` and `fix`, and for `kept` when it releases a taken item or reopens a dismissed one, and `--evidence` for `done`. `promote --ids <FU-a,FU-b> --title <intent title>` creates a new `agent-docs/intent/<title>.md` and never touches an existing one. `report --statement <one line>` files a product problem as an open follow-up (source `report`, optionally `--release <tag>` and `--feature <slug>`); its body comes from exactly one of `--file <path>` (`-` reads stdin), `--stdin` or `--text <body>`, is masked, capped at 1 MiB and kept only on this machine under `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/reports/`, while the project store holds the id, a masked 2 KB excerpt and the size. Free text is masked for secrets before it is stored, on a best-effort basis, never as a guarantee. `--channel question\|gate\|prompt\|default` records whether the user or the agent acted. Exits 1 on `unknown-id`, `illegal-transition`, `untracked-feature`, `intent-exists`, `id-collision`, `store-locked` and `store-migration-failed`, 2 on a usage error or `-g` |
| `doflow lifecycle [--action overview\|init\|status\|release\|merged] [--slug <name>] [--json]` | The project-level view of the same store. `overview` (the default with no `--action`) lists the open follow-ups with their sources, promoted intents, goals, and feature statuses in four buckets (`finished`, `awaitingRelease`, `inProgress`, `unknown`), plus ready-to-run `next` lines. It writes no event; like every lifecycle command it first runs the one-time copy and, with `DOFLOW_RETENTION_HOURS` set, the removal of expired files, and when neither has anything to do it creates no folder. `--maintain [--since <ISO time>]` shows up to 50 items, a `pending` count and, inside the DoFlow repository, the new and regressed failure entries. `init --slug <slug> [--take <FU-a,FU-b>] [--intent <path>] [--goal <goal>]` tracks a feature whose folder exists under the repository root, optionally taking follow-ups or every open one promoted to that intent, in one all-or-nothing write; a folder that exists only in a linked worktree is refused (`no-feature-folder`). `status --slug <slug>` derives `finished`, `awaiting-release`, `in-progress` or `unknown` from git (merge evidence into the integration ref, the first that exists of `develop`, `origin/develop`, `main`, `origin/main`, `master`, `origin/master` and `origin/HEAD`) and never writes it. `release --tag <vX.Y.Z> [--confirm] [--feature <slug>]… [--exclude <slug>]…` previews the tracked features a release ships and writes nothing; with `--confirm` the tag must exist (`tag-missing`) and one release record names what shipped, which finishes those features and the follow-ups they took; `--feature` adds a feature git could not detect, `--exclude` removes one, and `notDetected` lists tracked features with no evidence (a squash, rebase, fast-forward or cherry-pick merge). `merged --slug <slug> --reason <line>` records a merge git cannot show (`already-merged` when git already shows it). Reads git only; no network; nothing is committed or pushed. Exits 1 on a refusal (`no-feature-folder`, `untracked-feature`, `unknown-id`, `unknown-goal`, `goal-already-linked`, `illegal-transition`, `no-integration-ref`, `tag-missing`, `already-merged`, `store-locked`, `store-migration-failed`), 2 on a usage error or `-g` |
| `doflow goal --action add\|item\|check\|link\|list\|done --goal <id> [--json]` | Keep a goal in the project's own store, the same event folder as `followup`: DoFlow's own record of one outcome and its checklist, whatever a harness's own `goal` command does. The id is kebab-case, at most 40 characters. `add --statement <one line> --item <text> [--item <text>]…` needs at least one item (ids `C1`, `C2`, …) and is refused `goal-exists` when the id is taken; `item --text <text>` appends the next id. `check --item C3 --evidence <one line>` records the item as met, and `--unmet` records it as not met; evidence is required either way. `link --slug <slug>` makes a tracked feature serve the goal (`untracked-feature` for an untracked slug, `goal-already-linked` when it serves another goal unless `--replace`); a feature serves one goal at most, and a feature that serves none is unaffected. `list [--goal <id>]` shows each goal's items, `progress` (met over total), the linked features by status, `proposeDone` (every item met and the goal open) and a nudge per unchecked item while a linked feature is finished. `done [--reason <line>] --channel question\|gate\|prompt` is for the user only: `default` is refused (`not-user`), and a goal with unmet items is refused (`items-unmet`) unless `--reason` says why it is closed anyway. `--channel` records whether the user or the agent acted. Text is masked for secrets, one line and bounded. Reads git only to derive feature statuses; no network; nothing is committed or pushed. Exits 1 on a refusal (`goal-exists`, `unknown-goal`, `unknown-item`, `goal-already-linked`, `untracked-feature`, `not-user`, `items-unmet`, `already-done`, `store-locked`, `store-migration-failed`), 2 on a usage error or `-g` |
| `doflow failure --action list\|settle\|capture [--all] [--fp <16 hex>] [--as noise\|fixed\|imported] [--reason "<line>"] [--set on\|off] [--json]` | The failures DoFlow captured about itself on this machine, in one machine-wide folder `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/failures/`, shared by every project and never sent anywhere. A line is written when a DoFlow command ends in an internal error (a programming error, a system error with a code, an escaped throw), the dispatcher crashes, or a guard hook aborts; findings, refusals, bad flags, hook denies and environment faults are not recorded, and the message is stored only in its normalised, masked form. Capture never changes a command's output or exit status and is skipped when `HOME` is unset or `XDG_CONFIG_HOME` is relative. `list` folds the lines into entries by fingerprint and shows `new` and `regressed` ones (`--all` for every status), with counts; `settle --fp <fp> --as noise\|fixed` needs `--reason` and `--as imported` creates a follow-up in the DoFlow repository only (`not-doflow-repo` elsewhere); a `fixed` entry seen again is `regressed`. `capture` reports the switch, and `--set off` creates the sentinel file `off` (`--set on` removes it); `DOFLOW_FAILURE_CAPTURE=off` also turns capture off but cannot turn it on over the sentinel. Works whatever the working directory and ignores `-g`. Exits 1 on `unknown-fp`, `already-imported`, `not-doflow-repo` and, for `--as imported`, `store-migration-failed` and `store-locked`, 2 on a usage error |
| `doflow leak-scan --path <file>… [--exclude <segment>…] [--json]` | Report DoFlow's own process vocabulary — `FR-###`/`NFR-###`, `US#`, `agent-docs/`, `.doflow/state/`, chain artifact names — appearing in files that ship to people who never used DoFlow. `--path` is repeatable. `--exclude` extends the built-in `agent-docs/` exclusion with extra path segments (an implementing repository's own `bin/`/`src/`/`core/`, say) and accepts either a repeated flag or a comma-joined value in either spelling (`--exclude a --exclude b`, `--exclude a,b`, `--exclude=a,b`). Occurrences under an excluded segment are correct usage and are excluded before matching. Every path given is accounted for as scanned or unscanned-with-a-reason; an unreadable path is reported, never fatal. Exits 1 on findings, 0 when clean. Two callers share it so they cannot drift: the Claude Stop hook scans the turn's edited files, and `/do-code-review` scans the reviewed set |

`readiness`, `evidence`, `claim`, `context-pack`, `retrieval-plan` and `outcome` read per-project
state under the invoking repo's `.doflow/state/`; run them from the project the task belongs to,
or pass `-g` for the global scope. Those verbs and `research-request` accept `--slug`; for a
feature with a decision register their records live in a `<slug>/` subdirectory of each store, as
`.doflow/state/evidence/<slug>/<task>.json` (claims are `evidence/<slug>/<task>_claims.json`), so the
same task id in two features no longer collides. A feature without a register, and a task id equal
to the slug, keep the flat `.doflow/state/<store>/<task>.json` path. Every verb that takes `--slug`
(these, plus `verify`, `scaffold`, `decision`, `orchestrate`, `validate`, `prereqs`, `render-audit`,
`task-brief` and `parallel-check`) refuses an unsafe one with exit 2 and `{"error":"invalid-slug",...}`. `capabilities` reports on the machine and is
scope-independent; `doctor` reports on both, so index freshness and command detection follow the
same project scope.

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

`indicators` reads a different file from the three below it: the per-task orchestration records at
`<config>/state/orchestration/<slug>.json`, which the workflow orchestrator writes as stages complete.
That is why it is a separate verb rather than a mode of `stats` — a run-ledger record names no task,
stage or class, so no extension of `stats` could group by any of them. It reports per-stage intervals,
gate waits charged to no stage, recorded stage outcomes and rerun counts, grouped by task class, and it
prints what it cannot measure: anything needing git, pull-request or CI data, and the fact that a stage
figure is an interval since the previous recorded event rather than pure execution time. It writes
nothing.

`trace`, `stats` and `discover` read the run ledger at `<config>/state/runs/YYYY-MM-DD.jsonl`,
which `doflow-run` appends to once per dispatched verb. They locate it the way the dispatcher does
— nearest `.doflow` walking up from the working directory, or the global one — so they work from a
subdirectory. Records are metadata only: a verb, a capability, a provider, an exit code, a
duration, counts and byte volumes. No argument value, command output or file content is recorded.
An empty ledger is a normal state and is reported as "no conclusion can be drawn", never as a
clean bill of health.

`inventory` reads neither the run ledger nor the orchestration record: it reads the two *ownership*
ledgers, one per scope, and derives everything else at read time. Nothing it reports is persisted.
Its optional positional is the project root (default the working directory) and `-t` restricts it to
named harnesses; the global scope's root comes from the process home directory and is not an
argument. Its report and `doflow reconcile` deliberately disagree about how much is repairable —
`reconcile` converges a scope onto what `doflow.lock` pins and names a harness the ledger holds and
the lock lacks — so the report states that gap as repair coverage rather than hiding it by adopting
the narrower definition. The modules behind it live under `src/runtime/inventory`.

`scaffold` resolves which feature is active the same way every chain skill does — from the working
directory, branch-derived in a git repo — so run it from the project root. Where a non-git root
holds more than one feature directory it cannot choose: it exits 2 naming every candidate, and
`--slug <name>` re-runs against the one you pick.

**Dense/rerank retrieval slots.** `core/registry/models.json` accepts an optional top-level `slots`
array binding a retrieval stage (`dense` embedding lookup, `rerank` cross-encoder pass) to one
declared provider: entries are `{ "id": "dense" | "rerank", "provider": <models.json provider id>,
"model": "<concrete model>", "enabled": false }`. A slot changes nothing until it is both declared
and `"enabled": true` — until then (and whenever the bound backend does not answer a PATH probe)
retrieval stays lexical BM25 plus the import graph, which remains the correctness floor. There is
deliberately no HTTP client here: enabling a slot only routes lookups to the named provider through
the same advisory availability probe `model-role` uses; the provider implementation itself (local
vs API) is a separate decision and no caller invokes one today. Malformed slots fail registry load
loudly rather than reading as "no dense provider".

## Prompt nudge

A plain change request that names no `/do-*` skill can be suggested `/do`, once per session. The
suggestion is advisory: it never blocks or rewrites a prompt, and the model still does the task. The
decision's cost no longer grows with the prompt's length, and the hook stays near its existing 100 ms
budget on an idle machine; it is not free, so a slow machine can feel it.

- **Where.** Claude Code and Codex only, through the existing per-prompt hook
  (`core/harnesses/shared/hooks/policies/user-prompt-submit.sh`). The other six harnesses
  (Gemini CLI, Antigravity, OpenCode, Pi, Copilot CLI, Kiro) get no hook for this; they get only the
  rewritten `description` of `do`, `do-implement` and `do-flow`, which steer a plain change request
  to `/do` first.
- **When.** The first prompt of a session that reads as a code-change request: it starts with a
  change verb (after a polite lead-in such as "please") and names a code noun or a file path. The
  check is keyword-based, so it can miss a real request and can fire on a prompt that is not one,
for example a request to write a poem about a named function in a file.
- **When it stays silent.** Questions, slash commands, review and explanation requests, short
  replies such as "thanks" or "continue", prompts that mention `/do` or a `/do-*` skill, subagent
  prompts, a session whose branch already has a feature folder under `agent-docs/doflow/`, and a
  session where a `/do-*` skill has already run. A session is nudged at most once; a prompt that
  mentions `/do` also ends the chance for that session.
- **What it says.** One note, in the same hook output as the first-prompt context or alone on a
  later prompt. It tells the model to mention in one sentence that `/do` would classify the task and
  apply DoFlow's checks, then to do what the user asked, without running `/do` itself or waiting for
  a reply. It names `/do` and no other skill.
- **What it never does.** It makes no model call and no network call, stores no prompt text (the
  prompt reaches `jq` on standard input and is never written out), starts no `node` or `doflow-run`
  process, and never emits a `block` decision. Any failure on its path (no registry, no `jq` regex
  support, an unwritable state folder) leaves the prompt un-nudged.
- **Where the rules live.** Data, not code: the `promptNudge` object in
  `core/registry/workflows.json` (message, verbs, nouns, lead-ins, blockers, path pattern). The
  decision program is `core/harnesses/shared/hooks/policies/prompt-nudge.jq`. The workflow engine and
  the task classifier do not read this key; the registry shape guard G25
  (`test/guards/prompt-nudge-registry.test.js`) does.
- **How a rule change is judged.** `test/hooks/prompt-nudge.corpus.json` holds labelled prompts, some
  written with the rules in view and some without. `test/hooks/prompt-nudge.test.js` runs every one
  through the shipped rules: a prompt labelled silent that nudges fails the test, while recall on the
  prompts labelled as requests is printed as a diagnostic line and never asserted.

### Switching the nudge off

One setting file, `prompt-nudge`, holds one word on its first line (case and surrounding whitespace
are ignored):

| Scope | Path |
|---|---|
| Project | `<repo root>/.doflow/prompt-nudge` |
| User | `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/prompt-nudge` |

| Value | Effect |
|---|---|
| `on` | the nudge may run (also the default when neither file exists) |
| `off` | no nudge |

When both files exist, the project file decides alone. A file that cannot be read, is empty, or holds
any other word counts as `off`. The setting affects only the nudge: the first-prompt context, the
session title and the other hooks are unchanged. The repo root is the nearest ancestor of the
session's working directory that holds a `.git` entry.

### First-prompt context on Claude Code

The same hook builds the first-prompt context: a Git block, up to 4,000 characters of the previous
compact summary, and a warning left by the prior session, plus a session title of the form
`branch — sha`. It now emits one nested `hookSpecificOutput` object for both Claude Code and Codex.
Claude Code ignores a top-level `additionalContext`, which is what the hook emitted before, so on
Claude Code this context was not delivered; it is now, once per session start (including after
compact, clear or resume). The hook emits the title in the form Claude Code documents; its rule is
to skip the title when the session already has one, and Codex never receives a title.

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

The release version comes from `doflow-run git-state --next-version`. Its base tag is the highest `v*`
tag merged into HEAD or into the production branch, and the result carries a `warning` key when a
`package.json` exists and its version differs from that tag. A slug that is not letters, digits, dot,
underscore or dash (starting with a letter or digit, no `..`) is refused with exit 2 and
`{"error":"invalid-slug",...}`, by `doflow-run git-state --branch-name` and by `doflow-run paths` alike.

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
