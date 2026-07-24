---
name: do
description: "DoFlow command dispatcher — session-start announcement, quick command reference, and skill recommendation engine"
argument-hint: "[command] [args...]"
disable-model-invocation: true
effort: low
---

# do

Main entry point for the DoFlow command family: announces session start, dispatches to the
requested skill, and recommends the best-matching skill when the input doesn't name one directly.

## Invocation
```text
/do [command] [args...]
```

## Behavioral Flow
1. **Announce** — on session start, confirm DoFlow is active.
2. **Dispatch** — if `[command]` names a known `/do-*` skill, route to it directly.
3. **Recommend** — if no command is given, or the input doesn't match a known skill, identify the
   best-matching DoFlow skill(s) for `$ARGUMENTS` and explain why.

## Quick Reference
| Skill | Description | Example |
|---------|-------------|---------|
| `/do-pm` | Classify an ambiguous/multi-part request and route each part | `/do-pm "fix X and also document Y"` |
| `/do-research` | Deep web research | `/do-research topic` |
| `/do-index` | Project documentation and knowledge base | `/do-index` |
| `/do-help` | Full skill list | `/do-help` |

If `$ARGUMENTS` bundles 2+ unrelated asks or it's unclear which skill fits, recommend `/do-pm`
over guessing a single skill yourself.
