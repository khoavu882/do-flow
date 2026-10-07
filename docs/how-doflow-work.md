# How DoFlow works

DoFlow gives an AI coding agent a **declared procedure** for a piece of work, instead of letting it
decide the procedure as it goes. The agent proposes what kind of task this is; a runtime validates
that proposal against a registry and hands back the stages, gates and contracts that apply. From
that point the run has a plan of record that neither the agent nor the user has to hold in memory.

This page describes the machinery. For where the code lives, see
[Architecture](architecture.md); for the per-skill surface, see [Reference](reference.md).

## The shape of a run

```mermaid
flowchart TB
    U["User asks for something"] --> S["A /do-* skill starts"]
    S --> P["Skill proposes ONE task class"]
    P --> V{"Runtime validates<br/>against the registry"}
    V -->|REJECTED| X["Stop. Report the valid set<br/>and ask the user to choose"]
    V -->|ACCEPTED| W["Workflow returned:<br/>stages, gates, readiness contract"]
    W --> ST["Run the stages in order"]
    ST --> G{"Gate?"}
    G -->|approval| A["Ask the user"]
    G -->|none| ST
    ST --> R["Readiness graded<br/>before any stage that edits source"]
    R --> D["Edits, then verification, then review"]
```

Two properties matter more than the diagram. **The class is proposed by the model and validated by
the runtime, never chosen by the runtime.** And **the validation checks two things**: that the class
exists, and that the skill asking is actually a stage in that class's workflow. A skill can be
refused for a class that is perfectly correct, because that class does not route through it.

## The nine task classes

Declared in `core/registry/workflows.json`. Stages name skills that already exist; the registry adds
none.

| Class | Stages | Gates | Readiness |
|---|---|---|---|
| `feature` | discovery → design → planning → implementation → verification → review | 3 | `feature` |
| `bug` | reproduction → root-cause → implementation → regression-verification → review | — | `bug` |
| `refactor` | architecture-mapping → baseline-verification → implementation → verification → review | — | `refactor` |
| `dependency-change` | release-evidence → usage-impact → implementation → verification → review | — | `dependency-change` |
| `trivial-edit` | implementation → verification | — | `trivial-edit` |
| `documentation` | authoring → verification → review | — | — |
| `operations` | state-check → preflight → execution → record | — | — |
| `review` | verification → review | — | — |
| `research` | scoping → synthesis | — | — |

The differences between them are the point. `feature` is the only class with a discovery stage, and
the only one that demands three artifacts before an edit. `refactor` has no discovery stage at all —
refactoring starts from code that already exists, so its first stage *maps* the system rather than
eliciting requirements. `refactor` also has no planning stage. `review` has no implementation stage
by construction, and `research` requires no implementation readiness, because neither authors source.

A class whose stages never mutate source declares no readiness template. That is not an omission:
there is no source edit for a contract to gate.

## Stages have kinds

Every stage declares a `kind`, and the kind decides what the stage may do.

| Kind | What it does | Mutates source |
|---|---|---|
| `discovery` | Elicit requirements through dialogue | no |
| `analysis` | Map existing structure, behaviour, root cause, or blast radius | no |
| `design` / `planning` | Decide system shape, then decompose into ordered tasks | no |
| `implementation` | Author or modify source | **yes** |
| `verification` | Run builds, suites and coverage against the tree as it stands | no |
| `review` | Assess a change and report findings; produces judgement, not edits | no |

`implementation` is the only kind that mutates the tree, and therefore the only kind a readiness
template can gate.

## Gates

A gate pauses the run between stages. Only `feature` declares any:

| Gate | After | Trigger | Asks |
|---|---|---|---|
| `gate-0` | discovery | unresolved clarifications | Resolve every open marker before design starts |
| `gate-a` | planning | always | The three artifacts are ready — proceed to implementation? |
| `gate-b` | review | always | Review is complete — proceed to commit and merge? |

`feature` additionally carries a hard hook, keyed on branch and artifact state, that blocks source
edits until its three artifacts exist — regardless of which skill is doing the editing.

## Readiness is four states, never a score

Before a stage that edits source, the runtime grades the task against its class's template from
`core/registry/readiness-templates.json`. The verdict is one of exactly four states:

| State | Meaning |
|---|---|
| `READY` | Every mandatory prerequisite is satisfied |
| `NEEDS_EVIDENCE` | The contract is understood; the prerequisites are not yet established |
| `NEEDS_USER_DECISION` | A decision is owed by the user |
| `BLOCKED` | A claim on this task is `conflicted` — its evidence disagrees with itself |

There is no fifth state, no partial state, and no numeric or percentage rendering of any of them.
The engine fails closed: a requirement it cannot evaluate reads as unmet.

Five classes have a template:

| Class | Requirements |
|---|---|
| `feature` | `scope_clear`, `affected_components`, `verification_plan` |
| `bug` | `reproduction`, `affected_code`, `root_cause`, `blast_radius`, `regression_verification` |
| `refactor` | `architecture_mapped`, `invariants_captured`, `baseline_tests`, `blast_radius` |
| `dependency-change` | `compatibility_checked`, `usage_impact`, `verification_command` |
| `trivial-edit` | `target_identified`, `scope_verified` |

Three different inputs satisfy them, and **knowing which one moved a verdict is the difference
between a contract that was met and one that was described as met**:

- **Recorded evidence** satisfies requirements that declare evidence kinds.
- **A supported claim** satisfies `root_cause`, the one requirement that demands one.
- **A caller-stated profile** satisfies the rest. These are reported separately, because nothing
  backs them but the statement.

## Evidence and claims

A stage records what it observed as an evidence batch — one pass at the stage boundary, never one
call per fact. Each item carries a `kind`, a `source`, a locator or content, and a **provenance**
that is `extracted`, `inferred`, or `asserted`, with no default. An unstated provenance is refused
rather than filed as repository fact.

The rule that does the most work: `generated-analysis` and `user-statement` can never be
`extracted`. That pairing is precisely how a reading of the evidence stops being distinguishable
from the evidence.

Conclusions are added as **claims**, stored as hypotheses. A claim becomes `supported` only by
linking evidence the ledger actually holds — a link naming an unknown id is refused, not graded. A
claim carrying both fresh support and fresh contradiction becomes `conflicted`, which is what makes
readiness report `BLOCKED`.

Relevance is not confidence. A match count, a ranking or a best hit is a property of the query, not
of the fact; the ledger records locators, never scores.

## Verification scales with risk

`core/registry/verification.json` declares nine check tiers in a fixed order —
`parse`, `build`, `static-analysis`, `targeted-tests`, `broad-tests`, `structural-invariants`,
`requirement-satisfaction`, `change-scope`, `model-review` — and four risk levels (`LOW`, `MEDIUM`,
`HIGH`, `CRITICAL`) that select how many of them a change must clear. The risk level also sets the
bound on how many times a failed check may be retried; the runtime classifies the failure and
returns the action, so no agent picks its own retry count.

## After the chain: the lifecycle loop

The chain ends with a reviewed change, but a feature rarely ends with nothing left over. The
lifecycle loop is what happens around the chain: the feature leaves follow-ups, the next feature
starts from them, a release finishes what shipped, and a maintain step settles what is still open.

```mermaid
flowchart LR
    F[Feature] --> T[Test] --> R[Review] --> S[Ship] --> L[Release] --> M[Maintain]
    F -. leaves follow-ups .-> Store[(Lifecycle store)]
    R -. leaves follow-ups .-> Store
    Store -. overview before discovery .-> F
    L -. records what shipped .-> Store
    M -. settles each open item .-> Store
```

**Four verbs, one store.** `followup` records and settles deferred work, `lifecycle` shows the
project's overview, tracks features and records releases, `goal` keeps an outcome and its
checklist, and `failure` lists what DoFlow captured about itself on this machine. They go through
the same dispatcher as every other verb, so a skill calls `doflow-run followup` and nothing
else. `/do maintain` is the entry in the `do` skill that walks the open items; it adds no skill and no task class.

**The store is a folder of events, not a file.** Each change writes one small JSON file under
`.doflow/state/lifecycle/events/`, created once and never edited or renamed. The folder is local to
this machine and not shared. Files are deleted only by the retention switch, `DOFLOW_RETENTION_HOURS`,
which removes the files of settled items older than the window it names; unset, nothing is deleted.
Beside the events sit only a marker recording the one-time copy from the old `agent-docs/lifecycle/`
folder and the retention switch's journal; there is no running state: every read lists the events,
orders them by time and id, and folds them into the current picture. Two copies that hold the same files therefore produce
the same answer, and two processes recording at the same time never write the same file. The price
is that a read grows with the number of events, which is small for this use. A transition that is
illegal at its place in the order, such as taking an item that was dismissed, is refused on write
and listed as a conflict if it arrives in a copied file.

**Derived versus recorded.** The store records what people and agents did: an item added, taken,
settled or promoted, a feature tracked, a release recorded, a goal checked. It does not record a
feature's status. Whether a feature is `in-progress`, `awaiting-release` or `finished` is derived
from git on every read, from merge evidence into the integration branch and from the release
record, so a status can never be stale and a later read can change it. A taken follow-up shows as
done only while its feature derives as finished. Because the status is a fold over facts that
existed before it, a feature created before the loop is simply untracked: nothing is derived for it
and it keeps working as it did.

**Decisions only the user makes.** DoFlow proposes and the user decides. A goal is closed only
through a user channel (`question`, `gate` or `prompt`); the default channel is refused, and a goal
with unmet items needs a reason. The agent may propose that a goal is done when every item is met,
and may nudge when a linked feature is finished while an item is unchecked, but it cannot close it.
Dismissing an item and reopening a dismissed one also need a reason, and every event records
whether the user or the agent acted.

**What it will not do.** DoFlow never stages, commits or pushes the lifecycle folder and writes no
ignore rule for it; nothing in the loop makes a network call; and no part of it blocks an edit, a
write or a commit. Failure capture is machine-local, masked and switchable off, and it never
changes the output or exit status of the command it observes.

## One seam between skills and the runtime

Every runtime call a skill can make goes through a single dispatcher,
`core/shared/scripts/doflow/bin/doflow-run`, which owns the whole verb namespace and decides per
verb whether a shell helper or a `src/cli` command serves it. Skills never name a helper and
never name a verb's implementation, so a verb can move between the two arms without any caller
changing.

A skill reaches the dispatcher by walking up from the working directory, then falling back to the
user's home install. Never by a repo-relative path — a relative path in a shell command resolves
against the user's project root, not the skill's directory.

## What this buys

The machinery exists so that a run's decisions survive the agent that made them.

- A class the runtime rejected cannot be quietly substituted for a more convenient one.
- A stage that edits source cannot start on the assumption that prerequisites will work out.
- What was measured stays distinguishable from what was stated, in the ledger and in the report.
- Where a run stopped is read from a record, not reconstructed from a transcript — so a session
  that is compacted, interrupted or resumed by a different agent picks up from artifacts and
  `git log` rather than from memory.

None of it prevents a wrong decision. It makes the decision, its basis and its author legible
afterwards, which is the property that survives the conversation.
