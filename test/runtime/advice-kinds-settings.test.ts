'use strict';

// 084: `advice.kinds.<kind>` and `advice.models.<kind>` are registered settings, so `doflow config validate` and
// `doflow config` judge and show them, and the validated settings view agrees with the runtime reader
// (src/runtime/advice/shadow-config.ts) for every kind across valid, invalid and unset values in each layer.
// Every CLI case runs against a scratch HOME / XDG_CONFIG_HOME and project (test/helper/settings-fixtures.ts).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures.ts');
const { loadSettings } = require('../../src/runtime/settings/resolve.ts');
const { resolveShadowConfig } = require('../../src/runtime/advice/shadow-config.ts');

const KINDS: string[] = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/advice.json'), 'utf8')).kinds.map((kind: any) => kind.id);

test('the advice registry still declares the six kinds this file covers', () => {
  assert.deepEqual(KINDS, ['tier', 'task-class', 'verify-risk', 'review-depth', 'mcp-need', 'followup-triage']);
});

// ── config validate ───────────────────────────────────────────────────────────────────────────────

for (const kind of KINDS) {
  test(`config validate accepts off, shadow and act for advice.kinds.${kind} and rejects offf`, (t) => {
    const f = createSettingsEnv(t);
    for (const mode of ['off', 'shadow', 'act']) {
      for (const layer of [[], ['--layer', 'project']]) {
        const result = f.run(['config', 'validate', `advice.kinds.${kind}`, JSON.stringify(mode), ...layer, '--json']);
        assert.equal(result.status, 0, `${mode} ${layer.join(' ')}: ${result.stdout}${result.stderr}`);
        assert.equal(result.json.ok, true);
      }
    }
    const bad = f.run(['config', 'validate', `advice.kinds.${kind}`, '"offf"', '--json']);
    assert.equal(bad.status, 1, `${bad.stdout}${bad.stderr}`);
    assert.equal(bad.json.errors[0].code, 'enum');
    assert.deepEqual(bad.json.errors[0].allowed, ['off', 'shadow', 'act']);
    const model = f.run(['config', 'validate', `advice.models.${kind}`, '"qwen2.5-coder:1.5b"', '--json']);
    assert.equal(model.status, 0, `${model.stdout}${model.stderr}`);
    const emptyModel = f.run(['config', 'validate', `advice.models.${kind}`, '""', '--json']);
    assert.equal(emptyModel.status, 1, `${emptyModel.stdout}${emptyModel.stderr}`);
    assert.equal(emptyModel.json.errors[0].code, 'type');
  });
}

test('control: config validate still refuses a kind advice.json does not declare as unknown-key', (t) => {
  const f = createSettingsEnv(t);
  for (const key of ['advice.kinds.nosuch', 'advice.models.nosuch']) {
    const result = f.run(['config', 'validate', key, '"shadow"', '--json']);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.equal(result.json.errors[0].code, 'unknown-key');
  }
});

// ── config (list) ─────────────────────────────────────────────────────────────────────────────────

test('config lists every advice.kinds and advice.models key, shows a set value with its layer and adds no unknown-key note', (t) => {
  const f = createSettingsEnv(t);
  const settings: Record<string, string> = {};
  for (const kind of KINDS) { settings[`advice.kinds.${kind}`] = 'shadow'; settings[`advice.models.${kind}`] = `m-${kind}`; }
  f.writeProjectSettings({ schema: 1, ...settings });
  const result = f.run(['config', '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  for (const [key, value] of Object.entries(settings)) {
    assert.equal(result.json.keys[key]?.value, value, key);
    assert.equal(result.json.keys[key].origin.layer, 'project', key);
  }
  assert.deepEqual(result.json.notes.filter((note: any) => note.code === 'unknown-key'), []);

  const unset = createSettingsEnv(t).run(['config', '--json']);
  for (const kind of KINDS) {
    assert.equal(unset.json.keys[`advice.kinds.${kind}`].value, null, 'unset keeps the kind on its unset path, not off');
    assert.equal(unset.json.keys[`advice.kinds.${kind}`].origin.layer, 'default');
  }
  const text = f.run(['config']);
  assert.match(text.stdout, /^advice\.kinds\.tier = "shadow"$/m);
  assert.doesNotMatch(text.stdout, /advice\.kinds\.tier" is not a DoFlow setting/);
});

test('control: config still notes an advice.kinds key for an undeclared kind as not a DoFlow setting', (t) => {
  const f = createSettingsEnv(t);
  f.writeProjectSettings({ schema: 1, 'advice.kinds.nosuch': 'shadow' });
  const result = f.run(['config', '--json']);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(result.json.notes.some((note: any) => note.code === 'unknown-key' && note.key === 'advice.kinds.nosuch'), JSON.stringify(result.json.notes));
  assert.equal(result.json.keys['advice.kinds.nosuch'], undefined);
});

// ── the validated view agrees with the runtime reader ─────────────────────────────────────────────

const MODE_VALUES = [undefined, 'off', 'shadow', 'act', 'offf', 7];
const MODEL_VALUES = [undefined, 'm-a', '', 5];
const LAYERS = ['local', 'project', 'user'] as const;

function layerFiles(f: any) {
  return { local: f.projectFile('settings.local.json'), project: f.projectFile('settings.json'), user: f.userFile('settings.json') };
}

/** Writes the three layer files for one case; a layer whose keys are all unset gets no file. */
function writeCase(f: any, perLayer: Record<string, Record<string, unknown>>) {
  for (const [layer, file] of Object.entries(layerFiles(f))) {
    fs.rmSync(file, { force: true });
    const content = Object.fromEntries(Object.entries(perLayer[layer] || {}).filter(([, value]) => value !== undefined));
    if (Object.keys(content).length) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(content)); }
  }
}

/** What the validated view says for one kind, in the runtime reader's terms. */
function viewSays(view: any, kind: string) {
  const mode = view.get(`advice.kinds.${kind}`);
  const model = view.get(`advice.models.${kind}`);
  return {
    mode: mode.value ?? 'off',
    kindSet: mode.origin.layer !== 'default' || mode.candidates.length > 0,
    model: model.value,
  };
}

function runtimeSays(f: any, kind: string) {
  const cfg = resolveShadowConfig(kind, { projectRoot: f.project, env: f.env() });
  return { mode: cfg.mode, kindSet: cfg.kindSet, model: cfg.decidedBy.model ? cfg.model : null };
}

function product(values: unknown[], n: number): unknown[][] {
  return n === 0 ? [[]] : product(values, n - 1).flatMap((rest) => values.map((value) => [value, ...rest]));
}

/** Every disagreement over every layer combination of mode values (and model values) for `kind`. */
function disagreements(f: any, kind: string, viewOf: (f: any) => any) {
  const out: string[] = [];
  const cases = [
    ...product(MODE_VALUES, 3).map((modes) => ({ modes, models: [undefined, undefined, undefined] })),
    ...product(MODEL_VALUES, 3).map((models) => ({ modes: ['shadow', undefined, undefined], models })),
  ];
  for (const { modes, models } of cases) {
    const perLayer: Record<string, Record<string, unknown>> = {};
    LAYERS.forEach((layer, i) => { perLayer[layer] = { [`advice.kinds.${kind}`]: modes[i], [`advice.models.${kind}`]: models[i] }; });
    writeCase(f, perLayer);
    const view = viewSays(viewOf(f), kind);
    const runtime = runtimeSays(f, kind);
    if (JSON.stringify(view) !== JSON.stringify(runtime)) {
      out.push(`${JSON.stringify(perLayer)}: view ${JSON.stringify(view)} runtime ${JSON.stringify(runtime)}`);
    }
  }
  return out;
}

const projectView = (f: any) => loadSettings({ projectRoot: f.project, env: f.env() });

for (const kind of KINDS) {
  test(`the validated view and shadow-config agree on advice.kinds.${kind} and advice.models.${kind} in every layer`, (t) => {
    const f = createSettingsEnv(t);
    assert.deepEqual(disagreements(f, kind, projectView), []);
  });
}

test('control: the agreement check catches a view that leaves out the project layers', (t) => {
  const f = createSettingsEnv(t);
  const globalView = (g: any) => loadSettings({ global: true, env: g.env() });
  const found = disagreements(f, 'tier', globalView);
  assert.ok(found.length > 0, 'a view that ignores local and project values must disagree');
  assert.ok(found.some((line) => line.includes('"local":{"advice.kinds.tier":"shadow"')), found.slice(0, 3).join('\n'));
});
