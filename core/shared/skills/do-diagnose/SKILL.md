---
name: do-diagnose
description: "Unified diagnostic and code remediation engine — root cause analysis, performance profiling, security auditing, and targeted refactoring. Use when something is broken, slow, insecure, or needs cleanup and the user wants root-cause evidence before any fix, or says 'why is this crashing' / 'this endpoint feels slow' / 'audit this for security issues' rather than asking for a brand-new feature."
argument-hint: "[target|issue] [--type bug|perf|security|refactor] [--focus quality|security|performance|architecture] [--iterations n] [--validate] [--trace] [--fix]"
effort: medium
---

# do-diagnose

Unified diagnostic and code improvement engine. Replaces separate analyze/troubleshoot/reflect/improve tools with a single evidence-first diagnostic workflow.

## Invocation
```text
/do-diagnose [target|issue] [--type bug|perf|security|refactor] [--focus quality|security|performance|architecture] [--iterations n] [--validate] [--trace] [--fix]
```

## Behavioral Flow

1. **Classify Intent & Scope**:
   - `bug` (default if reproducing error): Reproduce issue, isolate cause via stack traces/diffs, formulate hypothesis. Consult `references/root_cause.md`.
   - `perf`: Profile execution, detect hot paths, identify algorithmic complexity ($O(n^2)$) or N+1 queries.
   - `security`: Static scan for secrets, unsanitized inputs, auth gaps, or vulnerability signatures. Consult `references/code_audit.md`.
   - `refactor`: Identify dead code, code smells, god functions, and structure cleanups. Consult `references/refactoring.md`.

2. **Evidence-First Diagnosis**:
   - Confirm root cause with concrete evidence before proposing any changes.
   - Propose ranked fix options with blast-radius ratings (Low / Medium / High).

3. **Remediation (`--fix`)**:
   - Only apply modifications when `--fix` is passed and after the user approves the remediation plan.
   - Verify fixes immediately by re-running tests.

4. **Iteration & Validation (`--iterations`, `--validate`)**:
   - `--iterations [n]`: repeat steps 1–2 for the given cycle count, re-diagnosing after each remediation pass.
   - `--validate`: run a pre-execution risk assessment and require explicit confirmation before remediating production or shared infrastructure.

## Boundaries
**Will:** Reproduce active issues, perform multi-domain static/runtime audits, and rank remediation strategies.
**Will Not:** Apply edits without `--fix` and explicit confirmation; bypass or disable tests to force passing status.
