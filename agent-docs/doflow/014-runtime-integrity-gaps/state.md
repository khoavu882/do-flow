# State: Runtime Integrity Gaps

**Feature:** 014-runtime-integrity-gaps · **Plan:** ./plan.md · **Status:** In Progress · **Updated:** 2026-08-20

> Execution state for `/do-execute-plan`. Reflects what has actually happened, not what's intended.
> On resume, trust this file and `git log` over recollection.

## Repo Branch Status

N/A: single-repo feature.

## Task Ledger

| Task | Commits | Rounds | Review | Status |
|---|---|---|---|---|
| A.1 | `48f0807..bbfbda4` | 0 | clean | complete |
| A.2 | `48f0807..bbfbda4` | 0 | clean | complete |
| B.1 | `bbfbda4..91bd031` | 1 | clean | complete |
| B.2 | `bbfbda4..91bd031` | 1 | clean | complete |
| B.3 | `bbfbda4..91bd031` | 2 | clean | complete |
| B.4 | `bbfbda4..91bd031` | 0 | clean | complete |
| C.1 | `91bd031..d33c9ef` | 0 | clean | complete |
| C.2 | `91bd031..d33c9ef` | 1 | clean | complete |
| D.1 | `d33c9ef..ee2219c` | 0 | clean | complete |
| D.2 | `d33c9ef..ee2219c` | 0 | clean | complete |
| D.3 | `d33c9ef..ee2219c` | 0 | clean | complete |
| D.4 | `d33c9ef..ee2219c` | 0 | clean | complete |
| E.1 | uncommitted (working tree) | 0 | clean | complete |
| E.2 | uncommitted (working tree) | 0 | clean | complete |
| E.3 | uncommitted (working tree) | 0 | clean | complete |

Review rounds above count fix rounds inside the task, not separate review passes: B.1's round was
the supersede validation-ordering fix, B.2's was the evidence-write fixture conflict, B.3's were the
`repoRoot`/`projectRoot` separation and the over-broad locator rename, and C.2's was the declarative
report rendering.

## Findings

Recorded rather than fixed, each with the ruling that let it stand:

- **[A.2] design deviation — accepted, artifact corrected.** Design §5 listed a bare component
  reference (`C#`, `C1`) as a leak pattern. Implementing it showed the rule would report every
  shipped mention of the C# language as a DoFlow leak. The pattern was dropped and `design.md` §5
  was corrected, so the design and the code do not disagree.
- **[D.4] leak-scan signal in DoFlow's own tree — accepted, design risk R4.** Run over 40 of this
  repository's shell and JS files the verb reports 21 findings, concentrated in the hook scripts and
  runtime modules that *implement* the artifact paths. Correct by rule. The verb targets consumer
  repositories where DoFlow's source is absent, and it reports rather than blocks, so this is the
  accepted cost R4 already named — not a defect and not a reason to weaken the patterns.
- **[D.4] install propagation — expected, not a gap.** The Stop hook resolves the *installed*
  runtime, so its leak pass only works once `doflow install`/`update` propagates the new verb. True
  of every hook in this repository; noted so a reader who tests the hook against an old install is
  not surprised.
- **[do-test] contract verdict INCONCLUSIVE — recorded, not repaired.** The MEDIUM-risk contract
  compiled nine tiers. `targeted-tests` and `broad-tests` both PASS on `npm test`; `parse`, `build`
  and `static-analysis` are NOT_APPLICABLE (this repo has no such steps); three tiers are SKIPPED as
  not required at MEDIUM. `change-scope` is UNRESOLVED because no scope bound was declared *before*
  implementation, and one unresolved required tier makes the whole run INCONCLUSIVE. It cannot be
  closed retroactively: a bound written now would be derived from the diff it exists to police, so
  it would be a vacuous pass. Ruling: record the gap and continue. The fix belongs to the next
  feature's planning stage, which should declare the bound up front.
- **[do-test] no coverage numbers.** The detected runner is `node --test` with no coverage flag, so
  the run emits no line or branch figures. None are reported rather than substituting a proxy.
- **[E.3] two tiers still unresolved on the no-manifest fixture — correct.** `static-analysis` is
  unresolved because that fixture's plan declares no lint command, and `change-scope` because no
  scope bound was declared before implementation. Both are honest gaps in the fixture, not failures
  of FR-011.

## Completed

- [x] A.1 — `locator-resolve.js`: does a locator still point at something (12 tests)
- [x] A.2 — `leak-scan.js` + verb: DoFlow vocabulary in shipped files (10 tests)
- [x] B.1 — terminal claim states, retract/supersede, the `evaluateClaim` early return
- [x] B.2 — write-time locator resolvability; one refused item discards the batch
- [x] B.3 — gate-time resolvability, kept distinct from stale; `projectRoot` separated
- [x] B.4 — `--plan-path`, `--replaced-by`, the `leak-scan` verb, shell dispatcher, help
- [x] C.1 — every walked file accounted for; `coverage` complete/partial
- [x] C.2 — shell as code; YAML/JSON as declarative structure
- [x] D.1 — `languages/shell.md`
- [x] D.2 — `content-types/config.md`
- [x] D.3 — dispatch rows, contract steps, `quality-guardian` offload, description
- [x] D.4 — leak pass in the Stop hook's existing batch loop
- [x] E.1 — `docs/reference.md`, `docs/flags.md`
- [x] E.2 — `CHANGELOG.md` (README needed no change: no language list, counts unchanged)
- [x] E.3 — 673 tests, 11 fixtures + 5 coverage assertions, leak verb, FR-011 end to end

## In Progress

None.

## Blocked

None.

## Review Findings (`/do-code-review`)

**Verdict: Request changes.** Analyser average 74.7 over the derived 28-path set, which falls in
the table's 50-74 band. No regression: the same set scored 67.6 (D) at base over 11 analysed files
and 74.7 (C) at head over 21.

Actionable on this branch (2):
- `src/runtime/locator-resolve.js` `resolveLocator` — complexity 21 (threshold 10), 54 lines
  (threshold 50).
- `src/runtime/leak-scan.js` `scanPaths` — complexity 18 (threshold 10), 65 lines (threshold 50).

Verified false positives, not fixed and not counted (13):
- 2 HIGH "blocking async call, can deadlock in ASP.NET" — `pr_analyzer.py:246` applies
  `re.IGNORECASE` to a C#-only pattern, so JavaScript's `...result` spread matches `.Result`.
- 9 `console_log` — CLI handler output in `leak-scan.js` and `claims.js`, the same pattern
  `handleClaimCommand` already uses; not debug statements.
- 3 magic numbers (799, 004, 009) — all inside documentation comments; two are the digits of
  `FR-004` and `FR-009`.

Minor, real: commit `ee2219c` has a 77-character subject line against a 72-character convention.

Out of scope, reported for a separate change: `pr_analyzer.py:246`'s IGNORECASE defect is the same
class this feature exists to remove — an analyser reporting a verdict it has not earned. This
feature touched `code_quality_checker.py`, not `pr_analyzer.py`, and `/do-code-review` does not
remediate what it reports.

## Post-Review Implementation (`/do-implement`, commit `8bac589`)

Both actionable findings addressed. Behaviour unchanged, **no test edited** — `git diff --stat`
over `test/` is empty, which was the stated invariant.

| File | Before | After |
|---|---|---|
| `src/runtime/locator-resolve.js` | 79 (C) | **94 (A)** |
| `src/runtime/leak-scan.js` | 88 (B) | **98 (A)** |

`long_function` gone from both. Readiness was graded `refactor`/`READY`, with `invariants_captured`
satisfied by a **caller-stated** `--invariants`, not by measured evidence.

**New finding — `code_quality_checker.py` penalises documentation.** Discovered while measuring the
refactor, not by the review:
- `find_functions` (line 90) slices a body up to the *next function declaration*, so it counts that
  function's JSDoc as part of this one.
- `calculate_cyclomatic_complexity` (line 85) matches the Python keywords for disjunction and
  conjunction in English prose, and never strips comments.

Measured on real bodies: `scanPaths` is **9** (under the threshold of 10; the reported 11 is entirely
artifact) and `resolveLocator` is **12** (reported 16). Splitting `resolveLocator` further would
trade readability for a mis-counting metric, so it stops here.

Reported, not fixed: correcting it changes the measured complexity of every analysed file and
requires regenerating all 11 committed fixtures — its own change, its own review.

## Re-Review (`/do-code-review`, second pass)

**Verdict: Approve with suggestions.** Derived-set average 75.9, in the table's 75-plus band with
two high-severity findings — both the same verified false positives as the first pass.

Read the band change narrowly: 74.7 to 75.9 is a 1.2-point move across a threshold, not a decisive
change in quality. Total smells fell 150 to 148 (the two closed `long_function` findings).

Closure of the first review's findings:

| Finding | State |
|---|---|
| `resolveLocator` long_function (54 lines) | **Closed** |
| `scanPaths` long_function (65 lines) | **Closed** |
| `scanPaths` complexity 18 | **Closed** — real body measures 9, under the threshold of 10 |
| `resolveLocator` complexity 21 | **Reduced, accepted** — reported 16, real body 12, code-only 11 |
| 2 HIGH `csharp_blocking_async` | Unchanged — verified false positive (`...result` spread) |
| 9 `console_log` | Unchanged — CLI handler output, not debug |
| `ee2219c` 77-char subject | Unchanged — would require rewriting branch history |

The fix diff itself (`7fce6ed..8bac589`) introduced nothing: 2 files, complexity 1 (Simple), no risk
finding at any severity, no commit-message issue, no test edited. Commit `8bac589`'s own subject is
62 characters.

Full check set re-run, not assumed: `npm test` 673/673, fixtures 11/11, working tree clean, no
`__pycache__` left behind.

## Analyser Defects Fixed (`/do-implement`, commit `0303c26`)

Both open analyser defects closed. They shared one root cause: a regex match on raw text treated as
a fact about program structure.

**`code_quality_checker.py` — documentation penalty.** `strip_comments()` now runs before the
keyword count (blank lines replace removed text so line numbers still align), and
`trim_trailing_comment_block()` gives a trailing doc comment back to the function it documents.
Measured effect, with **no source function edited**: `resolveLocator` reported 16 → **11**, matching
its real body; `scanPaths` stopped reporting entirely, because it was never over the threshold.

**`pr_analyzer.py` — case sensitivity.** Declared per pattern, explicitly on all eleven; an entry
that omits it is refused at import (`ValueError` naming the pattern) rather than taking a default.

The audit found **three** patterns needing case-insensitivity, not the two previously assumed:

| Pattern | `ignorecase` | Why |
|---|---|---|
| `hardcoded_secrets` | true | lowercase pattern, must catch `Password:` |
| `todo_fixme` | true | uppercase pattern, must catch `todo:` |
| `sql_concatenation` | true | uppercase SQL keywords; real code writes `select` |
| the other 8 | false | exact-case API names, keywords, or punctuation |

`sql_concatenation` was the one I had missed. Implementing from the remembered count of two would
have silently disabled lowercase SQL injection detection — which is why the audit was run against
the pattern list rather than from recollection.

**Fixtures.** Seven of eleven drifted. Field-by-field comparison confirmed the differences confined
to `function_details[].complexity`, `function_details[].lines`, `metrics.avg_complexity` and the
smell messages embedding them — no score moved, no finding appeared or disappeared. Regenerated on
that basis; 11/11 pass.

**Left alone by your ruling:** `resolveLocator`. Not edited. Its reported figure fell to 11 as a
side effect of the measurement fix, not by touching the function.

**Still open, separate:** an `and`/`or` inside a *string literal* still counts toward complexity.
Same class of defect; stripping string literals correctly needs a tokenizer, not another regex.

## Install Propagated (`doflow install -g`, source commit `0303c26`)

The one thing that had been quietly false all session: every prior verification measured the
**source tree** while the running system used the **installed copy**. That is why `/do-code-review`
kept loading its old contract after the edits, and why the Stop hook had to be tested against a fake
install pointed at the source tree.

Backup `install_2026-08-20_18-51-23`, 252 owned resources, 0 conflicts, target `claude` (the only
harness configured on this machine).

| Surface | Before | After |
|---|---|---|
| `doflow-run` `leak-scan` verb | 0 | 2 |
| `languages/shell.md` | missing | present |
| `content-types/config.md` | missing | present |
| analyser `strip_comments` | absent | present |
| `pr_analyzer` `ignorecase` | absent | 13 |
| `stop-check.sh` leak pass | absent | present |

Verified **through the installed path**: the Stop hook warns with file and line on a shipped file and
exits 0. Independent confirmation — the harness's own skill listing refreshed mid-session to name
Shell and declarative YAML/JSON config, so the description reached the surface the harness matches
on for triggering, not merely the files on disk.

`doflow doctor`: no findings, 4 of 6 providers answering. It flagged the code graph as stale;
`graphify update .` rebuilt it to 4107 nodes and 6047 edges.

## Next Action

Feature 014 is complete and installed. Three items remain, tracked as follow-on work rather than
part of this feature:

1. **String literals still count toward cyclomatic complexity** — `"error or warning"` reads as two
   branches. Same class as the comment defect already fixed; needs a tokenizer, not another regex.
   Under design.
2. **`scaffold-*` / `trace-*` regrouping** into `src/runtime/scaffold/` and `src/runtime/trace/`.
   Constrained by guard G16, whose reachability rule a barrel file could weaken. Under design.
3. **`src/runtime/helper/` grouping** — whether it is worth doing at all is itself the open
   question. Under design.
