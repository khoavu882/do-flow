# Contributing to DoFlow

Run the test command below before sending a change, and the suites outside it when the change touches what they cover.

## Repository facts

Each row states one fact and names the file that owns it. Guard G46 in `test/guards/guidance-truth.test.ts` compares every row with its owner, so a row that drifts fails the suite; fix the row to match the owner, not the other way round.

| Fact | Value | Owner |
|---|---|---|
| Node floor | >=24.22.1 | `package.json` `engines.node` |
| Test command | `node --test "test/**/*.test.js" "test/**/*.test.ts"` | `package.json` `scripts.test` |
| Typecheck command | `npx -y -p typescript@5.7.2 tsc -p tsconfig.json` | `package.json` `scripts.typecheck` |
| Harnesses | 7: claude, codex, opencode, pi, copilot, kiro, antigravity | `core/registry/harnesses.json` |
| Implement gate | advises, never denies | `core/harnesses/shared/hooks/policies/pre-implementation-gate.sh` |
| Suites outside npm test | `test/code-review-fixtures.sh`, `test/verify-hooks.sh`, `npm run bench` | `package.json` `scripts.test` scope |

`npm run typecheck` runs the typecheck command, and `npm test` runs the test command.
