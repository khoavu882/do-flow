'use strict';
// 169 IC-004 (T5): `models --action bind` with --provider and --effort, `list` and `describe` with the provider and
// listing columns, against a test-only Pi-shaped descriptor (the shipped harnesses.json gets its entries in T6) and a
// catalogue seeded from the recorded `pi --list-models` fixture. No harness CLI runs: the listing parser is fed the
// fixture text directly, and settings live in a scratch config home.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../helper/tmp.ts');
const { handleModelsCommand } = require('../../../src/runtime/models/command.ts');
const { writeCatalogue } = require('../../../src/runtime/models/catalogue.ts');
const { listHarnessModels } = require('../../../src/runtime/models/list-models.ts');
const { loadRegistry } = require('../../../src/registry/index.ts');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');

const PI_LIST = fs.readFileSync(path.join(REPO_ROOT, 'test', 'fixtures', 'worker', 'model-lists', 'pi-list-models.txt'), 'utf8');
const NOW = new Date().toISOString();
const evidence = { evidence: ['test'], verification: 'test', verifiedOn: '2026-11-17' };
const VIEW = { packages: [], stateRead: { state: {} }, grants: { grants: [] } };

/** The shipped registry with Pi given a provider and an effort entry, and codex given `unknown` entries with reasons. */
function testRegistry() {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO_ROOT }));
  const pi = registry.harnesses.find((h: any) => h.id === 'pi').worker;
  pi.provider = { status: 'supported', via: 'id-prefix', separator: '/', ...evidence };
  pi.effort = { status: 'supported', via: 'flag', argv: ['--thinking', '{effort}'], levels: ['off', 'low', 'medium', 'high'], offLevel: 'off', mayLower: true, ...evidence };
  pi.modelList = { ...pi.modelList, columns: { provider: 'provider', contextTokens: 'context', maxOutputTokens: 'max-out', reasoning: 'thinking', imageInput: 'images' } };
  const codex = registry.harnesses.find((h: any) => h.id === 'codex').worker;
  codex.provider = { status: 'unknown', evidence: [], verification: 'record the check', verifiedOn: '2026-11-17', reason: 'no codex help line shows a provider' };
  codex.effort = { status: 'unknown', evidence: [], verification: 'record the check', verifiedOn: '2026-11-17', reason: 'the codex effort flag is not recorded' };
  return registry;
}

function setup(t: any) {
  const root = tempDir(t, 'doflow-bind-169-');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const env: any = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'config'), PATH: bin };
  delete env.DOFLOW_CONFIG_DIR;
  const settingsFile = path.join(root, 'config', 'doflow', 'settings.json');
  const registry = testRegistry();
  const bindings = () => (fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['workers.models'] : undefined);
  const raw = () => (fs.existsSync(settingsFile) ? fs.readFileSync(settingsFile, 'utf8') : null);
  const seed = async (harnesses: any) => writeCatalogue({ version: 1, syncedAt: NOW, harnesses }, project);
  const seedPi = async () => {
    const listing = await listHarnessModels({ descriptor: registry.harnesses.find((h: any) => h.id === 'pi').worker, execImpl: async () => PI_LIST });
    assert.equal(listing.status, 'listed');
    await seed({
      pi: { harnessId: 'pi', binary: 'pi', installed: true, version: '1', detectedMode: 'subscription', derivedBilling: 'free', offeredModels: listing.models, lastSyncedAt: NOW, modelList: { status: 'listed', columns: listing.columns } },
      codex: { harnessId: 'codex', binary: 'codex', installed: true, version: '1', detectedMode: 'subscription', derivedBilling: 'free', offeredModels: [], lastSyncedAt: NOW, modelList: { status: 'none-recorded', reason: 'x' } },
    });
  };
  return { root, project, env, settingsFile, registry, bindings, raw, seed, seedPi };
}

async function run(args: any) {
  let out = '';
  let err = '';
  const log = console.log;
  const error = console.error;
  console.log = (msg: any) => { out += `${msg}\n`; };
  console.error = (msg: any) => { err += `${msg}\n`; };
  try {
    const code = await handleModelsCommand({ actionGiven: true, json: false, interactive: false, ...args });
    return { code, out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const call = (s: any, action: string, extra: any = {}) => run({ action, projectRoot: s.project, env: s.env, syncOptions: { registry: s.registry, view: VIEW }, ...extra });
const bind = (s: any, extra: any) => call(s, 'bind', { json: true, ...extra });

/** A refused bind: exit 1, the error code, and the settings file byte-identical (nothing written). */
async function refused(s: any, extra: any, error: string) {
  const before = s.raw();
  const res = await bind(s, extra);
  assert.equal(res.code, 1, res.out + res.err);
  const body = JSON.parse(res.out);
  assert.equal(body.ok, false);
  assert.equal(body.error, error);
  assert.equal(s.raw(), before, 'a refusal writes nothing');
  return body;
}

test('effort-unsupported carries the entry reason and says not supported on the harness; an absent entry counts as unknown', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const body = await refused(s, { harness: 'codex', tier: 'light', model: 'my-model', effort: 'high' }, 'effort-unsupported');
  assert.match(body.message, /not supported on codex/);
  assert.match(body.message, /the codex effort flag is not recorded/);
  const provider = await refused(s, { harness: 'codex', tier: 'light', model: 'my-model', provider: 'openai' }, 'provider-unsupported');
  assert.match(provider.message, /not supported on codex.*no codex help line shows a provider/);
  // claude has no provider entry in the test registry at all: absent reads as unknown.
  const absent = await refused(s, { harness: 'claude', tier: 'light', model: 'my-model', provider: 'openai' }, 'provider-unsupported');
  assert.match(absent.message, /not supported on claude/);
});

test('effort-unknown-level lists the closed levels', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const body = await refused(s, { harness: 'pi', tier: 'light', model: 'claude-fable-5', provider: 'anthropic', effort: 'ultra' }, 'effort-unknown-level');
  assert.match(body.message, /off, low, medium, high/);
});

test('ambiguous-model lists both providers and needs --provider', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const body = await refused(s, { harness: 'pi', tier: 'standard', model: 'gpt-6.1-terra' }, 'ambiguous-model');
  assert.deepEqual([...body.providers].sort(), ['openai', 'openai-codex']);
  assert.match(body.message, /--provider/);
});

test('effort-not-offered when the catalogue entry has reasoning false and the effort is not the off level', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  await refused(s, { harness: 'pi', tier: 'light', model: 'gpt-4', provider: 'openai', effort: 'low' }, 'effort-not-offered');
  const off = await bind(s, { harness: 'pi', tier: 'light', model: 'gpt-4', provider: 'openai', effort: 'off' });
  assert.equal(off.code, 0, off.out + off.err);
  assert.deepEqual(s.bindings(), { pi: { light: { model: 'gpt-4', provider: 'openai', effort: 'off' } } });
});

test('unlisted-model still refuses with the closest ids, and --allow-unlisted binds it', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const body = await refused(s, { harness: 'pi', tier: 'light', model: 'gpt-6-lunaa' }, 'unlisted-model');
  assert.ok(body.closest.includes('gpt-6-luna'));
  const allowed = await bind(s, { harness: 'pi', tier: 'light', model: 'gpt-6-lunaa', allowUnlisted: true });
  assert.equal(allowed.code, 0, allowed.out + allowed.err);
  const parsed = JSON.parse(allowed.out);
  assert.equal(parsed.checked, 'unlisted-allowed');
  assert.equal(parsed.check.model, 'not-listed');
});

test('--provider openai --effort low writes the object with only the non-null keys, and the JSON carries the checks', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const res = await bind(s, { harness: 'pi', tier: 'standard', model: 'gpt-6.1-terra', provider: 'openai', effort: 'low' });
  assert.equal(res.code, 0, res.out + res.err);
  const body = JSON.parse(res.out);
  assert.deepEqual(s.bindings(), { pi: { standard: { model: 'gpt-6.1-terra', provider: 'openai', effort: 'low' } } });
  assert.equal(body.provider, 'openai');
  assert.equal(body.effort, 'low');
  assert.equal(body.checked, 'listed');
  assert.deepEqual(body.check, { model: 'listed', effort: 'unchecked' });
  const providerOnly = await bind(s, { harness: 'pi', tier: 'light', model: 'gpt-6.1-terra', provider: 'openai-codex' });
  assert.equal(providerOnly.code, 0);
  assert.deepEqual(s.bindings().pi.light, { model: 'gpt-6.1-terra', provider: 'openai-codex' });
});

test('with no --provider and no --effort the plain id string is written, as before', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const res = await bind(s, { harness: 'pi', tier: 'frontier', model: 'claude-fable-5' });
  assert.equal(res.code, 0, res.out + res.err);
  assert.equal(s.bindings().pi.frontier, 'claude-fable-5');
  const body = JSON.parse(res.out);
  assert.equal(body.provider, null);
  assert.equal(body.effort, null);
  assert.deepEqual(body.check, { model: 'listed', effort: null });
});

test('a harness with none-recorded binds with check.model unchecked', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const res = await bind(s, { harness: 'codex', tier: 'light', model: 'typed-id' });
  assert.equal(res.code, 0, res.out + res.err);
  const body = JSON.parse(res.out);
  assert.equal(body.checked, 'unchecked');
  assert.equal(body.check.model, 'unchecked');
});

test('text output is Bound <harness> <tier> = <bindingText> (wrote <file>)', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const res = await call(s, 'bind', { harness: 'pi', tier: 'standard', model: 'gpt-6.1-terra', provider: 'openai', effort: 'low' });
  assert.equal(res.code, 0, res.err);
  assert.equal(res.out.trim(), `Bound pi standard = gpt-6.1-terra (provider openai, effort low) [effort unchecked, the harness may lower the effort] (wrote ${s.settingsFile}).`);
});

test('a malformed --provider or --effort is a usage fault (exit 2) and writes nothing', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  for (const extra of [{ provider: '-bad' }, { provider: 'has space' }, { effort: '-x' }, { effort: 'a'.repeat(40) }]) {
    const res = await bind(s, { harness: 'pi', tier: 'light', model: 'claude-fable-5', ...extra });
    assert.equal(res.code, 2, JSON.stringify(extra));
  }
  assert.equal(s.raw(), null);
});

test('the picker rows show id (provider p) and a picked row with a provider writes it', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  fs.writeFileSync(path.join(s.env.PATH, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const listExecImpl = async () => PI_LIST;
  const res = await call(s, 'bind', {
    harness: 'pi', tier: 'light', interactive: true, ask: () => '9', // row 9 is gpt-6-luna under openai-codex
    syncOptions: { registry: s.registry, view: VIEW, listExecImpl, execFileImpl: (_b: string, _a: string[], _o: any, cb: any) => cb(null, 'pi 1.5.2', '') },
  });
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /gpt-6-luna \(provider openai-codex\)/);
  assert.deepEqual(s.bindings().pi.light, { model: 'gpt-6-luna', provider: 'openai-codex' });
});

test('list prints the IC-005 cell per tier and "-" for a column the harness does not list', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  fs.writeFileSync(path.join(s.env.PATH, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await bind(s, { harness: 'pi', tier: 'standard', model: 'gpt-6.1-terra', provider: 'openai', effort: 'low' });
  const json = JSON.parse((await call(s, 'list', { json: true })).out);
  const pi = json.harnesses.find((h: any) => h.harness === 'pi');
  assert.deepEqual(pi.standard, { model: 'gpt-6.1-terra', provider: 'openai', effort: 'low', check: { model: 'listed', effort: 'unchecked' }, effortMayLower: true });
  assert.equal(pi.light, null);
  const piRow = json.models.find((m: any) => m.harness === 'pi' && m.model === 'gpt-6-luna');
  assert.equal(piRow.provider, 'openai-codex');
  assert.equal(piRow.contextTokens, 272000);
  const codexRow = json.models.find((m: any) => m.harness === 'codex');
  assert.equal(codexRow, undefined, 'codex lists nothing');

  // A harness that lists names only: its columns print "-".
  await s.seed({
    opencode: { harnessId: 'opencode', binary: 'opencode', installed: true, version: '1', detectedMode: 'subscription', derivedBilling: 'free', offeredModels: [{ id: 'openai/gpt-x' }], lastSyncedAt: NOW, modelList: { status: 'listed' } },
  });
  const text = (await call(s, 'list')).out;
  assert.match(text, /PROVIDER\s+CONTEXT\s+MAX OUT\s+REASONING\s+IMAGES/);
  assert.match(text, /opencode\s+openai\/gpt-x\s.*\s-\s+-\s+-\s+-\s+-/);
  assert.match(text, /- = not listed by the harness/);
});

test('describe --model groups offerings by harness and provider with the same columns; JSON offerings carry only the fields the entry has', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  const res = await call(s, 'describe', { model: 'gpt-6.1-terra', json: true });
  assert.equal(res.code, 0, res.err);
  const detail = JSON.parse(res.out);
  const offers = detail.harnesses.find((h: any) => h.harnessId === 'pi').offerings;
  assert.deepEqual(offers.map((o: any) => o.provider).sort(), ['openai', 'openai-codex']);
  assert.deepEqual(offers.find((o: any) => o.provider === 'openai-codex'), { provider: 'openai-codex', contextTokens: 500000, maxOutputTokens: 128000, reasoning: true, imageInput: true });
  const one = JSON.parse((await call(s, 'describe', { model: 'gpt-6.1-terra', provider: 'openai', json: true })).out);
  assert.deepEqual(one.harnesses.find((h: any) => h.harnessId === 'pi').offerings.map((o: any) => o.provider), ['openai']);
  const text = (await call(s, 'describe', { model: 'gpt-6.1-terra' })).out;
  assert.match(text, /pi/);
  assert.match(text, /openai-codex\s+500000\s+128000\s+yes\s+yes/);
  assert.match(text, /- = not listed by the harness/);
});

test('an existing plain id that several providers list is shown with the several-providers note and is not refused', async (t: any) => {
  const s = setup(t);
  await s.seedPi();
  fs.writeFileSync(path.join(s.env.PATH, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.dirname(s.settingsFile), { recursive: true });
  fs.writeFileSync(s.settingsFile, JSON.stringify({ schema: 1, 'workers.models': { pi: { light: 'gpt-6.1-terra' } } }));
  const text = (await call(s, 'list')).out;
  assert.match(text, /light=gpt-6\.1-terra \[several providers list it\]/);
});
