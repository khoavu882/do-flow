'use strict';

// 175 T6 (IC-005, IC-008): `doflow advise --action replay`, through the real CLI, against an in-process fake decision
// server and a claim ledger written into a scratch project. HOME and XDG_CONFIG_HOME are scratch folders, so the real
// ~/.doflow is never read or written, and no test reaches a model. Every claim and passage carries SENTINEL, so a test
// can prove no case text reaches stdout, stderr or a file.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createScratch, childEnv } = require('../../../helper/scratch-env.ts');
const { startFakeServer, closedEndpoint, tagsListing, answering } = require('../../../helper/fake-decision-server.ts');
const { loadStorageRegistry } = require('../../../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../../../src/runtime/storage/roots.ts');
const { appendPick, appendOutcome } = require('../../../../src/runtime/advice/record.ts');
const { captureState, resetCaptureSetting } = require('../../../../src/runtime/advice/state-text.ts');
const { REPO_ROOT } = require('../../../../src/helper/repo-root.ts');
const { renderText } = require('../../../../src/runtime/advice/replay/run.ts');

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const SENTINEL = 'SENTINEL-c4f1e2';
const KIND = 'claim-support';

const roundUp64 = (n: number) => Math.ceil(n / 64) * 64;
/** The --json body of the 200-case fixture measured 2242 bytes with the confusion figure (1999 before 177 T5); the ceiling is roundUp64(measured + 512). */
const JSON_CEILING = roundUp64(2242 + 512);

function writeJson(file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** The first 16 hex of sha256(task \n claim \n evidence): the claim-ledger case id. */
const caseId = (task: string, claim: string, evidence: string) => crypto.createHash('sha256').update(`${task}\n${claim}\n${evidence}`).digest('hex').slice(0, 16);

/**
 * One claim and one evidence item per spec in `<project>/.doflow/state/evidence/<feature>/<task>`. `relation` is the
 * recorded link (the label and the rule); `answer` is the yes probability the fake server replies with for that case.
 */
function writeLedger(project: string, specs: Array<{ relation: 'supports' | 'contradicts'; answer: number }>, { task = 'T1', feature = 'feature-r' } = {}) {
  const dir = path.join(project, '.doflow', 'state', 'evidence', feature);
  const at = '2026-11-01T10:00:00.000Z';
  const claims = specs.map((spec, i) => ({
    id: `claim_${i}`, taskId: task, statement: `${SENTINEL} claim ${i} of ${task}`, role: null,
    status: spec.relation === 'supports' ? 'supported' : 'contradicted',
    supportingEvidence: spec.relation === 'supports' ? [`ev_${i}`] : [],
    contradictingEvidence: spec.relation === 'contradicts' ? [`ev_${i}`] : [],
    createdAt: at, updatedAt: at,
  }));
  const evidence = specs.map((spec, i) => ({
    id: `ev_${i}`, taskId: task, kind: 'generated-analysis',
    source: { provider: 'general-task-execution', capability: 'coverage-reverify' }, locator: {}, provenance: 'inferred',
    content: `${SENTINEL} passage ${i} answer=${spec.answer}`,
    freshness: { gitCommit: null, fileHash: null, observedAt: at, status: 'FRESH' },
    establishes: [], observation: null,
    supports: spec.relation === 'supports' ? [`claim_${i}`] : [],
    contradicts: spec.relation === 'contradicts' ? [`claim_${i}`] : [],
    status: 'active', supersededBy: null,
  }));
  writeJson(path.join(dir, `${task}_claims.json`), { taskId: task, updatedAt: at, claimsCount: claims.length, claims, version: 1, revision: 1 });
  writeJson(path.join(dir, `${task}.json`), { taskId: task, updatedAt: at, evidenceCount: evidence.length, evidence, version: 1, revision: 1 });
  return specs.map((_spec, i) => caseId(task, `claim_${i}`, `ev_${i}`));
}

/**
 * 40 cases: 30 recorded `supports`, 10 `contradicts` (every fourth). The model agrees except on two supports cases it
 * answers no (worse than the rule) and one it splits on (a no-answer that falls back to the rule).
 */
function mainSpecs(count = 40) {
  return Array.from({ length: count }, (_v, i) => {
    const relation: 'supports' | 'contradicts' = i % 4 === 0 ? 'contradicts' : 'supports';
    let answer = relation === 'supports' ? 0.9 : 0.1;
    if (i === 1 || i === 5) answer = 0.1;
    if (i === 2) answer = 0.5;
    return { relation, answer };
  });
}

/** Every file under `dir` with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/**
 * A scratch HOME and project, the decision model on at user level, and a fake server that answers each yes/no question
 * with the `answer=` probability of its passage, after `delayMs`, counting the requests in flight.
 */
async function fixture(t: any, { settings = {}, tags = null, delayMs = 2, route = null }: any = {}) {
  const scratch = createScratch('doflow-advice-replay-');
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const seen: any = { inFlight: 0, maxInFlight: 0, asks: [] as any[] };
  const server = await startFakeServer({ routes: {
    'POST /v1/systemone': async ({ body }: any) => {
      if (route) { seen.asks.push(body); return route({ body }); }
      seen.inFlight++;
      seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
      seen.asks.push(body);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      seen.inFlight--;
      const p = Number(/answer=([0-9.]+)/.exec(body?.state || '')?.[1] ?? 0.7);
      return { status: 200, body: { answers: Object.fromEntries(Object.keys(body?.questions || {}).map((name) => [name, { noul: p }])) } };
    },
    ...(tags ? { 'GET /api/tags': { status: 200, body: tags } } : {}),
  } });
  t.after(async () => { await server.close(); scratch.remove(); });
  const userSettingsFile = path.join(scratch.xdg, 'doflow', 'settings.json');
  writeJson(userSettingsFile, {
    schema: 1, 'storage.prune': 'off', 'advice.enabled': true, 'advice.provider': 'ollama',
    'advice.endpoint': server.origin, 'advice.model': 'clef-flash', ...settings,
  });
  const resultsFile = path.join(scratch.home, '.doflow', 'state', 'advice', 'results.json');
  return {
    scratch, project, server, seen, userSettingsFile, resultsFile,
    /** The replay verb with `args`, stdin a pipe (no terminal), CI and the session role cleared unless `env` sets them. */
    run: (args: string[], env: any = {}) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [BIN, 'advise', '--action', 'replay', ...args], {
        cwd: project,
        env: childEnv(scratch, { CI: null, DOFLOW_SESSION_ROLE: null, DOFLOW_AUTOPILOT_ENABLED: null, ...env }),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk: any) => { stdout += chunk; });
      child.stderr.on('data', (chunk: any) => { stderr += chunk; });
      child.stdin.end();
      child.on('close', (status: number) => resolve({ status, stdout, stderr }));
    }),
  };
}

const asked = (f: any) => f.seen.asks.length;

function assertNoCaseText(f: any, ...outputs: string[]) {
  for (const text of outputs) {
    assert.ok(!text.includes(SENTINEL), `case text leaked: ${text}`);
    assert.doesNotMatch(text, /passage \d|claim \d/);
  }
  for (const [file, bytes] of Object.entries(snapshot(f.scratch.dir))) {
    if (file.startsWith(`project${path.sep}.doflow${path.sep}state${path.sep}evidence`)) continue;
    assert.ok(!bytes.includes(SENTINEL), `case text reached ${file}`);
  }
}

test('(a) every figure of design section 5 is in the --json body and the text form', async (t) => {
  const f = await fixture(t);
  writeLedger(f.project, mainSpecs());
  const json = await f.run(['--kind', KIND, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(body), ['schema', 'kind', 'provider', 'model', 'modelDigest', 'source', 'caseSet', 'metrics', 'standing', 'failedChecks', 'worseIds', 'confusion', 'stored', 'written', 'refused', 'replaced']);
  assert.equal(body.schema, 1);
  assert.equal(body.kind, KIND);
  assert.equal(body.provider, 'ollama');
  assert.equal(body.model, 'clef-flash');
  assert.match(body.modelDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(body.source, 'claim-ledger');
  assert.deepEqual(Object.keys(body.caseSet), ['eligible', 'replayed', 'digest', 'skipped']);
  assert.equal(body.caseSet.eligible, 40);
  assert.equal(body.caseSet.replayed, 40);
  assert.match(body.caseSet.digest, /^sha256:[0-9a-f]{64}$/);
  const m = body.metrics;
  assert.equal(m.n, 40);
  assert.deepEqual(m.labelCounts, { yes: 30, no: 10 });
  assert.equal(m.minority, 10);
  assert.equal(m.valid, 40);
  assert.equal(m.validShare, 1);
  assert.deepEqual(m.noAnswer, { count: 1, share: 1 / 40, byReason: { split: 1 } });
  assert.equal(m.accuracy.rule, 1);
  assert.equal(m.accuracy.model, 38 / 40);
  for (const key of ['model', 'rule', 'lower', 'gain', 'gainLower']) assert.ok(key in m.kappa, `kappa.${key}`);
  assert.equal(m.kappa.rule, 1);
  for (const option of ['yes', 'no']) for (const who of ['model', 'rule']) {
    assert.deepEqual(Object.keys(m.perClass[option][who]), ['precision', 'recall']);
  }
  assert.equal(m.worse, 2);
  assert.equal(m.better, 0);
  assert.equal(m.worseShare, 2 / 40);
  for (const key of ['first', 'p50', 'p95', 'max']) assert.equal(typeof m.latencyMs[key], 'number', `latencyMs.${key}`);
  assert.ok(!('worseIds' in m), 'worse ids are top-level, at most 20');
  assert.equal(body.worseIds.length, 2);
  assert.equal(body.standing, 'measure-only');
  assert.deepEqual(body.failedChecks, []);
  assert.equal(body.stored, 'none');
  assert.equal(body.written, false);
  assert.equal(body.refused, null);

  const text = await f.run(['--kind', KIND]);
  assert.equal(text.status, 0, text.stderr);
  const out = text.stdout;
  for (const pattern of [
    /^Replay claim-support · model clef-flash \(provider ollama, digest sha256:[0-9a-f]{8}…\) · 40 of 40 cases · source claim-ledger \(this project\)$/m,
    /^Labels: yes 30, no 10 \(smaller class 10\)$/m,
    /^Valid 40\/40 \(100\.0%\) · no answer 1 \(2\.5%: split 1\)$/m,
    /^ {13}accuracy {2}kappa {4}kappa low$/m,
    /^ {2}model {6}0\.95 {6}/m,
    /^ {2}rule {7}1\.00 {6}1\.00 {5}-$/m,
    /^Per class, precision\/recall \(model \| rule\): yes \S+\/\S+ \| 1\.00\/1\.00 · no \S+\/\S+ \| 1\.00\/1\.00$/m,
    /^Gain over the rule: kappa -?\d\.\d\d \(low -?\d\.\d\d\) · worse 2 \(5\.0%\), better 0$/m,
    /^Worse ids \(2\): [0-9a-f]{16}, [0-9a-f]{16}$/m,
    /^Latency ms: first \d+ · p50 \d+ · p95 \d+ · max \d+ \(budget 1500\)$/m,
    /^Standing: measure-only: the label is the rule's answer by construction, so nothing certifies from this source\.$/m,
    /^Stored: none · not written \(a person adds --write from their own session to store these figures\)\.$/m,
  ]) assert.match(out, pattern);
  assertNoCaseText(f, json.stdout, json.stderr, text.stdout, text.stderr);
});

const MISSES = 'Misses (labelled yes, answered no): model 2 of 30 · rule 0 of 30';
const FALSE_ALARMS = 'False alarms (labelled no, answered yes): model 0 of 10 · rule 0 of 10';

test('replay text prints the misses line and the false-alarms line for a yes/no kind and neither for a choice kind', async (t) => {
  const f = await fixture(t);
  writeLedger(f.project, mainSpecs());
  const text = await f.run(['--kind', KIND]);
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.trimEnd().split('\n');
  const perClass = lines.findIndex((line) => line.startsWith('Per class, precision/recall'));
  assert.ok(perClass >= 0);
  assert.equal(lines[perClass + 1], MISSES);
  assert.equal(lines[perClass + 2], FALSE_ALARMS);

  // No registered kind with a case source is a choice kind yet, so the text form is rendered directly.
  const shown = (yesno: boolean, confusion?: any) => renderText({
    kind: 'k', model: 'm', provider: 'p', modelDigest: null, source: 's', origin: 'project', yesno, budgetMs: 1000, resultsFile: 'r', confusion,
    caseSet: { eligible: 2, replayed: 2, skipped: {} },
    metrics: {
      n: 2, valid: 2, validShare: 1, noAnswer: { count: 0, share: 0, byReason: {} }, accuracy: { model: 1, rule: 1 }, kappa: { model: 1, rule: 1, lower: 1, gain: 0, gainLower: 0 },
      perClass: { a: { model: { precision: 1, recall: 1 }, rule: { precision: 1, recall: 1 } } }, labelCounts: { a: 2 }, worse: 0, better: 0, worseShare: 0, minority: 0,
      latencyMs: { first: 1, p50: 1, p95: 1, max: 1 },
    },
    worseIds: [], standing: 'below-minimum', failedChecks: [], stored: 'none', written: false, refused: null,
  });
  const choice = shown(false);
  assert.doesNotMatch(choice, /Misses \(|False alarms \(/);
  assert.match(choice, /^Per class, precision\/recall/m);
  const yesno = shown(true, { model: { misses: 1, falseAlarms: 2, nYes: 3, nNo: 4 }, rule: { misses: 5, falseAlarms: 6, nYes: 3, nNo: 4 } });
  assert.match(yesno, /^Misses \(labelled yes, answered no\): model 1 of 3 · rule 5 of 3$/m);
  assert.match(yesno, /^False alarms \(labelled no, answered yes\): model 2 of 4 · rule 6 of 4$/m);
});

test('--json carries confusion and the stored entry does not', async (t) => {
  const f = await fixture(t);
  writeLedger(f.project, mainSpecs());
  const r = await f.run(['--kind', KIND, '--write', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.deepEqual(body.confusion, {
    model: { misses: 2, falseAlarms: 0, nYes: 30, nNo: 10 },
    rule: { misses: 0, falseAlarms: 0, nYes: 30, nNo: 10 },
  });
  assert.ok(!('confusion' in body.metrics), 'confusion is top-level, like worseIds');
  const stored = fs.readFileSync(f.resultsFile, 'utf8');
  assert.ok(!stored.includes('confusion') && !stored.includes('falseAlarms'), 'the store is unchanged');
});

test('(b) the server sees only the configured model, one request at a time, n requests, in case-id order', async (t) => {
  const tags = tagsListing({ models: ['clef-flash:latest', 'kind-model:latest'] });
  const f = await fixture(t, { tags, delayMs: 15, settings: { [`advice.models.${KIND}`]: 'kind-model' } });
  const ids = writeLedger(f.project, mainSpecs(12));
  const r = await f.run(['--kind', KIND, '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).model, 'kind-model');
  assert.equal(asked(f), 12);
  assert.equal(f.seen.maxInFlight, 1);
  assert.ok(f.seen.asks.every((body: any) => body.model === 'kind-model'), 'only the configured model is asked');
  const order = f.seen.asks.map((body: any) => ids[Number(/claim (\d+) /.exec(body.state)![1])]);
  assert.deepEqual(order, [...ids].sort());

  // --limit keeps the first n cases in case-id order.
  f.seen.asks.length = 0;
  const limited = await f.run(['--kind', KIND, '--limit', '5', '--json']);
  assert.equal(limited.status, 0, limited.stderr);
  assert.deepEqual(JSON.parse(limited.stdout).caseSet, { ...JSON.parse(limited.stdout).caseSet, eligible: 12, replayed: 5 });
  assert.deepEqual(f.seen.asks.map((body: any) => ids[Number(/claim (\d+) /.exec(body.state)![1])]), [...ids].sort().slice(0, 5));
});

test('(c) no pick or miss line is written and, without --write, no file changes under HOME or the project', async (t) => {
  const f = await fixture(t);
  writeLedger(f.project, mainSpecs(10));
  const before = snapshot(f.scratch.dir);
  for (const args of [['--kind', KIND], ['--kind', KIND, '--json']]) {
    const r = await f.run(args);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.equal(asked(f), 20);
  assert.deepEqual(snapshot(f.scratch.dir), before);
});

test('(d) each setup refusal exits 1 with nothing asked; usage faults exit 2', async (t) => {
  const f = await fixture(t);
  // No case built: an empty project.
  const none = await f.run(['--kind', KIND]);
  assert.equal(none.status, 1, none.stdout);
  assert.match(none.stderr, /advise: no cases for claim-support/);
  // A kind with no replay source.
  writeLedger(f.project, mainSpecs(4));
  const rerank = await f.run(['--kind', 'rerank']);
  assert.equal(rerank.status, 1);
  assert.match(rerank.stderr, /no local case source: this kind's records hold only digests/);
  // The endpoint does not answer: the provider is named by its id from data.
  const closed = await closedEndpoint();
  writeJson(f.userSettingsFile, { schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': closed, 'advice.model': 'clef-flash' });
  const down = await f.run(['--kind', KIND]);
  assert.equal(down.status, 1);
  assert.ok(down.stderr.includes(`advise: provider ollama did not answer at ${closed}`), down.stderr);
  // The decision model is off.
  writeJson(f.userSettingsFile, { schema: 1, 'advice.enabled': false });
  const off = await f.run(['--kind', KIND]);
  assert.equal(off.status, 1);
  assert.match(off.stderr, /advise: decision model is off/);
  // An invalid bars override in the user's config home.
  writeJson(f.userSettingsFile, { schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': f.server.origin, 'advice.model': 'clef-flash' });
  writeJson(path.join(f.scratch.xdg, 'doflow', 'advice-bars.json'), { schema: 2 });
  const bars = await f.run(['--kind', KIND]);
  assert.equal(bars.status, 1);
  assert.match(bars.stderr, /advice-bars\.json.*schema must be 1/);
  fs.rmSync(path.join(f.scratch.xdg, 'doflow', 'advice-bars.json'));
  assert.equal(asked(f), 0, 'no setup refusal asks the model');

  for (const [args, message] of [
    [[], '--kind is required'],
    [['--kind', 'no-such-kind'], "unknown --kind 'no-such-kind'"],
    [['--kind', KIND, '--limit', '0'], '--limit must be a whole number from 1'],
    [['--kind', KIND, '--limit', 'ten'], '--limit must be a whole number from 1'],
  ] as Array<[string[], string]>) {
    const r = await f.run(args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`);
    assert.ok(r.stderr.includes(message), r.stderr);
  }
  assert.equal(asked(f), 0);
});

for (const refusal of [
  { reason: 'worker-session', env: { DOFLOW_SESSION_ROLE: 'worker' } },
  { reason: 'ci', env: { CI: 'true' } },
  { reason: 'attendance-unclear', setup: (f: any) => { fs.mkdirSync(path.join(f.project, '.doflow', 'state', 'roadmap'), { recursive: true }); fs.writeFileSync(path.join(f.project, '.doflow', 'state', 'roadmap', 'runs'), 'not a folder'); } },
  { reason: 'attendance-unclear', name: 'an unparsable run record', setup: (f: any) => writeRun(f, '{ not json') },
  { reason: 'unattended-run', settings: { 'autopilot.enabled': 'on' }, setup: (f: any) => writeRun(f, openRun()) },
  { reason: 'model-digest-unknown', tags: tagsListing({ omitDigest: true }) },
]) {
  test(`(e) --write is refused up front for ${refusal.name || refusal.reason}: nothing asked, nothing written, exit 1`, async (t) => {
    const f = await fixture(t, { tags: refusal.tags, settings: refusal.settings });
    writeLedger(f.project, mainSpecs(6));
    refusal.setup?.(f);
    const text = await f.run(['--kind', KIND, '--write'], refusal.env);
    assert.equal(text.status, 1, text.stderr);
    assert.equal(text.stdout, '', 'no figures: the replay did not run');
    assert.ok(text.stderr.includes(`advise: --write refused (${refusal.reason})`), text.stderr);
    assert.match(text.stderr, /a person runs --write from their own session, outside a worker or an autopilot run; nothing was written; nothing was asked/);
    const json = await f.run(['--kind', KIND, '--write', '--json'], refusal.env);
    assert.equal(json.status, 1);
    const body = JSON.parse(json.stdout);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'write-refused');
    assert.equal(body.refused, refusal.reason);
    assert.equal(asked(f), 0, 'the fake server saw no ask');
    assert.equal(fs.existsSync(f.resultsFile), false);
  });
}

function writeRun(f: any, record: any) {
  const file = path.join(f.project, '.doflow', 'state', 'roadmap', 'runs', 'rl-20261119-ab12.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record));
}

function openRun(extra: any = {}) {
  return { schema: 1, runId: 'rl-20261119-ab12', steps: 0, n: 1, rows: {}, log: [], createdAt: '2026-11-19T00:00:00.000Z', ...extra };
}

test('(e) control: an open run with the autopilot switch verifiably off, and a closed run, do not refuse --write', async (t) => {
  const f = await fixture(t, { settings: { 'autopilot.enabled': 'on' } });
  writeLedger(f.project, mainSpecs(6));
  writeRun(f, openRun());
  fs.mkdirSync(path.join(f.scratch.xdg, 'doflow', 'autopilot'), { recursive: true });
  fs.writeFileSync(path.join(f.scratch.xdg, 'doflow', 'autopilot', 'off'), '');
  const off = await f.run(['--kind', KIND, '--write']);
  assert.equal(off.status, 0, off.stderr);
  fs.rmSync(path.join(f.scratch.xdg, 'doflow', 'autopilot', 'off'));
  writeRun(f, openRun({ closedAt: '2026-11-19T01:00:00.000Z' }));
  const closed = await f.run(['--kind', KIND, '--write']);
  assert.equal(closed.status, 0, closed.stderr);
});

test('(f) with no terminal and no run, --write stores one entry; a replay after it compares the case set', async (t) => {
  const f = await fixture(t);
  writeLedger(f.project, mainSpecs(8));
  const before = snapshot(f.scratch.dir);
  const r = await f.run(['--kind', KIND, '--write', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.written, true);
  assert.equal(body.refused, null);
  const after = snapshot(f.scratch.dir);
  const added = Object.keys(after).filter((file) => !(file in before));
  assert.deepEqual(added, [path.relative(f.scratch.dir, f.resultsFile)], 'the store is the only file written');
  for (const file of Object.keys(before)) assert.equal(after[file], before[file], `${file} unchanged`);
  const store = JSON.parse(fs.readFileSync(f.resultsFile, 'utf8'));
  assert.equal(store.results.length, 1);
  const entry = store.results[0];
  assert.deepEqual(Object.keys(entry).sort(), ['barsDigest', 'builderDigest', 'caseSet', 'doflowVersion', 'kind', 'metrics', 'model', 'modelDigest', 'provider', 'questionDigest', 'runAt'].sort());
  assert.equal(entry.modelDigest, body.modelDigest);
  assert.equal(entry.caseSet.digest, body.caseSet.digest);
  assert.equal(entry.caseSet.replayed, 8);
  assert.ok(!('standing' in entry) && !('worseIds' in entry.metrics));
  for (const id of body.worseIds) assert.ok(!fs.readFileSync(f.resultsFile, 'utf8').includes(id), 'no case id is stored');

  const same = await f.run(['--kind', KIND]);
  assert.match(same.stdout, /^Stored: same case set · not written/m);
  writeLedger(f.project, mainSpecs(9));
  const changed = await f.run(['--kind', KIND, '--json']);
  assert.equal(JSON.parse(changed.stdout).stored, 'case set changed');
  // A second write for the same project, kind and model build replaces the entry.
  const again = await f.run(['--kind', KIND, '--write']);
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /^Stored: case set changed · written to /m);
  assert.equal(JSON.parse(fs.readFileSync(f.resultsFile, 'utf8')).results.length, 1);
  assertNoCaseText(f, r.stdout, r.stderr, same.stdout, changed.stdout, again.stdout, again.stderr);
});

test('(f) a --write that replaces a stored result names what it replaced; the first write and a replay without --write name nothing', async (t) => {
  const f = await fixture(t);
  writeLedger(f.project, mainSpecs(20));
  const first = await f.run(['--kind', KIND, '--write', '--json']);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(JSON.parse(first.stdout).replaced, null, 'nothing was stored before');
  const stored = JSON.parse(fs.readFileSync(f.resultsFile, 'utf8')).results[0];
  assert.equal(stored.caseSet.replayed, 20);

  const text = await f.run(['--kind', KIND, '--limit', '10', '--write']);
  assert.equal(text.status, 0, text.stderr);
  const day = stored.runAt.slice(0, 10);
  assert.ok(text.stdout.split('\n').includes(`Replaced the stored result (20 cases, replayed ${day}) with this one (10 cases).`), text.stdout);
  assert.equal(JSON.parse(fs.readFileSync(f.resultsFile, 'utf8')).results[0].caseSet.replayed, 10);

  const secondRunAt = JSON.parse(fs.readFileSync(f.resultsFile, 'utf8')).results[0].runAt;
  const json = await f.run(['--kind', KIND, '--limit', '5', '--write', '--json']);
  assert.deepEqual(JSON.parse(json.stdout).replaced, { replayed: 10, runAt: secondRunAt });
  const plain = await f.run(['--kind', KIND, '--limit', '5']);
  assert.doesNotMatch(plain.stdout, /Replaced the stored result/, 'without --write nothing is replaced');
});

test('(g) a 200-case replay: the --json body stays under its measured ceiling and the text form is at most 30 lines', async (t) => {
  const f = await fixture(t, { delayMs: 0 });
  // Every case worse than the rule, so the worse-id list is at its cap.
  writeLedger(f.project, Array.from({ length: 200 }, (_v, i) => ({ relation: i % 3 === 0 ? 'contradicts' : 'supports', answer: i % 3 === 0 ? 0.9 : 0.1 } as any)));
  const json = await f.run(['--kind', KIND, '--json']);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.equal(body.metrics.n, 200);
  assert.equal(body.metrics.worse, 200);
  assert.equal(body.worseIds.length, 20);
  const bytes = Buffer.byteLength(json.stdout, 'utf8');
  assert.ok(bytes <= JSON_CEILING, `--json body is ${bytes} bytes; the ceiling is ${JSON_CEILING}`);
  const text = await f.run(['--kind', KIND]);
  assert.equal(text.status, 0, text.stderr);
  const lines = text.stdout.trimEnd().split('\n');
  assert.ok(lines.length <= 30, `text form is ${lines.length} lines`);
  assert.match(text.stdout, /^Worse ids \(first 20 of 200\): /m);
  assertNoCaseText(f, json.stdout, text.stdout);
});

test('(h) no case text or sentinel string in stdout or stderr, whatever the outcome', async (t) => {
  const f = await fixture(t);
  writeLedger(f.project, mainSpecs(5));
  const outputs: string[] = [];
  for (const [args, env] of [
    [['--kind', KIND], {}], [['--kind', KIND, '--json'], {}], [['--kind', KIND, '--write'], { CI: '1' }], [['--kind', KIND, '--write', '--json'], {}],
  ] as Array<[string[], any]>) {
    const r = await f.run(args, env);
    if (env.CI) assert.equal(r.status, 1, 'a refused --write runs no replay');
    else assert.match(r.stdout, /Replay claim-support|"kind": "claim-support"/, 'the figures were printed');
    outputs.push(r.stdout, r.stderr);
  }
  assertNoCaseText(f, ...outputs);
});

test('a case is bounded by timeoutMs, not the kind budget: a slow answer is measured as over-budget', async (t) => {
  const f = await fixture(t, { delayMs: 1600 });
  writeLedger(f.project, [{ relation: 'supports', answer: 0.9 }]);
  const r = await f.run(['--kind', KIND, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout).metrics;
  assert.deepEqual(m.noAnswer.byReason, { 'over-budget': 1 });
  assert.equal(m.valid, 1);
  assert.ok(m.latencyMs.first >= 1600);
});

test('180 (f) a routing kind replays from its captured states: the model is reported against the rule; with no captured line the refusal says capture is off or empty', async (t) => {
  // The fake model answers `frontier` for a state that says so, else `standard`.
  const f = await fixture(t, {
    settings: { 'advice.capture.state-text': true },
    route: ({ body }: any) => answering(() => (/pick=frontier/.test(body?.state || '') ? 'frontier' : 'standard'))({ body }),
  });
  const empty = await f.run(['--kind', 'tier']);
  assert.equal(empty.status, 1, empty.stdout);
  assert.match(empty.stderr, /advise: no cases for tier: skipped capture-off-or-empty 1; nothing was asked/);
  assert.equal(asked(f), 0);

  resetCaptureSetting();
  const roots = resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: f.project, env: { HOME: f.scratch.home, XDG_CONFIG_HOME: f.scratch.xdg } });
  const question = { name: 'tier', type: 'choice', instructions: 'Choose a tier.', options: { light: 'Light', standard: 'Normal', frontier: 'Frontier' } };
  const answer = { name: 'tier', type: 'choice', pick: 'standard', probabilities: { light: 0.1, standard: 0.8, frontier: 0.1 }, confidence: 0.7 };
  for (let i = 0; i < 6; i += 1) {
    // The rule answered standard every time; people moved two tasks to frontier.
    const actual = i < 2 ? 'frontier' : 'standard';
    const state = `${SENTINEL} task ${i} pick=${i < 3 ? 'frontier' : 'standard'}`;
    const written = appendPick({ roots, kind: 'tier', answer, question, staticAnswer: 'standard', state, caller: 'brief-tools' });
    assert.ok(captureState({ roots, pickId: written.pickId, kind: 'tier', state, store: written.store }));
    assert.ok(appendOutcome({ roots, pickId: written.pickId, actual, source: 'orchestrator' }));
  }
  const r = await f.run(['--kind', 'tier', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.kind, 'tier');
  assert.equal(body.source, 'captured-state');
  assert.equal(body.caseSet.eligible, 6);
  assert.equal(body.caseSet.replayed, 6);
  assert.equal(asked(f), 6, 'one call per case');
  // Against the labels: the rule is right on 4 of 6; the model on 5 (it says frontier for task 2, which stayed standard).
  assert.equal(body.metrics.n, 6);
  assert.equal(body.metrics.valid, 6);
  assert.deepEqual(body.metrics.accuracy, { model: 5 / 6, rule: 4 / 6 });
  assert.deepEqual([body.metrics.better, body.metrics.worse], [2, 1]);
  assert.ok(!r.stdout.includes(SENTINEL), 'no case text in the report');
});
