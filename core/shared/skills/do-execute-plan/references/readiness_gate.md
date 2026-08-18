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

These five are the only templates that exist. `review`, `research` and `operations` are declared
task classes with **no** readiness template, by design: their workflows author no source, so there
is nothing for an implementation contract to gate. The verb exits 1 on them and lists the valid
keys — that is the right answer, not a gap. Any other unknown class fails the same way, so a typo
is loud rather than silently evaluating the wrong contract.

## Reading the report

Each unmet requirement carries a `recommendedAction` naming the **intent** and **capability** that
would satisfy it — `blast_radius`, for example, recommends `estimate-blast-radius` /
`code.impact-analysis`. Resolve it against this machine with
`"$DOFLOW" route --intent <intent> --json`, which reports the provider that actually answers here
and its fallback chain, then go gather that evidence. The gate tells you what is missing *and* how
to go get it.

| State | Meaning | What to do |
| :--- | :--- | :--- |
| `READY` | Every mandatory prerequisite is verified by fresh evidence | Proceed. |
| `NEEDS_EVIDENCE` | Contract understood, prerequisites not yet established | Gather the named requirements first. Do not start editing on the assumption it will work out. |
| `NEEDS_USER_DECISION` | A design or architectural decision is owed by the user | Ask it through the `RULE_04_QUESTIONS.md` mechanism. Do not decide it yourself and proceed. |
| `BLOCKED` | A claim on this task is `conflicted` — evidence disagrees with itself | Stop. Never modify source while blocked; surface which claim and which evidence. |

These four are the whole vocabulary. There is no fifth state, no partial state, and no numeric or
percentage rendering of any of them — a gate that emits a number invites the reader to round it up.
All four are reachable through the seam; the next section says exactly which input produces each.

The engine fails closed: a requirement it cannot evaluate reads as unmet, not satisfied. A gate that
guesses in its own favour is worse than no gate, because it reports a verdict it never earned.

## What produces each state

`readiness` grades three inputs. Knowing which one moved a verdict is the difference between a
contract that was met and one that was described as met.

| Input | Written by | What it can satisfy |
| :--- | :--- | :--- |
| Evidence | `evidence --task-id <id> --action add` — one item from `--kind/--provenance/--provider/--capability/--locator/--content`, or a whole stage from `--batch <file>` | every requirement declaring evidence kinds: `reproduction`, `affected_code`, `blast_radius`, `affected_components`, `architecture_mapped`, `baseline_tests`, `target_identified`, `compatibility_checked`, `usage_impact` |
| Claims | `claim --action add`, promoted by `claim --action link` | `root_cause`, the one requirement that demands a `supported` claim. A `conflicted` claim additionally forces `BLOCKED` for the whole task |
| Caller-stated profile | `readiness --verification-plan <text>` · `--scope <text>` · `--invariants <text>` · `--user-decision-pending` | `verification_plan`, `verification_command`, `regression_verification` (from `--verification-plan`); `scope_clear`, `scope_verified`, `invariants_captured` (from `--scope` or `--invariants`) |

So each state arrives as follows.

- **`NEEDS_EVIDENCE`** — the default answer for a task with nothing recorded. Every required
  entry the batch has not covered and no stated input satisfies is listed with its
  `recommendedAction`. This is the checklist, not a malfunction.
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
  establish, rather than a value that happens to parse. But **no verb re-marks a record `STALE`
  today**, so an old batch stays `FRESH` until something says otherwise: re-check a locator
  yourself before leaning on evidence recorded in an earlier session.
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
