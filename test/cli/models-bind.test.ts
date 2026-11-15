'use strict';
// `doflow models --action bind|unbind|list`: the dedicated writer of the user-layer `workers.models`, the
// check against the harness's own list, the TTY picker, and the per-harness tier rows. Scratch HOME, scratch
// PATH and an injected exec: no real CLI runs and no real settings are read or written.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { handleModelsCommand } = require('../../src/runtime/models/command.ts');
const { writeCatalogue } = require('../../src/runtime/models/catalogue.ts');
const { closestIds } = require('../../src/runtime/models/bind.ts');

function setup(t: any) {
  const root = tempDir(t, 'doflow-models-bind-');
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  const env: any = { ...process.env, HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: path.join(root, 'config'), PATH: bin };
  delete env.DOFLOW_CONFIG_DIR;
  const settingsFile = path.join(root, 'config', 'doflow', 'settings.json');
  const bindings = () => (fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))['workers.models'] : undefined);
  const catalogue = (harness: string, ids: string[] | null, extra: any = {}) => writeCatalogue({
    version: 1, syncedAt: new Date().toISOString(),
    harnesses: { [harness]: { harnessId: harness, binary: harness, installed: true, version: '1', loginState: 'logged-in', reloginHint: null, detectedMode: 'subscription', derivedBilling: 'free', offeredModels: (ids || []).map((id) => ({ id })), lastSyncedAt: new Date().toISOString(), ...(ids ? { modelList: { status: 'listed' } } : { modelList: { status: 'none-recorded', reason: 'x' } }), ...extra } },
  }, project);
  return { root, project, bin, env, settingsFile, bindings, catalogue };
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

const bind = (s: any, extra: any) => run({ action: 'bind', projectRoot: s.project, env: s.env, ...extra });

test('bind writes the user-layer workers.models through the settings writer, one slot at a time', async (t: any) => {
  const s = setup(t);
  assert.equal((await bind(s, { harness: 'codex', tier: 'frontier', model: 'gpt-6.1-sol' })).code, 0);
  assert.equal((await bind(s, { harness: 'codex', tier: 'light', model: 'gpt-6-luna' })).code, 0);
  assert.equal((await bind(s, { harness: 'antigravity', tier: 'orchestrator', model: 'gemini-4-argon-high' })).code, 0);
  assert.deepEqual(s.bindings(), { codex: { frontier: 'gpt-6.1-sol', light: 'gpt-6-luna' }, antigravity: { orchestrator: 'gemini-4-argon-high' } });
  assert.ok(fs.existsSync(`${s.settingsFile}.config.bak`), 'the replaced bytes are kept');
});

test('bind and unbind refuse from a worker session: exit 1, nothing written, a person runs it from their own terminal', async (t: any) => {
  const s = setup(t);
  for (const role of ['worker', 'Worker', 'surprise']) {
    const env = { ...s.env, DOFLOW_SESSION_ROLE: role };
    for (const action of ['bind', 'unbind']) {
      const res = await run({ action, projectRoot: s.project, env, harness: 'codex', tier: 'frontier', model: 'gpt-6.1-sol' });
      assert.equal(res.code, 1);
      assert.match(res.err, /worker session; a person runs it from their own terminal/);
    }
  }
  assert.equal(fs.existsSync(s.settingsFile), false);
  assert.equal((await bind({ ...s, env: { ...s.env, DOFLOW_SESSION_ROLE: 'main' } }, { harness: 'codex', tier: 'frontier', model: 'gpt-6.1-sol' })).code, 0);
});

test('a harness with no model list accepts the typed id and says it was not checked', async (t: any) => {
  const s = setup(t);
  const res = await bind(s, { harness: 'codex', tier: 'standard', model: 'my-model' });
  assert.equal(res.code, 0);
  assert.match(res.out, /Bound codex standard = my-model \(not checked: no synced model list for this harness\)/);
  const json = await bind(s, { harness: 'codex', tier: 'light', model: 'other', json: true });
  assert.equal(JSON.parse(json.out).checked, 'unchecked');
});

test('an id outside the harness list is refused with the three closest ids unless --allow-unlisted', async (t: any) => {
  const s = setup(t);
  s.catalogue('opencode', ['anthropic/claude-opus', 'anthropic/claude-sonnet', 'anthropic/claude-haiku', 'openai/gpt-y', 'zzz/unrelated']);
  const refused = await bind(s, { harness: 'opencode', tier: 'frontier', model: 'anthropic/claude-opuss' });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /'anthropic\/claude-opuss' is not in opencode's model list; closest: anthropic\/claude-opus, /);
  assert.equal(refused.err.match(/closest: ([^;]*);/)![1].split(', ').length, 3);
  assert.equal(s.bindings(), undefined, 'a refusal writes nothing');
  const json = await bind(s, { harness: 'opencode', tier: 'frontier', model: 'nope', json: true });
  assert.equal(JSON.parse(json.out).error, 'unlisted-model');
  assert.equal(JSON.parse(json.out).closest.length, 3);

  const allowed = await bind(s, { harness: 'opencode', tier: 'frontier', model: 'anthropic/claude-opuss', allowUnlisted: true });
  assert.equal(allowed.code, 0);
  assert.match(allowed.out, /not in the list; --allow-unlisted/);
  const listed = await bind(s, { harness: 'opencode', tier: 'light', model: 'anthropic/claude-haiku' });
  assert.equal(listed.code, 0);
  assert.deepEqual(s.bindings(), { opencode: { frontier: 'anthropic/claude-opuss', light: 'anthropic/claude-haiku' } });
});

test('closestIds ranks by edit distance, case-insensitively', () => {
  assert.deepEqual(closestIds('Opus', ['sonnet', 'opus-4', 'haiku', 'opus'], 2), ['opus', 'opus-4']);
});

test('bind refuses unusable input with a usage error (exit 2) and writes nothing', async (t: any) => {
  const s = setup(t);
  for (const args of [
    { harness: 'codex' },
    { tier: 'light', model: 'x' },
    { harness: 'nope', tier: 'light', model: 'x' },
    { harness: 'codex', tier: 'ultra', model: 'x' },
    { harness: 'codex', tier: 'light', model: '-rf' },
  ]) assert.equal((await bind(s, args)).code, 2, JSON.stringify(args));
  assert.equal(s.bindings(), undefined);
});

test('without --model and without a terminal bind exits 2 with the usage line', async (t: any) => {
  const s = setup(t);
  const res = await bind(s, { harness: 'codex', tier: 'light', interactive: false });
  assert.equal(res.code, 2);
  assert.match(res.err, /--model is required without a terminal; usage: models --action bind --harness <id> --tier/);
  assert.equal(s.bindings(), undefined);
});

test('on a terminal bind syncs the harness, prints a numbered list and binds the chosen id', async (t: any) => {
  const s = setup(t);
  const asked: string[] = [];
  const execFileImpl = (_bin: string, args: string[], _o: any, cb: any) => (args[0] === 'models' ? cb(null, 'a/one\nb/two\nc/three\n', '') : cb(null, '1.0.0', ''));
  const res = await bind(s, {
    harness: 'opencode', tier: 'standard', interactive: true, ask: (m: string) => { asked.push(m); return '2'; },
    syncOptions: { execFileImpl, homeDir: s.root },
  });
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /1  a\/one\n\s+2  b\/two\n\s+3  c\/three/);
  assert.deepEqual(asked, ['Choose 1-3: ']);
  assert.deepEqual(s.bindings(), { opencode: { standard: 'b/two' } });
  const bad = await bind(s, { harness: 'opencode', tier: 'light', interactive: true, ask: () => '9', syncOptions: { execFileImpl, homeDir: s.root } });
  assert.equal(bad.code, 2);
  assert.deepEqual(s.bindings(), { opencode: { standard: 'b/two' } });
});

test('the picker on a harness with no list exits 2 and tells the person to type the id', async (t: any) => {
  const s = setup(t);
  const execFileImpl = (_bin: string, _args: string[], _o: any, cb: any) => cb(null, '1.0.0', '');
  const res = await bind(s, { harness: 'codex', tier: 'light', interactive: true, ask: () => { throw new Error('must not ask'); }, syncOptions: { execFileImpl, homeDir: s.root } });
  assert.equal(res.code, 2);
  assert.match(res.err, /codex gave no model list.*pass --model <id>/);
});

test('unbind removes one slot, and the whole key when the map empties', async (t: any) => {
  const s = setup(t);
  await bind(s, { harness: 'codex', tier: 'light', model: 'a' });
  await bind(s, { harness: 'codex', tier: 'frontier', model: 'b' });
  const unbind = (tier: string) => run({ action: 'unbind', harness: 'codex', tier, projectRoot: s.project, env: s.env });
  const first = await unbind('light');
  assert.equal(first.code, 0);
  assert.match(first.out, /Unbound codex light: it now uses the harness default/);
  assert.deepEqual(s.bindings(), { codex: { frontier: 'b' } });
  assert.match((await unbind('light')).out, /was not bound; nothing written/);
  await unbind('frontier');
  assert.equal(s.bindings(), undefined);
  assert.equal((await run({ action: 'unbind', harness: 'codex', projectRoot: s.project, env: s.env })).code, 2);
});

test('unbinding the orchestrator says it falls back to the main session or the frontier binding', async (t: any) => {
  const s = setup(t);
  await bind(s, { harness: 'codex', tier: 'orchestrator', model: 'a' });
  const res = await run({ action: 'unbind', harness: 'codex', tier: 'orchestrator', projectRoot: s.project, env: s.env });
  assert.match(res.out, /it now uses the main session or frontier binding/);
});

test('bind refuses to overwrite a settings file it cannot read', async (t: any) => {
  const s = setup(t);
  fs.mkdirSync(path.dirname(s.settingsFile), { recursive: true });
  fs.writeFileSync(s.settingsFile, '{ not json');
  const res = await bind(s, { harness: 'codex', tier: 'light', model: 'a' });
  assert.equal(res.code, 1);
  assert.equal(fs.readFileSync(s.settingsFile, 'utf8'), '{ not json');
});

test('list prints one row per installed harness: three tiers, the orchestrator and where it came from', async (t: any) => {
  const s = setup(t);
  for (const name of ['codex', 'opencode']) {
    fs.writeFileSync(path.join(s.bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }
  await bind(s, { harness: 'codex', tier: 'frontier', model: 'gpt-6.1-sol' });
  await bind(s, { harness: 'codex', tier: 'light', model: 'gpt-6-luna' });
  await bind(s, { harness: 'opencode', tier: 'orchestrator', model: 'p/orch' });

  const res = await run({ action: 'list', json: true, projectRoot: s.project, env: s.env });
  assert.equal(res.code, 0);
  const view = JSON.parse(res.out);
  assert.deepEqual(view.harnesses.map((h: any) => h.harness).sort(), ['codex', 'opencode']);
  const codex = view.harnesses.find((h: any) => h.harness === 'codex');
  assert.deepEqual(codex, { harness: 'codex', light: 'gpt-6-luna', standard: null, frontier: 'gpt-6.1-sol', orchestrator: 'gpt-6.1-sol', orchestratorSource: 'frontier-binding' });
  const opencode = view.harnesses.find((h: any) => h.harness === 'opencode');
  assert.deepEqual(opencode, { harness: 'opencode', light: null, standard: null, frontier: null, orchestrator: 'p/orch', orchestratorSource: 'binding' });
  assert.deepEqual(view.models, []);

  const text = (await run({ action: 'list', projectRoot: s.project, env: s.env })).out;
  assert.match(text, /codex\s+light=gpt-6-luna\s+standard=harness default\s+frontier=gpt-6\.1-sol\s+orchestrator=gpt-6\.1-sol \(frontier binding\)/);
  assert.match(text, /opencode\s+light=harness default.*orchestrator=p\/orch \(bound\)/);
});

test('a harness that is not installed shows only when it has a binding', async (t: any) => {
  const s = setup(t);
  assert.deepEqual(JSON.parse((await run({ action: 'list', json: true, projectRoot: s.project, env: s.env })).out).harnesses, []);
  await bind(s, { harness: 'pi', tier: 'light', model: 'm' });
  const rows = JSON.parse((await run({ action: 'list', json: true, projectRoot: s.project, env: s.env })).out).harnesses;
  assert.deepEqual(rows.map((h: any) => h.harness), ['pi']);
});
