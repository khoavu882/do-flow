# DoFlow Framework Flags

Behavioral flags that change how a request is handled. This file is loaded into **every** session
on every harness, so it documents only flags that route somewhere real — a flag with no consumer
is removed rather than kept as aspiration.

**MCP short flags are not listed here.** They vary per install and are generated into
`MCP_INDEX.md` from the servers actually selected, so this file never names a server you may not
have installed.

## Execution Control

**--iterations [n]** — improvement cycles to run (1–10). Consumed by `do-diagnose` and `do-execute-plan`.

**--focus [performance|security|quality|architecture|accessibility|testing]** — narrows analysis to one domain. Consumed by `do-diagnose`.

<important if="operating in production, on shared infrastructure, or performing risky operations">
**--validate** — pre-execution risk assessment and validation gates before acting. Consumed by `do-diagnose` and `do-execute-plan`.
</important>

## Priority Rules

**Safety first** — `--validate` outranks any optimization flag.
**Explicit over inferred** — a flag the user typed beats auto-detection.
**Parallel execution** is the default.
