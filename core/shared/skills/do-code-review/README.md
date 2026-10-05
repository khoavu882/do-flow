# do-code-review

Code review automation for TypeScript, JavaScript, Python, Go, Swift, Kotlin, C#, .NET, Java, C,
C++, Rust, Ruby, PHP, Dart/Flutter and markdown/prose. All three bundled scripts (`pr_analyzer.py`,
`code_quality_checker.py`, `review_report_generator.py`, under `scripts/`) are stdlib-only — no
`pip install` required.

Everything else — dispatch tables, thresholds, verdict table — is in
[`SKILL.md`](./SKILL.md), the file the harnesses actually load. This README holds only the
maintainer sections below, not a second copy.

## Adding a New Language

**Reviewer guidance (required):**

1. Create `languages/<name>.md` using any existing language file as a template — it must have sections: PR Analyzer Signals, Code Quality Checks, Security, Async, Resource Management, Exception Handling, Performance, Idioms.
2. Add the extension row to the dispatch table in `SKILL.md`.

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
