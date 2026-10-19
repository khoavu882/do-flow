# Guide

Use this page to choose a workflow. Use [Reference](reference.md) when you need an exact command or capability.

## Choose a path

```mermaid
flowchart TD
    A[What are you trying to do?] --> B{Starting a feature?}
    B -->|Yes| C[Discovery → design → plan → implement → validate]
    B -->|No| D{Investigating a problem?}
    D -->|Yes| E[Diagnose → fix → test]
    D -->|No| F{Improving existing code?}
    F -->|Yes| G[Diagnose → refactor → test → review]
    F -->|No| H[Research, document, or ask /do to route it]
```

## Deliver a feature

Choose the guided path when the request needs requirements, design decisions, or multiple implementation steps.

### The spec-driven workflow

DoFlow treats feature delivery as a sequence of durable specifications, not one long chat. Each phase writes an artifact under `agent-docs/doflow/<feature-slug>/`; the next phase reads that artifact rather than relying on conversation memory.

```mermaid
flowchart LR
    R[Requirement\nWHAT and WHY] --> D[Design\nsystem shape]
    D --> P[Plan\nHOW and tasks]
    P --> G{Ready to implement?}
    G -->|Approved| I[Execute and validate]
    I --> V[Test and review]
    V --> C{Ready to commit?}
    C -->|Approved| M[Commit or merge]
```

| Phase | Command | Artifact | It answers |
|---|---|---|---|
| Discover | `/do-brainstorm` | `requirement.md` | What problem are we solving, for whom, and why? |
| Design | `/do-design` | `design.md` | What system shape, interfaces, and decisions satisfy the requirement? |
| Plan | `/do-plan` | `plan.md` | How will work be broken into dependency-ordered, verifiable tasks? |
| Execute | `/do-execute-plan` | Checked tasks and `state.md` | What is complete, what is next, and what blocked progress? |
| Validate | `/do-test`, `/do-code-review` | Test and review results | Does the implementation meet the agreed specification? |

The three specifications are deliberately different. Do not put implementation tasks into `requirement.md`, or repeat design decisions in `plan.md`; update the artifact that owns the decision.

### Gates and review points

`/do-flow` advances through phases automatically, but pauses where human judgment matters:

1. **Clarification gate:** resolve any remaining requirement ambiguity before design.
2. **Implementation gate:** review `requirement.md`, `design.md`, and `plan.md` before code changes. The prerequisite gate also prevents implementation when any of those files is missing.
3. **Commit gate:** review test and code-review results before using `/do-git` to commit or merge.

Use this as the normal path for a new feature:

```bash
/do-brainstorm "add team invitations"
/do-design "team invitation flow"
/do-plan
/do-execute-plan --dry-run
/do-execute-plan --scope next
/do-test
/do-code-review
/do-git save
```

Or use the lifecycle intents for git operations:

```bash
/do-git ship          # Ship current feature to integration
/do-git release       # Full release with version bump, tag, and merge
/do-git hotfix <id>   # Create and propagate a hotfix across all branches
```

`/do-flow "add team invitations"` coordinates the same path and pauses at its approval gates. Use it when one feature should progress through the full delivery sequence.

### Optional MCP servers in the stages

`/do-brainstorm` and `/do-design` may consult two MCP servers, `context7` and `sequential-thinking`, when you have them installed (see [Setup](setup.md#mcp-server-selection)). They are used only when a stage meets the condition that calls for them, never on every run:

| Stage | `context7`, when | `sequential-thinking`, when |
|---|---|---|
| `/do-brainstorm` | `requirement.md` would state a named library, API or tool's behaviour as fact | a round's open ambiguity spans two or more components, actors or requirements |
| `/do-design` | `design.md` would state a named library, API, SDK, CLI or service's interface, configuration or version behaviour as fact | §1 records a decision with a rejected alternative |

Whatever a server returns is evidence the stage weighs, not an instruction. At handoff the stage says what it did with each server it names: consulted and used, consulted with nothing usable, skipped with a reason (a condition that did not hold is `skipped:not-due`), or unavailable. A server it names but records nothing for produces a warning after the handoff. The warning never blocks the stage or changes its exit status. `doflow doctor` shows these outcomes per stage over the last 20 recorded runs, and which of your harnesses have each server, in its `[MCP Consultations]` and `[MCP Servers]` sections.

When `/do-execute-plan` dispatches a task to a subagent, the brief it writes also states the model tier for that task, the tools this machine answers with for each kind of search, and which MCP servers the current stage expects (naming any the target harness cannot reach). The subagent ends its report with a `Tools used:` line, such as `Tools used: semble, rg, context7=used`, and the next handoff reads it. Tool use is recommended where it saves reading, never required.

### Resume a generated plan

The plan and its checklist are the source of truth once planning is complete. `state.md` records progress so a later session can resume without reconstructing the work from chat history.

```bash
/do-execute-plan --dry-run
/do-execute-plan --scope resume
/do-execute-plan --scope phase:2
```

Stop and update the requirements or design if a dependency, decision, or validation result makes the plan invalid.

### Start or resume with one command

`/do-flow` detects the active feature and starts at the first missing specification. It begins with discovery for a new feature, creates a design when only a requirement exists, creates a plan when design is the missing artifact, and asks for implementation approval when the specification set is complete.

```bash
# Start a new spec-driven feature
/do-flow "add team invitations"

# Continue an existing feature from its first incomplete phase
/do-flow

# Deliberately rerun a phase after a material change
/do-flow --from design
```

## Investigate a bug

Start with diagnosis. A fix is an explicit next step, not an assumption.

```bash
/do-diagnose "login returns 500 after password reset" --focus quality
/do-diagnose src/auth.ts --focus security
/do-test
/do-git save
```

## Improve code deliberately

Use diagnosis to establish the root cause or audit scope, then improve only the agreed scope.

```bash
/do-diagnose src/ --focus quality
/do-test
/do-code-review
```

For parallel task orchestration, `do-execute-plan` automatically isolates write-sets across specialist subagents.

## Retrieve code from the project

`doflow retrieve` keeps its existing guidance search when you pass only `--query`. Use
`--scope code` to search the current project. Code retrieval is lexical-only by default; exact
lookups always use the bounded lexical path. A conceptual query can request the optional hybrid
profile, which combines lexical candidates with a local Semble index and falls back to lexical
retrieval when Semble is unavailable or the index is stale.

Prepare the optional provider before invoking it: install Semble 0.7.0 and its required Python
dependencies in the environment of the `semble` launcher (found on PATH, then in `~/.local/bin`),
and keep a compatible model already present on disk. Set `SEMBLE_MODEL_PATH` to that absolute model directory, or pass `--model-path`.
DoFlow does not download models or install Python packages. Provider calls set the model libraries'
offline flags and redirect their caches and temporary statistics into a bounded, project-local
temporary directory.

Build the code index explicitly, then opt into hybrid for conceptual searches:

```bash
doflow retrieve --scope code --index-action build --root . --model-path "$SEMBLE_MODEL_PATH" --json
doflow retrieve --scope code --profile hybrid --query "where are task attempts appended?" --root . --json
```

Use `--index-action refresh` to update an existing compatible index. If a build or refresh reports
an incomplete index, fix the reported cause and run an explicit bounded `build` to repair it; no
query silently rebuilds or refreshes the index. Retrieval state stays under the project's
`.doflow/index/code/semble/`. Provider faults leave lexical search available and report the gap.
Hybrid remains an experimental, incomplete promotion: lexical-only is the default until repeated
provider conformance and the full retrieval gate pass. The paid task-success and token-cost checks
remain unreached without separate authorization.

An unknown `--scope` value exits 2 and lists `guidance` and `code`. The search root is `--root`, or the current
directory when it is omitted; task state (`--task-id`, `--slug`) stays in the feature store root, so in a linked
worktree the search reads that worktree's files while records go to the main checkout. When both providers answer, a conceptual hybrid search
returns one result per file: lexical and Semble each vote for their first requested-top files, and the delivered
span is the widest span either returned (`origins[].locator` shows each provider's span). When files were left out
of the corpus (an oversized file, a file-count limit, an unstaged delete or rename), the response lists a gap with
source `admission`, a cause and a count, and the search is marked incomplete. An index operation that stopped
leaving a lock behind is cleared automatically when the process that held it has exited on this host.

## Research before committing to a design

Keep current or uncertain external knowledge separate from implementation work.

```bash
/do-document "current OAuth 2.1 authorization-code guidance" --type research
/do-design "OAuth login for this application"
/do-execute-plan --scope next
```

Research produces evidence; it does not replace a design decision or validation.

During an active feature run, a stage can open a `research-request` only for a specific external fact it cannot establish locally, or when you explicitly ask for research. The question and results stay under the feature task ID; a blocking unanswered question keeps its dependent stage open. Web search addresses broader current questions, while Context7 addresses version-specific library documentation when the harness has those tools. An unavailable provider leaves a stated gap, not an invented answer, and a stage that could not reach `context7` records it as `unavailable` with the command that adds it. Outbound queries omit private repository content unless you approve the exact disclosure. This does not add a seventh feature stage or waive implementation, commit, or merge approval.

```bash
# Inspect the active feature's research questions and their status
doflow research-request --action list --task-id <feature-slug> --json
```

The feature stage ordinarily manages open/resolve actions and source evidence itself; run the standalone `/do-document ... --type research` workflow when the question is not part of an active feature.

## Write and maintain documentation

Use documentation work as a focused task, then build the site when repository documentation changes.

```bash
/do-document "document the billing API" --type api
mkdocs build --strict
```

For this repository, keep one canonical home for each topic: installation in [Setup](setup.md), workflows here, complete lookup material in [Reference](reference.md), and system concepts in [Overview](overview.md).

## Keep track of what is left

A feature rarely finishes everything it found. The lifecycle loop gives deferred work one place to
live, so the next feature can start from it instead of from someone's memory.

- **Follow-ups are recorded when work is deferred.** A stage that leaves something undone records it with its one-line statement and where it came from.
- **The next feature starts from them.** Discovery shows the open follow-ups before it asks you anything; you pick the ones the new feature takes, and DoFlow marks them taken by that feature.
- **A follow-up can become an intent.** Promoting one or more items creates a new intent file that names them, and each promoted item shows the intent it went to.
- **A release finishes what it shipped.** After you tag a release, `lifecycle release --confirm` records which features it carried; those features, and the follow-ups they took, become done. The release ritual previews it for you before the tag.
- **Problems in the product can be reported.** A report is an open follow-up with a body that stays on your machine.
- **Goals are optional.** A goal is one outcome with a checklist; a feature may serve one, and no feature has to.
- **`/do maintain` goes through everything open.** It lists reports, open follow-ups and (in the DoFlow repository) DoFlow's own captured failures, and you settle each one: keep, dismiss, promote, start a fix, or mark done.

DoFlow proposes and you decide. A goal is closed only when you say so, and an item is dismissed only with a reason you give.

### Where it is stored

Everything lives under `.doflow/state/lifecycle/` at the root of your repository, as one small JSON file per change. The store is local to this machine and not shared: DoFlow never stages, commits or pushes it, and `.doflow/state/.gitignore` keeps it out of `git add -A`. Linked worktrees share the store of the main working tree.

Earlier versions kept the store in `agent-docs/lifecycle/events/`. The first `followup`, `lifecycle`, `goal` or `failure --action settle --as imported` command in a repository that still has that folder copies it once into the new location, and leaves the old folder exactly as it was. The copy then writes `.doflow/state/lifecycle/migrated.json`, a marker that tells every later command the store is in place, so the old folder is never read again, even after retention empties the store; a new store that already holds events gets the marker without a copy. The line saying the old folder is no longer read and can be deleted repeats on every one of those commands for as long as the folder exists. If the copy fails, the command exits 1 with `store-migration-failed`, changes nothing, writes no marker, and the next command tries again.

Settled items are pruned after 180 days by default; open, taken and unfinished items never are. Set `DOFLOW_RETENTION_HOURS` to a positive whole number of hours to choose another window: each of those commands then removes the files of settled follow-ups (done or dismissed) and settled goals (done) whose newest event is older than that. Open, taken and unfinished items are never removed, and neither are feature or release records. A removal prints one line on stderr, such as `retention: removed 3 event files older than 720 h` (the count is not pluralised, so one file reads `removed 1 event files`). An unset or empty value uses the 180-day default, or keeps everything when pruning is switched off (see below); a value that is not a positive whole number prints a warning, removes nothing and lets the command run. The old `agent-docs/lifecycle/` folder is never touched.

The machine-local pieces are kept outside the repository, under `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/`:

| What | Where | Sent anywhere |
|---|---|---|
| Failures DoFlow captured about itself | `failures/` | Never. Recorded on this machine only |
| The full body of a report | `reports/` | Never. The project store keeps only the id, a masked excerpt and the size; a body is removed with its follow-up |

Secrets are masked before anything is written, on a best-effort basis: it is a safeguard, not a guarantee, so do not paste credentials into a report.

### How much DoFlow keeps

DoFlow bounds everything it writes. Logs, per-task records, run history, recovery snapshots, session folders and settled lifecycle events are pruned once their work is finished and past the bound listed in the store table of `docs/reference.md` ("Storage stores"); work that is open, waiting at a gate or unfinished is never removed. Pruning runs quietly after DoFlow commands and session hooks and never changes their output.

- `doflow storage` shows every store, its size and what a pass would remove, and changes nothing.
- A `.doflow/prune` file containing `off` switches pruning off for the project, and `~/.config/doflow/prune` for your user; the report still works. An explicitly set `DOFLOW_RETENTION_HOURS` still removes settled lifecycle events while pruning is off.
- `.doflow/state/.gitignore` keeps the state out of `git add -A`; DoFlow writes it once and never overwrites your own.
- `doflow remove` deletes these control files when DoFlow leaves a project and leaves the state itself.

### Failure capture and its off switch

When a DoFlow command ends in an internal error, or the dispatcher or a guard hook crashes, DoFlow appends one masked line to a file on this machine. A bad flag, a refusal, a hook that denies a command, a missing `jq` and a missing `bash` are not recorded. Some environment errors, such as a permission error on a folder or a missing program, are recorded because they look like internal errors; `/do maintain` lets you settle them as noise. Capture never changes a command's output or exit status. Turn it off with:

```bash
doflow failure --action capture --set off      # creates the file `off` in the failures folder
doflow failure --action capture --set on       # removes it
DOFLOW_FAILURE_CAPTURE=off doflow ...          # off for one command or shell; cannot turn capture on over the file
```

Failures are for the people who maintain DoFlow: inside the DoFlow repository, `/do maintain` lists new and regressed entries and lets you import one as a follow-up. Elsewhere they are only listed by `doflow failure --action list`.

### The /do suggestion and its off switch

On Claude Code and Codex, the first prompt of a session that reads as a plain code-change request
(for example "add a retry to src/upload.js") gets a one-sentence suggestion from the model that `/do`
would classify the task and apply DoFlow's checks. The model then does what you asked. It happens at
most once per session, and only when no `/do-*` skill is already in use. It is advisory and
keyword-based, so it can miss a request or fire on one that is not a change request. The other
harnesses get no such hook; their skill descriptions steer a plain change request to `/do`. To turn it
off for one project or for yourself:

```bash
mkdir -p .doflow && echo off > .doflow/prompt-nudge                      # this project, from the repo root
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/doflow" && echo off > "${XDG_CONFIG_HOME:-$HOME/.config}/doflow/prompt-nudge"   # every project, this user
```

Use `on` in place of `off` to turn it back on. If both files exist, the project file wins, even when
the user file says the opposite. A file that is empty, unreadable or holds any other word counts as
`off`. Whether the project file is committed or ignored is up to the project's own rules: commit it to
switch the nudge off for everyone on the repository, or add it to `.gitignore` to keep the choice
personal. The setting changes only the nudge, not the first-prompt Git context or any other hook.

### A worked example

This was run in a scratch repository with a `develop` branch, a `v1.0.0` tag and empty feature folders under `agent-docs/doflow/`. The agent runs the same verbs through `doflow-run`; `doflow` is the same command for you. Item ids are random, so yours will differ.

Feature `010-search` is tracked and, during review, leaves two follow-ups. Then it merges.

```console
$ doflow lifecycle --action init --slug 010-search
010-search: tracked new
$ doflow followup --action add --slug 010-search --stage review --statement "Search ignores accents in the query"
added FU-88ggkq (stage 010-search review): Search ignores accents in the query
$ doflow followup --action add --slug 010-search --stage review --statement "Search index is rebuilt on every start"
added FU-w1as7v (stage 010-search review): Search index is rebuilt on every start
```

The next feature starts from the overview, then takes the first item:

```console
$ doflow lifecycle
discovery overview: 2 open follow-ups, 2 shown (release mode tagged, integration ref develop)
  FU-88ggkq  (stage 010-search review, 2026-10-03)  Search ignores accents in the query
  FU-w1as7v  (stage 010-search review, 2026-10-03)  Search index is rebuilt on every start
awaiting release: 010-search
next: Take items into the new feature when its folder exists: doflow-run lifecycle --action init --slug <slug> --take FU-88ggkq
$ doflow lifecycle --action init --slug 011-accents --take FU-88ggkq
011-accents: tracked new, took FU-88ggkq
$ doflow followup --action list --state taken
FU-88ggkq  taken by 011-accents  (stage 010-search review, 2026-10-03)  Search ignores accents in the query
```

Both features merge into `develop`. Before the tag exists, `release` is a preview and writes nothing; after `git tag v1.1.0`, `--confirm` records it:

```console
$ doflow lifecycle --action release --tag v1.1.0
preview of release v1.1.0 (previous v1.0.0, bound develop)
  ships 010-search  (branch feat/010-search)
  ships 011-accents  (branch feat/011-accents)
follow-ups done: FU-88ggkq
next: After git tag v1.1.0: doflow-run lifecycle --action release --tag v1.1.0 --confirm (add --feature <slug> for a feature listed under notDetected that shipped)
$ doflow lifecycle --action release --tag v1.1.0 --confirm
recorded release v1.1.0 (previous v1.0.0, bound v1.1.0)
  ships 010-search  (branch feat/010-search)
  ships 011-accents  (branch feat/011-accents)
follow-ups done: FU-88ggkq
$ doflow followup --action list --state all
FU-88ggkq  done by 011-accents  (stage 010-search review, 2026-10-03)  Search ignores accents in the query
FU-w1as7v  open  (stage 010-search review, 2026-10-03)  Search index is rebuilt on every start
```

A user reports a problem, and `/do maintain` starts from the overview (here `FU-2sb0xv` is the report):

```console
$ doflow followup --action report --release v1.1.0 --statement "Search crashes on an empty query" --text "TypeError: query is undefined at search.js:12"
reported FU-2sb0xv (report v1.1.0): Search crashes on an empty query
  body on-this-machine (45 bytes), excerpt 45 bytes, 0 values masked
next: Settle it now or at /do maintain; to start a fix, route it as a bug run
$ doflow lifecycle --maintain
maintain overview: 2 open follow-ups, 2 shown (release mode tagged, integration ref develop)
  FU-2sb0xv  (report v1.1.0, 2026-10-03)  Search crashes on an empty query
  FU-w1as7v  (stage 010-search review, 2026-10-03)  Search index is rebuilt on every start
finished: 010-search, 011-accents
pending: 2
next: Take items into the new feature when its folder exists: doflow-run lifecycle --action init --slug <slug> --take FU-2sb0xv
next: Keep open: doflow-run followup --action settle --ids FU-2sb0xv --as kept --reason "<why it stays>" --channel question
next: Dismiss: doflow-run followup --action settle --ids FU-2sb0xv --as dismissed --reason "<why>" --channel question
next: Promote to a new intent: doflow-run followup --action promote --ids FU-2sb0xv --title "<intent title>" --channel question
next: Start a fix: doflow-run followup --action settle --ids FU-2sb0xv --as fix --reason "<where it is routed>" --channel question
next: Done outside a feature: doflow-run followup --action settle --ids FU-2sb0xv --as done --evidence "<what shows it>" --channel question
```

`/do maintain` asks you about each item and runs the matching line. Here the report is dismissed and the other item is promoted, which creates `agent-docs/intent/search-startup-speed.md` and lets the next feature start from it:

```console
$ doflow followup --action promote --ids FU-w1as7v --title "Search startup speed" --channel question
created agent-docs/intent/search-startup-speed.md from FU-w1as7v
$ doflow followup --action settle --ids FU-2sb0xv --as dismissed --reason "cannot reproduce" --channel question
settled FU-2sb0xv as dismissed
$ doflow lifecycle --action init --slug 012-startup --intent agent-docs/intent/search-startup-speed.md
012-startup: tracked new, took FU-w1as7v
```

A goal records an outcome and a checklist, and only you close it:

```console
$ doflow goal --action add --goal fast-search --statement "Search feels instant" --item "Accents work" --item "Index is cached"
added goal fast-search: Search feels instant
  C1  Accents work
  C2  Index is cached
next: Link a feature that serves it: doflow-run goal --action link --goal fast-search --slug <slug>
next: Record a met item with evidence: doflow-run goal --action check --goal fast-search --item C1 --evidence "<what shows it>"
$ doflow goal --action link --goal fast-search --slug 011-accents
011-accents now serves fast-search
$ doflow goal --action check --goal fast-search --item C1 --evidence 011-accents
fast-search C1: met (011-accents); 1/2 items met
next: Record a met item with evidence: doflow-run goal --action check --goal fast-search --item C2 --evidence "<what shows it>"
$ doflow goal --action done --goal fast-search --channel default
not-user: only the user marks a goal done: pass --channel question, gate or prompt once the user has said so (got 'default'). Nothing was written.
$ doflow goal --action done --goal fast-search --channel question --reason "caching is out of scope"
fast-search is done with C2 unmet: caching is out of scope
```

### Limits worth knowing

- A merge git cannot show (a squash, a rebase, a fast-forward or a cherry-pick) is not detected as shipped. List the feature with `--feature <slug>` when you record the release, or confirm the merge with `doflow lifecycle --action merged --slug <slug> --reason "<line>"`.
- Features created before the loop existed keep working as they did; their earlier follow-ups are not collected.
- The loop runs on all eight harnesses, in every scope where the harness gets skills: installing any one of them projects the DoFlow runtime. Antigravity has no skills at global scope, so install it per project. `doflow doctor` shows which harnesses reach the runtime.

## Drive the roadmap one step at a time

`doflow roadmap` advances a list of features (the roadmap) one step per call. It is for the person or
the orchestrating session that owns the roadmap; no skill calls it for you. It is local only, it ships
off, and the tests drive it against fixture repositories, so treat the flow as new. The exact flags,
outcomes and exit codes are in [Reference](reference.md).

**The seed.** `agent-docs/roadmap/rows.json` in the main checkout declares the rows; `agent-docs/` is
gitignored in this repository, so the file is yours. Each row has `id` (three digits, optionally a
lowercase letter or `-` and a capital, as in `085a` or `107-A`), `slug` (starts with `<id>-`), `title`, `class` (only `feature` rows are picked) and
`needs` (row ids that must be merged first), and optionally `writeSet` (repo-relative paths; a trailing
`/` means the subtree), `requires` (capability ids that must have a healthy provider), `mergeCommit` (a
merge from before the loop existed) and `hold` (one line, at most 120 characters: the row is skipped
until you remove it). `layout.worktree` may set where a row's worktree goes; it must be a sibling of
the main checkout. Never write a status: `status`, `phase` and `evidence` keys are rejected, because
status comes from git.

```bash
doflow roadmap --action render --check   # exit 0: ROADMAP.md matches git and the seed; exit 1: findings
doflow roadmap --action render           # write agent-docs/roadmap/ROADMAP.md if it changed
doflow roadmap --action status           # merged / in-flight / not-started per row, open merge intents
```

**Drive `next`.** Call `doflow roadmap --action next --json` and read `outcome`:

- `acted`: the call did one mechanical step (`pick` claimed a row into a new worktree, `gate`
  approved a gate by policy, `merge` merged an approved row into local develop, `cleanup` rendered the
  table and removed the finished worktree). Call `next` again.
- `perform`: a stage needs a skill. The envelope names the `skill`, the row's `worktree` and
  `artifactRoot`, the argument lists in `after` and the `next` command. Run the skill in that worktree,
  then run each `after` command (fill the `--note <text>` placeholder), then call `next` with the `runId`
  it gives. If the artifact is missing or unchanged, or the stage was not handed off, `next` answers
  `denied: stage-not-performed` with the same envelope. The implementation envelope runs `dispatch`
  with `--billing-cap free`, so no worker launches until you have recorded a harness's `billing` as
  `free`. After a merge, the envelope asks for the post-merge `verify --action report` in the develop
  worktree.
- `denied` or `blocked`: nothing advanced and the row waits. `reasons` says why (a gate predicate such as
  `blockers-open`, `stage-not-performed`, `lease-held`, or for `blocked`: `budget`, `stuck` or `quota`).
  Fix the cause; a denied gate is evaluated again when its inputs change.
- `idle`: nothing is ready; `skips` lists each row's reason. `stopped`: the kill switch is off.

`--row <id>` restricts a call to one in-flight row and `--run <id>` names the run; the default is the
open run. Only one `next` runs at a time (`lease-held` otherwise).

**Turn it on and off.** It ships off. To turn it on, put `{"schema":1,"autopilot.enabled":"on"}` in
`~/.config/doflow/settings.json` (or under `$XDG_CONFIG_HOME/doflow`). To stop it: set
`DOFLOW_AUTOPILOT_ENABLED=off`, set the value to `off`, or create the file `autopilot/off` in the same
folder. The switch is read before each step, and a stopped call names the layer in `annotations.switch`.
The environment variable and the file can only switch it off. The loop itself creates `autopilot/off`
when develop gets a revert of an autopilot merge or a merge fails its post-merge check
(`merged-unverified`); only you remove it. `doflow config -g` can still show `on` while only that file
is set; believe the loop's `stopped`.

**What never happens automatically.** Push, tag, publish, a global install, a permission-rule change
and a paid run. The loop only writes local state, local branches and worktrees, and merges an approved
row into your local develop; you push. Its code spawns only `git`, and G53 and G54 fail the build if
that changes. Gate-b approval is by policy: it needs a clean verify run on the exact feature head and a
valid `review/findings.json` with no open blockers, and a change to the gate policy or other protected
paths is never approved by the loop.

**When it stops.** Every `next` prints a `checkpoint` path (`.doflow/state/roadmap/runs/<runId>.json`)
holding the step log and per-row state. `doflow roadmap --action audit` prints every logged step and
deny. An open merge intent is in `.doflow/state/roadmap/intents/<row>.json`, and the next call resumes
it. A tripwire stop is in `annotations.tripwire` and `.doflow/state/roadmap/tripwire/events.json`.
`blocked: budget` means the run used its step cap (`loop.maxSteps` in `core/registry/gates.json`).

## Work across supported tools

| Environment | Start point | What to expect |
|---|---|---|
| Claude Code | `/do` or a named skill | Native instructions, skills, hooks, and MCP after verification |
| Codex | Read `AGENTS.md`, then use installed skills | Native settings/MCP/hook behavior requires trust and hook review |
| Gemini CLI | Read `GEMINI.md`, then use installed skills | Skills and instructions are native; unavailable hooks/scripts/templates are reported, not emulated |
| OpenCode · Pi · Copilot CLI · Kiro · Antigravity | Read the projected instruction file (`AGENTS.md`, steering files, or `.github/copilot-instructions.md`), then use installed skills | Each harness gets its documented native surfaces; everything else is guidance projection |

The same shared sources drive every installation, but adapters render them into native target
formats — eight of them today. Tool-specific behavior, activation prerequisites, and per-harness
differences are in the [capability map](capability-map.md) and [Setup](setup.md).
