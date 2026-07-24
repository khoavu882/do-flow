---
name: do-explain
description: "Provide clear explanations of code, concepts, and system behavior with educational clarity"
when_to_use: Trigger automatically for read-only explanations of code, architecture, system behavior, errors, APIs, framework concepts, or project workflows. Do not edit files in auto mode.
argument-hint: "[target] [--level basic|intermediate|advanced] [--format text|examples|interactive] [--context domain]"
disable-model-invocation: false
user-invocable: true
effort: medium
---

# do-explain

Educational explanation only — produces no file, no artifact. Distinct from `/do-document`
(produces a documentation file) and `/do-index` (whole-project doc generation) — this is
conversational, in-response explanation of code/concepts/behavior that already exists.

## Invocation
```text
/do-explain [target] [--level basic|intermediate|advanced] [--format text|examples|interactive] [--context domain]
```

## Behavioral Flow
1. **Read the actual target** — the real code/config/error being asked about, not a generic
   description of the pattern it resembles. If `[target]` is a concept rather than a specific
   file (e.g. "how does the MCP merge work"), locate its concrete implementation in this repo
   first (the specific function/module) and explain from that, not from general knowledge alone.
2. **Calibrate to `--level`**:
   - `basic`: what it does and why it matters, minimal jargon, define any term used.
   - `intermediate` (default): what it does, how, and the key design decision(s) behind it.
   - `advanced`: the above plus edge cases, trade-offs considered, and how it interacts with
     neighboring code.
3. **Structure by `--format`**: `text` — prose explanation. `examples` — walk a concrete
   input/output or before/after through the logic. `interactive` — pose a question back to check
   understanding before continuing (used for multi-part explanations, not simple lookups).
4. **Ground every claim** in the actual code read in step 1 — cite the specific file:line or
   config key a claim comes from, rather than a plausible-sounding generality; if something is
   genuinely ambiguous or undocumented in the code itself, say so instead of guessing.
5. **Stop at explanation** — no file is written, no code is changed, even if the explanation
   surfaces something that looks like a bug (name it, then hand off — don't fix it inline).

## Boundaries
**Will:** explain code/concepts/behavior grounded in this repo's actual implementation, at a
calibrated depth, with cited sources for factual claims.
**Will Not:** write or edit any file; fix a bug or issue surfaced during explanation (name it and
suggest `/do-troubleshoot` or `/do-improve` instead); explain from generic pattern-knowledge when
the actual implementation is available and could be read instead.
