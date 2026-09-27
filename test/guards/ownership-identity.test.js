'use strict';

/**
 * G20 — the two properties of the recorded ownership identity that the cross-scope join rests on
 * (feature 041, task D.3; IC-004).
 *
 * `doflow inventory` decides that two recorded resources are two copies of the same logical asset
 * when `(harness, ownershipIdentity)` agrees. `src/lifecycle/index.js:40` already refuses a change
 * carrying no ownership identity, so the field is mandatory. Two further properties are load-
 * bearing and neither was enforced anywhere before this guard:
 *
 *   - **Scope-freedom.** No adapter may compose an ownership identity from a scope name or a
 *     destination path. If one did, the global and the project copy of one asset would carry
 *     different identities and would simply stop joining — no error, no finding, two singleton
 *     entries where there should be one shadowed pair. Antigravity is the case that proves the
 *     property is real rather than incidental: `treeDestFor` sends `agents.shared` to
 *     `.agents/agents/` at project scope and `.gemini/config/agents/` at global scope, and the
 *     identity is identical across both.
 *   - **Uniqueness.** Two code paths inside one adapter may not emit the same
 *     `(harness, ownershipIdentity)` for different resources. Codex is the live candidate:
 *     `ownershipIdentity(componentName, identity)` maps a component name through a kind table
 *     while `lifecycleResource` builds the same shape from a raw `kind`. A collision would collapse
 *     two distinct resources into one logical asset carrying two copies at the *same* scope, which
 *     the report's one-record-per-scope shape cannot represent.
 *
 * Both are checked behaviourally first and statically second, because neither method alone is
 * enough. The behavioural tests plan every harness against real roots and compare what the
 * adapters actually emit — no indirection can hide from that — but a plan against an empty root
 * exercises only the create path, leaving the verify and remove sites unvisited. The static scan
 * covers every composition site in `src/adapters/`, at the cost of being text. Where they overlap
 * they agree; where they do not, each covers the other's gap.
 *
 * Planning is read-only: `registryLifecycleView` computes a plan and writes nothing. The roots are
 * `mkdtemp` directories, never `$HOME` and never the repository.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { REPO } = require('./_shared');
const { loadRegistry } = require('../../src/registry');
const { registryLifecycleView, LIFECYCLE_HARNESSES } = require('../../src/lifecycle/view');

const ADAPTERS = path.join(REPO, 'src', 'adapters');
const registry = loadRegistry({ repoRoot: REPO });

// ------------------------------------------------------------------ behavioural: what adapters do

function scratch(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

/** The view derives a global scopeRoot from os.homedir() rather than from its scope descriptor
 * (design R7), so a hermetic global-scope plan relocates the home directory for the duration of
 * the synchronous call. Same idiom as test/lifecycle/dual-scope-read.test.js. */
function withHomeDir(dir, fn) {
  const original = os.homedir;
  os.homedir = () => dir;
  try { return fn(); } finally { os.homedir = original; }
}

/** Every change every adapter would make in one scope, across all eight harnesses. */
function planChanges(scope) {
  return registryLifecycleView({
    registry, repoRoot: REPO, targets: LIFECYCLE_HARNESSES, mcpIds: [], scope,
  }).plan.changes;
}

function pair(change) { return `${change.harness}|${change.ownershipIdentity}`; }

test('G20: no adapter composes an ownership identity from a destination path (IC-004)', () => {
  // Two roots of deliberately different length and spelling: a path-derived identity differs
  // between them under any composition, prefix or suffix.
  const first = scratch('doflow-identity-a-');
  const second = scratch('doflow-identity-second-much-longer-');
  const home = scratch('doflow-identity-home-');

  const fromFirst = withHomeDir(home, () => planChanges({ global: false, projectRoot: first }));
  const fromSecond = withHomeDir(home, () => planChanges({ global: false, projectRoot: second }));

  assert.ok(fromFirst.length > 0, 'planning an empty project root must produce changes to compare');
  assert.ok(fromFirst.some((change) => change.target?.startsWith(first))
    && fromSecond.some((change) => change.target?.startsWith(second)),
  'the two plans must actually target their own roots, or this test proves nothing');

  const a = fromFirst.map(pair).sort();
  const b = fromSecond.map(pair).sort();
  const onlyFirst = a.filter((key) => !b.includes(key));
  const onlySecond = b.filter((key) => !a.includes(key));
  assert.deepEqual([...onlyFirst, ...onlySecond], [],
    'planning the same install at two different project roots produced different ownership '
    + 'identities, so some adapter composes one from a destination path. IC-004 joins a global and '
    + 'a project copy of one asset on `(harness, ownershipIdentity)`, so a path-derived identity '
    + 'silently stops the two copies joining and `doflow inventory` reports a shadowed asset as two '
    + `unrelated singletons:\n  ${[...onlyFirst, ...onlySecond].join('\n  ')}`);
});

test('G20: no adapter composes an ownership identity from a scope name (IC-004)', () => {
  const home = scratch('doflow-identity-scope-home-');
  const project = scratch('doflow-identity-scope-project-');

  const globalChanges = withHomeDir(home, () => planChanges({ global: true }));
  const projectChanges = withHomeDir(home, () => planChanges({ global: false, projectRoot: project }));

  // Containment, not equality: some assets are project-scope only (antigravity's workspace rules
  // and workflows have no user-scope home, Copilot's repository instructions likewise), so the
  // global plan is legitimately a subset. What may never happen is an identity present at global
  // scope that the project plan spells differently.
  const projectPairs = new Set(projectChanges.map(pair));
  const renamed = [...new Set(globalChanges.map(pair))].filter((key) => !projectPairs.has(key)).sort();
  assert.deepEqual(renamed, [],
    'these ownership identities exist at global scope but at no other, while the resource itself '
    + 'exists at both — the signature of an identity composed from the scope name or from a '
    + `per-scope destination root:\n  ${renamed.join('\n  ')}`);

  // The sentinel: the one asset whose destination ROOT differs by scope
  // (src/adapters/antigravity/index.js#treeDestFor). If scope-freedom is ever broken, it breaks
  // here first, so the case is named rather than left to the aggregate above.
  const sentinel = (changes) => changes
    .filter((change) => change.harness === 'antigravity' && change.assetId === 'agents.shared');
  const globalSentinel = sentinel(globalChanges);
  const projectSentinel = sentinel(projectChanges);
  assert.ok(globalSentinel.length > 0 && projectSentinel.length > 0,
    "antigravity's agents.shared must be planned at both scopes for this sentinel to mean anything; "
    + 'if the asset moved, pick another whose destination root varies by scope');
  assert.deepEqual(
    projectSentinel.map((change) => change.ownershipIdentity).sort(),
    globalSentinel.map((change) => change.ownershipIdentity).sort(),
    "antigravity projects agents.shared under .agents/agents at project scope and under "
    + '.gemini/config/agents at global scope; its ownership identities must be identical across '
    + 'the two regardless, because IC-004 is what joins them');
  assert.notEqual(
    path.dirname(globalSentinel[0].target), path.dirname(projectSentinel[0].target),
    'the sentinel stopped varying its destination root by scope, so it no longer tests anything — '
    + 'find the asset that does and point this assertion at it'
  );
});

test('G20: no two resources share a (harness, ownership identity) pair (IC-004)', () => {
  const home = scratch('doflow-identity-unique-home-');
  const project = scratch('doflow-identity-unique-project-');

  for (const [label, changes] of [
    ['global', withHomeDir(home, () => planChanges({ global: true }))],
    ['project', withHomeDir(home, () => planChanges({ global: false, projectRoot: project }))],
  ]) {
    const seen = new Map();
    const collisions = [];
    for (const change of changes) {
      const key = pair(change);
      if (seen.has(key)) collisions.push(`${label}: ${key} — ${seen.get(key)} and ${change.target}`);
      else seen.set(key, change.target);
    }
    assert.deepEqual(collisions, [],
      'two changes in one plan carry the same (harness, ownership identity), so two distinct '
      + 'resources are one logical asset as far as IC-004 is concerned. `doflow inventory` would '
      + 'then show one entry holding two copies at the SAME scope, a shape its per-scope record '
      + `cannot represent:\n  ${collisions.join('\n  ')}`);
    assert.ok(seen.size > 0, `the ${label} plan produced no changes, so uniqueness was never tested`);
  }
});

// -------------------------------------------------------------- static: every composition site

/** Read one value expression starting at `start`, stopping at the top-level `,`, `;` or newline
 * that ends it. Tracks quotes, template literals and their `${}` interpolations, so a comma inside
 * a call's argument list or inside a string does not end the expression early. */
function readExpression(text, start) {
  const stack = [];
  let i = start;
  for (; i < text.length; i += 1) {
    const ch = text[i];
    const top = stack[stack.length - 1];
    if (top === "'" || top === '"') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === top) stack.pop();
      continue;
    }
    if (top === '`') {
      if (ch === '\\') { i += 1; continue; }
      if (ch === '`') { stack.pop(); continue; }
      if (ch === '$' && text[i + 1] === '{') { stack.push('{'); i += 1; }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '(' || ch === '[' || ch === '{') { stack.push(ch); continue; }
    if (ch === ')' || ch === ']' || ch === '}') {
      if (stack.length === 0) break;  // the enclosing object literal closed: the expression ended
      stack.pop();
      continue;
    }
    if (stack.length === 0 && (ch === ',' || ch === ';' || ch === '\n')) break;
  }
  return text.slice(start, i).trim();
}

function adapterFiles(dir = ADAPTERS, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) adapterFiles(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

/** Every place an adapter composes an ownership identity: the property assignments, and the one
 * named helper (codex) that several of them call. */
function compositionSites() {
  const sites = [];
  for (const file of adapterFiles()) {
    const text = fs.readFileSync(file, 'utf8');
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    for (const match of text.matchAll(/ownershipIdentity:\s*/g)) {
      sites.push({ rel, expr: readExpression(text, match.index + match[0].length) });
    }
    for (const match of text.matchAll(/function ownershipIdentity\([^)]*\)\s*\{\s*return\s*/g)) {
      sites.push({ rel, expr: readExpression(text, match.index + match[0].length) });
    }
  }
  return sites;
}

/**
 * Every interpolation an adapter is permitted to put inside an ownership identity, with the reason
 * it carries no scope. Fail-closed: an interpolation that is not here fails the guard rather than
 * being waved through, because the whole point is that a new one gets read before IC-004's join
 * starts depending on it.
 */
const SCOPE_FREE_INTERPOLATIONS = new Map([
  ['HARNESS', 'the adapter\'s own constant harness id'],
  ['HOOKS_ASSET_ID', 'a constant registry asset id'],
  ['asset.id', 'a registry asset id, the same string in every scope'],
  ['assetId', 'a registry asset id, the same string in every scope'],
  ['change.relPath', 'a path relative to the asset\'s own destination root, derived from the source tree — the part of a destination that does NOT vary by scope'],
  ['resource.relPath', 'the same source-relative path, read back from the ledger'],
  ['identity', 'the resource-local discriminator: a file basename, a config key, an agent name'],
  ['id', 'an MCP server id'],
  ['server.id', 'an MCP server id'],
  ['fileName', 'a settings file basename'],
  ['kind', 'a literal resource-kind word (copy-tree-file, mcp-server, ...)'],
  ['ownershipKind(componentName)', "codex's fixed component-name -> kind table (src/adapters/codex/index.js), a closed set of literals"],
]);

/** Identifiers that name a scope or a destination. None may appear anywhere in a composition. */
const SCOPE_BEARING = /\b(scope|scopeRoot|projectRoot|homeDir|homedir|configDir|destDir|destAbs|target|paths|root|cwd)\b/i;

/** A literal segment that names a scope. Segments are split on the `:` and `/` that adapters
 * actually delimit these strings with. */
const SCOPE_NAMES = new Set(['global', 'project', 'user', 'workspace', 'home']);

test('G20: every adapter composition site builds an ownership identity from scope-free parts', () => {
  const sites = compositionSites();

  // A refactor that reshapes these sites must not silently empty the scan.
  assert.ok(sites.length >= 70,
    `only ${sites.length} ownership-identity composition sites were parsed in src/adapters/; the `
    + 'scan has stopped seeing most of them and is no longer guarding anything');
  const contributing = new Set(sites.map((site) => site.rel.split('/')[2]).filter((name) => name.endsWith('.js') === false));
  const adapterDirs = fs.readdirSync(ADAPTERS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual([...contributing].sort(), adapterDirs,
    'every harness adapter composes ownership identities; one contributing none to this scan means '
    + 'its sites are written in a shape the scan does not see');

  const unknown = [];
  const scopeBearing = [];
  for (const { rel, expr } of sites) {
    assert.ok(expr !== '', `failed to read the ownership-identity expression at ${rel}`);
    assert.ok(!/\$\{[^}]*\{/.test(expr),
      `${rel} nests braces inside a template interpolation, a shape this scan cannot read: ${expr}`);

    for (const [, interpolation] of expr.matchAll(/\$\{([^{}]*)\}/g)) {
      if (!SCOPE_FREE_INTERPOLATIONS.has(interpolation.trim())) unknown.push(`${rel}: \${${interpolation}} in ${expr}`);
    }
    if (SCOPE_BEARING.test(expr.replace(/\bownershipIdentity\b/g, ''))) scopeBearing.push(`${rel}: ${expr}`);
    for (const segment of expr.replace(/\$\{[^{}]*\}/g, '').split(/[`'":/\s]+/)) {
      if (SCOPE_NAMES.has(segment)) scopeBearing.push(`${rel}: literal '${segment}' in ${expr}`);
    }
  }

  assert.deepEqual(unknown.sort(), [],
    'these ownership identities interpolate something this guard has not been told is scope-free. '
    + 'IC-004 joins a global and a project copy on the identity alone, so a value that differs '
    + 'between scopes silently stops them joining. Add the interpolation to '
    + `SCOPE_FREE_INTERPOLATIONS with the reason it is the same at both scopes, or stop using it:\n  ${unknown.join('\n  ')}`);

  assert.deepEqual(scopeBearing.sort(), [],
    'these ownership identities name a scope or a destination. IC-004 requires the identity to be '
    + 'exactly the part of the ownership key that does NOT vary between a global and a project '
    + `install:\n  ${scopeBearing.join('\n  ')}`);
});
