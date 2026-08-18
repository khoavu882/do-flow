# Research Configuration

No loader reads this file: it holds no knobs, only the discipline a research run follows.

**The class.** `research` is a declared task class whose workflow terminates at synthesis and
declares no readiness template: do not run a readiness check, and do not report one as skipped.

**Retrieval.** Resolve each information need through the capability router (`"$DOFLOW" route`),
not a named vendor. `"$DOFLOW" capabilities` lists the registered capabilities and
`doflow capabilities` reports which provider answers on *this* machine — no written table can.
Two passes, in order: one broad discovery pass over the whole scope — terminology, surfaces,
competing readings — concluding nothing; then one targeted pass per named sub-question.

**Stopping.** Stop when every sub-question has an answer or a stated gap, **and** the last round
produced no new source. A round that only restates what you have is the last.
Report the remaining gaps rather than searching to raise a count.

**Reporting.** Source, provenance and locator per item — never a score, a credibility rating or a
confidence. Schema and refused fields: `EVIDENCE_LEDGER.md`, beside this file.
