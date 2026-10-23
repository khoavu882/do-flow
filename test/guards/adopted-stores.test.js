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
// A helper call addresses a store through its own argument: `taskRecord`/`taskStoreDir` by a string-literal
// `store: '<path>'` property, `recordIn` by a `base:` that names the store, either as a literal
// `'.doflow', 'state', '<path>'` path or through `runStoreDir`/`RUN_STORE_REL` (the orchestration run
// store), followed one assignment deep when `base` is a variable or `this.<field>`. A call whose store
// cannot be resolved that way is reported, never skipped. `resolveTaskScope` takes no store argument, so a
// file that calls it addresses the `'.doflow', 'state', '<path>'` stores it names (it builds the record
// path itself). The checking functions are pure, so the controls run them on synthetic registries and
// sources.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { adoptedStores, ADOPTER } = require('../../src/runtime/state-root.ts');
const { RUN_STORE_REL } = require('../../src/runtime/implementation-gate.ts');

const HELPER_HOME = 'src/runtime/task-scope.ts';
const HELPER_CALL = /(?<!\bfunction\s+)\b(taskRecord|taskStoreDir|recordIn|resolveTaskScope)\s*\(/g;
const STORE_LITERAL = /^['"]([A-Za-z0-9][A-Za-z0-9._-]*)['"]$/;
const STATE_PATH = /['"]\.doflow['"]\s*,\s*['"]state['"]\s*,\s*['"]([A-Za-z0-9][A-Za-z0-9._-]*)['"]/;
const RUN_STORE_NAME = /\b(?:runStoreDir|RUN_STORE_REL)\b/;
const RUN_STORE = path.basename(RUN_STORE_REL);

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

/** The text between the bracket opened at `open` and its match, skipping strings; null when unbalanced. */
function balanced(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      for (index += 1; index < text.length && text[index] !== char; index += 1) if (text[index] === '\\') index += 1;
    } else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) { depth -= 1; if (depth === 0) return text.slice(open + 1, index); }
  }
  return null;
}

/** `text` split at its top-level commas (outside brackets and strings), trimmed, empties dropped. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let from = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "'" || char === '"' || char === '`') {
      for (index += 1; index < text.length && text[index] !== char; index += 1) if (text[index] === '\\') index += 1;
    } else if ('([{'.includes(char)) depth += 1;
    else if (')]}'.includes(char)) depth -= 1;
    else if (char === ',' && depth === 0) { parts.push(text.slice(from, index)); from = index + 1; }
  }
  parts.push(text.slice(from));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The top-level properties of a call's first argument when it is an object literal, else null. */
function firstObjectProperties(args) {
  const first = splitTopLevel(args)[0] || '';
  if (!first.startsWith('{') || !first.endsWith('}')) return null;
  const properties = new Map();
  for (const property of splitTopLevel(first.slice(1, -1))) {
    const keyed = /^['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*([\s\S]+)$/.exec(property);
    if (keyed) properties.set(keyed[1], keyed[2].trim());
    else if (/^[A-Za-z_$][\w$]*$/.test(property)) properties.set(property, property);
  }
  return properties;
}

/** The store a `base:` expression names: a literal state path, the run store, or what the variable
 * (or `this.<field>`) it names is assigned in the same file (up to three assignments deep). */
function storeOfBase(expression, code, depth = 0) {
  const literal = STATE_PATH.exec(expression);
  if (literal) return literal[1];
  if (RUN_STORE_NAME.test(expression)) return RUN_STORE;
  const named = /^(this\.)?([A-Za-z_$][\w$]*)$/.exec(expression);
  if (!named || depth >= 3) return null;
  const field = named[1] ? `this\\.${named[2].replace(/\$/g, '\\$')}\\s*=(?!=)` : `\\b(?:const|let|var)\\s+${named[2].replace(/\$/g, '\\$')}\\s*=(?!=)`;
  const stores = new Set();
  for (const assignment of code.matchAll(new RegExp(`${field}([^;]+);`, 'g'))) {
    const store = storeOfBase(assignment[1].trim(), code, depth + 1);
    if (store) stores.add(store);
  }
  return stores.size === 1 ? [...stores][0] : null;
}

/** The store one helper call addresses (`{ store }`), `{}` for a helper that names none, or `{ reason }`. */
function storeOfCall(helper, args, code) {
  if (helper === 'resolveTaskScope') return {};
  const properties = firstObjectProperties(args);
  if (!properties) return { reason: 'its first argument is not an object literal' };
  if (helper === 'recordIn') {
    if (!properties.has('base')) return { reason: 'it passes no `base:` property' };
    const store = storeOfBase(properties.get('base'), code);
    return store ? { store } : { reason: `its \`base\` (${properties.get('base')}) does not resolve to a '.doflow', 'state', '<store>' path or runStoreDir/RUN_STORE_REL` };
  }
  if (!properties.has('store')) return { reason: 'it passes no `store:` property' };
  const literal = STORE_LITERAL.exec(properties.get('store'));
  return literal ? { store: literal[1] } : { reason: `its \`store\` (${properties.get('store')}) is not a string literal` };
}

/** The files that call a namespaced-record helper, each with the stores its calls address and the
 * calls whose store cannot be resolved. */
function helperUsers(sources) {
  const users = new Map();
  for (const [file, text] of sources) {
    if (file === HELPER_HOME) continue;
    const code = stripComments(text);
    const stores = new Set();
    const unresolved = [];
    let found = false;
    let scoped = false;
    for (const call of code.matchAll(HELPER_CALL)) {
      found = true;
      scoped = scoped || call[1] === 'resolveTaskScope';
      const open = call.index + call[0].length - 1;
      const args = balanced(code, open);
      const result = args === null ? { reason: 'its argument list is not balanced' } : storeOfCall(call[1], args, code);
      if (result.store) stores.add(result.store);
      else if (result.reason) unresolved.push({ helper: call[1], line: code.slice(0, call.index).split('\n').length, reason: result.reason });
    }
    // `resolveTaskScope` takes no store argument: a file that only asks it for the namespace builds the
    // record path itself, so the state paths the file names are the stores it addresses.
    if (scoped) for (const named of code.matchAll(new RegExp(STATE_PATH, 'g'))) stores.add(named[1]);
    if (found) users.set(file, { stores: [...stores].sort(), unresolved });
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
  for (const [file, { stores, unresolved }] of helperUsers(sources)) {
    for (const call of unresolved) {
      errors.push(`${file}:${call.line} calls ${call.helper}(...) but the store it addresses cannot be resolved: ${call.reason}; pass a string-literal \`store:\` (taskRecord, taskStoreDir) or a \`base:\` built from a '.doflow', 'state', '<store>' path or runStoreDir/RUN_STORE_REL (recordIn)`);
    }
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
  assert.deepEqual([...users].flatMap(([file, user]) => user.unresolved.map((call) => `${file}:${call.line} ${call.helper}`)), [], 'every shipped helper call names its store');
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

// --- Controls: each helper call is tied to its own argument ------------------------------------

test('G63 control: a store literal outside any helper call is not attributed to the file', () => {
  const sources = fixtureSources({ 'src/x.ts': "taskRecord({ store: 'alpha' }); const unrelated = { store: 'gamma' };\n" });
  assert.deepEqual(checkAdopters([{ id: 'task-alpha', path: 'alpha' }], sources), []);
  assert.deepEqual([...helperUsers(sources).get('src/x.ts').stores], ['alpha']);
});

test('G63 control: a store literal in an object nested in a helper call is not the call\'s store', () => {
  const sources = fixtureSources({ 'src/x.ts': "taskRecord({ projectRoot, taskId: pick({ store: 'gamma' }), store: 'alpha' });\n" });
  assert.deepEqual([...helperUsers(sources).get('src/x.ts').stores], ['alpha']);
});

test('G63 control: a helper call whose store is a variable, or is missing, is reported with its file and line', () => {
  const adopted = adoptedStores(fixtureRegistry());
  const variable = checkAdopters(adopted, fixtureSources({ 'src/alpha.ts': alphaUser, 'src/beta.ts': betaUser, 'src/x.ts': "const extra = 'gamma';\ntaskRecord({ store: extra });\n" }));
  assert.equal(variable.length, 1, variable.join('\n'));
  assert.match(variable[0], /^src\/x\.ts:2 calls taskRecord\(\.\.\.\) but the store it addresses cannot be resolved: its `store` \(extra\) is not a string literal/);
  const missing = checkAdopters(adopted, fixtureSources({ 'src/alpha.ts': alphaUser, 'src/beta.ts': betaUser, 'src/y.ts': 'taskStoreDir({ projectRoot, taskId });\nrecordIn(options);\n' }));
  assert.equal(missing.length, 2, missing.join('\n'));
  assert.match(missing[0], /^src\/y\.ts:1 calls taskStoreDir.*it passes no `store:` property/);
  assert.match(missing[1], /^src\/y\.ts:2 calls recordIn.*its first argument is not an object literal/);
});

test('G63 control: a recordIn base resolves through runStoreDir, RUN_STORE_REL, a literal path, a variable or a this field; a resolveTaskScope file addresses the state paths it names', () => {
  const store = (text) => helperUsers(fixtureSources({ 'src/x.ts': text })).get('src/x.ts');
  const orchestration = RUN_STORE_REL.split(/[\\/]/).pop();
  assert.equal(orchestration, 'orchestration');
  assert.deepEqual(store('recordIn({ base: runStoreDir(root), namespace, name });').stores, [orchestration]);
  assert.deepEqual(store("recordIn({ base: path.join(root, RUN_STORE_REL), namespace, name });").stores, [orchestration]);
  assert.deepEqual(store("recordIn({ base: path.join(root, '.doflow', 'state', 'beta'), namespace, name });").stores, ['beta']);
  assert.deepEqual(store('class O { constructor() { this.stateDir = stateDir || runStoreDir(this.projectRoot); }\n  run() { return recordIn({ base: this.stateDir, namespace, name }); } }').stores, [orchestration]);
  assert.deepEqual(store("const base = path.join(root, '.doflow', 'state', 'beta');\nrecordIn({ base, namespace, name });").stores, ['beta']);
  const scope = store('resolveTaskScope({ projectRoot, taskId });');
  assert.deepEqual([scope.stores, scope.unresolved], [[], []]);
  const built = store("const STORE = path.join('.doflow', 'state', 'readiness');\nconst { namespace } = resolveTaskScope({ projectRoot, taskId });\n");
  assert.deepEqual([built.stores, built.unresolved], [['readiness'], []]);
  const unknown = store('recordIn({ base: somewhere, namespace, name });');
  assert.equal(unknown.unresolved.length, 1);
  assert.match(unknown.unresolved[0].reason, /does not resolve/);
});

test('G63 control: the orchestrator is recognised as an orchestration user from its own run-store call, and the shipped tree stays consistent without research-request.ts naming it', () => {
  const sources = shippedSources();
  const without = new Map(sources);
  const request = sources.get('src/runtime/research-request.ts');
  assert.ok(request.includes("store: 'orchestration'"), 'research-request.ts names the orchestration store (the line this control takes away)');
  without.set('src/runtime/research-request.ts', request.replace("store: 'orchestration'", "store: 'research'"));
  assert.deepEqual(checkAdopters(adoptedStores(registry), without), []);
  const orchestrator = helperUsers(new Map([['src/runtime/workflow-orchestrator.ts', sources.get('src/runtime/workflow-orchestrator.ts')]])).get('src/runtime/workflow-orchestrator.ts');
  assert.deepEqual([orchestrator.stores, orchestrator.unresolved], [['orchestration'], []]);
});
