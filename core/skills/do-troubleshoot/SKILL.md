---
name: do-troubleshoot
description: "Diagnose and resolve issues in code, builds, deployments, and system behavior"
when_to_use: Trigger automatically for diagnosis of errors, failing tests, build failures, runtime issues, deployment problems, and performance symptoms. Auto mode is diagnosis-first and must not apply fixes unless the user explicitly requests edits and confidence-check passes.
argument-hint: "[issue] [--type bug|build|performance|deployment] [--trace] [--fix]"
disable-model-invocation: false
user-invocable: true
effort: medium
---

# do-troubleshoot

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-troubleshoot [issue] [--type bug|build|performance|deployment] [--trace] [--fix]
```

## Metadata
- Category: `utility`
- Complexity: `basic`
- Effort: `medium`

## Triggers
- Code defects and runtime error investigation requests
- Build failure analysis and resolution needs
- Performance issue diagnosis and optimization requirements
- Deployment problem analysis and system behavior debugging

## Behavioral Flow
1. **Analyze**: Examine issue description and gather relevant system state information
2. **Investigate**: Identify potential root causes through systematic pattern analysis
3. **Debug**: Execute structured debugging procedures including log and state examination
4. **Propose**: Validate solution approaches with impact assessment and risk evaluation
5. **Resolve**: Apply appropriate fixes and verify resolution effectiveness

Key behaviors:
- Systematic root cause analysis with hypothesis testing and evidence collection
- Multi-domain troubleshooting (code, build, performance, deployment)
- Structured debugging methodologies with comprehensive problem analysis
- Safe fix application with verification and documentation

## Key Patterns
- **Bug Investigation**: Error analysis → stack trace examination → code inspection → fix validation
- **Build Troubleshooting**: Build log analysis → dependency checking → configuration validation
- **Performance Diagnosis**: Metrics analysis → bottleneck identification → optimization recommendations
- **Deployment Issues**: Environment analysis → configuration verification → service validation

## Boundaries
**Will:**
- Execute systematic issue diagnosis using structured debugging methodologies
- Provide validated solution approaches with comprehensive problem analysis
- Apply safe fixes with verification and detailed resolution documentation

**Will Not:**
- Apply risky fixes without proper analysis and user confirmation
- Modify production systems without explicit permission and safety validation
- Make architectural changes without understanding full system impact

## CRITICAL BOUNDARIES
**DIAGNOSE FIRST - FIXES REQUIRE `--fix` FLAG**

This command is DIAGNOSIS-FIRST by default.

**Default behavior (no `--fix` flag)**:
- Diagnose the issue
- Identify root cause
- Propose solution options
- **STOP and present findings to user** - do not apply any fixes

**With `--fix` flag**:
- After diagnosis, prompt user for confirmation before applying
- Apply fix only after user explicitly approves
- Verify fix with tests

**Explicitly Will NOT** (without `--fix` flag):
- Apply any code changes
- Modify any files
- Execute fixes automatically

**Output**: Diagnostic report containing:
- Issue description
- Root cause analysis
- Proposed solutions (ranked)
- Risk assessment for each solution

**Next Step**: User reviews diagnosis, then either:
- Re-run with `--fix` flag to apply recommended fix
- Use `/do-improve` for broader refactoring
