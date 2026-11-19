'use strict';

// G87 — the local replay of a decision model (row 175, design §13) stays neutral, model-free in tests and closed in what
// it stores.
//   G87.1  neutral text: no vendor name (the inventory's `vendorNames` in prompt-frame-sites.json), no provider `id`,
//          `adapter` or `modelProvider` literal from advice.json, and no `name:tag` model literal in
//          src/runtime/advice/replay/**, the `bars` and `replay` blocks of advice.json, and the docs section headed
//          "Decision model: replay and local results" (any heading level). The check fails closed when that section is
//          absent. A provider is named by its id from data, never by a literal.
//   G87.2  no model in tests: every file under test/ whose text runs `--action replay` or requires `replay/run` also
//          requires the fake decision server or injects a `client` (never a real `createAdviceClient`), so no test reaches a
//          model; `--action replay`, `--action=replay` and `{ action: 'replay' }` all count as running replay. This file is left out of
//          the scan: it holds the planted controls as text.
//   G87.3  one bars schema: every kind's effective bars validate, every `replay.source` is a source the seam knows, and
//          every source the seam knows has a fixture test under test/runtime/ that names its id and requires its module.
//   G87.4  store allowlist: the result store's allowlist holds only the design §8 keys, and every leaf of it is a shape
//          that cannot hold free text (a slug, a model name, a digest, a count, a number, a time, a version).
//   Controls: each check fails on a planted-bad copy (a temp folder or a changed copy of the data), never on the tree.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadAdviceRegistry, validateBars } = require('../../src/runtime/advice/registry.ts');
const { effectiveBars } = require('../../src/runtime/advice/replay/bars.ts');
const { SOURCE_IDS } = require('../../src/runtime/advice/replay/sources/index.ts');
const { ENTRY_FIELDS } = require('../../src/runtime/advice/replay/results.ts');

const REPLAY_DIR = path.join('src', 'runtime', 'advice', 'replay');
const DOCS_FILE = path.join('docs', 'reference.md');
const DOCS_TITLE = 'Decision model: replay and local results';
const ADVICE_FILE = path.join('core', 'registry', 'advice.json');
const VENDORS: string[] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test/guards/prompt-frame-sites.json'), 'utf8')).vendorNames;
const ADVICE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ADVICE_FILE), 'utf8'));

function filesUnder(dir: string, keep: (file: string) => boolean): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      if (entry.isDirectory()) walk(file); else if (keep(file)) out.push(file);
    }
  };
  walk(dir);
  return out.sort();
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- G87.1

/** A quoted literal shaped like a model name and tag, `name:tag` (a `node:` module specifier is not one). */
const MODEL_LITERAL = /(["'`])(?!node:)([A-Za-z][\w.-]*:[A-Za-z0-9][\w.-]*)\1/g;

/** Provider words from advice.json: every `id`, `adapter` and `modelProvider`, once each. */
function providerWords(registry: any): string[] {
  return [...new Set<string>((registry.providers || []).flatMap((p: any) => [p.id, p.adapter, p.modelProvider]).filter((w: any) => typeof w === 'string' && w))];
}

/** What is wrong with `text`: a vendor name, a provider word, a model literal. `where` names the text in each finding. */
function neutralFindings(where: string, text: string, providers: string[]): string[] {
  const found: string[] = [];
  for (const vendor of VENDORS) if (new RegExp(`\\b${escapeRegex(vendor)}\\b`, 'i').test(text)) found.push(`${where}: vendor name '${vendor}'`);
  for (const word of providers) if (new RegExp(escapeRegex(word), 'i').test(text)) found.push(`${where}: provider word '${word}'`);
  for (const match of text.matchAll(MODEL_LITERAL)) found.push(`${where}: model literal ${match[0]}`);
  return found;
}

/** The text between the heading `title` (any level) and the next heading of the same or a higher level, or null. */
function docsSection(text: string, title: string): string | null {
  const lines = text.split('\n');
  let level = 0;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(lines[i]);
    if (!heading) continue;
    if (start < 0) {
      if (heading[2] === title) { level = heading[1].length; start = i + 1; }
    } else if (heading[1].length <= level) return lines.slice(start, i).join('\n');
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

/** Findings over the replay folder, `bars` and `replay` data of `registry`, under `root`. */
function codeFindings(root: string, registry: any): string[] {
  const providers = providerWords(registry);
  const found: string[] = [];
  for (const file of filesUnder(path.join(root, REPLAY_DIR), () => true)) {
    found.push(...neutralFindings(path.relative(root, file), fs.readFileSync(file, 'utf8'), providers));
  }
  const blocks = { bars: registry.bars, kinds: (registry.kinds || []).map((kind: any) => ({ id: kind.id, replay: kind.replay, bars: kind.bars })) };
  found.push(...neutralFindings(`${ADVICE_FILE} bars and replay blocks`, JSON.stringify(blocks), providers));
  return found;
}

/** Findings over the docs section; an absent section is a finding (fail closed). */
function docsFindings(root: string, registry: any): string[] {
  const section = docsSection(fs.readFileSync(path.join(root, DOCS_FILE), 'utf8'), DOCS_TITLE);
  if (section === null) return [`${DOCS_FILE}: no section headed "${DOCS_TITLE}"`];
  return neutralFindings(`${DOCS_FILE} "${DOCS_TITLE}"`, section, providerWords(registry));
}

/** A temp copy of the replay folder and the docs file, the shape `codeFindings` and `docsFindings` read. */
function copyOfTree(t: any, docs: string) {
  const root = tempDir(t, 'doflow-g87-');
  fs.cpSync(path.join(REPO_ROOT, REPLAY_DIR), path.join(root, REPLAY_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, DOCS_FILE), docs);
  return root;
}

test('G87.1: the replay code and the bars and replay data name no vendor, no provider and no model', () => {
  assert.deepEqual(codeFindings(REPO_ROOT, ADVICE), []);
});

test('G87.1: the docs section "Decision model: replay and local results" exists and names no vendor, provider or model', () => {
  assert.deepEqual(docsFindings(REPO_ROOT, ADVICE), []);
});

test('G87.1 control: a provider word in run.ts, a vendor name, a model literal and a missing docs section are each found', (t) => {
  const root = copyOfTree(t, `# Reference\n\n## ${DOCS_TITLE}\n\nA neutral paragraph.\n\n## Next\n\nClaude is named here, outside the section.\n`);
  assert.deepEqual(codeFindings(root, ADVICE), [], 'the copy is clean before the plant');
  assert.deepEqual(docsFindings(root, ADVICE), [], 'a name outside the section does not count');

  const run = path.join(root, REPLAY_DIR, 'run.ts');
  fs.appendFileSync(run, `\nconst planted = '${providerWords(ADVICE)[0]}';\n`);
  assert.ok(codeFindings(root, ADVICE).some((finding) => finding.includes(`${path.join(REPLAY_DIR, 'run.ts')}: provider word`)));
  fs.appendFileSync(run, `\nconst vendor = '${VENDORS[0]}';\n`);
  assert.ok(codeFindings(root, ADVICE).some((finding) => finding.includes(`vendor name '${VENDORS[0]}'`)));
  fs.appendFileSync(run, `\nconst model = 'tiny3:8b';\n`);
  assert.ok(codeFindings(root, ADVICE).some((finding) => finding.includes("model literal 'tiny3:8b'")));

  fs.writeFileSync(path.join(root, DOCS_FILE), `# Reference\n\n### ${DOCS_TITLE}\n\nClaude judges the answers.\n\n### Next\n\nx\n`);
  assert.ok(docsFindings(root, ADVICE).some((finding) => finding.includes("vendor name 'Claude'")), 'a vendor name in the section is found at any heading level');
  fs.writeFileSync(path.join(root, DOCS_FILE), '# Reference\n\n## Another section\n\nx\n');
  assert.deepEqual(docsFindings(root, ADVICE), [`${DOCS_FILE}: no section headed "${DOCS_TITLE}"`]);

  const planted = { ...ADVICE, bars: { ...ADVICE.bars, note: `${VENDORS[1]} model` } };
  assert.ok(codeFindings(REPO_ROOT, planted).some((finding) => finding.includes('bars and replay blocks')));
});

// ---------------------------------------------------------------- G87.2

// Runs replay: the argv forms `--action replay` and `--action=replay`, a handler call `{ action: 'replay' }`, or a require of replay/run.
const RUNS_REPLAY = /--action(=|['"`,\s]+)replay\b|\baction\s*:\s*['"`]replay['"`]|require\([^)]*replay\/run(\.ts|\.js)?['"`]\)/;
// Model-free: the fake decision server, or a `createClient` / `client` injection. A real `createAdviceClient` is never model-free.
const NO_MODEL = /fake-decision-server|createClient|\bclient\s*[:,}]/;
const REAL_CLIENT = /\bcreateAdviceClient\b/;

/** Test files under `testRoot` that run replay and neither use the fake decision server nor inject a client. */
function modelReachingTests(testRoot: string, skip: string | null = null): string[] {
  return filesUnder(testRoot, (file) => /\.(ts|js)$/.test(file) && file !== skip)
    .filter((file) => {
      const text = fs.readFileSync(file, 'utf8');
      return RUNS_REPLAY.test(text) && (REAL_CLIENT.test(text) || !NO_MODEL.test(text));
    })
    .map((file) => path.relative(testRoot, file));
}

test('G87.2: every test that runs replay uses the fake decision server or injects a client', () => {
  assert.deepEqual(modelReachingTests(path.join(REPO_ROOT, 'test'), __filename), []);
});

test('G87.2 control: a test file that runs replay with neither is found; one with the fake server is not', (t) => {
  const dir = tempDir(t, 'doflow-g87-tests-');
  const verb = ['--action', 'replay'].join(' ');
  fs.writeFileSync(path.join(dir, 'bad.test.ts'), `spawn(node, [bin, 'advise', '${verb}', '--kind', 'x']);\n`);
  fs.writeFileSync(path.join(dir, 'bad-require.test.ts'), "const { handleReplay } = require('../../src/runtime/advice/replay/run.ts');\n");
  fs.writeFileSync(path.join(dir, 'ok-server.test.ts'), `const { startFakeServer } = require('../helper/fake-decision-server.ts');\nspawn(node, [bin, 'advise', '--action', 'replay']);\n`);
  fs.writeFileSync(path.join(dir, 'ok-client.test.ts'), "const { handleReplay } = require('../../src/runtime/advice/replay/run.ts');\nhandleReplay(o, r, { createClient: () => fake });\n");
  fs.writeFileSync(path.join(dir, 'unrelated.test.ts'), "const x = require('../../src/runtime/advice/replay/score.ts');\n");
  assert.deepEqual(modelReachingTests(dir), ['bad-require.test.ts', 'bad.test.ts']);
});

test('G87.2 control: the equals form, a direct handler call and a real client are each found', (t) => {
  const dir = tempDir(t, 'doflow-g87-forms-');
  const verb = ['--action', 'replay'].join('=');
  fs.writeFileSync(path.join(dir, 'bad-equals.test.ts'), `spawn(node, [bin, 'advise', '${verb}', '--kind', 'x']);\n`);
  fs.writeFileSync(path.join(dir, 'bad-handler.test.ts'), `handleAdviseCommand({ action: 'replay', kind: 'x' }, roots);\n`);
  fs.writeFileSync(path.join(dir, 'bad-real-client.test.ts'), `const client = createAdviceClient({ adviceRegistry, roots });\nspawn(node, [bin, 'advise', '--action', 'replay']);\n`);
  fs.writeFileSync(path.join(dir, 'ok-handler.test.ts'), `const { startFakeServer } = require('../helper/fake-decision-server.ts');\nhandleAdviseCommand({ action: 'replay', kind: 'x' }, roots);\n`);
  assert.deepEqual(modelReachingTests(dir), ['bad-equals.test.ts', 'bad-handler.test.ts', 'bad-real-client.test.ts']);
});

// ---------------------------------------------------------------- G87.3

/** Source ids of `ids` that have no test file under `runtimeTests` naming the id and requiring `sources/<id>`. */
function sourcesWithoutFixtureTest(ids: readonly string[], runtimeTests: string): string[] {
  const texts = filesUnder(runtimeTests, (file) => /\.test\.(ts|js)$/.test(file)).map((file) => fs.readFileSync(file, 'utf8'));
  return ids.filter((id) => !texts.some((text) => text.includes(id) && new RegExp(`require\\([^)]*sources/${escapeRegex(id)}(\\.ts|\\.js)?['"\`]\\)`).test(text)));
}

/** Messages for each kind of `registry` whose effective bars do not validate, and each `replay.source` the seam lacks. */
function schemaFindings(registry: any): string[] {
  const found: string[] = [];
  for (const kind of registry.kinds || []) {
    const effective = effectiveBars({ registry, kind: kind.id, roots: {} });
    if (!effective.ok) { found.push(`${kind.id}: ${effective.errors.join('; ')}`); continue; }
    const errors: string[] = [];
    validateBars(effective.bars, `${kind.id} effective bars`, errors);
    found.push(...errors);
    if (kind.replay && !SOURCE_IDS.includes(kind.replay.source)) found.push(`${kind.id}: replay.source '${kind.replay.source}' is not in the seam map`);
  }
  return found;
}

/** The registry loader's verdict on a copy of advice.json changed by `mutate`, in a temp folder. */
function loadChanged(t: any, mutate: (registry: any) => void) {
  const registry = JSON.parse(JSON.stringify(ADVICE));
  mutate(registry);
  const file = path.join(tempDir(t, 'doflow-g87-advice-'), 'advice.json');
  fs.writeFileSync(file, JSON.stringify(registry));
  return loadAdviceRegistry({ repoRoot: REPO_ROOT, file });
}

test('G87.3: every kind has valid effective bars, and every replay source is in the seam map', () => {
  assert.deepEqual(schemaFindings(ADVICE), []);
  assert.ok(ADVICE.kinds.some((kind: any) => kind.replay), 'at least one kind replays');
});

test('G87.3: every source in the seam map has a fixture test that names its id and requires its module', () => {
  assert.ok(SOURCE_IDS.length > 0);
  assert.deepEqual(sourcesWithoutFixtureTest(SOURCE_IDS, path.join(REPO_ROOT, 'test', 'runtime')), []);
});

test('G87.3 control: a partial bars block, an unknown source id and a source without a fixture test are each found', (t) => {
  const partial = JSON.parse(JSON.stringify(ADVICE));
  partial.kinds[0].bars = { version: 1 };
  assert.ok(schemaFindings(partial).length > 0, 'a kind with a partial bars block does not validate');
  assert.equal(loadChanged(t, (registry) => { registry.kinds[0].bars = { version: 1 }; }).ok, false, 'the registry refuses a partial bars block');

  const unknown = JSON.parse(JSON.stringify(ADVICE));
  unknown.kinds.find((kind: any) => kind.replay).replay.source = 'no-such-source';
  assert.ok(schemaFindings(unknown).some((finding) => finding.includes("'no-such-source'")));
  const refused = loadChanged(t, (registry) => { registry.kinds.find((kind: any) => kind.replay).replay.source = 'no-such-source'; });
  assert.equal(refused.ok, false);
  assert.match(refused.detail, /replay\.source/);

  assert.deepEqual(sourcesWithoutFixtureTest([...SOURCE_IDS, 'ghost-source'], path.join(REPO_ROOT, 'test', 'runtime')), ['ghost-source']);
});

// ---------------------------------------------------------------- G87.4

/** The keys of design §8 an entry may hold; the leaf is the shape a value must have, none of which can hold free text. */
const LEAVES = ['id', 'model', 'digest', 'origin', 'count', 'figure', 'time', 'version', 'reasons'];
const ENTRY_KEYS: any = {
  kind: null, provider: null, model: null, modelDigest: null, questionDigest: null, builderDigest: null, barsDigest: null,
  caseSet: { source: null, origin: null, projectKey: null, digest: null, eligible: null, replayed: null },
  metrics: {
    n: null, valid: null, validShare: null, noAnswer: { count: null, share: null, byReason: null }, accuracy: { model: null, rule: null },
    kappa: { model: null, rule: null, lower: null, gain: null, gainLower: null }, worse: null, better: null, worseShare: null,
    minority: null, latencyMs: { first: null, p50: null, p95: null, max: null },
  },
  runAt: null, doflowVersion: null,
};

/** Fields of `allowed` the allowlist `fields` holds that are not in `shape`, and leaves that are not a no-text shape. */
function allowlistFindings(fields: any, shape: any = ENTRY_KEYS, where = 'entry'): string[] {
  const found: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (!Object.hasOwn(shape, key)) { found.push(`${where}.${key} is not a design §8 key`); continue; }
    if (typeof value === 'string') {
      if (!LEAVES.includes(value)) found.push(`${where}.${key} has the leaf shape '${value}', which may hold text`);
      if (shape[key] !== null) found.push(`${where}.${key} should be an object`);
    } else {
      if (shape[key] === null) found.push(`${where}.${key} should be a leaf`);
      else found.push(...allowlistFindings(value, shape[key], `${where}.${key}`));
    }
  }
  for (const key of Object.keys(shape)) if (!Object.hasOwn(fields, key)) found.push(`${where}.${key} is missing from the allowlist`);
  return found;
}

test('G87.4: the result store allowlist holds only the design §8 keys, each with a shape that cannot hold text', () => {
  assert.deepEqual(allowlistFindings(ENTRY_FIELDS), []);
});

test('G87.4 control: a planted `state` field, a planted nested field and a free-text leaf are each found', () => {
  assert.deepEqual(allowlistFindings({ ...ENTRY_FIELDS, state: 'id' }), ['entry.state is not a design §8 key']);
  assert.deepEqual(allowlistFindings({ ...ENTRY_FIELDS, caseSet: { ...ENTRY_FIELDS.caseSet, text: 'id' } }), ['entry.caseSet.text is not a design §8 key']);
  assert.deepEqual(allowlistFindings({ ...ENTRY_FIELDS, kind: 'text' }), ["entry.kind has the leaf shape 'text', which may hold text"]);
  const { runAt, ...without } = ENTRY_FIELDS;
  assert.deepEqual(allowlistFindings(without), ['entry.runAt is missing from the allowlist']);
});
