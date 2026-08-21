# Code Review Report

**Generated:** 2026-08-18T16:43:42.400729
**Repository:** <repo>/.doflow/worktrees/bench-d3-do-code-review-1

## Executive Summary

**Verdict:** ❌ BLOCK
**Score:** 0/100
**Rationale:** Critical issues must be resolved before merge

### Issue Summary

| Severity | Count |
|----------|-------|
| Critical | 10 |
| High | 12 |
| Medium | 18 |
| Low | 1 |

### Change Statistics

- **Files Changed:** 484
- **Lines Added:** +58641
- **Lines Removed:** -2629
- **Complexity:** Critical

## Action Items

1. 🔴 **[P0]** Use parameterized queries to prevent SQL injection
   - Files: bench/runs/baseline/do-test/eval-1-test-request-invokes-test/outputs/test-output.txt
2. 🔴 **[P0]** Use parameterized queries to prevent SQL injection
   - Files: bench/runs/baseline/do-test/eval-2-reports-failures-honestly/outputs/npm-test.log
3. 🔴 **[P0]** Remove hardcoded credentials and use environment variables or a secrets manager
   - Files: bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/review-report.md
4. 🔴 **[P0]** Remove hardcoded credentials and use environment variables or a secrets manager
   - Files: bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/transcript.txt
5. 🔴 **[P0]** Use parameterized queries to prevent SQL injection
   - Files: bench/runs/boundary/do-code-review/eval-2-dispatches-to-language-checker/outputs/pr_analyzer.py.reviewed
6. 🔴 **[P0]** Use parameterized queries to prevent SQL injection
   - Files: bench/runs/boundary/do-code-review/eval-2-dispatches-to-language-checker/outputs/review-report.md
7. 🔴 **[P0]** Use parameterized queries to prevent SQL injection
   - Files: bench/runs/boundary/do-test/eval-1-test-request-invokes-test/outputs/npm-test-full-output.tap
8. 🔴 **[P0]** Use parameterized queries to prevent SQL injection
   - Files: bench/runs/boundary/do-test/eval-2-reports-failures-honestly/outputs/node-test-unit-full-output.tap
9. 🔴 **[P0]** Use parameterized queries to prevent SQL injection
   - Files: bench/runs/boundary/do/eval-2-estimation-is-ranged-not-false-precision/outputs/claims.json
10. 🔴 **[P0]** Remove hardcoded credentials and use environment variables or a secrets manager
   - Files: src/runtime/command-detect.js
11. 🟠 **[P1]** Remove debugger statements before merging
   - Files: bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/pr_analysis.json
12. 🟠 **[P1]** Remove debugger statements before merging
   - Files: bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/review-report.md
13. 🟠 **[P1]** Review and address: Blocking call on async operation — can deadlock in ASP.NET contexts
   - Files: bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/review-report.md
14. 🟠 **[P1]** Remove debugger statements before merging
   - Files: bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/review_report_raw.md
15. 🟠 **[P1]** Remove debugger statements before merging
   - Files: bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/transcript.txt

## Critical Issues (Must Fix)

- **sql_concatenation** in `bench/runs/baseline/do-test/eval-1-test-request-invokes-test/outputs/test-output.txt`
  - Potential SQL injection (string concatenation or interpolation in query)
- **sql_concatenation** in `bench/runs/baseline/do-test/eval-2-reports-failures-honestly/outputs/npm-test.log`
  - Potential SQL injection (string concatenation or interpolation in query)
- **hardcoded_secrets** in `bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/review-report.md`
  - Potential hardcoded secret or connection string detected
- **hardcoded_secrets** in `bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/transcript.txt`
  - Potential hardcoded secret or connection string detected
- **sql_concatenation** in `bench/runs/boundary/do-code-review/eval-2-dispatches-to-language-checker/outputs/pr_analyzer.py.reviewed`
  - Potential SQL injection (string concatenation or interpolation in query)
- **sql_concatenation** in `bench/runs/boundary/do-code-review/eval-2-dispatches-to-language-checker/outputs/review-report.md`
  - Potential SQL injection (string concatenation or interpolation in query)
- **sql_concatenation** in `bench/runs/boundary/do-test/eval-1-test-request-invokes-test/outputs/npm-test-full-output.tap`
  - Potential SQL injection (string concatenation or interpolation in query)
- **sql_concatenation** in `bench/runs/boundary/do-test/eval-2-reports-failures-honestly/outputs/node-test-unit-full-output.tap`
  - Potential SQL injection (string concatenation or interpolation in query)
- **sql_concatenation** in `bench/runs/boundary/do/eval-2-estimation-is-ranged-not-false-precision/outputs/claims.json`
  - Potential SQL injection (string concatenation or interpolation in query)
- **hardcoded_secrets** in `src/runtime/command-detect.js`
  - Potential hardcoded secret or connection string detected

## High Priority Issues

- **debugger** in `bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/pr_analysis.json`
  - Debugger statement found
- **debugger** in `bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/review-report.md`
  - Debugger statement found
- **csharp_blocking_async** in `bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/review-report.md`
  - Blocking call on async operation — can deadlock in ASP.NET contexts
- **debugger** in `bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/outputs/review_report_raw.md`
  - Debugger statement found
- **debugger** in `bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/transcript.txt`
  - Debugger statement found
- **csharp_blocking_async** in `bench/runs/boundary/do-code-review/eval-1-review-request-invokes-review/transcript.txt`
  - Blocking call on async operation — can deadlock in ASP.NET contexts
- **debugger** in `bench/runs/boundary/do-code-review/eval-2-dispatches-to-language-checker/outputs/pr_analyzer.py.reviewed`
  - Debugger statement found
- **csharp_blocking_async** in `src/adapters/copilot/index.js`
  - Blocking call on async operation — can deadlock in ASP.NET contexts
- **csharp_blocking_async** in `src/adapters/kiro/index.js`
  - Blocking call on async operation — can deadlock in ASP.NET contexts
- **csharp_blocking_async** in `src/adapters/opencode/index.js`
  - Blocking call on async operation — can deadlock in ASP.NET contexts

## Suggested Review Order

1. `bench/runs/boundary/do-document/eval-2-research-mode-separates-source-from-inference/outputs/idempotency-keys-payment-apis_20260818T072117Z.md`
2. `bench/config.json`
3. `bench/runs/boundary/do-document/eval-1-doc-request-invokes-document/outputs/copy-tree-api-reference.md`
4. `core/shared/guidance/references/MODEL_SELECTION.md`
5. `core/shared/guidance/references/RESEARCH_CONFIG.md`
6. `bench/baseline/baseline.json`
7. `bench/do-brainstorm/evals.json`
8. `bench/do-code-review/evals.json`
9. `bench/do-constitution/evals.json`
10. `bench/do-design/evals.json`

---
*Generated by Code Reviewer*