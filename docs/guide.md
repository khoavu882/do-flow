---
description: Task recipes for features, bugs, code quality, research, docs, follow-ups, the roadmap and other tools.
---
# Guide

Pick the job and follow its commands. The mechanism behind each job is in [How DoFlow works](how-doflow-work.md),
exact flags, exit codes and settings are in [Reference](reference.md), and install steps are in [Setup](setup.md).

## Choose a path

| You want to | Start with | Section |
|---|---|---|
| Build a feature | `/do-flow` or `/do-brainstorm` | [Deliver a feature](#deliver-a-feature) |
| Find out why something fails | `/do-diagnose` | [Investigate a bug](#investigate-a-bug) |
| Improve existing code | `/do-diagnose`, then `/do-test` and `/do-code-review` | [Improve code deliberately](#improve-code-deliberately) |
| Search the project's code | `doflow retrieve --scope code` | [Retrieve code from the project](#retrieve-code-from-the-project) |
| Settle a current or uncertain fact | `/do-document --type research` | [Research before committing to a design](#research-before-committing-to-a-design) |
| Write documentation | `/do-document` | [Write and maintain documentation](#write-and-maintain-documentation) |
| Pick up what a feature left undone | `/do maintain` | [Keep track of what is left](#keep-track-of-what-is-left) |
| Advance a list of features | `doflow roadmap` | [Drive the roadmap one step at a time](#drive-the-roadmap-one-step-at-a-time) |
| Not sure | `/do`, which classifies the task and routes it | [Work across supported tools](#work-across-supported-tools) |

## Deliver a feature

Choose the guided path when the request needs requirements, design decisions, or multiple implementation steps.

### The spec-driven workflow

DoFlow treats feature delivery as a sequence of durable specifications, not one long chat. Each phase writes an artifact under `agent-docs/doflow/<feature-slug>/`; the next phase reads that artifact rather than relying on conversation memory.

| Phase | Command | Artifact | It answers |
|---|---|---|---|
| Discover | `/do-brainstorm` | `requirement.md` | What problem are we solving, for whom, and why? |
| Design | `/do-design` | `design.md` | What system shape, interfaces, and decisions satisfy the requirement? |
| Plan | `/do-plan` | `plan.md` | How will work be broken into dependency-ordered, verifiable tasks? |
| Execute | `/do-execute-plan` | Checked tasks and `state.md` | What is complete, what is next, and what blocked progress? |
| Validate | `/do-test`, `/do-code-review` | Test and review results | Does the implementation meet the agreed specification? |

The three specifications are deliberately different. Do not put implementation tasks into `requirement.md`, or repeat design decisions in `plan.md`; update the artifact that owns the decision.

### Gates and review points

`/do-flow` advances through phases automatically, but pauses where human judgment matters ([the gates](how-doflow-work.md#gates) are defined in How DoFlow works):

1. **Clarification gate:** resolve any remaining requirement ambiguity before design.
2. **Implementation gate:** review `requirement.md`, `design.md`, and `plan.md` before code changes. If any of those files is missing, an advisory hook notes a source edit but does not block it, `/do-execute-plan` stops with exit 2 on its `prereqs --require-plan` check, and the implementation handoff also needs a `READY` readiness record ([details](how-doflow-work.md#gates)).
3. **Commit gate:** review test and code-review results before using `/do-git` to commit or merge.

Use this as the normal path for a new feature:

```bash
/do-brainstorm "add team invitations"
/do-design "team invitation flow"
/do-plan
/do-execute-plan --scope next
/do-test
/do-code-review
/do-git save
```

Or use the lifecycle intents for git operations (the full list is in [Reference](reference.md#git-lifecycle-intents)):

```bash
/do-git ship          # Ship current feature to integration
/do-git release       # Full release with version bump, tag, and merge
/do-git hotfix <id>   # Create and propagate a hotfix across all branches
```

### Start or resume with one command

`/do-flow` coordinates the same path and pauses at its approval gates. It detects the active feature and starts at the first missing specification: discovery for a new feature, design when only a requirement exists, a plan when design is the missing artifact, and an implementation approval request when the specification set is complete.

```bash
/do-flow "add team invitations"   # start a new spec-driven feature
/do-flow                          # continue an existing feature from its first incomplete phase
/do-flow --from design            # deliberately rerun a phase after a material change
```

### Resume a generated plan

The plan and its checklist are the source of truth once planning is complete. `state.md` records progress so a later session can resume without reconstructing the work from chat history.

```bash
/do-execute-plan --scope resume
/do-execute-plan --scope phase:2
```

Stop and update the requirements or design if a dependency, decision, or validation result makes the plan invalid.

### Optional MCP servers in the stages

`/do-brainstorm` and `/do-design` may consult two MCP servers, `context7` and `sequential-thinking`, when you have them installed (see [Setup](setup.md#mcp-server-selection) for choosing them, the outcome words a stage records and the warning for a missing outcome). They are used only when a stage meets the condition that calls for them, never on every run:

| Stage | `context7`, when | `sequential-thinking`, when |
|---|---|---|
| `/do-brainstorm` | `requirement.md` would state a named library, API or tool's behaviour as fact | a round's open ambiguity spans two or more components, actors or requirements |
| `/do-design` | `design.md` would state a named library, API, SDK, CLI or service's interface, configuration or version behaviour as fact | Architecture Approach records a decision with a rejected alternative |

Whatever a server returns is evidence the stage weighs, not an instruction. `doflow doctor` shows these outcomes per stage over the last 20 recorded runs, and which of your harnesses have each server, in its `[MCP Consultations]` and `[MCP Servers]` sections.

When `/do-execute-plan` dispatches a task to a subagent, the brief it writes also states the model tier for that task, the tools this machine answers with for each kind of search, and which MCP servers the current stage expects (naming any the target harness cannot reach). The subagent ends its report with a `Tools used:` line, such as `Tools used: semble, rg, context7=used`, and the next handoff reads it. Tool use is recommended where it saves reading, never required.

### Bring your own context

Put the material you already have (a PRD, a meeting transcript, a design note, vendor documents) in the feature's `additional-context/` folder, loose and in any order. `/do-brainstorm` runs `doflow intake`, which sorts those files into the folders below and reports what it moved and what it left. Nothing is deleted or overwritten, every move is checked by hash, and a file saved in the last minute is left until the next run.

```bash
doflow intake --action preview        # show the moves, change nothing
doflow intake --action sort           # move the files and record the run
doflow intake --action undo           # put the last sorted run back
doflow intake --action list           # every file with its folder, kind, size and hash
doflow intake --action file-prompt --stdin   # keep pasted prompt text as a file
```

<!-- BEGIN GENERATED:intake-categories -->
| Folder | Also accepted as | Takes | Purpose |
|---|---|---|---|
| `raw-prd` | prd, requirements | .md .txt .pdf .docx, name matches prd\|requirement\|brief\|epic\|\(^\|\[^a-z0-9\]\)\(user\[-\_ \]?\)?\(story\|stories\)\(\[^a-z0-9\]\|$\) | Product requirement documents, briefs and stories as the user wrote them. |
| `hld` | design, architecture | .mmd .puml .drawio .excalidraw, into diagrams/; .png .svg .jpg .jpeg, beside a .mmd .puml .drawio .excalidraw file; .md, name matches ^\(?\!.\*\(transcript\|meeting\|minutes\|session\[-\_ \]?notes\)\).\*\(hld\|high\[-\_ \]?level\|design\|architecture\|decision\|adr\) | High-level design notes, diagram sources and their rendered images. |
| `discuss-session` | meetings | .mp3 .m4a .wav .ogg .mp4 .mov .webm, into records/; .vtt .srt, into transcripts/; .txt .md, name matches transcript\|meeting\|minutes\|discuss\|session, into transcripts/; .txt, name matches ^\(\\d{1,2}-\\d{1,2}-\\d{4}\|\\d{4}-\\d{2}-\\d{2}\)\(\[ \_T\]\\d{1,2}\[.:\]\\d{2}\(\[.:\]\\d{2}\)?\)?$, into transcripts/ | Recordings, transcripts and notes of a discussion. |
| `references` | docs, vendor-docs | .pdf .docx .xlsx .pptx .html | Reference documents, spreadsheets and vendor material. |
| `prompt` | — | — | Context pasted into the prompt, filed verbatim by the intake verb; no rule sorts a file here. |
<!-- END GENERATED:intake-categories -->

Stages cite these files as user-provided evidence, so a claim that rests on one points at the file you supplied. A package can add categories through the `intake-category` contribution point.

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

## Inspect and tune the runtime

These commands show or change how DoFlow behaves. The [command index](reference.md#command-index) has every flag and exit code, and [Settings keys](reference.md#settings-keys) lists each setting.

### Change a setting from the command line

`doflow config schema` lists every setting with its type, allowed values, default and scope, and says which ones `config set` may write; the locked review invariants appear in the same list as read-only entries. `doflow config set` validates a JSON value and writes it into one settings file:

```bash
doflow config set review.rounds 3 --layer project
doflow config validate review.preset '"review-deep"' --layer project
doflow config unset review.rounds --layer project
doflow config validate --prepared-run prepared.json   # check a prepared-run file; writes nothing
```

Quote a string value so the shell passes it as JSON. A security-relevant setting (`autopilot.enabled`, `verify.reuse`, `workers.enabled`, `workers.models`, `workers.billing`, every `advice.*`) is refused: you write those in the settings file yourself. A refused write exits 1 and changes nothing; a usage mistake exits 2. The lock, backup (`<file>.config.bak`), size and symlink behaviour of a write are in the `config set` row of the command index.

### See what a review, a rule or the primary session resolves to

All three are read-only: they write no file and no telemetry.

```bash
doflow protocol --action list [--kind review|debate]
doflow protocol --action resolve --kind review --task-class feature [--risk HIGH] [--preset review-deep]
doflow protocol --action resolve --kind debate [--preset debate-3]
doflow rules --task-class feature   # also: doflow rules -g --json
doflow primary --action resolve [--json]
```

- `protocol` prints how a review or a debate will run, so a brief can embed it as printed. `list` shows each preset with its seats, rounds, synthesizer and decider, then the invariants no setting can change; `resolve` shows the protocol one run would use and where each value came from. It has no diff to read, so a review always resolves to at least the deep preset and a `--preset` can only raise it. A looser preset exits 1; a bad flag value exits 2.
- `rules` prints the values the runtime owns (review seats and rounds, the seat floor per task class, loop limits, the tier of each agent owner, the model behind each worker tier), each with the file or settings layer it came from. Point guidance and policy text at it instead of restating numbers that go stale. A value it cannot resolve prints as `unresolved:<reason>`, never as a guess.
- `primary` prints which harness and model DoFlow takes the main session to run, from your `primary.harness` and `primary.model` settings and what the harness reported at session start. It exits 0 for every state except `refused` (1: the declared model differs from the observed one and `primary.onContradiction` is `refuse`). `doflow status` and `doflow doctor` show the same state in one line.

### Switch off the /do suggestion

On Claude Code and Codex, the first prompt of a session that reads as a plain code-change request (for example "add a retry to src/upload.js") gets a one-sentence suggestion from the model that `/do` would classify the task and apply DoFlow's checks. The model then does what you asked. It happens at most once per session, only when no `/do-*` skill is already in use, and it is keyword-based, so it can miss a request or fire on one that is not. The other harnesses get no such hook; their skill descriptions steer a plain change request to `/do`. To turn it off for one project or for yourself:

```bash
mkdir -p .doflow && echo off > .doflow/prompt-nudge                      # this project, from the repo root
mkdir -p "${XDG_CONFIG_HOME:-$HOME/.config}/doflow" && echo off > "${XDG_CONFIG_HOME:-$HOME/.config}/doflow/prompt-nudge"   # every project, this user
```

Use `on` in place of `off` to turn it back on. If both files exist, the project file wins. Whether the project file is committed or ignored is up to the project's own rules: commit it to switch the nudge off for everyone on the repository, or add it to `.gitignore` to keep the choice personal. The rules, the value table and what else the setting leaves alone are in [Prompt nudge](reference.md#prompt-nudge).

## Add and manage a package

A package is a directory with a `doflow-package.json` and the files it names. These commands are read-only and offline (no file, no telemetry, no harness needed):

```bash
doflow package --action points [--json]              # contribution points: tier (inert|instruction|executable), open or reserved
doflow package --action list [--id <id>] [--json]    # every package and whether it is in use
doflow package --action show --id <id> [--json]
doflow package --action check --path <dir> [--json]  # manifest, each contribution, file tree; no install
```

A reserved point refuses every contribution until its release opens it. `check` exits 0 when clean, 1 on an error finding (a manifest needing a DoFlow version outside the running one is one) and 2 without exactly one `--path`; a clean package prints its content and capability digests. A package is `active` when it can be used; one whose files are missing or break a rule of `check` is `incompatible`, with reason codes beside it, and affects no other package or command. `list` exits 1 unless every package is `active` or `disabled`. When the global lock on disk is version 2 (as soon as a package is recorded), an older DoFlow cannot read it and refuses it, so keep this DoFlow or a newer one while packages are recorded.

### Add a local package

Each step prints what it will do before it does it:

```bash
doflow package --action check --path <dir>          # read-only: the findings, one line per field
doflow package --action add --source <dir>          # writes a plan only; prints the plan id
doflow package --action add --plan <planId>         # records the package, still switched off
doflow package --action enable --id <id>            # switches it on; its presets join the protocols
```

`check` and `add --source` stop at the first refusal with every error listed and change nothing. A package that carries a `settings`, `order` or `enabled` field, or reuses the id of a built-in preset, is refused with the field or collision named ([forbidden fields](reference.md#package-manifest-forbidden-fields)). A package you added is not on until you run `enable`; until then a setting that names its preset is refused as unavailable. `disable` switches it off again and keeps your grants; `remove --id <id>` deletes it and prints every setting and review record that still names it. When a package declaring workers was removed and re-added, `trust` includes a `rebind` key, so worker settings (such as `workers.billing` and `workers.enabled`) apply again only after your confirmation; DoFlow never edits those files.

### Grant trust

A package that asks for more than data (a tier above `inert`) is `needs-trust` after `enable`. DoFlow does not grant trust: `doflow package --action trust --id <id>` prints one line and the file to put it in, `<config home>/packages/grants.jsonl`, and only you add it. DoFlow never writes that file. Rules for the file:

- One malformed line, an unknown key, or a line that repeats an earlier one's grant, package, version and digests (a `trust` line also its policy; a `fetch` line its source) voids every grant in the file. Lines for one package version with other digests or another policy coexist, and only the line whose digests match the installed package grants, so a trust line for new digests or a new policy is appended. When the file already holds a line with the printed line's key, `trust` says `already granted by line N` while it still grants, or `replace line N` after `revoke` or `verify --repair` revoked it; put the printed line in that place.
- Trust belongs to one content digest. When the package's files change, the old line stops counting and `update` prints a new one.
- The file is ignored when it lies inside the project or the system temp directory.

A package whose `doflow` range excludes the running version is `incompatible` with the reason beside it. A package may later declare programs (executables). Those will run as your own processes on your machine, with no sandbox or confinement around them, and a package that declares programs is not available yet.

### Add a remote package

Pass `--source git:https://example.org/acme.git@v1.2.0` (optionally `#<subdir>` before `@<ref>`) or `--source npm:acme@1.2.0` (an npm range is also accepted). Without a matching fetch grant, `add` refuses with `grant-missing`, prints the exact JSON line and the grants file path, and starts neither git nor npm. A person appends that line to the grants file, then repeats the same command.

With the fetch grant, `add` resolves the ref or range once and prints `pinned <url> <commit>` or `pinned <name>@<version>`. It fetches only that pin, checks the package and retains a snapshot under `~/.doflow/packages/fetched/<planId>/` beside the plan, for 24 hours subject to storage upkeep. `doflow package --action add --plan <planId>` checks the retained bytes again without fetching, then records the package disabled; missing or changed bytes refuse with `digest-mismatch`, so plan again. Enable and trust remain separate steps: a fetch grant authorizes fetching that source and grants no trust.

Alternatively, `doflow package --action add --index ./index.json --id acme [--version 1.2.0]` reads a local package index of at most 4 MiB (its closed JSON shape is in the `add --index` row of the command index). The whole index is refused if any entry is invalid, naming its JSON path. Without `--version`, selection takes the highest non-prerelease version compatible with this host. The index grants nothing: add the fetch line it prints (the pinned git commit as `ref`, or the exact npm version) before repeating the command, then inspect the pin, apply the plan and enable/trust as above. `update --id` accepts recorded local sources only; to replace a remote package, remove it and add a new source or index selection.

### Author a package

Use `/do package <idea>` or ask to make an idea a DoFlow package. The route lists the open contribution points, stops if the idea needs a point that is not open, asks at most three scoping questions, and runs `new`. Follow the `next` lines it prints:

1. Run `doflow package --action new --id <id> --points <point[:local],...>`. It creates checked stubs and a README in `.doflow/package/<id>/` under the project root. Use `--dir <path>` for another folder; outside a project, `--dir` is required.
2. Edit the stubs and the README's "What and why" section. Run `doflow package --action check --path <dir>` until clean.
3. Run `doflow package --action add --source <dir>` to inspect the inventory, projection and grant lines. Apply the printed plan with `doflow package --action add --plan <planId>`.
4. Run `doflow package --action enable --id <id>`. An inert package is active without a grant. Above inert, run `doflow package --action trust --id <id>`; it prints a line and the grants file path. Only a person adds that line. Run `enable` again to project trusted skills and agents into globally installed harnesses.
5. Iterate in the source folder: edit, `check`, `doflow package --action update --id <id>`, then `doflow package --action update --plan <planId>`. Every applied content change above inert needs a fresh trust line a person adds, even at the same version; the package stays `needs-trust` and its projection is removed until then. At the same version, append the new line and keep or delete the old one as you like: a line for other digests grants nothing and does not void the file, while an exact copy of a line already there does. Inert edits need no grant.

The authored folder is your source: DoFlow never prunes it or follows edits automatically. You can commit it. If the project ignores `.doflow`, make the parent traversable and add `!.doflow/package/`, as `new` reports. For example, replace a blanket `.doflow` ignore rule with `.doflow/*`, followed by `!.doflow/package/`. DoFlow never edits your ignore rules.

## Retrieve code from the project

`doflow retrieve` keeps its existing guidance search when you pass only `--query`. Use `--scope code` to search the current project. Code retrieval is lexical-only by default, and exact lookups always use the bounded lexical path. A conceptual query can request the optional hybrid profile, which combines lexical candidates with a local Semble index and falls back to lexical retrieval when Semble is unavailable or the index is stale.

Prepare the optional provider first: install Semble 0.7.0 and its required Python dependencies in the environment of the `semble` launcher (found on PATH, then in `~/.local/bin`), and keep a compatible model already present on disk. A conceptual hybrid query reads the absolute model directory from `--model-path` or `SEMBLE_MODEL_PATH`; `--index-action build|refresh` needs `--model-path` and exits 2 with `model-path-required` without it. DoFlow does not download models or install Python packages. Provider calls set the model libraries' offline flags and redirect their caches and temporary statistics into a bounded, project-local temporary directory.

Build the code index explicitly, then opt into hybrid for conceptual searches:

```bash
doflow retrieve --scope code --index-action build --root . --model-path "$SEMBLE_MODEL_PATH" --json
doflow retrieve --scope code --profile hybrid --query "where are task attempts appended?" --root . --json
```

Use `--index-action refresh` to update an existing compatible index. If a build or refresh reports an incomplete index, fix the reported cause and run an explicit bounded `build`; no query silently rebuilds or refreshes the index. Index state stays under `.doflow/index/code/semble/`. Provider faults leave lexical search available and report the gap. Hybrid remains an experimental, incomplete promotion: lexical-only is the default until repeated provider conformance and the full retrieval gate pass. The paid task-success and token-cost checks remain unreached without separate authorization; the protocol is in `bench/agentic/README.md`.

- An unknown `--scope` exits 2 and lists `guidance` and `code`.
- The search root is `--root`, or the current directory. Task state (`--task-id`, `--slug`) stays in the feature store root, so in a linked worktree the search reads that worktree's files while records go to the main checkout.
- When both providers answer, a conceptual hybrid search returns one result per file: lexical and Semble each vote for their first requested-top files, and the delivered span is the widest either returned (`origins[].locator` shows each provider's span).
- When files were left out of the corpus (an oversized file, a file-count limit, an unstaged delete or rename), the response lists a gap with source `admission`, a cause and a count, and marks the search incomplete.
- A lock left by an index operation that stopped is cleared automatically once the process that held it has exited on this host.

## Research before committing to a design

Keep current or uncertain external knowledge separate from implementation work.

```bash
/do-document "current OAuth 2.1 authorization-code guidance" --type research
/do-design "OAuth login for this application"
/do-execute-plan --scope next
```

Research produces evidence; it does not replace a design decision or validation.

During an active feature run, discovery and design each run a bounded ideation pass (the protocol in `embedded-research.md` sets the bounds), skipped when the stage's questions are already answered. Other research stays for an external fact a stage cannot establish locally, or for when you explicitly ask for it, and a stage opens it as a `research-request`. The question and results stay under the feature task ID; a blocking unanswered question keeps its dependent stage open. Web search addresses broader current questions, while Context7 addresses version-specific library documentation when the harness has those tools. An unavailable provider leaves a stated gap, not an invented answer, and a stage that could not reach `context7` records it as `unavailable` with the command that adds it. Outbound queries omit private repository content unless you approve the exact disclosure. This does not add a seventh feature stage or waive implementation, commit, or merge approval.

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

For this repository, keep one canonical home for each topic: installation in [Setup](setup.md), workflows here, the mechanism in [How DoFlow works](how-doflow-work.md), complete lookup material in [Reference](reference.md), and system concepts in [Home](index.md#the-component-model).

## Keep track of what is left

A feature rarely finishes everything it found. The lifecycle loop ([how it works](how-doflow-work.md#after-the-chain-the-lifecycle-loop)) gives deferred work one place to live, so the next feature can start from it instead of from someone's memory.

- **Follow-ups are recorded when work is deferred.** A stage that leaves something undone records it with its one-line statement and where it came from.
- **The next feature starts from them.** Discovery shows the open follow-ups before it asks you anything; you pick the ones the new feature takes, and DoFlow marks them taken by that feature.
- **A follow-up can become an intent.** Promoting one or more items creates a new intent file that names them, and each promoted item shows the intent it went to.
- **A release finishes what it shipped.** After you tag a release, `lifecycle release --confirm` records which features it carried; those features, and the follow-ups they took, become done. The release ritual previews it for you before the tag.
- **Problems in the product can be reported.** A report is an open follow-up with a body that stays on your machine.
- **Goals are optional.** A goal is one outcome with a checklist; a feature may serve one, and no feature has to.
- **`/do maintain` goes through everything open.** It lists reports, open follow-ups and (in the DoFlow repository) DoFlow's own captured failures, and you settle each one: keep, dismiss, promote, start a fix, or mark done.
- `/do program <goal>` researches a goal larger than one feature, offers roadmap shapes, writes a draft and checks it with `roadmap seed --action check`; it never writes the roadmap, you land the draft with the `land` command it shows.

DoFlow proposes and you decide. A goal is closed only when you say so, and an item is dismissed only with a reason you give.

### A worked example

Item ids are random, so yours will differ. The agent runs the same verbs through `doflow-run`; `doflow` is the same command for you. Feature `010-search` is tracked and leaves two follow-ups during review; the next feature starts from the overview and takes one:

```bash
doflow lifecycle --action init --slug 010-search
doflow followup --action add --slug 010-search --stage review --statement "Search ignores accents in the query"
doflow followup --action add --slug 010-search --stage review --statement "Search index is rebuilt on every start"
doflow lifecycle                                                        # discovery overview: open follow-ups, features awaiting release
doflow lifecycle --action init --slug 011-accents --take FU-88ggkq      # the new feature takes the first item
doflow followup --action list --state taken
```

Both features merge into `develop`. Before the tag exists, `release` is a preview and writes nothing; after `git tag v1.1.0`, `--confirm` records it, and the follow-up the shipped feature took becomes done:

```bash
doflow lifecycle --action release --tag v1.1.0             # preview: lists the features it ships and the follow-ups it finishes
doflow lifecycle --action release --tag v1.1.0 --confirm   # records the release
doflow followup --action list --state all
```

A user reports a problem (here `FU-2sb0xv` is the report), and `/do maintain` starts from the overview. For each item it asks you and runs the matching line:

```bash
doflow followup --action report --release v1.1.0 --statement "Search crashes on an empty query" --text "TypeError: query is undefined at search.js:12"
doflow lifecycle --maintain
doflow followup --action settle --ids FU-2sb0xv --as kept --reason "<why it stays>" --channel question
doflow followup --action settle --ids FU-2sb0xv --as dismissed --reason "cannot reproduce" --channel question
doflow followup --action settle --ids FU-2sb0xv --as fix --reason "<where it is routed>" --channel question
doflow followup --action settle --ids FU-2sb0xv --as done --evidence "<what shows it>" --channel question
doflow followup --action promote --ids FU-w1as7v --title "Search startup speed" --channel question
doflow lifecycle --action init --slug 012-startup --intent agent-docs/intent/search-startup-speed.md
```

Promoting creates `agent-docs/intent/search-startup-speed.md` from the item, and the next feature starts from that intent. A goal records an outcome and a checklist, and only you close it:

```bash
doflow goal --action add --goal fast-search --statement "Search feels instant" --item "Accents work" --item "Index is cached"
doflow goal --action link --goal fast-search --slug 011-accents
doflow goal --action check --goal fast-search --item C1 --evidence 011-accents
doflow goal --action done --goal fast-search --channel question --reason "caching is out of scope"
```

`goal --action done` on the default channel is refused (`not-user`) and writes nothing; with C2 unmet it needs the reason above.

### Limits worth knowing

- A merge git cannot show (a squash, a rebase, a fast-forward or a cherry-pick) is not detected as shipped. List the feature with `--feature <slug>` when you record the release, or confirm the merge with `doflow lifecycle --action merged --slug <slug> --reason "<line>"`.
- Features created before the loop existed keep working as they did; their earlier follow-ups are not collected.
- The loop runs on all seven harnesses, in every scope where the harness gets skills: installing any one of them projects the DoFlow runtime. `doflow doctor` shows which harnesses reach the runtime.

### Where it is stored

Everything lives under `.doflow/state/lifecycle/` at the root of your repository, as one small JSON file per change. The store is local to this machine and not shared: DoFlow never stages, commits or pushes it, and `.doflow/state/.gitignore` keeps it out of `git add -A`. Linked worktrees share the store of the main working tree.

Earlier versions kept the store in `agent-docs/lifecycle/events/`. The first `followup`, `lifecycle`, `goal` or `failure --action settle --as imported` command in a repository that still has that folder copies it once into the new location, leaves the old folder exactly as it was, and writes `.doflow/state/lifecycle/migrated.json`, so the old folder is never read again. If the copy fails, the command exits 1 with `store-migration-failed`, changes nothing, and the next command tries again.

Settled items are pruned after 180 days by default; open, taken and unfinished items, and feature and release records, never are. Set `DOFLOW_RETENTION_HOURS` to a positive whole number of hours to choose another window; an invalid value prints a warning, removes nothing and lets the command run. See [Storage and retention](reference.md#storage-and-retention) for the bounds of every store, `doflow storage` (it shows every store, its size and what a pass would remove, and changes nothing) and how to switch pruning off.

Machine-local pieces are kept outside the repository, under `${XDG_CONFIG_HOME:-$HOME/.config}/doflow/` ([config home](reference.md#config-home)):

| What | Where | Sent anywhere |
|---|---|---|
| Failures DoFlow captured about itself | `failures/` | Never. Recorded on this machine only |
| The full body of a report | `reports/` | Never. The project store keeps only the id, a masked excerpt and the size; a body is removed with its follow-up |

Secrets are masked before anything is written, on a best-effort basis: it is a safeguard, not a guarantee, so do not paste credentials into a report.

### Failure capture and its off switch

When a DoFlow command ends in an internal error, or the dispatcher or a guard hook crashes, DoFlow appends one masked line to a file on this machine. A bad flag, a refusal, a hook that denies a command and a missing `bash` are not recorded; a missing `jq` in a guard hook is recorded as `dependency-missing:jq`. Some environment errors, such as a permission error on a folder or a missing program, are recorded because they look like internal errors; `/do maintain` lets you settle them as noise. Capture never changes a command's output or exit status. Turn it off with:

```bash
doflow failure --action capture --set off      # writes failure.capture off to <config home>/settings.json
doflow failure --action capture --set on       # writes it back on; an existing failures/off file still turns capture off
DOFLOW_FAILURE_CAPTURE=off doflow ...          # off for one command or shell; cannot turn capture on over the file
```

Failures are for the people who maintain DoFlow: inside the DoFlow repository, `/do maintain` lists new and regressed entries and lets you import one as a follow-up. Elsewhere they are only listed by `doflow failure --action list`.

## Drive the roadmap one step at a time

`doflow roadmap` advances a list of features (the roadmap) one step per call. It is for the person or the orchestrating session that owns the roadmap; no skill advances it for you (the `do` skill's program mode may run `roadmap seed --action check` to validate new rows, which changes nothing). It is local only, it ships off, and the tests drive it against fixture repositories, so treat the flow as new. The exact flags, outcomes and exit codes are in the `roadmap` rows of the [command index](reference.md#command-index).

**The seed.** `agent-docs/roadmap/rows.json` in the main checkout declares the rows; `agent-docs/` is gitignored in this repository, so the file is yours. Each row has `id` (three digits, optionally a lowercase letter or `-` and a capital, as in `085a` or `107-A`), `slug` (starts with `<id>-`), `title` and `class` (the loop picks `feature`, `bug`, `refactor`, `documentation` and `trivial-edit` rows; `dependency-change`, `research`, `review` and `operations` rows are skipped as `class-unsupported`, and `render` shows such a not-started row as `manual`: it waits for a person, not for time), and optionally `needs` (row ids that must be merged first), `writeSet` (repo-relative paths; a trailing `/` means the subtree), `requires` (capability ids that must have a healthy provider), `mergeCommit` (a merge from before the loop existed), `hold` (one line, at most 120 characters: the row is skipped until you remove it) and `proposed` (see below). `layout.worktree` may set where a row's worktree goes; it must be a sibling of the main checkout. Never write a status: `status`, `phase` and `evidence` keys are rejected, because status comes from git.

**Adding rows while autopilot runs.** `doflow roadmap seed --action apply|amend` writes the store whether or not autopilot is on. Unless you run it in your own terminal and either autopilot is verifiably off or you answer `y` to a `[y/N]` prompt on `/dev/tty` (it lists the draft's rows and times out after 60 seconds), every row it adds or replaces lands `proposed`: autopilot never picks it, steps it or approves its gates. A person makes it ready with `doflow roadmap promote <id...>`, typed in their own terminal: it refuses a run without an interactive terminal (`needs-person-tty`), lists the named rows and asks `[y/N]` on `/dev/tty` (anything but `y` or `yes` is refused `needs-person-confirm`; no flag or variable skips the question), works whether autopilot is on or off, and changes all named rows or none. The person-only check is a terminal check: a process with a pseudo-terminal can still answer (a signed token is planned for 2.1). No wrapper script that turns autopilot off around the seed call is needed.

**The gate policy.** The loop approves gates only from `core/registry/gates.json` as committed on develop's head; it never reads the working tree, a feature branch or the package copy. A repository whose develop has no such file is denied `no-policy`, and the denial carries a hint (`annotations.hint`). Run `doflow roadmap --action init-policy` to write the installed DoFlow's policy to `core/registry/gates.json` (it refuses to overwrite an existing file and runs no git command), review it, and commit it on develop yourself. `doflow roadmap --action init-policy --commit` does that commit for you: it adds only that file to the local `develop` branch, without touching your index, working tree or checked-out branch (a reviewed `core/registry/gates.json` in the main checkout is committed as it is, else the packaged policy). If `develop` is checked out in a worktree it prints the commands to run there instead. DoFlow never pushes: pushing `develop` is yours.

```bash
doflow roadmap --action render --check   # exit 0: ROADMAP.md matches git and the seed; exit 1: findings
doflow roadmap --action render           # write agent-docs/roadmap/ROADMAP.md if it changed
doflow roadmap --action status           # merged / in-flight / not-started per row, open merge intents, run holds, the lease holder
```

**Drive `next`.** Call `doflow roadmap --action next --json` and read `outcome`:

- `acted`: the call did one mechanical step (`pick` claimed a row into a new worktree, `gate` approved a gate by policy, `merge` merged an approved row into local develop, `cleanup` rendered the table and removed the finished worktree). Call `next` again.
- `perform`: a stage needs a skill. The envelope names the `skill`, the row's `worktree` and `artifactRoot`, the argument lists in `after` and the `next` command. Run the skill in that worktree, then run each `after` command (fill the `--note <text>` placeholder), then call `next` with the `runId` it gives. If the artifact is missing or unchanged, or the stage was not handed off, `next` answers `denied: stage-not-performed` with the same envelope; a plan whose handoff the constitution check refused answers `denied: plan-exit-refused`, with the refusal in `annotations.refusal`. The implementation envelope runs `dispatch` with `--billing-cap free`, so no worker launches until you have recorded a harness's `billing` as `free` (see **Record a worker's billing**), and with `--verify-argv` from the row's seed `verifyArgv` or the worktree's `npm test`; when the dispatch completes, the loop fast-forwards the feature branch to its integration branch. The verification envelopes pass `--baseline-ref`, so a local merge you have not pushed does not widen the next row's change scope. After a merge, the envelope asks for the post-merge `verify --action report` in the develop worktree.
- `denied` or `blocked`: nothing advanced and the row waits. `reasons` says why (a gate predicate such as `blockers-open`, `stage-not-performed`, `lease-held`, or for `blocked`: `budget`, `stuck` or `quota`). Fix the cause; a denied gate is evaluated again when its inputs change.
- `idle`: nothing is ready; `skips` lists each row's reason (a `held:<reason>` skip means the row's last deny or block repeated on unchanged inputs, so it is skipped without spending budget until something it reads changes). `stopped`: the kill switch is off.

`--row <id>` restricts a call to one in-flight row and `--run <id>` names the run; the default is the open run. Only one `next` runs at a time (`lease-held` otherwise).

**Record a worker's billing.** DoFlow never says a harness is free: the registry lists every harness's billing as `unknown`, and the record is where you state that your account has no per-run charge for it (a flat subscription counts). Write the record yourself under `workers.billing` in `~/.config/doflow/settings.json` (or under `$XDG_CONFIG_HOME/doflow`). The key is global-only, so a project file cannot set it, and `doflow config` never writes it. For example, for `codex` and for `antigravity` (the `agy` CLI):

```json
{
  "schema": 1,
  "workers.billing": {
    "codex": { "billing": "free", "asserted": "2026-10-23", "basis": "flat plan, no per-run charge" },
    "antigravity": { "billing": "free", "asserted": "2026-10-23", "basis": "flat plan, no per-run charge" }
  }
}
```

Each key is a registry harness id, `billing` is `free` or `metered`, `asserted` is the real calendar date (`YYYY-MM-DD`) on which you stated it, and `basis` is an optional one-line note. A capped `dispatch start` prints one line per recorded worker, for example `billing: codex free (user record, asserted 2026-10-23)`, so you see what counts as free before any worker launches. If the record is malformed or names an id that is not a registry harness, no worker counts as free. The record says nothing about quota: when a worker runs out of quota, the fallback ladder decides what happens next. The rules for the record are under `workers.billing` in [Settings keys](reference.md#settings-keys).

**Enable workers and bind model tiers.** By default, all shipped harnesses followed by `primary` (in-session execution) are enabled in registry order. Restrict and order the eligible workers with `workers.enabled`, and assign models by tier (`light`, `standard`, `frontier`) with `workers.models`, in `<config home>/settings.json`. Validate before writing; which harnesses can run as workers is in [External worker support](reference.md#external-worker-support-by-harness):

```bash
doflow config validate workers.enabled '["worker-a","worker-b","primary"]' --layer user
doflow config validate workers.models '{"worker-a":{"standard":"vendor-model-std","frontier":"vendor-model-adv"}}' --layer user
```

**Turn it on and off.** It ships off. To turn it on, put `{"schema":1,"autopilot.enabled":"on"}` in `~/.config/doflow/settings.json` (or under `$XDG_CONFIG_HOME/doflow`). To stop it: set `DOFLOW_AUTOPILOT_ENABLED=off`, set the value to `off`, or create the file `autopilot/off` in the same folder. The switch is read before every mutating act, not only at the start of a call (a switch turned off mid-call stops the next act), and a stopped call names the layer in `annotations.switch`. A sentinel file the loop cannot read counts as set, so a permissions error stops it rather than letting it run. The environment variable and the file can only switch it off. The loop itself creates `autopilot/off` when develop gets a revert of an autopilot merge or a merge fails its post-merge check (`merged-unverified`); only you remove it. `doflow config -g` can still show `on` while only that file is set; believe the loop's `stopped`.

**What never happens automatically.** Push, tag, publish, a global install, a permission-rule change and a paid run. The loop only writes local state, local branches and worktrees, and merges an approved row into your local develop; you push. Its code spawns only `git`, and G53 and G54 fail the build if that changes. Gate-b approval is by policy: it needs a clean verify run on the exact feature head and a valid `review/findings.json` with no open blockers, and a change to the gate policy or other protected paths is never approved by the loop. Policy also never accepts a blocker marked `user-accepted` (`user-accepted-needs-person`; that gate is a person's) and never approves a plan that carries a `doflow-verification` block (`protected-path:plan-verification`), because that block would replace the post-merge check. Approval is not retroactive, with two exceptions: the loop reads develop's current policy again before it writes a merge intent (a gate-b set to `never` since then denies `policy-never`), and a plan edited after gate-b denies `plan-changed` at the post-merge step. The loop removes a finished worktree and branch only after proving the branch tip is already on develop; otherwise both are kept (`cleanup-kept`). Before the worktree is removed, its gitignored `agent-docs/doflow/<slug>/` folder is copied into the main checkout (an existing file there is never overwritten: identical bytes are skipped, differing bytes keep the worktree and are named in the audit line), and a failed copy keeps the worktree.

**When it stops.** Every `next` prints a `checkpoint` path (`.doflow/state/roadmap/runs/<runId>.json`) holding the step log and per-row state. `doflow roadmap --action audit` prints every logged step and deny. An open merge intent is in `.doflow/state/roadmap/intents/<row>.json`, and the next call resumes it. A tripwire stop is in `annotations.tripwire` and `.doflow/state/roadmap/tripwire/events.json`. `blocked: budget` means the run used its step cap (`loop.maxSteps` in `core/registry/gates.json`). The feature's decision register and orchestration journal live in its worktree and are removed with it by cleanup. The run record's log keeps only its last 500 entries, and run records are pruned 30 days after their work finishes, so it is not the durable audit; `.doflow/state/roadmap/audit.jsonl` is: it keeps the last 10000 gate, merge, render and cleanup entries with the locator and sha256 of every input they read.

**When it is stuck.**

- A merge intent denied `develop-moved` (someone committed on develop after the intent was written) or `plan-changed` (the feature plan differs from the one gate-b approved) is held: the deny is logged once, later calls skip the row as `held:develop-moved` or `held:plan-changed`, and other rows still advance. The hold ends when the intent, develop's head or the plan changes, so restoring develop or the plan lifts it. To give up that merge instead, with no `next` running, move `.doflow/state/roadmap/intents/<row>.json` to `.doflow/state/roadmap/done/<row>.json` and set `"status": "abandoned"` in it. The loop then skips the row as `intent-abandoned` and neither resumes nor replaces the intent. Archived intents are pruned 30 days after they were written; once the record is gone, the loop can write a new intent for the row.
- A run that returned `blocked: budget` never closes, and every later call on it blocks again. Start a new run by naming an unused id: `doflow roadmap --action next --run rl-<yyyymmdd>-<4 characters>` (characters from `0-9` and `a-z` without `i`, `l`, `o` and `u`). Later calls without `--run` use the newest open run. A gate-b the loop approved stays valid across runs, because the approved feature head is kept in the approval itself. The blocked record stays until its `closedAt` is set; set it by hand if you want retention to remove it.
- `lease-held` with `annotations.holder` naming a process that is gone: on the same host the next call takes the lease over itself. If the holder is on another host, its process id may have been reused, or the lease file is unreadable, the loop refuses forever by design. Check that no `next` is running, then delete `.doflow/state/roadmap/lease.json`, and `.doflow/state/roadmap/lease.reclaim` if it is there (a stale `lease.reclaim` blocks every call the same way). A call that answers `lease-lost` found its lease replaced mid-call and wrote nothing more; call `next` again.
- Scheduling covers the rows in the seed only. A `feat/*` branch, worktree or run that no seeded row names counts toward neither the cap on work in progress nor the write-set overlap check, and `status` does not list it. Look for such leftovers yourself with `git worktree list` and `git branch --list 'feat/*'`.

## Work across supported tools

| Environment | Start point | What to expect |
|---|---|---|
| Claude Code | `/do` or a named skill | Native instructions, skills, hooks, and MCP after verification |
| Codex | Read `AGENTS.md`, then use installed skills | Native settings/MCP/hook behavior requires trust and hook review |
| OpenCode · Pi · Copilot CLI · Kiro · Antigravity | Read the projected instruction file (`AGENTS.md`, steering files, or `.github/copilot-instructions.md`), then use installed skills | Each harness gets its documented native surfaces; everything else is guidance projection |

The same shared sources drive every installation, but adapters render them into native target formats, seven of them today. Tool-specific behavior, activation prerequisites, and per-harness differences are in [Setup](setup.md#what-gets-installed).
