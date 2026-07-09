---
name: do-analyze
description: "Comprehensive code analysis across quality, security, performance, and architecture domains"
when_to_use: Trigger automatically for read-only quality, security, performance, architecture, or technical-debt analysis. Auto mode must report findings and recommendations only; edits require explicit user request and confidence-check first.
argument-hint: "[target] [--focus quality|security|performance|architecture] [--depth shallow|normal|deep] [--format text|json|report]"
disable-model-invocation: false
user-invocable: true
effort: medium
---

# do-analyze

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-analyze [target] [--focus quality|security|performance|architecture] [--depth shallow|normal|deep] [--format text|json|report]
```

## Metadata
- Category: `utility`
- Complexity: `basic`
- Effort: `medium`

## Triggers
- Code quality assessment requests for projects or specific components
- Security vulnerability scanning and compliance validation needs
- Performance bottleneck identification and optimization planning
- Architecture review and technical debt assessment requirements

## Behavioral Flow
1. **Discover**: Categorize source files using language detection and project analysis
2. **Scan**: Apply domain-specific analysis techniques and pattern matching
3. **Evaluate**: Generate prioritized findings with severity ratings and impact assessment
4. **Recommend**: Create actionable recommendations with implementation guidance
5. **Report**: Present comprehensive analysis with metrics and improvement roadmap

Key behaviors:
- Multi-domain analysis combining static analysis and heuristic evaluation
- Intelligent file discovery and language-specific pattern recognition
- Severity-based prioritization of findings and recommendations
- Comprehensive reporting with metrics, trends, and actionable insights

## Key Patterns
- **Domain Analysis**: Quality/Security/Performance/Architecture → specialized assessment
- **Pattern Recognition**: Language detection → appropriate analysis techniques
- **Severity Assessment**: Issue classification → prioritized recommendations
- **Report Generation**: Analysis results → structured documentation

## Boundaries
**Will:**
- Perform comprehensive static code analysis across multiple domains
- Generate severity-rated findings with actionable recommendations
- Provide detailed reports with metrics and improvement guidance

**Will Not:**
- Execute dynamic analysis requiring code compilation or runtime
- Modify source code or apply fixes without explicit user consent
- Analyze external dependencies beyond import and usage patterns

**Output**: Analysis report containing:
- Severity-rated findings
- Code quality metrics
- Security vulnerabilities
- Performance issues
- Recommendations

**Next Step**: After review, use `/do-improve` to apply recommended fixes or `/do-cleanup` for dead code removal.
