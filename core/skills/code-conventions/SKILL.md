---
name: code-conventions
description: Language-aware coding convention router for Java, Python, JavaScript, and TypeScript. Auto-activates for code review, implementation, and convention-check requests.
when_to_use: Trigger automatically for code review, implementation, refactoring, convention checks, or when changed files include Java, Python, JavaScript, or TypeScript. Use as background guidance only.
user-invocable: false
disable-model-invocation: false
effort: low
---

# Code Conventions

Use this hidden skill when reviewing, implementing, or validating code conventions across supported languages.

## Triggers
- Code review, merge request review, or pre-merge validation
- "review my changes", "check coding standard", or "convention check" requests
- Changed files include `.java`, `.py`, `.js`, `.jsx`, `.ts`, or `.tsx`
- `/do-review` detects language-specific convention requirements

## Language Routing
Apply common conventions first, then route language-specific rules:

| Language | File Patterns | Convention Source |
|----------|---------------|-------------------|
| Java | `*.java` | `java-conventions`, `core/reference/JAVA_CODING_RULE.md` |
| Python | `*.py` | `core/reference/CODE_REVIEW_CHECKLIST.md` Python section |
| JavaScript | `*.js`, `*.jsx` | `core/reference/CODE_REVIEW_CHECKLIST.md` JS/TS section |
| TypeScript | `*.ts`, `*.tsx` | `core/reference/CODE_REVIEW_CHECKLIST.md` JS/TS section |

For mixed-language changes, group findings by language and call out cross-boundary issues separately.

## Common Conventions
- Use clear, consistent, English naming
- Follow the existing repository style before introducing new patterns
- Keep functions, classes, and modules focused on one responsibility
- Avoid magic literals except common sentinel values when locally accepted
- Prefer explicit validation at external boundaries
- Handle errors deliberately; avoid swallowing exceptions or promise rejections
- Remove unused imports, variables, private members, and dead branches
- Keep comments accurate and focused on non-obvious intent
- Avoid duplicated logic when a local helper or established abstraction exists
- Preserve backward compatibility unless the change intentionally breaks it

## Review Boundaries
**Will:**
- Select convention guidance by language and context
- Support `/do-review` and code-reviewer agent workflows
- Preserve `java-conventions` as the Java financial-services specialization

**Will Not:**
- Replace language-specific convention skills
- Make code changes by itself
- Approve code without considering correctness, security, and tests
