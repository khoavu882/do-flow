# Task Readiness Gate

Pre-implementation contract gate. **The contract is defined by
`core/registry/readiness-templates.yaml` and evaluated by the readiness engine — query it, don't
recall it.** Requirement ids and class names below are reproduced for orientation only; when this
page and the command disagree, the command is right.

```bash
"$DOFLOW" readiness --task-class <class> --task-id <id>          # human-readable report
"$DOFLOW" readiness --task-class <class> --task-id <id> --json
"$DOFLOW" evidence  --task-id <id>                               # what has been recorded so far
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
Three of the four are not reachable through the seam yet; the next section says exactly why, and
reading this table as the live behaviour without it is the mistake it warns about.

The engine fails closed: a requirement it cannot evaluate reads as unmet, not satisfied. A gate that
guesses in its own favour is worse than no gate, because it reports a verdict it never earned.

## What the gate can and cannot establish today

`readiness` is wired through the seam and computes a real verdict against the versioned templates.
But it grades three inputs, and only one of them currently has a writer — so read the states knowing
which is which.

| Input | Written by | Consequence for the verdict |
| :--- | :--- | :--- |
| Evidence | **nothing.** `EvidenceLedger.addEvidence()`/`.save()` exist and are tested, but no verb, hook or script calls them, and `evidence` is a read verb that silently ignores append-shaped flags | every `evidenceKinds` requirement reads unmet, and `evidence --task-id <id>` returns an empty ledger |
| Claims | `claim --action add` and `claim --action link`, which do persist | a claim can be recorded and stays `hypothesis`; linking an evidence id the empty ledger does not hold marks it `invalidated`, never `supported` — so `root_cause`, which requires a `supported` claim, stays unmet, and `conflicted` (which needs *fresh contradicting* evidence) cannot arise either |
| Task profile | **nothing.** The verb passes only `--task-class` and `--task-id`, deliberately: it used to assert `verificationPlan` and `scopeClear` unconditionally and reported checkmarks it had not measured | `scope_clear`, `scope_verified`, `invariants_captured`, `verification_plan`, `verification_command` and `regression_verification` all read unmet; `userDecisionPending` is never set, so `NEEDS_USER_DECISION` cannot arise |

The consequence, stated plainly rather than left to be discovered: **`NEEDS_EVIDENCE` is the only
state `readiness` can currently return through the seam.** `READY` needs an evidence writer,
`BLOCKED` needs a conflicted claim that needs fresh contradicting evidence, and
`NEEDS_USER_DECISION` needs a task-profile field the verb does not accept. Do not wait for a state
that cannot arrive, and do not read the absence of `BLOCKED` as a clean bill of health — the gate
did not evaluate that.

What the gate *does* deliver is real and worth running: the exact per-class contract, which
requirements are unmet, and the intent and capability that would satisfy each one. Act on it as the
checklist it is. Satisfy each named requirement through your own investigation, record the findings
as the phase's evidence batch in the task report, and state which requirements you established and
how. Do not halt indefinitely on a persistent `NEEDS_EVIDENCE` — and do not write `READY` yourself.
The gate did not say it, and saying it on the gate's behalf is precisely the failure this page
exists to prevent.
