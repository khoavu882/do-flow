'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { appendPick, appendMiss, appendOutcome, readWindow, findPick, newPickId } = require('../../src/runtime/advice/record.ts');

const REPO = path.resolve(__dirname, '../..');
const STORAGE = loadStorageRegistry({ repoRoot: REPO });
const AT: any = new Date('2026-06-01T02:00:00.000Z');
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

function fixture(t: any, global: any = false) {
  const home = tempDir(t, 'doflow-advice-home-');
  const project = tempDir(t, 'doflow-advice-project-');
  const roots = resolveRoots({
    registry: STORAGE, projectRoot: project, global,
    env: { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') },
  });
  return { roots, project };
}

function pickInput(roots: any, overrides: any = {}) {
  return {
    roots, now: NOW, kind: 'tier',
    answer: { name: 'tier', type: 'choice', pick: 'standard', strength: { word: 'clear', between: null }, probabilities: { light: 0.1, standard: 0.85, frontier: 0.05 }, confidence: 0.71 },
    question: { name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Light', standard: 'Standard', frontier: 'Frontier' } },
    staticAnswer: 'standard', provider: 'ollama', model: 'clef-flash', state: 'private decision state',
    caller: 'advise', taskId: 'task-17', durationMs: 512,
    ...overrides,
  };
}

function appendLine(root: any, date: any, value: any) {
  const file = path.join(root, 'advice', 'picks', `${date}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
  return file;
}

test('score records retain ordered criteria, argmax index and independent numeric score', (t) => {
  const { roots } = fixture(t);
  const criteria: any = ['Low', 'Medium', 'High'];
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

test('084 C-7: dispatcher fields mode and elevated and a given pick id are kept; absent ones add nothing', (t) => {
  const { roots } = fixture(t);
  const given = 'adv-1780279200000-abcdef';
  assert.equal(appendPick(pickInput(roots, { mode: 'shadow', elevated: false, pickId: given })).pickId, given);
  const generated = appendPick(pickInput(roots, { pickId: '../not-an-id' })).pickId;
  assert.match(generated, /^adv-[0-9]{13}-[0-9a-f]{6}$/);
  assert.ok(appendMiss({ roots, now: NOW, kind: 'tier', caller: 'brief-tools', reason: 'timeout', mode: 'act' }));
  const lines = readWindow({ roots, now: NOW }).records.map((entry: any) => entry.record);
  assert.equal(lines[0].pickId, given);
  assert.equal(lines[0].mode, 'shadow');
  assert.equal(lines[0].elevated, false);
  assert.equal(lines[1].pickId, generated);
  assert.equal('mode' in lines[1] || 'elevated' in lines[1], false);
  assert.deepEqual(lines[2], { schema: 1, type: 'miss', at: AT.toISOString(), kind: 'tier', caller: 'brief-tools', reason: 'timeout', model: null, durationMs: 0, mode: 'act' });
  assert.match(newPickId(Date.parse('2026-06-01T02:00:00.000Z')), /^adv-1780279200000-[0-9a-f]{6}$/);
});

// ── 141 IC-007: the extra payload ────────────────────────────────────────────────────────────────

const GIVEN_ID = 'adv-1780279200000-abcdef';

test('141 IC-007: an old-format pick line is byte-identical, with no extra, and when an extra is given to a kind that does not take it', (t) => {
  const { roots } = fixture(t);
  const digest = crypto.createHash('sha256').update('private decision state').digest('hex');
  // The literal line a pick wrote before this feature: key order, null fields and all.
  const expected = `{"schema":1,"type":"pick","pickId":"${GIVEN_ID}","at":"${AT.toISOString()}","kind":"tier","question":"tier","qtype":"choice",`
    + '"options":["light","standard","frontier"],"instructions":null,"pick":"standard","strength":"clear","between":null,'
    + '"probabilities":{"light":0.1,"standard":0.85,"frontier":0.05},"confidence":0.71,"static":"standard","provider":"ollama","model":"clef-flash",'
    + `"stateDigest":"sha256:${digest}","stateBytes":${Buffer.byteLength('private decision state')},"caller":"advise","taskId":"task-17","durationMs":512,"mode":"shadow","elevated":false}\n`;
  const plain = appendPick(pickInput(roots, { pickId: GIVEN_ID, mode: 'shadow', elevated: false }));
  assert.equal(fs.readFileSync(plain.file, 'utf8'), expected);
  fs.rmSync(plain.file);
  const rerankExtra = { rerank: { arm: 'choice', n: 2, refs: ['a', 'b'], order: ['B', 'A'] }, claimSupport: { claimId: 'c', evidenceId: 'e', relation: 'supports', claimStatus: 'supported' }, other: 'x' };
  const withExtra = appendPick(pickInput(roots, { pickId: GIVEN_ID, mode: 'shadow', elevated: false, extra: rerankExtra }));
  assert.equal(fs.readFileSync(withExtra.file, 'utf8'), expected, 'a tier pick ignores rerank, claimSupport and unknown extra keys');
  fs.rmSync(withExtra.file);
  // An old-format miss line is unchanged too.
  appendMiss({ roots, now: NOW, kind: 'tier', caller: 'brief-tools', reason: 'timeout', model: 'm', durationMs: 7, mode: 'shadow' });
  assert.equal(fs.readFileSync(path.join(roots['project-state'], 'advice', 'picks', '2026-06-01.jsonl'), 'utf8'),
    `{"schema":1,"type":"miss","at":"${AT.toISOString()}","kind":"tier","caller":"brief-tools","reason":"timeout","model":"m","durationMs":7,"mode":"shadow"}\n`);
});

function rerankInput(roots: any, arm: string, rerank: any, overrides: any = {}) {
  const ladder = arm === 'ladder';
  const criteria = ['sentinel zero', 'sentinel one', 'sentinel two', 'sentinel three', 'sentinel four'];
  return pickInput(roots, {
    kind: 'rerank', staticAnswer: 'A', state: 'query: sentinel query\ncandidate_text[A]: sentinel candidate', mode: 'shadow', elevated: false,
    question: ladder ? { name: 'rerank-a', type: 'score', instructions: 'sentinel instructions', criteria } : { name: 'rerank', type: 'choice', instructions: 'sentinel instructions', options: { A: 'sentinel candidate a', B: 'sentinel candidate b' } },
    answer: ladder
      ? { name: 'rerank-a', type: 'score', pick: criteria[4], pickIndex: 4, score: 3.2, criteria, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0.2, 4: 0.8 }, confidence: 0.8, strength: { word: 'clear', between: null } }
      : { name: 'rerank', type: 'choice', pick: 'B', probabilities: { A: 0.3, B: 0.7 }, confidence: 0.7, strength: { word: 'leaning', between: null } },
    extra: { rerank },
    ...overrides,
  });
}

const CHOICE_PAYLOAD = { arm: 'choice', n: 2, refs: ['docs/a.md', 'docs/b.md'], order: ['B', 'A'], truncated: 1, candidateBytes: 800, firstStageMs: 12, criteriaDigest: '3f9a1c0b27de', criteriaSource: 'registry' };
const LADDER_PAYLOAD = { arm: 'ladder', n: 2, refs: ['docs/a.md', 'docs/b.md'], order: ['B', 'A'], truncated: 0, candidateBytes: 800, firstStageMs: null, criteriaDigest: '3f9a1c0b27de', expected: [1.23456, 3.2], confidence: [0.5, 0.8] };

test('141 IC-007: a choice-arm rerank pick takes the rerank envelope and the allowlisted payload', (t) => {
  const { roots } = fixture(t);
  const written = appendPick(rerankInput(roots, 'choice', CHOICE_PAYLOAD));
  const line = findPick({ pickId: written.pickId, roots, now: NOW }).pick;
  assert.equal(line.question, 'rerank');
  assert.equal(line.qtype, 'choice');
  assert.deepEqual(line.options, ['A', 'B']);
  assert.equal(line.instructions, null);
  assert.equal(line.pick, 'B');
  assert.equal(line.static, 'A');
  assert.equal(line.strength, 'leaning');
  assert.deepEqual(line.probabilities, { A: 0.3, B: 0.7 });
  assert.equal(line.confidence, 0.7);
  assert.deepEqual(line.rerank, {
    arm: 'choice', n: 2, refs: ['docs/a.md', 'docs/b.md'], order: ['B', 'A'], truncated: 1, candidateBytes: 800, top1Changed: true,
    firstStageMs: 12, criteriaDigest: '3f9a1c0b27de', criteriaSource: 'registry',
  });
});

test('141 IC-007: a ladder-arm rerank pick stores 4-decimal numeric arrays and never the criteria, index or score', (t) => {
  const { roots } = fixture(t);
  const written = appendPick(rerankInput(roots, 'ladder', LADDER_PAYLOAD));
  const raw = fs.readFileSync(written.file, 'utf8');
  assert.equal(raw.includes('sentinel'), false, 'no criteria, instruction, query or candidate text on the line');
  const line = JSON.parse(raw);
  assert.equal(line.qtype, 'score');
  assert.deepEqual(line.options, ['A', 'B']);
  assert.equal(line.pick, 'B');
  assert.deepEqual([line.strength, line.between, line.probabilities, line.confidence], [null, null, null, null]);
  for (const key of ['criteria', 'pickIndex', 'score']) assert.equal(key in line, false, key);
  assert.deepEqual(line.rerank.expected, [1.2346, 3.2]);
  assert.deepEqual(line.rerank.confidence, [0.5, 0.8]);
  assert.equal(line.rerank.firstStageMs, null);
  assert.equal('criteriaSource' in line.rerank, false);
  assert.equal(line.stateBytes, Buffer.byteLength('query: sentinel query\ncandidate_text[A]: sentinel candidate'));
});

test('141 IC-007: only allowlisted keys of the rerank object are written; text-bearing keys and bad values are dropped', (t) => {
  const { roots } = fixture(t);
  const written = appendPick(rerankInput(roots, 'choice', {
    ...CHOICE_PAYLOAD, query: 'leak query', candidates: ['leak candidate'], criteria: ['leak criteria'], text: 'leak',
    criteriaDigest: 'not-a-digest', criteriaSource: 'free text', top1Changed: false,
  }));
  const raw = fs.readFileSync(written.file, 'utf8');
  assert.equal(raw.includes('leak'), false);
  const { rerank } = JSON.parse(raw);
  assert.deepEqual(Object.keys(rerank).sort(), ['arm', 'candidateBytes', 'criteriaDigest', 'firstStageMs', 'n', 'order', 'refs', 'top1Changed', 'truncated']);
  assert.equal(rerank.criteriaDigest, null, 'a digest that is not 12 hex characters is not stored');
  assert.equal(rerank.top1Changed, true, 'top1Changed is recomputed from the order, not trusted');
});

test('141 IC-007: a rerank pick with a missing or malformed payload is not written at all', (t) => {
  const { roots } = fixture(t);
  const bad: any[] = [
    undefined, null, 'text', { ...CHOICE_PAYLOAD, arm: 'both' }, { ...CHOICE_PAYLOAD, n: 0 }, { ...CHOICE_PAYLOAD, n: 17 },
    { ...CHOICE_PAYLOAD, refs: ['one'] }, { ...CHOICE_PAYLOAD, refs: ['a', 7] }, { ...CHOICE_PAYLOAD, order: ['A'] },
    { ...CHOICE_PAYLOAD, order: ['A', 'A'] }, { ...CHOICE_PAYLOAD, order: ['A', 'C'] },
  ];
  for (const rerank of bad) assert.equal(appendPick(rerankInput(roots, 'ladder', rerank)), null, JSON.stringify(rerank));
  assert.equal(appendPick(rerankInput(roots, 'ladder', LADDER_PAYLOAD, { extra: undefined })), null, 'no extra at all');
  assert.deepEqual(readWindow({ roots, now: NOW }).records, []);
});

test('141 IC-007: ladder numbers must be one finite number per candidate, else they are stored as null', (t) => {
  const { roots } = fixture(t);
  const written = appendPick(rerankInput(roots, 'ladder', { ...LADDER_PAYLOAD, expected: [1, 'x'], confidence: [0.5] }));
  const { rerank } = JSON.parse(fs.readFileSync(written.file, 'utf8'));
  assert.deepEqual([rerank.expected, rerank.confidence], [null, null]);
});

test('141 IC-007: the claimSupport object is ids, words and counts only, and only for a claim-support pick', (t) => {
  const { roots } = fixture(t);
  const yesno = {
    kind: 'claim-support', question: { name: 'claim-support', type: 'yesno', no: 'No', yes: 'Yes' }, staticAnswer: 'yes',
    answer: { name: 'claim-support', type: 'yesno', pick: 'yes', strength: { word: 'clear', between: null }, probabilities: { no: 0.1, yes: 0.9 }, confidence: null },
  };
  const written = appendPick(pickInput(roots, {
    ...yesno,
    extra: { claimSupport: { claimId: 'CLM-1', evidenceId: 'EV-2', relation: 'supports', claimStatus: 'supported', claimBytes: 120, passageBytes: 1800, truncated: false, claim: 'leak claim', passage: 'leak passage' } },
  }));
  const raw = fs.readFileSync(written.file, 'utf8');
  assert.equal(raw.includes('leak'), false);
  assert.deepEqual(JSON.parse(raw).claimSupport, { claimId: 'CLM-1', evidenceId: 'EV-2', relation: 'supports', claimStatus: 'supported', claimBytes: 120, passageBytes: 1800, truncated: false });
  const bad = appendPick(pickInput(roots, { ...yesno, extra: { claimSupport: { claimId: 'CLM-1', evidenceId: 'EV-2', relation: 'maybe', claimStatus: 'supported' } } }));
  assert.equal('claimSupport' in JSON.parse(fs.readFileSync(bad.file, 'utf8').trim().split('\n').pop()), false, 'a bad relation drops the object, the plain pick stays');
  const wrongKind = appendPick(pickInput(roots, { extra: { claimSupport: { claimId: 'CLM-1', evidenceId: 'EV-2', relation: 'supports', claimStatus: 'supported' } } }));
  assert.equal('claimSupport' in JSON.parse(fs.readFileSync(wrongKind.file, 'utf8').trim().split('\n').pop()), false);
});

// ── 151 IC-002: readWindow reports each partition and store it read ───────────────────────────────

function picksDir(root: string): string {
  return path.join(root, 'advice', 'picks');
}

function writePartition(root: string, date: string, text: string): string {
  const file = path.join(picksDir(root), `${date}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
}

/** Every entry under `dir`: relative path, kind, size, mtime and the exact bytes of each file. */
function treeSnapshot(dir: string): any[] {
  const entries: any[] = [];
  const walk = (current: string) => {
    for (const name of fs.readdirSync(current).sort()) {
      const full = path.join(current, name);
      const stat = fs.lstatSync(full);
      const rel = path.relative(dir, full);
      if (stat.isDirectory()) { entries.push({ rel, kind: 'dir', mtimeMs: stat.mtimeMs }); walk(full); }
      else entries.push({ rel, kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, bytes: fs.readFileSync(full).toString('base64') });
    }
  };
  walk(dir);
  return entries;
}

test('151 IC-002: a listed store is read, a missing directory or an unresolved root is absent', (t) => {
  const { roots } = fixture(t);
  writePartition(roots['project-state'], '2026-06-01', `${JSON.stringify({ schema: 1, type: 'miss', reason: 'timeout' })}\n`);
  const result = readWindow({ roots, now: NOW });
  assert.deepEqual(result.stores, { 'project-state': 'read', 'user-state': 'absent' });
  assert.deepEqual(result.partitions, [{ store: 'project-state', day: '2026-06-01', read: true, unreadableLines: 0 }]);
  assert.equal(result.unreadable, 0);
  assert.equal(result.records.length, 1);

  fs.mkdirSync(picksDir(roots['user-state']), { recursive: true });
  assert.deepEqual(readWindow({ roots, now: NOW }).stores, { 'project-state': 'read', 'user-state': 'read' }, 'an empty listed directory is read');

  const projectOnly = readWindow({ roots: { 'project-state': roots['project-state'] }, now: NOW });
  assert.deepEqual(projectOnly.stores, { 'project-state': 'read', 'user-state': 'absent' });
  const none = readWindow({ roots: undefined, now: NOW });
  assert.deepEqual(none, { records: [], unreadable: 0, stores: { 'project-state': 'absent', 'user-state': 'absent' }, partitions: [] });
  assert.deepEqual(readWindow({ roots, now: () => new Date('not a date') }),
    { records: [], unreadable: 0, stores: { 'project-state': 'unreadable', 'user-state': 'unreadable' }, partitions: [] },
    'with no cutoff nothing is listed, so no store claims to be read');
});

test('151 IC-002: a file where the picks directory or its parent should be makes the store absent, not unreadable', (t) => {
  const { roots } = fixture(t);
  fs.mkdirSync(path.join(roots['project-state'], 'advice'), { recursive: true });
  fs.writeFileSync(picksDir(roots['project-state']), 'not a directory');
  fs.mkdirSync(roots['user-state'], { recursive: true });
  fs.writeFileSync(path.join(roots['user-state'], 'advice'), 'not a directory');
  const result = readWindow({ roots, now: NOW });
  assert.deepEqual(result.stores, { 'project-state': 'absent', 'user-state': 'absent' });
  assert.deepEqual(result.partitions, []);
  assert.equal(result.unreadable, 0);
  assert.deepEqual(result.records, []);
});

test('151 IC-002: a directory that cannot be listed is unreadable, adds 1 to unreadable and leaves the other store read', (t) => {
  const { roots } = fixture(t);
  writePartition(roots['project-state'], '2026-06-01', `${JSON.stringify({ schema: 1, type: 'miss', reason: 'hidden' })}\n`);
  writePartition(roots['user-state'], '2026-05-31', `${JSON.stringify({ schema: 1, type: 'miss', reason: 'seen' })}\n`);
  const blocked = picksDir(roots['project-state']);
  const fsImpl = Object.create(fs);
  fsImpl.readdirSync = (directory: string, ...rest: any[]) => {
    if (directory === blocked) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    return fs.readdirSync(directory, ...rest);
  };
  const result = readWindow({ roots, now: NOW, fsImpl });
  assert.deepEqual(result.stores, { 'project-state': 'unreadable', 'user-state': 'read' });
  assert.deepEqual(result.partitions, [{ store: 'user-state', day: '2026-05-31', read: true, unreadableLines: 0 }]);
  assert.equal(result.unreadable, 1);
  assert.deepEqual(result.records.map((entry: any) => entry.record.reason), ['seen']);
});

test('151 IC-002: a partition file that cannot be read is read: false and adds 1 to unreadable', (t) => {
  const { roots } = fixture(t);
  writePartition(roots['project-state'], '2026-05-31', `${JSON.stringify({ schema: 1, type: 'miss', reason: 'ok' })}\n`);
  fs.mkdirSync(path.join(picksDir(roots['project-state']), '2026-06-01.jsonl'), { recursive: true });
  const result = readWindow({ roots, now: NOW });
  assert.deepEqual(result.stores, { 'project-state': 'read', 'user-state': 'absent' });
  assert.deepEqual(result.partitions, [
    { store: 'project-state', day: '2026-05-31', read: true, unreadableLines: 0 },
    { store: 'project-state', day: '2026-06-01', read: false, unreadableLines: 0 },
  ]);
  assert.equal(result.unreadable, 1);
  assert.equal(result.records.length, 1);
});

test('151 IC-002: a line that does not parse as an object counts in unreadable and in its partition', (t) => {
  const { roots } = fixture(t);
  const good = JSON.stringify({ schema: 1, type: 'miss', reason: 'ok' });
  writePartition(roots['project-state'], '2026-05-30', `${good}\n{not json}\n[1,2]\n\n"text"\n`);
  writePartition(roots['project-state'], '2026-05-31', `${good}\n`);
  writePartition(roots['user-state'], '2026-06-01', `null\n${good}\r\n`);
  const result = readWindow({ roots, now: NOW });
  assert.deepEqual(result.partitions, [
    { store: 'project-state', day: '2026-05-30', read: true, unreadableLines: 3 },
    { store: 'project-state', day: '2026-05-31', read: true, unreadableLines: 0 },
    { store: 'user-state', day: '2026-06-01', read: true, unreadableLines: 1 },
  ]);
  assert.equal(result.unreadable, 4);
  assert.equal(result.records.length, 3);
});

test('151 IC-002: every record carries the YYYY-MM-DD of its partition', (t) => {
  const { roots } = fixture(t);
  const line = (reason: string) => `${JSON.stringify({ schema: 1, type: 'miss', reason })}\n`;
  writePartition(roots['project-state'], '2026-05-30', line('a') + line('b'));
  writePartition(roots['project-state'], '2026-06-01', line('c'));
  writePartition(roots['user-state'], '2026-05-31', line('d'));
  const result = readWindow({ roots, now: NOW });
  assert.deepEqual(result.records.map((entry: any) => [entry.store, entry.day, entry.record.reason]), [
    ['project-state', '2026-05-30', 'a'], ['project-state', '2026-05-30', 'b'],
    ['project-state', '2026-06-01', 'c'], ['user-state', '2026-05-31', 'd'],
  ]);
  for (const entry of result.records) assert.equal(entry.day, path.basename(entry.file).slice(0, 10));
});

test('151 IC-002: a partition before the cutoff, or a file that is not a partition, is left out of partitions', (t) => {
  const { roots } = fixture(t);
  const line = `${JSON.stringify({ schema: 1, type: 'miss', reason: 'r' })}\n`;
  // NOW is 2026-06-01T02:00Z, so the 90-day cutoff is 2026-03-03.
  writePartition(roots['project-state'], '2026-03-02', `${line}{not json}\n`);
  writePartition(roots['project-state'], '2026-03-03', line);
  fs.writeFileSync(path.join(picksDir(roots['project-state']), 'notes.txt'), '{not json}\n');
  const result = readWindow({ roots, now: NOW });
  assert.deepEqual(result.partitions, [{ store: 'project-state', day: '2026-03-03', read: true, unreadableLines: 0 }]);
  assert.equal(result.unreadable, 0);
  assert.deepEqual(result.records.map((entry: any) => entry.day), ['2026-03-03']);
  assert.deepEqual(readWindow({ roots, now: NOW, maxAgeDays: 1 }).partitions, []);
});

test('151 IC-002: readWindow leaves both store trees byte for byte unchanged', (t) => {
  const { roots } = fixture(t);
  writePartition(roots['project-state'], '2026-05-31', `${JSON.stringify({ schema: 1, type: 'pick', pickId: GIVEN_ID, kind: 'tier' })}\n{not json}\n`);
  fs.mkdirSync(path.join(picksDir(roots['project-state']), '2026-06-01.jsonl'), { recursive: true });
  writePartition(roots['user-state'], '2026-01-01', '{"schema":1,"type":"miss"}\n');
  const trees = [path.dirname(roots['project-doflow']), path.dirname(roots['user-doflow'])];
  const before = trees.map(treeSnapshot);
  assert.ok(before[0].some((entry: any) => entry.rel.endsWith('2026-05-31.jsonl') && entry.size > 0), 'the snapshot sees the partition it guards');
  const result = readWindow({ roots, now: NOW });
  assert.equal(result.partitions.length, 2);
  assert.deepEqual(trees.map(treeSnapshot), before);
});
