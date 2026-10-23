'use strict';

// G63 — the stores a linked worktree's records are adopted from are the stores that use the
// namespaced task-record helpers (FU-tbd9by).
//
// `src/runtime/state-root.ts` takes its list of adopted stores from `core/registry/storage.json`: the
// project-state stores that name that module among their `writers`. Nothing tied that declaration to
// the code that writes per-task records, so a store given `taskRecord`/`recordIn` without the
// declaration was never swept into the main checkout (its records stayed in the worktree), and a
// declaration kept after its last user went stale. This guard reads both sides:
//   (a) every project-state store that a source file addresses through `taskRecord`, `taskStoreDir`,
//       `recordIn` or `resolveTaskScope` is declared among the adopted stores;
//   (b) every adopted store is addressed by at least one such source file.
// A source file "addresses" a store by a `store: '<path>'` property or a literal
// `'.doflow', 'state', '<path>'` path in the same file as a helper call. The checking functions are
// pure, so the controls run them on synthetic registries and sources.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { adoptedStores, ADOPTER } = require('../../src/runtime/state-root.ts');

const HELPER_HOME = 'src/runtime/task-scope.ts';
const HELPER_CALL = /\b(?:taskRecord|taskStoreDir|recordIn|resolveTaskScope)\s*\(/;
const STORE_PROPERTY = /\bstore:\s*['"]([A-Za-z0-9][A-Za-z0-9._-]*)['"]/g;
const STATE_PATH = /['"]\.doflow['"]\s*,\s*['"]state['"]\s*,\s*['"]([A-Za-z0-9][A-Za-z0-9._-]*)['"]/g;

/** The source without block comments and whole-line or trailing `//` comments (a `//` inside a URL
 * string is kept: it is only a comment after whitespace or at the start of a line). */
function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' ')).replace(/(^|\s)\/\/.*$/gm, '$1');
}

function walkSource(relativeDir) {
  const found = [];
  for (const entry of fs.readdirSync(path.join(REPO, relativeDir), { withFileTypes: true })) {
    const relative = `${relativeDir}/${entry.name}`;
    if (entry.isDirectory()) found.push(...walkSource(relative));
    else if (entry.isFile() && /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name)) found.push(relative);
  }
  return found;
}

/** The files that call a namespaced-record helper, each with the store paths the file names. */
function helperUsers(sources) {
  const users = new Map();
  for (const [file, text] of sources) {
    if (file === HELPER_HOME) continue;
    const code = stripComments(text);
    if (!HELPER_CALL.test(code)) continue;
    const stores = new Set([...code.matchAll(STORE_PROPERTY), ...code.matchAll(STATE_PATH)].map((match) => match[1]));
    users.set(file, [...stores].sort());
  }
  return users;
}

/**
 * @param {Array<{id: string, path: string}>} adopted the adopted stores
 * @param {Map<string, string>} sources source file -> text
 * @returns {string[]} one message per disagreement
 */
function checkAdopters(adopted, sources) {
  const errors = [];
  const adoptedPaths = new Set(adopted.map((store) => store.path));
  const named = new Set();
  for (const [file, stores] of helperUsers(sources)) {
    for (const store of stores) {
      named.add(store);
      if (!adoptedPaths.has(store)) {
        errors.push(`${file} addresses store '${store}' through a task-record helper, but no project-state store with that path lists ${ADOPTER} in its writers in core/registry/storage.json`);
      }
    }
  }
  for (const store of adopted) {
    if (!named.has(store.path)) {
      errors.push(`store ${store.id} (${store.path}) lists ${ADOPTER} in its writers, but no source file addresses '${store.path}' through taskRecord, taskStoreDir, recordIn or resolveTaskScope`);
    }
  }
  return errors;
}

const shippedSources = () => new Map(walkSource('src').map((file) => [file, fs.readFileSync(path.join(REPO, file), 'utf8')]));
const registry = loadStorageRegistry({ repoRoot: REPO });

test('G63: the adopted stores and the task-record helper users name the same stores', () => {
  const adopted = adoptedStores(registry);
  assert.ok(adopted.length >= 7, 'the adopted stores were found');
  const users = helperUsers(shippedSources());
  assert.ok(users.size >= 8, `the helper users were found (${users.size})`);
  assert.deepEqual(checkAdopters(adopted, shippedSources()), []);
});

// --- Controls: the check fails on a synthetic disagreement -------------------------------------

const fixtureRegistry = (extra = []) => ({
  stores: [
    { id: 'task-alpha', root: 'project-state', path: 'alpha', writers: ['src/a.ts', ADOPTER] },
    { id: 'task-beta', root: 'project-state', path: 'beta', writers: [ADOPTER] },
    { id: 'plain-gamma', root: 'project-state', path: 'gamma', writers: ['src/g.ts'] },
    { id: 'user-delta', root: 'user-config', path: 'delta', writers: [ADOPTER] },
    ...extra,
  ],
});
const fixtureSources = (files) => new Map(Object.entries(files));
const alphaUser = "const { taskRecord } = require('./task-scope.ts');\ntaskRecord({ projectRoot, store: 'alpha', taskId });\n";
const betaUser = "const { recordIn } = require('./task-scope.ts');\nconst base = path.join(root, '.doflow', 'state', 'beta');\nrecordIn({ base, namespace, name });\n";

test('G63 control: adoption read from a synthetic registry covers only project-state stores that name the adopter', () => {
  assert.deepEqual(adoptedStores(fixtureRegistry()).map((store) => store.id).sort(), ['task-alpha', 'task-beta']);
});

test('G63 control: a consistent synthetic registry and source set reports nothing', () => {
  assert.deepEqual(checkAdopters(adoptedStores(fixtureRegistry()), fixtureSources({
    'src/alpha.ts': alphaUser, 'src/beta.ts': betaUser, 'src/unrelated.ts': "fs.writeFileSync(path.join(root, '.doflow', 'state', 'gamma', 'x.json'), '');\n",
  })), []);
});

test('G63 control: a store used through a helper but not adopted is named with its file', () => {
  const errors = checkAdopters(adoptedStores(fixtureRegistry()), fixtureSources({
    'src/alpha.ts': alphaUser, 'src/beta.ts': betaUser,
    'src/gamma.ts': "taskRecord({ projectRoot, store: 'gamma', taskId });\n",
  }));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^src\/gamma\.ts addresses store 'gamma' through a task-record helper/);
});

test('G63 control: an adopted store with no helper user is named by its id', () => {
  const errors = checkAdopters(adoptedStores(fixtureRegistry()), fixtureSources({ 'src/alpha.ts': alphaUser }));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /^store task-beta \(beta\) lists src\/runtime\/state-root\.ts in its writers, but no source file addresses 'beta'/);
});

test('G63 control: a store named in a comment, in the helper module or beside no helper call does not count as a user', () => {
  const errors = checkAdopters(adoptedStores(fixtureRegistry()), fixtureSources({
    'src/alpha.ts': alphaUser,
    'src/comment.ts': "// recordIn({ store: 'beta' })\n/* taskRecord({ store: 'beta' }) */\nconst x = 1; // taskRecord({ store: 'beta' })\n",
    [HELPER_HOME]: "function taskRecord() { return path.join('.doflow', 'state', 'beta'); }\n",
    'src/nohelper.ts': "const dir = path.join(root, '.doflow', 'state', 'beta');\n",
  }));
  assert.equal(errors.length, 1, errors.join('\n'));
  assert.match(errors[0], /store task-beta/);
});

test('G63 control: removing the adopter from a real store, or adding it to one with no user, fails against the shipped sources', () => {
  const sources = shippedSources();
  const without = structuredClone(registry);
  const evidence = without.stores.find((store) => store.id === 'task-evidence');
  evidence.writers = evidence.writers.filter((writer) => writer !== ADOPTER);
  const missing = checkAdopters(adoptedStores(without), sources);
  assert.ok(missing.some((message) => message.includes("addresses store 'evidence'") && message.startsWith('src/runtime/claims.ts')), missing.join('\n'));
  const extra = structuredClone(registry);
  extra.stores.find((store) => store.id === 'task-attempts').writers.push(ADOPTER);
  const stale = checkAdopters(adoptedStores(extra), sources);
  assert.deepEqual(stale.map((message) => message.split(' ').slice(0, 3).join(' ')), ['store task-attempts (task-attempts)']);
});
