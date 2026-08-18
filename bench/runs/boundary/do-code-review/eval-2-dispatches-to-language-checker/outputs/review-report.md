# Code Review: core/shared/skills/do-code-review/scripts/pr_analyzer.py

**Target:** `core/shared/skills/do-code-review/scripts/pr_analyzer.py` (536 lines, 12 functions, 0 classes)
**Dispatch:** `.py` extension → `languages/python.md` + `rules/universal.md` (per SKILL.md dispatch table) →
deterministic pass via `scripts/code_quality_checker.py --language python`
**Quality score:** 61/100 — **Grade D**

---

## 1. Deterministic findings (code_quality_checker.py)

| Type | Severity | Location | Message |
|---|---|---|---|
| long_function | medium | `analyze_pr` | 71 lines (max 50) |
| long_function | medium | `print_report` | 52 lines (max 50) |
| long_function | medium | `main` | 55 lines (max 50) |
| high_complexity | medium | `calculate_complexity_score` | complexity 12 (max 10) |
| high_complexity | medium | `analyze_pr` | complexity 15 (max 10) |
| high_complexity | medium | `print_report` | complexity 12 (max 10) |
| high_complexity | medium | `main` | complexity 11 (max 10) |
| magic_number | low | line 288 | `500` should be a named constant |
| magic_number | low | line 290 | `200` should be a named constant |

No SOLID violations were flagged by the automated pass (file has 0 classes, so class-level
SOLID checks — god class, etc. — do not apply structurally), but see §3 for a function-level SRP
concern the automated pass can't detect.

Full raw JSON saved to `outputs/code_quality_checker.json`.

## 2. Manual review against `languages/python.md` + `rules/universal.md`

### Idioms (python.md)
- **Unused import — `Optional`** (line 21): `from typing import Dict, List, Optional, Tuple` imports
  `Optional`, but it is never referenced anywhere in the file (verified via grep — zero other hits).
  Dead import; remove it.
- **Plain `dict`/`List[Dict]` used for structured data throughout** (`FILE_CATEGORIES` entries, risk
  records, `file_analyses` entries, the `analyze_pr` return value) instead of `TypedDict` or
  `dataclass`. python.md idioms explicitly prefer `TypedDict`/`dataclass` over plain `dict` for
  structured data — this file's shapes (risk record: `name/severity/message/file/count`; file
  analysis: `path/status/category/priority_weight/additions/deletions/risks`) are exactly that case,
  and would benefit from static shape-checking.
- No `print()`-as-debug-leftover issue: the `print()` calls in `print_report` are the tool's
  intentional human-readable output path, not debug residue — not flagged.

### Exception Handling (universal.md / python.md)
- `run_git_command` (line 146-160) has a bare `except Exception as e: return False, str(e)` after
  a specific `except subprocess.TimeoutExpired`. universal.md flags catching the broadest exception
  type where a specific one is appropriate; here it's a defensive wrapper around an external
  process call and the broad catch is arguably justified (subprocess can raise `OSError`,
  `FileNotFoundError`, etc., all worth reporting uniformly) — flagging as **low-severity,
  acceptable-with-comment** rather than a real defect.

### Security (universal.md — ReDoS / unbounded regex on untrusted input)
- **Regex catastrophic-backtracking risk in `RISK_PATTERNS`** (lines 60-143), specifically
  `sql_concatenation` (line 111): `r"(SELECT|INSERT|UPDATE|DELETE).*\+.*['\"]|..."` and several
  neighboring patterns use unanchored `.*` chained through alternation. These patterns run via
  `re.findall(..., content, re.IGNORECASE)` in `analyze_diff_for_risks` (line 246) against
  `content`, which is the full joined text of every added line in a diff — i.e., **attacker/PR-
  author-controlled input** for a tool meant to run against untrusted pull requests. Large or
  adversarially crafted diffs could trigger pathological backtracking (ReDoS) in this hot path.
  universal.md's "user-controlled input passed to ... without validation" and general regex-safety
  concerns apply. Recommend bounding line length before matching, or auditing patterns with a
  regex-DoS linter.

### SOLID / Structure (beyond what the automated pass measures)
- **`analyze_pr` (line 343-414, 71 lines / complexity 15) violates Single Responsibility**: it
  fetches changed files, iterates and diffs each one, aggregates risks, sorts by priority, invokes
  commit-message analysis, computes the complexity score, and assembles the final response dict —
  six distinct concerns in one function. This is exactly the kind of function the checker's
  long_function/high_complexity flags point at; the fix is to extract at least
  "build per-file analyses" and "assemble summary dict" into separate functions, each independently
  testable.
- **`print_report` (line 431-479, 52 lines / complexity 12)** mixes report-summary, risk-detail,
  commit-issue, and review-order rendering in one function — same SRP issue, one level down.
  Extracting one `print_<section>` helper per report section would bring each under the 50-line /
  10-complexity thresholds and make the CLI output format independently testable.

### Minor / style
- `analyze_commit_messages` line 323: `message = commit[8:] if len(commit) > 8 else commit` — the
  `8` (7-char abbreviated SHA + 1 space) is an unexplained magic number tied to git's default
  `--oneline` hash width; not caught by the checker's magic-number rule (which only flags numeric
  literals in specific contexts) but worth a named constant or comment given it silently
  mis-parses if `core.abbrev` is configured differently.

## 3. Verdict

Per `SKILL.md`'s verdict table (score 61, no critical issues but several medium-severity
long-function/high-complexity smells and one flagged security-adjacent concern):

**Verdict: Request changes** (score 50-74 band).

Priority fixes, in order:
1. Break up `analyze_pr` and `print_report` — both exceed the length/complexity thresholds and mix
   multiple responsibilities (SRP).
2. Audit the `RISK_PATTERNS` regexes (esp. `sql_concatenation`) for ReDoS exposure since they run
   against untrusted diff content.
3. Remove the unused `Optional` import; consider `TypedDict`/`dataclass` for the risk/file-analysis
   record shapes.
4. Name the magic numbers (500, 200 thresholds; the `8`-char commit-hash offset).
