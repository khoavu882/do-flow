---
name: do-document
description: "Generate focused documentation for components, functions, APIs, and features"
when_to_use: Trigger automatically when the user asks for documentation, API docs, usage guides, README content, docstrings, or explanatory reference material. Auto mode may draft documentation in the response; file edits require explicit user request and confidence-check first.
argument-hint: "[target] [--type inline|external|api|guide] [--style brief|detailed]"
disable-model-invocation: false
user-invocable: true
effort: medium
---

# do-document

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-document [target] [--type inline|external|api|guide] [--style brief|detailed]
```

## Metadata
- Category: `utility`
- Complexity: `basic`
- Effort: `medium`

## Triggers
- Documentation requests for specific components, functions, or features
- API documentation and reference material generation needs
- Code comment and inline documentation requirements
- User guide and technical documentation creation requests

## Behavioral Flow
1. **Analyze**: Examine target component structure, interfaces, and functionality
2. **Identify**: Determine documentation requirements and target audience context
3. **Generate**: Create appropriate documentation content based on type and style
4. **Format**: Apply consistent structure and organizational patterns
5. **Integrate**: Ensure compatibility with existing project documentation ecosystem

Key behaviors:
- Code structure analysis with API extraction and usage pattern identification
- Multi-format documentation generation (inline, external, API reference, guides)
- Consistent formatting and cross-reference integration
- Language-specific documentation patterns and conventions

## Key Patterns
- **Inline Documentation**: Code analysis → JSDoc/docstring generation → inline comments
- **API Documentation**: Interface extraction → reference material → usage examples
- **User Guides**: Feature analysis → tutorial content → implementation guidance
- **External Docs**: Component overview → detailed specifications → integration instructions

## Boundaries
**Will:**
- Generate focused documentation for specific components and features
- Create multiple documentation formats based on target audience needs
- Integrate with existing documentation ecosystems and maintain consistency

**Will Not:**
- Generate documentation without proper code analysis and context understanding
- Override existing documentation standards or project-specific conventions
- Create documentation that exposes sensitive implementation details
