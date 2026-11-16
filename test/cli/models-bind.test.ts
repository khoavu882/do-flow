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
    harnesses: { [harness]: { harnessId: harness, binary: harness, installed: true, version: '1', detectedMode: 'subscription', derivedBilling: 'free', offeredModels: (ids || []).map((id) => ({ id })), lastSyncedAt: new Date().toISOString(), ...(ids ? { modelList: { status: 'listed' } } : { modelList: { status: 'none-recorded', reason: 'x' } }), ...extra } },
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

test('the refusal says when the list it checked against is the last one, kept stale after a failed refresh', async (t: any) => {
  const s = setup(t);
  s.catalogue('opencode', ['anthropic/claude-opus', 'openai/gpt-y'], { modelList: { status: 'failed', reason: 'offline', stale: true } });
  const refused = await bind(s, { harness: 'opencode', tier: 'frontier', model: 'anthropic/claude-opuss' });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /is not in opencode's model list \(the last list; it could not be refreshed\); closest: /);
  const fresh = setup(t);
  fresh.catalogue('opencode', ['anthropic/claude-opus']);
  assert.doesNotMatch((await bind(fresh, { harness: 'opencode', tier: 'frontier', model: 'nope' })).err, /last list/);
});

test('the sync line says how many ids were left out and when the list was cut', async (t: any) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const execFileImpl = (_bin: string, args: string[], _opts: any, cb: any) => (args[0] === 'models'
    ? cb(null, `--foo\n${Array.from({ length: 600 }, (_, i) => `p/m${i}`).join('\n')}\n`, '') : cb(null, '1.0.0', ''));
  const res = await run({ action: 'sync', harness: 'opencode', projectRoot: s.project, env: s.env, syncOptions: { execFileImpl, homeDir: s.root } });
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /models: 500 \[1 ids that are not usable model ids left out; the list was cut at its first 500 ids\]/);
});

test('list --json gives unresolved:<reason> for the tier fields when workers.models cannot be read, never null', async (t: any) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.bin, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.dirname(s.settingsFile), { recursive: true });
  fs.writeFileSync(s.settingsFile, JSON.stringify({ schema: 1, 'workers.models': { codex: { bogus: 'x' } } }));
  const res = await run({ action: 'list', projectRoot: s.project, env: s.env, json: true });
  const out = JSON.parse(res.out);
  assert.equal(out.bindings.state, 'invalid');
  const row = out.harnesses.find((h: any) => h.harness === 'codex');
  for (const key of ['light', 'standard', 'frontier', 'orchestrator']) assert.match(row[key], /^unresolved:.+/, key);
  const text = await run({ action: 'list', projectRoot: s.project, env: s.env });
  assert.match(text.out, /light=unresolved/);
});

test('two syncs of different harnesses in one project both keep their entry, and no lock is left behind', async (t: any) => {
  const s = setup(t);
  fs.writeFileSync(path.join(s.bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(s.bin, 'pi'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const later = (answer: string, ms: number) => (_bin: string, args: string[], _opts: any, cb: any) => {
    setTimeout(() => (args[0] === 'models' || args[0] === '--list-models' ? cb(null, answer, '') : cb(null, '1.0.0', '')), ms);
  };
  const log = console.log;
  console.log = () => {};
  let codes: number[];
  try {
    // opencode answers after pi has started, so both read the catalogue before either writes.
    codes = await Promise.all([
      handleModelsCommand({ actionGiven: true, action: 'sync', harness: 'opencode', projectRoot: s.project, env: s.env, json: true, syncOptions: { execFileImpl: later('a/one\n', 60) } }),
      handleModelsCommand({ actionGiven: true, action: 'sync', harness: 'pi', projectRoot: s.project, env: s.env, json: true, syncOptions: { execFileImpl: later('provider model\nx y\n', 5) } }),
    ]);
  } finally {
    console.log = log;
  }
  assert.deepEqual(codes, [0, 0]);
  const file = path.join(s.project, '.doflow', 'state', 'models', 'catalogue.json');
  const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(stored.harnesses).sort(), ['opencode', 'pi']);
  assert.deepEqual(stored.harnesses.opencode.offeredModels, [{ id: 'one', provider: 'a' }]);
  assert.equal(fs.existsSync(`${file}.lock`), false);
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

test('a catalogue entry written before model lists existed reads as no list: the typed id is accepted, unchecked, and the old names are never shown', async (t: any) => {
  const s = setup(t);
  const file = path.join(s.project, '.doflow', 'state', 'models', 'catalogue.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const old = { harnessId: 'codex', binary: 'codex', installed: true, version: '1', detectedMode: 'subscription', derivedBilling: 'free', offeredModels: [{ id: 'removed-table-model-a' }, { id: 'removed-table-model-b' }], lastSyncedAt: new Date().toISOString() };
  fs.writeFileSync(file, JSON.stringify({ version: 1, syncedAt: new Date().toISOString(), harnesses: { codex: old } }));
  // A typed id outside the old table is not refused against it, and the old names are not offered as "closest".
  const typed = await bind(s, { harness: 'codex', tier: 'frontier', model: 'removed-table-model-c', json: true });
  assert.equal(typed.code, 0, typed.err);
  assert.equal(JSON.parse(typed.out).checked, 'unchecked');
  const plain = await bind(s, { harness: 'codex', tier: 'light', model: 'anything' });
  assert.match(plain.out, /^Bound codex light = anything \[model unchecked\] \(wrote /);
  assert.doesNotMatch(plain.out + plain.err, /removed-table-model/);
  // list shows no observed model rows from the old entry.
  const listed = await run({ action: 'list', projectRoot: s.project, env: s.env, json: true });
  assert.deepEqual(JSON.parse(listed.out).models, []);
  assert.doesNotMatch(listed.out, /removed-table-model-[ab]/);
  const text = await run({ action: 'list', projectRoot: s.project, env: s.env });
  assert.doesNotMatch(text.out, /removed-table-model-[ab]/);
  // describe does not find an old name.
  const described = await run({ action: 'describe', projectRoot: s.project, env: s.env, harness: undefined, model: 'removed-table-model-a', json: true });
  assert.equal(described.code, 1);
  assert.equal(JSON.parse(described.out).error, 'not-found');
});

test('a harness with no model list accepts the typed id and says it was not checked', async (t: any) => {
  const s = setup(t);
  const res = await bind(s, { harness: 'codex', tier: 'standard', model: 'my-model' });
  assert.equal(res.code, 0);
  assert.match(res.out, /Bound codex standard = my-model \[model unchecked\] \(wrote /);
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
  assert.match(allowed.out, /Bound opencode frontier = anthropic\/claude-opuss \[not in the list\] \(wrote /);
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
  fs.writeFileSync(path.join(s.bin, 'opencode'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const asked: string[] = [];
  const execFileImpl = (_bin: string, args: string[], _o: any, cb: any) => (args[0] === 'models' ? cb(null, 'a/one\nb/two\nc/three\n', '') : cb(null, '1.0.0', ''));
  const res = await bind(s, {
    harness: 'opencode', tier: 'standard', interactive: true, ask: (m: string) => { asked.push(m); return '2'; },
    syncOptions: { execFileImpl, homeDir: s.root },
  });
  assert.equal(res.code, 0, res.err);
  assert.match(res.out, /1  one \(provider a\)\n\s+2  two \(provider b\)\n\s+3  three \(provider c\)/);
  assert.deepEqual(asked, ['Choose 1-3: ']);
  assert.deepEqual(s.bindings(), { opencode: { standard: { model: 'two', provider: 'b' } } });
  const bad = await bind(s, { harness: 'opencode', tier: 'light', interactive: true, ask: () => '9', syncOptions: { execFileImpl, homeDir: s.root } });
  assert.equal(bad.code, 2);
  assert.deepEqual(s.bindings(), { opencode: { standard: { model: 'two', provider: 'b' } } });
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
  const cell = (model: string) => ({ model, provider: null, effort: null, check: { model: 'unchecked', effort: null } });
  assert.deepEqual(codex, { harness: 'codex', light: cell('gpt-6-luna'), standard: null, frontier: cell('gpt-6.1-sol'), orchestrator: cell('gpt-6.1-sol'), orchestratorSource: 'frontier-binding' });
  const opencode = view.harnesses.find((h: any) => h.harness === 'opencode');
  assert.deepEqual(opencode, { harness: 'opencode', light: null, standard: null, frontier: null, orchestrator: cell('p/orch'), orchestratorSource: 'binding' });
  assert.deepEqual(view.models, []);

  const text = (await run({ action: 'list', projectRoot: s.project, env: s.env })).out;
  assert.match(text, /codex\s+light=gpt-6-luna \[model unchecked\]\s+standard=harness default\s+frontier=gpt-6\.1-sol \[model unchecked\]\s+orchestrator=gpt-6\.1-sol \[model unchecked\] \(frontier binding\)/);
  assert.match(text, /opencode\s+light=harness default.*orchestrator=p\/orch \[model unchecked\] \(bound\)/);
});

test('a harness that is not installed shows only when it has a binding', async (t: any) => {
  const s = setup(t);
  assert.deepEqual(JSON.parse((await run({ action: 'list', json: true, projectRoot: s.project, env: s.env })).out).harnesses, []);
  await bind(s, { harness: 'pi', tier: 'light', model: 'm' });
  const rows = JSON.parse((await run({ action: 'list', json: true, projectRoot: s.project, env: s.env })).out).harnesses;
  assert.deepEqual(rows.map((h: any) => h.harness), ['pi']);
});
