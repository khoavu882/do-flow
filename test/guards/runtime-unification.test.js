'use strict';

// G12 — runtime unification (feature 008, design C14 / FR-005, FR-002, FR-003).
//
// The whole point of the dispatcher seam is that a verb has exactly ONE implementation and that
// the locator, the registry and the dispatcher agree on where that implementation lives. Nothing
// at runtime notices when they stop agreeing: the locator simply reports "no DoFlow runtime
// found" and every chain skill's first call dies. That is not hypothetical — B.1 and B.2 both
// followed design.md §4.1 faithfully and still did not join up, because the design named
// `<config>/bin/doflow-run` while the `scripts.doflow` asset actually installs the dispatcher at
// `<config>/scripts/doflow/bin/doflow-run`. Two correct agents, one broken seam. These guards
// compute the answer from the registry rather than trusting either side's prose.
//
// Scope note: the *behaviour* of the locator once projected (lands inside the harness's own
// directory, executable bit intact) is already asserted by test/gemini-adapter.test.js — 'the
// runtime locator is projected into every harness, inside that harness own directory' and 'the
// locator source is executable'. Those run the real adapter projection, which is the right place
// for them, so this file deliberately does NOT duplicate them. What it adds is the declaration
// side those tests take as given: that the registry claims all seven in a self-consistent way,
// and that the path the locator searches for is the path the registry projects to.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { loadRegistry } = require('../../src/registry');

const SCRIPTS = path.join(REPO, 'core', 'shared', 'scripts');
const DISPATCHER = path.join(SCRIPTS, 'doflow', 'bin', 'doflow-run');
const LOCATOR = path.join(REPO, 'core', 'harnesses', 'shared', 'locator', 'doflow-run');
const BASH_DIR = path.join(SCRIPTS, 'doflow', 'bash');

const registry = loadRegistry({ repoRoot: REPO });
const assetById = (id) => registry.assets.find((a) => a.id === id);
const dispatcherText = fs.readFileSync(DISPATCHER, 'utf8');
const locatorText = fs.readFileSync(LOCATOR, 'utf8');

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------- 1. single implementation

// FR-005/FR-006. The runtime path is pure bash + Node after B.5 deleted the Python shadow tree.
// The four do-code-review analyzers are skill-owned, fixtured separately by
// test/code-review-fixtures.sh, and explicitly exempt — but the exemption is a *location*, not a
// blanket one, so a Python file reappearing anywhere else in core/ fails here. That is how the
// shadow tree grew the first time: one module at a time, each individually defensible.
const PY_EXEMPT_DIR = path.join('core', 'shared', 'skills', 'do-code-review', 'scripts');

test('G12: the only Python in core/ is the exempt do-code-review analyzer set (FR-005, FR-006)', () => {
  const stray = walk(path.join(REPO, 'core'))
    .filter((file) => file.endsWith('.py'))
    .map((file) => path.relative(REPO, file))
    .filter((rel) => path.dirname(rel) !== PY_EXEMPT_DIR);
  assert.deepEqual(stray, [],
    'Python outside the skill-owned analyzers means a second runtime implementation is growing back.\n'
    + `Only ${PY_EXEMPT_DIR}/*.py is exempt (FR-006). Offenders:\n  ${stray.join('\n  ')}`);
});

test('G12: exactly one dispatcher and one locator exist, and the retired entrypoints stay retired', () => {
  const named = walk(path.join(REPO, 'core'))
    .map((file) => path.relative(REPO, file))
    .filter((rel) => path.basename(rel) === 'doflow-run');
  assert.deepEqual(named.sort(), [
    'core/harnesses/shared/locator/doflow-run',
    'core/shared/scripts/doflow/bin/doflow-run',
  ], 'a second dispatcher or a second locator means a verb can be served two ways');

  // `doflow.sh` was the dispatcher whose fixed-depth root arithmetic computed /Users in a global
  // install; `compiler.py`/`doctor.py` were the shadow product layer. Naming them explicitly means
  // a revert or a stray restore is caught rather than quietly re-shipped.
  const retired = walk(path.join(REPO, 'core'))
    .map((file) => path.basename(file))
    .filter((base) => ['doflow.sh', 'compiler.py', 'doctor.py'].includes(base));
  assert.deepEqual(retired, [], 'B.5 retired these; their return would restore the two-runtime split');
});

// ---------------------------------------------------------- 2. locator projection declaration

test('G12: the locator asset claims every harness, consistently, inside each harness own directory', () => {
  const locator = assetById('locator.doflow');
  assert.ok(locator, 'the locator.doflow asset is what puts a runtime entrypoint on all seven harnesses');

  const allHarnesses = registry.harnesses.map((h) => h.id).sort();
  assert.deepEqual([...locator.appliesTo].sort(), allHarnesses,
    'a harness missing from appliesTo receives chain skills that reference a runtime it never gets');
  assert.deepEqual(Object.keys(locator.projection).sort(), allHarnesses,
    'appliesTo without a projection entry is a claim the adapter cannot honour');
  assert.deepEqual(Object.keys(locator.nativeDir).sort(), allHarnesses,
    'appliesTo without a nativeDir entry is a claim with no destination');

  // `../.doflow/...` is the idiom for the harness-neutral shared tree. The locator is the one asset
  // that must NOT use it: a copy in the shared tree cannot be named by a literal relative path from
  // a harness's own skill file, which is the single reason the locator exists.
  for (const [harness, dir] of Object.entries(locator.nativeDir)) {
    assert.ok(!dir.startsWith('..'),
      `${harness} locator nativeDir "${dir}" escapes the harness directory into the shared tree`);
  }
});

// ------------------------------------------------------- 3. dispatcher / locator path agreement

// THE guard this task exists for. The locator hardcodes one config-relative path; the registry
// decides where the dispatcher actually lands. Derive the second and compare, so neither side can
// move without the other. Breaking this is silent at install time and total at run time.
test('G12: the path the locator searches for is where the registry projects the dispatcher', () => {
  const scripts = assetById('scripts.doflow');
  assert.ok(scripts, 'scripts.doflow is the asset that ships the dispatcher');

  const relInAsset = path.relative(path.join(REPO, scripts.source), DISPATCHER);
  assert.ok(!relInAsset.startsWith('..'),
    `the dispatcher at ${path.relative(REPO, DISPATCHER)} is not inside the scripts.doflow source tree`);

  const [, searched] = locatorText.match(/^REL='([^']+)'$/m) || [];
  assert.ok(searched, "the locator must declare its search path once, as REL='...'");

  for (const [harness, nativeDir] of Object.entries(scripts.nativeDir)) {
    // nativeDir is written relative to the harness directory and reaches back into the shared
    // config root, e.g. '../.doflow/scripts'. Everything after '.doflow/' is the config-relative
    // prefix the locator has to prepend.
    const match = nativeDir.match(/^\.\.\/\.doflow\/(.+)$/);
    assert.ok(match, `${harness}: scripts.doflow nativeDir "${nativeDir}" no longer targets the shared .doflow tree`);
    const expected = `${match[1]}/${relInAsset.split(path.sep).join('/')}`;
    assert.equal(searched, expected,
      `${harness}: the locator searches for '${searched}' but the registry installs the dispatcher at `
      + `<config>/${expected}. The locator would never find it and every skill's first runtime call `
      + 'would report "no DoFlow runtime found".');
  }

  // The three resolution steps must all be expressed through REL. A step that spells its own path
  // would drift away from the derivation above without failing the equality check.
  const uses = (locatorText.match(/\$REL/g) || []).length;
  assert.ok(uses >= 3,
    `all three resolution steps (design §4.1) must interpolate $REL; found ${uses} uses`);
});

// ------------------------------------------------------------------- 4. verb-table integrity

/** The dispatcher's own two case blocks are the verb table; parse them rather than restating it. */
function shellVerbs() {
  const block = dispatcherText.match(/shell_helper_for\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'shell_helper_for() is the shell arm of the verb table and must be parseable');
  return new Map([...block[1].matchAll(/^\s*([a-z][a-z-]*)\)\s*printf '([^']+)'/gm)]
    .map(([, verb, helper]) => [verb, helper]));
}

function nodeVerbs() {
  const block = dispatcherText.match(/is_node_verb\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(block, 'is_node_verb() is the node arm of the verb table and must be parseable');
  // The pattern list wraps with a trailing backslash; join it back into one alternation.
  const [, patterns] = block[1].replace(/\\\n/g, '').match(/^\s*([a-z|-]+)\)\s*return 0/m) || [];
  assert.ok(patterns, 'the node verb alternation must be parseable');
  return patterns.split('|');
}

test('G12: every shell-backed verb resolves to a helper that exists', () => {
  const missing = [...shellVerbs()]
    .filter(([, helper]) => !fs.existsSync(path.join(BASH_DIR, helper)))
    .map(([verb, helper]) => `${verb} -> bash/${helper}`);
  assert.deepEqual(missing, [],
    'a verb pointing at a helper that does not exist fails at exit 2 the first time a skill calls it:\n  '
    + missing.join('\n  '));
});

// Helpers with no verb. Being unexposed is a legitimate state — but only deliberately, so each one
// is listed with the reason it is not in the table.
//
// The test of whether a helper needs a verb is FR-003: the seam must cover every runtime call a
// skill can make. A helper only ever invoked by another helper is already behind the seam, because
// the skill reached it through the verb serving its caller. `do-parallel-check.sh` and
// `sync-context.sh` failed that test — both were named by skill prose — and gained verbs;
// `do-exec-paths.sh` passes it and stays internal.
const UNEXPOSED_HELPERS = new Map([
  ['do-exec-paths.sh',
    'no skill invokes it: do-task-brief.sh and do-review-package.sh shell out to it directly, so it '
    + 'is already behind the task-brief and review-package verbs. parallel_dispatch.md names it only '
    + 'to explain where a brief\'s paths come from — prose about a helper is not a runtime call, and '
    + 'a verb here would widen the public surface without removing an inlined resolver'],
]);

test('G12: every shell helper is either a verb target or a recorded non-verb helper', () => {
  const helpers = fs.readdirSync(BASH_DIR).filter((f) => f.endsWith('.sh'));
  const served = new Set(shellVerbs().values());
  const unaccounted = helpers.filter((h) => !served.has(h) && !UNEXPOSED_HELPERS.has(h));
  assert.deepEqual(unaccounted, [],
    'a new helper reachable by neither the verb table nor a recorded exemption is unreachable through '
    + 'the seam — add a verb, or add it to UNEXPOSED_HELPERS with the reason:\n  ' + unaccounted.join('\n  '));

  // Reverse direction: an exemption that outlived its helper, or a helper that gained a verb while
  // keeping its exemption, both mean the list has stopped describing reality.
  const stale = [...UNEXPOSED_HELPERS.keys()]
    .filter((h) => !helpers.includes(h) || served.has(h));
  assert.deepEqual(stale, [], 'stale UNEXPOSED_HELPERS entries must be deleted once the helper is gone or exposed');
});

test('G12: the dispatcher documents exactly the verbs it dispatches', () => {
  const help = dispatcherText.match(/usage\(\)\s*\{\s*cat <<'EOF'\n([\s\S]*?)\nEOF/);
  assert.ok(help, 'usage() must be parseable — it is the only verb list a user ever sees');
  const documented = new Set([...help[1].matchAll(/^ {2}([a-z][a-z-]*)\s{2,}\S/gm)].map(([, v]) => v));
  const dispatched = new Set([...shellVerbs().keys(), ...nodeVerbs()]);

  const undocumented = [...dispatched].filter((v) => !documented.has(v)).sort();
  const phantom = [...documented].filter((v) => !dispatched.has(v)).sort();
  assert.deepEqual(undocumented, [], `verbs that dispatch but --help never mentions: ${undocumented.join(', ')}`);
  assert.deepEqual(phantom, [],
    `verbs --help advertises that fall through to "unknown verb": ${phantom.join(', ')}`);
});

// ------------------------------------------------------ 5. the CLI has no surface off the seam

// FR-003 in the direction the verb table cannot check on its own. `is_node_verb()` deliberately
// lists verbs the CLI has not built yet, so "a verb with no command" is a legitimate state and is
// not an error. The reverse never is: a runtime command the CLI implements that the dispatcher
// does not dispatch is reachable *only* by going around the seam, which is precisely the state
// C.11 found `scaffold` in — a working generator whose only caller was an inline `node -e` that
// resolved the package from the CLI's own location. It worked, and it meant the entrypoint did
// not in fact cover every runtime call a skill can make.
//
// Both sides are parsed. The command list comes from the dispatch switch, so a command wired
// tomorrow is guarded the moment it is wired rather than when someone remembers this file.
test('G12: every runtime command the CLI implements is dispatched by a verb (FR-003)', () => {
  const cli = fs.readFileSync(path.join(REPO, 'bin', 'doflow.js'), 'utf8');
  const commands = [...cli.matchAll(/case '([a-z-]+)': return handle[A-Za-z]+Command/g)].map((m) => m[1]);
  assert.ok(commands.length > 0,
    "expected to parse runtime commands from bin/doflow.js's dispatch switch. A command written as a "
    + "block — case 'x': { ...; return; } — is invisible to this pattern and to G8's, so it would be "
    + 'silently unguarded rather than newly failing; keep the single-expression form');

  const dispatched = new Set([...shellVerbs().keys(), ...nodeVerbs()]);
  const offSeam = commands.filter((cmd) => !dispatched.has(cmd)).sort();
  assert.deepEqual(offSeam, [],
    'these runtime commands are reachable through `doflow <cmd>` but not through the dispatcher, so a '
    + 'skill can only call them by resolving the package itself — the bypass FR-003 exists to close. '
    + `Add each to the verb table:\n  ${offSeam.join('\n  ')}`);
});

// -------------------------------------------------- 5b. the wiring stays visible to the guards

// The trap C.3 fell into, recorded so it cannot be fallen into twice. Both this file and G8 learn
// what the CLI implements by matching `case 'x': return handleXCommand`. Written in the equally
// valid block form — `case 'x': { ...; return; }` — a command becomes invisible to both, so the
// guards do not go red, they go *quiet*: the command stops being checked at all and nobody is
// told. A guard that can be silently disabled by a refactor is not a guard.
//
// This does not require every advertised verb to have a command; an unbuilt verb is a legitimate
// state and belongs to C.7. It requires only that a verb which *is* wired is wired visibly.
test('G12: a wired runtime verb uses the case form the guards can parse', () => {
  const cli = fs.readFileSync(path.join(REPO, 'bin', 'doflow.js'), 'utf8');
  const nodeArm = new Set(nodeVerbs());
  const invisible = [];
  for (const [, verb, tail] of cli.matchAll(/case '([a-z-]+)':(.{0,60})/g)) {
    if (!nodeArm.has(verb)) continue;
    if (!/^ return handle[A-Za-z]+Command\b/.test(tail)) invisible.push(`${verb} ->${tail.trimEnd()}`);
  }
  assert.deepEqual(invisible.sort(), [],
    "a runtime verb wired in any form other than `case 'x': return handleXCommand(...)` disappears "
    + 'from this guard and from G8 without either of them failing:\n  ' + invisible.join('\n  '));
});

// ------------------------------------------------------------ 6. no skill goes around the seam

// FR-004's mechanical half for the *runtime library* case. C.4's guard covers inlined resolver
// blocks and interpolated `$DOFLOW_CONFIG_DIR` paths; this covers the other shape the same mistake
// takes — reaching a JavaScript module in `src/runtime/` directly, by inline evaluation or by
// `require`, instead of asking the dispatcher for the verb that serves it.
//
// Deliberately matches invocation, not mention: `references/scaffold.md` names
// `src/runtime/scaffold.js` several times to say which module produces Part 1, and prose about an
// implementation is not a call to it.
const SEAM_BYPASSES = [
  [/node\s+(?:--input-type=\S+\s+)?--?e(?:val)?\b/, 'inline `node -e`: evaluates DoFlow code outside the verb table'],
  [/require\([^)]*src[\\/]runtime/, 'direct `require()` of a runtime module: the seam decides which implementation serves a verb'],
  [/node\s+\S*src[\\/]runtime[\\/]\S+\.js/, 'running a runtime module as a script: skips dispatch, tracing and the uniform exit contract'],
];

test('G12: no skill reaches the JavaScript runtime except through the dispatcher (FR-004)', () => {
  const findings = [];
  (function walkSkills(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walkSkills(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const [pattern, why] of SEAM_BYPASSES) {
        if (pattern.test(text)) findings.push(`${path.relative(REPO, full)} — ${why}`);
      }
    }
  }(path.join(REPO, 'core', 'shared', 'skills')));

  assert.deepEqual(findings.sort(), [],
    'a skill that reaches the runtime by any route other than a verb is a second entrypoint with its '
    + 'own resolution rules, its own failure message and no run-ledger record:\n  ' + findings.join('\n  '));
});
