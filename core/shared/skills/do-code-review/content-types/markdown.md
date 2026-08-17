---
content-type: markdown
extensions: [".md"]
---

# Markdown / Prose — Content-Specific Review Notes

Markdown is not treated as a `languages/*.md` entry. The language files' required sections
(Security, Async, Resource Management, Exception Handling, Performance) describe code-execution
concerns that do not translate to prose — forcing markdown through that template would produce
empty or fabricated sections, which is exactly the "invented metrics" problem
`PRINCIPLES.md`'s Professional Honesty principle warns against. This file documents a
content-type-specific set of checks instead, run by `scripts/doc_quality_checker.py`.

Load this file when the reviewed path is a `.md` file. There is no `rules/universal.md`
equivalent for prose — every check below is either skill-specific or guidance-tree-wide, as
noted per check.

---

## Tool

```bash
# Analyze a single file or a directory of .md files
python scripts/doc_quality_checker.py <path>

# JSON output — same finding-list shape as code_quality_checker.py --json
python scripts/doc_quality_checker.py <path> --json
```

Every check below is deterministic and cite-the-match: a finding names the exact line, phrase,
or reference that triggered it. There is no aggregate "quality score" — per this repo's
`PRINCIPLES.md` Professional Honesty principle, an invented single-number score would claim more
precision than a pattern match can support. Treat every finding as "here is the specific thing to
look at," not as a verdict; confirm it against the actual file before editing (the same
manual-verification discipline this feature's own audit applies to its own tooling).

---

## Checks

### 1. Length (SKILL.md files only)

**Applies to:** `SKILL.md` files specifically — not every `.md` file in the tree.

Flags a `SKILL.md` whose line count exceeds skill-creator's progressive-disclosure guideline of
roughly 500 lines. The guideline exists so a skill's main file stays a dispatch/overview surface,
pushing detail into `references/`, `languages/`, `modes/`, or similar sibling files rather than
growing one monolithic document. A finding here cites the actual line count against the ~500-line
threshold — it does not judge whether the content itself is good or bad, only that it has likely
outgrown the single-file shape.

**Interpretation:** if flagged, look for content that belongs in a sibling reference file instead
of `SKILL.md` itself; splitting content out (not just trimming prose) is usually the fix.

### 2. Boundaries section (SKILL.md and agent-spec files)

**Applies to:** `SKILL.md` files, and specialist agent-definition files — identified by
frontmatter shape (`tools:` and `model:` keys present, no `argument-hint:`), not by a fixed path.
This repo keeps its own agent definitions under `core/shared/agent-specs/`, but every harness
installs them under a differently-named directory (typically `agents/`), so the check deliberately
does not hardcode a source-tree path — it works the same way against an installed copy in any
project as it does against this repo's own source.

Flags a file that lacks a `## Boundaries` section, or has one that does not frame scope with
explicit Will / Will Not language. This check is guidance-tree-wide in the sense that it runs
against both file kinds — a skill and an agent spec are held to the same expectation that scope is
stated, not implied.

**Interpretation:** a finding here means the file's scope is not explicit, not that it is wrong.
Add a `## Boundaries` section (or a Will / Will Not pair inside an existing one) describing what
the skill or archetype does and, as importantly, what it deliberately does not do.

### 3. Triggering description (SKILL.md frontmatter `description:` field)

**Applies to:** the `description:` field in `SKILL.md`'s YAML frontmatter only.

Flags a description that is under roughly 40 words, or that does not contain a concrete trigger
phrase or example (e.g., "Use when reviewing pull requests..."). This follows skill-creator's
"make it a little pushy" guidance: the description is what a dispatching agent reads to decide
whether to load the skill at all, so a vague or generic description under-triggers it.

**Interpretation:** a finding here cites the current description's word count and/or the absence
of a "Use when..." style clause. The fix is a more specific description naming concrete scenarios,
not a longer description for its own sake — length and specificity are separate signals and both
should hold.

### 4. Dangling cross-reference

**Applies to:** any `.md` file under the reviewed path (skills, agent specs, or guidance).

Flags any mention of a `references/<name>.md` or `modes/<name>.md` style path that does not resolve
to a real file on disk relative to the reviewing file's own location. This is guidance-tree-wide —
the same broken-link risk exists whether the dangling mention is in a skill, an agent spec, or a
guidance rule file.

**Interpretation:** a finding here cites the exact dangling path string and the file it appeared
in. Either the referenced file needs to be created, or the mention needs to be corrected/removed
— check which is intended before editing, since a dangling reference can indicate an unfinished
file just as easily as a stale one.

### 5. Staleness markers

**Applies to:** any `.md` file under the reviewed path.

Conservatively flags prose containing deprecated / legacy / no longer / outdated / obsolete
language. This check is deliberately conservative: it does not flag a rule or guard whose own
*description* quotes one of these words as the thing being detected (for example, a staleness
guard's own doc-comment listing "deprecated" as a pattern it searches for is not itself stale
prose). Only prose asserting that the surrounding content itself is deprecated/legacy/outdated is
flagged.

**Interpretation:** this check exists to catch false positives, not manufacture them — the
design-phase investigation for this feature already found that a naive keyword grep for
words like "deprecated" produces false positives against files that quote the word as a detection
target rather than describing themselves as stale. Confirm the matched sentence actually describes
the file's own content as outdated before treating it as a real finding; if it is a rule
description quoting the word, it is not a defect.

---

## Adding a New Content Type

Follow the same two-step pattern `languages/*.md` uses for code, but do not reuse that template's
required sections — they are code-execution concerns and do not apply to prose:

1. Create `content-types/<name>.md` describing the checks specific to that content type, not the
   `languages/*.md` section shape (PR Analyzer Signals, Security, Async, Resource Management,
   Exception Handling, Performance, Idioms do not translate to non-code content).
2. Add the content-type row to the dispatch table in `SKILL.md`.
