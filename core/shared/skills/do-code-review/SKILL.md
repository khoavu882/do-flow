---
name: do-code-review
description: Code review automation for TypeScript, JavaScript, Python, Go, Swift, Kotlin, C#, .NET, Java, C, C++, Rust, Ruby, PHP, and Dart/Flutter. Analyzes PRs for complexity and risk, checks code quality for SOLID violations and code smells, generates review reports. Use when reviewing pull requests, analyzing code quality, identifying issues, generating review checklists.
---

# Code Reviewer

Automated code review tools for analyzing pull requests, detecting code quality issues, and generating review reports.

---

## How This Skill Is Organized

```
do-code-review/
  SKILL.md                        ← you are here (tools + dispatch table)
  rules/
    universal.md                  ← security, async, resources, exceptions, performance — all languages
  languages/
    python.md                     ← Python-specific rules + idioms
    typescript.md                 ← TypeScript / JavaScript-specific rules + idioms
    go.md                         ← Go-specific rules + idioms
    swift.md                      ← Swift-specific rules + idioms
    kotlin.md                     ← Kotlin-specific rules + idioms
    csharp.md                     ← C# / .NET-specific rules + idioms
    java.md                       ← Java-specific rules + idioms
    c.md                          ← C -specific rules + idioms
    cpp.md                        ← C++ -specific rules + idioms
    rust.md                       ← Rust -specific rules + idioms
    ruby.md                       ← Ruby -specific rules + idioms
    php.md                        ← PHP-specific rules + idioms
    dart.md                       ← Dart / Flutter-specific rules + idioms
  content-types/
    markdown.md                   ← Markdown / prose review notes (checked by doc_quality_checker.py)
```

`content-types/` is a sibling of `languages/`, not a subdirectory of it — it dispatches by content
type (prose vs. code) rather than by programming language; see `content-types/markdown.md`.

### Loading order for every review

1. This file (`SKILL.md`) — tools and thresholds
2. `rules/universal.md` — always, for every language
3. The matching `languages/*.md` — one file based on the extension table below

That is always exactly **2 additional files**, regardless of scope.

| Extension(s) | Load |
|---|---|
| `.py` | `languages/python.md` |
| `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs` | `languages/typescript.md` |
| `.go` | `languages/go.md` |
| `.swift` | `languages/swift.md` |
| `.kt`, `.kts` | `languages/kotlin.md` |
| `.cs`, `.csx`, `.razor`, `.cshtml` | `languages/csharp.md` |
| `.java` | `languages/java.md` |
| `.c`, `.h` | `languages/c.md` |
| `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` | `languages/cpp.md` |
| `.rs` | `languages/rust.md` |
| `.rb`, `.rake`, `.gemspec`, `.ru` | `languages/ruby.md` |
| `.php`, `.phtml` | `languages/php.md` |
| `.dart` | `languages/dart.md` |

---

### Content-type dispatch

For non-code content, a second axis applies alongside (or instead of) the language table above:

| Content type | Extension(s) | Load |
|---|---|---|
| Markdown / prose | `.md` | `content-types/markdown.md` |

This dispatch runs `scripts/doc_quality_checker.py` instead of `code_quality_checker.py` — see
`content-types/markdown.md` for the checks it performs.

---

## Tools

### PR Analyzer

Analyzes git diff between branches to assess review complexity and identify risks.

```bash
# Analyze current branch against main
python scripts/pr_analyzer.py /path/to/repo

# Compare specific branches
python scripts/pr_analyzer.py . --base main --head feature-branch

# JSON output for integration
python scripts/pr_analyzer.py /path/to/repo --json
```

**What it detects (universal — see also language file for language-specific signals):**
- Hardcoded secrets (passwords, API keys, tokens, connection strings)
- SQL / query injection patterns
- Debug statements left in production code
- Lint / analyzer suppression annotations
- TODO/FIXME comments

**Language-specific detections** are defined in each `languages/*.md` file.

**Output includes:**
- Complexity score (1-10)
- Risk categorization (critical, high, medium, low)
- File prioritization for review order
- Commit message validation

---

### Code Quality Checker

Analyzes source code for structural issues, code smells, and SOLID violations.

```bash
# Analyze a directory
python scripts/code_quality_checker.py /path/to/code

# Analyze specific language
# Valid values: python, typescript, javascript, go, swift, kotlin, csharp, java, c, cpp, rust, ruby, php, dart
python scripts/code_quality_checker.py . --language java

# JSON output
python scripts/code_quality_checker.py /path/to/code --json
```

**Universal thresholds:**

| Issue | Threshold |
|-------|-----------|
| Long function | >50 lines |
| Large file | >500 lines |
| God class | >20 methods |
| Too many params | >5 |
| Deep nesting | >4 levels |
| High complexity | >10 branches |

Language-specific checks are defined in each `languages/*.md` file.

---

### Review Report Generator

Combines PR analysis and code quality findings into structured review reports.

```bash
# Generate report for current repo
python scripts/review_report_generator.py /path/to/repo

# Markdown output
python scripts/review_report_generator.py . --format markdown --output review.md

# Use pre-computed analyses
python scripts/review_report_generator.py . \
  --pr-analysis pr_results.json \
  --quality-analysis quality_results.json
```

**Verdicts:**

| Score | Verdict |
|-------|---------|
| 90+ with no high issues | Approve |
| 75+ with ≤2 high issues | Approve with suggestions |
| 50-74 | Request changes |
| <50 or critical issues | Block |

---

## Adding a New Language

**Reviewer guidance (required):**

1. Create `languages/<name>.md` using any existing language file as a template — it must have sections: PR Analyzer Signals, Code Quality Checks, Security, Async, Resource Management, Exception Handling, Performance, Idioms.
2. Add the extension row to the dispatch table above.

That is all the agent-driven review needs.

**Deterministic analyzer support (optional, recommended):** the bundled scripts
only flag a language they explicitly know. To make `code_quality_checker.py`
score the new language:

3. Add the extensions to `LANGUAGE_EXTENSIONS` in `scripts/code_quality_checker.py` (this also adds the `--language` choice).
4. Add `function` / `class` / `method` regex entries for the language in the same file; otherwise it falls back to the Python patterns.
5. Optionally add a `check_<name>_specific_smells(...)` detector (see the C#, Java, and C ones) and call it from `analyze_file`.
6. Add `assets/sample_<name>_smells.<ext>` + `_clean` fixtures and commit the expected `--json` output under `expected_outputs/` as a regression guard.

---

## Regression Fixtures

Labelled fixtures live in `assets/` with their committed `--json` output in
`expected_outputs/` (C#, Java, and C). Drift from the committed JSON signals a
behaviour change in the analyzer.

Emitted paths are relative to the working directory, so the output is identical on
every machine and the fixtures compare directly. Run from this skill's own directory:

```bash
python scripts/code_quality_checker.py assets/sample_java_smells.java --json \
  | diff - expected_outputs/sample_java_smells_quality.json
```

`bash test/code-review-fixtures.sh` (from the repo root) checks all of them at once,
and is how they are normally run. Regenerate a fixture after an intentional analyzer
change with `… --json > expected_outputs/<name>_quality.json`, from this directory so
the recorded path stays relative.

## Next Step
After review, use `/do-implement` to address requested changes, then rerun `/do-code-review`.
On a clean review with nothing left to fix, consider `/do-document --type impl` to record what was built — optional, and does not gate or pause completion.