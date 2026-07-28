# DoFlow Framework Flags

Behavioral flags that change how a request is handled. This file is loaded into **every** session
on every harness, so it documents only flags that route somewhere real — a flag with no consumer
is removed rather than kept as aspiration.

**MCP short flags are not listed here.** They vary per install and are generated into
`MCP_INDEX.md` from the servers actually selected, so this file never names a server you may not
have installed.

## Mode Activation

Each of these loads a behavioral mode from `modes/`. Modes are lazy — the skill named below is
what reads them, so every mode has exactly one load point.

**--brainstorm** — vague or exploratory request ("maybe", "thinking about", "not sure").
Collaborative discovery: probe before proposing. Loaded by `do-brainstorm`.

**--introspect** — self-analysis, error recovery, or a problem needing exposed reasoning.
Surfaces the thinking process with transparency markers. Loaded by `do-reflect`.

**--task-manage** — multi-step work (>3 steps) or wide scope (>2 directories, >3 files).
Orchestrates through delegation and progressive checkpoints. Loaded by `do-execute-plan`.

**--delegate** — >7 directories, >50 files, or complexity above ~0.8. Routes work to sub-agents
in parallel instead of one pass. Described in `modes/MODE_Task_Management.md`.

## Analysis Depth

Escalating reasoning budget; each tier subsumes the one before it.

**--think** — multi-component analysis, moderate complexity.
**--think-hard** — architectural analysis, system-wide dependencies.
**--ultrathink** — critical redesign, legacy modernization, hard debugging.

## Execution Control

**--iterations [n]** — improvement cycles to run (1–10). Consumed by `do-spec-panel`.

**--focus [performance|security|quality|architecture|accessibility|testing]** — narrows analysis
to one domain. Consumed by `do-analyze`, `do-troubleshoot`, and `do-spec-panel`.

<important if="operating in production, on shared infrastructure, or performing risky operations">
**--validate** — pre-execution risk assessment and validation gates before acting. Consumed by
`do-reflect`.
</important>

## Priority Rules

**Safety first** — `--validate` outranks any optimization flag.
**Explicit over inferred** — a flag the user typed beats auto-detection.
**Depth is ordered** — `--ultrathink` > `--think-hard` > `--think`.
