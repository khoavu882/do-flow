'use strict';

// Row 174 (T2): `advise --action ask` goes through the one dispatcher path. A named kind runs in the mode
// advice.kinds.<kind> and the rollout profile's cap give it: off asks nothing and prints status off, shadow hands the call
// to the detached child and prints status shadow, show and act print the model's answer once the kind's local result
// stands at show or act (175 IC-009; the ask has a show surface). A model is only ever the fake decision server of
// test/helper/fake-decision-server.ts, under a scratch HOME and config home.

const { bashPath } = require('../../helper/bash-locator.ts');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createScratch } = require('../../helper/scratch-env.ts');
const { startFakeServer } = require('../../helper/fake-decision-server.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');

const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');
const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const KINDS: any = {
  'verify-risk': { args: ['--kind', 'verify-risk', '--state', 'A change to the payment path.', '--static', 'MEDIUM'], pick: 'LOW' },
  'mcp-need': { args: ['--kind', 'mcp-need', '--server', 'context7', '--state', 'A stage that names a library.', '--static', 'yes'], pick: 'yes' },
};

async function fixture(t: any) {
  const scratch = createScratch('doflow-advice-ask-modes-');
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(project, '.doflow', 'state'), { recursive: true });
  const server: any = await startFakeServer();
  t.after(async () => { await server.close(); scratch.remove(); });
  fs.writeFileSync(path.join(scratch.xdg, 'doflow', 'settings.json'), JSON.stringify({
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
  }));
  const f: any = {
    scratch, project, server,
    settings(value: any) { fs.writeFileSync(path.join(project, '.doflow', 'settings.json'), JSON.stringify(value)); },
    /** The model requests the fake server got for a decision; the detached child asks after the verb exited. */
    asks: () => server.requests.filter((r: any) => r.method === 'POST' && r.pathname === '/v1/systemone').length,
    async untilAsks(n: number) {
      const until = Date.now() + 5000;
      while (Date.now() < until && f.asks() < n) await new Promise((resolve) => setTimeout(resolve, 10));
    },
    async quiet() { await new Promise((resolve) => setTimeout(resolve, 300)); },
    records(): any[] {
      const file = path.join(project, '.doflow', 'state', 'advice', 'picks', `${new Date().toISOString().slice(0, 10)}.jsonl`);
      return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line)) : [];
    },
    ask(args: string[], { env }: any = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
      const child = spawn(bashPath(), [RUN, 'advise', '--action', 'ask', ...args], { cwd: project, env: scratch.env({ DOFLOW_CLI: BIN, ...(env || {}) }) });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: any) => { stdout += chunk; });
      child.stderr.on('data', (chunk: any) => { stderr += chunk; });
      return new Promise((resolve) => child.on('close', (status: number | null) => resolve({ status, stdout, stderr })));
    },
  };
  return f;
}

for (const [kind, spec] of Object.entries(KINDS) as any) {
  test(`${kind}: off asks nothing and prints status: off, as text and as JSON`, async (t) => {
    const f = await fixture(t);
    f.settings({ advice: { kinds: { [kind]: 'off' } } });
    const text = await f.ask(spec.args);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`Advice \\(${kind}\\): status: off;`));
    const json = await f.ask([...spec.args, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.status, 'off');
    assert.deepEqual(parsed.answers, []);
    await f.quiet();
    assert.equal(f.asks(), 0, 'off makes no model call');
    assert.deepEqual(f.records(), []);
  });

  test(`${kind}: a profile capping the advisor to off asks nothing even with the kind set to act`, async (t) => {
    const f = await fixture(t);
    f.settings({ advice: { kinds: { [kind]: 'act' } }, rollout: { profile: 'baseline' } });
    const text = await f.ask(spec.args);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, new RegExp(`Advice \\(${kind}\\): status: off;`));
    const json = JSON.parse((await f.ask([...spec.args, '--json'])).stdout);
    assert.equal(json.status, 'off');
    await f.quiet();
    assert.equal(f.asks(), 0);
    assert.deepEqual(f.records(), []);
  });

  for (const [name, settings] of [
    ['shadow', { advice: { kinds: { [kind]: 'shadow' } } }],
    ['unset with a decision model configured', {}],
    ['act with no local result', { advice: { kinds: { [kind]: 'act' } } }],
    ['show with no local result', { advice: { kinds: { [kind]: 'show' } } }],
    ['act under a canary profile', { advice: { kinds: { [kind]: 'act' } }, rollout: { profile: 'canary' } }],
  ] as any) {
    test(`${kind}: ${name} prints status: shadow, shows no answer and the child records one shadow pick`, async (t) => {
      const f = await fixture(t);
      f.settings(settings);
      const text = await f.ask(spec.args);
      assert.equal(text.status, 0, text.stderr);
      assert.match(text.stdout, new RegExp(`Advice \\(${kind}\\): status: shadow;`));
      assert.doesNotMatch(text.stdout, new RegExp(spec.pick === 'yes' ? 'Advice \\(mcp-need\\): yes' : 'Advice \\(verify-risk\\): LOW'));
      const json = JSON.parse((await f.ask([...spec.args, '--json'])).stdout);
      assert.equal(json.status, 'shadow');
      assert.deepEqual(json.answers, []);
      if (/no local result/.test(name)) assert.equal(json.reason, 'LOCAL_RESULT_UNMET: none: no local result for this project, kind and model build; run a replay with --write');
      else assert.equal(json.reason, null);
      await f.untilAsks(2);
      const until = Date.now() + 5000;
      while (Date.now() < until && f.records().filter((r: any) => r.type === 'pick').length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(f.asks(), 2, 'one call per run, made by the detached child');
      assert.deepEqual(f.records().map(({ type, mode, caller, kind: k, pick }: any) => ({ type, mode, caller, kind: k, pick })),
        [0, 1].map(() => ({ type: 'pick', mode: 'shadow', caller: 'advise', kind, pick: spec.pick })));
    });
  }
}

test('an unset kind with no decision model configured makes no call and prints status: off', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.scratch.xdg, 'doflow', 'settings.json'), JSON.stringify({
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': f.server.origin, 'advice.model': null,
  }));
  const text = await f.ask(KINDS['verify-risk'].args);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Advice \(verify-risk\): status: off;/);
  await f.quiet();
  assert.equal(f.asks(), 0);
});

test('a state over the limit stays a usage error whichever mode the kind runs in', async (t) => {
  const f = await fixture(t);
  f.settings({ advice: { kinds: { 'verify-risk': 'shadow' } } });
  const result = await f.ask(['--kind', 'verify-risk', '--state', 'x'.repeat(51200)]);
  assert.equal(result.status, 2, result.stdout);
  assert.match(result.stderr, /limits\.maxStateBytes/);
  await f.quiet();
  assert.equal(f.asks(), 0);
});

// ---- ad hoc question sets: the profile cap alone decides ----

/** Two questions, so the call carries no static answer (a single one would be checked against it). */
function adhocFile(f: any) {
  const file = path.join(f.scratch.dir, 'adhoc.json');
  fs.writeFileSync(file, JSON.stringify({ questions: [
    { name: 'first', type: 'choice', instructions: 'Choose one.', options: { a: 'A', b: 'B' } },
    { name: 'second', type: 'choice', instructions: 'Choose one.', options: { c: 'C', d: 'D' } },
  ] }));
  return ['--questions-file', file, '--state', 'An ad hoc question.'];
}

test('adhoc: a profile capping the advisor to off asks nothing and prints status: off', async (t) => {
  const f = await fixture(t);
  f.settings({ rollout: { profile: 'baseline' } });
  const json = JSON.parse((await f.ask([...adhocFile(f), '--json'])).stdout);
  assert.equal(json.status, 'off');
  await f.quiet();
  assert.equal(f.asks(), 0);
});

test('adhoc: a shadow cap prints status: shadow and the detached child asks once', async (t) => {
  const f = await fixture(t);
  f.settings({ rollout: { profile: 'canary' } });
  const text = await f.ask(adhocFile(f));
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /Advice \(adhoc\): status: shadow;/);
  await f.untilAsks(1);
  assert.equal(f.asks(), 1);
  const until = Date.now() + 5000;
  while (Date.now() < until && f.records().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(f.records().map(({ type, mode, caller, kind }: any) => ({ type, mode, caller, kind })),
    [{ type: 'pick', mode: 'shadow', caller: 'advise', kind: 'adhoc' }]);
});

test('adhoc: with no cap the ask is direct and answered', async (t) => {
  const f = await fixture(t);
  const json = JSON.parse((await f.ask([...adhocFile(f), '--json'])).stdout);
  assert.equal(json.status, 'answered');
  assert.equal(json.answers.length, 2);
  assert.equal(f.asks(), 1);
});

// ---- show and act at a local standing, in this process: no shipped source certifies, so no spawned run reaches them ----

/**
 * Loads advice/cli.ts with the trust evaluator (replay/trust.ts) answering `standing`; restored after the test. The scratch
 * HOME and config home are applied to this process first, because the verb reads its store roots from the process
 * environment: without it the in-process call would read the developer's own settings (O-7: never a real model).
 */
function cliAtStanding(t: any, f: any, standing: string) {
  f.scratch.apply();
  t.after(() => f.scratch.restore());
  const trustPath = require.resolve('../../../src/runtime/advice/replay/trust.ts');
  const reload = [require.resolve('../../../src/runtime/advice/shadow-dispatcher.ts'), require.resolve('../../../src/runtime/advice/cli.ts')];
  const trust = require(trustPath);
  const saved = trust.evaluateTrust;
  trust.evaluateTrust = async () => ({ standing, reason: `injected ${standing}`, failedChecks: [], staleDigest: null, modelDigest: 'sha256:00' });
  for (const file of reload) delete require.cache[file];
  t.after(() => { trust.evaluateTrust = saved; for (const file of reload) delete require.cache[file]; });
  return require('../../../src/runtime/advice/cli.ts').handleAdviseCommand;
}

async function inProcess(handle: any, f: any, options: any) {
  let printed = '';
  const oldLog = console.log;
  const savedExit = process.exitCode;
  console.log = (text: any) => { printed += `${text}\n`; };
  try {
    await handle({ action: 'ask', actionGiven: true, projectRoot: f.project, env: f.scratch.env(), ...options });
  } finally { console.log = oldLog; process.exitCode = savedExit; }
  return printed;
}

for (const [kind, spec] of Object.entries(KINDS) as any) {
  for (const [setTo, standing, recorded] of [['act', 'act', 'act'], ['show', 'show', 'show'], ['show', 'act', 'show'], ['act', 'show', 'show']]) {
    test(`${kind}: ${setTo} at standing ${standing} shows the model's answer, with its pick id, and records a pick in mode ${recorded}`, async (t) => {
      const f = await fixture(t);
      f.settings({ advice: { kinds: { [kind]: setTo } } });
      const handle = cliAtStanding(t, f, standing);
      const common: any = { kind, state: 'The state.', staticAnswer: spec.args[spec.args.indexOf('--static') + 1] };
      if (kind === 'mcp-need') common.server = 'context7';
      const result = JSON.parse(await inProcess(handle, f, { ...common, json: true }));
      assert.equal(result.endpoint, f.server.origin, 'the scratch settings, never the developer\'s own model');
      assert.equal(result.status, 'answered');
      assert.deepEqual(Object.keys(result), ['status', 'reason', 'detail', 'provider', 'model', 'endpoint', 'decidedBy', 'durationMs', 'answers']);
      assert.equal(result.answers[0].kind, kind);
      assert.equal(result.answers[0].pick, spec.pick);
      assert.match(result.answers[0].pickId, /^adv-[0-9]{13}-[0-9a-f]{6}$/);
      assert.equal(f.asks(), 1);
      const picks = f.records().filter((r: any) => r.type === 'pick');
      assert.deepEqual(picks.map(({ pickId, mode, caller }: any) => ({ pickId, mode, caller })), [{ pickId: result.answers[0].pickId, mode: recorded, caller: 'advise' }]);
      const text = await inProcess(handle, f, common);
      assert.match(text, new RegExp(`^Advice \\(${kind}\\): ${spec.pick}, `));
    });
  }

  test(`${kind}: show below the show standing prints status: shadow with LOCAL_RESULT_UNMET and shows no answer`, async (t) => {
    const f = await fixture(t);
    f.settings({ advice: { kinds: { [kind]: 'show' } } });
    const handle = cliAtStanding(t, f, 'below-show');
    const common: any = { kind, state: 'The state.', staticAnswer: spec.args[spec.args.indexOf('--static') + 1] };
    if (kind === 'mcp-need') common.server = 'context7';
    const result = JSON.parse(await inProcess(handle, f, { ...common, json: true }));
    assert.equal(result.status, 'shadow');
    assert.equal(result.reason, 'LOCAL_RESULT_UNMET: below-show: injected below-show');
    assert.deepEqual(result.answers, []);
    // The detached child still asks once and records a shadow pick.
    await f.untilAsks(1);
    const until = Date.now() + 5000;
    while (Date.now() < until && f.records().length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(f.records().map(({ type, mode }: any) => ({ type, mode })), [{ type: 'pick', mode: 'shadow' }]);
  });
}
