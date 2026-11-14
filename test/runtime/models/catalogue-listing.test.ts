'use strict';
// `models --action sync` fills offeredModels from the harness's own listing command (worker.modelList), keeps
// the previous list marked stale when a listing fails, and records why a harness has none. The runner and the
// home directory are injected: no real CLI runs and no real home is read.

const test = require('node:test');
const assert = require('node:assert/strict');
const { suiteTempDir } = require('../../helper/tmp.ts');
const { syncHarness, syncAllHarnesses, readCatalogue } = require('../../../src/runtime/models/catalogue.ts');
const probes = require('../../../src/runtime/worker/probes/index.ts');

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
  assert.deepEqual(res.offeredModels, [{ id: 'anthropic/claude-x' }, { id: 'openai/gpt-y' }]);
  assert.deepEqual(res.modelList, { status: 'listed' });
  assert.ok(calls.some((c) => c.join(' ') === 'opencode models'));
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

test('the hard-coded model table is gone: a probe alone offers no models', async () => {
  assert.equal('DEFAULT_MODELS' in probes, false);
  const home = suiteTempDir('doflow-test-sync-home-');
  for (const id of ['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']) {
    const res = await probes.PROBES[id]({ execFileImpl: runner(LIST), homeDir: home, env: {} });
    assert.deepEqual(res.offeredModels, [], id);
  }
});

test('syncAllHarnesses carries each harness previous list into its own listing', async () => {
  const project = suiteTempDir('doflow-test-sync-project-');
  const home = suiteTempDir('doflow-test-sync-home-');
  const first = await syncAllHarnesses({ projectRoot: project, homeDir: home, env: {}, execFileImpl: runner(LIST) });
  assert.deepEqual(first.harnesses.opencode.offeredModels.map((m: any) => m.id), ['anthropic/claude-x', 'openai/gpt-y']);
  const second = await syncAllHarnesses({ projectRoot: project, homeDir: home, env: {}, execFileImpl: runner(new Error('offline')) });
  assert.equal(second.harnesses.opencode.modelList.stale, true);
  assert.deepEqual(second.harnesses.opencode.offeredModels.map((m: any) => m.id), ['anthropic/claude-x', 'openai/gpt-y']);
  assert.deepEqual(readCatalogue(project, { homeDir: home }).harnesses.opencode.modelList.status, 'failed');
  assert.equal(second.harnesses.claude.modelList.status, 'none-recorded');
});
