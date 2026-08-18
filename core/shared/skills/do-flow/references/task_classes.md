# Task classes — proposal guide

The runtime's workflow registry is authoritative for **what runs**; this file is authoritative for
**which class to propose**. Never quote a stage list from here: get stages from `classify` or
`workflow`, so a registry edit reaches the run without a prose edit.

## Propose exactly one

- Read the request, name one class id, and hand it to `classify` as `taskClass`. That key name is
  literal — the runtime detects `class`, `type`, `taskType`, `workflow` and friends as near-misses
  and rejects the proposal rather than reading them.
- A proposal is a hypothesis, not a decision. Say what you propose and the one or two signals it
  rests on, so a wrong read is visible before the workflow runs.
- Two classes fit equally well → **ask**, do not pick the larger one. "Feature" is not the safe
  default; it is the longest workflow and the only one that demands three artifacts before an edit.
- The user naming a class outright settles it. Propose what they said, and let `classify` reject it
  if it is not a declared id.

## Cues

| Class | Propose when the request is about… |
|---|---|
| `feature` | A capability that does not exist yet and needs to be specified before it is built. |
| `bug` | Behavior that is wrong *now*, with a symptom the user can point at. |
| `refactor` | Changing structure while holding behavior fixed — extract, rename, split, de-duplicate. |
| `review` | Judging code or a diff that already exists. The deliverable is findings. |
| `research` | Answering a question. The deliverable is a written report, not a change. |
| `dependency-change` | Adding, removing, or moving the version of something the project depends on. |
| `operations` | Repository lifecycle — branch, release, merge, hotfix, backport, tag. |
| `trivial-edit` | One file, no cascade: a typo, a constant, a string, a comment. |

## Confusable pairs

- **bug vs refactor** — a bug has an observed wrong behavior; a refactor has none, and the suite is
  green before and after. If the suite is red, it is a bug.
- **bug vs trivial-edit** — a one-line change is still `bug` when the reason it is wrong has to be
  established. `trivial-edit` is for when the target and the correct value are both already known.
- **review vs bug** — reviewing produces findings; acting on a finding is a separate task with its
  own class. Do not propose `review` for work that ends in an edit.
- **research vs review** — `review` judges this repository's code, `research` answers a question
  that may have no code answer at all.
- **dependency-change vs feature** — an upgrade is `dependency-change` even when it unlocks a
  feature. The feature is the next task.
- **operations vs trivial-edit** — changing a version *string* in a manifest as part of cutting a
  release is `operations`; changing it because it is wrong is `trivial-edit` or `bug`.

## Properties each class guarantees

These are structural facts about the resolved workflow, not advice — read them off the returned
object rather than assuming them.

- **`review`** — `hasImplementationStage: false`. There is no stage that edits source, so a review
  run never enters implementation and never consults implementation readiness. A finding leaves the
  workflow as its own task under its own class.
- **`research`** — terminates at synthesis. `requiresImplementationReadiness: false`: do not run a
  readiness check, do not report one as skipped, and do not ask for the evidence a readiness
  template would want. If the synthesis motivates a change, that change is a new task.
- **`bug`** — starts from reproduction and root cause. Do not propose or apply a fix before the
  reproduction stage has recorded the failure and the analysis stage has supported a cause. A fix
  proposed at intake is the thing this ordering exists to prevent.
- **`refactor`** — needs a recorded green baseline before the first edit, so a later failure is
  attributable to the restructuring rather than argued about.
- **`dependency-change`** — starts from the upstream release evidence for the exact version range,
  not from the version number. Its verification stage runs the full suite: the blast radius is not
  bounded by the diff.
- **`operations`** — **ungated, deliberately.** The readiness registry holds no `operations`
  template, and the class claims none: the workflow authors no source, so
  implementation readiness has nothing to gate. Its equivalent safeguard is the preflight
  verification stage. Do not invent a template, and do not call `readiness --task-class operations`
  — the verb rejects it, and rightly.
- **`trivial-edit`** — deliberately the shortest workflow. Do not add checks to it; if it needs
  them, it was the wrong class.
- **`feature`** — unchanged from what `do-flow` has always run: the six-stage chain, resumed from
  the first missing artifact, stopping at unresolved clarifications, before implementation, and
  before commit or merge.

## Reading the decision

`classify` returns one object. The fields this skill acts on:

- `outcome` — `ACCEPTED` or `REJECTED`. Branch on this, never on the exit code.
- `message` — the sentence to show the user. On a rejection it already names the valid set and any
  near-match suggestions, so surface it verbatim rather than paraphrasing it.
- `validClasses`, `suggestions` — present on a rejection; the option set for the follow-up question.
- `workflow` — present only on `ACCEPTED`; `null` on a rejection. The run's plan of record.

Within `workflow`: `stages[]` (each with `id`, `skill`, `kind`, `purpose`, `optional`,
`readinessTemplate`, `mutatesSource`, `gatesAfter`), `stageIds`, `gates[]` (`id`, `name`,
`afterStage`, `trigger`, `prompt`), `hasImplementationStage`,
`requiresImplementationReadiness`, and `handoff`.

## The hard hook does not know about classes

`pre-implement-gate.sh` keys on branch and artifact state: if the current branch already carries a
feature directory missing `requirement.md`, `design.md` or `plan.md`, it denies source edits
regardless of the class in play — so a `bug` or `trivial-edit` workflow started on that branch will
be blocked at its implementation stage. Surface the hook's message as written. Do not route around
it, and do not create placeholder artifacts to satisfy it.
