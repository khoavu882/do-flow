---
name: do-research
description: "Deep web research with adaptive planning and intelligent search"
argument-hint: "\"[query]\" [--depth quick|standard|deep|exhaustive] [--strategy planning|intent|unified]"
disable-model-invocation: true
effort: high
context: fork
agent: deep-research-agent
---

# do-research

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-research "[query]" [--depth quick|standard|deep|exhaustive] [--strategy planning|intent|unified]
```

## Metadata
- Category: `command`
- Complexity: `advanced`
- Effort: `high`
- Suggested MCP/tooling: `sequential`, `playwright`
- Suggested specialist roles: `deep-research-agent`

## Summary
> **Context Framework Note**: This command activates comprehensive research capabilities with adaptive planning, multi-hop reasoning, and evidence-based synthesis.

## Triggers
- Research questions beyond knowledge cutoff
- Complex research questions
- Current events and real-time information
- Academic or technical research requirements
- Market analysis and competitive intelligence

## Behavioral Flow
### 1. Understand (5-10% effort)
- Assess query complexity and ambiguity
- Identify required information types
- Determine resource requirements
- Define success criteria

### 2. Plan (10-15% effort)
- Select planning strategy based on complexity
- Identify parallelization opportunities
- Generate research question decomposition
- Create investigation milestones

### 3. TodoWrite (5% effort)
- Create adaptive task hierarchy
- Scale tasks to query complexity (3-15 tasks)
- Establish task dependencies
- Set progress tracking

### 4. Execute (50-60% effort)
- **Parallel-first searches**: Always batch similar queries
- **Smart extraction**: Route by content complexity
- **Multi-hop exploration**: Follow entity and concept chains
- **Evidence collection**: Track sources and confidence

### 5. Track (Continuous)
- Monitor TodoWrite progress
- Update confidence scores
- Log successful patterns
- Identify information gaps

### 6. Validate (10-15% effort)
- Verify evidence chains
- Check source credibility
- Resolve contradictions
- Ensure completeness

## Key Patterns
### Parallel Execution
- Batch all independent searches
- Run concurrent extractions
- Only sequential for dependencies

### Evidence Management
- Track search results
- Provide clear citations when available
- Note uncertainties explicitly

### Adaptive Depth
- **Quick**: Basic search, 1 hop, summary output
- **Standard**: Extended search, 2-3 hops, structured report
- **Deep**: Comprehensive search, 3-4 hops, detailed analysis
- **Exhaustive**: Maximum depth, 5 hops, complete investigation

## Boundaries
**Will**: Current information, intelligent search, evidence-based analysis
**Won't**: Make claims without sources, skip validation, access restricted content

## CRITICAL BOUNDARIES
**STOP AFTER RESEARCH REPORT**

This skill produces a RESEARCH REPORT ONLY - no implementation.

**Explicitly Will NOT**:
- Implement findings or recommendations
- Write code based on research
- Make architectural decisions
- Create system changes based on research

**Output**: Research report (`agent-docs/research_*.md`) containing:
- Findings with sources
- Evidence-based analysis
- Recommendations (for human decision)
- Cited references

**Next Step**: After research completes, user decides next action. Use `/do-design` for architecture or `/do-implement` for coding.

## Output Standards
- Save reports to `agent-docs/research_[topic]_[timestamp].md`
- Include executive summary
- Provide confidence levels
- List all sources with citations
