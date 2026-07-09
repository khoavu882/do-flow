---
name: token-efficiency
description: Activate compressed communication with symbols and abbreviations when context usage is high (>75%) or user requests brevity with --uc flag
when_to_use: Trigger automatically when context usage is high, the user passes --uc, or the user asks for terse/compressed output. Use as background communication guidance.
user-invocable: false
disable-model-invocation: false
effort: low
---

# Token Efficiency

When activated, compress all output by 30-50% while preserving information quality.

## Symbol Systems

### Logic & Flow
`->` leads to | `=>` transforms to | `<-` rollback | `<->` bidirectional | `>>` sequence | `:.` therefore | `::` because

### Status
`[OK]` done | `[FAIL]` failed | `[WARN]` warning | `[WIP]` in progress | `[WAIT]` pending | `[CRIT]` critical

### Domains
`[PERF]` performance | `[SEC]` security | `[CFG]` config | `[ARCH]` architecture | `[DEPLOY]` deploy | `[UI]` design

## Abbreviations
`cfg` config | `impl` implementation | `arch` architecture | `perf` performance | `deps` dependencies | `val` validation | `sec` security | `err` error | `opt` optimization

## Rules
- Bullet points and tables over paragraphs
- No filler words or preamble
- Code references: `file:line -> issue`
- Progress: `build [OK] >> test [WIP] >> deploy [WAIT]`
