# [Stage] Dialogue — Round [N]

**Feature:** [NNN-slug] · **Stage:** [intention|design|plan] · **Round:** [N]

> The one recurring shape every `intention/*-question.md`, `design/*-question.md` and
> `plan/*-question.md` file uses: the Socratic dialogue transcript for a single round of a chain
> stage's `AskUserQuestion` loop. This is a dialogue transcript, not an ID-bearing normative
> artifact — out of `references/ARTIFACT_FORMAT.md`'s index/detail scope, the same way that
> reference's own intro already carves out `state.md`.
>
> Not to be confused with the differently-named `{stage}-questions.md` convention in
> `rules/RULE_04_QUESTIONS.md`: that file is a *request for input*, written for a
> non-interactive harness and awaiting a `[Answer]:` tag before the run can continue. This one is
> the opposite direction — a completed *record* of a round that already happened, filed after the
> user answered, never awaiting anything.

## Question 1 — [question text as asked]

**Options offered:**
- [option A]
- [option B]
- [option C]
- Other (free text)

**Answer:** [the option the user picked, or their free-text answer, verbatim]

<!-- If the user picked "Decide for me" (or the harness's equivalent defer choice) instead of a
     normal option, do NOT record it under "Answer" as if it were one. Record it as:

     **Resolved via:** recorded assumption — [one-line rationale for the default taken]

     matching how requirement-template.md §8 Assumptions already documents a deferred answer: the
     rationale that was written down, not the fact that the user declined to choose. -->

## Question 2 — [question text as asked]

**Options offered:**
- [option A]
- [option B]

**Answer:** [verbatim]

<!-- Repeat one "## Question N" block per question actually asked this round — omit blocks for
     questions that were not asked rather than leaving placeholders behind.

     Naming: one file per Socratic round, numbered `<stage-prefix>-NN-question.md`, zero-padded to
     two digits:
       - intention/brainstorm-01-question.md, intention/brainstorm-02-question.md, ...
       - design/design-01-question.md, design/design-02-question.md, ...
       - plan/plan-01-question.md, plan/plan-02-question.md, ...
     A new round is always a new file — never appended to a prior round's file. -->
