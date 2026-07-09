---
name: do-estimate
description: "Provide development estimates for tasks, features, or projects with intelligent analysis"
when_to_use: Trigger automatically for read-only time, effort, complexity, scope, risk, or resource estimates. Stop after the estimate; do not start planning or implementation.
argument-hint: "[target] [--type time|effort|complexity] [--unit hours|days|weeks] [--breakdown]"
disable-model-invocation: false
user-invocable: true
effort: low
---

# do-estimate

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-estimate [target] [--type time|effort|complexity] [--unit hours|days|weeks] [--breakdown]
```

## Metadata
- Category: `special`
- Complexity: `standard`
- Effort: `low`
- Suggested MCP/tooling: `sequential`, `context7`
- Suggested specialist roles: `architect`, `performance`, `project-manager`

## Triggers
- Development planning requiring time, effort, or complexity estimates
- Project scoping and resource allocation decisions
- Feature breakdown needing systematic estimation methodology
- Risk assessment and confidence interval analysis requirements

## Behavioral Flow
1. **Analyze**: Examine scope, complexity factors, dependencies, and framework patterns
2. **Calculate**: Apply estimation methodology with historical benchmarks and complexity scoring
3. **Validate**: Cross-reference estimates with project patterns and domain expertise
4. **Present**: Provide detailed breakdown with confidence intervals and risk assessment
5. **Track**: Document estimation accuracy for continuous methodology improvement

Key behaviors:
- Multi-persona coordination (architect, performance, project-manager) based on estimation scope
- Sequential MCP integration for systematic analysis and complexity assessment
- Context7 MCP integration for framework-specific patterns and historical benchmarks
- Intelligent breakdown analysis with confidence intervals and risk factors

## Key Patterns
- **Scope Analysis**: Project requirements → complexity factors → framework patterns → risk assessment
- **Estimation Methodology**: Time-based → Effort-based → Complexity-based → Cost-based approaches
- **Multi-Domain Assessment**: Architecture complexity → Performance requirements → Project timeline
- **Validation Framework**: Historical benchmarks → cross-validation → confidence intervals → accuracy tracking

## Boundaries
**Will:**
- Provide systematic development estimates with confidence intervals and risk assessment
- Apply multi-persona coordination for comprehensive complexity analysis
- Generate detailed breakdown analysis with historical benchmark comparisons

**Will Not:**
- Guarantee estimate accuracy without proper scope analysis and validation
- Provide estimates without appropriate domain expertise and complexity assessment
- Override historical benchmarks without clear justification and analysis

## CRITICAL BOUNDARIES
**STOP AFTER ESTIMATION**

This skill produces an ESTIMATION REPORT ONLY - no implementation.

**Explicitly Will NOT**:
- Execute work based on estimates
- Create implementation timelines for execution
- Start implementation tasks
- Make commitments on behalf of user

**Output**: Estimation report containing:
- Time/effort breakdown
- Complexity analysis
- Confidence intervals
- Risk assessment
- Resource requirements

**Next Step**: After estimation, user decides on timeline. Use `/do-plan` for planning or `/do-implement` for execution.
