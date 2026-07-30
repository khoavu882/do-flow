# State: [FEATURE NAME]

**Feature:** [NNN-slug] · **Plan:** ./plan.md · **Status:** In Progress · **Updated:** [DATE]

> Execution state for `/do-execute-plan`. Updated after each task/phase validation — reflects
> what has actually happened, not what's intended (that's `plan.md`'s job).
>
> The **Plan:** field above is this file's identity, not decoration: a record naming a different
> plan is another run's progress, so leave it alone and start a fresh one rather than reading it as
> your own. On resume, trust this file and `git log` over recollection — conversation memory does
> not survive a compact, and a controller that lost its place can re-dispatch work already done.

## Repo Branch Status
> Populate/update as `/do-execute-plan` first touches each repo — lazily, only when that repo's
> first task executes, not upfront; this check runs for every task regardless of how many repos
> the feature started with (a plan can grow a new repo mid-execution). `Status` is `created`
> (branch didn't exist, now does) / `existing` (branch already existed, checked out as-is) /
> `blocked` (uncommitted changes were found and not silently checked out over — resolve manually).
> A `blocked` row is re-checked the next time that repo is touched; `created`/`existing` rows are
> trusted as-is, never re-checked. For a single-repo feature, write "N/A: single-repo feature"
> instead of the table.

| Repo | Branch | Status | Last Checked |
|---|---|---|---|
| [repo path] | `feat/[branch]` | created / existing / blocked | [DATE] |

## Task Ledger

> Per-task execution facts, appended as each task finishes — the durable record the status sections
> below summarise. `Rounds` is `<used>/<cap>` review-fix rounds (`0` = review passed first time,
> `—` = not reviewed). `Review` is `clean`, `N open`, or `n/a`. `Status` here is execution state, not
> the `Live`/`Superseded` vocabulary artifacts use — this file sits outside that convention.
> A task with a `complete` row is DONE: never re-dispatch it, resume at the first task without one.

| Task | Commits | Rounds | Review | Status |
|---|---|---|---|---|
| [A.1] | `[base7]..[head7]` | 0 | clean | complete |

## Findings

> Review findings that were deliberately not fixed, so nothing is discarded silently. Deferred
> minors are handed to `/do-code-review` to triage; a parked finding records the ruling that let the
> code stand. Write "None." when there are none — an empty section reads as an oversight.

- **[A.2] deferred (minor)** — [one-liner].
- **[B.1] parked** — [finding] — ruling: [why the code stands, or that it is real and deferred].

## Completed
- [ ] [task ref, e.g. A.1] — [one-line summary]

## In Progress
- [task ref] — [what's happening now]

## Blocked
- [task ref] — [blocker] — [what's needed to unblock]

## Next Action
[the single next step — task ref + brief description, or "none, feature complete pending /do-code-review"]
