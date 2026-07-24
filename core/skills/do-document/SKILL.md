---
name: do-document
description: "Generate focused documentation for components, functions, APIs, and features"
when_to_use: Trigger automatically when the user asks for documentation, API docs, usage guides, README content, docstrings, or explanatory reference material. Auto mode may draft documentation in the response; file edits require explicit user request and confidence-check first.
argument-hint: "[target] [--type inline|external|api|guide|feature] [--style brief|detailed]"
user-invocable: true
effort: medium
---

# /do-document - Focused Documentation Generation

## Triggers
- Documentation requests for specific components, functions, or features
- API documentation and reference material generation needs
- Code comment and inline documentation requirements
- User guide and technical documentation creation requests
- Feature flow documentation requests (C4 diagrams, sequence diagrams, data model, API spec)

## Usage
```
/do-document [target] [--type inline|external|api|guide|feature] [--style brief|detailed]
```

## Behavioral Flow
1. **Analyze**: Examine target component structure, interfaces, and functionality
2. **Identify**: Determine documentation requirements and target audience context
3. **Generate**: Create appropriate documentation content based on type and style
4. **Format**: Apply consistent structure and organizational patterns
5. **Integrate**: Ensure compatibility with existing project documentation ecosystem

Key behaviors:
- Code structure analysis with API extraction and usage pattern identification
- Multi-format documentation generation (inline, external, API reference, guides, feature flows)
- Consistent formatting and cross-reference integration
- Language-specific documentation patterns and conventions

## Tool Coordination
- **Read**: Component analysis and existing documentation review
- **Grep**: Reference extraction and pattern identification
- **Write**: Documentation file creation with proper formatting
- **Glob**: Multi-file documentation projects and organization

Distinct from `/do-index` (whole-project documentation) and `/do-explain` (no-artifact
conversational explanation) — this produces a documentation file scoped to one target.

## Examples

### Inline Code Documentation
```
/do-document src/auth/login.js --type inline
# Generates JSDoc comments with parameter and return descriptions
# Adds comprehensive inline documentation for functions and classes
```

### API Reference Generation
```
/do-document src/api --type api --style detailed
# Creates comprehensive API documentation with endpoints and schemas
# Generates usage examples and integration guidelines
```

### User Guide Creation
```
/do-document payment-module --type guide --style brief
# Creates user-focused documentation with practical examples
# Focuses on implementation patterns and common use cases
```

### Component Documentation
```
/do-document components/ --type external
# Generates external documentation files for component library
# Includes props, usage examples, and integration patterns
```

### Feature Flow Documentation
```
/do-document savings-deposit-flow --type feature
# Generates a full flow document from references/feature-flow.md:
# metadata table, overview, references, C1/C2/C3 Mermaid diagrams,
# per-sub-flow sequence diagrams, data model + ER diagram, API spec
# with request/response samples and status mapping
# Optional sections (C3, business logic, security/perf, rollout,
# known limitations) are populated when applicable, otherwise removed
```

## Reference Resources
- **API Template**: Use `references/api-reference.md` for standardized endpoint documentation.
- **Guide Template**: Use `references/user-guide.md` for consistent user-facing tutorials.
- **Feature Flow Template**: Use `references/feature-flow.md` for structured feature/flow documentation (metadata, C4 diagrams, sequence diagrams, data model, API spec, rollout notes). Fill every `[Required]` section; drop `[Optional]` sections that don't apply to the target feature.

## Boundaries

**Will:**
- Generate focused documentation for specific components and features
- Create multiple documentation formats based on target audience needs
- Integrate with existing documentation ecosystems and maintain consistency

**Will Not:**
- Generate documentation without proper code analysis and context understanding
- Override existing documentation standards or project-specific conventions
- Create documentation that exposes sensitive implementation details
