'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry');
const { resolveRoots } = require('../../src/runtime/storage/roots');
const { appendPick, appendMiss, appendOutcome, readWindow, findPick } = require('../../src/runtime/advice/record');

const REPO = path.resolve(__dirname, '../..');
const STORAGE = loadStorageRegistry({ repoRoot: REPO });
const AT = new Date('2026-06-01T02:00:00.000Z');
const NOW = () => new Date(AT);

for (const component of ['root', 'advice', 'picks', 'partition']) {
  test(`advisory appends refuse symlinked ${component} for pick, miss and outcome`, (t) => {
    const { roots } = fixture(t);
    const outside = tempDir(t, 'doflow-advice-outside-');
    const root = roots['project-state'];
    const link = component === 'root' ? root : component === 'partition'
      ? path.join(root, 'advice', 'picks', '2026-06-01.jsonl')
      : path.join(root, 'advice', ...(component === 'picks' ? ['picks'] : []));
    fs.mkdirSync(path.dirname(link), { recursive: true });
    const target = component === 'partition' ? path.join(outside, 'target.jsonl') : outside;
    if (component === 'partition') fs.writeFileSync(target, '');
    fs.symlinkSync(target, link);
    assert.equal(appendPick(pickInput(roots)), null);
    assert.equal(appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'timeout' }), null);
    assert.equal(appendOutcome({ roots, now: NOW, pickId: 'adv-1780279200000-abcdef', actual: 'standard', source: 'caller', store: 'project-state' }), null);
    assert.deepEqual(fs.readdirSync(outside), component === 'partition' ? ['target.jsonl'] : []);
    if (component === 'partition') assert.equal(fs.readFileSync(target, 'utf8'), '');
  });
}

function fixture(t, global = false) {
  const home = tempDir(t, 'doflow-advice-home-');
  const project = tempDir(t, 'doflow-advice-project-');
  const roots = resolveRoots({
    registry: STORAGE, projectRoot: project, global,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') },
  });
  return { roots, project };
}

function pickInput(roots, overrides = {}) {
  return {
    roots, now: NOW, kind: 'tier',
    answer: { name: 'tier', type: 'choice', pick: 'standard', strength: { word: 'clear', between: null }, probabilities: { light: 0.1, standard: 0.85, frontier: 0.05 }, confidence: 0.71 },
    question: { name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Light', standard: 'Standard', frontier: 'Frontier' } },
    staticAnswer: 'standard', provider: 'ollama', model: 'clef-flash', state: 'private decision state',
    caller: 'advise', taskId: 'task-17', durationMs: 512,
    ...overrides,
  };
}

function appendLine(root, date, value) {
  const file = path.join(root, 'advice', 'picks', `${date}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

test('score records retain ordered criteria, argmax index and independent numeric score', (t) => {
  const { roots } = fixture(t);
  const criteria = ['Low', 'Medium', 'High'];
  const written = appendPick(pickInput(roots, {
    kind: 'adhoc', staticAnswer: 'High',
    question: { name: 'impact', type: 'score', instructions: 'Assess impact.', criteria },
    answer: { name: 'impact', type: 'score', pick: 'High', pickIndex: 2, score: 1.15, criteria, probabilities: { 0: 0.25, 1: 0.35, 2: 0.4 }, confidence: 0.7, strength: { word: 'split', between: ['High', 'Medium'] } },
  }));
  const found = findPick({ pickId: written.pickId, roots, now: NOW }).pick;
  assert.equal(found.qtype, 'score');
  assert.deepEqual(found.options, criteria);
  assert.deepEqual(found.criteria, criteria);
  assert.equal(found.pickIndex, 2);
  assert.equal(found.score, 1.15);
  assert.equal(found.pick, 'High');
  assert.equal(found.static, 'High');
  assert.deepEqual(found.probabilities, { 0: 0.25, 1: 0.35, 2: 0.4 });
  assert.equal(found.confidence, 0.7);
  assert.ok(appendOutcome({ roots, now: NOW, pickId: written.pickId, actual: 'Medium', source: 'caller' }));
});

test('IC-013: pick line has the fixed fields, UTC partition, digest only and returned pick id', (t) => {
  const { roots } = fixture(t);
  const result = appendPick(pickInput(roots));
  assert.ok(result);
  assert.match(result.pickId, /^adv-[0-9]{13}-[0-9a-f]{6}$/);
  assert.equal(result.file, path.join(roots['project-state'], 'advice', 'picks', '2026-06-01.jsonl'));
  const text = fs.readFileSync(result.file, 'utf8');
  assert.equal(text.includes('private decision state'), false);
  const line = JSON.parse(text);
  assert.deepEqual(line, {
    schema: 1, type: 'pick', pickId: result.pickId, at: AT.toISOString(),
    kind: 'tier', question: 'tier', qtype: 'choice', options: ['light', 'standard', 'frontier'], instructions: null,
    pick: 'standard', strength: 'clear', between: null,
    probabilities: { light: 0.1, standard: 0.85, frontier: 0.05 }, confidence: 0.71,
    static: 'standard', provider: 'ollama', model: 'clef-flash',
    stateDigest: `sha256:${crypto.createHash('sha256').update('private decision state').digest('hex')}`,
    stateBytes: Buffer.byteLength('private decision state'), caller: 'advise', taskId: 'task-17', durationMs: 512,
  });
});

test('IC-013: adhoc instructions alone are kept and are cut to 500 characters', (t) => {
  const { roots } = fixture(t);
  const result = appendPick(pickInput(roots, {
    kind: 'adhoc',
    question: { name: 'choice', type: 'choice', instructions: 'x'.repeat(600), options: { a: 'A', b: 'B' } },
    answer: { name: 'choice', type: 'choice', pick: 'a', strength: { word: 'leaning', between: null }, probabilities: { a: 0.7, b: 0.3 }, confidence: 0.5 },
  }));
  const line = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.equal(line.instructions.length, 500);
  assert.equal(line.instructions, 'x'.repeat(500));
  assert.deepEqual(line.options, ['a', 'b']);
});

test('IC-013: yesno pick options use no/yes order and null confidence', (t) => {
  const { roots } = fixture(t);
  const result = appendPick(pickInput(roots, {
    kind: 'mcp-need', question: { name: 'mcp-need', type: 'yesno', no: 'No', yes: 'Yes' },
    answer: { name: 'mcp-need', type: 'yesno', pick: 'yes', strength: { word: 'split', between: ['yes', 'no'] }, probabilities: { no: 0.3, yes: 0.7 }, confidence: null },
  }));
  const line = JSON.parse(fs.readFileSync(result.file, 'utf8'));
  assert.deepEqual(line.options, ['no', 'yes']);
  assert.equal(line.confidence, null);
});

test('IC-013: miss and outcome lines match their fixed shapes', (t) => {
  const { roots } = fixture(t);
  const miss = appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'unreachable', model: 'clef-flash', durationMs: 100 });
  const outcome = appendOutcome({ roots, now: NOW, pickId: 'adv-1780279200000-abcdef', actual: 'standard', source: 'caller' });
  assert.ok(miss);
  assert.ok(outcome);
  const lines = fs.readFileSync(miss.file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines, [
    { schema: 1, type: 'miss', at: AT.toISOString(), kind: 'tier', caller: 'advise', reason: 'unreachable', model: 'clef-flash', durationMs: 100 },
    { schema: 1, type: 'outcome', pickId: 'adv-1780279200000-abcdef', at: AT.toISOString(), actual: 'standard', source: 'caller' },
  ]);
});

test('IC-013: project store is selected when present and user store otherwise', (t) => {
  const project = fixture(t);
  const fromProject = appendMiss({ roots: project.roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'unreachable' });
  assert.ok(fromProject.file.startsWith(project.roots['project-state']));
  const user = fixture(t, true);
  const fromUser = appendMiss({ roots: user.roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'unreachable' });
  assert.ok(fromUser.file.startsWith(user.roots['user-state']));
});

test('IC-013: partition date comes from the UTC date of at', (t) => {
  const { roots } = fixture(t);
  const result = appendMiss({ roots, now: () => new Date('2026-06-01T00:30:00+02:00'), kind: 'tier', caller: 'advise', reason: 'timeout' });
  assert.ok(result.file.endsWith('2026-05-31.jsonl'));
});

test('IC-013: failed writes return null without throwing', (t) => {
  const { roots } = fixture(t);
  const fsImpl = Object.create(fs);
  fsImpl.appendFileSync = () => { throw new Error('disk full'); };
  assert.doesNotThrow(() => assert.equal(appendMiss({ roots, now: NOW, kind: 'tier', caller: 'advise', reason: 'timeout', fsImpl }), null));
});

test('IC-013: retained window skips malformed lines and counts them', (t) => {
  const { roots } = fixture(t);
  appendLine(roots['project-state'], '2026-06-01', { schema: 1, type: 'miss', reason: 'timeout' });
  const unreadable = path.join(roots['project-state'], 'advice', 'picks', '2026-06-01.jsonl');
  fs.appendFileSync(unreadable, '{not json}\n\n');
  appendLine(roots['user-state'], '2000-01-01', { schema: 1, type: 'miss', reason: 'old' });
  const result = readWindow({ roots, now: NOW });
  assert.equal(result.records.length, 1);
  assert.equal(result.unreadable, 1);
  assert.equal(result.records[0].record.reason, 'timeout');
  assert.equal(result.records[0].store, 'project-state');
});

test('IC-009: pick lookup searches project before user and returns its store', (t) => {
  const { roots } = fixture(t);
  const pickId = 'adv-1780279200000-abcdef';
  const projectFile = appendLine(roots['project-state'], '2026-06-01', { schema: 1, type: 'pick', pickId, kind: 'tier' });
  appendLine(roots['user-state'], '2026-06-01', { schema: 1, type: 'pick', pickId, kind: 'task-class' });
  const project = findPick({ pickId, roots, now: NOW });
  assert.equal(project.store, 'project-state');
  assert.equal(project.file, projectFile);
  assert.equal(project.pick.kind, 'tier');

  const userOnlyId = 'adv-1780279200001-abcdef';
  const userFile = appendLine(roots['user-state'], '2026-06-01', { schema: 1, type: 'pick', pickId: userOnlyId, kind: 'task-class' });
  const user = findPick({ pickId: userOnlyId, roots, now: NOW });
  assert.equal(user.store, 'user-state');
  assert.equal(user.file, userFile);
  assert.equal(user.pick.kind, 'task-class');
  assert.equal(findPick({ pickId: 'adv-1780279200002-abcdef', roots, now: NOW }), null);
});
