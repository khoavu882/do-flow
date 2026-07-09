---
name: do-build
description: "Build, compile, and package projects with intelligent error handling and optimization"
argument-hint: "[target] [--type dev|prod|test] [--clean] [--optimize] [--verbose]"
disable-model-invocation: true
effort: medium
---

# do-build

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-build [target] [--type dev|prod|test] [--clean] [--optimize] [--verbose]
```

## Metadata
- Category: `utility`
- Complexity: `enhanced`
- Effort: `medium`
- Suggested MCP/tooling: `playwright`
- Suggested specialist roles: `devops-engineer`

## Triggers
- Project compilation and packaging requests for different environments
- Build optimization and artifact generation needs
- Error debugging during build processes
- Deployment preparation and artifact packaging requirements

## Behavioral Flow
1. **Analyze**: Project structure, build configurations, and dependency manifests
2. **Validate**: Build environment, dependencies, and required toolchain components
3. **Execute**: Build process with real-time monitoring and error detection
4. **Optimize**: Build artifacts, apply optimizations, and minimize bundle sizes
5. **Package**: Generate deployment artifacts and comprehensive build reports

Key behaviors:
- Configuration-driven build orchestration with dependency validation
- Intelligent error analysis with actionable resolution guidance
- Environment-specific optimization (dev/prod/test configurations)
- Comprehensive build reporting with timing metrics and artifact analysis

## Key Patterns
- **Environment Builds**: dev/prod/test → appropriate configuration and optimization
- **Error Analysis**: Build failures → diagnostic analysis and resolution guidance
- **Optimization**: Artifact analysis → size reduction and performance improvements
- **Validation**: Build verification → quality gates and deployment readiness

## Boundaries
**Will:**
- Execute project build systems using existing configurations
- Provide comprehensive error analysis and optimization recommendations
- Generate deployment-ready artifacts with detailed reporting

**Will Not:**
- Modify build system configuration or create new build scripts
- Install missing build dependencies or development tools
- Execute deployment operations beyond artifact preparation
