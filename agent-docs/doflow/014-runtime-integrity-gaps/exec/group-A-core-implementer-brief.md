# Group brief: A:core-implementer

> Composed from plan.md, requirement.md and design.md. This brief covers multiple tasks that share an owner.

## Shared context

### Where this fits

Build the two shared primitives first (`locator-resolve.js`, `leak-scan.js`) with their tests, then
wire their consumers, because every other task calls one of them and a consumer written against an
unbuilt module cannot be tested. The analyser bundle and the shipped content files are independent of
that chain by file set and proceed on their own track. Inventory updates land last, in one pass, so
the guards are run against a finished surface rather than a moving one.
The single biggest correctness risk is not in any new module: it is the early return for terminal
states in `claims.js`. Without it every other retraction change is inert, so it is a named task with
its own regression test rather than a line folded into a larger edit.

### Global constraints — these bind every task

- **NFR-001 (No new external dependencies):** Nothing in this feature may require a tool that is not
  already required to run DoFlow. Analyser coverage for YAML, shell, and JSON is delivered with what
  ships today. External linters would give richer findings, but they turn a capability that works
  everywhere into one that works where someone happened to install a tool — and the failure mode is
  a silent coverage hole, which is the defect this feature exists to close.
- **NFR-002 (Fail-open and fast):** The always-on check inherits the existing hook contract: any
  uncertainty resolves to allowing the operation, and it must not add perceptible latency to a
  write. A check that stalls or blocks on ambiguity would be removed by its users, at which point it
  protects nothing.
- **NFR-003 (Nothing is removed):** No operation added here may delete a claim or evidence record.
  The audit trail's value is that it is append-only; a retraction that removed the record would make
  the trail unable to answer why a decision changed, which is the question it is kept for.
- **NFR-004 (Existing state remains readable):** State written before this feature must load and
  evaluate without migration. A claim recorded without a terminal state reads as non-terminal;
  evidence recorded before locator validation is not retroactively refused.
- **NFR-005 (Guards stay green):** The repository's structural guards must pass unchanged. Where
  this feature adds a command, a flag, a script, or a documented path, the corresponding inventory
  must be updated in the same change rather than the guard being weakened.
- **NFR-006 (No chain artifacts required):** Every capability here must work in a repository with no
  feature directory and no chain artifacts. Claim and evidence operations, review, and verification
  are used outside the chain as well as inside it.

## Task order

A.1 → A.2   (write each task's report before starting the next)

## Task A.1

A.1 [P] [US2] Build the locator resolvability module and its tests — owner: core-implementer; files: src/runtime/locator-resolve.js, test/runtime/runtime-locator-resolve.test.js

### Why (user story)

**US2 (P1):** As an engineer relying on the readiness gate, I want evidence whose locator does not
  resolve to be refused, so that a gate reporting `READY` is not resting on a locator that points
  nowhere.

### Story 3: Trusting a review verdict (P1)

### Requirements — build exactly these

- **FR-004:** When evidence is recorded with a provenance asserting it was read from the repository,
  the runtime MUST confirm the locator resolves against the named file's actual content before
  accepting the item — a line number beyond the file's length, or a named symbol absent from it,
  MUST be refused. Refusal MUST name the file, what was asked for, and what the file actually
  offers, so the writer can correct it rather than guess. Consistent with existing batch semantics,
  one refused item MUST write nothing.
- **FR-005:** The readiness gate MUST NOT return a ready verdict while any evidence item it counts
  as support has a locator that does not resolve. Where an item was accepted earlier and the file
  has since changed, the gate MUST report the item as unresolvable and name it, rather than either
  ignoring it or silently downgrading the whole verdict without saying which item caused it.

### Files you own

src/runtime/locator-resolve.js, test/runtime/runtime-locator-resolve.test.js

### Verification bar

| FR-004 | `runtime-evidence-write.test.js` — line beyond EOF, missing file, and absent symbol each refuse the whole batch |
| FR-005 | `runtime-readiness.test.js` — a gate with an unresolvable supporting item is not READY and names the item |
- After Phase A: `node --test test/runtime/runtime-locator-resolve.test.js test/runtime/runtime-leak-scan.test.js`; commit `feat(runtime): add locator resolvability and leak-scan primitives`

## Task A.2

A.2 [P] [US4] Build the internal-identifier scan module, its command handler, and its tests — owner: core-implementer; files: src/runtime/leak-scan.js, test/runtime/runtime-leak-scan.test.js

### Why (user story)

**US4 (P2):** As a maintainer, I want DoFlow's own identifiers flagged when they reach files
  outside `agent-docs/`, so that requirement and design references do not leak into artifacts
  delivered to people who never used DoFlow.

### Story 5: Verifying a repository with no build manifest (P2)

### Requirements — build exactly these

- **FR-009:** A review MUST report occurrences of DoFlow-internal identifiers — requirement and
  design item references, artifact-directory paths, and equivalent process vocabulary — appearing in
  files outside the artifact directory, with file and line for each. Occurrences inside the artifact
  directory are correct usage and MUST NOT be reported.
- **FR-010:** An always-on check MUST warn when a write introduces a DoFlow-internal identifier into
  a file outside the artifact directory, independent of which skill (if any) is running, so that a
  session that never invokes a review still surfaces the leak. The check MUST NOT block the write:
  a legitimate occurrence exists (documentation about DoFlow itself), and a false positive that
  halts work costs more than the leak it prevents.

### Files you own

src/runtime/leak-scan.js, test/runtime/runtime-leak-scan.test.js

### Verification bar

| FR-009 | `runtime-leak-scan.test.js` — identifiers outside the artifact dir are found with file and line; identical text inside it is not |
| FR-010 | `runtime-leak-scan.test.js` for the rule; manual run of `stop-check.sh` against a seeded edited-files list for the caller |
- After Phase A: `node --test test/runtime/runtime-locator-resolve.test.js test/runtime/runtime-leak-scan.test.js`; commit `feat(runtime): add locator resolvability and leak-scan primitives`

