# Deep Web Research Reference

Methodology for multi-hop evidence collection and cited reporting:

## Research Process

**Discovery first.** One broad pass over the whole reported scope to find the terminology, the surfaces involved, and the competing readings — do not conclude here. Only then, one targeted pass per named sub-question.

1. **Query Decomposition**: break what the discovery pass surfaced into independent and sequenced search vectors — not the question as it arrived.
2. **Batch Retrieval**: Execute independent searches in parallel; follow entity hops.
3. **Claim & Source Tracking**: Link every claim directly to a cited source URL, and mark whether the claim is extracted from that source or inferred by you from it.
4. **Report Output**: Save detailed findings with an Executive Summary and Citation Table to `agent-docs/research/[topic]_[timestamp].md`.

**Stop when** every sub-question the contract names has an answer or a stated gap, **and** the last round produced no new sub-question. A round that only restates what you already have is the last round. Report the remaining gaps rather than continuing.

## Behavioral Posture
For deep investigation protocols, consult the guidance tree's `modes/MODE_DeepResearch.md`; for what
the research class does and does not configure, the guidance tree's `references/RESEARCH_CONFIG.md`.
