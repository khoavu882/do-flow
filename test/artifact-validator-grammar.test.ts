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
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, suiteTempDir } = require('./helper/tmp.ts');

const VALIDATOR = path.join(__dirname, '..', 'core', 'shared', 'scripts', 'doflow', 'bash', 'validate-artifacts.sh');
const scratch = suiteTempDir('doflow-artifact-grammar-');

// Run the checker over one artifact written to the scratch directory, and read its findings back
// through --json so a message never has to be recovered from column-aligned text.
function check(name: any, body: any) {
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
function parseJson(run: any, ctx: any) {
  try {
    return JSON.parse(run.stdout);
  } catch (err) {
    assert.fail(`${ctx}: the validator did not emit JSON (exit ${run.status}).\n`
      + `  stdout: ${JSON.stringify(run.stdout.slice(0, 300))}\n`
      + `  stderr: ${JSON.stringify((run.stderr || '').slice(0, 300))}\n`
      + `  parse error: ${(err as Error).message}`);
  }
}

function rules(result: any) {
  return result.findings.map((f: any) => `${f.rule} ${f.id}`);
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
  assert.deepEqual(parsed.findings.map((f: any) => f.rule), ['io']);
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

function git(cwd: any, ...args: any[]) {
  const run = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  assert.equal(run.status, 0, `git ${args.join(' ')} failed: ${run.stderr}`);
}

const dec = (id: any, extra?: any) => ({
  id, topic: `topic-${id.slice(4)}`, statement: 's', decidedBy: 'user', channel: 'question', stage: 'design',
  date: '2026-10-03', at: '2026-10-03T00:00:00.000Z', status: 'live', supersedes: [], supersededBy: null,
  refs: [], source: '', rationale: 'r', ...extra,
});

/** A scratch repo holding feature 050-x (structured layout). `register` is the decisions array, or
 * null for a feature with no register. `files` maps feature-relative paths to content. */
function featureRepo(t: any, name: any, register: any, files: any, { vcs = true } = {}) {
  const repo = tempDir(t, `doflow-artifact-grammar-${name}-`);
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

function validateIn(repo: any, ...args: any[]) {
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

test('stale: a line citing a superseded decision is flagged with the live end of its chain', (t) => {
  const { repo, feature } = featureRepo(t, 'stale-fires', CHAIN, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nThe wire carries the key. DEC-001\nThis one is fine. DEC-004\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(result.findings.map((f: any) => [f.rule, f.id, f.message]),
    [['stale', 'DEC-001', 'line 5 cites DEC-001, superseded by DEC-003']]);
  assert.equal(result.status, 1);
});

test('stale: a line that also names a later decision in the chain is exempt', (t) => {
  const { repo, feature } = featureRepo(t, 'stale-successor', CHAIN, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nWas DEC-001, now DEC-002.\nDEC-002 replaced DEC-001 and then DEC-003 replaced it.\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  // Line 5 names DEC-002 after DEC-001, but DEC-002 is itself superseded by DEC-003, which the
  // line does not name: DEC-002 is flagged, DEC-001 is exempt.
  assert.deepEqual(rules(result), ['stale DEC-002']);
});

test('stale: a token that merely contains a DEC id is not a citation', (t) => {
  const { repo, feature } = featureRepo(t, 'stale-boundary', CHAIN, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nXDEC-001 and 1DEC-001 and DEC-001a are not citations.\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(rules(result), []);
});

test('stale: History sections and HTML comments are exempt', (t) => {
  const { repo, feature } = featureRepo(t, 'stale-exempt', CHAIN, {
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

test('stale: a feature without a register gets no stale finding', (t) => {
  const { repo, feature } = featureRepo(t, 'stale-no-register', null, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nThe wire carries the key. DEC-001\n',
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(rules(result), []);
  assert.equal(result.status, 0);
});

test('stale: discovery mode covers data-model.md alongside the other artifacts', (t) => {
  const { repo } = featureRepo(t, 'stale-discovery', CHAIN, {
    'design/data-model.md': '# Data model\n\n## 1. Entities\n\nKeyed by number. DEC-001\n',
    'plan.md': `${taskPlan(['- [ ] A.1 Build'])}\n## 1. Basis\n\nResting on DEC-004.\n`,
  });
  const result = validateIn(repo);
  assert.deepEqual(result.findings.map((f: any) => [path.basename(f.file), f.rule, f.id]),
    [['data-model.md', 'stale', 'DEC-001']]);
});

// FR-016: only a feature with a register gets data-model.md as a default target.
const BAD_DATA_MODEL = [
  '# Data model', '',
  '## 1. Entities', '',
  '| ID | Entity | Status |', '|---|---|---|', '| E-1 | Account | Live |', '',
  '**Detail**', '', '- **E-2:** not in the index.', '',
].join('\n');

test('data-model.md is not a default target without a register, and is with one', (t) => {
  const legacy = featureRepo(t, 'target-legacy', null, { 'design/data-model.md': BAD_DATA_MODEL, 'plan.md': taskPlan(['- [ ] A.1 Build']) });
  const before = validateIn(legacy.repo);
  assert.deepEqual(before.findings, []);
  assert.equal(before.status, 0);
  // Naming the file explicitly still checks it: only the default target set is gated.
  assert.deepEqual(rules(validateIn(legacy.repo, path.join(legacy.feature, 'design', 'data-model.md'))).sort(), ['parity E-1', 'parity E-2']);

  const registered = featureRepo(t, 'target-registered', CHAIN, { 'design/data-model.md': BAD_DATA_MODEL, 'plan.md': taskPlan(['- [ ] A.1 Build']) });
  const after = validateIn(registered.repo);
  assert.deepEqual(after.findings.map((f: any) => `${path.basename(f.file)} ${f.rule} ${f.id}`).sort(),
    ['data-model.md parity E-1', 'data-model.md parity E-2']);
  assert.equal(after.status, 1);
});

test('stale: an explicit path outside the feature folder is not checked against its register', (t) => {
  const { repo } = featureRepo(t, 'stale-outside', CHAIN, {});
  const outside = path.join(repo, 'notes.md');
  fs.writeFileSync(outside, '# Notes\n\n## 1. Choices\n\nCites DEC-001.\n');
  assert.deepEqual(rules(validateIn(repo, outside)), []);
});

test('history: an ID that moved to the archive named by the History pointer still has a History entry', (t) => {
  const body = (withPointer: any) => [
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

  const withPointer = featureRepo(t, 'history-pointer', CHAIN, { 'design/specs.md': body(true), 'decisions/history/specs.md': archive });
  assert.deepEqual(rules(validateIn(withPointer.repo, path.join(withPointer.feature, 'design', 'specs.md'))), []);

  const bulletArchive = archive.replace('| IC-001 | replaced |', '').concat('\n- **IC-001** — replaced.\n');
  const withBullet = featureRepo(t, 'history-bullet', null, { 'design/specs.md': body(true), 'decisions/history/specs.md': bulletArchive });
  assert.deepEqual(rules(validateIn(withBullet.repo, path.join(withBullet.feature, 'design', 'specs.md'))), []);

  // No pointer: the archive file beside it is not consulted, so the rule still fires.
  const noPointer = featureRepo(t, 'history-no-pointer', CHAIN, { 'design/specs.md': body(false), 'decisions/history/specs.md': archive });
  assert.deepEqual(rules(validateIn(noPointer.repo, path.join(noPointer.feature, 'design', 'specs.md'))), ['history IC-001']);

  // Pointer to an archive that does not exist: the rule still fires rather than failing open.
  const missing = featureRepo(t, 'history-missing', CHAIN, { 'design/specs.md': body(true) });
  assert.deepEqual(rules(validateIn(missing.repo, path.join(missing.feature, 'design', 'specs.md'))), ['history IC-001']);
});

test('stale: a feature reached through a symlinked root is still checked', (t) => {
  // Outside git the resolver reports the logical root, so the folder is compared by its physical
  // path on both sides.
  const { repo } = featureRepo(t, 'stale-symlink', CHAIN, {
    'design/design.md': '# Design\n\n## 1. Choices\n\nThe wire carries the key. DEC-001\n',
  }, { vcs: false });
  const link = path.join(scratch, `link-${path.basename(repo)}`);
  fs.symlinkSync(repo, link);
  const result = validateIn(link, path.join(link, 'agent-docs', 'doflow', '050-x', 'design', 'design.md'));
  assert.deepEqual(rules(result), ['stale DEC-001']);
});

test('stale: fenced code neither opens a section nor cites a decision', (t) => {
  const { repo, feature } = featureRepo(t, 'stale-fence', CHAIN, {
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
  assert.deepEqual(result.findings.map((f: any) => [f.rule, f.message]), [
    ['stale', 'line 9 cites DEC-001, superseded by DEC-003'],
    ['stale', 'line 14 cites DEC-001, superseded by DEC-003'],
  ]);
});

test('stale: a lone <!-- quoted in prose does not hide later citations; a same-line comment is still stripped', (t) => {
  const { repo, feature } = featureRepo(t, 'stale-inline-comment', CHAIN, {
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
  assert.deepEqual(result.findings.map((f: any) => f.message), [
    'line 6 cites DEC-001, superseded by DEC-003',
    'line 11 cites DEC-001, superseded by DEC-003',
  ]);
});

test('stale: a cyclic supersededBy chain in a hand-edited register terminates and stays advisory', (t) => {
  const { repo, feature } = featureRepo(t, 'stale-cycle', [
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

test('history: a pointer leading outside decisions/history is ignored', (t) => {
  const body = (target: any) => [
    '# Specs', '',
    '## 1. Contracts', '',
    '| ID | Contract | Status |', '|---|---|---|', '| IC-001 | old | Superseded -> IC-002 |', '| IC-002 | new | Live |', '',
    '**Detail**', '', '- **IC-001:** old.', '- **IC-002:** new.', '',
    '## 2. History', '',
    `Earlier entries: [decisions/history/specs.md](${target}).`, '',
  ].join('\n');
  const archive = '# History archive: design/specs.md\n\n- **IC-001** — replaced.\n';
  const inside = featureRepo(t, 'history-contained', CHAIN, { 'design/specs.md': body('../decisions/history/specs.md'), 'decisions/history/specs.md': archive });
  assert.deepEqual(rules(validateIn(inside.repo, path.join(inside.feature, 'design', 'specs.md'))), []);

  const up = featureRepo(t, 'history-dotdot', CHAIN, { 'design/specs.md': body('../../elsewhere.md'), 'decisions/history/specs.md': '# x\n' });
  fs.writeFileSync(path.join(up.feature, '..', 'elsewhere.md'), archive);
  assert.deepEqual(rules(validateIn(up.repo, path.join(up.feature, 'design', 'specs.md'))), ['history IC-001']);

  const abs = featureRepo(t, 'history-absolute', CHAIN, { 'design/specs.md': '', 'decisions/history/specs.md': '# x\n' });
  const outside = path.join(abs.repo, 'outside.md');
  fs.writeFileSync(outside, archive);
  fs.writeFileSync(path.join(abs.feature, 'design', 'specs.md'), body(outside));
  assert.deepEqual(rules(validateIn(abs.repo, path.join(abs.feature, 'design', 'specs.md'))), ['history IC-001']);
});

test('unknown: a cited DEC id the register does not hold is flagged; known live and superseded ids are not', (t) => {
  const { repo, feature } = featureRepo(t, 'unknown-fires', CHAIN, {
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
  assert.deepEqual(result.findings.map((f: any) => [f.rule, f.id, f.message]),
    [['unknown', 'DEC-099', 'line 7 cites DEC-099, which is not in the decision register']]);
  assert.equal(result.status, 1);
});

test('unknown: inert without a register, and active for a register holding no decisions', (t) => {
  const body = { 'design/design.md': '# Design\n\n## 1. Choices\n\nCites DEC-001.\n' };
  const none = featureRepo(t, 'unknown-no-register', null, body);
  assert.deepEqual(rules(validateIn(none.repo, path.join(none.feature, 'design', 'design.md'))), []);
  const empty = featureRepo(t, 'unknown-empty-register', [], body);
  assert.deepEqual(rules(validateIn(empty.repo, path.join(empty.feature, 'design', 'design.md'))), ['unknown DEC-001']);
});

test('history: a project path containing a backslash is read literally, not as an escape sequence', (t) => {
  // A directory named with a literal "\t": awk -v would turn that into a tab and miss the archive.
  const { repo, feature } = featureRepo(t, 'bs\\tdir', CHAIN, {
    'design/specs.md': [
      '# Specs', '', '## 1. Contracts', '',
      '| ID | Contract | Status |', '|---|---|---|', '| IC-001 | old | Superseded -> IC-002 |', '| IC-002 | new | Live |', '',
      '**Detail**', '', '- **IC-001:** old.', '- **IC-002:** new.', '',
      '## 2. History', '', 'Earlier entries: [decisions/history/specs.md](../decisions/history/specs.md).', '',
    ].join('\n'),
    'decisions/history/specs.md': '# History archive: design/specs.md\n\n- **IC-001** — replaced.\n',
  });
  assert.ok(repo.includes('\\t'), 'the fixture path must contain a literal backslash');
  assert.deepEqual(rules(validateIn(repo, path.join(feature, 'design', 'specs.md'))), []);
});

// ── IC-006 (feature 045): path tokens are not citations; fenced "## " lines are gated by a register ─

test('unknown and stale: a DEC token after "/" in a URL or a path is not a citation; a bare one still is', (t) => {
  const { repo, feature } = featureRepo(t, 'path-token', CHAIN, {
    'design/design.md': [
      '# Design', '', '## 1. Choices', '',
      'Link https://x.test/DEC-780 and file notes/DEC-781.md stay quiet.',
      'A superseded id in a path, docs/DEC-001.md, is not stale either.',
      '[linked](../decisions/DEC-782.md) is a link target.',
      'Bare citation DEC-783 is unknown.',
      'Bare superseded DEC-001 is stale.',
      'Both on one line: notes/DEC-784.md then DEC-785.',
      '',
    ].join('\n'),
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(result.findings.map((f: any) => [f.rule, f.id]), [
    ['unknown', 'DEC-783'],
    ['stale', 'DEC-001'],
    ['unknown', 'DEC-785'],
  ]);
});

const FENCED_HISTORY_SPECS = [
  '# Specs', '', '## 1. Contracts', '',
  '```markdown', '## 9. History', '```', '',
  '| ID | Contract | Status |', '|---|---|---|', '| IC-001 | old | Superseded -> IC-002 |', '| IC-002 | new | Live |', '',
  '**Detail**', '', '- **IC-001:** old.', '- **IC-002:** new.', '',
].join('\n');

test('a fenced "## 9. History" example does not hide a missing History entry when the feature has a register', (t) => {
  const { repo, feature } = featureRepo(t, 'fence-section-register', CHAIN, { 'design/specs.md': FENCED_HISTORY_SPECS });
  assert.deepEqual(rules(validateIn(repo, path.join(feature, 'design', 'specs.md'))), ['history IC-001']);
});

test('without a register the structural section tracking is exactly what it was', (t) => {
  const { repo, feature } = featureRepo(t, 'fence-section-legacy', null, { 'design/specs.md': FENCED_HISTORY_SPECS });
  assert.deepEqual(rules(validateIn(repo, path.join(feature, 'design', 'specs.md'))), []);
});

test('unknown and stale: DEC-001/DEC-099 in prose is a pair of citations, only URL and path words are exempt', (t) => {
  const { repo, feature } = featureRepo(t, 'slash-pair', CHAIN, {
    'design/design.md': [
      '# Design', '', '## 1. Choices', '',
      'Pair DEC-004/DEC-099 in prose.',
      'Parenthesised (DEC-004/DEC-098) too.',
      'A superseded pair DEC-001/DEC-004 names DEC-004 but not the live end.',
      'Still exempt: https://x.test/DEC-780 and notes/DEC-781.md and a/DEC-782.',
      '',
    ].join('\n'),
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(result.findings.map((f: any) => [f.rule, f.id]), [
    ['unknown', 'DEC-099'], ['unknown', 'DEC-098'], ['stale', 'DEC-001'],
  ]);
});

const FENCED_PLAN = [
  '# Plan', '', '## 1. Summary', '',
  '| Phase | Tasks |', '|---|---|', '| A | 1 |', '',
  '## 2. Tasks', '',
  '### Phase A', '',
  '- [ ] A.1 real task', '',
  '```markdown', '### Phase B', '- [ ] B.1 example', '- [ ] A.9 example', '## 3. History', '```', '',
].join('\n');

test('with a register, headings and checklist lines inside a fence do not feed the phase rollup', (t) => {
  const { repo, feature } = featureRepo(t, 'fence-phase-register', CHAIN, { 'plan.md': FENCED_PLAN });
  assert.deepEqual(rules(validateIn(repo, path.join(feature, 'plan.md'))), []);
});

test('without a register the phase rollup reads fenced lines exactly as it always did', (t) => {
  const { repo, feature } = featureRepo(t, 'fence-phase-legacy', null, { 'plan.md': FENCED_PLAN });
  assert.deepEqual(rules(validateIn(repo, path.join(feature, 'plan.md'))), ['rollup Phase B']);
});

test('unknown and stale: link targets, query strings and file names are exempt; chains and a sentence-final token are not', (t) => {
  const { repo, feature } = featureRepo(t, 'token-shapes', CHAIN, {
    'design/design.md': [
      '# Design', '', '## 1. Choices', '',
      'Link [n](DEC-097.md) and https://x.test?id=DEC-095 and a bare DEC-094.md stay quiet.',
      'Superseded targets stay quiet too: [old](DEC-001.md) and https://x.test?id=DEC-001.',
      'Chain DEC-090/DEC-091/DEC-092 checks all three.',
      'Sentence-final citation DEC-099.',
      'Mid-sentence DEC-098. Then more.',
      '',
    ].join('\n'),
  });
  const result = validateIn(repo, path.join(feature, 'design', 'design.md'));
  assert.deepEqual(result.findings.map((f: any) => [f.rule, f.id]), [
    ['unknown', 'DEC-090'], ['unknown', 'DEC-091'], ['unknown', 'DEC-092'],
    ['unknown', 'DEC-099'], ['unknown', 'DEC-098'],
  ]);
});

// ── 115 (IC-003): the `task-graph` rule asks the plan-check verb about each plan.md ──────────────
// Fixture text is the one test/runtime/plan-verdict.test.js feeds planVerdict, so the two cannot
// disagree about what a malformed plan is. The rule is advisory like the others: one finding per
// problem plan-check reports, none when plan-check cannot run.

function taskPlan(lines: any, { header = '**Task graph:** v1', tasksSection = true } = {}) {
  return [
    '# Plan', '',
    ...(header ? [header, ''] : []),
    ...(tasksSection ? ['## 8. Tasks', '', ...lines] : ['## Overview', 'No task list.']),
    '',
  ].join('\n');
}

const TASK_GRAPH_FIXTURES = [
  { name: 'bad-acceptance range', text: taskPlan(['- [ ] A.1 Build — acceptance: FR-001..FR-005']),
    id: 'A.1', message: "bad-acceptance 'FR-001..FR-005'" },
  { name: 'bad-acceptance requirement kind', text: taskPlan(['- [ ] A.1 Build — acceptance: RK-001']),
    id: 'A.1', message: "bad-acceptance 'RK-001'" },
  { name: 'bad-acceptance decision id', text: taskPlan(['- [ ] A.1 Build — acceptance: DEC-004']),
    id: 'A.1', message: "bad-acceptance 'DEC-004'" },
  { name: 'bad-dependency', text: taskPlan(['- [ ] A.1 Build; depends-on: A.1 (after review)']),
    id: 'A.1', message: "bad-dependency 'A.1 (after review)'" },
  { name: 'unknown-dependency', text: taskPlan(['- [ ] A.1 Build; depends-on: B.1']),
    id: 'A.1,B.1', message: 'unknown-dependency' },
  { name: 'duplicate-id', text: taskPlan(['- [ ] A.1 Build', '### Completion Criteria', '- [ ] A.1 Build completion criteria']),
    id: 'A.1', message: 'duplicate-id' },
  { name: 'bad-budget', text: taskPlan(['- [ ] A.1 Build — budget: attempts=0']),
    id: 'A.1', message: "bad-budget 'attempts=0'" },
  { name: 'bad-header', text: taskPlan(['- [ ] A.1 Build'], { header: '**Task graph:** v2' }),
    id: '-', message: "bad-header 'v2'" },
  { name: 'cycle', text: taskPlan(['- [ ] A.1 First; depends-on: A.2', '- [ ] A.2 Second; depends-on: A.1']),
    id: 'A.1,A.2', message: 'cycle via A.1->A.2, A.2->A.1' },
  { name: 'no-tasks (empty section)', text: taskPlan([]), id: '-', message: 'no-tasks' },
  { name: 'no-tasks (no section)', text: taskPlan([], { tasksSection: false }), id: '-', message: 'no-tasks' },
];

/** Write `body` to <scratch>/<dir>/<name> and run the checker over it with `extra` spawn options. */
function checkIn(dir: any, name: any, body: any, { validator = VALIDATOR, ...options }: any = {}) {
  const folder = path.join(scratch, dir);
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, name);
  fs.writeFileSync(file, body);
  const run = spawnSync('bash', [validator, '--json', file], { encoding: 'utf8', ...options });
  assert.equal(run.error, undefined, `validator failed to spawn: ${run.error && run.error.message}`);
  return { run, file, result: parseJson(run, `${dir}/${name}`) };
}

test('task-graph: each malformed plan gives exactly one finding with the plan-check id and message', () => {
  for (const fixture of TASK_GRAPH_FIXTURES) {
    const dir = `task-graph-${fixture.name.replace(/\W+/g, '-')}`;
    const { run, file, result } = checkIn(dir, 'plan.md', fixture.text);
    assert.deepEqual(result.findings, [
      { file, rule: 'task-graph', id: fixture.id, message: fixture.message },
    ], fixture.name);
    assert.equal(result.ok, false, fixture.name);
    assert.equal(run.status, 1, `${fixture.name}: a task-graph finding exits 1 like the others`);
    assert.doesNotMatch(run.stderr, /^note:/m, fixture.name);
  }
});

test('task-graph: a clean plan has no finding, and the other rules still run beside it', () => {
  const clean = checkIn('task-graph-clean', 'plan.md', taskPlan(['- [ ] A.1 First', '- [ ] A.2 Second; depends-on: A.1']));
  assert.deepEqual(clean.result, { ok: true, findings: [] });
  assert.equal(clean.run.status, 0);

  // Two independent problems in one file: the rollup finding from awk and the task-graph finding.
  const both = checkIn('task-graph-both', 'plan.md', [
    '# Plan', '', '**Task graph:** v2', '',
    '| Phase | Tasks |', '|---|---|', '| A | 3 |', '',
    '## 8. Tasks', '', '### Phase A', '', '- [ ] A.1 First', '',
  ].join('\n'));
  assert.deepEqual(both.result.findings.map((f: any) => `${f.rule} ${f.id}`), ['rollup Phase A', 'task-graph -']);
});

test('task-graph: only a file named plan.md is asked about', () => {
  const { run, result } = checkIn('task-graph-non-plan', 'design.md', taskPlan([]));
  assert.deepEqual(result, { ok: true, findings: [] });
  assert.equal(run.status, 0);
  assert.equal(run.stderr, '');
});

test('task-graph: a plan.md that cannot be read is the one io finding, with no task-graph finding', () => {
  const missing = path.join(scratch, 'task-graph-absent', 'plan.md');
  const run = spawnSync('bash', [VALIDATOR, '--json', missing], { encoding: 'utf8' });
  const parsed = parseJson(run, 'absent plan.md');
  assert.deepEqual(parsed.findings.map((f: any) => f.rule), ['io']);
  assert.equal(run.status, 1);
});

test('task-graph: the dispatcher missing prints one note on stderr and adds no finding', () => {
  // A copy of the script with no ../bin/doflow-run beside it. Two plans, one note.
  const lib = path.join(scratch, 'no-dispatcher', 'bash');
  fs.mkdirSync(lib, { recursive: true });
  const copy = path.join(lib, 'validate-artifacts.sh');
  fs.copyFileSync(VALIDATOR, copy);
  const one = path.join(scratch, 'no-dispatcher-one');
  const two = path.join(scratch, 'no-dispatcher-two');
  fs.mkdirSync(one, { recursive: true });
  fs.mkdirSync(two, { recursive: true });
  fs.writeFileSync(path.join(one, 'plan.md'), taskPlan([]));
  fs.writeFileSync(path.join(two, 'plan.md'), taskPlan([]));
  const run = spawnSync('bash', [copy, '--json', path.join(one, 'plan.md'), path.join(two, 'plan.md')], { encoding: 'utf8' });
  assert.deepEqual(parseJson(run, 'no dispatcher'), { ok: true, findings: [] });
  assert.equal(run.status, 0);
  const notes = run.stderr.split('\n').filter((l: any) => l.startsWith('note:'));
  assert.equal(notes.length, 1, `expected exactly one note line, got: ${JSON.stringify(run.stderr)}`);
  assert.match(notes[0], /plan-check/);
});

test('task-graph: Node missing from PATH prints one note and adds no finding', (t) => {
  // A PATH holding only the tools the checker itself needs, not node, which the dispatcher needs.
  const bin = tempDir(t, 'doflow-artifact-grammar-nonode-');
  for (const tool of ['bash', 'env', 'dirname', 'basename', 'awk', 'sed', 'jq', 'cat', 'grep', 'tr', 'head', 'sort', 'uname', 'rm', 'mkdir', 'mktemp', 'sh']) {
    const found = spawnSync('bash', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    if (found) fs.symlinkSync(found, path.join(bin, tool));
  }
  const { run, result } = checkIn('task-graph-no-node', 'plan.md', taskPlan([]), {
    env: { PATH: bin, HOME: bin },
  });
  assert.deepEqual(result, { ok: true, findings: [] });
  assert.equal(run.status, 0);
  assert.equal(run.stderr.split('\n').filter((l: any) => l.startsWith('note:')).length, 1, run.stderr);
});

// ── 115 (IC-005, validate half): default targets join to feature_root, falling back to repo_root ──
// A stub resolver next to a copy of the script stands in for do-paths.sh, so the two roots can be
// told apart without a second checkout.

function stubbedValidator(name: any, resolverJson: any) {
  const lib = path.join(scratch, name, 'bash');
  fs.mkdirSync(lib, { recursive: true });
  fs.copyFileSync(VALIDATOR, path.join(lib, 'validate-artifacts.sh'));
  fs.writeFileSync(path.join(lib, 'do-paths.sh'), `#!/usr/bin/env bash\ncat <<'JSON'\n${JSON.stringify(resolverJson)}\nJSON\n`);
  return path.join(lib, 'validate-artifacts.sh');
}

const ORPHAN_DESIGN = '# Design\n\n## 1. Choices\n\n| ID | Choice | Status |\n|---|---|---|\n| D-1 | x | Live |\n\n**Detail**\n';

test('default targets resolve under feature_root, and under repo_root when the key is absent', () => {
  const here = path.join(scratch, 'fr-here');
  const main = path.join(scratch, 'fr-main');
  for (const root of [here, main]) fs.mkdirSync(path.join(root, 'f'), { recursive: true });
  fs.writeFileSync(path.join(main, 'f', 'design.md'), ORPHAN_DESIGN);

  const withKey = stubbedValidator('fr-with-key', { repo_root: here, feature_root: main, feature_slug: 's', design: 'f/design.md' });
  const viaMain = spawnSync('bash', [withKey, '--json'], { encoding: 'utf8' });
  assert.deepEqual(parseJson(viaMain, 'feature_root').findings.map((f: any) => [f.file, f.rule, f.id]),
    [[path.join(main, 'f', 'design.md'), 'parity', 'D-1']]);

  const withoutKey = stubbedValidator('fr-without-key', { repo_root: here, feature_slug: 's', design: 'f/design.md' });
  const viaHere = spawnSync('bash', [withoutKey, '--json'], { encoding: 'utf8' });
  assert.equal(parseJson(viaHere, 'repo_root fallback').note, 'no-artifacts-present');

  fs.writeFileSync(path.join(here, 'f', 'design.md'), ORPHAN_DESIGN);
  const fallback = spawnSync('bash', [withoutKey, '--json'], { encoding: 'utf8' });
  assert.deepEqual(parseJson(fallback, 'repo_root fallback').findings.map((f: any) => f.file), [path.join(here, 'f', 'design.md')]);
});
