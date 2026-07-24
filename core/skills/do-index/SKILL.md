---
name: do-index
description: "Generate comprehensive project documentation and knowledge base with intelligent organization"
argument-hint: "[target] [--type docs|api|structure|readme] [--format md|json|yaml]"
disable-model-invocation: true
effort: medium
---

# do-index

Whole-project documentation/knowledge-base generation — scope is the entire project (or a named
subtree), not one component. Distinct from `/do-document` (docs for one specific
component/function/API/feature) and `/do-explain` (no-artifact educational explanation).

## Invocation
```text
/do-index [target] [--type docs|api|structure|readme] [--format md|json|yaml]
```

## Behavioral Flow
1. **Survey** `[target]` (default: repo root) — enumerate top-level directories, entry points
   (`package.json`/`pyproject.toml`/build files), and existing docs (`README.md`, `docs/`,
   `CLAUDE.md`) so new output builds on what's there instead of duplicating it.
2. **Generate** by `--type`:
   - `structure`: a directory/module map with a one-line responsibility per top-level
     component — grounded in what's actually in the tree, not an assumed convention.
   - `api`: enumerate actual exported functions/endpoints/classes (via real exports, route
     definitions, or OpenAPI/GraphQL schema if present) — never invent a signature that isn't in
     the source.
   - `readme`: project overview, install/run instructions pulled from actual `package.json`
     scripts or build files (not generic placeholders), and a structure summary.
   - `docs`: all of the above assembled into one navigable set, cross-linked.
3. **Preserve manual content** — if a target doc file already exists, diff against it first;
   merge generated content into the existing structure rather than overwriting hand-written
   prose, and flag (don't silently drop) any manual section that no longer matches the current
   code so the user can decide whether it's stale or intentional.
4. **Cross-reference**: link related sections (e.g. an API doc entry back to its structure-map
   entry) so the output is navigable as a set, not a pile of disconnected files.
5. **Output** in `--format` (`md` default; `json`/`yaml` for tooling consumption) to the target
   location implied by `--type` (e.g. `README.md` for `readme`, `docs/` for `docs`/`api`).

## Boundaries
**Will:** generate or update whole-project documentation grounded in the actual codebase;
preserve and flag conflicts with existing manual documentation; cross-reference generated
sections.
**Will Not:** overwrite hand-written documentation without flagging the conflict first; invent
API signatures, structure, or install instructions not present in the actual source; document a
single component in isolation (that's `/do-document`'s scope, not this skill's).
