# State: [FEATURE NAME]

**Feature:** [NNN-slug] · **Plan:** ./plan.md · **Status:** In Progress · **Updated:** [DATE]

> Execution state for `/do-execute-plan`. Updated after each task/phase validation — reflects
> what has actually happened, not what's intended (that's `plan.md`'s job).

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

## Completed
- [ ] [task ref, e.g. A.1] — [one-line summary]

## In Progress
- [task ref] — [what's happening now]

## Blocked
- [task ref] — [blocker] — [what's needed to unblock]

## Next Action
[the single next step — task ref + brief description, or "none, feature complete pending /do-code-review"]
