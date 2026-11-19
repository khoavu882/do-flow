'use strict';

// 175 D14/O-5: the advice-gate runner is a print-only scorer. It asks the configured decision model every heldout case of
// one choice or yes/no kind, scores the answers with replay/score.ts and prints the figures and the standing against the
// package bars. It stores nothing. Driven through its injected collaborators with a fake client: no model, no network,
// and no write to the repository (the corpus directory is a temp copy).

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
const SETTING = { state: 'on', model: 'fake-model', endpoint: 'http://127.0.0.1:1', provider: 'ollama', decidedBy: {} };
const STANDINGS = ['measure-only', 'below-minimum', 'below-show', 'show', 'act'];

function readJson(file: string) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** A temp corpus dir (every shipped corpus). Tier keeps `heldout` heldout cases. */
function workspace(t: any, { heldout = 30 }: any = {}) {
  const root = tempDir(t, 'doflow-advice-gate-');
  const corpusDir = path.join(root, 'corpus');
  fs.mkdirSync(corpusDir);
  for (const file of fs.readdirSync(path.join(REPO_ROOT, 'bench/advice'))) {
    fs.copyFileSync(path.join(REPO_ROOT, 'bench/advice', file), path.join(corpusDir, file));
  }
  const tierFile = path.join(corpusDir, 'tier.json');
  const tier = readJson(tierFile);
  let seen = 0;
  tier.cases = tier.cases.filter((item: any) => item.split !== 'heldout' || ++seen <= heldout);
  fs.writeFileSync(tierFile, JSON.stringify(tier));
  return { root, corpusDir, tierFile };
}

/** Every file under `dir` with its bytes, to compare before and after a run. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file); else out[path.relative(dir, file)] = fs.readFileSync(file, 'utf8');
    }
  };
  walk(dir);
  return out;
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
    corpusDir: ws.corpusDir, log: (s: string) => out.push(s), error: (s: string) => err.push(s),
    ...extra,
  }).then((result: any) => ({ ...result, out, err }));
}

test('--json prints the figures and the standing; 2 of 30 failing cases stay in the denominator; nothing is written', async (t) => {
  const ws = workspace(t);
  const heldout = readJson(ws.tierFile).cases.filter((item: any) => item.split === 'heldout');
  assert.equal(heldout.length, 30);
  const client = fakeClient(ws.tierFile, { fail: heldout.slice(0, 2).map((item: any) => item.id) });
  const before = snapshot(ws.root);
  const { code, out, err } = await run(ws, { client, json: true });
  assert.equal(code, 0, err.join('\n'));
  assert.equal(client.calls.length, 30);
  assert.equal(client.calls.every((call: any) => call.record === false && call.kind === 'tier'), true);

  const printed = JSON.parse(out[0]);
  assert.equal(printed.kind, 'tier');
  assert.equal(printed.model, 'fake-model');
  assert.ok(STANDINGS.includes(printed.standing), printed.standing);
  assert.ok(Array.isArray(printed.failedChecks));
  const m = printed.metrics;
  assert.equal(m.n, 30);
  assert.equal(m.valid, 28);
  assert.equal(m.validShare, 28 / 30);
  assert.equal(m.noAnswer.count, 2);
  assert.deepEqual(m.noAnswer.byReason, { unreachable: 2 });
  for (const key of ['accuracy', 'kappa', 'perClass', 'labelCounts', 'worse', 'better', 'worseShare', 'minority', 'latencyMs']) {
    assert.ok(key in m, `the figure ${key} is printed`);
  }
  // The two failed cases take the rule's answer, so the model figure is not computed over the 28 answered cases only.
  const staticRight = heldout.filter((item: any) => item.staticPick === item.expected).length;
  const failedStaticRight = heldout.slice(0, 2).filter((item: any) => item.staticPick === item.expected).length;
  assert.equal(m.accuracy.rule, staticRight / 30);
  assert.equal(m.accuracy.model, (28 + failedStaticRight) / 30);
  assert.equal(printed.cases.filter((o: any) => !o.valid).length, 2);
  assert.deepEqual(snapshot(ws.root), before, 'a print-only run writes nothing');
});

test('the text form names the figures, the standing and that nothing is stored', async (t) => {
  const ws = workspace(t);
  const { code, out } = await run(ws);
  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.match(out[0], /^advice-gate tier \(fake-model\): standing (measure-only|below-minimum|below-show|show|act)/);
  assert.match(out[0], /cases: 30, valid 30/);
  assert.match(out[0], /kappa: model .*rule .*lower .*gain/);
  assert.match(out[0], /latency ms: p50 .*p95 .*budget 1500/);
  assert.match(out[0], /print-only: nothing is stored/);
});

test('fewer heldout cases than the show bar minimum is below-minimum, not a pass', async (t) => {
  const ws = workspace(t, { heldout: 29 });
  const { code, out } = await run(ws, { json: true });
  assert.equal(code, 0);
  const printed = JSON.parse(out[0]);
  assert.equal(printed.metrics.n, 29);
  assert.equal(printed.standing, 'below-minimum');
  assert.ok(printed.failedChecks.includes('min-cases'));
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
  assert.equal(client.calls.length, 0);
});

test('the runner CLI refuses misuse, including --write and --freeze, with exit 2 before any model or file work', (t) => {
  const scratch = createScratch('doflow-advice-gate-cli-');
  t.after(() => scratch.remove());
  const cli = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'bench/runner.ts'), ...args], {
    cwd: REPO_ROOT, encoding: 'utf8', env: scratch.env(),
  });
  const noKind = cli('advice-gate');
  assert.equal(noKind.status, 2);
  assert.match(noKind.stderr, /--kind <id> is required/);
  const write = cli('advice-gate', '--kind', 'tier', '--write');
  assert.equal(write.status, 2, write.stdout + write.stderr);
  assert.match(write.stderr, /--write/);
  const freeze = cli('advice-gate', '--freeze');
  assert.equal(freeze.status, 2, freeze.stdout + freeze.stderr);
  assert.match(freeze.stderr, /--freeze/);
  assert.equal(cli('advice-gate', '--kind', 'tier', '--model').status, 2);
  const stray = cli('coverage', '--write');
  assert.equal(stray.status, 2);
});
