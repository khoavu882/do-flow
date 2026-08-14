---
name: do-document
description: "Unified documentation and knowledge engine — generate guides, API references, architecture knowledge bases, and deep web research reports"
argument-hint: "[target|query] [--type api|guide|impl|index|research] [--depth quick|standard|deep]"
effort: medium
---

# do-document

Unified documentation, technical writing, architecture indexing, and web research engine.

## Invocation
```text
/do-document [target|query] [--type api|guide|impl|index|research] [--depth quick|standard|deep]
```

## Behavioral Flow

1. **Classify Documentation Scope**:
   - `api` / `guide`: Component docs, endpoint references, interface contracts, docstrings.
   - `impl`: Generates `agent-docs/doflow/<slug>/implementation-flow.md` summarizing feature decisions, deviations, and test verifications.
   - `index`: Whole-project architecture overview and knowledge base mapping. Consult `references/index_generator.md`.
   - `research`: Evidence-based web research and synthesis with verified citations. Consult `references/deep_research.md`.

2. **Analysis & Synthesis**:
   - Extract interface shapes, doc comments, types, and architectural dependencies.
   - For research queries, follow multi-hop retrieval chains and record confidence per claim.

3. **Output Generation**:
   - Format with concise markdown hierarchy, code examples, and clickable repository links.

## Boundaries
**Will:** Generate documentation, implementation flow summaries, project architecture indexes, and cited research reports.
**Will Not:** Modify business logic code or make unverified factual assertions in research.
