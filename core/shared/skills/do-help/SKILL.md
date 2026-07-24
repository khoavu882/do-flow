---
name: do-help
description: "List all available DoFlow skills and their functionality"
effort: low
---

# do-help

Skill discovery — lists every skill actually installed alongside this file, not a fixed/cached
table. Self-contained: makes no assumption about being run from any particular repo (this one or
a consuming project) — it only ever looks at its own sibling skill directories.

## Invocation
```text
/do-help
```

## Behavioral Flow
1. **Locate the skills directory** — the directory containing this file (`do-help/`'s parent).
   List its sibling directories, each expected to hold one `SKILL.md`.
2. **Read each skill's frontmatter** — `name`, `description`, `disable-model-invocation`,
   `user-invocable`. Don't paraphrase descriptions from memory; a description can change
   independently of this file, and the live frontmatter is the only source that can't drift.
3. **Group by invocation mode**, derived from frontmatter, not a hardcoded list:
   - `disable-model-invocation: true` → **manual command** (typed `/skill-name` only).
   - `disable-model-invocation: false` + `user-invocable: false` → **auto-loaded policy**
     (background guidance, not normally typed directly).
   - `disable-model-invocation: false` + `user-invocable: true` (or unset) → **hybrid**
     (Claude may auto-load it, or it can be typed directly).
4. **Present**: one table per group, `/skill-name` + description. If a skill's own doc content
   (its Boundaries/Next Step section) names a fixed sequence with other skills — chain skills
   whose `description` or body mentions the doflow phase flow — surface that sequence first, since
   it's usually the primary path a new user wants.

## Boundaries
**Will:** enumerate the skill set actually present next to this file, grouped by each skill's own
frontmatter.
**Will Not:** execute any listed skill; edit any file; reference a fixed skill count, table, or
external doc path — none of that survives being installed into a project that doesn't have it.
