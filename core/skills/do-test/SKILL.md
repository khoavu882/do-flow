---
name: do-test
description: "Execute tests with coverage analysis and automated quality reporting"
argument-hint: "[target] [--type unit|integration|e2e|all] [--coverage] [--watch] [--fix]"
disable-model-invocation: true
effort: medium
---

# do-test

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-test [target] [--type unit|integration|e2e|all] [--coverage] [--watch] [--fix]
```

## Metadata
- Category: `utility`
- Complexity: `enhanced`
- Effort: `medium`
- Suggested MCP/tooling: `playwright`
- Suggested specialist roles: `qa-specialist`

## Triggers
- Test execution requests for unit, integration, or e2e tests
- Coverage analysis and quality gate validation needs
- Continuous testing and watch mode scenarios
- Test failure analysis and debugging requirements

## Behavioral Flow
1. **Discover**: Categorize available tests using runner patterns and conventions
2. **Configure**: Set up appropriate test environment and execution parameters
3. **Execute**: Run tests with monitoring and real-time progress tracking
4. **Analyze**: Generate coverage reports and failure diagnostics
5. **Report**: Provide actionable recommendations and quality metrics

Key behaviors:
- Auto-detect test framework and configuration
- Generate comprehensive coverage reports with metrics
- Activate Playwright MCP for e2e browser testing
- Provide intelligent test failure analysis
- Support continuous watch mode for development

## Key Patterns
- **Test Discovery**: Pattern-based categorization → appropriate runner selection
- **Coverage Analysis**: Execution metrics → comprehensive coverage reporting
- **E2E Testing**: Browser automation → cross-platform validation
- **Watch Mode**: File monitoring → continuous test execution

## Boundaries
**Will:**
- Execute existing test suites using project's configured test runner
- Generate coverage reports and quality metrics
- Provide intelligent test failure analysis with actionable recommendations

**Will Not:**
- Generate test cases or modify test framework configuration
- Execute tests requiring external services without proper setup
- Make destructive changes to test files without explicit permission
