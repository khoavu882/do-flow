# Code Review — task/bench-d3-do-code-review-1 vs main

**Reviewed:** 2026-08-18 · **Base:** `main` @ 0101995c735d51b68a2d5b9870f8c92363d1d5ba · **Head:** `task/bench-d3-do-code-review-1` @ 704fb33

## The Review Contract

**1. The file set, and how it was derived.**
`pr_analyzer.py . --base main`, i.e. the three-dot diff between the merge-base with `main` and
this branch's head. 484 files, +58641 / -2629, across 36 commits. The branch has no commits of its
own beyond the base of `feat/008-doflow-runtime-unification`, so "the changes on this branch"
resolves to the whole feature branch as it would land in a PR — which is what "before I open a PR"
asks for.

Of the 484: 203 `.json`, 95 `.md`, 85 `.txt`, 58 `.js`, 14 `.py`, 13 `.sh`, 6 `.yaml`,
plus 2 extensionless shell entrypoints and a scattering of `.tap`/`.diff`/`.log`/`.conf`.

**Not individually opened, and reported as such rather than dropped:** 458 of the 484. I opened
`src/runtime/command-detect.js`, `src/runtime/recovery.js`, `src/adapters/kiro/index.js`,
`.claude/skills/do-code-review/scripts/pr_analyzer.py` and
`.claude/skills/do-code-review/scripts/code_quality_checker.py` by hand to adjudicate analyzer
output. The remaining files were covered only by the deterministic analyzers, at the coverage stated
below. A 484-file, 58k-line diff is not reviewable file-by-file in one pass and this review does not
claim to have done so.

**2. The rules files that load.**
- `rules/universal.md` — loaded, applies to every code file.
- `languages/typescript.md` — the dispatch target for all 58 `.js` files.
- `languages/python.md` — the dispatch target for the 14 `.py` files.
- `content-types/markdown.md` — the dispatch target for the 95 `.md` files.

**Dispatch gap:** 203 `.json`, 85 `.txt`, 13 `.sh`, 6 `.yaml`/`.yml` and the 2
extensionless `doflow-run` shell entrypoints match no row in either dispatch table. That is 309 of
484 files — 64% of the diff — with no rules file at all. The two `doflow-run` files are the
runtime seam every skill goes through, and they are the least reviewable files in this repository
under this skill's own tables.

**3. What this review refuses to conclude.**
- It does not certify any of the 458 files it did not open.
- It reports no finding against a file-length or nesting-depth threshold: `THRESHOLDS` in
  `code_quality_checker.py` contains exactly `long_function_lines`, `too_many_parameters`,
  `high_complexity`, `god_class_methods`, `max_imports`, and neither of those checks exists.
- It does not adopt the generator's verdict as its own. See "Verdict" below for why.
- The shell and JSON portions of the diff were not checked by any tool; that is a gap, not a pass.

---

## Extracted — what the analyzers detected

`pr_analyzer.py`, on added lines only, across the 484-file diff:

| Severity | Count |
|---|---|
| Critical | 10 |
| High | 12 |
| Medium | 18 |
| Low | 1 |

`code_quality_checker.py src --language javascript`: 52 files analyzed, average score 82.1,
grade B, 228 smells, 8 SOLID violations. 26 of those 52 files are in this diff; their average score
is 75.5.

Smell counts (all files): high_complexity 94, magic_number 73, long_function 44, god_class 9,
commented_code 8. Severity split: 38 high, 109 medium, 81 low.

Lowest-scoring files that are in this diff:

| Score | Grade | File | Smells | SOLID |
|---|---|---|---|---|
| 0 | F | src/runtime/trace.js | 30 | 1 |
| 16 | F | src/runtime/cli.js | 15 | 1 |
| 20 | F | src/runtime/scaffold.js | 15 | 1 |
| 23 | F | src/runtime/verification.js | 21 | 1 |
| 45 | F | src/runtime/health.js | 14 | 0 |
| 58 | F | src/runtime/command-detect.js | 8 | 0 |
| 66 | D | src/runtime/retrieval-bridge.js | 10 | 0 |

`doc_quality_checker.py core/shared/skills`: 2 findings, both in
`do-code-review/assets/sample_markdown_smells.md`, which is the deliberately-bad fixture. Zero
findings across the 13 rewritten `SKILL.md` files.

Commit messages: 5 commits exceed 72 characters on the subject line (704fb33, 66a5473, b8d1348,
194d5d3, f5fa836).

---

## Inferred — what I conclude from those detections

### F1 — BLOCKING (of the review, not of the branch): one analyzer bug produces nearly every high-and-above finding in source

`pr_analyzer.py:246` applies `re.IGNORECASE` to every entry in `RISK_PATTERNS`. Several of
those patterns are case-significant C# identifiers. Under `IGNORECASE` they match ordinary
JavaScript.

Verified directly:

```
pattern: \.(?:Result\b|Wait\(\)|GetAwaiter\(\)\.GetResult\(\))
subject: const out = plan.result;
with IGNORECASE: ['.result']    without: []
```

Consequences observed in this run:
- `src/adapters/{kiro,opencode,pi,copilot}/index.js` are each flagged HIGH with "Blocking call on
  async operation — can deadlock in ASP.NET contexts". The matched text is
  `...result.conflicts.map(...)` — a plain property read, in JavaScript, in a repo with no C#.
- `src/runtime/command-detect.js` is the only CRITICAL hit in real source: "Potential hardcoded
  secret or connection string detected". The matched text is
  `const TARGET_PATTERN_TOKEN = '{pattern}';` — the `hardcoded_secrets` pattern's literal
  `token` matches the constant name `TOKEN` only because of `IGNORECASE`. There is no secret.

Fix: drop the blanket `IGNORECASE` and let each pattern declare its own flags, or lowercase only
the patterns that are genuinely case-insensitive (`todo_fixme` is the clear one). Until then, every
high-severity async finding this analyzer reports on a non-C# codebase is noise, and a reviewer who
trusts it will chase four adapters that have nothing wrong with them.

### F2 — HIGH: the `debugger` pattern has no context guard

`src/runtime/recovery.js` is flagged HIGH, "Debugger statement found" x4. The file contains no
`debugger` statement. The match is the English word in a comment:
"handing the task back to a debugger spends more of the budget…". The pattern is a bare `\bdebugger\b`
against added diff lines with no comment-stripping and no requirement that it be a statement.

### F3 — HIGH: 9 of the 10 CRITICAL findings are in this repository's own eval fixtures

Nine of ten criticals point into `bench/runs/baseline/…` and `bench/runs/boundary/…` — saved
transcripts, `.tap` logs and `review-report.md` files from previous bench runs, which contain
these strings precisely because they are records of previous reviews discussing them. The analyzer
has no exclusion for `bench/runs/`, so every eval run permanently raises the critical count of
every subsequent review of this repo. It is self-poisoning, and it compounds.

Fix: exclude `bench/runs/` (and any recorded-output tree) from the analyzed file set, or make the
excluded set an explicit, reported part of the review contract's derivation.

### F4 — MEDIUM: SKILL.md's threshold table contradicts the analyzer it documents

SKILL.md says of its five-row threshold table: "Those five are the whole set". The checker emits two
smell types that are not in the table and not in `THRESHOLDS` — `magic_number` (73 occurrences
this run) and `commented_code` (8). Conversely `max_imports` is in `THRESHOLDS` but no code
path emits a finding for it, and `too_many_parameters` produced none here.

This matters because the review contract's clause 3 tells the reviewer to refuse to "report a
threshold the analyzer does not implement". Following the documentation literally would mean
suppressing 81 real findings the analyzer did produce. SKILL.md hedges correctly one sentence
earlier — "that dict is the source of truth, so re-check it there" — and re-checking it is what
exposed the contradiction, but the flat claim should go.

### F5 — MEDIUM: four runtime modules are structurally large enough to review as a unit

`src/runtime/trace.js` scores 0/100 (F): 1084 lines, 24 functions, 3 classes, average branch
complexity 9.7 against a threshold of 10, with `normalizeRunRecord` at 124 lines and `roundCost`
at 100 against a 50-line threshold. `cli.js` (16), `scaffold.js` (20) and `verification.js` (23)
sit alongside it. These are genuine structural findings, unaffected by F1–F3, and they are the part
of this diff most worth a human's attention. They are also new files in a new runtime, so the debt
is being taken on deliberately rather than inherited.

### F6 — LOW: 5 commit subject lines exceed 72 characters

Cosmetic. Real, and trivially fixable before the PR.

### F7 — the prose rewrite comes back clean

The 13 rewritten `SKILL.md` files produce zero `doc_quality_checker.py` findings. The only two
findings in `core/shared/skills` are in the fixture that exists to produce them. That is a real,
if narrow, positive signal for the D.3 rewrite: no dangling references and no staleness markers
across the rewritten set.

---

## Verdict

`review_report_generator.py` returns **BLOCK, score 0/100**, on the strength of 10 critical issues.

**I do not adopt that verdict.** Nine of the ten criticals are strings inside this repository's own
saved eval transcripts (F3) and the tenth is a constant named `TARGET_PATTERN_TOKEN` (F1). Zero
hardcoded secrets and zero SQL injections exist in this diff. Passing on a BLOCK sourced entirely
from false positives would be reporting a number rather than reviewing.

**My verdict: Request changes** — on the analyzer, not on the feature work.

- F1 and F2 are defects in `pr_analyzer.py`, which is itself part of this diff. They should be
  fixed here, because shipping them means every future review of any JavaScript repository inherits
  them.
- F3 is a scoping defect with a compounding cost and should be fixed here too.
- F4 is a one-line documentation correction.
- F5 is a judgement call for the author: four F-grade files in a new runtime is defensible if
  deliberate, but `trace.js` at 1084 lines with a 124-line function is the one I would split.
- 458 of 484 files remain unopened by a human, and 309 of them match no rules file at all. Whatever
  is decided about F1–F5, that coverage gap is the honest headline of this review.

## Next Step
`/do-implement` to address F1–F4, then rerun `/do-code-review`.
