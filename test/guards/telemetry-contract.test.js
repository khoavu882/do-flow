'use strict';

// G44 (provisional number: the next free G at merge time; 086 also adds a guard) - telemetry
// contract (feature 088, IC-001, IC-002, IC-018; FR-001, FR-007, NFR-001, NFR-006, NFR-010).
//
// `core/registry/telemetry.json` is the one list of keys a telemetry line may carry. This guard fails
// when the registry and what the repository writes disagree: a key written but not declared (or the
// reverse), a node process on a shell hook path, a network client in the runtime, a skill that sends
// the model to a trace view, a dependency, or a telemetry store the retention registry does not
// declare. Each check is a pure function so the self-tests can run it on planted input.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir, suiteTempDir, removeTree } = require('../helper/tmp');
const { TelemetryWriter } = require('../../src/runtime/trace/telemetry.ts');
const { RunLedger } = require('../../src/runtime/trace/ledger.ts');

const REGISTRY_FILE = 'core/registry/telemetry.json';
const WRITER_FILE = 'src/runtime/trace/telemetry.ts';
const FIXTURE_DIR = 'test/fixtures/telemetry';
const TYPE_ATOMS = new Set(['token', 'id', 'uint', 'int', 'hex16', 'hex32', 'iso8601ms', 'date', 'null']);
const FIELD_KEY = /^[a-z][a-z0-9_]*$/;
const READ_ONLY_TYPES = new Set(['runkey']); // recordFields only: a run key is `<hex16>/<run>/<lineage>`

// --- G44.1: the allowlist equals what is written ------------------------------------------------

/** The registry is well formed: classes, names, types and vocabularies all resolve. */
function checkRegistryShape(registry) {
  const errors = [];
  const at = (where, message) => errors.push(`${REGISTRY_FILE} ${where}: ${message}`);
  if (registry.version !== 1) at('version', 'must be 1');
  if (registry.keyPrefix !== 'doflow.') at('keyPrefix', "must be 'doflow.'");
  const classes = new Set(Object.keys(registry.classes || {}));
  const vocabularies = registry.vocabularies || {};
  const typeErrors = (type) => {
    if (typeof type !== 'string' || type === '') return ['is not a string'];
    return type.split('|').flatMap((atom) => {
      if (TYPE_ATOMS.has(atom) || READ_ONLY_TYPES.has(atom)) return [];
      if (atom.startsWith('enum:')) return Object.hasOwn(vocabularies, atom.slice(5)) ? [] : [`names no vocabulary '${atom.slice(5)}'`];
      return [`has unknown type '${atom}'`];
    });
  };
  for (const [name, values] of Object.entries(vocabularies)) {
    if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string' || value === '')) at(`vocabularies.${name}`, 'must be a non-empty array of strings');
    else if (new Set(values).size !== values.length) at(`vocabularies.${name}`, 'has duplicate values');
  }
  const common = Array.isArray(registry.common) ? registry.common : [];
  if (!common.length) at('common', 'must be a non-empty array');
  for (const key of common) {
    if (!classes.has((registry.commonClasses || {})[key])) at(`commonClasses.${key}`, 'is missing or names an unknown class');
  }
  const kinds = registry.kinds || {};
  if (JSON.stringify(Object.keys(kinds).sort()) !== JSON.stringify([...(vocabularies.kind || [])].sort())) at('vocabularies.kind', 'must list exactly the declared kinds');
  for (const [kind, spec] of Object.entries(kinds)) {
    if (typeof spec.store !== 'string' || !spec.store) at(`kinds.${kind}.store`, 'must name a store');
    if (!Array.isArray(spec.writers) || spec.writers.length === 0) at(`kinds.${kind}.writers`, 'must list the files that write the kind');
    for (const [key, field] of Object.entries(spec.fields || {})) {
      const where = `kinds.${kind}.fields.${key}`;
      if (!FIELD_KEY.test(key)) at(where, 'key must match ^[a-z][a-z0-9_]*$');
      if (common.includes(key)) at(where, 'repeats a common key');
      if (field.name !== `${registry.keyPrefix}${kind}.${key}`) at(`${where}.name`, `must be '${registry.keyPrefix}${kind}.${key}'`);
      if (!classes.has(field.class)) at(`${where}.class`, 'names an unknown class');
      if (field.class === 'T4') at(`${where}.class`, 'T4 content is never recorded');
      for (const message of typeErrors(field.type)) at(`${where}.type`, message);
      if (field.type && field.type.split('|').some((atom) => READ_ONLY_TYPES.has(atom))) at(`${where}.type`, 'runkey is for recordFields only');
      if (!/^P\d/.test(field.phase || '')) at(`${where}.phase`, 'must name the phase that first writes the key');
    }
  }
  for (const [key, field] of Object.entries(registry.recordFields || {})) {
    if (!classes.has(field.class)) at(`recordFields.${key}.class`, 'names an unknown class');
    for (const message of typeErrors(field.type)) at(`recordFields.${key}.type`, message);
  }
  for (const entry of registry.excludedStores || []) {
    if (!entry.store || !String(entry.reason || '').trim()) at('excludedStores', 'every entry needs a store and a reason');
  }
  if (/gen_ai\./.test(JSON.stringify(registry))) at('', "no 'gen_ai.*' key belongs to contract v1 (FR-001)");
  return errors;
}

/** Vocabularies that another registry owns equal that registry's list. */
function checkVocabularyOwners(registry, owners) {
  const errors = [];
  for (const [vocabulary, expected] of Object.entries(owners)) {
    if (JSON.stringify(registry.vocabularies[vocabulary]) !== JSON.stringify(expected.values)) {
      errors.push(`${REGISTRY_FILE} vocabularies.${vocabulary} differs from ${expected.owner}: [${expected.values.join(',')}]`);
    }
  }
  return errors;
}

/** The keys a shell writer's `printf` format carries, by kind: `[{ kind, keys, line }]`. */
function printfKeys(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    if (!/printf/.test(line)) return;
    const kind = /"kind"\s*:\s*"([a-z.]+)"/.exec(line);
    if (!kind) return;
    found.push({ kind: kind[1], keys: [...line.matchAll(/"([a-z][a-z0-9_]*)"\s*:/g)].map((match) => match[1]), line: index + 1 });
  });
  return found;
}

/**
 * Every observed line key is declared, and every declared field is observed.
 * `observations` is `[{ source, kind, keys }]`; common keys are checked for membership only.
 */
function checkAllowlist(registry, observations) {
  const errors = [];
  const common = new Set(registry.common);
  const seen = new Map(Object.keys(registry.kinds).map((kind) => [kind, new Set()]));
  for (const { source, kind, keys } of observations) {
    if (!Object.hasOwn(registry.kinds, kind)) { errors.push(`${source}: kind '${kind}' is not in ${REGISTRY_FILE}`); continue; }
    for (const key of keys) {
      if (common.has(key) || key === 'kind') continue;
      if (!Object.hasOwn(registry.kinds[kind].fields, key)) errors.push(`${source}: kind ${kind} writes '${key}', which ${REGISTRY_FILE} does not declare`);
      seen.get(kind).add(key);
    }
  }
  for (const [kind, spec] of Object.entries(registry.kinds)) {
    for (const key of Object.keys(spec.fields)) {
      if (!seen.get(kind).has(key)) errors.push(`${REGISTRY_FILE} kind ${kind} declares '${key}', which no writer, format or fixture line carries`);
    }
  }
  return errors;
}

/** A value that passes `type`, for the writer observation. */
function sampleValue(type, vocabularies) {
  const atom = type.split('|').find((candidate) => candidate !== 'null');
  if (atom.startsWith('enum:')) return vocabularies[atom.slice(5)][0];
  return {
    token: 'a', id: 'a', uint: 1, int: -1, hex16: '0'.repeat(16), hex32: '0'.repeat(32),
    iso8601ms: '2026-10-17T00:00:00.000Z', date: '2026-10-17',
  }[atom];
}

/** What the real `TelemetryWriter` writes for a record that supplies every declared key plus a stranger. */
function writerObservations(registry) {
  const root = suiteTempDir('doflow-g44-');
  try {
    fs.mkdirSync(path.join(root, '.doflow', 'state', 'runs'), { recursive: true });
    const records = Object.entries(registry.kinds)
      .filter(([, spec]) => spec.writers.includes(WRITER_FILE))
      .map(([kind, spec]) => ({
        kind,
        stranger_key: 'x',
        ...Object.fromEntries(Object.entries(spec.fields).map(([key, field]) => [key, sampleValue(field.type, registry.vocabularies)])),
      }));
    new TelemetryWriter({ registry, env: {}, start: root, now: () => new Date('2026-10-17T00:00:00.000Z') }).write(records);
    const dir = path.join(root, '.doflow', 'state', 'runs', 'telemetry');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map((line) => {
      const parsed = JSON.parse(line);
      return { source: `${WRITER_FILE} (TelemetryWriter output)`, kind: parsed.kind, keys: Object.keys(parsed) };
    }));
  } finally {
    removeTree(root);
  }
}

function shippedObservations(registry) {
  const observations = writerObservations(registry);
  for (const spec of Object.values(registry.kinds)) {
    for (const file of spec.writers.filter((writer) => writer.endsWith('.sh'))) {
      const abs = path.join(REPO, file);
      if (!fs.existsSync(abs)) continue;
      for (const hit of printfKeys(fs.readFileSync(abs, 'utf8'))) observations.push({ source: `${file}:${hit.line}`, kind: hit.kind, keys: hit.keys });
    }
  }
  const dir = path.join(REPO, FIXTURE_DIR);
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir).filter((entry) => entry.endsWith('.jsonl'))) {
      fs.readFileSync(path.join(dir, name), 'utf8').split('\n').forEach((line, index) => {
        if (!line.trim()) return;
        const parsed = JSON.parse(line);
        observations.push({ source: `${FIXTURE_DIR}/${name}:${index + 1}`, kind: parsed.kind, keys: Object.keys(parsed) });
      });
    }
  }
  return observations;
}

// --- G44.2: no node on a shell hook path --------------------------------------------------------

const HOOK_ROOTS = ['core/harnesses/shared/hooks', 'core/harnesses/antigravity/hooks', 'core/harnesses/claude/hooks',
  'core/harnesses/codex/hooks', 'core/harnesses/gemini/hooks', 'core/harnesses/kiro/hooks', 'core/harnesses/pi/extensions'];
/** The only scripts that are node by nature: the shared runner, the Antigravity adapter, the Pi extension. */
const PINNED_NODE_FILES = ['core/harnesses/pi/extensions/doflow-guard.js', 'core/harnesses/shared/hooks/adapters/antigravity.js', 'core/harnesses/shared/hooks/stream-hook-runner.js'];
/** Front doors that hand the payload to the shared runner by design (`exec node .../stream-hook-runner.js`). */
const PINNED_RUNNER_DOORS = ['core/harnesses/antigravity/hooks/pre-implementation-gate.sh', 'core/harnesses/antigravity/hooks/stop-check.sh'];
const NODE_COMMAND = /(^|[;&|(`]|\$\()\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+|(?:env|exec|command|sudo|then|do|else|elif|if|while|until|time)\s+)*(?:node|nodejs|npx|tsx|deno|bun)(?=\s|$|;|\))/;

/** `files` is `[{ rel, text }]`: every file under the hook roots. */
function checkNoNodeOnHooks(files) {
  const errors = [];
  const isScript = (rel) => /\.(?:sh|jq|conf)$/.test(rel);
  const isNodeFile = (rel) => /\.(?:js|cjs|mjs|ts)$/.test(rel);
  for (const { rel, text } of files) {
    if (isNodeFile(rel)) {
      if (!PINNED_NODE_FILES.includes(rel)) errors.push(`${rel} is a node file on a hook path and is not in the pinned list`);
      continue;
    }
    if (!isScript(rel) && !text.startsWith('#!')) continue;
    text.split('\n').forEach((line, index) => {
      if (/^\s*#/.test(line)) return;
      if (PINNED_RUNNER_DOORS.includes(rel) && /^\s*exec node "\$\(dirname "\$0"\)\/\.\.\/\.\.\/\.doflow\/shared\/hooks\/stream-hook-runner\.js" \w+\s*$/.test(line)) return;
      if (NODE_COMMAND.test(line)) errors.push(`${rel}:${index + 1} starts a node process on a hook path`);
    });
  }
  for (const pinned of PINNED_NODE_FILES) {
    if (!files.some(({ rel }) => rel === pinned)) errors.push(`pinned node file ${pinned} is gone: update PINNED_NODE_FILES`);
  }
  return errors;
}

// --- G44.3: no network client in the runtime ----------------------------------------------------

/** The model-endpoint client of feature 072; 088 adds nothing here (NFR-006). */
const PINNED_NETWORK_FILES = ['src/runtime/advice/client.ts', 'src/runtime/advice/endpoint-guard.ts'];
const NETWORK_USE = /(?:require\(\s*|from\s+|import\(\s*)['"](?:node:)?(?:http|https|http2|net|tls|dgram|dns|undici)['"]|(?<![.\w])fetch\s*\(|\bundici\b/;

function checkNoNetwork(files) {
  const errors = [];
  for (const { rel, text } of files) {
    if (PINNED_NETWORK_FILES.includes(rel)) continue;
    text.split('\n').forEach((line, index) => {
      if (/^\s*(?:\/\/|\/\*|\*)/.test(line)) return;
      if (NETWORK_USE.test(line)) errors.push(`${rel}:${index + 1} uses a network module outside an export module`);
    });
  }
  return errors;
}

// --- G44.4: no model-facing step ----------------------------------------------------------------

const MODEL_FACING = /trace\s+(?:spans|export|analyze)\b|verify-baseline/;
const MODEL_FACING_ROOTS = ['core/shared/skills', 'core/shared/guidance', 'core/shared/agent-specs', 'core/shared/workflows'];

function checkNoModelStep(files) {
  const errors = [];
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, index) => {
      const hit = MODEL_FACING.exec(line);
      if (hit) errors.push(`${rel}:${index + 1} names '${hit[0]}' in a skill or guidance file`);
    });
  }
  return errors;
}

// --- G44.5: zero dependencies -------------------------------------------------------------------

function checkZeroDependencies(packageText, adviceGuardText) {
  const errors = [];
  const manifest = JSON.parse(packageText);
  for (const key of ['dependencies', 'optionalDependencies']) {
    if (manifest[key] && Object.keys(manifest[key]).length) errors.push(`package.json has ${key}`);
  }
  if (!/G30\.2: shipped package has no runtime dependencies/.test(adviceGuardText)) errors.push('test/guards/advice.test.js no longer enforces G30.2');
  return errors;
}

// --- G44.6: telemetry dirs are declared runs/ subdirectories the ledger readers skip -------------

const LEDGER_PARTITION = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function checkStoreIsolation(registry, storage) {
  const errors = [];
  const stores = new Map(storage.stores.map((store) => [store.id, store]));
  for (const [kind, spec] of Object.entries(registry.kinds)) {
    const store = stores.get(spec.store);
    if (!store) { errors.push(`kind ${kind} names store '${spec.store}', which core/registry/storage.json does not declare`); continue; }
    const segments = store.path.split('/');
    if (store.root !== 'project-state' || segments[0] !== 'runs' || segments.length < 2) errors.push(`store ${store.id} must be a subdirectory of project-state runs/, not '${store.root}:${store.path}'`);
    else if (LEDGER_PARTITION.test(segments[1])) errors.push(`store ${store.id} path ${store.path} would be listed as a ledger partition`);
    for (const writer of spec.writers) {
      if (!store.writers.includes(writer)) errors.push(`store ${store.id} does not list ${writer}, which ${REGISTRY_FILE} names as a writer of ${kind}`);
    }
  }
  for (const entry of registry.excludedStores) {
    if (stores.has(entry.store) && !entry.reason) errors.push(`excluded store ${entry.store} has no reason`);
  }
  return errors;
}

// --- file helpers -------------------------------------------------------------------------------

function filesUnder(relativeRoot, accept = () => true) {
  const root = path.join(REPO, relativeRoot);
  if (!fs.existsSync(root)) return [];
  const found = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        const rel = path.relative(REPO, full).split(path.sep).join('/');
        if (accept(rel)) found.push({ rel, text: fs.readFileSync(full, 'utf8') });
      }
    }
  }(root));
  return found;
}

const registry = JSON.parse(fs.readFileSync(path.join(REPO, REGISTRY_FILE), 'utf8'));
const storage = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/storage.json'), 'utf8'));

// --- Tests --------------------------------------------------------------------------------------

test('G44.1: telemetry.json is well formed, its owned vocabularies match their owners, and its keys equal what is written', () => {
  assert.deepEqual(checkRegistryShape(registry), []);
  const harnesses = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/harnesses.json'), 'utf8'));
  const verification = JSON.parse(fs.readFileSync(path.join(REPO, 'core/registry/verification.json'), 'utf8'));
  assert.deepEqual(checkVocabularyOwners(registry, {
    harness: { owner: 'core/registry/harnesses.json', values: harnesses.harnesses.map((entry) => entry.id) },
    status: { owner: 'core/registry/verification.json tierStatuses', values: verification.tierStatuses },
    risk: { owner: 'core/registry/verification.json riskLevels', values: Object.keys(verification.riskLevels) },
  }), []);
  assert.deepEqual(checkAllowlist(registry, shippedObservations(registry)), []);
});

test('G44.2: no node process is started on a shell hook path, and the node files are the pinned three', () => {
  const files = HOOK_ROOTS.flatMap((root) => filesUnder(root));
  assert.ok(files.length > 20, 'the hook roots were found');
  assert.deepEqual(checkNoNodeOnHooks(files), []);
});

test('G44.3: no network module or fetch under src/runtime outside the pinned advice client', () => {
  const files = filesUnder('src/runtime', (rel) => /\.(?:ts|js)$/.test(rel));
  assert.ok(files.length > 50);
  for (const pinned of PINNED_NETWORK_FILES) assert.ok(files.some(({ rel }) => rel === pinned), `${pinned} exists`);
  assert.deepEqual(checkNoNetwork(files), []);
});

test('G44.4: no skill, guidance or agent spec sends the model to a trace view or the baseline', () => {
  const files = MODEL_FACING_ROOTS.flatMap((root) => filesUnder(root, (rel) => /\.(?:md|json|yaml|yml|toml)$/.test(rel)));
  assert.ok(files.length > 20);
  assert.deepEqual(checkNoModelStep(files), []);
});

test('G44.5: the package has no runtime dependency and G30.2 is still enforced', () => {
  assert.deepEqual(checkZeroDependencies(
    fs.readFileSync(path.join(REPO, 'package.json'), 'utf8'),
    fs.readFileSync(path.join(REPO, 'test/guards/advice.test.js'), 'utf8'),
  ), []);
});

test('G44.6: telemetry stores are declared runs/ subdirectories, and the ledger readers do not see them', (t) => {
  assert.deepEqual(checkStoreIsolation(registry, storage), []);
  const dir = tempDir(t, 'doflow-g44-ledger-');
  fs.mkdirSync(path.join(dir, 'telemetry'));
  fs.writeFileSync(path.join(dir, 'telemetry', '2026-10-17.jsonl'), `${JSON.stringify({ timestamp: '2026-10-17T00:00:00.000Z', kind: 'hook', verb: 'trace' })}\n`);
  const read = new RunLedger({ dir }).read();
  assert.deepEqual([read.files, read.records.length, read.malformedLines], [[], 0, 0], 'RunLedger lists only partitions directly under runs/');
});

// --- Self-tests: every check fails on a planted violation ----------------------------------------

const clone = (value) => JSON.parse(JSON.stringify(value));
const withField = (key, field) => {
  const copy = clone(registry);
  copy.kinds['verify.run'].fields[key] = field;
  return copy;
};
const GOOD_FIELD = { name: 'doflow.verify.run.duration_ms', class: 'T1', type: 'uint|null', phase: 'P2' };

test('G44.1 self-test: a registry that is missing a key a fixture line carries fails, naming kind and key', () => {
  const declared = withField('duration_ms', GOOD_FIELD);
  const lines = [{ source: 'fixture:1', kind: 'verify.run', keys: ['timestamp', 'kind', 'run', 'lineage', 'attempt', 'duration_ms'] }];
  assert.deepEqual(checkAllowlist(declared, lines), []);
  const errors = checkAllowlist(registry, lines);
  assert.deepEqual(errors, ["fixture:1: kind verify.run writes 'duration_ms', which core/registry/telemetry.json does not declare"]);
  assert.match(checkAllowlist(registry, [{ source: 'f:1', kind: 'span', keys: [] }]).join('\n'), /kind 'span' is not in core\/registry\/telemetry\.json/);
});

test('G44.1 self-test: a declared key nothing writes fails, and a printf format is read for its keys', () => {
  const declared = withField('duration_ms', GOOD_FIELD);
  assert.match(checkAllowlist(declared, []).join('\n'), /kind verify\.run declares 'duration_ms', which no writer/);
  const format = "printf '{\"kind\":\"hook\",\"harness\":\"%s\",\"duration_ms\":%s,%s\\n' a b c >>\"$f\"\necho '{\"kind\":\"hook\",\"x\":1}'\n";
  assert.deepEqual(printfKeys(format), [{ kind: 'hook', keys: ['kind', 'harness', 'duration_ms'], line: 1 }]);
  const errors = checkAllowlist(registry, printfKeys(format).map((hit) => ({ source: 'bridge.sh:1', kind: hit.kind, keys: hit.keys })));
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.match(errors[0], /kind hook writes 'harness'/);
});

test('G44.1 self-test: the real writer drops a key the registry lacks and writes the one it declares', () => {
  const declared = withField('duration_ms', GOOD_FIELD);
  const keys = writerObservations(declared).find((line) => line.kind === 'verify.run').keys;
  assert.ok(keys.includes('duration_ms'));
  assert.ok(!keys.includes('stranger_key'), 'an unknown key never reaches the line');
  assert.deepEqual(checkAllowlist(declared, writerObservations(declared)).filter((message) => /verify\.run/.test(message)), []);
});

test('G44.1 self-test: a malformed registry fails on class, name, type, collision, T4, gen_ai and kind list', () => {
  assert.deepEqual(checkRegistryShape(withField('duration_ms', GOOD_FIELD)), []);
  const cases = [
    [{ ...GOOD_FIELD, class: 'T9' }, /class: names an unknown class/],
    [{ ...GOOD_FIELD, class: 'T4' }, /T4 content is never recorded/],
    [{ ...GOOD_FIELD, name: 'doflow.verify.run.other' }, /name: must be 'doflow\.verify\.run\.duration_ms'/],
    [{ ...GOOD_FIELD, type: 'string' }, /unknown type 'string'/],
    [{ ...GOOD_FIELD, type: 'enum:nope' }, /names no vocabulary 'nope'/],
    [{ ...GOOD_FIELD, type: 'runkey' }, /runkey is for recordFields only/],
    [{ ...GOOD_FIELD, phase: 'soon' }, /phase: must name the phase/],
  ];
  for (const [field, pattern] of cases) assert.match(checkRegistryShape(withField('duration_ms', field)).join('\n'), pattern);
  assert.match(checkRegistryShape(withField('kind', { ...GOOD_FIELD, name: 'doflow.verify.run.kind' })).join('\n'), /repeats a common key/);
  assert.match(checkRegistryShape(withField('Bad-Key', GOOD_FIELD)).join('\n'), /key must match/);
  const exported = clone(registry);
  exported.kinds.hook.fields.model = { name: 'gen_ai.request.model', class: 'T2', type: 'token', phase: 'P2' };
  assert.match(checkRegistryShape(exported).join('\n'), /gen_ai/);
  const extraKind = clone(registry);
  extraKind.kinds.span = { store: 'runs-telemetry', writers: ['x'], fields: {} };
  assert.match(checkRegistryShape(extraKind).join('\n'), /vocabularies\.kind: must list exactly the declared kinds/);
  const noClass = clone(registry);
  delete noClass.commonClasses.run;
  assert.match(checkRegistryShape(noClass).join('\n'), /commonClasses\.run/);
});

test('G44.1 self-test: a vocabulary that differs from its owning registry fails', () => {
  const changed = clone(registry);
  changed.vocabularies.status = changed.vocabularies.status.filter((value) => value !== 'NOT_RUN');
  const errors = checkVocabularyOwners(changed, { status: { owner: 'core/registry/verification.json tierStatuses', values: registry.vocabularies.status } });
  assert.equal(errors.length, 1);
  assert.match(errors[0], /vocabularies\.status differs from core\/registry\/verification\.json tierStatuses/);
});

test('G44.2 self-test: a hook file with node -e fails, a comment or a quoted word does not, a new node file fails', () => {
  const hook = (text) => checkNoNodeOnHooks([...PINNED_NODE_FILES.map((rel) => ({ rel, text: '' })), { rel: 'core/harnesses/shared/hooks/policies/x.sh', text }]);
  assert.deepEqual(hook('#!/bin/bash\n# node -e "x"\necho "install node first"\nlog=$(date)\n'), []);
  assert.deepEqual(hook('#!/bin/bash\nnode -e "process.exit(0)"\n'), ['core/harnesses/shared/hooks/policies/x.sh:2 starts a node process on a hook path']);
  for (const command of ['x=1 node a.js', 'cat f | node -e 1', 'true && npx tsx a.ts', 'out=$(node -p 1)', 'exec node a.js', 'env FOO=1 node a.js', 'if true; then bun run x; fi']) {
    assert.equal(hook(`#!/bin/bash\n${command}\n`).length, 1, command);
  }
  const door = (rel, line) => checkNoNodeOnHooks([...PINNED_NODE_FILES.map((file) => ({ rel: file, text: '' })), { rel, text: `#!/usr/bin/env bash\n${line}\n` }]);
  const runner = 'exec node "$(dirname "$0")/../../.doflow/shared/hooks/stream-hook-runner.js" PreToolUse';
  assert.deepEqual(door(PINNED_RUNNER_DOORS[0], runner), [], 'the pinned door may hand over to the shared runner');
  assert.equal(door('core/harnesses/codex/hooks/pre-bash-guard.sh', runner).length, 1, 'no other door may');
  assert.equal(door(PINNED_RUNNER_DOORS[0], 'exec node -e "1"').length, 1, 'and the pinned door may do nothing else');
  const extra = checkNoNodeOnHooks([...PINNED_NODE_FILES.map((rel) => ({ rel, text: '' })), { rel: 'core/harnesses/claude/hooks/new.js', text: '' }]);
  assert.deepEqual(extra, ['core/harnesses/claude/hooks/new.js is a node file on a hook path and is not in the pinned list']);
  assert.match(checkNoNodeOnHooks([]).join('\n'), /pinned node file .* is gone/);
});

test('G44.3 self-test: a network require, import or fetch fails; the pinned client and comments do not', () => {
  const run = (rel, text) => checkNoNetwork([{ rel, text }]);
  assert.deepEqual(run('src/runtime/trace/x.ts', "const net = require('node:net');\n"), ['src/runtime/trace/x.ts:1 uses a network module outside an export module']);
  assert.equal(run('src/runtime/x.ts', "import http from 'http';\n").length, 1);
  assert.equal(run('src/runtime/x.ts', 'const r = await fetch(url);\n').length, 1);
  assert.equal(run('src/runtime/x.ts', "const { request } = require('undici');\n").length, 1);
  assert.deepEqual(run('src/runtime/x.ts', "// require('node:http')\n * fetch(x)\nconst a = git.fetch(1) || prefetch(2);\n"), []);
  assert.deepEqual(run('src/runtime/advice/client.ts', "const http = require('node:http');\n"), []);
});

test('G44.4 self-test: a skill or guidance file naming a trace view or the baseline fails', () => {
  const run = (text) => checkNoModelStep([{ rel: 'core/shared/skills/do/SKILL.md', text }]);
  assert.deepEqual(run('Run `doflow-run trace spans --json` first.\n'), ["core/shared/skills/do/SKILL.md:1 names 'trace spans' in a skill or guidance file"]);
  assert.equal(run('ok\nthen trace export\n').length, 1);
  assert.equal(run('trace   analyze the ledger\n').length, 1);
  assert.equal(run('npm run bench -- verify-baseline\n').length, 1);
  assert.deepEqual(run('the trace verb reads the ledger; analysis is the user\'s\n'), []);
});

test('G44.5 self-test: a dependency, or a missing G30.2 guard, fails', () => {
  const guard = "test('G30.2: shipped package has no runtime dependencies', () => {});";
  assert.deepEqual(checkZeroDependencies('{"dependencies":{}}', guard), []);
  assert.deepEqual(checkZeroDependencies('{"dependencies":{"left-pad":"1"}}', guard), ['package.json has dependencies']);
  assert.deepEqual(checkZeroDependencies('{"optionalDependencies":{"x":"1"}}', guard), ['package.json has optionalDependencies']);
  assert.deepEqual(checkZeroDependencies('{}', 'nothing'), ['test/guards/advice.test.js no longer enforces G30.2']);
});

test('G44.6 self-test: an undeclared store, a non-runs path, a ledger-shaped path and an unlisted writer fail', () => {
  const without = { stores: storage.stores.filter((store) => store.id !== 'runs-telemetry') };
  assert.match(checkStoreIsolation(registry, without).join('\n'), /names store 'runs-telemetry', which core\/registry\/storage\.json does not declare/);
  const moved = (patch) => ({ stores: storage.stores.map((store) => (store.id === 'runs-telemetry' ? { ...store, ...patch } : store)) });
  assert.match(checkStoreIsolation(registry, moved({ path: 'telemetry' })).join('\n'), /must be a subdirectory of project-state runs\//);
  assert.match(checkStoreIsolation(registry, moved({ path: 'runs' })).join('\n'), /must be a subdirectory of project-state runs\//);
  assert.match(checkStoreIsolation(registry, moved({ root: 'user-state' })).join('\n'), /must be a subdirectory of project-state runs\//);
  assert.match(checkStoreIsolation(registry, moved({ path: 'runs/2026-10-17.jsonl' })).join('\n'), /would be listed as a ledger partition/);
  assert.match(checkStoreIsolation(registry, moved({ writers: [] })).join('\n'), /does not list src\/runtime\/trace\/telemetry\.ts/);
});
