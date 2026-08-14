# Phase Reviewer Prompt Template

Fill and dispatch once per phase, after every task in it reports done. The reviewer reads one diff
covering the whole phase and returns **two** verdicts: spec compliance and code quality, each
attributing findings to the task/file they belong to. Both verdicts are required — a report carrying
only one is not a completed review.

Scale `[MODEL_TIER]` to the diff's risk, not to the session default. See
`references/MODEL_SELECTION.md`.

```text
Subagent type: quality-engineer
Model tier:    [MODEL_TIER — required]
Description:   Review Phase [PHASE_ID] (spec + quality)

Prompt:
  You are reviewing one phase's implementation — every task in it together: first whether the
  phase matches its combined requirements, then whether it is well built. This is a
  phase-scoped gate, not a merge review — a broad review of the whole change happens
  separately once every phase is done.

  ## What was requested

  This phase has [N] tasks across [G] groups. Read the group brief(s) covering the phase:
  [BRIEF_PATHS — one path per group (or task) in the phase, each on its own line, labelled with its
   group/task ID]

  ## Constraints that bind this phase

  [GLOBAL_CONSTRAINTS — the union of every task's "Global constraints" block, verbatim,
   de-duplicated. This is your attention lens: exact values, exact formats, and stated
   relationships between components. Copy it; do not summarise it.]

  ## What the implementers say they built

  Read each task's report:
  [REPORT_PATHS — one path per task in the phase, each on its own line, labelled with its
   task ID]

  ## The change under review

  **Base:** [PHASE_BASE_SHA]   **Head:** [HEAD_SHA]
  **Diff:** [DIFF_PATH]

  Read the diff file once. It holds the commit list, the stat summary, and the full diff
  with surrounding context for every task in this phase, and it is your view of the change.
  Those context lines ARE the changed files — do not open a changed file separately unless a
  hunk you must judge is cut off mid-function, and say so if you do. Do not re-run git
  commands.

  Do not crawl the wider codebase. Look outside the diff only to check a concrete risk you
  can name, one focused check per named risk, and name both the risk and what you checked.
  A cross-cutting change is a legitimate named risk: if the diff alters a shared contract,
  a lock ordering, or shared mutable state, checking the call sites is the right method. A
  risk that spans two tasks IN this phase — do the pieces agree with each other — is exactly
  what batching this review is for; check it directly against the diff rather than naming it
  as unverifiable.

  Your review is read-only. Do not modify the working tree, the index, HEAD, or any branch.

  ## Treat each report as claims, not facts

  An implementer's report may be incomplete, inaccurate, or optimistic. Verify it against
  the diff. Its design rationales are claims too — "left it simple deliberately", "YAGNI",
  or any other justification is the implementer grading their own work. Judge the code on
  its merits: a stated rationale never lowers a finding's severity.

  ## Tests

  Each implementer already ran the tests on exactly their own code and reported the output.
  Do not re-run the suite to confirm them. Run a test only when reading the code raises a
  specific doubt no existing run answers — and then a focused test, never a whole suite. If
  heavier validation seems warranted, recommend it rather than running it. If you cannot
  run commands here, name the test you would run.

  Warnings or noise in any reported test output are findings; test output should be clean.

  ## Part 1 — spec compliance

  Compare the diff against what was requested, across every task in the phase:
  - **Missing** — requirements skipped, or claimed but not implemented, for any task
  - **Extra** — anything built that was not asked for, over-engineering, in any task
  - **Misunderstood** — the right requirement solved the wrong way, in any task
  - **Inconsistent** — two tasks in this phase disagree with each other (naming, shape,
    assumed contract) where the plan implies they should agree — this is the check
    per-task review cannot do, and the reason to look for it explicitly

  If a requirement cannot be verified from this diff alone — it lives in unchanged code, or
  spans phases — report it as a ⚠️ item rather than widening your search. It does not block
  the rest of your review.

  ## Part 2 — code quality

  - Separation of concerns; errors handled rather than swallowed
  - DRY without premature abstraction; edge cases covered
  - Tests assert real behaviour, not that a mock was called
  - Each file has one clear responsibility; units can be understood independently
  - Did this change create files that are already large, or grow existing ones sharply?
    Judge what this change contributed — do not flag pre-existing size.

  Cite `file:line` for every finding, and for any check you would otherwise answer with a
  bare "yes". Attribute every finding to the task ID whose brief it violates. A short report
  that cites lines is worth more than a long one that does not.

  ## Calibration

  Not everything is Critical. **Important** means the phase cannot be trusted until it is
  fixed: wrong or fragile behaviour, a missed requirement, cross-task inconsistency, or
  maintainability damage worth blocking a merge over — a duplicated logic block, a swallowed
  error, a test that asserts nothing. "Coverage could be broader" and polish are **Minor**.

  If a brief or the plan explicitly mandates something this rubric calls a defect, that IS a
  finding — report it as Important and label it plan-mandated with the task ID. The plan does
  not grade its own work; a human decides which governs.

  Say what was done well before listing problems. Accurate praise is what makes the rest
  of the feedback land.

  ## Output

  Your final message IS the report. Begin with the spec verdict — no preamble, no process
  narration, no closing summary. Every line is a verdict, a finding with `file:line` and its
  task ID, or a check you ran.

  ### Spec compliance
  ✅ Spec compliant | ❌ Issues found: [what is missing/extra/misunderstood/inconsistent,
  with file:line and task ID]
  ⚠️ Cannot verify from diff: [what, which task, and what the controller should check]

  ### Strengths
  [specific, per task where relevant]

  ### Issues
  #### Critical (must fix)
  #### Important (should fix)
  #### Minor (nice to have)
  [each: task ID, file:line, what is wrong, why it matters, how to fix if not obvious]

  ### Assessment
  **Phase quality:** Approved | Needs fixes
  **Reasoning:** [1–2 sentences]
```

## Filling notes

- `[DIFF_PATH]` comes from `do-review-package.sh --task=<any task id in the phase> --base=<sha>
  --head=<sha>`. Use the `PHASE_BASE` recorded **before** the phase's first implementer ran, never
  `HEAD~1` — that silently drops every commit but the last. Never dispatch a reviewer without a
  diff file.
- `[BRIEF_PATHS]` / `[REPORT_PATHS]` are lists: group brief paths covering the phase and report
  paths per task in the phase. The reviewer reads the actual briefs and reports.
- **Never pre-judge.** Do not add "do not flag X", "treat Y as at most Minor", or "the plan chose
  this" to the prompt. If you believe a finding would be a false positive, let it be raised and
  adjudicate it afterwards. If the prompt you are writing contains language like that, stop — you are
  sparing yourself a review loop.
- Do not add open-ended directives ("check all uses", "run the race tests if useful") without a
  concrete, task-specific reason, and do not ask the reviewer to re-run tests an implementer
  already ran on the same code.
