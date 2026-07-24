---
name: do-research
description: "Deep web research with adaptive planning and intelligent search"
argument-hint: "\"[query]\" [--depth quick|standard|deep|exhaustive] [--strategy planning|intent|unified]"
effort: high
context: fork
agent: deep-research-agent
---

# do-research

Deep, evidence-based web research — forks into `deep-research-agent` so the main session's context
isn't consumed by search noise. Produces a cited report only, never implements findings.

## Invocation
```text
/do-research "[query]" [--depth quick|standard|deep|exhaustive] [--strategy planning|intent|unified]
```

## Behavioral Flow
1. **Understand** (5-10% effort): assess query complexity/ambiguity, identify what information
   types are actually needed, define what "answered" looks like before searching.
2. **Plan** (10-15% effort): decompose into sub-questions; identify which can be searched in
   parallel (no dependency between them) vs. which require a prior answer first (multi-hop).
3. **TodoWrite** (5% effort): scale task count to `--depth` (roughly 3 tasks at `quick`, up to 15
   at `exhaustive`); set dependencies so parallel-safe searches are marked as such.
4. **Execute** (50-60% effort): batch all independent searches in one turn, not one-by-one; follow
   entity/concept chains for multi-hop questions; track each claim's source as it's collected, not
   after the fact.
5. **Track** (continuous): update confidence per claim as corroborating/contradicting sources
   appear; note information gaps explicitly rather than filling them with inference.
6. **Validate** (10-15% effort): every claim in the final report traces to a source; contradictions
   between sources are surfaced, not silently resolved by picking one; sources are logged even
   when a claim can't be confidently made — dropping evidence a search actually surfaced changes
   the report's conclusions and readers can't distinguish "verified" from "asserted" without it.

## Depth levels
- `quick`: 1 hop, summary output.
- `standard` (default): 2-3 hops, structured report.
- `deep`: 3-4 hops, detailed analysis.
- `exhaustive`: 5 hops, complete investigation.

## Boundaries
**Will:** search and synthesize current information with tracked, cited sources; flag
uncertainties and contradictions explicitly.
**Will Not:** implement findings, write code, make architectural decisions, or access restricted
content; make a claim without a source.

## Output
Save to `agent-docs/research_[topic]_[timestamp].md`: executive summary, findings with sources,
confidence levels per claim, full citation list.

## Next Step
User decides on findings — `/do-design` for architecture implications, `/do-implement` for coding.
