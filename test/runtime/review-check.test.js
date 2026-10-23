'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { countFindings } = require('../../src/runtime/review/findings.ts');
const { handleReviewCommand } = require('../../src/runtime/review/command.ts');
const { createSettingsEnv } = require('../helper/settings-fixtures');
const { derivedVocabularies } = require('../../src/runtime/trace/telemetry.ts');

const REPO = path.resolve(__dirname, '../..');
const SECRET = 'SECRET-095-PLANT';
const HEAD_A = '0123456789abcdef0123456789abcdef01234567';
const HEAD_B = 'fedcba9876543210fedcba9876543210fedcba98';

function validRecord() {
  return {
    schema: 1,
    row: '095',
    slug: '095-review-convergence',
    reviewedHead: HEAD_B,
    rounds: 2,
    seats: [
      { id: 'seat-a', findings: [{ id: 'source-a', severity: 'should-fix', locator: 'src/a.ts:4', summary: 'Type narrowing' }] },
      { id: 'seat-b', findings: [] },
    ],
    converged: [
      { id: 'finding-a', from: ['source-a'], severity: 'should-fix', locator: 'src/a.ts:4', status: 'open' },
    ],
  };
}

function fakeWriter() {
  const records = [];
  return { records, writer: { write: (batch) => records.push(...batch) } };
}

function invoke(options) {
  const lines = [];
  const exitCode = handleReviewCommand({ ...options, out: (line) => lines.push(line) });
  process.exitCode = 0;
  return { exitCode, lines };
}

function writeRecord(root, record, relativePath = 'feature/review/findings.json') {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record)}\n`, 'utf8');
  return file;
}

function baseOptions(cwd, recordPath, writer) {
  return {
    action: 'check',
    path: recordPath,
    cwd,
    env: {},
    git: () => ({ status: 0 }),
    writer,
    resolve: () => ({ error: 'unexpected-resolve', message: 'path locator should not resolve a feature' }),
  };
}

function parseJsonOutput(lines) {
  assert.equal(lines.length, 1, 'JSON result is exactly one output line');
  return JSON.parse(lines[0]);
}

test('valid review check exits zero and reports the shared finding counts', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-valid-');
  const record = validRecord();
  const file = writeRecord(cwd, record);
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(body, {
    schema: 1,
    path: file,
    valid: true,
    errors: [],
    advisories: [],
    counts: countFindings(record),
  });
  assert.equal(capture.records.length, 1);
  assert.equal(capture.records[0].kind, 'review.run');
});

test('invalid review check exits one with validation errors and null counts', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-invalid-');
  const record = validRecord();
  record.slug = 'not-the-row-slug';
  const file = writeRecord(cwd, record);
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 1);
  assert.equal(body.valid, false);
  assert.deepEqual(body.errors, ['slug']);
  assert.deepEqual(body.advisories, []);
  assert.equal(body.counts, null);
  assert.equal(capture.records.length, 1);
  assert.equal(capture.records[0].task, null, 'an unchecked slug never reaches telemetry');
  for (const key of Object.keys(countFindings(validRecord())).filter((name) => name !== 'task')) {
    assert.equal(capture.records[0][key], null, `${key} is null for an invalid record`);
  }
  assert.equal(capture.records[0].errors, 1);
});

test('text output prints its summary followed by one counts line for a valid record', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-text-');
  const record = validRecord();
  const file = writeRecord(cwd, record);
  const capture = fakeWriter();
  const result = invoke(baseOptions(cwd, file, capture.writer));

  assert.equal(result.exitCode, 0);
  assert.equal(result.lines[0], 'review check: valid (0 errors, 0 advisories)');
  assert.equal(result.lines[1], Object.entries(countFindings(record)).map(([key, value]) => `${key}=${value}`).join(' '));
  assert.equal(result.lines.length, 2);
});

test('missing findings file exits one and writes missing telemetry', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-missing-');
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, path.join(cwd, 'absent.json'), capture.writer), json: true });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(body.errors, ['missing']);
  assert.equal(body.counts, null);
  assert.equal(capture.records.length, 1);
  assert.equal(capture.records[0].task, null);
  assert.equal(capture.records[0].errors, 1);
});

test('bad JSON exits one with the validator json error', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-json-');
  const file = path.join(cwd, 'findings.json');
  fs.writeFileSync(file, '{', 'utf8');
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(body.errors, ['json']);
  assert.equal(body.counts, null);
  assert.equal(capture.records.length, 1);
  assert.equal(capture.records[0].task, null);
});

test('unreadable findings path exits one with unreadable error', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-unreadable-');
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, cwd, capture.writer), json: true });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(body.errors, ['unreadable']);
  assert.equal(body.counts, null);
  assert.equal(capture.records.length, 1);
});

test('usage errors reject both locators, missing or unknown action, and empty values without telemetry', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-usage-');
  const capture = fakeWriter();
  const common = { cwd, env: {}, writer: capture.writer, resolve: () => ({}) };

  assert.equal(invoke({ ...common, action: 'check', slug: '095-review-convergence', path: 'findings.json' }).exitCode, 2);
  assert.equal(invoke({ ...common, action: 'nope' }).exitCode, 2);
  assert.equal(invoke({ ...common }).exitCode, 2);
  assert.equal(invoke({ ...common, action: 'check', path: '' }).exitCode, 2);
  assert.equal(invoke({ ...common, action: 'check', slug: '   ' }).exitCode, 2);
  assert.deepEqual(capture.records, []);
});

test('pre-existing commit must be an ancestor of the reviewed head', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-non-ancestor-');
  const record = validRecord();
  record.converged[0].origin = 'pre-existing';
  record.converged[0].preExistingAt = HEAD_A;
  const file = writeRecord(cwd, record);
  const capture = fakeWriter();
  let gitCall;
  const result = invoke({
    ...baseOptions(cwd, file, capture.writer),
    json: true,
    git: (args, gitCwd) => { gitCall = { args, cwd: gitCwd }; return { status: 1 }; },
  });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(gitCall, { args: ['merge-base', '--is-ancestor', HEAD_A, HEAD_B], cwd: path.dirname(file) });
  assert.deepEqual(body.errors, ['preExistingAt-not-ancestor:finding-a']);
  assert.equal(body.counts, null);
  assert.equal(body.counts, null);
});

test('git status 128 is an ancestry advisory and does not invalidate the record', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-git-unavailable-');
  const record = validRecord();
  record.rounds = 3;
  record.converged[0].severity = 'blocker';
  record.converged[0].origin = 'pre-existing';
  record.converged[0].preExistingAt = HEAD_A;
  const file = writeRecord(cwd, record);
  const capture = fakeWriter();
  const result = invoke({
    ...baseOptions(cwd, file, capture.writer),
    json: true,
    git: () => ({ status: 128 }),
  });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(body.errors, []);
  assert.deepEqual(body.advisories, [
    'ancestry-unchecked:finding-a',
    'round-cap:3',
    'unverified-blocker:finding-a',
  ]);
  assert.deepEqual(body.counts, countFindings(record));
});

test('round-cap review advisory preserves a successful exit', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-round-cap-');
  const record = validRecord();
  record.rounds = 3;
  const file = writeRecord(cwd, record);
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(body.errors, []);
  assert.deepEqual(body.advisories, ['round-cap:3']);
});

test('slug locator uses the injected resolver and reads its feature review record', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-slug-');
  const featureFolder = path.join(cwd, 'agent-docs', 'doflow', '095-review-convergence');
  const record = validRecord();
  const file = writeRecord(cwd, record, 'agent-docs/doflow/095-review-convergence/review/findings.json');
  const capture = fakeWriter();
  let resolution;
  const result = invoke({
    action: 'check',
    slug: '095-review-convergence',
    cwd,
    env: {},
    git: () => ({ status: 0 }),
    writer: capture.writer,
    resolve: (options) => { resolution = options; return { featureFolder }; },
    json: true,
  });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 0);
  assert.deepEqual(resolution, { projectRoot: cwd, slug: '095-review-convergence' });
  assert.equal(body.path, file);
});

test('resolver error reports missing and explains the reason in text output', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-resolve-error-');
  const capture = fakeWriter();
  const result = invoke({
    action: 'check',
    slug: '095-review-convergence',
    cwd,
    env: {},
    writer: capture.writer,
    resolve: () => ({ error: 'no-active-feature', message: 'branch has no active feature' }),
  });

  assert.equal(result.exitCode, 1);
  assert.match(result.lines[0], /^review check: invalid \(1 errors, 0 advisories\)$/);
  assert.equal(result.lines[1], 'error: missing: branch has no active feature');
  assert.equal(capture.records.length, 1);
});

test('each check writes one review.run record using only declared review fields', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-telemetry-');
  const record = validRecord();
  const file = writeRecord(cwd, record);
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });
  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/telemetry.json'), 'utf8'));
  const declared = new Set(['kind', ...Object.keys(registry.kinds['review.run'].fields)]);

  assert.equal(result.exitCode, 0);
  assert.equal(capture.records.length, 1);
  assert.equal(capture.records[0].kind, 'review.run');
  assert.ok(Object.keys(capture.records[0]).every((key) => declared.has(key)), 'telemetry record has no undeclared keys');
  assert.equal(capture.records[0].errors, 0);
  assert.equal(capture.records[0].advisories, 0);
});

test('privacy: telemetry omits planted review content and the record path', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-secret-');
  const record = validRecord();
  record.seats[0].id = `${SECRET}-seat`;
  record.seats[0].findings[0].id = `${SECRET}-source`;
  record.seats[0].findings[0].locator = `${SECRET}/seat.ts:1`;
  record.seats[0].findings[0].summary = `${SECRET} summary text`;
  record.converged[0] = {
    id: `${SECRET}-converged`,
    from: [`${SECRET}-source`],
    severity: 'should-fix',
    locator: `${SECRET}/converged.ts:2`,
    status: 'open',
    bugClass: `${SECRET} bug class`,
    sweep: `${SECRET} sweep command`,
  };
  const file = writeRecord(cwd, record, `${SECRET}/review/findings.json`);
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });

  assert.equal(result.exitCode, 0);
  assert.equal(capture.records.length, 1);
  assert.equal(JSON.stringify(capture.records[0]).includes(SECRET), false);
});

test('C-1: an invalid record whose slug is a sha, a seat id or a canary persists task null and no slug text', (t) => {
  const project = tempDir(t, 'doflow-review-check-invalid-slug-');
  const runs = path.join(project, '.doflow', 'state', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const sha = '58c6e191aa00bb11cc22dd33ee44ff5566778899';
  const seatId = `seat-${SECRET}-name`;
  const slugs = [sha, seatId, `${SECRET}-slug`];
  for (const slug of slugs) {
    const record = validRecord();
    record.seats[0].id = seatId;
    record.slug = slug;
    const file = writeRecord(project, record, `checks/${slugs.indexOf(slug)}/findings.json`);
    const result = invoke({ action: 'check', path: file, cwd: project, env: {}, git: () => ({ status: 0 }), json: true });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(parseJsonOutput(result.lines).errors, ['slug']);
  }

  const telemetryDir = path.join(runs, 'telemetry');
  const files = fs.readdirSync(telemetryDir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const text = fs.readFileSync(path.join(telemetryDir, files[0]), 'utf8');
  const lines = text.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, slugs.length);
  assert.ok(lines.every((line) => line.kind === 'review.run' && line.task === null), 'every invalid check persists task null');
  assert.equal(text.includes(sha), false, 'the sha slug is absent');
  assert.equal(text.includes(SECRET), false, 'the seat id and canary slugs are absent');
});

test('end-to-end: real telemetry writer and git verify ancestry and omit planted content', (t) => {
  const project = tempDir(t, 'doflow-review-check-e2e-');
  const runs = path.join(project, '.doflow', 'state', 'runs');
  fs.mkdirSync(runs, { recursive: true });

  const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (args, cwd) => spawnSync('git', args, { cwd, env: gitEnv, stdio: 'ignore' });
  assert.equal(git(['init', '-q'], project).status, 0);
  fs.writeFileSync(path.join(project, 'tracked.txt'), 'first\n', 'utf8');
  assert.equal(git(['add', 'tracked.txt'], project).status, 0);
  assert.equal(git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'first'], project).status, 0);
  const first = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, env: gitEnv, encoding: 'utf8' }).stdout.trim();

  fs.writeFileSync(path.join(project, 'tracked.txt'), 'second\n', 'utf8');
  assert.equal(git(['add', 'tracked.txt'], project).status, 0);
  assert.equal(git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'second'], project).status, 0);
  const second = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: project, env: gitEnv, encoding: 'utf8' }).stdout.trim();

  const record = validRecord();
  record.reviewedHead = second;
  record.seats[0].id = `${SECRET}-seat`;
  record.seats[0].findings[0].id = `${SECRET}-source`;
  record.seats[0].findings[0].locator = `${SECRET}/seat.ts:1`;
  record.seats[0].findings[0].summary = `${SECRET} summary text`;
  record.converged[0] = {
    id: `${SECRET}-converged`,
    from: [`${SECRET}-source`],
    severity: 'blocker',
    locator: `${SECRET}/converged.ts:2`,
    status: 'open',
    origin: 'pre-existing',
    preExistingAt: first,
    escapedFrom: '094',
    bugClass: `${SECRET} bug class`,
    sweep: `${SECRET} sweep command`,
  };
  const recordPath = writeRecord(project, record, `feature-${SECRET}/review/findings.json`);
  const options = { action: 'check', path: recordPath, cwd: project, env: {}, git, json: true };

  const valid = invoke(options);
  assert.equal(valid.exitCode, 0);
  assert.deepEqual(parseJsonOutput(valid.lines).errors, []);

  record.reviewedHead = first;
  record.converged[0].preExistingAt = second;
  fs.writeFileSync(recordPath, JSON.stringify(record), 'utf8');
  const swapped = invoke(options);
  assert.equal(swapped.exitCode, 1);
  assert.deepEqual(parseJsonOutput(swapped.lines).errors, [`preExistingAt-not-ancestor:${SECRET}-converged`]);

  const telemetryDir = path.join(runs, 'telemetry');
  const files = fs.readdirSync(telemetryDir).filter((name) => name.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const lines = fs.readFileSync(path.join(telemetryDir, files[0]), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 2);
  assert.deepEqual(lines.map((line) => line.kind), ['review.run', 'review.run']);
  assert.ok(lines.every((line) => !JSON.stringify(line).includes(SECRET)), 'real telemetry lines omit planted content and path');
  assert.equal(lines[0].errors, 0);
  assert.equal(lines[1].errors, 1);
});


test('095b IC-005/IC-006: depth deep with one seat gives depth-unmet:deep, exit 0, and the telemetry carries depth, risk and head', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-depth-');
  const record = { ...validRecord(), depth: 'deep', risk: 'HIGH' };
  record.seats = record.seats.slice(0, 1);
  const file = writeRecord(cwd, record);
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 0);
  assert.equal(body.valid, true);
  assert.deepEqual(body.advisories, ['depth-unmet:deep']);
  assert.equal(capture.records.length, 1);
  assert.equal(capture.records[0].depth, 'deep');
  assert.equal(capture.records[0].risk, 'HIGH');
  assert.equal(capture.records[0].head, HEAD_B);
  assert.equal(capture.records[0].advisories, 1);
});

test('095b IC-006: a valid record without depth and risk writes null for them and its head', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-nodepth-');
  const file = writeRecord(cwd, validRecord());
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });

  assert.equal(result.exitCode, 0);
  assert.equal(capture.records[0].depth, null);
  assert.equal(capture.records[0].risk, null);
  assert.equal(capture.records[0].head, HEAD_B);
});

test('095b IC-006: an invalid record (bad depth) writes null for depth, risk and head, exit 1', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-baddepth-');
  const file = writeRecord(cwd, { ...validRecord(), depth: 'shallow', risk: 'HIGH' });
  const capture = fakeWriter();
  const result = invoke({ ...baseOptions(cwd, file, capture.writer), json: true });
  const body = parseJsonOutput(result.lines);

  assert.equal(result.exitCode, 1);
  assert.deepEqual(body.errors, ['depth']);
  assert.equal(capture.records[0].depth, null);
  assert.equal(capture.records[0].risk, null);
  assert.equal(capture.records[0].head, null);
});

test('119 IC-002: a valid record with protocol writes the preset id; without protocol or when invalid it writes null', (t) => {
  const cwd = tempDir(t, 'doflow-review-check-protocol-');
  const protocol = { id: 'review-deep', digest: 'a'.repeat(64) };
  const run = (record, name) => {
    const capture = fakeWriter();
    const result = invoke({ ...baseOptions(cwd, writeRecord(cwd, record, name), capture.writer), json: true });
    return { result, telemetry: capture.records[0] };
  };

  const withProtocol = run({ ...validRecord(), protocol }, 'with/review/findings.json');
  assert.equal(withProtocol.result.exitCode, 0);
  assert.equal(withProtocol.telemetry.protocol, 'review-deep');

  const without = run(validRecord(), 'without/review/findings.json');
  assert.equal(without.result.exitCode, 0);
  assert.equal(without.telemetry.protocol, null);

  const invalid = run({ ...validRecord(), protocol: { ...protocol, id: 'debate-2' } }, 'invalid/review/findings.json');
  assert.equal(invalid.result.exitCode, 1);
  assert.deepEqual(parseJsonOutput(invalid.result.lines).errors, ['protocol']);
  assert.equal(invalid.telemetry.protocol, null);
});

test('095b IC-006: the telemetry registry declares depth, risk and head; the depth vocabulary is derived from protocols.json (C-9)', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/telemetry.json'), 'utf8'));
  const fields = registry.kinds['review.run'].fields;
  assert.deepEqual(fields.depth, { name: 'doflow.review.run.depth', class: 'T2', type: 'enum:depth|null', phase: 'P7' });
  assert.deepEqual(fields.risk, { name: 'doflow.review.run.risk', class: 'T2', type: 'enum:risk|null', phase: 'P7' });
  assert.deepEqual(fields.head, { name: 'doflow.review.run.head', class: 'T0', type: 'token|null', phase: 'P7' });
  assert.equal(Object.hasOwn(registry.vocabularies, 'depth'), false, 'telemetry.json holds no copy');
  assert.deepEqual(derivedVocabularies().depth, ['single', 'deep']);
});

test('C-6: a malformed or invalid project review.sameFamily is an unreadable setting: check errors (exit 1), never the advisory', (t) => {
  const f = createSettingsEnv(t, { prefix: 'doflow-review-check-settings-' });
  const record = { ...validRecord(), author: { agent: 'core-implementer', session: 's1', family: 'claude' } };
  record.seats[0] = { ...record.seats[0], agent: 'reviewer', session: 's2', family: 'gpt' };
  record.seats[1] = { ...record.seats[1], agent: 'reviewer', session: 's3', family: 'gpt' };
  const file = writeRecord(f.project, record);
  const check = () => {
    const result = invoke({ ...baseOptions(f.project, file, fakeWriter().writer), env: f.env(), json: true });
    return { exitCode: result.exitCode, body: parseJsonOutput(result.lines) };
  };
  assert.equal(check().exitCode, 0, 'no settings file: valid');
  for (const text of ['{ "schema": 1, "review.sameFamily": "refuse", }', '{ "schema": 1, "review.sameFamily": "strict" }']) {
    fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), text);
    const { exitCode, body } = check();
    assert.equal(exitCode, 1, text);
    assert.equal(body.valid, false);
    assert.deepEqual(body.errors, ['same-family-setting-unread'], text);
    assert.ok(!body.advisories.includes('same-family-setting-unread'));
  }
  fs.writeFileSync(path.join(f.project, '.doflow', 'settings.json'), '{ "schema": 1, "review.sameFamily": "warn" }');
  assert.equal(check().exitCode, 0, 'a readable file is fine again');
});
