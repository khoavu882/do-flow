'use strict';

// 141 IC-004/IC-006: the advice-gate runner, driven through its injected collaborators with a fake client. No model, no
// network, and no write to the repository: the corpus directory and the verdict directory are temp copies.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { adviceGate } = require('../../bench/advice-gate.ts');

const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT });
assert.equal(ADVICE.ok, true);
const REGISTRY = ADVICE.registry;
const EMPTY = { schemaVersion: 1, corpora: {}, verdicts: [] };
const SETTING = { state: 'on', model: 'fake-model', endpoint: 'http://127.0.0.1:1', provider: 'ollama', decidedBy: {} };
const REAL_VERDICT_FILE = path.join(REPO_ROOT, 'core/registry/advice-verdicts.json');

function readJson(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** A temp corpus dir (every shipped corpus) and a temp registry dir holding `verdicts`. Tier keeps `heldout` heldout cases. */
function workspace(t: any, { heldout = 30, verdicts = EMPTY }: any = {}) {
  const root = tempDir(t, 'doflow-advice-gate-');
  const corpusDir = path.join(root, 'corpus');
  const registryDir = path.join(root, 'registry');
  fs.mkdirSync(corpusDir);
  fs.mkdirSync(registryDir);
  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'bench/advice'))) {
    fs.copyFileSync(path.join(REPO_ROOT, 'bench/advice', file), path.join(corpusDir, file));
  }
  const tierFile = path.join(corpusDir, 'tier.json');
  const tier = readJson(tierFile);
  let seen = 0;
  tier.cases = tier.cases.filter((item: any) => item.split !== 'heldout' || ++seen <= heldout);
  fs.writeFileSync(tierFile, JSON.stringify(tier));
  const verdictFile = path.join(registryDir, 'advice-verdicts.json');
  fs.writeFileSync(verdictFile, JSON.stringify(verdicts));
  return { corpusDir, registryDir, verdictFile, tierFile };
}

/** A client that answers every heldout case with its `expected` pick, except ids in `fail`, which are unavailable. */
function fakeClient(corpusFile: string, { fail = [] as string[], calls = [] as any[] } = {}) {
  const byState = new Map<string, any>(readJson(corpusFile).cases.map((item: any) => [item.state, item]));
  return {
    calls,
    async inspect() { return { endpoint: { state: 'reached' }, model: { installed: true, decisionCapable: true } }; },
    async ask(request: any) {
      calls.push(request);
      const item = byState.get(request.questionSet.state);
      if (fail.includes(item.id)) return { status: 'unavailable', answers: [], durationMs: 40 };
      return { status: 'answered', answers: [{ pick: item.expected }], durationMs: 10 };
    },
  };
}

function run(ws: any, extra: any = {}) {
  const out: string[] = [];
  const err: string[] = [];
  return adviceGate({
    kind: 'tier', adviceRegistry: REGISTRY, setting: SETTING, client: fakeClient(ws.tierFile),
    corpusDir: ws.corpusDir, registryDir: ws.registryDir,
    now: () => new Date('2026-11-06T00:00:00.000Z'), log: (s: string) => out.push(s), error: (s: string) => err.push(s),
    ...extra,
  }).then((result: any) => ({ ...result, out, err }));
}

test('2 of 30 cases failing stay in the denominator and fail the valid-share check', async (t) => {
  const ws = workspace(t);
  const heldoutIds = readJson(ws.tierFile).cases.filter((item: any) => item.split === 'heldout').map((item: any) => item.id);
  assert.equal(heldoutIds.length, 30);
  const client = fakeClient(ws.tierFile, { fail: heldoutIds.slice(0, 2) });
  const { code, verdict, outcomes } = await run(ws, { client });
  assert.equal(code, 0);
  assert.equal(client.calls.length, 30);
  assert.equal(client.calls.every((call: any) => call.record === false && call.kind === 'tier'), true);
  assert.equal(verdict.n, 30);
  assert.equal(verdict.valid, 28);
  assert.equal(verdict.validShare, 28 / 30);
  assert.equal(verdict.result, 'fail');
  assert.ok(verdict.failedChecks.includes('valid-share'));
  assert.equal(outcomes.filter((o: any) => !o.valid).length, 2);
  // The two failed cases take the static score, so the quality figure is not computed over the 28 answered cases only.
  const heldout = readJson(ws.tierFile).cases.filter((item: any) => item.split === 'heldout');
  const staticRight = heldout.filter((item: any) => item.staticPick === item.expected).length;
  const failedStaticRight = heldout.slice(0, 2).filter((item: any) => item.staticPick === item.expected).length;
  assert.equal(verdict.quality.static, staticRight / 30);
  assert.equal(verdict.quality.model, (28 + failedStaticRight) / 30);
  assert.deepEqual(readJson(ws.verdictFile), EMPTY);
});

test('fewer heldout cases than gate.minCases is insufficient-data, not a pass', async (t) => {
  const ws = workspace(t, { heldout: 29 });
  const { code, verdict } = await run(ws);
  assert.equal(code, 0);
  assert.equal(verdict.n, 29);
  assert.equal(verdict.result, 'insufficient-data');
  assert.deepEqual(verdict.failedChecks, ['min-cases']);
});

test('--freeze refuses a changed corpus whose corpusVersion did not increase, and writes nothing', async (t) => {
  const ws = workspace(t);
  const first = await run(ws, { kind: undefined, freeze: true, client: null, setting: null });
  assert.equal(first.code, 0, first.err.join('\n'));
  const frozen = readJson(ws.verdictFile);
  assert.deepEqual(Object.keys(frozen.corpora).sort(), REGISTRY.kinds.filter((k: any) => k.criteriaFrom !== 'call').map((k: any) => k.id).sort());
  assert.equal(frozen.corpora.tier.heldoutCases, 30);
  assert.match(frozen.corpora.tier.digest, /^sha256:[0-9a-f]{64}$/);
  assert.deepEqual(frozen.verdicts, []);

  // A note-only edit does not change the digest.
  const tier = readJson(ws.tierFile);
  tier.cases[0].note = `${tier.cases[0].note} (reworded)`;
  fs.writeFileSync(ws.tierFile, JSON.stringify(tier));
  assert.equal((await run(ws, { kind: undefined, freeze: true, client: null, setting: null })).code, 0);

  // A heldout label change does, and without a higher corpusVersion the freeze is refused.
  const changed = readJson(ws.tierFile);
  const target = changed.cases.find((item: any) => item.split === 'heldout');
  target.expected = target.expected === 'light' ? 'standard' : 'light';
  fs.writeFileSync(ws.tierFile, JSON.stringify(changed));
  const before = fs.readFileSync(ws.verdictFile, 'utf8');
  const refused = await run(ws, { kind: undefined, freeze: true, client: null, setting: null });
  assert.equal(refused.code, 1);
  assert.match(refused.err.join('\n'), /--freeze refused: kind 'tier'.*increment corpusVersion/);
  assert.equal(fs.readFileSync(ws.verdictFile, 'utf8'), before);

  changed.corpusVersion += 1;
  fs.writeFileSync(ws.tierFile, JSON.stringify(changed));
  assert.equal((await run(ws, { kind: undefined, freeze: true, client: null, setting: null })).code, 0);
  assert.equal(readJson(ws.verdictFile).corpora.tier.corpusVersion, 2);
});

test('--write replaces exactly the (kind, model, arm) entry and keeps every other one', async (t) => {
  const other = (kind: string, model: string, arm: string | null = null) => ({ kind, model, arm, marker: `${kind}/${model}/${arm}` });
  const seeded = {
    schemaVersion: 1,
    corpora: { 'verify-risk': { corpusVersion: 1, digest: 'sha256:keep', heldoutCases: 32 } },
    verdicts: [other('tier', 'fake-model'), other('tier', 'another-model'), other('verify-risk', 'fake-model'), other('tier', 'fake-model', 'ladder')],
  };
  const ws = workspace(t, { verdicts: seeded });
  const { code, verdict } = await run(ws, { write: true });
  assert.equal(code, 0);
  const stored = readJson(ws.verdictFile);
  assert.equal(stored.verdicts.length, 4);
  assert.deepEqual(stored.verdicts[0], JSON.parse(JSON.stringify(verdict)));
  assert.deepEqual(stored.verdicts.slice(1), seeded.verdicts.slice(1));
  assert.deepEqual(stored.corpora['verify-risk'], seeded.corpora['verify-risk']);
  assert.equal(stored.corpora.tier.heldoutCases, 30);

  // A second run replaces again; it does not append.
  assert.equal((await run(ws, { write: true })).code, 0);
  assert.equal(readJson(ws.verdictFile).verdicts.length, 4);

  // A new model adds one entry.
  const added = await run(ws, { write: true, model: 'third-model' });
  assert.equal(added.code, 0);
  assert.equal(readJson(ws.verdictFile).verdicts.length, 5);
});

test('without --write nothing is stored; --write refuses an unversioned corpus change', async (t) => {
  const ws = workspace(t);
  const dry = await run(ws);
  assert.equal(dry.code, 0);
  assert.deepEqual(readJson(ws.verdictFile), EMPTY);
  assert.match(dry.out.join('\n'), /not written \(pass --write/);

  assert.equal((await run(ws, { kind: undefined, freeze: true, client: null, setting: null })).code, 0);
  const tier = readJson(ws.tierFile);
  const target = tier.cases.find((item: any) => item.split === 'heldout');
  target.expected = target.expected === 'light' ? 'standard' : 'light';
  fs.writeFileSync(ws.tierFile, JSON.stringify(tier));
  const before = fs.readFileSync(ws.verdictFile, 'utf8');
  const refused = await run(ws, { write: true });
  assert.equal(refused.code, 1);
  assert.match(refused.err.join('\n'), /--write refused/);
  assert.equal(fs.readFileSync(ws.verdictFile, 'utf8'), before);
});

test('the stored verdict file holds no case text and no per-case row', async (t) => {
  const ws = workspace(t);
  assert.equal((await run(ws, { write: true, client: fakeClient(ws.tierFile, { fail: ['tier-001'] }) })).code, 0);
  const raw = fs.readFileSync(ws.verdictFile, 'utf8');
  const stored = JSON.parse(raw);
  const corpus = readJson(ws.tierFile);
  for (const item of corpus.cases) {
    assert.equal(raw.includes(item.state), false, `state of ${item.id} leaked`);
    assert.equal(raw.includes(item.note), false, `note of ${item.id} leaked`);
  }
  assert.equal(raw.includes('tier-0'), false, 'a case id leaked');
  assert.deepEqual(Object.keys(stored).sort(), ['corpora', 'schemaVersion', 'verdicts']);
  assert.deepEqual(Object.keys(stored.verdicts[0]).sort(), [
    'arm', 'corpusDigest', 'corpusVersion', 'criteriaDigest', 'failedChecks', 'gateDigest', 'gateVersion', 'host',
    'kind', 'latencyMs', 'model', 'n', 'quality', 'result', 'runAt', 'valid', 'validShare',
  ]);
});

test('setup failures exit 1 and usage errors exit 2 without asking the model', async (t) => {
  const ws = workspace(t);
  const client = fakeClient(ws.tierFile);
  const off = await run(ws, { client, setting: { state: 'off', reason: 'not-configured' } });
  assert.equal(off.code, 1);
  assert.match(off.err.join('\n'), /advice is off/);
  const unreachable = await run(ws, { client: { ...client, inspect: async () => ({ endpoint: { state: 'unreachable', message: 'refused' } }) } });
  assert.equal(unreachable.code, 1);
  const notCapable = await run(ws, { client: { ...client, inspect: async () => ({ endpoint: { state: 'reached' }, model: { installed: true, decisionCapable: false } }) } });
  assert.equal(notCapable.code, 1);
  assert.match(notCapable.err.join('\n'), /not decision-capable/);
  assert.equal((await run(ws, { kind: undefined })).code, 2);
  assert.equal((await run(ws, { kind: 'no-such-kind' })).code, 2);
  assert.equal((await run(ws, { arm: 'choice' })).code, 2);
  assert.equal((await run(ws, { freeze: true, kind: 'tier' })).code, 2);
  assert.equal(client.calls.length, 0);
});

test('the runner CLI refuses misuse with exit 2 before any model or file work', (t) => {
  const scratch = createScratch('doflow-advice-gate-cli-');
  t.after(() => scratch.remove());
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'bench/runner.ts'), ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: scratch.env(),
  });
  const noKind = cli('advice-gate');
  assert.equal(noKind.status, 2);
  assert.match(noKind.stderr, /--kind <id> is required/);
  const freezeKind = cli('advice-gate', '--freeze', '--kind', 'tier');
  assert.equal(freezeKind.status, 2);
  assert.equal(cli('advice-gate', '--kind', 'tier', '--model').status, 2);
  const stray = cli('coverage', '--write');
  assert.equal(stray.status, 2);
  assert.match(stray.stderr, /--write is not accepted/);
  assert.deepEqual(readJson(REAL_VERDICT_FILE), EMPTY);
});

test('these tests leave the shipped verdict file empty', () => {
  assert.deepEqual(readJson(REAL_VERDICT_FILE), EMPTY);
});
