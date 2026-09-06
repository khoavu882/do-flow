'use strict';

// IC-002: the detail-entry grammar of validate-artifacts.sh accepts two forms — the "- **<ID>"
// bullet and the "#### <ID>: <text>" heading — and the heading counts only when its ID is also a
// row of that section's index table. Design risk RK2 is the reason the second clause exists: an
// ID-shaped heading that matches nothing must be ignored outright rather than reported as an
// orphan, or every "#### C4 Level 1: System Context" in a design.md invents a finding.
//
// Behavioural coverage of a shipped script, not a structural guard over repo content, so it lives
// beside test/ rather than in test/guards/. Every fixture is written to a scratch directory that is
// removed on exit; nothing here reads or writes agent-docs/, so the file is hermetic in a fresh
// clone and in CI, where that directory does not exist at all.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const VALIDATOR = path.join(__dirname, '..', 'core', 'shared', 'scripts', 'doflow', 'bash', 'validate-artifacts.sh');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-artifact-grammar-'));

// Every fixture this file writes lives under `scratch`, so one removal releases all of them. Without
// it each `npm test` leaves a directory behind -- rules/universal.md, Resource Management: no
// resource is acquired without a guaranteed release path.
process.on('exit', () => { try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ } });

// Run the checker over one artifact written to the scratch directory, and read its findings back
// through --json so a message never has to be recovered from column-aligned text.
function check(name, body) {
  const file = path.join(scratch, name);
  fs.writeFileSync(file, body.endsWith('\n') ? body : `${body}\n`);
  const run = spawnSync('bash', [VALIDATOR, '--json', file], { encoding: 'utf8' });
  assert.equal(run.error, undefined, `validator failed to spawn: ${run.error && run.error.message}`);
  const parsed = parseJson(run, name);
  assert.equal(parsed.note, undefined, `validator fell open with note "${parsed.note}" instead of checking ${name}`);
  return { ...parsed, status: run.status };
}

/** Parse the checker's stdout, reporting what actually came back when it is not JSON. A bare
 * JSON.parse here surfaces an environment failure as "SyntaxError: Unexpected token" with no
 * fixture name, no exit code and no stderr -- misreporting the environment as a validator bug. */
function parseJson(run, ctx) {
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    assert.fail(`${ctx}: the validator did not emit JSON (exit ${run.status}).\n`
      + `  stdout: ${JSON.stringify(run.stdout.slice(0, 300))}\n`
      + `  stderr: ${JSON.stringify((run.stderr || '').slice(0, 300))}\n`
      + `  parse error: ${err.message}`);
  }
}

function rules(result) {
  return result.findings.map((f) => `${f.rule} ${f.id}`);
}

test('a heading-form detail entry whose ID is in the index is recognised', () => {
  const result = check('heading-form.md', `# Specs

## 1. Interface Contracts

| ID | Contract | Status |
|---|---|---|
| IC-001 | Detail-entry grammar | Live |
| IC-002 | Guard comparison | Live |

**Detail**

#### IC-001: Detail-entry grammar

A detail entry is recognised in either of two forms.

#### IC-002: Guard comparison

The guard compares the declaration against the transcription.
`);

  assert.deepEqual(rules(result), []);
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
});

test('an ID-shaped heading with no index row is ignored, reporting no orphan', () => {
  const result = check('unmatched-heading.md', `# Design

## 3. Components & Boundaries

| ID | Component | Status |
|---|---|---|
| C1 | Validator | Live |

**Detail**

- **C1:** The validator reads an artifact and reports inconsistencies.

#### C4 Level 1: System Context

#### C9: A component that was never indexed

#### Family: Checking
`);

  assert.deepEqual(rules(result), []);
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
});

test('an unindexed ID-shaped heading does not satisfy an index row either', () => {
  // The complement of the case above: ignoring the heading has to leave the row it superficially
  // resembles still unsatisfied, or "ignored" would quietly mean "accepted".
  const result = check('heading-does-not-satisfy.md', `# Design

## 3. Components & Boundaries

| ID | Component | Status |
|---|---|---|
| C1 | Validator | Live |
| C2 | Reporter | Live |

**Detail**

- **C1:** The validator reads an artifact and reports inconsistencies.
`);

  assert.deepEqual(rules(result), ['parity C2']);
  assert.match(result.findings[0].message, /appears in the index but has no Detail entry/);
  assert.equal(result.ok, false);
  assert.equal(result.status, 1);
});

test('the bullet form is unchanged, including a parenthetical qualifier inside the bold', () => {
  const result = check('bullet-form.md', `# Requirement

## 4. Non-Functional Requirements

| ID | Requirement | Status |
|---|---|---|
| NFR-001 | Backward compatible | Live |
| NFR-002 | Non-blocking | Live |

**Detail**

- **NFR-001 (Backward compatible):** Every ID an older artifact declares still resolves.
- **NFR-002:** Nothing introduced here halts a user's chain.
`);

  assert.deepEqual(rules(result), []);
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
});

test('the bullet form still reports an orphan in either direction', () => {
  const result = check('bullet-orphans.md', `# Requirement

## 3. Functional Requirements

| ID | Requirement | Status |
|---|---|---|
| FR-001 | Indexed and detailed | Live |
| FR-002 | Indexed only | Live |

**Detail**

- **FR-001:** This one has both sides.
- **FR-003:** This one has detail and no index row.
`);

  assert.deepEqual(rules(result).sort(), ['parity FR-002', 'parity FR-003']);
  assert.equal(result.status, 1);
});

test('both forms in one artifact are read as detail entries of the same section', () => {
  const result = check('mixed-forms.md', `# Specs

## 1. Interface Contracts

| ID | Contract | Family | Status |
|---|---|---|---|
| IC-001 | Grammar | Checking | Live |
| IC-002 | Guard | Checking | Live |
| IC-003 | Voice | Authoring | Superseded → IC-002 |

**Detail**

#### Family: Checking

#### IC-001: Grammar

The bullet form and the heading form both parse.

- **IC-002:** The guard compares four token sets in both directions.

#### Family: Authoring

#### IC-003: Voice

Superseded, and recorded below.

## 3. History

| Date | ID | Change | Replaced by |
|---|---|---|---|
| 2026-09-04 | IC-003 | Folded into the guard contract | IC-002 |

**Detail**

- **IC-003** — What it said before, and what is true now.
`);

  assert.deepEqual(rules(result), []);
  assert.equal(result.ok, true);
  assert.equal(result.status, 0);
});

test('a heading form in a later section does not satisfy an index row in an earlier one', () => {
  // Parity is per section, and sec advances on "## " headings only, so a "####" heading must not
  // disturb that tracking.
  const result = check('cross-section.md', `# Design

## 3. Components & Boundaries

| ID | Component | Status |
|---|---|---|
| C1 | Validator | Live |

**Detail**

- **C1:** The validator reads an artifact.

## 7. Risks

| ID | Risk | Status |
|---|---|---|
| R1 | Grammar over-matches | Live |

**Detail**

#### C1: Not the component of section 3

#### R1: Grammar over-matches

An ID-shaped heading could match something it should not.
`);

  assert.deepEqual(rules(result), []);
  assert.equal(result.status, 0);
});

test('a named file that cannot be read is a finding, not a clean result', () => {
  // The heading rule must not have widened the fail-open surface: an unreadable target still exits
  // 1 and says so.
  const missing = path.join(scratch, 'absent.md');
  const run = spawnSync('bash', [VALIDATOR, '--json', missing], { encoding: 'utf8' });
  assert.equal(run.error, undefined, `validator failed to spawn: ${run.error && run.error.message}`);
  const parsed = parseJson(run, 'absent.md');
  assert.equal(parsed.ok, false);
  assert.equal(run.status, 1);
  assert.deepEqual(parsed.findings.map((f) => f.rule), ['io']);
});

test('a specs.md shaped like a real one, with family grouping, parses clean', () => {
  // This reproduces the shape a written specs.md actually takes: an index, family sub-headings that
  // match no index row, per-contract headings that do, and a History section using the bullet form.
  // It was previously asserted against the repository's own agent-docs/ tree, which is gitignored --
  // so the block returned before asserting anything in a fresh clone and in CI, and depended on
  // hand-authored content nobody maintains anywhere else. The fixture is hermetic and always runs.
  const result = check('realistic-specs.md', `# Specs

## 1. Interface Contracts

| ID | Contract | Family | Status |
|---|---|---|---|
| IC-001 | First contract | Checking | Superseded → IC-003 |
| IC-002 | Second contract | Checking | Live |
| IC-003 | Third contract | Authoring | Live |

**Detail**

#### Family: Checking

#### IC-001: First contract

Superseded by IC-003. Its prose is in §3.

#### IC-002: Second contract

The full normative shape, every qualifier intact.

#### Family: Authoring

#### IC-003: Third contract

The replacement for IC-001.

## 2. Data Model

### Conceptual domain map

#### ER view: catalog

## 3. History

| Date | ID | Change | Replaced by |
|---|---|---|---|
| 2026-09-04 | IC-001 | Replaced during design | IC-003 |

**Detail**

- **IC-001** — what it said before, and why it changed.
`);

  assert.deepEqual(rules(result), []);
  assert.equal(result.status, 0);
});
