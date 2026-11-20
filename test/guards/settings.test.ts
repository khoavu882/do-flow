'use strict';

// G44 — settings registration, documentation, storage and copied reader guards (086 IC-014/015/016).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { spawnBash } = require('../helper/home-less-bash.ts');
const { IS_WIN, samePath } = require('../helper-platform.ts');
const { loadSettingsRegistry, validateSettingsRegistry } = require('../../src/runtime/settings/registry.ts');
const { configHome } = require('../../src/runtime/config-home.ts');
const { lexicalCapture } = require('../../src/runtime/settings/lexical.ts');
const { checkSettingsDocs, renderSettingsTable, resolvedDefault } = require('../helper/settings-doc-guard.ts');
const { identityInlineConfigHomeBlock } = require('../helper/settings-shell-blocks.ts');

const REPO = path.resolve(__dirname, '../..');
const SOURCE_EXT = /\.(?:js|mjs|cjs|ts|sh)$/;
const CONFIG_NAME = 'doflow-config-home v1';
const CONFIG_FORMS = /\$XDG_CONFIG_HOME\b|\$\{XDG_CONFIG_HOME\b|\benv(?:\?\.|\.)XDG_CONFIG_HOME\b/;
const BANNED_CONFIG_FORMS = /\$\{XDG_CONFIG_HOME:-|XDG_CONFIG_HOME\s*\|\|/;
const CONFIG_BLOCK_FILES: any = [
  'core/shared/scripts/doflow/bin/doflow-run',
  'core/harnesses/shared/hooks/policies/capture-failure.sh',
  'core/harnesses/shared/hooks/policies/lib.sh',
  'core/harnesses/claude/hooks/lib.sh',
  'core/harnesses/codex/hooks/lib.sh',
  'core/harnesses/kiro/hooks/lib.sh',
  'core/harnesses/shared/hooks/stream-hook-runner.js',
  'core/harnesses/shared/hooks/policies/identity.sh',
];
const SETTINGS_FILE = 'core/registry/settings.json';
const STORAGE_FILE = 'core/registry/storage.json';

function readJson(file: any) { return JSON.parse(fs.readFileSync(path.join(REPO, file), 'utf8')); }

function walkSourceFiles(root: any, prefix: any = ''): any {
  const found: any = [];
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

function sourceComment(line: any, file: any) {
  if (/\.sh$/.test(file)) return /^\s*#/.test(line);
  return /^\s*(?:\/\/|\/\*|\*|\*\/)/.test(line);
}

function markerRanges(text: any, name: any) {
  const lines = text.split('\n');
  const ranges: any = [];
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

function checkConfigHomeSources(sources: any) {
  const errors: any = [];
  for (const { file, text } of sources) {
    const lines = text.split('\n');
    const ranges = markerRanges(text, CONFIG_NAME);
    for (const range of ranges) if (range.invalid) errors.push(`${file}:${range.start + 1} unterminated ${CONFIG_NAME} block`);
    const inline = identityInlineConfigHomeBlock(file, text);
    const allowed: any = [...ranges, ...(inline ? [inline] : [])];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (sourceComment(line, file) || !CONFIG_FORMS.test(line)) continue;
      const approved = file === 'src/runtime/config-home.ts'
        || allowed.some((range: any) => i >= range.start && i <= range.end);
      if (!approved) errors.push(`${file}:${i + 1} config-home access must use ${CONFIG_NAME}`);
      if (BANNED_CONFIG_FORMS.test(line) && !approved) errors.push(`${file}:${i + 1} banned config-home expression`);
    }
  }
  return errors;
}

function extractBlocks(sources: any, name: any) {
  const blocks: any = [];
  const errors: any = [];
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

function configCases(dir: any) {
  const U = undefined;
  const cases: any = [
    [1, U, U], [2, U, 'r'], [3, U, 'H'],
    [4, '', U], [5, '', 'r'], [6, '', 'H'],
    [7, 'r', U], [8, 'r', 'r'], [9, 'r', 'H'],
    [10, 'X', U], [11, 'X', 'r'], [12, 'X', 'H'],
  ];
  const abs: any = { x: path.join(dir, 'xdg'), h: path.join(dir, 'home') };
  return cases.map(([number, xdg, home]: any) => {
    const pick = (value: any) => value === 'X' ? abs.x : value === 'H' ? abs.h : value;
    const env: any = { PATH: process.env.PATH };
    if (xdg !== U) env.XDG_CONFIG_HOME = pick(xdg);
    if (home !== U) env.HOME = pick(home);
    return { number, env };
  });
}

function runBashConfigHome(block: any, env: any, cwd: any) {
  const script = `set -euo pipefail\n${block}\ndoflow_config_home\nprintf '%s' "$DOFLOW_HOME"`;
  const result = spawnBash(['-c', script], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `bash exits 0: ${result.stderr}`);
  assert.equal(result.stderr, '', 'config-home block is silent');
  return result.stdout;
}

function runJsConfigHome(block: any, env: any) {
  const run = new Function('path', `${block}\nreturn doflowConfigHome;`)(path);
  const result = run(env);
  return typeof result === 'string' ? result : result?.dir ?? '';
}

function checkConfigBlocks(blocks: any, dir: any) {
  const errors: any = [];
  const cases = configCases(dir);
  for (const block of blocks) {
    const run = block.inline
      ? (value: any, env: any) => runIdentityInlineConfigHome(value, env, dir)
      : /\.js$/.test(block.file) ? runJsConfigHome : (value: any, env: any) => runBashConfigHome(value, env, dir);
    const viaBash = block.inline || !/\.js$/.test(block.file);
    for (const { number, env } of cases) {
      // Git Bash (MSYS) fills in HOME before the script runs, from the Windows profile when it is absent and
      // as an absolute path when it is relative, so a bash block cannot see those inputs on win32. The cases
      // with an absolute HOME (3, 6, 9, 10-12) still run there.
      if (IS_WIN && viaBash && (env.HOME === undefined || !path.isAbsolute(env.HOME))) continue;
      const configDir = configHome(env).dir ?? '';
      const expected = block.inline && configDir ? path.join(configDir, 'session-env', 'sessions') : configDir;
      const actual = run(block.text, env);
      // Bash reports a Windows path as /c/..., so on win32 the two are compared as the same location.
      const same = IS_WIN && viaBash && actual && expected
        ? samePath(actual, expected)
        : (actual ? path.normalize(actual) : '') === (expected ? path.normalize(expected) : '');
      if (!same) {
        errors.push(`${block.file} config-home case ${number}: expected '${expected}', got '${actual}'`);
      }
    }
  }
  return errors;
}

function runIdentityInlineConfigHome(block: any, env: any, cwd: any) {
  const script = `set -euo pipefail\nsessions="${'${SESSION_DIR:-}'}"\n${block}\nprintf '%s' "$sessions"`;
  const result = spawnBash(['-c', script], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `bash exits 0: ${result.stderr}`);
  assert.equal(result.stderr, '', 'identity config-home copy is silent');
  return result.stdout;
}

function stripComments(text: any) {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

// model-router maps a model backend to its CLI name; that string is not the advice.provider default.
const OLLAMA_LITERAL_ALLOWLIST: any = new Set(['src/runtime/models/model-router.ts']);

function checkNoCopiedDefaults(sources: any, retention: any) {
  const errors: any = [];
  for (const { file, text } of sources) {
    if (OLLAMA_LITERAL_ALLOWLIST.has(file)) continue;
    if (/(?:'ollama'|"ollama")/.test(stripComments(text))) errors.push(`${file} copies the advice.provider default`);
  }
  if (/\b4320\b/.test(stripComments(retention))) errors.push('lifecycle/retention.ts copies the storage.retentionHours default');
  return errors;
}

function shellReadBlockNames(raw: any) {
  return [...new Set(Object.values(raw.keys)
    .map((spec) => spec.shellRead)
    .filter((shellRead) => typeof shellRead === 'string')
    .map((shellRead) => `doflow-settings-${shellRead.replace(/-v(\d+)$/, ' v$1')}`))];
}

function loadLexicalCorpus() {
  const file = path.join(REPO, 'test/settings/lexical.test.ts');
  const source = fs.readFileSync(file, 'utf8');
  const match = source.match(/const CORPUS = (\[[\s\S]*?\n\]);/);
  assert.ok(match, `${file} exports the IC-004 corpus as a literal array`);
  return new Function('BOM', 'NBSP', `return ${match[1]};`)('\u00ef\u00bb\u00bf', '\u00a0');
}

function runJsLexical(block: any) {
  return new Function('fs', `${block}\nreturn lexicalCapture;`)(fs);
}

function runBashLexical(block: any, file: any, cwd: any) {
  const script = `set -euo pipefail\n${block}\ndoflow_lex_capture "$1"\nprintf '%s' "$DOFLOW_LEX_CAPTURE"`;
  const result = spawnBash(['-c', script, 'x', file], {
    // LC_ALL=C pins the byte semantics POSIX gets from an empty environment; Git Bash otherwise picks a locale
    // from the Windows code page, in which byte 0xA0 is a space and the NBSP controls would not hold.
    cwd, env: { PATH: process.env.PATH, LC_ALL: 'C' }, encoding: 'utf8',
  });
  assert.equal(result.status, 0, `bash exits 0: ${result.stderr}`);
  assert.equal(result.stderr, '', 'lexical block is silent');
  return result.stdout === '' ? null : result.stdout;
}

function lexicalMismatches(block: any, corpus: any, dir: any) {
  const mismatches: any = [];
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

function checkSettingsStores(registry: any) {
  const errors: any = [];
  const expected: any = {
    'user-settings-project-doflow': {
      root: 'project-doflow',
      match: '^(?:prompt-nudge|settings\\.json|settings\\.local\\.json)$',
      legacyLocal: true,
    },
    'user-settings-config-home': {
      root: 'config-home',
      match: '^(?:prompt-nudge|settings\\.json)$',
      legacyLocal: false,
    },
  };
  for (const [id, want] of Object.entries(expected)) {
    const store = registry.stores.find((candidate: any) => candidate.id === id);
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
  const docs = fs.readFileSync(path.join(REPO, 'docs/reference.md'), 'utf8');
  assert.deepEqual(checkSettingsDocs(raw, docs, loaded.registry), []);
});

test('G44 S2 control: a scratch settings table missing storage.prune is rejected', (t) => {
  const dir = tempDir(t, 'doflow-settings-doc-control-');
  const raw = readJson(SETTINGS_FILE);
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const fixture = path.join(dir, 'docs', 'reference.md');
  fs.mkdirSync(path.dirname(fixture), { recursive: true });
  fs.writeFileSync(fixture, renderSettingsTable(raw, loaded.registry, { omitKey: 'storage.prune' }));
  const errors = checkSettingsDocs(raw, fs.readFileSync(fixture, 'utf8'), loaded.registry);
  assert.ok(errors.some((message: any) => message.includes('missing storage.prune')), errors.join('\n'));
});

test('G44 S2 control: doubled config-home paths are rejected', () => {
  const raw = readJson(SETTINGS_FILE);
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const docs = fs.readFileSync(path.join(REPO, 'docs/reference.md'), 'utf8');
  const planted = docs.replace('## Settings keys', '<config home>/doflow/settings.json\n## Settings keys');
  const errors = checkSettingsDocs(raw, planted, loaded.registry);
  assert.ok(errors.some((message: any) => message.includes('config home path')), errors.join('\n'));
});

test('G44 S2 control: wrong Type and Legacy file cells are rejected', () => {
  const raw = readJson(SETTINGS_FILE);
  const loaded = loadSettingsRegistry({ repoRoot: REPO, verifyRefs: true });
  assert.equal(loaded.ok, true, loaded.ok ? '' : loaded.detail);
  const good = renderSettingsTable(raw, loaded.registry);
  const row = good.split('\n').find((line: any) => line.includes('| `autopilot.enabled` |'));
  assert.ok(row, 'the fixture has an autopilot.enabled row (the one key that still has a legacy file)');
  const wrong = good.replace(row, row.replace('| enum |', '| string |').replace(' | `autopilot/off` | ', ' | `obsolete-sentinel` | '));
  const errors = checkSettingsDocs(raw, wrong, loaded.registry);
  assert.ok(errors.some((message: any) => message.includes('autopilot.enabled type')), errors.join('\n'));
  assert.ok(errors.some((message: any) => message.includes('autopilot.enabled legacy file')), errors.join('\n'));
});

test('G44 S2 control: default refs receive dependencies from registry metadata and requires', () => {
  const keys: any = new Map([
    ['base.value', { default: 'registry-default' }],
    ['derived.value', { defaultRef: 'fixture.ref', requires: [{ when: true, key: 'base.value', view: 'global' }] }],
  ]);
  const registry: any = {
    keys,
    resolveRef(name: any, deps: any) { return name === 'fixture.ref' ? `resolved:${deps['base.value']}` : undefined; },
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
  assert.deepEqual(blocks.map((block: any) => block.file).sort(), [...CONFIG_BLOCK_FILES].sort());
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

  const jsBlock: any = blocks.find((block) => /\.js$/.test(block.file));
  const broken: any = jsBlock.text.replace("const WS = '[ \\\\t\\\\n\\\\v\\\\f\\\\r]';", "const WS = '\\\\s';");
  assert.notEqual(broken, jsBlock.text, 'the negative control mutates the lexical class');
  assert.ok(lexicalMismatches({ ...jsBlock, text: broken }, corpus, dir).length > 0);
});

test('G44 S6: settings files are declared as existing stores with matching writers and bounds', () => {
  const registry = readJson(STORAGE_FILE);
  assert.deepEqual(checkSettingsStores(registry), []);

  const control = structuredClone(registry);
  const project = control.stores.find((store: any) => store.id === 'user-settings-project-doflow');
  project.writers = project.writers.filter((writer: any) => writer !== 'src/runtime/settings/write.ts');
  const errors = checkSettingsStores(control);
  assert.ok(errors.some((message: any) => message.includes('omits src/runtime/settings/write.ts')));
});

// A file outside src/runtime/settings/ that names a settings layer file may read keys straight from it, past the view
// (which throws on an unregistered key). Every key literal it names in a registered namespace must be registered; a
// `${...}` placeholder stands for one key segment.
const LAYER_FILE_NAME = /settings(?:\.local)?\.json/;
const KEY_LITERAL = /(['"`])([a-z][a-zA-Z0-9]*(?:\.(?:[a-zA-Z0-9-]+|\$\{[^}`'"]+\}))+)\1/g;
const FILE_NAME_LITERAL = /\.(?:json|jsonl|md|ts|js|sh|ya?ml|txt|lock)$/;

function unregisteredSettingsReads(sources: any, keys: string[]) {
  const namespaces = new Set(keys.map((key) => key.split('.')[0]));
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const errors: string[] = [];
  for (const { file, text } of sources) {
    if (file.startsWith('src/runtime/settings/') || !LAYER_FILE_NAME.test(text)) continue;
    for (const match of stripComments(text).matchAll(KEY_LITERAL)) {
      const literal = match[2];
      if (!namespaces.has(literal.split('.')[0]) || FILE_NAME_LITERAL.test(literal)) continue;
      const pattern = new RegExp(`^${literal.split(/\$\{[^}]+\}/).map(escape).join('[a-z0-9-]+')}$`);
      if (!keys.some((key) => pattern.test(key))) errors.push(`${file} reads ${literal}, which ${SETTINGS_FILE} does not register`);
    }
  }
  return [...new Set(errors)];
}

/**
 * Every advice kind that something asks (a non-empty `askedBy`) has its per-kind mode and model keys, and a kind nothing
 * asks (an empty `askedBy`, the offline-measured `rerank`) has neither: a setting for it would change nothing.
 */
function adviceKindKeyFindings(advice: any, keys: string[]) {
  const findings: string[] = [];
  for (const kind of advice.kinds) {
    const asked = Array.isArray(kind.askedBy) && kind.askedBy.length > 0;
    for (const key of [`advice.kinds.${kind.id}`, `advice.models.${kind.id}`]) {
      if (asked && !keys.includes(key)) findings.push(`${SETTINGS_FILE} does not register ${key}`);
      if (!asked && keys.includes(key)) findings.push(`${SETTINGS_FILE} registers ${key}, but kind ${kind.id} has an empty askedBy`);
    }
  }
  return findings;
}

test('G44 S7: every key a direct settings-file reader names is registered, and every asked advice kind has its keys', () => {
  const keys = Object.keys(readJson(SETTINGS_FILE).keys);
  assert.deepEqual(unregisteredSettingsReads(walkSourceFiles(REPO, 'src'), keys), []);
  assert.deepEqual(adviceKindKeyFindings(readJson('core/registry/advice.json'), keys), []);
});

test('G44 S7 control: an unregistered key read by a settings-file reader, a kind without keys and keys of an unasked kind are rejected', () => {
  const advice = readJson('core/registry/advice.json');
  const askedIds = advice.kinds.filter((kind: any) => kind.askedBy.length > 0).map((kind: any) => kind.id);
  const kindKeys = askedIds.flatMap((id: string) => [`advice.kinds.${id}`, `advice.models.${id}`]);
  const keys = [...Object.keys(readJson(SETTINGS_FILE).keys), ...kindKeys];
  const reader = {
    file: 'src/runtime/fake-reader.ts',
    text: "const file = path.join(root, '.doflow', 'settings.json');\nget(content, `advice.kinds.${kind}`);\nget(content, 'advice.planted');\nconst other = 'storage.json';",
  };
  assert.deepEqual(unregisteredSettingsReads([reader], keys), [
    `src/runtime/fake-reader.ts reads advice.planted, which ${SETTINGS_FILE} does not register`,
  ]);
  const withoutKinds = keys.filter((key) => !key.startsWith('advice.kinds.'));
  assert.deepEqual(unregisteredSettingsReads([reader], withoutKinds), [
    `src/runtime/fake-reader.ts reads advice.kinds.\${kind}, which ${SETTINGS_FILE} does not register`,
    `src/runtime/fake-reader.ts reads advice.planted, which ${SETTINGS_FILE} does not register`,
  ]);
  assert.deepEqual(unregisteredSettingsReads([{ ...reader, text: reader.text.replace('settings.json', 'other.json') }], withoutKinds), [],
    'a file that names no settings layer file is not a direct reader');
  assert.deepEqual(adviceKindKeyFindings(advice, keys), []);
  assert.deepEqual(adviceKindKeyFindings(advice, keys.filter((key) => key !== 'advice.models.mcp-need')),
    [`${SETTINGS_FILE} does not register advice.models.mcp-need`]);
  const unasked = advice.kinds.find((kind: any) => kind.askedBy.length === 0);
  assert.ok(unasked, 'the registry keeps one kind with an empty askedBy (rerank, measured offline)');
  assert.deepEqual(adviceKindKeyFindings(advice, [...keys, `advice.kinds.${unasked.id}`]),
    [`${SETTINGS_FILE} registers advice.kinds.${unasked.id}, but kind ${unasked.id} has an empty askedBy`]);
});

// G44 S8 (row 174) — every `advice.*` key in core/registry/settings.json has a live reader, so a setting never again
// ships that nothing reads. A key is live when (1) each of its `consumers` is a shipped src/ file that names the key
// outside a comment and is reached by `require` from src/cli/index.ts, and (2) for `advice.kinds.<k>` and
// `advice.models.<k>`, the kind <k> in core/registry/advice.json has a non-empty `askedBy` whose every entry is a live
// caller of that kind: a runtime caller whose source dispatches it (`interceptDecisionPoint({ kind: '<k>', caller: '<entry>'`;
// a file holding that adjacency also counts when it directly requires a reached module that dispatches the kind, one hop only),
// the `advise` verb for a kind with a static question, or a skill directory of that name whose bash block runs
// `advise --kind <k>`. A kind some caller names but nothing dispatches is how `rerank` and `followup-triage` shipped
// settings that did nothing.
const ADVICE_ENTRY = 'src/cli/index.ts';

function stripSourceComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
}

/** Every src/ file reached by a relative require from the entry, as a set of repo-relative paths. */
function reachedFrom(entry: string, texts: Map<string, string>): Set<string> {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !texts.has(file)) return;
    seen.add(file);
    for (const [, target] of (texts.get(file) as string).matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      const found = [base, `${base}.ts`, `${base}/index.ts`].find((candidate) => texts.has(candidate));
      if (found) visit(found);
    }
  };
  visit(entry);
  return seen;
}

/** True when a bash fence of the skill's markdown holds `advise --kind <id>` on a line that is not a shell comment. */
function skillRunsKind(markdown: string, id: string): boolean {
  const call = new RegExp(`advise --kind ${id}(?![\\w-])`);
  let inBash = false;
  for (const line of markdown.replace(/<!--[\s\S]*?-->/g, ' ').split('\n')) {
    const fence = /^\s*(`{3,}|~{3,})\s*([\w-]*)\s*$/.exec(line);
    if (fence) { inBash = !inBash && /^(?:bash|sh|shell|zsh)$/.test(fence[2]); continue; }
    if (inBash && !/^\s*#/.test(line) && call.test(line)) return true;
  }
  return false;
}

/**
 * True when the source reads the key through the runtime's accessors, not merely names it: `getSettingValue(<obj>, '<key>')`
 * or `<view>.get('<key>'` for a fixed key, and the same call with a template `advice.<group>.${...}` for a per-kind key.
 * A string literal that is only assigned, listed or logged does not read anything.
 */
function readsKey(code: string, key: string, group: string | null): boolean {
  const accessor = String.raw`(?:getSettingValue\(\s*[\w.]+\s*,|\.get\()\s*`;
  const keyText = group ? String.raw`\`advice\.${group}\.\$\{` : `'${key.replace(/\./g, '\\.')}'`;
  return new RegExp(accessor + keyText).test(code);
}

function adviceReaderFindings({ settings, advice, sources, skills }: { settings: any; advice: any; sources: Map<string, string>; skills: Map<string, string> }): string[] {
  const findings: string[] = [];
  const code = new Map([...sources].map(([file, text]) => [file, stripSourceComments(text)]));
  const reached = reachedFrom(ADVICE_ENTRY, sources);
  const requiredFrom = (file: string): string[] => [...(code.get(file) as string).matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)].flatMap(([, target]) => {
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
    return [base, `${base}.ts`, `${base}/index.ts`].filter((candidate) => code.has(candidate)).slice(0, 1);
  });
  const dispatchesKind = (file: string, kind: any): boolean => reached.has(file) && (code.get(file) as string).includes('interceptDecisionPoint(') && (code.get(file) as string).includes(`'${kind.id}'`);
  const liveCaller = (kind: any, caller: string): boolean => {
    for (const [file, text] of skills) {
      if (file.startsWith(`core/shared/skills/${caller}/`) && skillRunsKind(text, kind.id)) return true;
    }
    for (const [file, text] of code) {
      if (!reached.has(file)) continue;
      if (new RegExp(`kind:\\s*'${kind.id}',\\s*caller:\\s*'${caller}'`).test(text)
        && (text.includes('interceptDecisionPoint(') || requiredFrom(file).some((target) => dispatchesKind(target, kind)))) return true;
      if (!text.includes('interceptDecisionPoint(')) continue;
      // The verb takes the kind from --kind, so it dispatches every kind that has a static question.
      if (caller === 'advise' && file === 'src/runtime/advice/cli.ts' && /caller:\s*'advise'/.test(text) && kind.criteriaFrom !== 'call') return true;
    }
    return false;
  };
  for (const [key, spec] of Object.entries<any>(settings.keys)) {
    if (!key.startsWith('advice.')) continue;
    const perKind = /^advice\.(kinds|models)\.(.+)$/.exec(key);
    if (!Array.isArray(spec.consumers) || spec.consumers.length === 0) findings.push(`${key}: no consumers listed`);
    for (const consumer of spec.consumers || []) {
      if (!code.has(consumer)) { findings.push(`${key}: consumer ${consumer} is not a shipped src/ file`); continue; }
      if (!reached.has(consumer)) findings.push(`${key}: consumer ${consumer} is not reached from ${ADVICE_ENTRY}`);
      const names = readsKey(code.get(consumer) as string, key, perKind ? perKind[1] : null);
      if (!names) findings.push(`${key}: consumer ${consumer} does not read it`);
    }
    if (!perKind) continue;
    const kind = advice.kinds.find((entry: any) => entry.id === perKind[2]);
    if (!kind) { findings.push(`${key}: no kind ${perKind[2]} in core/registry/advice.json`); continue; }
    if (!Array.isArray(kind.askedBy) || kind.askedBy.length === 0) { findings.push(`${key}: kind ${kind.id} has an empty askedBy, so nothing asks it`); continue; }
    for (const caller of kind.askedBy) {
      if (!liveCaller(kind, caller)) findings.push(`${key}: kind ${kind.id} lists askedBy '${caller}', which does not dispatch it`);
    }
  }
  return findings;
}

function adviceReaderInputs() {
  const sources = new Map<string, string>(walkSourceFiles(REPO, 'src').map(({ file, text }: any) => [file, text]));
  const skills = new Map<string, string>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (entry.name.endsWith('.md')) skills.set(rel, fs.readFileSync(path.join(REPO, rel), 'utf8'));
    }
  };
  walk('core/shared/skills');
  return { settings: readJson(SETTINGS_FILE), advice: readJson('core/registry/advice.json'), sources, skills };
}

test('G44 S8: every advice.* setting has a live reader: a consumer reached from the CLI, and for a kind key a caller that dispatches the kind', () => {
  const inputs = adviceReaderInputs();
  assert.ok(Object.keys(inputs.settings.keys).filter((key) => key.startsWith('advice.')).length >= 10, 'the advice keys must still be found');
  assert.deepEqual(adviceReaderFindings(inputs), []);
});

test('G44 S8 control: a planted key, a kind nothing asks, a caller that does not call the kind and an unread consumer are each reported', () => {
  const inputs = adviceReaderInputs();
  const plant = (change: (draft: any) => void) => {
    const draft = JSON.parse(JSON.stringify({ settings: inputs.settings, advice: inputs.advice }));
    change(draft);
    return adviceReaderFindings({ ...inputs, settings: draft.settings, advice: draft.advice });
  };
  const key = (consumers: string[]) => ({ ...inputs.settings.keys['advice.kinds.tier'], consumers });

  assert.deepEqual(plant((d) => { d.settings.keys['advice.kinds.ghost'] = key(['src/runtime/advice/shadow-config.ts']); }),
    ['advice.kinds.ghost: no kind ghost in core/registry/advice.json']);
  assert.deepEqual(plant((d) => { d.settings.keys['advice.kinds.rerank'] = key(['src/runtime/advice/shadow-config.ts']); }),
    ['advice.kinds.rerank: kind rerank has an empty askedBy, so nothing asks it']);
  assert.deepEqual(plant((d) => { d.advice.kinds.find((kind: any) => kind.id === 'tier').askedBy.push('retrieve'); }),
    ["advice.kinds.tier: kind tier lists askedBy 'retrieve', which does not dispatch it", "advice.models.tier: kind tier lists askedBy 'retrieve', which does not dispatch it"]);
  assert.deepEqual(plant((d) => { d.advice.kinds.find((kind: any) => kind.id === 'mcp-need').askedBy = ['do-test']; }),
    ["advice.kinds.mcp-need: kind mcp-need lists askedBy 'do-test', which does not dispatch it", "advice.models.mcp-need: kind mcp-need lists askedBy 'do-test', which does not dispatch it"]);
  assert.deepEqual(plant((d) => { d.settings.keys['advice.model'].consumers = ['src/runtime/advice/criteria.ts']; }),
    ["advice.model: consumer src/runtime/advice/criteria.ts is not reached from src/cli/index.ts", "advice.model: consumer src/runtime/advice/criteria.ts does not read it"]);
  assert.deepEqual(plant((d) => { d.settings.keys['advice.model'].consumers = ['src/runtime/advice/missing.ts']; }),
    ['advice.model: consumer src/runtime/advice/missing.ts is not a shipped src/ file']);
  assert.deepEqual(plant((d) => { d.settings.keys['advice.model'].consumers = []; }), ['advice.model: no consumers listed']);

  // A consumer whose only mention of a key is an unused string literal does not read it.
  const stripped = (file: string, drop: RegExp, extra: string) => adviceReaderFindings({ ...inputs, sources: new Map([...inputs.sources, [file, `${(inputs.sources.get(file) as string).replace(drop, 'void 0')}\n${extra}\n`]]) });
  assert.deepEqual(stripped('src/runtime/advice/config.ts', /\.get\('advice\.endpoint'/g, "const unused = 'advice.endpoint';").filter((line) => line.startsWith('advice.endpoint')),
    ['advice.endpoint: consumer src/runtime/advice/config.ts does not read it']);
  assert.deepEqual(stripped('src/runtime/advice/shadow-config.ts', /getSettingValue\(content, `advice\.kinds\.\$\{kind\}`\)/g, 'const unused = `advice.kinds.${kind}`;').filter((line) => line.startsWith('advice.kinds.tier')),
    ['advice.kinds.tier: consumer src/runtime/advice/shadow-config.ts does not read it']);
});

test('G44 S8 control: a caller literal counts through one required module that dispatches the kind, and through nothing else', () => {
  const inputs = adviceReaderInputs();
  const plant = (spec: string) => `require('${spec}');\n`; // built, so G16 does not read it as a real require
  const adjacency = "checkIt({ kind: 'tier', caller: 'planted' });";
  const dispatch = (kind: string) => `interceptDecisionPoint({ kind: '${kind}', caller });`;
  const run = (files: Record<string, string>) => {
    const sources = new Map(inputs.sources);
    sources.set(ADVICE_ENTRY, `${sources.get(ADVICE_ENTRY)}\n${plant('./planted-caller.ts')}`);
    for (const [file, text] of Object.entries(files)) sources.set(file, text);
    const draft = JSON.parse(JSON.stringify(inputs.advice));
    draft.kinds.find((kind: any) => kind.id === 'tier').askedBy.push('planted');
    return adviceReaderFindings({ ...inputs, sources, advice: draft }).filter((line) => line.includes("'planted'"));
  };
  const reported = ["advice.kinds.tier: kind tier lists askedBy 'planted', which does not dispatch it", "advice.models.tier: kind tier lists askedBy 'planted', which does not dispatch it"];
  // No dispatch and no required dispatcher: reported.
  assert.deepEqual(run({ 'src/cli/planted-caller.ts': `${adjacency}\n` }), reported);
  // The required module dispatches a different kind: reported.
  assert.deepEqual(run({ 'src/cli/planted-caller.ts': `${plant('./planted-ask.ts')}${adjacency}\n`, 'src/cli/planted-ask.ts': `${dispatch('mcp-need')}\n` }), reported);
  // The dispatcher is two hops away: reported.
  assert.deepEqual(run({ 'src/cli/planted-caller.ts': `${plant('./planted-mid.ts')}${adjacency}\n`, 'src/cli/planted-mid.ts': plant('./planted-ask.ts'), 'src/cli/planted-ask.ts': `${dispatch('tier')}\n` }), reported);
  // The dispatcher only names the kind in a comment: reported.
  assert.deepEqual(run({ 'src/cli/planted-caller.ts': `${plant('./planted-ask.ts')}${adjacency}\n`, 'src/cli/planted-ask.ts': `${dispatch('mcp-need')}\n// 'tier'\n` }), reported);
  // One hop to a module that dispatches the kind: live.
  assert.deepEqual(run({ 'src/cli/planted-caller.ts': `${plant('./planted-ask.ts')}${adjacency}\n`, 'src/cli/planted-ask.ts': `${dispatch('tier')}\n` }), []);
});

test('G44 S8 control: the comment-stripping and fence rules ignore a call that only a comment or a shell comment makes', () => {
  assert.equal(skillRunsKind('```bash\n# advise --kind tier\n```\n', 'tier'), false);
  assert.equal(skillRunsKind('advise --kind tier in prose\n', 'tier'), false);
  assert.equal(skillRunsKind('```bash\n"$DOFLOW" advise --kind tier --state x\n```\n', 'tier'), true);
  assert.equal(skillRunsKind('```bash\n"$DOFLOW" advise --kind tier-x --state x\n```\n', 'tier'), false);
  assert.equal(stripSourceComments("// interceptDecisionPoint(\nconst a = 1; // kind: 'tier'\n/* caller: 'x' */").includes('interceptDecisionPoint'), false);
});

// A function that takes an `env` resolves the storage roots and the settings layers from it, never from this process's
// environment: `resolveRoots` and the settings readers default `env` to process.env, so a dropped `env` reads the
// developer's real config home under a caller (a test, a worker) that passed a scratch one.
const ENV_READERS = ['resolveRoots', 'resolveSetting', 'resolveShadowConfig', 'profileAdvisorCap', 'loadSettings'];

function balanced(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return text.slice(open, i + 1); }
  }
  return '';
}

/** Whether any named function whose body holds `at` (the call itself or a closure around it) takes an `env` parameter. */
function enclosingTakesEnv(text: string, at: number): boolean {
  for (const header of text.slice(0, at).matchAll(/\bfunction\b[^(]*\(/g)) {
    const open = header.index + header[0].length - 1;
    const params = balanced(text, open);
    const bodyStart = text.indexOf('{', open + params.length);
    if (bodyStart < 0 || bodyStart > at || bodyStart + balanced(text, bodyStart).length < at) continue;
    if (/\benv\b/.test(params)) return true;
  }
  return false;
}

function droppedEnv(sources: any) {
  const errors: string[] = [];
  const call = new RegExp(`\\b(${ENV_READERS.join('|')})\\(`, 'g');
  for (const { file, text } of sources) {
    if (!/\.ts$/.test(file) || file.startsWith('src/runtime/settings/')) continue;
    for (const match of text.matchAll(call)) {
      const args = balanced(text, match.index + match[0].length - 1);
      if (!/^\(\s*(?:'[^']*',\s*)?\{/.test(args) || /\benv\b/.test(args)) continue;
      if (enclosingTakesEnv(text, match.index)) errors.push(`${file}:${text.slice(0, match.index).split('\n').length} ${match[1]} drops the env its function was given`);
    }
  }
  return errors;
}

test('G44 S8: a function given an env passes it to every roots and settings reader it calls', () => {
  assert.deepEqual(droppedEnv(walkSourceFiles(REPO, 'src')), []);
});

test('G44 S8 control: a reader call without the env its function took is rejected, and one with it passes', () => {
  const planted = (args: string) => ({
    file: 'src/runtime/fake-env.ts',
    text: `function run({ projectRoot, env = process.env }: any) {\n  const roots = resolveRoots({ registry, projectRoot${args} });\n  return resolveShadowConfig('tier', { projectRoot${args}, roots });\n}\nfunction other({ projectRoot }: any) { return resolveRoots({ registry, projectRoot }); }\nfunction outer({ env }: any) {\n  async function inner() { return resolveRoots({ registry }); }\n}\n`,
  });
  assert.deepEqual(droppedEnv([planted('')]), [
    'src/runtime/fake-env.ts:2 resolveRoots drops the env its function was given',
    'src/runtime/fake-env.ts:3 resolveShadowConfig drops the env its function was given',
    'src/runtime/fake-env.ts:7 resolveRoots drops the env its function was given',
  ]);
  assert.deepEqual(droppedEnv([planted(', env')]), ['src/runtime/fake-env.ts:7 resolveRoots drops the env its function was given'], 'a closure inside a function given env counts too');
});
