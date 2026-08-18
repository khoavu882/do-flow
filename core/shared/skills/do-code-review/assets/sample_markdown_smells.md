---
name: sample-markdown-smells
description: Helps with markdown stuff sometimes.
---

# Sample Markdown Skill (Smells Fixture)

This is a synthetic fixture for `doc_quality_checker.py` — NOT a real skill, just a document
shaped like a `SKILL.md` (frontmatter, a short description, a body) so the checker's
content-agnostic checks (dangling references, staleness markers) have real prose to exercise.
It intentionally omits a `## Boundaries` section and uses a weak, un-triggering description,
mirroring the structural gaps `doc_quality_checker.py` is built to catch on a real SKILL.md.

Run:
  python scripts/doc_quality_checker.py assets/sample_markdown_smells.md

Expected output: see expected_outputs/sample_markdown_smells_quality.json

## Overview

For the full background on this pattern, see `references/does-not-exist.md`, which was never
written.

This approach is deprecated and should not be used anymore — teams should migrate away from it
entirely before relying on any of the examples below.

## Usage

Run the tool against a target file or directory and read the findings it prints.
