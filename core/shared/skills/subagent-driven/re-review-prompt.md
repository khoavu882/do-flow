# Scoped Re-Review Prompt Template

Fill and dispatch once per fix round, after the implementer reports its fix. This is **not** a fresh
review — the full review already happened. Its only job is to verdict each finding and check the fix
diff for damage.

A small fix diff takes a `light`–`standard` tier; see `references/MODEL_SELECTION.md`.

```text
Subagent type: quality-engineer
Model tier:    [MODEL_TIER — required]
Description:   Re-review [TASK_ID] fix round [ROUND]

Prompt:
  You are re-reviewing one fix round. A previous review produced findings; an implementer
  has attempted to fix them. Verdict each finding and inspect the fix diff — nothing else.

  ## The task

  Read the task brief: [BRIEF_PATH]

  ## Findings under verification

  [FINDINGS — the Critical/Important findings and spec gaps from the previous review,
   copied verbatim, one per bullet. Do not summarise or re-word them: a paraphrased
   finding is a different finding, and the verdict would not mean what it says.]

  ## The fix

  Read the implementer's report — fix reports are appended at the end: [REPORT_PATH]

  **Fix base:** [FIX_BASE_SHA] (the head the previous review saw)
  **Head:** [HEAD_SHA]
  **Diff:** [DIFF_PATH]

  Read the diff file once — it holds the fix commits, the stat summary, and the fix diff
  with context. Do not re-run git commands. Your review is read-only: do not modify the
  working tree, the index, HEAD, or any branch.

  ## Scope

  Your scope is the findings list and the fix diff. Verdict every finding. Inspect the fix
  diff for problems the fix itself introduced.

  Do NOT re-review code the fix did not touch. If you notice something entirely outside the
  fix diff, report it under Out-of-scope observations — it does not block this task and does
  not extend the loop. A broad review of the whole change happens after every task is done.

  ## Tests

  The implementer re-ran the tests covering the amended code and appended the results.
  Treat that as claims: confirm the fix report names the covering tests and shows their
  output, and check the claims against the diff. Do not re-run the suite to confirm them.
  Run a test only if reading the code raises a specific doubt no existing run answers, and
  then a focused one.

  ## Output

  Your final message IS the report. Begin with the first finding's verdict — no preamble,
  no process narration.

  ### Finding verdicts

  For each finding, in the order given:
  - **[finding one-liner]** — ADDRESSED | NOT ADDRESSED, with `file:line` evidence.
    "Attempted" is not addressed. The specific defect must no longer exist.

  ### New breakage in the fix diff

  Anything the fix broke or introduced, with severity (Critical/Important/Minor) and
  `file:line`. "None" if clean.

  ### Out-of-scope observations

  Issues entirely outside the fix diff. Non-blocking — the controller records these for the
  final review. "None" if none.

  ### Verdict

  **Fix round:** All findings addressed, no new Critical/Important breakage
              |  Findings remain open — [list them]
```

## Filling notes

- `[DIFF_PATH]` comes from `do-review-package.sh --task=<id> --base=<FIX_BASE> --head=<HEAD>`, where
  `FIX_BASE` is the head the **previous** review saw. Because packages are named per range, this
  produces a fresh file rather than the one the first review already read.
- `[FINDINGS]` is verbatim. This is what makes a verdict meaningful: ADDRESSED against a reworded
  finding does not tell you the original defect is gone.
- New Critical/Important breakage in the fix diff joins the open findings list for the next round.
  Out-of-scope observations never do — they go to the ledger as deferred minors. That asymmetry is
  what stops a fix loop from wandering into an unbounded review.
