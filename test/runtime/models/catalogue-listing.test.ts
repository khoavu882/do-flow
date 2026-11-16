'use strict';
// `models --action sync` fills offeredModels from the harness's own listing command (worker.modelList), keeps
// the previous list marked stale when a listing fails, and records why a harness has none. The runner and the
// home directory are injected: no real CLI runs and no real home is read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../../helper/tmp.ts');
const { syncHarness, syncAllHarnesses, readCatalogue } = require('../../../src/runtime/models/catalogue.ts');

const LIST = 'anthropic/claude-x\nopenai/gpt-y\n';

/** A callback-style execFile: `--version` answers, `models` answers `listing` (a string, or an Error to fail with). */
function runner(listing: string | Error, calls: string[][] = []) {
  return (bin: string, args: string[], _opts: any, cb: any) => {
    calls.push([bin, ...args]);
    if (args[0] === 'models') {
      if (listing instanceof Error) cb(listing, '', '');
      else cb(null, listing, '');
    } else cb(null, '1.2.3', '');
  };
}

test('sync fills offeredModels from the listing command and marks the list as listed', async () => {
  const home = suiteTempDir('doflow-test-sync-home-');
  const calls: string[][] = [];
  const res = await syncHarness('opencode', { execFileImpl: runner(LIST, calls), homeDir: home, env: {} });
  assert.deepEqual(res.offeredModels, [{ id: 'claude-x', provider: 'anthropic' }, { id: 'gpt-y', provider: 'openai' }]);
  assert.deepEqual(res.modelList, { status: 'listed' });
  assert.ok(calls.some((c) => c.join(' ') === 'opencode models'));
});

test('sync keeps only usable ids and records how many were left out and whether the list was cut', async () => {
  const home = suiteTempDir('doflow-test-sync-home-');
  const dropped = await syncHarness('opencode', { execFileImpl: runner('--foo\nok/model\n-x\n'), homeDir: home, env: {} });
  assert.deepEqual(dropped.offeredModels, [{ id: 'model', provider: 'ok' }]);
  assert.deepEqual(dropped.modelList, { status: 'listed', dropped: 2 });
  const many = await syncHarness('opencode', { execFileImpl: runner(Array.from({ length: 1200 }, (_, i) => `p/m${i}`).join('\n')), homeDir: home, env: {} });
  assert.equal(many.offeredModels.length, 500);
  assert.deepEqual(many.modelList, { status: 'listed', capped: true });
});

test('a harness with no listing command gets an empty list and a field saying why', async () => {
  const home = suiteTempDir('doflow-test-sync-home-');
  const calls: string[][] = [];
  const res = await syncHarness('claude', { execFileImpl: runner(LIST, calls), homeDir: home, env: {} });
  assert.deepEqual(res.offeredModels, []);
  assert.equal(res.modelList.status, 'none-recorded');
  assert.match(res.modelList.reason, /\S/);
  assert.equal(calls.some((c) => c[1] === 'models'), false, 'nothing is asked of a harness with no listing command');
});

test('a failed listing keeps the previous list, marked stale, and is not an error', async () => {
  const home = suiteTempDir('doflow-test-sync-home-');
  const previous = {
    ...(await syncHarness('opencode', { execFileImpl: runner(LIST), homeDir: home, env: {} })),
  };
  const res = await syncHarness('opencode', { execFileImpl: runner(new Error('not logged in')), homeDir: home, env: {}, previous });
  assert.deepEqual(res.offeredModels, previous.offeredModels);
  assert.equal(res.modelList.status, 'failed');
  assert.equal(res.modelList.stale, true);
  assert.match(res.modelList.reason, /opencode models/);
});

test('a failed listing with no previous list leaves the list empty and not stale', async () => {
  const home = suiteTempDir('doflow-test-sync-home-');
  const res = await syncHarness('opencode', { execFileImpl: runner(new Error('offline')), homeDir: home, env: {}, previous: null });
  assert.deepEqual(res.offeredModels, []);
  assert.equal(res.modelList.status, 'failed');
  assert.equal(res.modelList.stale, undefined);
});

test('a list written before the listing path existed (no modelList field) is not kept as stale', async () => {
  const home = suiteTempDir('doflow-test-sync-home-');
  const legacy: any = { harnessId: 'opencode', offeredModels: [{ id: 'old-hard-coded-name' }] };
  const res = await syncHarness('opencode', { execFileImpl: runner(new Error('offline')), homeDir: home, env: {}, previous: legacy });
  assert.deepEqual(res.offeredModels, []);
});

test('syncAllHarnesses carries each harness previous list into its own listing', async () => {
  const project = suiteTempDir('doflow-test-sync-project-');
  const home = suiteTempDir('doflow-test-sync-home-');
  const first = await syncAllHarnesses({ projectRoot: project, homeDir: home, env: {}, execFileImpl: runner(LIST) });
  assert.deepEqual(first.harnesses.opencode.offeredModels.map((m: any) => m.id), ['claude-x', 'gpt-y']);
  const second = await syncAllHarnesses({ projectRoot: project, homeDir: home, env: {}, execFileImpl: runner(new Error('offline')) });
  assert.equal(second.harnesses.opencode.modelList.stale, true);
  assert.deepEqual(second.harnesses.opencode.offeredModels.map((m: any) => m.id), ['claude-x', 'gpt-y']);
  assert.deepEqual(readCatalogue(project, { homeDir: home }).harnesses.opencode.modelList.status, 'failed');
  assert.equal(second.harnesses.claude.modelList.status, 'none-recorded');
});

test('169 sync stores the listed columns per model and records which columns were read', async () => {
  const { loadRegistry } = require('../../../src/registry/index.ts');
  const { createScratch, childEnv } = require('../../helper/scratch-env.ts');
  const { linkBin, writeScenario } = require('../../helper/fake-harness-cli.ts');
  const repo = path.resolve(__dirname, '..', '..', '..');
  const pi = fs.readFileSync(path.join(repo, 'test', 'fixtures', 'worker', 'model-lists', 'pi-list-models.txt'), 'utf8');
  const scratch = createScratch('doflow-catalogue-columns-');
  const env = childEnv(scratch, { PATH: linkBin(path.join(scratch.dir, 'bin'), ['pi']), FAKE_HARNESS_SCENARIO: writeScenario(scratch.dir, { byArgv: [
    { argv: ['--version'], steps: [{ print: 'pi 1.5.2' }, { exit: 0 }] },
    { argv: ['--list-models'], steps: [{ print: pi }, { exit: 0 }] },
  ] }), FAKE_HARNESS_LOG: path.join(scratch.dir, 'log.jsonl') });
  const registry = structuredClone(loadRegistry({ repoRoot: repo }));
  const worker = registry.harnesses.find((h: any) => h.id === 'pi').worker;
  worker.provider = { status: 'supported', via: 'flag', argv: ['--provider', '{provider}'], evidence: ['x'], verification: 'x', verifiedOn: '2026-11-16' };
  worker.effort = { status: 'supported', via: 'flag', argv: ['--thinking', '{effort}'], levels: ['off', 'low', 'high'], evidence: ['x'], verification: 'x', verifiedOn: '2026-11-16' };
  worker.modelList = { ...worker.modelList, columns: { provider: 'provider', contextTokens: 'context', maxOutputTokens: 'max-out', reasoning: 'thinking', imageInput: 'images' } };
  const view = { packages: [], stateRead: { state: {} }, grants: { grants: [] } };
  const home = suiteTempDir('doflow-test-sync-home-');
  // The listing runs the scratch `pi` (the fake), found on the scratch PATH: the default exec would look at the real PATH.
  const { findOnPath } = require('../../../src/runtime/worker/readiness.ts');
  const listExecImpl = (_file: string, args: string[]) => new Promise((resolve, reject) => {
    require('node:child_process').execFile(findOnPath('pi', env, process.platform, scratch.dir), args, { env, encoding: 'utf8' }, (err: any, out: string) => (err ? reject(err) : resolve(out)));
  });
  const res = await syncHarness('pi', { env, registry, view, homeDir: home, projectRoot: suiteTempDir('doflow-test-sync-project-'), listExecImpl });
  assert.equal(res.installed, true);
  assert.deepEqual(res.modelList, { status: 'listed', columns: ['provider', 'contextTokens', 'maxOutputTokens', 'reasoning', 'imageInput'] });
  assert.equal(res.offeredModels.length, 10);
  assert.deepEqual(res.offeredModels.find((m: any) => m.provider === 'openai-codex' && m.id === 'gpt-6.1-terra'), { id: 'gpt-6.1-terra', provider: 'openai-codex', contextTokens: 500000, maxOutputTokens: 128000, reasoning: true, imageInput: true });
});
