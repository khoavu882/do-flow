# Research Configuration

No loader reads this file: it holds no knobs, only the discipline a research run follows.

**The class.** `research` is a declared task class whose workflow terminates at synthesis and
declares no readiness template: do not run a readiness check, and do not report one as skipped.

**Retrieval.** The capability router covers repository-local needs only — every registered
capability resolves inside this repo, and `route` rejects a web intent by name. Web retrieval is
the harness's own tools; name what answered in the report rather than a vendor you assumed. Ask
`"$DOFLOW" capabilities` what is registered instead of trusting a written table, but do not expect
a search provider there yet.
Two passes, in order: one broad discovery pass over the whole scope — terminology, surfaces,
competing readings — concluding nothing; then one targeted pass per named sub-question.

**Stopping.** Stop when every sub-question has an answer or a stated gap, **and** the last round
produced no new source. A round that only restates what you have is the last.
Report the remaining gaps rather than searching to raise a count.

**Reporting.** Source, provenance and locator per item — never a score, a credibility rating or a
confidence. Schema and refused fields: `EVIDENCE_LEDGER.md`, beside this file.
