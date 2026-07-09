---
name: do-implement
description: "Feature and code implementation with intelligent persona activation and MCP integration"
argument-hint: "[feature-description] [--type component|api|service|feature] [--framework react|vue|express] [--safe] [--with-tests]"
disable-model-invocation: true
effort: high
---

# do-implement

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-implement [feature-description] [--type component|api|service|feature] [--framework react|vue|express] [--safe] [--with-tests]
```

## Metadata
- Category: `workflow`
- Complexity: `standard`
- Effort: `high`
- Suggested MCP/tooling: `context7`, `sequential`, `playwright`
- Suggested specialist roles: `architect`, `frontend`, `backend`, `security`, `qa-specialist`

## Summary
> **Context Framework Note**: This behavioral instruction activates when Claude Code users type `/do-implement` patterns. It guides Claude to coordinate specialist personas and MCP tools for comprehensive implementation.

## Triggers
- Feature development requests for components, APIs, or complete functionality
- Code implementation needs with framework-specific requirements
- Multi-domain development requiring coordinated expertise
- Implementation projects requiring testing and validation integration

## Behavioral Flow
1. **Analyze**: Examine implementation requirements and detect technology context
2. **Plan**: Choose approach and activate relevant personas for domain expertise
3. **Generate**: Create implementation code with framework-specific best practices
4. **Validate**: Apply security and quality validation throughout development
5. **Integrate**: Update documentation and provide testing recommendations

Key behaviors:
- Context-based persona activation (architect, frontend, backend, security, qa)
- Framework-specific implementation via Context7 MCP integration
- Systematic multi-component coordination via Sequential MCP
- Comprehensive testing integration with Playwright for validation

## Key Patterns
- **Context Detection**: Framework/tech stack → appropriate persona and MCP activation
- **Implementation Flow**: Requirements → code generation → validation → integration
- **Multi-Persona Coordination**: Frontend + Backend + Security → comprehensive solutions
- **Quality Integration**: Implementation → testing → documentation → validation

## Boundaries
**Will:**
- Implement features with intelligent persona activation and MCP coordination
- Apply framework-specific best practices and security validation
- Provide comprehensive implementation with testing and documentation integration

**Will Not:**
- Make architectural decisions without appropriate persona consultation
- Implement features conflicting with security policies or architectural constraints
- Override user-specified safety constraints or bypass quality gates

## COMPLETION CRITERIA
**Implementation is DONE when**:
- Feature code is written and compiles
- Basic functionality verified
- Files saved and ready for testing

**Post-Implementation Checklist**:
1. Code compiles without errors
2. Basic functionality works
3. Ready for `/do-test`

**Next Step**: After implementation, use `/do-test` to run tests, then `/do-git` to commit.
