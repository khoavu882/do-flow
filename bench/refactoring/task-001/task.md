# Benchmark Task 002: Refactor Context Pack Token Budgeting

**ID:** refactor-001  
**Category:** Refactoring  
**Difficulty:** Medium (2/5)  
**Risk:** Medium  

## Objective
Refactor context pack compiler to prune low-reliability evidence when context token budget is constrained.

## Expected Verification Contract
1. `npm test test/runtime-readiness.test.js` -> PASS
2. Token budget compliance verified.
