'use strict';

// Row 174 O-4: `doflow retrieve` makes no decision-model call. It used to ask the model, after printing, to reorder its
// first-stage candidates (the rerank kind, 141 IC-010); no setting or caller asks that kind any more. These cases keep a
// retrieve run from sending a request or writing an advice record even when the machine has advice on and still holds the
// removed `advice.kinds.rerank` setting of an older version, for the guidance branch and for `--scope code`.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { createSettingsEnv } = require('../helper/settings-fixtures.ts');
const { startFakeServer, answering } = require('../helper/fake-decision-server.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../src/runtime/advice/record.ts');
const { admitCodeCorpus } = require('../../src/runtime/knowledge/code-corpus.ts');
const { handleRetrieveCommand, handleCodeRetrieveCommand } = require('../../src/runtime/knowledge/retrieval.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const NO_RG = spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0 ? false : 'ripgrep (rg) is not installed';
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const tick = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` with console output and the exit status captured; the status is restored to what it was. */
async function capture(fn: () => any) {
  const out: string[] = [];
  const log = console.log; const error = console.error;
  const priorExit = process.exitCode;
  console.log = (...args: any[]) => { out.push(args.join(' ')); };
  console.error = (...args: any[]) => { out.push(args.join(' ')); };
  process.exitCode = undefined;
  try {
    await fn();
    return { out, exit: process.exitCode ?? 0 };
  } finally {
    console.log = log; console.error = error; process.exitCode = priorExit;
  }
}

/** Advice on against a fake decision server, with the removed per-kind rerank settings still in the user file. */
async function adviceOn(t: any) {
  const f = createSettingsEnv(t, { prefix: 'doflow-retrieve-no-call-' });
  const env = f.env();
  const roots = resolveRoots({ registry: STORAGE, projectRoot: f.project, env });
  const server: any = await startFakeServer({ routes: { 'POST /v1/systemone': answering() } });
  t.after(() => server.close());
  f.writeUserSettings({
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'fake-model',
    'advice.kinds.rerank': 'shadow', 'advice.models.rerank': 'fake-model',
  });
  const asks = () => server.requests.filter((request: any) => request.pathname === '/v1/systemone');
  const records = () => readWindow({ roots }).records.map((entry: any) => entry.record);
  return { f, env, roots, projectRoot: f.project, asks, records };
}

describe('retrieve makes no decision-model call', () => {
  test('guidance: the results print, no request reaches the model and no advice record is written', async (t) => {
    const s = await adviceOn(t);
    const configDir = path.join(s.f.dir, 'doflow-config');
    const guidance = path.join(configDir, 'guidance');
    fs.mkdirSync(guidance, { recursive: true });
    for (const name of ['one', 'two', 'three']) fs.writeFileSync(path.join(guidance, `${name}.md`), `calibration procedure ${name} ${'widget '.repeat(3)}\n`);
    const previous = process.env.DOFLOW_CONFIG_DIR;
    process.env.DOFLOW_CONFIG_DIR = configDir;
    t.after(() => { if (previous === undefined) delete process.env.DOFLOW_CONFIG_DIR; else process.env.DOFLOW_CONFIG_DIR = previous; });
    const run = () => capture(() => handleRetrieveCommand({ query: 'calibration widget', projectRoot: s.projectRoot, env: s.env }));
    const first = await run();
    const second = await run();
    await tick();
    assert.equal(second.exit, 0);
    assert.ok(second.out.filter((line) => /^\d+\. \[/.test(line)).length >= 2, `results printed: ${second.out.join(' | ')}`);
    assert.equal(first.exit, 0);
    assert.equal(s.asks().length, 0, 'no decision request');
    assert.deepEqual(s.records(), [], 'no pick or miss line');
  });

  describe('--scope code', { skip: NO_RG }, () => {
    test('the results print, no request reaches the model and no advice record is written', async (t) => {
      const s = await adviceOn(t);
      const root = tempDir(t, 'doflow-retrieve-no-call-code-');
      fs.mkdirSync(path.join(root, 'src'));
      const names: string[] = [];
      for (let i = 1; i <= 3; i += 1) {
        names.push(`src/mod${i}.js`);
        fs.writeFileSync(path.join(root, `src/mod${i}.js`), `function parseToken${i}(value) {\n  // parseToken refresh credentials for user ${i}\n  return value;\n}\n`);
      }
      const router: any = { capabilities: {
        'code.exact-search': { providers: [{ id: 'native.rg' }] },
        'code.semantic-search': { providers: [{ id: 'semble.search' }, { id: 'native.rg' }] },
      } };
      const result = await capture(() => handleCodeRetrieveCommand({
        query: 'parseToken', profile: 'lexical-only', root, projectRoot: s.projectRoot, env: s.env, scope: 'code',
        providers: { router, inventory: admitCodeCorpus({ root, files: names }) },
      }));
      await tick();
      assert.equal(result.exit, 0, result.out.join('\n'));
      assert.ok(result.out.some((line) => /src\/mod\d\.js:\d+-\d+/.test(line)), `results printed: ${result.out.join(' | ')}`);
      assert.equal(s.asks().length, 0, 'no decision request');
      assert.deepEqual(s.records(), [], 'no pick or miss line');
    });
  });
});
