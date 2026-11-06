'use strict';

// 141 B.5 (IC-010): the shadow rerank hooks of `doflow retrieve`, guidance and code scope. The advice client is a fake.
// The hook runs detached after the output is printed, so every case compares what the command printed, its exit
// status and its result order with the kind off, and reads the store only for what the detached call wrote.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../src/runtime/advice/record.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { handleRetrieveCommand, handleCodeRetrieveCommand, searchGuidance } = require('../../src/runtime/knowledge/retrieval.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const NO_RG = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'ripgrep (rg) is not installed';
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const SENTINEL_QUERY = 'sentinelquery4471';
const SENTINEL_CANDIDATE = 'sentinelcandidate9023';
const SHADOW = { kind: 'rerank', mode: 'shadow', model: 'm' };

/** The shipped registry with the rerank kind's params and budget replaced. */
function registryWith({ arm = 'choice', budgetMs = 5000, minCandidates }: any = {}) {
  const registry = JSON.parse(JSON.stringify(ADVICE));
  const kind = registry.kinds.find((entry: any) => entry.id === 'rerank');
  kind.params.arm = arm;
  kind.budgetMs = budgetMs;
  if (minCandidates !== undefined) kind.params.minCandidates = minCandidates;
  return registry;
}

/** A client that answers every rerank question set: label C is the model's favourite (choice), scores rise with the label (ladder). */
function answeringClient() {
  const calls: any[] = [];
  return {
    calls,
    ask: async (options: any) => {
      calls.push(options);
      const questions = options.questionSet.questions;
      if (questions.length === 1) {
        const labels = Object.keys(questions[0].options);
        const favourite = labels.includes('C') ? 'C' : labels[labels.length - 1];
        const probabilities = Object.fromEntries(labels.map((label) => [label, label === favourite ? 0.7 : 0.1]));
        return { status: 'answered', reason: null, model: 'm', answers: [{ name: 'rerank', type: 'choice', pick: favourite, strength: { word: 'clear', between: null }, probabilities, confidence: 0.7 }] };
      }
      return {
        status: 'answered', reason: null, model: 'm',
        answers: questions.map((question: any, index: number) => ({
          name: question.name, type: 'score', pick: question.criteria[Math.min(index, 4)], pickIndex: Math.min(index, 4),
          score: Math.min(index, 4) * 0.9, confidence: 0.6, criteria: question.criteria, strength: { word: 'clear', between: null },
          probabilities: { 0: 0.1, 1: 0.1, 2: 0.1, 3: 0.1, 4: 0.6 },
        })),
      };
    },
  };
}

function hangingClient() {
  const calls: any[] = [];
  return { calls, ask: (options: any) => { calls.push({ ...options, at: Date.now() }); return new Promise(() => {}); } };
}

function rejectingClient() {
  const calls: any[] = [];
  return { calls, ask: async (options: any) => { calls.push(options); throw new Error('client exploded'); } };
}

async function waitFor(check: () => any, ms = 2000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return check();
}

/** The retrieval attempt refs are fresh random ids on every run; everything else must match byte for byte. */
const stable = (lines: string[]) => lines.map((line) => line.replace(/ra-[0-9a-f-]{36}/g, 'ra-<id>'));

const tick = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` with console output and the exit status captured; the status is restored to what it was. */
async function capture(fn: () => any) {
  const out: string[] = [];
  const err: string[] = [];
  const log = console.log; const error = console.error;
  const priorExit = process.exitCode;
  console.log = (...args: any[]) => { out.push(args.join(' ')); };
  console.error = (...args: any[]) => { err.push(args.join(' ')); };
  process.exitCode = undefined;
  try {
    const returned = await fn();
    return { out, err, exit: process.exitCode ?? 0, returned };
  } finally {
    console.log = log; console.error = error; process.exitCode = priorExit;
  }
}

/** A project with a settings fixture, a record store, and a guidance tree at DOFLOW_CONFIG_DIR. */
function setup(t: any) {
  const f = createSettingsEnv(t, { prefix: 'doflow-retrieve-rerank-' });
  const env = f.env();
  const roots = resolveRoots({ registry: STORAGE, projectRoot: f.project, env });
  const configDir = path.join(f.dir, 'doflow-config');
  const guidance = path.join(configDir, 'guidance');
  fs.mkdirSync(guidance, { recursive: true });
  const padding = 'filler words '.repeat(30);
  // The sentinel sits past the 200-character printed snippet, so it appears only in the chunk text the hook sends.
  ['one', 'two', 'three', 'four', 'five'].forEach((name, index) => {
    fs.writeFileSync(path.join(guidance, `${name}.md`), `calibration procedure ${name} ${'widget '.repeat(index + 1)}${padding}${SENTINEL_CANDIDATE} ${name}\n`);
  });
  fs.writeFileSync(path.join(guidance, 'lonely.md'), `zebrafishuniqueterm only here ${padding}\n`);
  const previous = process.env.DOFLOW_CONFIG_DIR;
  process.env.DOFLOW_CONFIG_DIR = configDir;
  t.after(() => { if (previous === undefined) delete process.env.DOFLOW_CONFIG_DIR; else process.env.DOFLOW_CONFIG_DIR = previous; });
  const lines = () => readWindow({ roots }).records.map((entry: any) => entry.record);
  const storeText = () => {
    const dir = path.join(roots['project-state'], 'advice');
    const texts: string[] = [];
    const walk = (directory: string) => {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(full); else texts.push(fs.readFileSync(full, 'utf8'));
      }
    };
    walk(dir);
    return texts.join('');
  };
  return { f, env, roots, projectRoot: f.project, lines, storeText };
}

function guidance(s: any, { query = `calibration widget ${SENTINEL_QUERY}`, json = false, services = {}, top }: any = {}) {
  return capture(() => handleRetrieveCommand({
    query, json, top, projectRoot: s.projectRoot, env: s.env, adviceServices: { roots: s.roots, ...services },
  }));
}

describe('guidance retrieve: searchGuidance shortlist', () => {
  test('returns the first maxCandidates BM25 hits with chunk text, results unchanged, before graph expansion', async (t) => {
    const s = setup(t);
    const corpusDir = path.join(process.env.DOFLOW_CONFIG_DIR as string, 'guidance');
    const indexDir = path.join(process.env.DOFLOW_CONFIG_DIR as string, 'index', 'guidance');
    const small = searchGuidance({ corpusDir, indexDir, query: 'calibration widget', k: 2 });
    const wide = searchGuidance({ corpusDir, indexDir, query: 'calibration widget', k: 5 });
    assert.equal(small.results.length, 2);
    assert.deepEqual(small.results, wide.results.slice(0, 2), 'a smaller k is a prefix of the larger result list');
    assert.equal(small.shortlist.length, 5, 'the shortlist is independent of k');
    assert.deepEqual(small.shortlist.map((entry: any) => entry.ref), wide.results.map((entry: any) => entry.path));
    assert.ok(small.shortlist[0].text.includes(SENTINEL_CANDIDATE), 'text comes from the chunk, not the 200-character snippet');
    assert.ok(small.shortlist.every((entry: any) => typeof entry.title === 'string'));
    assert.equal(searchGuidance({ corpusDir, indexDir, query: 'calibration widget', k: 5, maxCandidates: 3 }).shortlist.length, 3);
    void s;
  });
});

describe('guidance retrieve: the shadow hook', () => {
  for (const arm of ['choice', 'ladder']) {
    test(`${arm} arm: output, JSON and exit status equal the kind-off run; one rerank pick is written with no query, candidate or criteria text`, async (t) => {
      const s = setup(t);
      const registry = registryWith({ arm });
      await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } }); // builds the index
      const offClient = answeringClient();
      const off = await guidance(s, { services: { adviceRegistry: registry, adviceClient: offClient, shadowConfig: { ...SHADOW, mode: 'off' } } });
      const offJson = await guidance(s, { json: true, services: { adviceRegistry: registry, adviceClient: offClient, shadowConfig: { ...SHADOW, mode: 'off' } } });
      await tick();
      assert.equal(offClient.calls.length, 0, 'kind off: no client call');
      assert.deepEqual(s.lines(), [], 'kind off: no file');

      const client = answeringClient();
      const on = await guidance(s, { services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
      const line = await waitFor(() => s.lines()[0]);
      assert.deepEqual(on.out, off.out, 'printed text is byte-identical with the kind on');
      assert.deepEqual(on.err, off.err);
      assert.equal(on.exit, off.exit);
      const onJson = await guidance(s, { json: true, services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
      assert.deepEqual(onJson.out, offJson.out, '--json content is byte-identical with the kind on');
      assert.equal(onJson.exit, offJson.exit);
      assert.ok(!on.out.join('\n').includes(SENTINEL_CANDIDATE) && !onJson.out.join('\n').includes(SENTINEL_CANDIDATE), 'the shortlist text is never printed');
      assert.equal(JSON.parse(onJson.out.join('\n')).shortlist, undefined);

      assert.equal(client.calls[0].kind, 'rerank');
      assert.equal(client.calls[0].caller, 'retrieve');
      assert.equal(client.calls[0].record, false);
      assert.equal(client.calls[0].staticAnswer, null);
      const questions = client.calls[0].questionSet.questions;
      assert.equal(questions.length, arm === 'choice' ? 1 : 5, 'one choice question, or one score question per candidate');
      assert.ok(JSON.stringify(client.calls[0].questionSet).includes(SENTINEL_CANDIDATE), 'the model is asked with the chunk text');
      assert.ok(client.calls[0].questionSet.state.includes(SENTINEL_QUERY));

      assert.equal(line.type, 'pick');
      assert.equal(line.kind, 'rerank');
      assert.equal(line.caller, 'retrieve');
      assert.equal(line.mode, 'shadow');
      assert.equal(line.static, 'A');
      assert.equal(line.rerank.arm, arm);
      assert.equal(line.rerank.n, 5);
      assert.deepEqual(line.rerank.refs.slice().sort(), ['five.md', 'four.md', 'one.md', 'three.md', 'two.md']);
      assert.equal(line.rerank.criteriaSource, 'registry');
      assert.match(line.rerank.criteriaDigest, /^[0-9a-f]{12}$/);
      assert.ok(Number.isInteger(line.rerank.firstStageMs));
      if (arm === 'choice') assert.equal(line.pick, 'C');
      else assert.deepEqual(line.rerank.order, ['E', 'D', 'C', 'B', 'A']);
      const stored = s.storeText();
      assert.ok(stored.length > 0);
      for (const sentinel of [SENTINEL_QUERY, SENTINEL_CANDIDATE]) assert.equal(stored.includes(sentinel), false, `${sentinel} is not stored`);
    });
  }

  test('a rejecting client leaves the output and exit status unchanged and records a miss', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const off = await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = rejectingClient();
    const on = await guidance(s, { services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    assert.deepEqual(on.out, off.out);
    assert.equal(on.exit, off.exit);
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(client.calls.length, 1);
    assert.equal(line.type, 'miss');
    assert.equal(line.kind, 'rerank');
  });

  test('a client that throws synchronously, or a registry that cannot be read, is swallowed', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const off = await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const throwing = { ask: () => { throw new Error('sync boom'); } };
    for (const services of [{ adviceRegistry: registry, adviceClient: throwing, shadowConfig: SHADOW }, { adviceRegistry: { kinds: 'broken' }, shadowConfig: SHADOW }, { shadowConfig: { mode: 'shadow' }, adviceRegistry: { kinds: [{ id: 'rerank', params: null }] } }]) {
      const on = await guidance(s, { services });
      assert.deepEqual(on.out, off.out);
      assert.equal(on.exit, off.exit);
    }
  });

  test('a hanging client: the handler returns first, the call is aborted at budgetMs and recorded as a timeout', async (t) => {
    const s = setup(t);
    const registry = registryWith({ budgetMs: 120 });
    await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = hangingClient();
    const startedAt = Date.now();
    const on = await guidance(s, { services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    const returnedAt = Date.now();
    assert.equal(on.exit, 0);
    assert.ok(returnedAt - startedAt < 120, `the handler did not wait for the call (${returnedAt - startedAt} ms)`);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].signal.aborted, false, 'the call is still running when the handler returns');
    await waitFor(() => client.calls[0].signal.aborted, 1500);
    const abortedAfter = Date.now() - client.calls[0].at;
    assert.equal(client.calls[0].signal.aborted, true);
    assert.ok(abortedAfter >= 100 && abortedAfter < 1000, `aborted at the budget (${abortedAfter} ms)`);
    const line = await waitFor(() => s.lines()[0]);
    assert.deepEqual([line.type, line.reason, line.mode], ['miss', 'timeout', 'shadow']);
  });

  test('a registry timeout budget does not apply: the kind\'s budgetMs bounds the detached call', async (t) => {
    const s = setup(t);
    const registry = registryWith({ budgetMs: 90 });
    registry.timeoutMs = 15000;
    await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = hangingClient();
    await guidance(s, { services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    await waitFor(() => client.calls[0].signal.aborted, 1500);
    assert.ok(Date.now() - client.calls[0].at < 1000);
  });

  test('fewer than two candidates: no call and no file, output unchanged', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    await guidance(s, { query: 'zebrafishuniqueterm', services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const off = await guidance(s, { query: 'zebrafishuniqueterm', services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = answeringClient();
    const on = await guidance(s, { query: 'zebrafishuniqueterm', services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    await tick();
    assert.equal(on.out.length > 0, true);
    assert.deepEqual(on.out, off.out);
    assert.equal(client.calls.length, 0);
    assert.deepEqual(s.lines(), []);
    const none = await guidance(s, { query: 'nothingmatchesthisqueryatall', services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    assert.deepEqual(none.out, ['[OK] No matching guidance found.']);
    await tick();
    assert.equal(client.calls.length, 0);
  });

  test('a candidate count below the registry minCandidates asks nothing', async (t) => {
    const s = setup(t);
    const registry = registryWith({ minCandidates: 6 });
    await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = answeringClient();
    await guidance(s, { services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    await tick();
    assert.equal(client.calls.length, 0);
  });

  test('act configured: held at shadow with the warning, the output equals the kind-off run, the line says shadow', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const off = await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = answeringClient();
    const neverGate = () => { throw new Error('the bench gate must not be reached'); };
    const on = await guidance(s, { services: { adviceRegistry: registry, adviceClient: client, benchGate: neverGate, shadowConfig: { ...SHADOW, mode: 'act' } } });
    assert.deepEqual(on.out, off.out, 'no warning is printed and the order is the first-stage order');
    assert.deepEqual(on.err, off.err);
    assert.equal(on.exit, off.exit);
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(line.mode, 'shadow');
    assert.equal(line.elevated, false);
    assert.equal(client.calls.length, 1);
  });

  test('kind off through the real settings: no client call and no file; shadow through the settings asks once', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    const settings = (mode?: string) => s.f.writeUserSettings({
      schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': 'http://127.0.0.1:11434', 'advice.model': 'clef-flash',
      ...(mode ? { 'advice.kinds.rerank': mode } : {}),
    });
    settings();
    await guidance(s, { services: { adviceRegistry: registry, adviceClient: answeringClient() } }); // builds the index
    const off = await guidance(s, { services: { adviceRegistry: registry, adviceClient: answeringClient() } });
    const client = answeringClient();
    await guidance(s, { services: { adviceRegistry: registry, adviceClient: client } });
    await tick();
    assert.equal(client.calls.length, 0);
    assert.deepEqual(s.lines(), []);

    settings('shadow');
    const on = await guidance(s, { services: { adviceRegistry: registry, adviceClient: client } });
    assert.deepEqual(on.out, off.out);
    await waitFor(() => s.lines()[0]);
    assert.equal(client.calls.length, 1);
    assert.equal(client.calls[0].model, 'clef-flash', 'the model of the settings is the one asked');

    s.f.writeUserSettings({ schema: 1, 'advice.enabled': false, 'advice.kinds.rerank': 'shadow' });
    const disabled = answeringClient();
    await guidance(s, { services: { adviceRegistry: registry, adviceClient: disabled } });
    await tick();
    assert.equal(disabled.calls.length, 0, 'advice off: no call');
  });

  test('a refused criteria setting does not change what is printed', async (t) => {
    const s = setup(t);
    const registry = registryWith();
    s.f.writeUserSettings({
      schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': 'http://127.0.0.1:11434', 'advice.model': 'clef-flash',
      'advice.kinds.rerank': 'shadow', 'advice.criteria.rerank': 'only one line',
    });
    await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const off = await guidance(s, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const client = answeringClient();
    const on = await guidance(s, { services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    assert.deepEqual(on.out, off.out);
    assert.deepEqual(on.err, off.err, 'the criteria warning is not printed by retrieve');
    const line = await waitFor(() => s.lines()[0]);
    assert.equal(line.rerank.criteriaSource, 'registry');
  });
});

describe('code retrieve: the shadow hook', { skip: NO_RG }, () => {
  const router: any = { capabilities: {
    'code.exact-search': { providers: [{ id: 'native.rg' }] },
    'code.semantic-search': { providers: [{ id: 'semble.search' }, { id: 'native.rg' }] },
  } };

  function codeFixture(t: any, files = 4) {
    const s = setup(t);
    const root = tempDir(t, 'doflow-retrieve-rerank-code-');
    fs.mkdirSync(path.join(root, 'src'));
    const names: string[] = [];
    for (let i = 1; i <= files; i += 1) {
      names.push(`src/mod${i}.js`);
      fs.writeFileSync(path.join(root, `src/mod${i}.js`), `function parseToken${i}(value) {\n  // parseToken refresh credentials for user ${i}\n  return value;\n}\n`);
    }
    return { ...s, root, inventory: admitCodeCorpus({ root, files: names }) };
  }

  function code(c: any, { query = 'parseToken', profile = 'lexical-only', json = false, services = {}, providers = {} }: any = {}) {
    return capture(() => handleCodeRetrieveCommand({
      query, profile, json, root: c.root, projectRoot: c.projectRoot, env: c.env, scope: 'code',
      providers: { router, inventory: c.inventory, ...providers }, adviceServices: { roots: c.roots, ...services },
    }));
  }

  const failSemantic = { semanticQuery: async () => ({ ok: false, reason: 'provider-unavailable', freshness: 'UNKNOWN', candidates: [] }) };

  for (const [label, profile, query, extra] of [
    ['exact query, lexical-only', 'lexical-only', 'parseToken', {}],
    ['exact query, hybrid', 'hybrid', 'parseToken', {}],
    ['conceptual query, hybrid with the semantic provider down', 'hybrid', 'refresh credentials for user', { providers: failSemantic, modelPath: '/fake/model' }],
  ] as any[]) {
    for (const arm of ['choice', 'ladder']) {
      test(`${label}, ${arm} arm: text and JSON equal the kind-off run; one rerank pick keyed by file:line`, async (t) => {
        const c = codeFixture(t);
        const registry = registryWith({ arm });
        const options = { query, profile, ...extra };
        const off = await code(c, { ...options, services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
        const offJson = await code(c, { ...options, json: true, services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
        await tick();
        assert.deepEqual(c.lines(), [], 'kind off: no file');
        assert.ok(off.out.length >= 2, `the first stage found candidates: ${off.out.join('|')} ${off.err.join('|')}`);

        const client = answeringClient();
        const on = await code(c, { ...options, services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
        assert.deepEqual(on.out, off.out);
        assert.deepEqual(on.err, off.err);
        assert.equal(on.exit, off.exit);
        const onJson = await code(c, { ...options, json: true, services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
        assert.deepEqual(stable(onJson.out), stable(offJson.out));
        const line = await waitFor(() => c.lines()[0]);
        assert.equal(line.type, 'pick');
        assert.equal(line.rerank.arm, arm);
        assert.ok(line.rerank.n >= 2);
        assert.ok(line.rerank.refs.every((ref: string) => /^src\/mod\d\.js:\d+$/.test(ref)), line.rerank.refs.join(','));
        assert.ok(client.calls[0].questionSet.state.includes('query: '));
        const stored = c.storeText();
        assert.equal(stored.includes('parseToken refresh'), false, 'no snippet text is stored');
        assert.equal(stored.includes('refresh credentials for user'), false, 'no query text is stored');
      });
    }
  }

  test('fewer than two results, a rejecting client and a hanging client leave the command alone', async (t) => {
    const c = codeFixture(t, 1);
    const registry = registryWith({ budgetMs: 100 });
    const client = answeringClient();
    const single = await code(c, { query: 'parseToken1', services: { adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW } });
    await tick();
    assert.equal(single.exit, 0);
    assert.equal(client.calls.length, 0);
    assert.deepEqual(c.lines(), []);

    const many = codeFixture(t, 4);
    const off = await code(many, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const rejecting = rejectingClient();
    const afterReject = await code(many, { services: { adviceRegistry: registry, adviceClient: rejecting, shadowConfig: SHADOW } });
    assert.deepEqual(afterReject.out, off.out);
    assert.equal(rejecting.calls.length, 1);
    const hanging = hangingClient();
    const startedAt = Date.now();
    const afterHang = await code(many, { services: { adviceRegistry: registry, adviceClient: hanging, shadowConfig: SHADOW } });
    assert.ok(Date.now() - startedAt < 100 + 1000);
    assert.deepEqual(afterHang.out, off.out);
    assert.equal(hanging.calls.length, 1);
    await waitFor(() => hanging.calls[0].signal.aborted, 1500);
    assert.equal(hanging.calls[0].signal.aborted, true);
  });

  test('an index action, a failed retrieval and act configured ask nothing new or stay at shadow', async (t) => {
    const c = codeFixture(t);
    const registry = registryWith();
    const client = answeringClient();
    const bad = await capture(() => handleCodeRetrieveCommand({
      query: 'parseToken', profile: 'bogus', root: c.root, projectRoot: c.projectRoot, env: c.env, scope: 'code',
      providers: { router, inventory: c.inventory }, adviceServices: { roots: c.roots, adviceRegistry: registry, adviceClient: client, shadowConfig: SHADOW },
    }));
    await tick();
    assert.equal(bad.exit, 2);
    assert.equal(client.calls.length, 0, 'a failed retrieval has no first stage to rerank');

    const off = await code(c, { services: { adviceRegistry: registry, shadowConfig: { ...SHADOW, mode: 'off' } } });
    const acting = await code(c, { services: { adviceRegistry: registry, adviceClient: client, benchGate: () => { throw new Error('no gate'); }, shadowConfig: { ...SHADOW, mode: 'act' } } });
    assert.deepEqual(acting.out, off.out);
    const line = await waitFor(() => c.lines()[0]);
    assert.equal(line.mode, 'shadow');
  });
});
