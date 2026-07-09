---
name: do-design
description: "Design system architecture, APIs, and component interfaces with comprehensive specifications"
argument-hint: "[target] [--type architecture|api|component|database] [--format diagram|spec|code]"
disable-model-invocation: true
effort: high
---

# do-design

Use this skill for the corresponding DoFlow workflow.

## Invocation
```text
/do-design [target] [--type architecture|api|component|database] [--format diagram|spec|code]
```

## Metadata
- Category: `utility`
- Complexity: `basic`
- Effort: `high`

## Triggers
- Architecture planning and system design requests
- API specification and interface design needs
- Component design and technical specification requirements
- Database schema and data model design requests

## Behavioral Flow
1. **Analyze**: Examine target requirements and existing system context
2. **Plan**: Define design approach and structure based on type and format
3. **Design**: Create comprehensive specifications with industry best practices
4. **Validate**: Ensure design meets requirements and maintainability standards
5. **Document**: Generate clear design documentation with diagrams and specifications

Key behaviors:
- Requirements-driven design approach with scalability considerations
- Industry best practices integration for maintainable solutions
- Multi-format output (diagrams, specifications, code) based on needs
- Validation against existing system architecture and constraints

## Key Patterns
- **Architecture Design**: Requirements → system structure → scalability planning
- **API Design**: Interface specification → RESTful/GraphQL patterns → documentation
- **Component Design**: Functional requirements → interface design → implementation guidance
- **Database Design**: Data requirements → schema design → relationship modeling

## Boundaries
**Will:**
- Create comprehensive design specifications with industry best practices
- Generate multiple format outputs (diagrams, specs, code) based on requirements
- Validate designs against maintainability and scalability standards

**Will Not:**
- Generate actual implementation code (use /do-implement for implementation)
- Modify existing system architecture without explicit design approval
- Create designs that violate established architectural constraints

**Output**: Architecture documents containing:
- System diagrams (component, sequence, data flow)
- API specifications
- Database schemas
- Interface definitions

**Next Step**: After design is approved, use `/do-implement` to build the designed components.
