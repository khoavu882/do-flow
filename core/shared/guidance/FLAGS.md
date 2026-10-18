# Runtime Behavior and Flags

What a flag used to request is now mostly unconditional, so this states the behavior once
rather than listing knobs.

## Always on

**Readiness gating** — a stage that edits source is graded against its class contract first;
the verdict is one of four states, never a number.
**Recovery bounds** — a failed verification is classified and retried under a bound the runtime
sets. You do not pick a cycle count.
**Run tracing** — every runtime call is recorded as it happens and read back; where a run
stopped is read from that record, never reconstructed.
**Capability routing** — an information need resolves to a provider healthy on this machine, not to
a habitual tool.

## Flags

What the user typed beats auto-detection. A flag is declared in the `argument-hint` of every
skill that consumes it; shared flags are `--depth` and `--type`.

**--focus [quality|security|performance|architecture]** — narrows analysis to one domain. Consumed
by `do-diagnose`.

MCP short flags are generated per install into `MCP_INDEX.md`; this file names no server.
