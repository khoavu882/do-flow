# Code Review Checklist

Use this checklist for `/do-review` and the `code-reviewer` agent. Apply the common checklist first, then add language-specific and domain overlays.

## Common Checklist

### Correctness
- Implementation matches the intended behavior and acceptance criteria
- Edge cases, empty states, failure paths, and boundary values are handled
- State transitions are valid and cannot enter impossible states
- Backward compatibility is preserved unless explicitly changed

### Requirements Alignment
- Design, PBI, BRD, Q&A, or acceptance criteria are reflected in the implementation
- Business rules are implemented in the correct layer
- Missing requirements context is called out instead of assumed

### Conventions and Maintainability
- Naming is clear, consistent, English-only, and follows language norms
- Existing repository patterns are reused before introducing new abstractions
- Duplication is justified or factored into local helpers
- Comments explain non-obvious intent and are not stale
- Dead code, unused imports, unused variables, and deprecated APIs are removed

### Error Handling
- Errors are handled at appropriate boundaries
- Exceptions and promise rejections are not swallowed
- Log messages are useful and avoid sensitive data
- Retry, fallback, and timeout behavior is explicit where relevant

### Security
- External input is validated and encoded
- Auth, authorization, tenancy, and ownership checks are preserved
- Secrets, tokens, credentials, and PII are not logged or exposed
- SQL/command/template injection risks are mitigated
- Dependencies and APIs are used safely

### Performance
- Avoid unnecessary work in loops, hot paths, and render paths
- Avoid N+1 queries and unbounded reads
- Use efficient string, collection, and allocation patterns
- Database queries are indexed and constrained where needed

### Tests
- Tests cover positive, negative, boundary, and regression cases
- Assertions verify behavior, not only execution
- Changed business logic has meaningful test coverage
- Existing tests are not disabled or weakened to pass

## Java Checklist
- Apply `java-conventions` and `core/reference/JAVA_CODING_RULE.md`
- Run or recommend `spotlessCheck` when the project includes Spotless
- Use `.equals()` instead of `==` for string comparison
- Use constant-first `.equals()` where it improves null safety
- Validate null before conversions and data access
- Catch exceptions only when the handler can add value or recover safely
- Avoid deprecated APIs, wildcard imports, unused members, and warning-prone code
- Check loop bounds, termination, and repeated initialization inside loops
- Avoid unnecessary boxing/unboxing and primitive/wrapper misuse
- Check division by zero, overflow, BigDecimal precision, and operator precedence
- Prefer constants for repeated literals and business codes

## Java Financial and Database Overlay
- Verify database field length and type, including Unicode/emoji storage needs
- Add appropriate indexes for new or changed queries
- Add new fields at the end of tables when jOOQ compatibility requires it
- Validate non-null parameters before using them in `WHERE` conditions
- Avoid `SELECT *` unless explicitly justified
- Check transaction boundaries, idempotency, and duplicate partner requests
- Preserve auditability for financial operations
- Avoid floating-point types for money or precision-sensitive values
- Verify implementation against Design/PBI/BRD/Q&A before approval

## Python Checklist
- Type hints are useful and consistent with runtime behavior
- `None` handling is explicit at boundaries
- Exceptions are specific and not swallowed broadly
- Async functions are awaited correctly; blocking calls do not run in async hot paths
- Inputs are validated before persistence, network calls, or command execution
- Resource handling uses context managers where appropriate
- Dependencies are necessary and follow project tooling
- Tests cover edge cases, failure paths, and security-sensitive behavior

## JavaScript and TypeScript Checklist
- TypeScript types model real data and avoid unnecessary `any`
- `unknown` is narrowed safely before use
- Null and undefined states are handled explicitly
- Promises and async functions handle rejection paths
- API inputs and outputs are validated at boundaries
- React/component changes avoid stale state, unnecessary renders, and key misuse
- Browser code avoids XSS, unsafe `eval`, token leakage, and unsafe storage patterns
- Tests cover user-visible behavior and failure paths

## Approval Guide
- **APPROVED**: No high or medium findings; requirements and tests are adequate
- **APPROVED WITH MINOR CHANGES**: Only low-priority findings remain
- **CHANGES REQUESTED**: High or medium findings exist
- **BLOCKED - INSUFFICIENT CONTEXT**: Review cannot verify business logic or risk without missing requirements/design context
