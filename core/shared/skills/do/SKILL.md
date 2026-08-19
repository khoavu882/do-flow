---
name: do
description: "DoFlow universal dispatcher and request router — session announcement, multi-part task decomposition, capability routing, and development estimation. Use when a request doesn't clearly name one of the other /do-* skills, bundles multiple unrelated asks across files or domains, or needs a tool recommendation or effort estimate before any work begins — for example 'what should I use to search this repo' or 'give me a rough estimate for this change'."
argument-hint: "[command|request] [--depth shallow|normal|deep] [--estimate]"
effort: low
---

# do

Universal command dispatcher, task decomposer, capability router, and development estimator for DoFlow.

## Invocation
```text
/do [command|request] [--depth shallow|normal|deep] [--estimate]
```

## Behavioral Flow

1. **Session & Command Dispatch**:
   - If invoked with no arguments or `--help`, announce DoFlow session status and display the core command reference.
   - If `$1` matches a known `/do-*` skill (`do-flow`, `do-brainstorm`, `do-design`, `do-plan`, `do-execute-plan`, `do-test`, `do-code-review`, `do-git`, `do-constitution`, `do-diagnose`, `do-document`, `do-implement`), forward to that skill directly.
   - Otherwise, resolve the runtime seam **once** and reuse `$DOFLOW` for every later call here:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```
Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print the message verbatim and stop; it names every path searched.

```bash
"$DOFLOW" paths --json
```

2. **Multi-Part / Ambiguous Request Routing (`--depth`)**:
   - When a request bundles 2+ unrelated asks across different files or domains, verify referenced files exist first.
   - Decompose into independent or sequenced work packages, then propose **one task class per
     package** and let the runtime validate each: `"$DOFLOW" classify --task-class "<proposed>" --calling-skill do --json`.

Branch on the returned `outcome` field, not the exit code.
- **`ACCEPTED`** — the returned `workflow` is this run's plan of record; read `stages`, `gates` and `handoff` off it rather than from memory.
- **`REJECTED`** — **stop.** Print `message` verbatim (it already names `validClasses` and any `suggestions`), ask the user to choose from `validClasses`, then re-validate. Never substitute `feature`.
  A rejection may be about **you** rather than the class (`reason: caller-not-a-stage`). Then the fix is to propose one of the classes in `fit.hostingClasses`, or to hand the work to the skill this class names for the stage you meant — not to re-propose the same class.
- **Exit 2** — surface the message verbatim and stop.

Route the package to the accepted workflow's first stage. A workflow whose `stages` contain nothing
that does the package's work is a misclassification — re-propose the class rather than routing the
package under one the runtime accepted for a different kind of task.

   - For detailed decomposition and dependency graph formatting, consult this skill's own
     `references/pm_routing.md`.

3. **Capability & Tool Selection**:
   - Before routing, check what recorded runs already show — run `"$DOFLOW" discover --json`
     (reuse `$DOFLOW` resolved in step 1). **It exits 1 when there is a finding — that is signal,
     not failure; never treat that exit code as an error.** When the analysis cannot be settled
     from the recorded metadata, `discover` reports `UNKNOWN` rather than "clear"; surface `UNKNOWN`
     as undetermined and never round it up to "no missed opportunities". `do` surfaces the finding
     to the user — it takes no automatic action on it, and no finding is ever rendered as a number,
     a percentage, or a confidence.
   - Routing an information need to a tool is unconditional, not a mode this skill can be asked
     for: whenever a search, graph, or testing need arises, query the Capability Router — run `"$DOFLOW" capabilities` (add `--json` to parse, `--check` for a deep
     smoke check), or `"$DOFLOW" route --intent <intent> --json` to resolve one need end to end. It
     reports which provider is actually available on *this* machine; Semble and Graphify degrade to
     Ripgrep when absent, and a static table cannot know that.
   - Consult this skill's own `references/tool_matrix.md` for the intent→capability map and the two
     fallback layers. Treat the router's output as authoritative when the two disagree.

4. **Scope & Effort Estimation (`--estimate`)**:
   - When asked for sizing, complexity, or timeline estimates, produce a range anchored against git history and file scope, stating the assumptions that set its width and the unknowns that would narrow it. Never attach a numeric or percentage certainty to the range — the assumptions are the honest expression of what is not yet known.
   - Consult this skill's own `references/estimation.md` for sizing breakdowns. Stops after
     producing the estimate; never begins edits.

**Stop when** every width-setting assumption the contract names has an answer or a stated gap, **and** the last round produced no new width-setting assumption. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

5. **Batch the Scoping Evidence** — once, when the routing or estimate is delivered, not once per
   finding. Use one `<task id>` for the request: the plan task id when one exists, otherwise the
   feature slug.

```bash
"$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
"$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
```
This stage's items are the scoping inputs: what the router reported, what git history and file scope
showed, and the user's own words. Each routing or sizing conclusion enters as a claim.

Item schema, provenance rules, and the refused-field list: the guidance tree's `references/EVIDENCE_LEDGER.md`. Read it before writing the batch.

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
| `/do-implement` | Direct, standalone implementation from a description or review findings — no chain artifacts required | Extension |

## Boundaries
**Will:** Announce session status, route single and multi-part requests, propose a task class per
package and have the runtime validate it, select optimal retrieval tools, generate scoped
estimates, and batch the scoping evidence and claims.
**Will Not:** Directly perform code edits or modify source files (delegates to specialist skills);
route a package under a class the runtime rejected or replaced with `feature`;
call `readiness` for a stage that declares no template; or express evidence, an estimate or readiness as a number, a percentage or a confidence.
