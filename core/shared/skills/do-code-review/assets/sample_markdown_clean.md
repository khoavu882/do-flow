---
name: sample-markdown-clean
description: >
  Reviews markdown and prose content for structural health. Use when checking a SKILL.md or
  agent-spec file for a missing Boundaries section, a weak triggering description, dangling
  references/ or modes/ cross-references, or leftover staleness language such as "deprecated".
---

# Sample Markdown Skill (Clean Fixture)

This is a synthetic fixture for `doc_quality_checker.py` — a well-formed document with a
strong triggering description, an explicit Boundaries section, and no dangling references or
stale language, so it should produce zero findings.

Run:
  python scripts/doc_quality_checker.py assets/sample_markdown_clean.md

Expected output: see expected_outputs/sample_markdown_clean_quality.json

## Boundaries

**Will:** analyze markdown and prose files for structural health issues — missing Boundaries
sections, weak triggering descriptions, dangling cross-references, and staleness markers.

**Will Not:** compute a code-smell quality score for prose, or judge subjective writing quality
beyond the deterministic patterns listed above.

## Usage

Run the tool against a target file or directory and read the findings it prints.
