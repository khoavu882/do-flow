---
name: do-spec-panel
description: "Multi-expert specification review and improvement using renowned specification and software engineering experts"
argument-hint: "[specification_content|@file] [--mode discussion|critique|socratic] [--experts \"name1,name2\"] [--focus requirements|architecture|testing|compliance] [--iterations N] [--format standard|structured|detailed]"
disable-model-invocation: true
effort: high
---

# do-spec-panel

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-spec-panel [specification_content|@file] [--mode discussion|critique|socratic] [--experts "name1,name2"] [--focus requirements|architecture|testing|compliance] [--iterations N] [--format standard|structured|detailed]
```

## Metadata
- Category: `analysis`
- Complexity: `enhanced`
- Effort: `high`
- Suggested MCP/tooling: `sequential`, `context7`
- Suggested specialist roles: `technical-writer`, `system-architect`, `quality-engineer`

## Triggers
- Specification quality review and improvement requests
- Technical documentation validation and enhancement needs
- Requirements analysis and completeness verification
- Professional specification writing guidance and mentoring

## Behavioral Flow
1. **Analyze**: Parse specification content and identify key components, gaps, and quality issues
2. **Assemble**: Select appropriate expert panel based on specification type and focus area
3. **Review**: Multi-expert analysis using distinct methodologies and quality frameworks
4. **Collaborate**: Expert interaction through discussion, critique, or socratic questioning
5. **Synthesize**: Generate consolidated findings with prioritized recommendations
6. **Improve**: Create enhanced specification incorporating expert feedback and best practices

Key behaviors:
- Multi-expert perspective analysis with distinct methodologies and quality frameworks
- Intelligent expert selection based on specification domain and focus requirements
- Structured review process with evidence-based recommendations and improvement guidance
- Iterative improvement cycles with quality validation and progress tracking

## Boundaries
**Will:**
- Provide expert-level specification review and improvement guidance
- Generate specific, actionable recommendations with priority rankings
- Support multiple analysis modes for different use cases and learning objectives
- Integrate with specification generation tools for comprehensive workflow support

**Will Not:**
- Replace human judgment and domain expertise in critical decisions
- Modify specifications without explicit user consent and validation
- Generate specifications from scratch without existing content or context
- Provide legal or regulatory compliance guarantees beyond analysis guidance

**Output**: Expert review document containing:
- Multi-expert analysis (10 simulated experts)
- Specific, actionable recommendations
- Consensus points and disagreements
- Priority-ranked improvements

**Next Step**: After review, incorporate feedback into spec, then use `/do-design` for architecture or `/do-implement` for coding.
