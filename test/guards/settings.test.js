'use strict';

// G44 — settings registration, documentation, storage and copied reader guards (086 IC-014/015/016).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { loadSettingsRegistry, validateSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { configHome } = require('../../src/runtime/config-home.ts');
const { lexicalCapture } = require('../../src/runtime/settings/lexical.ts');
const { checkSettingsDocs, renderSettingsTable, resolvedDefault } = require('../helper/settings-doc-guard');
const { identityInlineConfigHomeBlock } = require('../helper/settings-shell-blocks');

const REPO = path.resolve(__dirname, '../..');
const SOURCE_EXT = /\.(?:js|mjs|cjs|ts|sh)$/;
const CONFIG_NAME = 'doflow-config-home v1';
const CONFIG_FORMS = /\$XDG_CONFIG_HOME\b|\$\{XDG_CONFIG_HOME\b|\benv(?:\?\.|\.)XDG_CONFIG_HOME\b/;
const BANNED_CONFIG_FORMS = /\$\{XDG_CONFIG_HOME:-|XDG_CONFIG_HOME\s*\|\|/;
const CONFIG_BLOCK_FILES = [
  'core/shared/scripts/doflow/bin/doflow-run',
  'core/harnesses/shared/hooks/policies/capture-failure.sh',
  'core/harnesses/shared/hooks/policies/lib.sh',
  'core/harnesses/claude/hooks/lib.sh',
  'core/harnesses/codex/hooks/lib.sh',
  'core/harnesses/gemini/hooks/lib.sh',
  'core/harnesses/kiro/hooks/lib.sh',
  'core/harnesses/shared/hooks/stream-hook-runner.js',
  'core/harnesses/shared/hooks/policies/identity.sh',
];
const SETTINGS_FILE = 'core/registry/settings.json';
const STORAGE_FILE = 'core/registry/storage.json';

function readJson(file) { return JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')); }

function walkSourceFiles(root, prefix = '') {
  const found = [];
  for (const entry of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
    const relative = path.posix.join(prefix.split(path.sep).join('/'), entry.name);
    const full = path.join(root, prefix, entry.name);
    if (entry.isDirectory()) found.push(...walkSourceFiles(root, relative));
    else if (entry.isFile()) {
      const text = fs.readFileSync(full, 'utf8');
      if ((SOURCE_EXT.test(entry.name) && !/\.d\.ts$/.test(entry.name)) || text.startsWith('#!')) {
        found.push({ file: path.relative(REPO, full).split(path.sep).join('/'), text });
      }
    }
  }
  return found;
}

function shippedSources() {
  return [
    ...walkSourceFiles(REPO, 'src'),
    ...walkSourceFiles(REPO, 'core'),
  ];
}

function sourceComment(line, file) {
  if (/\.sh$/.test(file)) return /^\s*#/.test(line);
  return /^\s*(?:\/\/|\/\*|\*|\*\/)/.test(line);
}

function markerRanges(text, name) {
  const lines = text.split('\n');
  const ranges = [];
  for (let i = 0; i < lines.length; i++) {
    const begin = lines[i].match(/^\s*(#|\/\/) BEGIN (.+?) \(.*\)\s*$/);
    if (!begin || begin[2] !== name) continue;
    const endText = `${begin[1]} END ${name}`;
    let end = i + 1;
    while (end < lines.length && lines[end] !== endText) end++;
    if (end === lines.length) ranges.push({ start: i, end: i, invalid: true });
    else ranges.push({ start: i, end });
  }
  return ranges;
}

function checkConfigHomeSources(sources) {
  const errors = [];
  for (const { file, text } of sources) {
    const lines = text.split('\n');
    const ranges = markerRanges(text, CONFIG_NAME);
    for (const range of ranges) if (range.invalid) errors.push(`${file}:${range.start + 1} unterminated ${CONFIG_NAME} block`);
    const inline = identityInlineConfigHomeBlock(file, text);
    const allowed = [...ranges, ...(inline ? [inline] : [])];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (sourceComment(line, file) || !CONFIG_FORMS.test(line)) continue;
      const approved = file === 'src/runtime/config-home.ts'
        || allowed.some((range) => i >= range.start && i <= range.end);
      if (!approved) errors.push(`${file}:${i + 1} config-home access must use ${CONFIG_NAME}`);
      if (BANNED_CONFIG_FORMS.test(line) && !approved) errors.push(`${file}:${i + 1} banned config-home expression`);
    }
  }
  return errors;
}

function extractBlocks(sources, name) {
  const blocks = [];
  const errors = [];
  for (const { file, text } of sources) {
    const ranges = markerRanges(text, name);
    if (ranges.length > 1) errors.push(`${file} has ${ranges.length} ${name} blocks`);
    for (const range of ranges) {
      if (range.invalid) continue;
      blocks.push({ file, text: text.split('\n').slice(range.start, range.end + 1).join('\n') });
    }
    if (name === CONFIG_NAME) {
      const inline = identityInlineConfigHomeBlock(file, text);
      if (inline) blocks.push({ file, text: inline.text, inline: true });
    }
  }
  return { blocks, errors };
}

function configCases(dir) {
  const U = undefined;
  const cases = [
    [1, U, U], [2, U, 'r'], [3, U, 'H'],
    [4, '', U], [5, '', 'r'], [6, '', 'H'],
    [7, 'r', U], [8, 'r', 'r'], [9, 'r', 'H'],
    [10, 'X', U], [11, 'X', 'r'], [12, 'X', 'H'],
  ];
  const abs = { x: path.join(dir, 'xdg'), h: path.join(dir, 'home') };
  return cases.map(([number, xdg, home]) => {
    const pick = (value) => value === 'X' ? abs.x : value === 'H' ? abs.h : value;
    const env = { PATH: process.env.PATH };
    if (xdg !== U) env.XDG_CONFIG_HOME = pick(xdg);
    if (home !== U) env.HOME = pick(home);
    return { number, env };
  });
}

function runBashConfigHome(block, env, cwd) {
  const script = `set -euo pipefail\n${block}\ndoflow_config_home\nprintf '%s' "$DOFLOW_HOME"`;
  const result = spawnSync('/bin/bash', ['-c', script], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `bash exits 0: ${result.stderr}`);
  assert.equal(result.stderr, '', 'config-home block is silent');
  return result.stdout;
}

function runJsConfigHome(block, env) {
  const run = new Function('path', `${block}\nreturn doflowConfigHome;`)(path);
  const result = run(env);
  return typeof result === 'string' ? result : result?.dir ?? '';
}

function checkConfigBlocks(blocks, dir) {
  const errors = [];
  const cases = configCases(dir);
  for (const block of blocks) {
    const run = block.inline
      ? (value, env) => runIdentityInlineConfigHome(value, env, dir)
      : /\.js$/.test(block.file) ? runJsConfigHome : (value, env) => runBashConfigHome(value, env, dir);
    for (const { number, env } of cases) {
      const configDir = configHome(env).dir ?? '';
      const expected = block.inline && configDir ? path.join(configDir, 'session-env', 'sessions') : configDir;
      const actual = run(block.text, env);
      if ((actual ? path.normalize(actual) : '') !== (expected ? path.normalize(expected) : '')) {
        errors.push(`${block.file} config-home case ${number}: expected '${expected}', got '${actual}'`);
      }
    }
  }
  return errors;
}

function runIdentityInlineConfigHome(block, env, cwd) {
  const script = `set -euo pipefail\nsessions="${'${SESSION_DIR:-}'}"\n${block}\nprintf '%s' "$sessions"`;
  const result = spawnSync('/bin/bash', ['-c', script], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `bash exits 0: ${result.stderr}`);
  assert.equal(result.stderr, '', 'identity config-home copy is silent');
  return result.stdout;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// model-router maps a model backend to its CLI name; that string is not the advice.provider default.
const OLLAMA_LITERAL_ALLOWLIST = new Set(['src/runtime/model-router.ts']);

function checkNoCopiedDefaults(sources, retention) {
  const errors = [];
  for (const { file, text } of sources) {
    if (OLLAMA_LITERAL_ALLOWLIST.has(file)) continue;
    if (/(?:'ollama'|"ollama")/.test(stripComments(text))) errors.push(`${file} copies the advice.provider default`);
  }
  if (/\b4320\b/.test(stripComments(retention))) errors.push('lifecycle/retention.ts copies the storage.retentionHours default');
  return errors;
}

function shellReadBlockNames(raw) {
  return [...new Set(Object.values(raw.keys)
    .map((spec) => spec.shellRead)
    .filter((shellRead) => typeof shellRead === 'string')
    .map((shellRead) => `doflow-settings-${shellRead.replace(/-v(\d+)$/, ' v$1')}`))];
}

function loadLexicalCorpus() {
  const file = path.join(REPO, 'test/settings/lexical.test.js');
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/const CORPUS = (\[[\s\S]*?\n\]);/);
  assert.ok(match, `${file} exports the IC-004 corpus as a literal array`);
  return new Function('BOM', 'NBSP', `return ${match[1]};`)('\u00ef\u00bb\u00bf', '\u00a0');
}

function runJsLexical(block) {
  return new Function('fs', `${block}\nreturn lexicalCapture;`)(fs);
}

function runBashLexical(block, file, cwd) {
  const script = `set -euo pipefail\n${block}\ndoflow_lex_capture "$1"\nprintf '%s' "$DOFLOW_LEX_CAPTURE"`;
  const result = spawnSync('/bin/bash', ['-c', script, 'x', file], {
    cwd, env: { PATH: process.env.PATH }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `bash exits 0: ${result.stderr}`);
  assert.equal(result.stderr, '', 'lexical block is silent');
  return result.stdout === '' ? null : result.stdout;
}

function lexicalMismatches(block, corpus, dir) {
  const mismatches = [];
  if (/\.js$/.test(block.file)) {
    const lex = runJsLexical(block.text);
    for (const [name, text, expected] of corpus) {
      const actual = lex(text);
      if (actual !== expected || actual !== lexicalCapture(text)) mismatches.push(name);
    }
    return mismatches;
  }
  for (let i = 0; i < corpus.length; i++) {
    const [name, text, expected] = corpus[i];
    const file = path.join(dir, `settings-${i}.json`);
    fs.writeFileSync(file, Buffer.from(text, 'latin1'));
    const actual = runBashLexical(block.text, file, dir);
    if (actual !== expected || expected !== lexicalCapture(text)) mismatches.push(name);
  }
  return mismatches;
}

function checkSettingsStores(registry) {
  const errors = [];
  const expected = {
    'user-settings-project-doflow': {
      root: 'project-doflow',
      match: '^(?:prompt-nudge|prune|decision-model\\.json|settings\\.json|settings\\.local\\.json)$',
      legacyLocal: true,
    },
    'user-settings-config-home': {
      root: 'config-home',
      match: '^(?:prompt-nudge|prune|decision-model\\.json|settings\\.json)$',
      legacyLocal: false,
    },
  };
  for (const [id, want] of Object.entries(expected)) {
    const store = registry.stores.find((candidate) => candidate.id === id);
    if (!store) { errors.push(`storage.json is missing ${id}`); continue; }
    if (store.root !== want.root) errors.push(`${id} root must be ${want.root}`);
    if (store.rule !== 'existing') errors.push(`${id} must use the existing rule`);
    if (store.match !== want.match) errors.push(`${id} match does not cover the settings files`);
    if (!store.writers.includes('src/runtime/settings/write.ts')) errors.push(`${id} omits src/runtime/settings/write.ts`);
    if (!store.bound?.text?.includes('settings.json')) errors.push(`${id} bound text does not name settings.json`);
    if (want.legacyLocal !== store.match.includes('settings\\.local\\.json')) errors.push(`${id} settings.local.json scope is wrong`);
  }
  return errors;
}

test('G44 S1: the settings registry validates refs and every consumer path exists', () => {
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true, checkConsumers: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);

  const raw = readJson(SETTINGS_FILE);
  delete raw.keys['advice.enabled'].consumers;
  const control = validateSettingsRegistry(raw);
  assert.equal(control.ok, false, 'a missing consumer declaration is rejected');
  assert.match(control.errors.join('\n'), /advice\.enabled is missing 'consumers'/);
});

test('G44 S2: the settings keys table matches registry types, defaults, scopes, env names and legacy files', () => {
  const raw = readJson(SETTINGS_FILE);
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const docs = fs.readFileSync(path.join(REPO, 'docs/settings.md'), 'utf8');
  assert.deepEqual(checkSettingsDocs(raw, docs, loaded.registry), []);
});

test('G44 S2 control: a scratch settings table missing storage.prune is rejected', (t) => {
  const dir = tempDir(t, 'doflow-settings-doc-control-');
  const raw = readJson(SETTINGS_FILE);
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const fixture = path.join(dir, 'docs', 'settings.md');
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, renderSettingsTable(raw, loaded.registry, { omitKey: 'storage.prune' }));
  const errors = checkSettingsDocs(raw, fs.readFileSync(fixture, 'utf8'), loaded.registry);
  assert.ok(errors.some((message) => message.includes('missing storage.prune')), errors.join('\n'));
});

test('G44 S2 control: doubled config-home paths are rejected', () => {
  const raw = readJson(SETTINGS_FILE);
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const docs = fs.readFileSync(path.join(REPO, 'docs/settings.md'), 'utf8');
  const planted = docs.replace('## Settings keys', '<config home>/doflow/settings.json\n## Settings keys');
  const errors = checkSettingsDocs(raw, planted, loaded.registry);
  assert.ok(errors.some((message) => message.includes('config home path')), errors.join('\n'));
});

test('G44 S2 control: wrong Type and Legacy file cells are rejected', () => {
  const raw = readJson(SETTINGS_FILE);
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const good = renderSettingsTable(raw, loaded.registry);
  const row = good.split('\n').find((line) => line.includes('| `storage.prune` |'));
  assert.ok(row, 'the fixture has a storage.prune row');
  const wrong = good.replace(row, row.replace('| enum |', '| string |').replace(' | `prune` |', ' | `obsolete-prune` |'));
  const errors = checkSettingsDocs(raw, wrong, loaded.registry);
  assert.ok(errors.some((message) => message.includes('storage.prune type')), errors.join('\n'));
  assert.ok(errors.some((message) => message.includes('storage.prune legacy file')), errors.join('\n'));
});

test('G44 S2 control: default refs receive dependencies from registry metadata and requires', () => {
  const keys = new Map([
    ['base.value', { default: 'registry-default' }],
    ['derived.value', { defaultRef: 'fixture.ref', requires: [{ when: true, key: 'base.value', view: 'global' }] }],
  ]);
  const registry = {
    keys,
    resolveRef(name, deps) { return name === 'fixture.ref' ? `resolved:${deps['base.value']}` : undefined; },
  };
  assert.equal(resolvedDefault('derived.value', keys.get('derived.value'), registry), 'resolved:registry-default');
});

test('G44 S3: every registry reference resolves and consumers do not copy referenced defaults', () => {
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  for (const [key, spec] of loaded.registry.keys) {
    if (spec.valuesRef) assert.ok(loaded.registry.enumValues(key)?.length, `${key} valuesRef resolves`);
    if (spec.defaultRef) assert.notEqual(resolvedDefault(key, spec, loaded.registry), undefined, `${key} defaultRef resolves`);
  }
  const adviceFiles = walkSourceFiles(REPO, 'src');
  const retentionFile = fs.readFileSync(path.join(REPO, 'src/runtime/lifecycle/retention.ts'), 'utf8');
  assert.deepEqual(checkNoCopiedDefaults(adviceFiles, retentionFile), []);

  const controls = checkNoCopiedDefaults([
    { file: 'src/runtime/fake-default.ts', text: "const defaultProvider = 'ollama';" },
  ], 'const window = 4320;');
  assert.equal(controls.length, 2, 'the copied provider and retention defaults are detected');
  assert.match(controls[0], /src\/runtime\/fake-default\.ts/);
});

test('G44 S4: config-home accesses use the helper or a checked block, and every block matches all 12 cases', (t) => {
  const dir = tempDir(t, 'doflow-settings-config-home-');
  const sources = shippedSources();
  assert.deepEqual(checkConfigHomeSources(sources), []);
  const { blocks, errors } = extractBlocks(sources, CONFIG_NAME);
  assert.deepEqual(errors, []);
  assert.deepEqual(blocks.map((block) => block.file).sort(), [...CONFIG_BLOCK_FILES].sort());
  assert.deepEqual(checkConfigBlocks(blocks, dir), []);
});

test('G44 S4 control: a scratch src file using an unsafe XDG expression is rejected', (t) => {
  const dir = tempDir(t, 'doflow-settings-config-control-');
  const file = path.join(dir, 'src', 'bad-config.ts');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'const config = "${XDG_CONFIG_HOME:-}/doflow";\n');
  const errors = checkConfigHomeSources([{ file: 'src/bad-config.ts', text: fs.readFileSync(file, 'utf8') }]);
  assert.equal(errors.length, 2);
  assert.match(errors.join('\n'), /banned config-home expression/);
});

test('G44 S5: every lexical-v1 consumer block matches the IC-004 corpus', (t) => {
  const dir = tempDir(t, 'doflow-settings-lexical-');
  const sources = shippedSources();
  const raw = readJson(SETTINGS_FILE);
  const blockSets = shellReadBlockNames(raw).map((name) => extractBlocks(sources, name));
  const blocks = blockSets.flatMap((result) => result.blocks);
  const errors = blockSets.flatMap((result) => result.errors);
  assert.ok(blockSets.length > 0, 'the registry declares at least one shellRead block');
  assert.ok(blocks.length > 0, 'the declared shellRead blocks are present in shipped sources');
  assert.deepEqual(errors, []);
  const corpus = loadLexicalCorpus();
  for (const block of blocks) {
    assert.deepEqual(lexicalMismatches(block, corpus, dir), [], `${block.file} differs from lexicalCapture()`);
  }

  const jsBlock = blocks.find((block) => /\.js$/.test(block.file));
  const broken = jsBlock.text.replace("const WS = '[ \\\\t\\\\n\\\\v\\\\f\\\\r]';", "const WS = '\\\\s';");
  assert.notEqual(broken, jsBlock.text, 'the negative control mutates the lexical class');
  assert.ok(lexicalMismatches({ ...jsBlock, text: broken }, corpus, dir).length > 0);
});

test('G44 S6: settings files are declared as existing stores with matching writers and bounds', () => {
  const registry = readJson(STORAGE_FILE);
  assert.deepEqual(checkSettingsStores(registry), []);

  const control = structuredClone(registry);
  const project = control.stores.find((store) => store.id === 'user-settings-project-doflow');
  project.writers = project.writers.filter((writer) => writer !== 'src/runtime/settings/write.ts');
  const errors = checkSettingsStores(control);
  assert.ok(errors.some((message) => message.includes('omits src/runtime/settings/write.ts')));
});
