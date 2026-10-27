# Logging each dialogue round

Steps named here are SKILL.md's.

**Log each round.** One file per round, never appended to a prior round's file:
`agent-docs/doflow/<slug>/intention/brainstorm-<NN>-question.md`, shaped by
`templates/doflow/question-log-template.md` (same install path resolution as the requirement
template in step 5) — every question as asked, the options offered, and the answer given, with a
"Decide for me" pick recorded as the assumption it becomes rather than as an answer, and the
template's `## Coverage` block: one line per requirement area, Clear, Partial, Missing or Deferred,
so an area the round skipped is visible rather than silent. `<NN>` is
zero-padded to two digits and starts at step 1's `intention_next_round` — never hand-counted:
the resolver already scanned the subdir, and this session's second round is that value plus one,
its third plus two. Write the round's file as soon as its answers land, `mkdir -p` the
`intention/` directory first. If `feature_slug` was still null at step 1 (a trunk branch with no
feature picked yet), there is no directory to write into until step 4 resolves one — hold the
rounds and write them all, in round order, immediately after step 4's `mkdir`.
