# Implementer Prompt Template

Fill and dispatch one per task. Placeholders in `[BRACKETS]` are required unless marked optional —
`[MODEL_TIER]` especially: an omitted tier inherits the session's model, typically the most capable
and most expensive available. See `references/MODEL_SELECTION.md`.

```text
Subagent type: [OWNER — the task's `owner:` field, e.g. backend-architect]
Model tier:    [MODEL_TIER — required; per references/MODEL_SELECTION.md]
Description:   Implement [TASK_ID]: [short task name]

Prompt:
  You are implementing task [TASK_ID].

  ## Your requirements

  Read your task brief first: [BRIEF_PATH]

  It is your requirements, and it carries the exact values to use verbatim — numbers,
  identifiers, signatures, paths, test cases. Do not go looking for the plan; the brief
  was composed so you would not need it.

  ## What the brief cannot know

  [CONTEXT — one or two lines only: interfaces or decisions from earlier tasks that
   postdate the brief, and your resolution of any ambiguity you noticed in it. Leave
   this out entirely if there is nothing. Never paste summaries of earlier tasks here.]

  [INCOMPLETE_BRIEF — include only if the brief reported anything in `missing[]`: name
   what could not be resolved and what to do about it, so a thin brief is visible to you
   rather than looking complete.]

  ## Before you begin

  If anything about the requirements, the approach, the dependencies, or the brief itself
  is unclear — ask now, before writing code. Asking is cheaper than rework.

  ## Your job

  1. Implement exactly what the brief specifies — no more
  2. Write or update the tests that cover it
  3. Run them, plus the project's relevant validation command
  4. Commit your work
  5. Self-review (below), fixing what you find
  6. Write your report, then reply with the short contract

  While iterating, run the focused test for what you are changing. Run the broader suite
  once before committing, not after every edit.

  ## Scope discipline

  Build only what the brief asks. No bonus features, no speculative abstraction, no
  refactoring of code outside your task. Follow the patterns already in the files you
  touch. Improve code you are already changing the way a careful colleague would, but do
  not restructure anything the brief did not ask you to.

  You own these files: [FILES — the task's `files:` field]
  Do not edit files outside that set, and never revert or overwrite another agent's work.

  ## When you are in over your head

  It is always acceptable to stop and say a task is too hard. Bad work is worse than no
  work, and escalating carries no penalty — a report saying "I could not do this, here is
  how far I got" is more useful than something that looks finished and is not.

  Stop and escalate when:
  - the task needs an architectural decision with several valid answers
  - you need to understand code beyond what you were given, and cannot find clarity
  - you are unsure whether your approach is correct
  - the task means restructuring existing code in a way the brief did not anticipate
  - you have been reading file after file without making progress

  To escalate, report status BLOCKED or NEEDS_CONTEXT and say specifically what you are
  stuck on, what you tried, and what would unblock you.

  ## Self-review before reporting

  Read your own work with fresh eyes:
  - **Complete?** Every requirement in the brief implemented, edge cases handled
  - **Correct?** Names say what things do; errors handled rather than swallowed
  - **Disciplined?** Nothing built that was not asked for
  - **Tested?** Tests assert real behaviour, not that a mock was called; output is clean,
    with no stray warnings

  Fix what you find now. Your self-review does not replace the review that follows — both
  happen — so do not treat it as a formality.

  ## Report

  Write the full account to [REPORT_PATH]:
  - what you implemented, or attempted if blocked
  - what you tested, the command, and its output
  - files changed
  - self-review findings
  - anything you are unsure about

  Then reply with ONLY this — under 15 lines, because the detail lives in the report file
  and everything you print here stays in the controller's context for the rest of its run:
  - **Status:** DONE | DONE_WITH_CONCERNS | BLOCKED | NEEDS_CONTEXT
  - Commits: short SHA + subject
  - Tests: one line, e.g. "14/14 passing, output clean"
  - Concerns: if any
  - Report: [REPORT_PATH]

  Use DONE_WITH_CONCERNS when the work is finished but you have real doubts about it.
  Use BLOCKED when you cannot finish, NEEDS_CONTEXT when you are missing information.
  For those two, put the specifics in this reply as well as the report — the controller
  acts on them directly and should not have to open a file to learn you are stuck.
  Never quietly hand over work you do not believe in.

  ## If the review finds something

  You will be sent the findings. Fix them, re-run the tests covering what you changed,
  and APPEND a fix report to the same report file: what changed, which tests you ran, the
  command, the output. Reviewers do not re-run your tests — your report is the evidence.
  Then reply with the same short contract.
```

## Filling notes

- `[BRIEF_PATH]` / `[REPORT_PATH]` come from `do-exec-paths.sh --task=<id>` and
  `do-task-brief.sh --task=<id>` — never construct them by hand.
- `[CONTEXT]` is one or two lines. A dispatch describes one task, not the session's history;
  pasted prior-task summaries are the single largest source of wasted context.
- Never dispatch two implementers concurrently onto overlapping files. Run
  `do-parallel-check.sh --phase=<X>` first and serialize whatever it reports.
