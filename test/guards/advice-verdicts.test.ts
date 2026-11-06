'use strict';

// G32 — the shipped gate-verdict file (141 IC-004) is well formed, holds one entry per (kind, model, arm), and every number
//       in it can be re-derived: the stored `result` equals what gate-score.ts `judge` returns for the stored aggregates and
//       the registry gate bar, each `corpora` entry equals the digest recomputed from bench/advice, and every heldout case
//       carries an origin of `synthetic` or `consented`. The file ships empty (DEC-021) and an empty file passes.
// The `rerank` corpora entry points at the retrieval dev tasks, not at a bench/advice file, so only its shape is checked here.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { judge } = require('../../src/runtime/advice/gate-score.ts');
const { gateDigest } = require('../../src/runtime/advice/bench-gate.ts');
const { corpusEntry } = require('../../bench/advice-gate.ts');

const FILE = 'core/registry/advice-verdicts.json';
const RERANK = 'rerank';
const RESULTS = ['pass', 'fail', 'insufficient-data'];
const CHECKS = ['valid-share', 'quality', 'latency', 'min-cases'];
const VERDICT_KEYS = [
  'kind', 'model', 'arm', 'criteriaDigest', 'gateVersion', 'gateDigest', 'corpusVersion', 'corpusDigest', 'runAt', 'host',
  'n', 'valid', 'validShare', 'quality', 'latencyMs', 'armDelta', 'result', 'failedChecks',
];

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumber(value: any): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isInterval(value: any): boolean {
  return Array.isArray(value) && value.length === 2 && value.every(isNumber);
}

/** Origin findings for the corpus behind one kind (IC-003: only `synthetic` or `consented`). */
function checkOrigins(kind: string, corpus: any): string[] {
  const findings: string[] = [];
  for (const item of Array.isArray(corpus?.cases) ? corpus.cases : []) {
    if (!['synthetic', 'consented'].includes(item?.origin)) {
      findings.push(`bench/advice/${kind}.json:1 case '${item?.id}' origin must be synthetic or consented`);
    }
  }
  return findings;
}

function checkCorpora(file: any, corpora: any): string[] {
  const findings: string[] = [];
  if (!isObject(file.corpora)) return [`${FILE}:1 corpora must be an object`];
  for (const [kind, stored] of Object.entries(file.corpora) as any) {
    if (!isObject(stored)) { findings.push(`${FILE}:1 corpora.${kind} must be an object`); continue; }
    if (kind === RERANK) {
      if (!Number.isInteger(stored.corpusVersion) || !/^sha256:[0-9a-f]{64}$/.test(stored.digest)
        || !Number.isInteger(stored.heldoutCases) || typeof stored.snapshotId !== 'string' || stored.snapshotId === '') {
        findings.push(`${FILE}:1 corpora.rerank must hold corpusVersion, digest, heldoutCases and snapshotId`);
      }
      continue;
    }
    if (!Object.hasOwn(corpora, kind)) { findings.push(`${FILE}:1 corpora.${kind} has no corpus in bench/advice`); continue; }
    const actual = corpusEntry(corpora[kind]);
    if (stored.digest !== actual.digest || stored.corpusVersion !== actual.corpusVersion || stored.heldoutCases !== actual.heldoutCases) {
      findings.push(`${FILE}:1 corpora.${kind} is stale: stored ${stored.digest} (v${stored.corpusVersion}, ${stored.heldoutCases} cases), `
        + `recomputed ${actual.digest} (v${actual.corpusVersion}, ${actual.heldoutCases} cases)`);
    }
  }
  return findings;
}

function checkVerdict(verdict: any, label: string, { file, gate }: any): string[] {
  const findings: string[] = [];
  const bad = (message: string) => findings.push(`${FILE}:1 ${label} ${message}`);
  if (!isObject(verdict)) return [`${FILE}:1 ${label} must be an object`];
  for (const key of Object.keys(verdict)) if (!VERDICT_KEYS.includes(key)) bad(`has unexpected key '${key}' (the file holds aggregates only)`);
  if (typeof verdict.kind !== 'string' || verdict.kind === '') bad('kind must be a non-empty string');
  if (typeof verdict.model !== 'string' || verdict.model === '') bad('model must be a non-empty string');
  const isRerank = verdict.kind === RERANK;
  if (isRerank ? !['choice', 'ladder'].includes(verdict.arm) : verdict.arm !== null) {
    bad(isRerank ? "arm must be 'choice' or 'ladder' for rerank" : 'arm must be null for every kind but rerank');
  }
  if (verdict.criteriaDigest !== null && !(typeof verdict.criteriaDigest === 'string' && /^[0-9a-f]{12}$/.test(verdict.criteriaDigest))) {
    bad('criteriaDigest must be null or 12 hex characters');
  } else if (!isRerank && verdict.criteriaDigest !== null) bad('criteriaDigest must be null for every kind but rerank');
  if (!Number.isInteger(verdict.n) || !Number.isInteger(verdict.valid) || !isNumber(verdict.validShare)) bad('n, valid and validShare must be numbers');
  if (!isObject(verdict.quality) || !['accuracy', 'ndcgAt5'].includes(verdict.quality.metric) || !isInterval(verdict.quality.ci)) {
    bad('quality must hold a metric (accuracy or ndcgAt5) and a two-number ci');
  } else if (verdict.quality.metric !== (isRerank ? 'ndcgAt5' : 'accuracy')) bad('quality.metric does not match the kind');
  if (!isObject(verdict.latencyMs) || !isNumber(verdict.latencyMs.p50) || !isNumber(verdict.latencyMs.p95)) bad('latencyMs must hold p50 and p95');
  if (typeof verdict.runAt !== 'string' || Number.isNaN(Date.parse(verdict.runAt))) bad('runAt must be an ISO timestamp');
  if (!isObject(verdict.host)) bad('host must be an object');
  if (verdict.armDelta !== undefined && verdict.armDelta !== null
    && !(isRerank && isObject(verdict.armDelta) && verdict.armDelta.versus === 'choice' && isNumber(verdict.armDelta.delta) && isInterval(verdict.armDelta.ci))) {
    bad('armDelta must be null or { versus: "choice", delta, ci } on a rerank verdict');
  }
  if (!RESULTS.includes(verdict.result)) bad(`result must be one of ${RESULTS.join(', ')}`);
  if (!Array.isArray(verdict.failedChecks) || verdict.failedChecks.some((check: any) => !CHECKS.includes(check))) {
    bad(`failedChecks must draw from ${CHECKS.join(', ')}`);
  }

  if (!isObject(gate)) { bad('cannot be checked: the registry has no gate block'); return findings; }
  if (verdict.gateVersion !== gate.version || verdict.gateDigest !== gateDigest(gate)) bad('gateVersion or gateDigest differs from the registry gate bar');
  const stored = isObject(file.corpora) && Object.hasOwn(file.corpora, verdict.kind) ? file.corpora[verdict.kind] : null;
  if (!isObject(stored)) bad(`has no corpora.${verdict.kind} entry`);
  else if (verdict.corpusVersion !== stored.corpusVersion || verdict.corpusDigest !== stored.digest) bad(`corpusVersion or corpusDigest differs from corpora.${verdict.kind}`);

  if (findings.length === 0) {
    let judged: any;
    try { judged = judge(verdict, gate, verdict.kind); } catch (error: any) { bad(`cannot be re-judged (${error.message})`); return findings; }
    if (judged.result !== verdict.result) bad(`stored result '${verdict.result}' differs from recomputed '${judged.result}'`);
    else if (JSON.stringify(judged.failedChecks) !== JSON.stringify(verdict.failedChecks)) {
      bad(`stored failedChecks [${verdict.failedChecks}] differ from recomputed [${judged.failedChecks}]`);
    }
  }
  return findings;
}

/** Every finding for one verdict file text, given the registry gate bar and the bench/advice corpora by kind. */
function checkVerdictFile({ text, gate, corpora }: any): string[] {
  let file: any;
  try { file = JSON.parse(text); } catch (error: any) { return [`${FILE}:1 invalid JSON (${error.message})`]; }
  if (!isObject(file) || file.schemaVersion !== 1 || !isObject(file.corpora) || !Array.isArray(file.verdicts)) {
    return [`${FILE}:1 must be { schemaVersion: 1, corpora: {}, verdicts: [] }`];
  }
  const findings: string[] = checkCorpora(file, corpora);
  for (const kind of Object.keys(file.corpora)) if (Object.hasOwn(corpora, kind)) findings.push(...checkOrigins(kind, corpora[kind]));
  const seen = new Map<string, number>();
  file.verdicts.forEach((verdict: any, index: number) => {
    const label = `verdicts[${index}]`;
    findings.push(...checkVerdict(verdict, label, { file, gate }));
    if (!isObject(verdict)) return;
    const key = JSON.stringify([verdict.kind, verdict.model, verdict.arm ?? null]);
    if (seen.has(key)) findings.push(`${FILE}:1 ${label} duplicates verdicts[${seen.get(key)}] for (kind, model, arm) ${key}`);
    else seen.set(key, index);
  });
  return findings;
}

function readShipped() {
  const read = (rel: string) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
  const corpora: any = {};
  const dir = path.join(REPO, 'bench/advice');
  for (const name of fs.readdirSync(dir)) if (name.endsWith('.json')) corpora[name.slice(0, -5)] = read(`bench/advice/${name}`);
  return { text: fs.readFileSync(path.join(REPO, FILE), 'utf8'), gate: read('core/registry/advice.json').gate, corpora };
}

const shipped = readShipped();

// In-memory fixtures: a corpus with two heldout cases, and a verdict whose numbers judge to `pass` under the registry bar.
const fixtureCorpus = {
  schemaVersion: 2, kind: 'tier', corpusVersion: 1,
  cases: [
    { id: 'tier-001', split: 'train', state: 's1', staticPick: 'light', expected: 'light', origin: 'synthetic', note: 'n1' },
    { id: 'tier-002', split: 'heldout', state: 's2', staticPick: 'light', expected: 'standard', origin: 'synthetic', note: 'n2' },
    { id: 'tier-003', split: 'heldout', state: 's3', staticPick: 'standard', expected: 'standard', origin: 'consented', note: 'n3' },
  ],
};

function fixture(mutate?: (file: any, corpora: any) => void) {
  const corpora: any = { tier: structuredClone(fixtureCorpus) };
  const gate = shipped.gate;
  const verdict = {
    kind: 'tier', model: 'm:1', arm: null, criteriaDigest: null,
    gateVersion: gate.version, gateDigest: gateDigest(gate),
    corpusVersion: 1, corpusDigest: corpusEntry(corpora.tier).digest,
    runAt: '2026-11-06T00:00:00.000Z', host: { platform: 'darwin', arch: 'arm64' },
    n: gate.minCases, valid: gate.minCases, validShare: 1,
    quality: { metric: 'accuracy', model: 0.9, static: 0.7, delta: 0.2, ci: [0.03, 0.37], excluded: 0 },
    latencyMs: { p50: 1400, p95: 3100 },
    result: 'pass', failedChecks: [],
  };
  const file: any = { schemaVersion: 1, corpora: { tier: corpusEntry(corpora.tier) }, verdicts: [verdict] };
  if (mutate) mutate(file, corpora);
  return { text: JSON.stringify(file), gate, corpora };
}

test('G32.1: the shipped verdict file is consistent with the registry gate bar and bench/advice', () => {
  assert.deepEqual(checkVerdictFile(shipped), []);
});

test('G32.1 control: the fixture file with one passing verdict has no findings', () => {
  assert.deepEqual(checkVerdictFile(fixture()), []);
  assert.deepEqual(checkVerdictFile({ ...fixture(), text: JSON.stringify({ schemaVersion: 1, corpora: {}, verdicts: [] }) }), []);
});

test('G32.2 control: a file that is not the verdict shape is named', () => {
  const base = fixture();
  assert.ok(checkVerdictFile({ ...base, text: '{' })[0].includes('invalid JSON'));
  assert.ok(checkVerdictFile({ ...base, text: '{"schemaVersion":2,"corpora":{},"verdicts":[]}' })[0].includes('schemaVersion: 1'));
});

test('G32.2 control: a duplicate (kind, model, arm) entry fails', () => {
  const findings = checkVerdictFile(fixture((file) => file.verdicts.push(structuredClone(file.verdicts[0]))));
  assert.ok(findings.some((finding) => finding.includes('verdicts[1] duplicates verdicts[0]')));
});

test('G32.2 control: the same kind and model with another rerank arm is not a duplicate', () => {
  const findings = checkVerdictFile(fixture((file) => {
    file.corpora.rerank = { corpusVersion: 1, digest: `sha256:${'a'.repeat(64)}`, heldoutCases: 74, snapshotId: 'snap' };
    const rerank = { ...file.verdicts[0], kind: 'rerank', arm: 'choice', criteriaDigest: 'abcdef012345',
      corpusDigest: file.corpora.rerank.digest, quality: { ...file.verdicts[0].quality, metric: 'ndcgAt5' }, latencyMs: { p50: 1400, p95: 2500 } };
    file.verdicts.push(rerank, { ...rerank, arm: 'ladder' });
  }));
  assert.deepEqual(findings, []);
});

test('G32.3 control: a wrong stored result fails', () => {
  const findings = checkVerdictFile(fixture((file) => { file.verdicts[0].result = 'fail'; file.verdicts[0].failedChecks = ['quality']; }));
  assert.ok(findings.some((finding) => finding.includes("stored result 'fail' differs from recomputed 'pass'")));
  const lowerBound = checkVerdictFile(fixture((file) => { file.verdicts[0].quality.ci = [-0.1, 0.3]; }));
  assert.ok(lowerBound.some((finding) => finding.includes("differs from recomputed 'fail'")));
  const checks = checkVerdictFile(fixture((file) => { file.verdicts[0].latencyMs.p95 = 99999; file.verdicts[0].result = 'fail'; }));
  assert.ok(checks.some((finding) => finding.includes('failedChecks')));
});

test('G32.4 control: a stale corpus digest fails, in corpora and in a verdict', () => {
  const changed = fixture((file, corpora) => { corpora.tier.cases[1].expected = 'light'; });
  assert.ok(checkVerdictFile(changed).some((finding) => finding.includes('corpora.tier is stale')));
  const verdictOnly = checkVerdictFile(fixture((file) => { file.verdicts[0].corpusDigest = `sha256:${'0'.repeat(64)}`; }));
  assert.ok(verdictOnly.some((finding) => finding.includes('corpusDigest differs from corpora.tier')));
  const note = fixture((file, corpora) => { corpora.tier.cases[1].note = 'edited note'; });
  assert.deepEqual(checkVerdictFile(note), [], 'the digest ignores note');
});

test('G32.5 control: a case origin other than synthetic or consented fails', () => {
  const findings = checkVerdictFile(fixture((file, corpora) => { corpora.tier.cases[0].origin = 'recorded'; }));
  assert.ok(findings.some((finding) => finding.includes("case 'tier-001' origin must be synthetic or consented")));
});

test('G32.6 control: criteriaDigest must be null or 12 hex characters', () => {
  for (const value of ['ABCDEF012345', 'abcdef01234', 'abcdef0123456', 'sha256:abc', 7, undefined]) {
    const findings = checkVerdictFile(fixture((file) => { file.verdicts[0].criteriaDigest = value; }));
    assert.ok(findings.some((finding) => finding.includes('criteriaDigest')), `criteriaDigest ${String(value)} must fail`);
  }
  const findings = checkVerdictFile(fixture((file) => { file.verdicts[0].criteriaDigest = 'abcdef012345'; }));
  assert.ok(findings.some((finding) => finding.includes('null for every kind but rerank')));
});

test('G32.7 control: a stale gate digest, a bad arm and a per-case key fail', () => {
  assert.ok(checkVerdictFile(fixture((file) => { file.verdicts[0].gateDigest = `sha256:${'1'.repeat(64)}`; }))
    .some((finding) => finding.includes('gateDigest differs')));
  assert.ok(checkVerdictFile(fixture((file) => { file.verdicts[0].arm = 'choice'; }))
    .some((finding) => finding.includes('arm must be null')));
  assert.ok(checkVerdictFile(fixture((file) => { file.verdicts[0].cases = [{ id: 'tier-002' }]; }))
    .some((finding) => finding.includes("unexpected key 'cases'")));
});
