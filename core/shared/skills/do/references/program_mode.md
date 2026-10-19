# Program mode

For an ask larger than one feature: research it, offer roadmap shapes, hand the person a checked
draft. It writes no roadmap row and edits no source.

1. **Enter.** `/do program <goal>` enters. An ask naming more than one independently shippable
   outcome may enter: name the signal in one line and ask with the question tool (program mode
   first, "one feature" second) before any research. Anything else routes as before.
2. **Contract.** Write the sub-questions the roadmap depends on (users, scope edges, existing
   surfaces, ordering risks), at most 6. Task id: `program-<kebab-of-goal>`.
3. **Research.** One broad round over the whole goal, then one targeted round per sub-question, per
   `../do-document/references/deep_research.md`, at most 6 sources each. Dispatch independent
   sub-questions as parallel subagents where the harness has them, else in turn, each at the tier
   the guidance tree's `references/MODEL_SELECTION.md` gives: `light` to scout or extract,
   `standard` to research, `frontier` to judge the evidence and pick shapes. Mark each finding
   sourced (with its locator) or inferred. Stop when every sub-question has an answer or a stated
   gap and the last round added nothing; report the gaps. Record one evidence batch and one claim
   per conclusion under the task id, per the guidance tree's `references/EVIDENCE_LEDGER.md`.
4. **Shapes.** Offer two or three roadmap shapes through the question tool, recommended first: rows
   in outline, their order and the main trade-off. One viable shape: say why the others fell.
5. **Draft.** Write the chosen shape as `{"schema":1,"rows":[...]}`: per row `id`, `slug`, `title`,
   `class`, `needs`, a rough `writeSet`, one-line `intent`, at most 8 `acceptance` lines; nothing a
   row's own chain decides later. New rows go to `agent-docs/roadmap/draft.json` with ids above the
   store's highest; changes to rows not started go to `agent-docs/roadmap/draft-amend.json`. Ask
   before overwriting either file.
6. **Check.** Run `"$DOFLOW" roadmap seed --action check --draft <path> --json` per draft. Fix the
   findings and re-check, at most 3 times; every row of a draft must carry the same `change`. Show
   the result line, overlaps, rows that run alone and the gaps. A draft with findings is not ready.
7. **Hand over.** Show the person the `land` command `check` printed and stop. Landing is the
   person's act: never run it, and never hand it to a subagent, a policy or autopilot.
