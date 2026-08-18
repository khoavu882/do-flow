# D.4 — post-rewrite evaluation delta

**Baseline** `boundary` @ `34b5233` (pre-rewrite) · **Comparison** `d3` @ `704fb33` (post-rewrite)
Model `claude-sonnet-5` · 33 cases · **provenance `verified` 33/33 in both iterations**

| | baseline | d3 | delta |
|---|---:|---:|---:|
| mean auto pass rate | 0.884 | **0.934** | **+0.051** |
| improved | — | 3 | |
| regressed | — | 1 | |
| unchanged | — | 29 | |

Drift is reported, not blocked. Both iterations were graded by one assertion set, at their own
commit — grading resolves the expected skill hash at the commit recorded in each iteration's
`iteration.json`, so the baseline stays re-gradeable after the tree it measured has moved on.

## Improved

| case | | what changed |
|---|---|---|
| `do-test/2` reports-failures-honestly | 0.50 → 1.00 | The pre-rewrite skill described a verification contract and contained **no command at all** — it asserted a verdict nothing produced. It now compiles the contract before running (`tiers[]`, `riskLevel`, `maxRecoveryIterations`, `detection.absent`), runs, then reports. The run returned `INCONCLUSIVE — "Required tier(s) were never evaluated: change-scope"` over a genuinely green 572/572 suite, and reported both facts rather than letting the green suite stand in for the verdict. |
| `do-diagnose/1` perf-complaint-invokes-diagnose | 0.50 → 1.00 | Measured instead of asserted. Handed "the suite got slower this week", it **falsified the obvious hypothesis**: the 24 new test files add 23.1s of serial work but ~1.1s of wall. Real cause is `test/cli-e2e.test.js` on the critical path. |
| `do-constitution/2` amend-bumps-semver | 0.00 → 1.00 | The underlying skill defect is **unchanged** — `--amend` against a repo with no constitution still has no `(false, --amend)` arm and still takes the create path. What improved is honesty: the run recorded the mismatch in its Sync Impact Report instead of emitting `0.1.0` silently. Scored as an improvement in reporting, not in behaviour. |

## Regressed

**`do/1` multi-part-request-routes, 1.00 → 0.67 — genuine drift, and a gap in the class taxonomy.**

The run decomposed the request correctly into three packages and classified each through the
runtime. The documentation package — "document the flag in `docs/reference.md`" — classified as
`trivial-edit`, whose workflow is `do-implement → do-test`. So it never named `do-document`, and the
assertion looking for that name failed.

The classification is defensible: a one-line doc edit *is* a trivial edit. The problem is upstream.
`do-document` appears as a stage in exactly three classes — `research`, `dependency-change`,
`operations` — and none of them describes "write or update documentation". Before C.6 made `do`
class-aware, it named skills directly and could route straight to `do-document`; class-based routing
has no path from "document this" to that skill unless the work is also research, a dependency bump,
or an operation.

This is the real finding of the comparison. Either the taxonomy needs a documentation class, or
`do`'s prose should stop implying that class routing reaches every skill.

## Two assertion defects fixed during grading, both re-graded on both iterations

Neither is a behaviour change, and both were fixed before the numbers above were computed — a fix
applied to one iteration only would manufacture a delta.

1. **13 `skill_invoked` assertions could never pass, 1 `skill_not_invoked` could never fail.** A.5's
   by-path contract requires cases *not* to invoke by name, so `invoked_skills.json` is empty by
   construction. Replaced with `skill_resolved`, which proves by hash that the run read this repo's
   copy. This alone moved the baseline's recorded mean from 0.667 to 0.884 — the earlier figure
   measured the harness, not the skills.
2. **`do-design/2` failed on its own evidence.** The assertion "the design does not use `C4Context`"
   was scoped to all of `outputs/`. `design.md` had zero occurrences; the *evidence ledger* recorded
   the claim "does not use the C4Context or C4Container diagram type", and the record of compliance
   failed the compliance check. Absence assertions now take an optional `file:` scope.
   Worth stating: this only appeared because C.12's evidence write path landed — the baseline run
   produced one file, the d3 run produced three. **The better the provenance discipline, the more
   often an absence check trips on evidence about the absence.**

## Methodological limits

- Dispatched runs have no interactive channel, so a skill that would call `AskUserQuestion` cannot.
  Assumptions were substituted and recorded per case. This measures *non-interactive* behaviour;
  both iterations ran under identical conditions, so the delta holds, but a pass rate here is not a
  claim about interactive use.
- 49 of the assertions are `manual` and carry no programmatic signal. The means above are over the
  machine-decidable subset.
- `pre-implement-gate` is structurally unexercised: sandbox branches are `task/*`, which classify as
  `other`, and the gate keys on `feature`. The feature class's one hard gate is never tested here.
- `targeted-tests` and `broad-tests` compile to the identical `npm test` in this repo, so any
  do-test case runs the suite twice and `tiersPassed: 2` overstates independence.
