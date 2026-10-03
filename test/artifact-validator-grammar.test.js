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

// ── 044-decision-register (IC-010): the `stale` rule and the archive-aware `history` rule ──────────
// Both need a feature folder: the stale rule reads decisions/register.json through the resolver, so
// these fixtures are real (scratch) git repos on a feat/ branch, and the validator runs from inside.

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
}

const dec = (id, extra) => ({
  id, topic: `topic-${id.slice(4)}`, statement: 's', decidedBy: 'user', channel: 'question', stage: 'design',
  date: '2026-10-03', at: '2026-10-03T00:00:00.000Z', status: 'live', supersedes: [], supersededBy: null,
  refs: [], source: '', rationale: 'r', ...extra,
});

/** A scratch repo holding feature 050-x (structured layout). `register` is the decisions array, or
 * null for a feature with no register. `files` maps feature-relative paths to content. */
function featureRepo(name, register, files, { vcs = true } = {}) {
  const repo = fs.mkdtempSync(path.join(scratch, `${name}-`));
  const feature = path.join(repo, 'agent-docs', 'doflow', '050-x');
  fs.mkdirSync(path.join(feature, 'intention'), { recursive: true });
  fs.mkdirSync(path.join(feature, 'design'), { recursive: true });
  fs.writeFileSync(path.join(feature, 'intention', 'requirement.md'), '# Requirement\n');
  if (register) {
    fs.mkdirSync(path.join(feature, 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(feature, 'decisions', 'register.json'),
      JSON.stringify({ version: 1, slug: '050-x', nextId: register.length + 1, decisions: register }));
  }
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(feature, rel)), { recursive: true });
    fs.writeFileSync(path.join(feature, rel), body);
  }
  if (vcs) {
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'checkout', '-q', '-b', 'feat/050-x');
  }
  return { repo, feature };
}

function validateIn(repo, ...args) {
  // PWD is set so a symlinked `repo` is seen logically, as an interactive shell would see it.
  const run = spawnSync('bash', [VALIDATOR, '--json', ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, PWD: repo }, timeout: 20000 });
  assert.equal(run.error, undefined);
  return { ...parseJson(run, args.join(' ')), status: run.status };
}

// DEC-001 was replaced by DEC-002, which was replaced by the live DEC-003; DEC-004 is untouched.
const CHAIN = [
  dec('DEC-001', { status: 'superseded', supersededBy: 'DEC-002' }),
  dec('DEC-002', { status: 'superseded', supersededBy: 'DEC-003', supersedes: ['DEC-001'] }),
  dec('DEC-003', { supersedes: ['DEC-002'] }),
  dec('DEC-004'),
];

test('stale: a line citing a superseded decision is flagged with the live end of its chain', () => {
  const { repo, feature } = featureRepo('stale-fires', CHAIN, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nThe wire carries the key. DEC-001\nThis one is fine. DEC-004\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(result.findings.map((f) => [f.rule, f.id, f.message]),
    [['stale', 'DEC-001', 'line 5 cites DEC-001, superseded by DEC-003']]);
  assert.equal(result.status, 1);
});

test('stale: a line that also names a later decision in the chain is exempt', () => {
  const { repo, feature } = featureRepo('stale-successor', CHAIN, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nWas DEC-001, now DEC-002.\nDEC-002 replaced DEC-001 and then DEC-003 replaced it.\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  // Line 5 names DEC-002 after DEC-001, but DEC-002 is itself superseded by DEC-003, which the
  // line does not name: DEC-002 is flagged, DEC-001 is exempt.
  assert.deepEqual(rules(result), ['stale DEC-002']);
});

test('stale: a token that merely contains a DEC id is not a citation', () => {
  const { repo, feature } = featureRepo('stale-boundary', CHAIN, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nXDEC-001 and 1DEC-001 and DEC-001a are not citations.\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(rules(result), []);
});

test('stale: History sections and HTML comments are exempt', () => {
  const { repo, feature } = featureRepo('stale-exempt', CHAIN, {
    'design/design.md': [
      '# Design', '', '## 1. Choices', '',
      '<!-- DEC-001 cited inside a one-line comment -->',
      '<!--', 'DEC-001 cited inside a block comment', '-->',
      'Visible text. <!-- DEC-001 --> more text.', '',
      '## 2. History', '', '- **DEC-001** replaced by DEC-003 in design.', 'DEC-001 was the first answer.', '',
    ].join('\n'),
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(rules(result), []);
});

test('stale: a feature without a register gets no stale finding', () => {
  const { repo, feature } = featureRepo('stale-no-register', null, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nThe wire carries the key. DEC-001\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(rules(result), []);
  assert.equal(result.status, 0);
});

test('stale: discovery mode covers data-model.md alongside the other artifacts', () => {
  const { repo } = featureRepo('stale-discovery', CHAIN, {
    'design/data-model.md': '# Data model\n\n## 1. Entities\n\nKeyed by number. DEC-001\n',
    'plan.md': '# Plan\n\n## 1. Basis\n\nResting on DEC-004.\n',
  });
  const result = validateIn(repo);
  assert.deepEqual(result.findings.map((f) => [path.basename(f.file), f.rule, f.id]),
    [['data-model.md', 'stale', 'DEC-001']]);
});

// FR-016: only a feature with a register gets data-model.md as a default target.
const BAD_DATA_MODEL = [
  '# Data model', '',
  '## 1. Entities', '',
  '| ID | Entity | Status |', '|---|---|---|', '| E-1 | Account | Live |', '',
  '**Detail**', '', '- **E-2:** not in the index.', '',
].join('\n');

test('data-model.md is not a default target without a register, and is with one', () => {
  const legacy = featureRepo('target-legacy', null, { 'design/data-model.md': BAD_DATA_MODEL, 'plan.md': '# Plan\n' });
  const before = validateIn(legacy.repo);
  assert.deepEqual(before.findings, []);
  assert.equal(before.status, 0);
  // Naming the file explicitly still checks it: only the default target set is gated.
  assert.deepEqual(rules(validateIn(legacy.repo, path.join(legacy.feature, 'design', 'data-model.md'))).sort(), ['parity E-1', 'parity E-2']);

  const registered = featureRepo('target-registered', CHAIN, { 'design/data-model.md': BAD_DATA_MODEL, 'plan.md': '# Plan\n' });
  const after = validateIn(registered.repo);
  assert.deepEqual(after.findings.map((f) => `${path.basename(f.file)} ${f.rule} ${f.id}`).sort(),
    ['data-model.md parity E-1', 'data-model.md parity E-2']);
  assert.equal(after.status, 1);
});

test('stale: an explicit path outside the feature folder is not checked against its register', () => {
  const { repo } = featureRepo('stale-outside', CHAIN, {});
  const outside = path.join(repo, 'notes.md');
  fs.writeFileSync(outside, '# Notes\n\n## 1. Choices\n\nCites DEC-001.\n');
  assert.deepEqual(rules(validateIn(repo, outside)), []);
});

test('history: an ID that moved to the archive named by the History pointer still has a History entry', () => {
  const body = (withPointer) => [
    '# Specs', '',
    '## 1. Contracts', '',
    '| ID | Contract | Status |', '|---|---|---|', '| IC-001 | old | Superseded -> IC-002 |', '| IC-002 | new | Live |', '',
    '**Detail**', '', '- **IC-001:** old.', '- **IC-002:** new.', '',
    '## 2. History', '',
    ...(withPointer ? ['Earlier entries: [decisions/history/specs.md](../decisions/history/specs.md).', ''] : []),
  ].join('\n');
  const archive = [
    '# History archive: design/specs.md', '',
    '## Compacted 2026-10-03 from design/specs.md §2', '',
    '| Date | ID | Change |', '|---|---|---|', '| 2026-09-04 | IC-009 | other |', '',
    '| ID | Change |', '|---|---|', '| IC-001 | replaced |', '',
  ].join('\n');

  const withPointer = featureRepo('history-pointer', CHAIN, { 'design/specs.md': body(true), 'decisions/history/specs.md': archive });
  assert.deepEqual(rules(validateIn(withPointer.repo, path.join(withPointer.feature, 'design', 'specs.md'))), []);

  const bulletArchive = archive.replace('| IC-001 | replaced |', '').concat('\n- **IC-001** — replaced.\n');
  const withBullet = featureRepo('history-bullet', null, { 'design/specs.md': body(true), 'decisions/history/specs.md': bulletArchive });
  assert.deepEqual(rules(validateIn(withBullet.repo, path.join(withBullet.feature, 'design', 'specs.md'))), []);

  // No pointer: the archive file beside it is not consulted, so the rule still fires.
  const noPointer = featureRepo('history-no-pointer', CHAIN, { 'design/specs.md': body(false), 'decisions/history/specs.md': archive });
  assert.deepEqual(rules(validateIn(noPointer.repo, path.join(noPointer.feature, 'design', 'specs.md'))), ['history IC-001']);

  // Pointer to an archive that does not exist: the rule still fires rather than failing open.
  const missing = featureRepo('history-missing', CHAIN, { 'design/specs.md': body(true) });
  assert.deepEqual(rules(validateIn(missing.repo, path.join(missing.feature, 'design', 'specs.md'))), ['history IC-001']);
});

test('stale: a feature reached through a symlinked root is still checked', () => {
  // Outside git the resolver reports the logical root, so the folder is compared by its physical
  // path on both sides.
  const { repo } = featureRepo('stale-symlink', CHAIN, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nThe wire carries the key. DEC-001\n',
  }, { vcs: false });
  const link = path.join(scratch, `link-${path.basename(repo)}`);
  fs.symlinkSync(repo, link);
  const result = validateIn(link, path.join(link, 'agent-docs', 'doflow', '050-x', 'design', 'design.md'));
  assert.deepEqual(rules(result), ['stale DEC-001']);
});

test('stale: fenced code neither opens a section nor cites a decision', () => {
  const { repo, feature } = featureRepo('stale-fence', CHAIN, {
    'design/design.md': [
      '# Design', '', '## 1. Choices', '',
      '```markdown', '## 9. History', 'DEC-001 inside a fence', '```',
      'Real line after the fenced example. DEC-001',
      '~~~~', '~~~', 'DEC-001 still inside the longer fence', '~~~~',
      'Another real line. DEC-001', '',
    ].join('\n'),
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  // A fenced "## 9. History" must not exempt line 9; lines 7 and 10-13 sit inside fences.
  assert.deepEqual(result.findings.map((f) => [f.rule, f.message]), [
    ['stale', 'line 9 cites DEC-001, superseded by DEC-003'],
    ['stale', 'line 14 cites DEC-001, superseded by DEC-003'],
  ]);
});

test('stale: a lone <!-- quoted in prose does not hide later citations; a same-line comment is still stripped', () => {
  const { repo, feature } = featureRepo('stale-inline-comment', CHAIN, {
    'design/design.md': [
      '# Design', '', '## 1. Choices', '',
      'Comments open with `<!--` in markdown.',
      'Cited after the quoted opener. DEC-001',
      'Closed on the same line <!-- DEC-001 --> is ignored.',
      '  <!-- an indented block opener', 'DEC-001 inside the block', '-->',
      'After the block. DEC-001', '',
    ].join('\n'),
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(result.findings.map((f) => f.message), [
    'line 6 cites DEC-001, superseded by DEC-003',
    'line 11 cites DEC-001, superseded by DEC-003',
  ]);
});

test('stale: a cyclic supersededBy chain in a hand-edited register terminates and stays advisory', () => {
  const { repo, feature } = featureRepo('stale-cycle', [
    dec('DEC-001', { status: 'superseded', supersededBy: 'DEC-002' }),
    dec('DEC-002', { status: 'superseded', supersededBy: 'DEC-001' }),
    dec('DEC-003', { status: 'superseded', supersededBy: 'DEC-003' }),
  ], {
    'design/design.md': '# Design\n\n## 1. Choices\n\nOne. DEC-001\nTwo. DEC-003\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.equal(result.note, undefined);
  assert.equal(result.status, 1);
  assert.deepEqual(rules(result), ['stale DEC-001']);
});

test('history: a pointer leading outside decisions/history is ignored', () => {
  const body = (target) => [
    '# Specs', '',
    '## 1. Contracts', '',
    '| ID | Contract | Status |', '|---|---|---|', '| IC-001 | old | Superseded -> IC-002 |', '| IC-002 | new | Live |', '',
    '**Detail**', '', '- **IC-001:** old.', '- **IC-002:** new.', '',
    '## 2. History', '',
    `Earlier entries: [decisions/history/specs.md](${target}).`, '',
  ].join('\n');
  const archive = '# History archive: design/specs.md\n\n- **IC-001** — replaced.\n';
  const inside = featureRepo('history-contained', CHAIN, { 'design/specs.md': body('../decisions/history/specs.md'), 'decisions/history/specs.md': archive });
  assert.deepEqual(rules(validateIn(inside.repo, path.join(inside.feature, 'design', 'specs.md'))), []);

  const up = featureRepo('history-dotdot', CHAIN, { 'design/specs.md': body('../../elsewhere.md'), 'decisions/history/specs.md': '# x\n' });
  fs.writeFileSync(path.join(up.feature, '..', 'elsewhere.md'), archive);
  assert.deepEqual(rules(validateIn(up.repo, path.join(up.feature, 'design', 'specs.md'))), ['history IC-001']);

  const abs = featureRepo('history-absolute', CHAIN, { 'design/specs.md': '', 'decisions/history/specs.md': '# x\n' });
  const outside = path.join(abs.repo, 'outside.md');
  fs.writeFileSync(outside, archive);
  fs.writeFileSync(path.join(abs.feature, 'design', 'specs.md'), body(outside));
  assert.deepEqual(rules(validateIn(abs.repo, path.join(abs.feature, 'design', 'specs.md'))), ['history IC-001']);
});

test('unknown: a cited DEC id the register does not hold is flagged; known live and superseded ids are not', () => {
  const { repo, feature } = featureRepo('unknown-fires', CHAIN, {
    'design/design.md': [
      '# Design', '', '## 1. Choices', '',
      'Live and known. DEC-004',
      'Superseded but known, named with its successor. DEC-001 DEC-003',
      'Typo. DEC-099 and again DEC-099',
      'Padded form of a known id. DEC-0004',
      'Not an id. XDEC-098 DEC-097a',
      '', '```', 'DEC-096 in a fence', '```',
      '<!-- DEC-095 in a comment -->',
      '', '## 2. History', '', '- **DEC-094** retired.', '',
    ].join('\n'),
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(result.findings.map((f) => [f.rule, f.id, f.message]),
    [['unknown', 'DEC-099', 'line 7 cites DEC-099, which is not in the decision register']]);
  assert.equal(result.status, 1);
});

test('unknown: inert without a register, and active for a register holding no decisions', () => {
  const body = { 'design/design.md': '# Design\n\n## 1. Choices\n\nCites DEC-001.\n' };
  const none = featureRepo('unknown-no-register', null, body);
  assert.deepEqual(rules(validateIn(none.repo, path.join(none.feature, 'design', 'design.md'))), []);
  const empty = featureRepo('unknown-empty-register', [], body);
  assert.deepEqual(rules(validateIn(empty.repo, path.join(empty.feature, 'design', 'design.md'))), ['unknown DEC-001']);
});
