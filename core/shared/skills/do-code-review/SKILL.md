---
name: do-code-review
description: Code review automation for TypeScript, JavaScript, Python, Go, Swift, Kotlin, C#, .NET, Java, C, C++, Rust, Ruby, PHP, Dart/Flutter, and Shell, plus declarative YAML/JSON config and OpenAPI specs. Analyzes PRs for complexity and risk, checks code quality for SOLID violations and code smells, generates review reports. Use when reviewing pull requests, analyzing code quality, identifying issues, generating review checklists.
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
    shell.md                      ← Shell-specific rules + idioms
  content-types/
    markdown.md                   ← Markdown / prose review notes (checked by doc_quality_checker.py)
    config.md                     ← YAML / JSON / OpenAPI declarative review notes
```

`content-types/` is a sibling of `languages/`, not a subdirectory of it — it dispatches by content
type (prose vs. code) rather than by programming language; see `content-types/markdown.md`.

### Loading order for every review

1. This file (`SKILL.md`) — tools and thresholds
2. `rules/universal.md` — always, for every language
3. The matching `languages/*.md` — one file based on the extension table below

Two additional files for code (`rules/universal.md` + one `languages/*.md`); one for prose
(`content-types/markdown.md`, which has no universal counterpart).

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
| `.sh`, `.bash`, `.zsh` | `languages/shell.md` |

---

### Content-type dispatch

For non-code content, a second axis applies alongside (or instead of) the language table above:

| Content type | Extension(s) | Load |
|---|---|---|
| Markdown / prose | `.md` | `content-types/markdown.md` |
| Declarative config | `.yaml`, `.yml`, `.json` | `content-types/config.md` |

Markdown dispatch runs `scripts/doc_quality_checker.py` instead of `code_quality_checker.py` — see
`content-types/markdown.md` for the checks it performs. Declarative config stays with
`code_quality_checker.py`, which routes those extensions to a structural path that reports no
complexity, function count or SOLID verdict — see `content-types/config.md` for why.

---

## The Review Contract

State this before producing a single finding, and report against it when the review ends.

1. **The file set, and how it was derived** — the `pr_analyzer.py` diff between base and head, the
   paths the user named, or the working tree. Name the derivation, not just the count. A file the
   derivation includes but the review never opened is reported as not reviewed; it is never dropped
   from the list.
2. **The rules files that will load** — from the dispatch tables above: `rules/universal.md` plus
   one `languages/*.md` per code file, `content-types/markdown.md` per prose file. Name them before
   loading them, so a file reviewed under the wrong rules is visible rather than plausible.
3. **What this review refuses to conclude** — it does not certify a file it did not open, does not
   report a threshold the analyzer does not implement, and does not convert a score into a verdict
   the table below does not define. A check that could not run is reported as not run.
4. **The coverage the analyzer actually achieved** — `code_quality_checker.py` reports
   `files_analyzed`, `files_skipped` and a `coverage` of `complete` or `partial`. Report all three.
   A `partial` coverage means the verdict describes the analysed subset, and saying so is not
   optional: a score presented as if it covered the whole change is the defect this contract exists
   to prevent.
5. **Process-leak scan** — run
   `doflow leak-scan --path <each reviewed file> --json` over the reviewed set. These are DoFlow's
   own identifiers (`FR-###`, `agent-docs/`, chain artifact names) reaching files that ship to
   people who never used DoFlow. Occurrences inside `agent-docs/` are correct usage and the verb
   excludes them itself. The verb reports and never blocks.

   **Say which kind of repository you are scanning before you list anything.** A repository that
   *uses* DoFlow should contain none of this vocabulary outside `agent-docs/`, so every finding is
   worth a line. A repository that *implements* it — DoFlow's own tree, or any project vendoring the
   chain — contains it correctly and by the hundred: its scaffold generator writes `requirement.md`,
   its guards assert on `FR-###`, its changelog describes the chain. Listing those individually
   teaches a reviewer to skip this step, and a skipped check protects nothing.

   So: in an implementing repository, narrow the scan with `--exclude <segment>` (repeatable, and it
   extends the artifact-directory exclusion rather than replacing it), and report the count you
   excluded alongside the findings you kept. Never silently drop a path — the verb reports an
   excluded file as `unscanned` with its reason, and so should you.

   **Derive the exclusion set, do not judge it by eye.** What a repository *implements* is what its
   package manifest ships plus its tests — for DoFlow that is `package.json`'s
   `files: ["bin/", "src/", "core/"]`, so the set is `--exclude bin --exclude src --exclude core
   --exclude test`. Reading "the code that ships onward" as a matter of judgement is how this step
   was first narrowed wrong: `bin/` was left in and its internal requirement references were
   reported as leaks, when `bin/` is as much DoFlow's implementation as `src/` is.

   What survives that exclusion in an implementing repository is documentation *about* the chain —
   a changelog, a docs tree — which contains the vocabulary correctly and in volume. Report the
   count and say so, rather than pasting it. In DoFlow's own repository this step therefore has no
   applicable surface at all, and saying that plainly is the honest result, not a failure to look.

**Stop when** every file in the reviewed set the contract names has an answer or a stated gap, **and** the last round produced no new file in the reviewed set. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

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
| Too many params | >5 |
| High complexity | >10 branches |
| God class | >20 methods |
| Too many imports | >15 |

Transcribed from the `THRESHOLDS` dict in `scripts/code_quality_checker.py`, in its order — that
dict is the source of truth, so re-check it there rather than trusting this table. Those five are
the whole set: the checker implements no file-length and no nesting-depth check, so do not report a
finding against one.

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

## Recording the Review

1. **Resolve the runtime seam** — every DoFlow runtime call in this skill goes through the runtime
   seam. Resolve it **once** here and reuse `$DOFLOW` for every later call in this skill:

```bash
# Resolve the DoFlow runtime: nearest project install wins, then the global one.
D=$PWD; while [ "$D" != / ] && [ ! -x "$D/.doflow/scripts/doflow/bin/doflow-run" ]; do D=$(dirname "$D"); done
DOFLOW="$D/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || DOFLOW="$HOME/.doflow/scripts/doflow/bin/doflow-run"
[ -x "$DOFLOW" ] || { echo "doflow: no runtime found in any .doflow/ above $PWD, nor at $HOME/.doflow. Run: npx @khoavu882/doflow install" >&2; exit 2; }
```

   Run every command below from the project root — the walk-up starts at `$PWD`. On exit 2, print
   the message verbatim and stop; it names every path searched.

2. **Batch this stage's evidence** — one pass here at the stage boundary, never one call per fact.
   `<task id>` is the unit these stores key on — the same id the chain's earlier stages recorded
   against, or the feature slug when this review runs standalone. Use it for every `evidence` and
   `claim` call this review makes:
   ```bash
   "$DOFLOW" evidence --task-id "<task id>" --action add --batch <batch>.json --json
   "$DOFLOW" claim --task-id "<task id>" --action add --statement "<one conclusion>"
   ```
   Item schema, provenance rules, and the refused-field list: the guidance tree's
   `references/EVIDENCE_LEDGER.md`. Read it before writing the batch.

   This stage's items are its findings. A finding read from code — a detection surfaced by the PR
   Analyzer, the Code Quality Checker, or your own reading of a diff line — is `extracted` and
   carries a `locator`. A judgement the reviewer reached about that finding — severity, root cause,
   whether it blocks — is `inferred` and carries `content`. Keep the two distinguishable in the
   batch the way the Tools section above already keeps a detection distinguishable from a
   conclusion in the report: never file a judgement as if it were something the code itself stated.
   Add the review's verdict rationale and any other conclusion as a claim in the same pass.

   A finding never carries `score`, `confidence`, `relevance` or a similarity field — the runtime
   refuses those keys by name and the whole batch writes nothing. The Complexity score and Risk
   categorization this skill's Tools compute are inputs to your `content`, never fields on the item.

   This gains the review no gate: recording evidence and claims here is bookkeeping, not authority.
   `do-code-review` still cannot block a merge or stop a downstream stage — only the Block verdict
   in its own report, read by a human or by `/do-implement`, does that.

## Boundaries

**Will:** Analyze source and prose for complexity, risk, SOLID violations, and code/doc smells;
generate structured review reports with a verdict (Approve / Approve with suggestions / Request
changes / Block); dispatch by language or content type to the matching rules file.

**Will Not:** Edit files, apply fixes, or otherwise remediate the findings it reports — that is
`/do-implement`'s job once a review has run. It also does not orchestrate a multi-task checklist
through specialist subagents (`/do-execute-plan`'s job) or replace human judgment on a Block verdict.

## Running the review in a subagent

A review over a large change can be dispatched whole to the `quality-guardian` archetype, which
already declares code quality review among its capabilities, and which returns its report to the
calling session. Use it when the analysis would otherwise consume context the caller still needs for
the work itself.

This changes **where** the review runs and nothing else: the dispatched review loads the same rules
files by the same dispatch tables, states the same Review Contract, and returns the same verdict
vocabulary. A dispatched review that reports differently from an in-session one is a defect, not a
variant.

Name the model tier explicitly on the dispatch — scale it to the diff's size and risk rather than
inheriting the session's model. See the guidance tree's `references/MODEL_SELECTION.md`; a final
whole-scope review sits at `frontier`, a re-review of one small fix diff at `light`–`standard`.

This is not the multi-task orchestration the boundary above rules out: one review, one subagent, one
report back.

## Next Step
After review, use `/do-implement` to address requested changes, then rerun `/do-code-review`.
On a clean review with nothing left to fix, consider `/do-document --type impl` to record what was built — optional, and does not gate or pause completion.