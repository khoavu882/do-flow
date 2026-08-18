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
   - If `$1` matches a known `/do-*` skill (`do-flow`, `do-brainstorm`, `do-design`, `do-plan`, `do-execute-plan`, `do-test`, `do-code-review`, `do-git`, `do-constitution`, `do-diagnose`, `do-document`), forward to that skill directly.
   - Otherwise, resolve the runtime seam **once** and reuse `$DOFLOW` for every later call here:
     ```bash
     # Resolve the DoFlow runtime: nearest project install wins, then the global one.
     D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
     DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
     [ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
     [ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
     "$DOFLOW" paths --json
     ```
     The walk-up starts at the working directory, so run every command here from the project root.
     Exit 2 means no runtime was found; surface the message verbatim and stop.

2. **Multi-Part / Ambiguous Request Routing (`--depth`)**:
   - When a request bundles 2+ unrelated asks across different files or domains, verify referenced files exist first.
   - Decompose into independent or sequenced work packages, then propose **one task class per
     package** and let the runtime validate each: `"$DOFLOW" classify --task-class "<proposed>" --json`.
     Branch on the returned `outcome` field, not on the exit code. **`ACCEPTED`** → route the
     package to the first skill in the returned `stageIds`. **`REJECTED`** → **stop** for that
     package, print `message` verbatim, and ask the user to choose from `validClasses` before
     re-validating. Never substitute `feature`, and never route a package under a class the runtime
     refused. **Exit 2** → surface the message verbatim and stop.
   - For detailed decomposition and dependency graph formatting, consult `references/pm_routing.md`.
   - As the `research` workflow's `scoping` stage, this skill declares `readinessTemplate: null`.
     Do **not** call `readiness` here and do not report one as skipped — research terminates at
     synthesis and has no implementation to be ready for.

3. **Capability & Tool Selection**:
   - Routing an information need to a tool is unconditional, not a mode this skill can be asked
     for: whenever a search, graph, or testing need arises, query the Capability Router — run `"$DOFLOW" capabilities` (add `--json` to parse, `--check` for a deep
     smoke check), or `"$DOFLOW" route --intent <intent> --json` to resolve one need end to end. It
     reports which provider is actually available on *this* machine; Semble and Graphify degrade to
     Ripgrep when absent, and a static table cannot know that.
   - Consult `references/tool_matrix.md` for the intent→capability map and the two fallback layers.
     Treat the router's output as authoritative when the two disagree.

4. **Scope & Effort Estimation (`--estimate`)**:
   - When asked for sizing, complexity, or timeline estimates, produce a range anchored against git history and file scope, stating the assumptions that set its width and the unknowns that would narrow it. Never attach a numeric or percentage certainty to the range — the assumptions are the honest expression of what is not yet known.
   - Consult `references/estimation.md` for sizing breakdowns. Stops after producing the estimate; never begins edits.

5. **Batch the Scoping Evidence**:
   - Once, when the routing or estimate is delivered — not once per finding. Use one `<task id>` for
     the request: the plan task id when one exists, otherwise the feature slug.
     ```bash
     "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
     "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
     ```
   - The batch file is a JSON array, one object per item (scratch input — delete it after the
     write), validated whole: one rejected item writes nothing. Per item: `kind` (`exact-search`,
     `semantic-retrieval`, `structural`, `historical`, `documentation`, `test-result`,
     `runtime-observation`, `user-statement`, `diff`, `generated-analysis`), `provenance`
     (`extracted` | `inferred` | `asserted`, with **no default** — an unstated one is refused rather
     than filed as repository fact), and `source` (`provider` + `capability`, no `unknown`
     stand-in). `extracted` needs a `locator`; `inferred` and `asserted` need `content`;
     `generated-analysis` and `user-statement` can never be `extracted`. `id`, `freshness`,
     `supports`/`contradicts`, `stage` and any score field are refused by name.
   - The same items are the block you report: what was found, its source (the provider + capability
     the router selected, or the user's own words), its locator, and whether it is **extracted**
     (read verbatim) or **inferred** (your analysis). Never merge those two provenances into one
     line.
   - Each routing or sizing conclusion enters as a claim and is stored as a `hypothesis`; it becomes
     supported only through linked evidence. Relevance is not confidence — a match count or a
     ranking is a property of the query, so record the locator, never a score, a percentage, or a
     confidence.

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
route a package under a class the runtime rejected or replaced with `feature`; call `readiness` for
a stage that declares no template; or express an estimate, evidence or readiness as a numeric or
percentage confidence.
