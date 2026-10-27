# Review tools

## PR Analyzer

Analyzes git diff between branches to assess review complexity and identify risks.

```bash
# Analyze current branch against main
python scripts/pr_analyzer.py /path/to/repo

# Compare specific branches
python scripts/pr_analyzer.py . --base main --head feature-branch

# JSON output for integration
python scripts/pr_analyzer.py /path/to/repo --json
```

**Extracted — what the analyzer detects** (universal; see also the language file for
language-specific signals):
- Hardcoded secrets (passwords, API keys, tokens, connection strings)
- SQL / query injection patterns
- Debug statements left in production code
- Lint / analyzer suppression annotations
- TODO/FIXME comments

**Language-specific detections** are defined in each `languages/*.md` file.

**Inferred — what the report concludes from those detections:**
- Complexity score (1-10)
- Risk categorization (critical, high, medium, low)
- File prioritization for review order
- Commit message validation

Report the two halves apart. A detection is a locator in a file; a conclusion is your reading of
several of them, and merging them into one line is how a reading stops being falsifiable.

## Code Quality Checker

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

**Universal thresholds:** declared in `review-policy.json`, never here. A guard fails the suite if a
number from it reappears in any document. Read what a run applies from the run: `--json` carries a
`policy` block naming the thresholds in force and the tiers that supplied them.

Three tiers resolve into one, lowest precedence first: the analyzer's built-in literal, the shipped
`review-policy.json` beside SKILL.md, then `agent-docs/review-policy.json` in the repository under
review, which a project's tech lead owns. A per-repo file is **partial** — declare only what you are
changing — and its absence is the ordinary state. A file that does not parse, names an unknown group,
or gives a threshold a non-integer value stops the analyzer naming the file and the problem rather
than reverting to defaults under a maintainer who believes their tuning applies. The policy also
declares severities, the verdict bands below, and the globs a review excludes.

The per-repo tier is found by walking up from the analysed path, so a target outside any repository
resolves none, which the `policy` block makes visible.

Language-specific checks are defined in each `languages/*.md` file.

## Review Report Generator

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

**Verdicts:** the bands live in `review-policy.json` under `verdictBands`, for the same reason the
thresholds do. They are **declared, never applied**: they orient a reviewer reading a score, and
nothing computes the verdict from one. A verdict may therefore disagree with the band a score falls
in, provided the report says so and why.
