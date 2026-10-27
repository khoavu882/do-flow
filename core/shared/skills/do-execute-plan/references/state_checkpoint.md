# Writing a `state.md` checkpoint (SKILL.md step 8)

- Every checkpoint: append the finished task(s) to the Task Ledger (`Commits` as the actual
  `[base7]..[head7]` range once committed, or `uncommitted (working tree)` when this run doesn't
  commit on its own), move them from **In Progress** to **Completed**, and rewrite **Status**,
  **Blocked**, **Findings** and **Next Action** (the next pending task) in place, deleting a
  blocker or finding that no longer applies, so a resumed session (or a different one) can pick up
  from this file and `git log` alone, never from conversation memory. A `Findings` entry records
  a review finding deliberately left unfixed (rare); write "None." otherwise, never omit it.
- This is bookkeeping, not a gate: a write failure here degrades resumability, not correctness —
  report it and continue rather than treating it as a task failure.
