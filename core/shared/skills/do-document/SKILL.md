---
name: do-document
description: "Generate focused documentation for components, functions, APIs, and features"
when_to_use: Trigger automatically when the user asks for documentation, API docs, usage guides, README content, docstrings, or explanatory reference material. Auto mode may draft documentation in the response; file edits require explicit user request and confidence-check first.
argument-hint: "[target] [--type inline|external|api|guide|impl] [--style brief|detailed]"
effort: medium
---

# /do-document - Focused Documentation Generation

## Triggers
- Documentation requests for specific components, functions, or features
- API documentation and reference material generation needs
- Code comment and inline documentation requirements
- User guide and technical documentation creation requests
- Implementation-flow documentation requests for a completed feature (summary, key decisions,
  deviations, changed surfaces)

## Usage
```
/do-document [target] [--type inline|external|api|guide|impl] [--style brief|detailed]
```
`[target]` has no effect for `--type impl` — target resolution is always the resolver's active
feature (see Behavioral Flow step 1).

## Behavioral Flow
1. **Resolve (`--type impl` only)** — run the resolver, parse JSON, mirroring the same call
   `/do-plan`/`/do-design`/`/do-brainstorm` already use:
   ```bash
   RESOLVER="${DOFLOW_CONFIG_DIR:+$DOFLOW_CONFIG_DIR/scripts/doflow/bash/do-paths.sh}"
   if [ -z "$RESOLVER" ] || [ ! -f "$RESOLVER" ]; then
     d="$PWD"
     while [ "$d" != / ]; do
       [ -f "$d/.doflow/scripts/doflow/bash/do-paths.sh" ] && RESOLVER="$d/.doflow/scripts/doflow/bash/do-paths.sh" && break
       d="$(dirname "$d")"
     done
   fi
   DOFLOW_CONFIG_DIR="$(dirname "$(dirname "$(dirname "$(dirname "$RESOLVER")")")")"
   bash "$RESOLVER" --json
   ```
   The `[target]` argument has no effect for `impl` — target resolution is always the resolver's
   active feature. **Precondition (hard gate):** the resolver's `feature_slug` must be non-null. If
   it is `null`, hard-error and write nothing — do not proceed to any step below: "`--type impl`
   requires an active feature — none resolved; check out a `feat/<slug>` branch first." Unlike
   `/do-plan`'s advisory precondition on `has_requirement`/`has_design`, this gate is not skippable.
2. **Analyze**: Examine target component structure, interfaces, and functionality
3. **Identify**: Determine documentation requirements and target audience context
4. **Generate**: Create appropriate documentation content based on type and style
5. **Format**: Apply consistent structure and organizational patterns
6. **Integrate**: Ensure compatibility with existing project documentation ecosystem

Key behaviors:
- Code structure analysis with API extraction and usage pattern identification
- Multi-format documentation generation (inline, external, API reference, guides, implementation flows)
- Consistent formatting and cross-reference integration
- Language-specific documentation patterns and conventions
- `--type impl` writes exactly one file, `agent-docs/doflow/<slug>/implementation-flow.md`, and
  reports its path on success

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

### Implementation Flow Documentation
```
/do-document --type impl
# Resolves the active feature via do-paths.sh; the [target] argument has no effect for impl
# Hard-errors and writes nothing if no active feature is resolved (feature_slug is null):
# "--type impl requires an active feature — none resolved; check out a feat/<slug> branch first."
# On success, writes exactly one file:
# agent-docs/doflow/<slug>/implementation-flow.md
# header (feature/branch/status/created + links to requirement.md/design.md/plan.md), summary,
# key decisions, deviations from plan/design, changed surfaces table,
# testing & verification, follow-ups/known gaps
```

## Boundaries

**Will:**
- Generate focused documentation for specific components and features
- Create multiple documentation formats based on target audience needs, including
  implementation-flow docs for the active feature via `--type impl`
- Integrate with existing documentation ecosystems and maintain consistency

**Will Not:**
- Generate documentation without proper code analysis and context understanding
- Override existing documentation standards or project-specific conventions
- Create documentation that exposes sensitive implementation details
- Accept `--type feature` — removed with no alias or silent fallback; hard-errors naming `feature`
  as unsupported and pointing to `impl` as its replacement
