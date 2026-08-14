# Benchmark Task 001: Debug Kafka Consumer Duplicate Processing

**ID:** debug-001  
**Category:** Debugging  
**Difficulty:** Medium (3/5)  
**Risk:** High  

## Objective
Kafka consumers occasionally process duplicate payment transactions following partition rebalances.

## Expected Verification Contract
1. `npm test test/runtime-claims.test.js` -> PASS
2. Idempotency assertion verified.
