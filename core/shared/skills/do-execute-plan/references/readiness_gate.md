# Task Readiness Gate

Pre-implementation contract gate. The contract is versioned and lives inside the runtime, not on
this page and not in your repository: **query it through the verb, don't recall it.** The class
names and requirement ids below are reproduced for orientation only — when this page and the
command disagree, the command is right.

```bash
"$DOFLOW" readiness --task-class <class> --task-id <id>          # human-readable report
"$DOFLOW" readiness --task-class <class> --task-id <id> --json
"$DOFLOW" evidence  --task-id <id>                               # what has been recorded so far
"$DOFLOW" evidence  --task-id <id> --action add --batch <file>   # record this stage's batch
"$DOFLOW" claim     --task-id <id> --action list                 # and what has been concluded
```

`$DOFLOW` is the handle `SKILL.md` step 1 resolves; run these from the project the task belongs to,
because evidence and claims are per-project state under that repo's `.doflow/state/evidence/`, not
global.

**Both `--task-class` and `--task-id` are required on `readiness`.** Omitting either exits 2 with
the valid set named — the verb refuses rather than grading the wrong class or the wrong task.
`readiness` then exits **0 for every state it can compute**, so branch on the `state` field; a zero
exit says the contract was evaluated, not that it was met.

## Task classes

Pass the **key**, not the display name — `--task-class feature`, not `"New Feature"`.

| Key | Contract | Requirements |
| :--- | :--- | :--- |
| `bug` | Bug Fix Readiness | `reproduction`, `affected_code`, `root_cause`, `blast_radius`, `regression_verification` |
| `feature` | Feature Implementation Readiness | `scope_clear`, `affected_components`, `verification_plan` |
| `refactor` | Refactoring Readiness | `architecture_mapped`, `invariants_captured`, `baseline_tests`, `blast_radius` |
| `trivial-edit` | Trivial Edit Readiness | `target_identified`, `scope_verified` |
| `dependency-change` | Dependency Change Readiness | `compatibility_checked`, `usage_impact`, `verification_command` |

These five are the only templates that exist. Every other declared task class has **no** readiness
template, by design: those workflows author no source, so there is nothing for an implementation
contract to gate. Which classes those are is a property of the resolved workflow —
`requiresImplementationReadiness: false` — not a list to carry here. The verb exits 1 on them and lists the valid
keys — that is the right answer, not a gap. Any other unknown class fails the same way, so a typo
is loud rather than silently evaluating the wrong contract.

## Reading the report

Each unmet requirement carries a `recommendedAction` naming the **intent** and **capability** that
would satisfy it — `blast_radius`, for example, recommends `estimate-blast-radius` /
`code.impact-analysis`. Resolve it against this machine with
`"$DOFLOW" route --intent <intent> --json`, which reports the provider that actually answers here
and its fallback chain, then go gather that evidence. The gate tells you what is missing *and* how
to go get it.

| State | Meaning |
| :--- | :--- |
| `READY` | Every mandatory prerequisite is verified by fresh evidence |
| `NEEDS_EVIDENCE` | Contract understood, prerequisites not yet established |
| `NEEDS_USER_DECISION` | A design or architectural decision is owed by the user |
| `BLOCKED` | A claim on this task is `conflicted` — evidence disagrees with itself |

These four are the whole vocabulary. There is no fifth state, no partial state, and no numeric or
percentage rendering of any of them — a gate that emits a number invites the reader to round it up.
All four are reachable through the seam; the next section says exactly which input produces each.

**What to do about a state is not this page's call, and not yours** — the runtime owns the one
stage-entry policy and every report carries its answer as `stageEntry: {decision, reason}`
(`Stage Entry:` in the human report), computed from the state and the execution mode you declare
with `--mode`:

| | `--mode workflow` (default) | `--mode standalone` |
| :--- | :--- | :--- |
| `READY` | `ENTER` | `ENTER` |
| `NEEDS_EVIDENCE` | `GATHER_FIRST` — gather the named requirements before entering the stage | `ENTER` — the unmet contract is reported, not enforced; relay it in the result |
| `NEEDS_USER_DECISION` | `ASK_USER` — ask through `RULE_04_QUESTIONS.md` and wait | `ASK_USER` — same; a small edit does not cure an owed decision |
| `BLOCKED` | `STOP` — never modify source; surface which claim and which evidence | `STOP` — same |

`workflow` is an orchestrated run (`do-flow`, `do-execute-plan`); `standalone` is a declared
one-off edit (`do-implement`, `do-diagnose --fix`). The mode is a flag, never an inference — an
absent evidence record is not a statement of intent, so the default fails closed to `workflow`.
Act on `decision`; do not re-derive the answer from `state`, because a policy re-derived in prose
is exactly how three skills came to disagree about the same state.

The engine fails closed: a requirement it cannot evaluate reads as unmet, not satisfied. A gate that
guesses in its own favour is worse than no gate, because it reports a verdict it never earned.

## What produces each state

`readiness` grades three inputs. Knowing which one moved a verdict is the difference between a
contract that was met and one that was described as met.

| Input | Written by | What it can satisfy |
| :--- | :--- | :--- |
| Evidence | `evidence --task-id <id> --action add` — one item from `--kind/--provenance/--provider/--capability/--locator/--content`, plus `--establishes <req-id[,req-id]>` and (for executions) `--observed-command`/`--observed-exit`; or a whole stage from `--batch <file>` | every requirement declaring evidence kinds: `reproduction`, `affected_code`, `blast_radius`, `affected_components`, `architecture_mapped`, `baseline_tests`, `target_identified`, `compatibility_checked`, `usage_impact` |
| Claims | `claim --action add` (with `--role root-cause` where the contract names a role), promoted by `claim --action link` | `root_cause`, the one requirement that demands a `supported` claim **in the `root-cause` role**. A `conflicted` claim additionally forces `BLOCKED` for the whole task |
| Caller-stated profile | `readiness --verification-plan <text>` · `--scope <text>` · `--invariants <text>` · `--user-decision-pending` | `verification_plan`, `verification_command`, `regression_verification` (from `--verification-plan`); `scope_clear`, `scope_verified`, `invariants_captured` (from `--scope` or `--invariants`) |

So each state arrives as follows.

- **`NEEDS_EVIDENCE`** — the default answer for a task with nothing recorded. Every required
  entry the batch has not covered and no stated input satisfies is listed with its
  `recommendedAction`. This is the checklist, not a malfunction.

  An item counts toward a requirement only when it is `extracted` **and** names that requirement
  in `establishes` — kind alone is a category, and an inferred item is analysis, not measurement.
  Where the contract expects an execution (`reproduction`, `baseline_tests`), the item must carry
  the observation `{command, exitCode}` it records, and `baseline_tests` additionally requires
  exit 0: a run that failed is reported as the failure it was. A bug reproduction succeeds by
  observing the expected failure, so a non-zero exit there is the evidence, not a defect in it.
- **`READY`** — recorded evidence plus stated inputs cover every required entry. Each satisfied
  requirement names the evidence ids that satisfied it in `evidenceIds`; a requirement satisfied
  by a *stated* input carries an empty `evidenceIds`, because nothing backs it but the statement.
- **`BLOCKED`** — a claim on the task is `conflicted`: it carries both fresh supporting and fresh
  contradicting evidence. Blocking is checked before requirements, so `BLOCKED` outranks
  `NEEDS_EVIDENCE` — a blocked task is not "also missing things", it is stopped.
- **`NEEDS_USER_DECISION`** — you passed `--user-decision-pending`. It returns before any
  requirement is examined, so that report carries no requirements breakdown. It records that a
  decision is owed; it is not a way to skip the gate.

**Measured and stated are reported apart, and must stay apart when you repeat the verdict.** The
JSON report lists every stated input under `callerAsserted`; the human report prints
`Caller-stated: … (asserted on the command line, not established by evidence)`. Pass those flags
when they are true — that is what they are for — but a `READY` that rests partly on them is only as
good as the statement, and saying so is the difference between reporting a verdict and laundering
one.

Three limits still hold, and none of them is a reason to work around the gate:

- Only evidence whose `freshness.status` is `FRESH` counts. The write measures freshness itself —
  HEAD commit, sha256 of the located file, `observedAt` — and records `null` for anything it cannot
  establish, rather than a value that happens to parse. Every `readiness` read and every gated
  stage completion re-checks those stamps against the tree as it stands — the same evaluation at
  both boundaries — so an item whose file has changed since it was read reports `STALE` and stops
  counting toward the requirement it named, and the report names it. Recording fresh replacement
  evidence alone does not clear this: a stale item stays in the ledger and keeps forcing
  `NEEDS_EVIDENCE` at the task level until it is explicitly retired. Once the fresh replacement is
  recorded, supersede the stale item: `evidence --action supersede --evidence-id <stale-id>
  --replaced-by <fresh-id>`. Do not argue with the verdict by any other route — not by re-adding the
  same fact under a new id and hoping the old one stops mattering, and never by editing the local
  ledger file directly.
- `claim --action link` refuses an evidence id the ledger does not hold (exit 2). Record the batch
  first, then link; a link is not a way to reference evidence you have not written.
- The gate grades this task's ledger only. A different `--task-id` reads a different record, and
  the verdict will look confident either way.

What the gate delivers is worth running for its own sake: the exact per-class contract, which
requirements are unmet, and the intent and capability that would satisfy each one. Act on it as the
checklist it is. Do not halt indefinitely on a persistent `NEEDS_EVIDENCE` — record what you
actually established, state which requirements it covers, and say what remains. And do not write
`READY` yourself. The gate did not say it, and saying it on the gate's behalf is precisely the
failure this page exists to prevent.
