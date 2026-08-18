# Code Review — `core/shared/skills/do-code-review/scripts/pr_analyzer.py`

**Reviewed:** 2026-08-18 · **Target:** one file, named by the user · **Repo:** DoFlow @ 704fb33

## The Review Contract

**1. The file set, and how it was derived.**
The single path the user named: `core/shared/skills/do-code-review/scripts/pr_analyzer.py`.
Derivation is "the paths the user named", not a diff and not the working tree. One file, 535 lines
by `wc -l` (the analyzer reports 536 total / 421 code / 82 blank / 33 comment — it counts the
trailing line). Every file in the set was opened; nothing is reported as unreviewed.

**2. The rules files that load.**
The extension is `.py`, so per SKILL.md's dispatch table:
- `rules/universal.md` — loaded, as it is for every code file.
- `languages/python.md` — loaded, the `.py` row of the language table.

`content-types/markdown.md` was **not** loaded and the prose path was **not** taken. This is a
Python source file; a doc-quality review of it would be a category error.

**3. What this review refuses to conclude.**
- No finding is reported against a file length or a nesting depth. `THRESHOLDS` in
  `code_quality_checker.py` holds exactly `long_function_lines`, `too_many_parameters`,
  `high_complexity`, `god_class_methods`, `max_imports`; neither of those checks exists.
- Runtime behaviour was not exercised beyond reading the source and the analyzer output. Nothing
  below is claimed on the basis of having executed a failure path.
- The `--language python` run reports zero SOLID violations and this review does not manufacture
  one; the file is procedural by design, with 12 module-level functions and no classes.

---

## Extracted — what the deterministic checker detected

`python3 .claude/skills/do-code-review/scripts/code_quality_checker.py \
  core/shared/skills/do-code-review/scripts/pr_analyzer.py --language python --json`

Score **61 / 100, grade D**. Language correctly identified as `python`.
Metrics: 536 total lines, 421 code, 82 blank, 33 comment; 12 functions; 0 classes; average branch
complexity 8.6 against a threshold of 10.

| Severity | Type | Finding |
|---|---|---|
| medium | long_function | `analyze_pr` has 71 lines (max 50) |
| medium | long_function | `print_report` has 52 lines (max 50) |
| medium | long_function | `main` has 55 lines (max 50) |
| medium | high_complexity | `calculate_complexity_score` complexity 12 (max 10) |
| medium | high_complexity | `analyze_pr` complexity 15 (max 10) |
| medium | high_complexity | `print_report` complexity 12 (max 10) |
| medium | high_complexity | `main` complexity 11 (max 10) |
| low | magic_number | `500` at line 288 should be a named constant |
| low | magic_number | `200` at line 290 should be a named constant |

9 smells, 0 SOLID violations. `function_details` additionally records `get_changed_files` at 45
lines / complexity 8 — under both thresholds, so not a finding, but it is the fourth-longest
function and it is where P1 below lives.

Targeted greps against `languages/python.md`'s checklist:
`print(` × 25 · `except` × 2 (both in one function) · mutable default arguments: none ·
`import *`: none · `eval`/`exec`/`pickle`: none · `subprocess.run` × 1, `shell=True`: none ·
`open()` × 1 · bare `assert`: none · unannotated `def`: 1 of 12.

---

## Inferred — what I conclude from those detections

### P1 — HIGH (correctness): `re.IGNORECASE` is applied to case-significant C# patterns

`analyze_diff_for_risks`, line 246:

```python
matches = re.findall(risk["pattern"], content, re.IGNORECASE)
```

The flag is applied uniformly to all 12 `RISK_PATTERNS`, but four of them are case-significant C#
identifiers — `csharp_blocking_async` (`.Result` / `.Wait()` / `.GetAwaiter().GetResult()`),
`csharp_async_void`, `csharp_unsafe_block`, `csharp_null_forgiving`. Under `IGNORECASE` they match
ordinary lowercase code in other languages. Verified:

```
pattern: \.(?:Result\b|Wait\(\)|GetAwaiter\(\)\.GetResult\(\))
subject: const out = plan.result;
  with IGNORECASE -> ['.result']      without -> []
```

The same flag makes `hardcoded_secrets`' literal `token` match the identifier `TOKEN`, so a constant
named `TARGET_PATTERN_TOKEN = '{pattern}'` is reported **critical: potential hardcoded secret**.

A JavaScript codebase therefore receives high-severity findings claiming an ASP.NET deadlock risk on
plain property reads, and critical findings on constant names. Because `calculate_complexity_score`
feeds `critical_risks` and `high_risks` into the score, and the report generator turns criticals
into a BLOCK verdict, this single flag can block a clean PR.

Fix: give each `RISK_PATTERNS` entry its own `flags` key, defaulting to `0`, and set
`re.IGNORECASE` only where it is wanted (`todo_fixme` is the clear case). Alternatively write the
case-insensitive patterns with explicit character classes and drop the flag entirely.

### P2 — HIGH (correctness): three silent fallbacks turn a bad base ref into a plausible wrong answer

`get_changed_files` (lines 163+) tries `git diff --name-status base...head`; on failure, silently
retries `git diff --name-status base head`; on failure **or empty output**, silently falls back to
`git diff --name-status --cached`. No warning, no record of which one succeeded, and the caller
cannot tell.

Two consequences. A mistyped or non-existent `--base` produces a review of *staged changes* while
the report header still names the requested base. And a legitimately empty diff is
indistinguishable from a failed one, because the second condition is `not success or not output` —
an honest "no changes between these refs" is treated as an error worth escalating past.

This is `rules/universal.md`'s swallowed-error rule expressed as control flow rather than as an
empty `except`. Fix: record which strategy produced the result, put it in the analysis dict, print
it in the header, and do not treat empty output as failure.

### P3 — MEDIUM: `except Exception as e` collapses every git failure into one opaque string

`run_git_command`, lines 157–159:

```python
except subprocess.TimeoutExpired:
    return False, "Command timed out"
except Exception as e:
    return False, str(e)
```

`languages/python.md` flags "`except` clause too broad when the `try` block covers multiple
operations with different failure modes", and `rules/universal.md` flags "catching the broadest
possible exception type where a specific type is appropriate". Here a missing `git` binary
(`FileNotFoundError`), an unreadable repo path (`PermissionError`), and a genuine non-zero exit are
all reduced to the same `(False, str(e))`, which P2 then swallows. The realistic specific set is
`FileNotFoundError` and `OSError`; anything else is a bug in this script and should propagate.

Positive, and worth stating because the rule was checked: `timeout=30` **is** set on the
`subprocess.run` call, satisfying `rules/universal.md`'s "flag timeouts missing on any I/O call".
`shell=True` is not used, and the command is passed as a list, so the shell-injection rule is
satisfied too.

### P4 — MEDIUM: `analyze_pr` at 71 lines and complexity 15 is doing four jobs

The checker flags it twice, and the two findings share a cause rather than being independent: the
function collects changed files, fetches and scans each diff, aggregates risks, and assembles the
summary dict. Complexity 15 against a threshold of 10 is the highest in the file. Splitting the
per-file scan loop out would resolve both findings and make P1's pattern loop testable in isolation
— which is the practical argument for doing it, since P1 shipped undetected.

`print_report` (52 lines, complexity 12) and `main` (55 lines, complexity 11) are less pressing:
both are flat, linear, and complex only because of the number of optional output sections and CLI
flags they enumerate.

### P5 — LOW: `main()` is the only unannotated function in the file

Eleven of twelve functions carry full parameter and return annotations. `def main():` at line 482
carries none. `languages/python.md` says all public functions should be annotated; `-> None` closes
it and makes the file uniform.

### P6 — LOW: the two magic numbers are review thresholds, not incidental constants

`500` and `200` at lines 288–290 are the total-change bands in `calculate_complexity_score`. They
sit alongside a `> 5` file-count band and `min(2, ...)` risk caps in the same function, none of
which the checker flagged. These are policy, not arithmetic: they decide what "large PR" means and
they belong in a module-level constant next to `RISK_PATTERNS` and `FILE_CATEGORIES`, where the
rest of this script's tunables already live and where a reviewer would look for them.

### P7 — LOW (design limitation, not a rule violation): only added lines are scanned

`analyze_diff_for_risks` filters to lines starting with `+`. A risk introduced by *deleting* a
guard — a removed timeout, a removed parameterized query — is invisible to every pattern. This is a
deliberate and defensible choice for a PR-risk tool, but it is undocumented, and SKILL.md's
"Extracted — what the analyzer detects" list reads as though it inspects the change rather than
half of it. One sentence in the docstring and one in SKILL.md.

### Rules checked that produced nothing, reported so the coverage is visible

- **`print()` × 25 is NOT reported as a finding.** `languages/python.md` lists "`print()`
  statements left in production code" as a Python risk signal, but every one of the 25 is inside
  `print_report` or `main`, in a CLI whose entire purpose is to print a report to stdout. Reporting
  it would be applying the rule's letter against its intent. Recorded here rather than omitted so
  the decision is visible rather than looking like an oversight.
- Mutable default arguments, `import *`, `eval`/`exec`, `pickle`, `shell=True`, bare `except:`,
  `assert` for validation, `open()` outside a context manager, string `+=` in a loop, N+1 query
  patterns: none present.
- Async rules: not applicable, the file is entirely synchronous.
- `re.findall` is called inside a nested loop (12 patterns × every changed file), which is adjacent
  to `python.md`'s "repeated `re.compile()` inside a loop". Not reported as a finding: `re` keeps an
  internal compiled-pattern cache and the pattern count is far below its limit, so there is no real
  recompilation cost. Named here because the grep hit and a silent drop would look like a miss.

---

## Verdict

**Request changes.**

The deterministic score is 61/100 (D), driven entirely by medium-severity structure. That score
understates the problem: P1 and P2 are correctness defects that the structural checker cannot see,
and both change what this tool *reports about other people's code*. P1 in particular manufactures
high-severity and critical findings on any non-C# codebase, and those findings propagate into
`review_report_generator.py`'s BLOCK verdict.

Priority order: **P1**, then **P2**, then **P3**. P4 is worth doing while P1 is being fixed, since
it is the function P1 lives in. P5–P7 are cleanups.

## Next Step
`/do-implement` to address P1–P3, then rerun `/do-code-review`.
