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
| `documentation` | Writing or updating docs that ship with the repo — a reference page, a guide, a README section, an architecture note. |
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
- **documentation vs trivial-edit** — a one-line doc fix with a known target and a known correct
  value is `trivial-edit`; anything that has to be written, or that spans the files a doc set
  cross-references, is `documentation`.
- **documentation vs research** — `research` answers a question and files a report; `documentation`
  writes prose that ships in the tree. If the deliverable is committed alongside the code, it is
  `documentation`.

## Properties each class guarantees

These are structural facts about the resolved workflow, not advice — read them off the returned
object rather than assuming them.

- **`review`** — `hasImplementationStage: false`. There is no stage that edits source, so a review
  run never enters implementation and never consults implementation readiness. A finding leaves the
  workflow as its own task under its own class.
- **`research`** — terminates at synthesis. `requiresImplementationReadiness: false`: do not run a
  readiness check, do not report one as skipped, and do not ask for the evidence a readiness
  template would want. If the synthesis motivates a change, that change is a new task.
- **`documentation`** — no readiness template, by the same rule as `review` and `research`: the
  workflow authors no source, so implementation readiness has nothing to gate. Every claim the prose
  makes carries a locator — a figure nobody measured is the failure this class actually has. The
  verification stage is optional, and a skip must be stated with the reason the repository has no
  check the documentation can break.
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
- `fit` — whether the class's workflow has a stage for the skill that called `classify`. See below.
- `callerSuggestions` — present only on an `unknown-calling-skill` rejection. Skill ids, never class
  ids: do not offer them as an answer to "which class?".
- `workflow` — present only on `ACCEPTED`; `null` on a rejection. The run's plan of record.

Within `workflow`: `stages[]` (each with `id`, `skill`, `kind`, `purpose`, `optional`,
`readinessTemplate`, `mutatesSource`, `gatesAfter`), `stageIds`, `gates[]` (`id`, `name`,
`afterStage`, `trigger`, `prompt`), `hasImplementationStage`,
`requiresImplementationReadiness`, and `handoff`.

## Fit: does this class have a stage for the skill asking?

Pass `--calling-skill <this skill's own id>` with every `classify` call. Membership — "is this a
real class?" — is not the same question as fit — "does this class's workflow have a stage I can
occupy?" — and a class can pass the first while having nowhere to put your work.

`fit.state` is one of four:

- `HOSTED` — the class names your skill at `fit.hostedStageIds`. Proceed.
- `NOT_APPLICABLE` — you are a router (`do`, `do-flow`): you select stages rather than occupying
  one, so fit is judged one hop later by the skill you hand the work to.
- `NOT_HOSTED` — a rejection. See below.
- `NOT_EVALUATED` — **nothing was checked.** Either no calling skill was named, or it was named
  under the wrong key. This is not a pass: the decision establishes that the class exists and
  nothing more. Re-run with `--calling-skill`.

A `caller-not-a-stage` rejection is about **you**, not about the class. Answer it from
`fit.hostingClasses`, which lists every class that does have a stage for your skill and names the
stage — propose one of those, or hand the work to the skill this class names for the stage you
meant. Re-proposing the same class will be rejected the same way.

## The hard hook does not know about classes

`pre-implement-gate.sh` keys on branch and artifact state: if the current branch already carries a
feature directory missing `requirement.md`, `design.md` or `plan.md`, it denies source edits
regardless of the class in play — so a `bug` or `trivial-edit` workflow started on that branch will
be blocked at its implementation stage. Surface the hook's message as written. Do not route around
it, and do not create placeholder artifacts to satisfy it.
