# Triggering decision — do-diagnose eval-1

**Prompt:** "The test suite here has gotten noticeably slower this week and I don't know why."

**Decision:** ROUTES TO do-diagnose (YES)

**Basis:** do-diagnose's frontmatter description (read from
`.claude/skills/do-diagnose/SKILL.md` in this sandbox) triggers on "Use when something is broken,
slow, insecure, or needs cleanup and the user wants root-cause evidence before any fix, or says
... 'this endpoint feels slow' ... rather than asking for a brand-new feature." The prompt reports
a slowdown ("noticeably slower") and an unknown cause ("I don't know why"), which is a root-cause
request, not a feature request. Investigation mode would be `--type perf` per the skill's own
"Classify Intent & Scope" section.

**Corroborating real measurement (this sandbox, not guessed):** `time npm test` here reports
573 tests, 572 pass, 1 pre-existing fail, `duration_ms` 20499.36, wall clock 20.705s (171% cpu) —
confirming the premise is grounded in a real, non-trivial suite (this repo's actual 573-test
`node --test` run), which is exactly the kind of real signal do-diagnose's evidence-first flow
would investigate further (see the companion behavioral case, eval-2, for the full root-cause
breakdown of where that time goes).
