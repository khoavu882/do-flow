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
// directory, executable bit intact) is already asserted by test/adapters/gemini/gemini-adapter.test.js — 'the
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
    + 'is already behind the task-brief and review-package verbs. Nothing in the skill tree names it '
    + 'at all any more — parallel_dispatch.md used to mention it while explaining where a brief\'s '
    + 'paths come from, and no longer does — so a verb here would widen the public surface without '
    + 'removing a single inlined resolver'],
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

// FR-003 in the direction the verb table cannot check on its own — one of the two halves. This is
// the "no command off the seam" half; the "no verb without a command" half is section 5c, added by
// C.7 once the CLI had caught up with the advertised namespace. A runtime command the CLI implements
// that the dispatcher
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
// This test asks only that a verb which *is* wired is wired visibly. Whether every advertised verb
// is wired at all is section 5c's question.
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

// --------------------------------------------- 5c. the seam has no verb without an implementation

// The other half of section 5, and the half whose absence let eight verbs ship advertised and
// unbuilt. The shell arm has been checked in both directions since B.6 — 'every shell-backed verb
// resolves to a helper that exists' is exactly this question asked of `shell_helper_for()`. The Node
// arm never was, because `is_node_verb()` was written as a namespace declaration rather than a
// routing table, and its own comment licensed the gap ("an unbuilt verb is dispatched and the CLI
// answers for itself"). That is the asymmetry: a missing helper fails loudly at exit 2 naming the
// file it wanted, while a missing command falls through to the CLI's unknown-command handler, which
// talks about `doflow` and not about the verb the skill actually called — and the dispatcher writes
// a run-ledger entry either way, so `stats` counts the verb as having run.
//
// Both arms are now checked in both directions. An advertised verb is a promise to every skill that
// reads the verb table, and this is the guard that makes the promise mean something.
test('G12: every verb the dispatcher advertises on the Node arm has a CLI command (FR-003)', () => {
  const cli = fs.readFileSync(path.join(REPO, 'bin', 'doflow.js'), 'utf8');
  const commands = new Set([...cli.matchAll(/case '([a-z-]+)': return handle[A-Za-z]+Command/g)].map((m) => m[1]));
  const unimplemented = nodeVerbs().filter((verb) => !commands.has(verb)).sort();
  assert.deepEqual(unimplemented, [],
    'these verbs are advertised by is_node_verb() and by --help, dispatched by the entrypoint, and '
    + 'recorded in the run ledger as having run — but the CLI implements no command for them, so a '
    + "skill calling one gets the CLI's generic unknown-command message instead of an answer. "
    + `Implement the command, or remove the verb from the table:\n  ${unimplemented.join('\n  ')}`);
});

// ------------------------------------------------------------ 6. no skill goes around the seam

// FR-004's mechanical half for the *runtime library* case. C.4's guard covers inlined resolver
// blocks and interpolated `$DOFLOW_CONFIG_DIR` paths; this covers the other shape the same mistake
// takes — reaching a JavaScript module in `src/runtime/` directly, by inline evaluation or by
// `require`, instead of asking the dispatcher for the verb that serves it.
//
// Deliberately matches invocation, not mention: `references/scaffold.md` names
// `src/runtime/scaffold/generate.js` several times to say which module produces Part 1, and prose about an
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

// ---------------------------------------------------------- 7. the run ledger stays metadata-only

// NFR-004. The ledger is the one thing this feature writes to disk on every single runtime call, so
// it is also the one place a leak would be both continuous and invisible: nobody reads
// `state/runs/2026-08-18.jsonl` until something else goes wrong. `sanitizeRunEvent` is the whole
// defence — a closed field list plus a token pattern that cannot express a path, a URL, a quote or
// a space. A writer that goes around it does not fail; it just writes.
const TRACE_FILE = path.join(REPO, 'src', 'runtime', 'trace', 'ledger.js');
const traceText = fs.readFileSync(TRACE_FILE, 'utf8');
const trace = require('../../src/runtime/trace/ledger');

/** Every .js under src/ and bin/, the two trees that could plausibly hold a second writer. */
function runtimeJsFiles() {
  return [path.join(REPO, 'src'), path.join(REPO, 'bin')]
    .flatMap((root) => walk(root))
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({ rel: path.relative(REPO, file), text: fs.readFileSync(file, 'utf8') }));
}

const LEDGER_LOCATION = /state[\\/]+runs|runsDir\(|RUNS_DIRNAME|new RunLedger/;
const FS_WRITE_SOURCE = String.raw`appendFileSync|writeFileSync|createWriteStream|promises\.appendFile|\bopenSync\(`;
const FS_WRITE = new RegExp(FS_WRITE_SOURCE);

test('G12: trace.js is the only module that writes the run ledger (NFR-004)', () => {
  const writers = runtimeJsFiles()
    .filter(({ rel }) => rel !== path.relative(REPO, TRACE_FILE))
    .filter(({ text }) => LEDGER_LOCATION.test(text) && FS_WRITE.test(text))
    .map(({ rel }) => rel);
  assert.deepEqual(writers, [],
    'a second writer into state/runs/ is a second privacy policy. sanitizeRunEvent is what keeps a '
    + 'query string, a file path or an API token out of a file nobody reads until later — a raw '
    + `append does not consult it. Route the write through RunLedger#append:\n  ${writers.join('\n  ')}`);
});

test('G12: the ledger write in trace.js is the one guarded by sanitizeRunEvent (NFR-004)', () => {
  const writes = [...traceText.matchAll(new RegExp(FS_WRITE_SOURCE, "g"))].map((m) => m[0]);
  assert.deepEqual(writes, ['appendFileSync'],
    `trace.js should perform exactly one filesystem write. Found: ${writes.join(', ') || '(none)'}. `
    + 'More than one means a path into the ledger that this guard has not read.');

  const method = traceText.match(/\n {2}append\(event\) \{([\s\S]*?)\n {2}\}/);
  assert.ok(method, 'RunLedger#append must be parseable — it is the ledger write path');
  const body = method[1];
  assert.ok(body.includes('appendFileSync'),
    'the single write is no longer inside RunLedger#append; whatever now performs it is unguarded');
  assert.ok(body.indexOf('sanitizeRunEvent') >= 0
    && body.indexOf('sanitizeRunEvent') < body.indexOf('appendFileSync'),
    'append() must sanitize before it writes. Sanitizing after the write, or not at all, means the '
    + `raw event reaches disk:\n${body}`);
});

test('G12: the shell dispatcher records only fields the sanitizer would have allowed (NFR-004)', () => {
  // The dispatcher writes its own line rather than calling into Node — it has to, since the run
  // being recorded may be a shell verb that never loads the CLI. It is therefore the one writer
  // sanitizeRunEvent cannot police, so its record is policed here instead: a fixed format string,
  // only declared wire keys, and no expansion that could carry an argument value.
  const body = dispatcherText.match(/trace_run\(\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(body, 'trace_run() is the dispatcher-side ledger writer and must be parseable');

  const format = body[1].match(/printf '([^']*)'/);
  assert.ok(format, 'trace_run must write one fixed format string, not an assembled one');

  const wire = new Set(trace.RUN_FIELDS.map((field) => field.wire));
  wire.add('timestamp'); // written by sanitizeRunEvent itself, not a declared field
  const undeclared = [...format[1].matchAll(/"([a-z_]+)":/g)].map((m) => m[1]).filter((key) => !wire.has(key));
  assert.deepEqual(undeclared, [],
    'the dispatcher writes keys that RUN_FIELDS does not declare, so the reading side drops them and '
    + `the privacy review never sees them:\n  ${undeclared.join('\n  ')}`);

  // `$*`/`$@` is the leak: it is the verb's arguments, which are file paths, queries and
  // occasionally credentials. The dispatcher deliberately records `arg_count` instead.
  const leaks = [...body[1].matchAll(/\$\{?[*@]\}?/g)].map((m) => m[0]);
  assert.deepEqual(leaks, [],
    'trace_run expands the argument list into the ledger. NFR-004 allows the *count* and not the '
    + `values — that is why arg_count exists:\n  ${leaks.join('\n  ')}`);
});

test('G12: every string-valued ledger field is a token (NFR-004)', () => {
  // The mechanical half of NFR-004 is that a string field can only hold an identifier. A field
  // declared `type: 'text'` would be accepted by the same sanitizer, pass the same review, and
  // carry whatever the caller put in it. Nothing else in the module would change.
  const KNOWN_TYPES = new Set(['token', 'int', 'uint']);
  const foreign = trace.RUN_FIELDS
    .filter((field) => !KNOWN_TYPES.has(field.type))
    .map((field) => `${field.key}: type '${field.type}'`);
  assert.deepEqual(foreign, [],
    `RUN_FIELDS may only declare ${[...KNOWN_TYPES].join(', ')}. A free-text type reopens NFR-004 `
    + `without touching a line of sanitizeRunEvent:\n  ${foreign.join('\n  ')}`);

  // Asserted behaviourally as well as structurally: the type name only matters because of what the
  // sanitizer does with it, so prove it still drops content for every token field there is.
  const CONTENT = 'src/auth.js?token=sk-live-abc def';
  const leaked = trace.RUN_FIELDS
    .filter((field) => field.type === 'token')
    .filter((field) => {
      const { record } = trace.sanitizeRunEvent({ verb: 'paths', [field.key]: CONTENT });
      return record && record[field.wire] !== undefined;
    })
    .map((field) => field.key);
  assert.deepEqual(leaked, [],
    `these token fields accepted a value containing a path, a query string and a space:\n  ${leaked.join('\n  ')}`);
});

// ------------------------------------------------- 8. discover never claims CLEAR over no evidence

// FR-012's failure mode, and the one this feature keeps rediscovering: an analysis that finds
// nothing in data that could never have shown anything, reported as "no missed opportunities". It
// is worse than silence, because a user who reads CLEAR stops looking. `buildDiscover` has the
// right vocabulary for this — NOT_DETERMINED exists precisely to say "the ledger lacks the field
// this analysis needs" — so the guard is that every analysis actually reaches for it.
//
// Each analysis is mapped to the ledger fields its verdict rests on. An analysis added later with
// no entry fails the completeness check below rather than going unchecked.
const DISCOVER_SIGNAL_FIELDS = new Map([
  ['search-was-a-question', ['capability', 'resultCount']],
  ['manual-relationship-walk', ['capability']],
  ['uncompressed-output', ['outputBytes']],
  ['retries-without-readiness', ['exitCode']],
]);

// A live defect, pinned rather than accepted. Recorded so the guard covers the other three fully
// instead of being weakened to a warning, and so the fix is detected: the reverse check below fails
// the moment the analysis stops reproducing it.
// Empty by design. `retries-without-readiness` was pinned here when this guard was written: it
// reported CLEAR over a window whose `verify` records carried no exit code, unable to tell a clean
// run from nothing but failures. That was fixed in src/runtime/trace/ledger.js the same day, and the
// reverse check below is what detected the fix — a stale exemption fails rather than quietly
// granting cover the code no longer needs. Add an entry only with the reason a false CLEAR is
// currently unavoidable, never to silence a fixable one.
const KNOWN_FALSE_CLEAR = new Map([]);

const HEALTHY_PROVIDERS = Object.freeze({
  'semble.search': { status: 'HEALTHY' },
  'graphify.query': { status: 'HEALTHY' },
  rtk: { status: 'HEALTHY' },
});

/** A ledger read whose records are exactly what the caller described — nothing inferred. */
function ledgerRead(rows) {
  const records = rows.map((row) => trace.normalizeRunRecord(row)).filter(Boolean);
  return {
    dir: '/nonexistent/state/runs',
    exists: true,
    files: ['2026-08-18.jsonl'],
    records,
    malformedLines: 0,
    unreadableFiles: [],
    days: null,
  };
}

const at = (minute) => `2026-08-18T10:${String(minute).padStart(2, '0')}:00Z`;

// Each scenario starves one signal field while leaving the others healthy, so an analysis that
// answers anyway is answering from data it does not have.
const STARVED_LEDGERS = [
  ['verb-only records, the shape the shell dispatcher writes on its own', [
    { timestamp: at(0), verb: 'verify' },
    { timestamp: at(1), verb: 'verify' },
    { timestamp: at(2), verb: 'paths' },
  ]],
  ['capability records with no result counts and no byte volumes', [
    { timestamp: at(0), verb: 'route', capability: 'code.exact-search', provider: 'ripgrep', exit_code: 0 },
    { timestamp: at(1), verb: 'route', capability: 'code.exact-search', provider: 'ripgrep', exit_code: 0 },
    { timestamp: at(2), verb: 'route', capability: 'code.exact-search', provider: 'ripgrep', exit_code: 0 },
  ]],
  ['result counts present, byte volumes absent', [
    { timestamp: at(0), verb: 'route', capability: 'code.exact-search', provider: 'ripgrep', result_count: 2, exit_code: 0 },
    { timestamp: at(1), verb: 'route', capability: 'code.relationships', provider: 'graphify.query', result_count: 1, exit_code: 0 },
  ]],
  ['byte volumes present, capability absent', [
    { timestamp: at(0), verb: 'paths', output_bytes: 120, exit_code: 0 },
    { timestamp: at(1), verb: 'paths', output_bytes: 90, exit_code: 0 },
  ]],
];

test('G12: discover reports CLEAR only for an analysis whose signal fields have coverage (FR-012)', () => {
  const unsupported = [];
  const exemptedHits = new Set();

  for (const [label, rows] of STARVED_LEDGERS) {
    const view = trace.buildDiscover(ledgerRead(rows), { providerHealth: HEALTHY_PROVIDERS });
    for (const analysis of view.analyses) {
      if (analysis.status !== 'CLEAR') continue;
      const fields = DISCOVER_SIGNAL_FIELDS.get(analysis.id) || [];
      const starved = fields.filter((field) => view.coverage[field] === 0);
      if (!starved.length) continue;
      if (KNOWN_FALSE_CLEAR.has(analysis.id)) { exemptedHits.add(analysis.id); continue; }
      unsupported.push(`${analysis.id}: CLEAR with zero coverage of ${starved.join(', ')} — ${label}`);
    }
  }

  assert.deepEqual(unsupported.sort(), [],
    'CLEAR means "the analysis ran against data that could have shown the pattern and did not". '
    + 'Reporting it over a field with zero coverage tells the user there is nothing to find when the '
    + 'truth is that nothing could have been found. Return NOT_DETERMINED instead:\n  '
    + unsupported.sort().join('\n  '));

  // Reverse direction: an exemption for a defect that has since been fixed would silently
  // pre-approve the next one to appear under the same analysis id.
  const stale = [...KNOWN_FALSE_CLEAR.keys()].filter((id) => !exemptedHits.has(id));
  assert.deepEqual(stale, [],
    'these analyses no longer produce the false CLEAR they are exempted for. Delete the '
    + `KNOWN_FALSE_CLEAR entry — the guard now covers them for real:\n  ${stale.join('\n  ')}`);
});

test('G12: every discover analysis declares which ledger fields its verdict rests on', () => {
  const view = trace.buildDiscover(ledgerRead([{ timestamp: at(0), verb: 'paths', exit_code: 0 }]), {
    providerHealth: HEALTHY_PROVIDERS,
  });
  const produced = view.analyses.map((analysis) => analysis.id).sort();
  const declared = [...DISCOVER_SIGNAL_FIELDS.keys()].sort();
  assert.deepEqual(produced, declared,
    'DISCOVER_SIGNAL_FIELDS must name every analysis buildDiscover produces and no others. A new '
    + 'analysis with no entry would be exempt from the coverage check above by omission, which is '
    + `the quiet form of not having a guard.\n  produced: ${produced.join(', ')}\n  declared: ${declared.join(', ')}`);
});

// --------------------------------------- 9. the verification registry names real failure classes

// verification.yaml declares, per tier, which recovery class that tier's failure means — structural
// evidence that outranks the keyword classifier reading an error string. The registry loader
// deliberately does not import recovery.js (the registry is data; importing the classifier to
// validate the data would invert the dependency), so nothing at load time notices a tier naming a
// class that does not exist. It surfaces later, in the recovery path, as an unrouted failure —
// which is the moment the system is least able to absorb a second problem.
test('G12: every failureClass in verification.yaml is a declared recovery class (FR-010)', () => {
  const { parseYamlFile } = require('../../src/runtime/capability-router');
  const { FAILURE_CLASSES } = require('../../src/runtime/recovery');
  const doc = parseYamlFile(path.join(REPO, 'core', 'registry', 'verification.yaml'), fs);

  assert.ok(Array.isArray(doc.tiers) && doc.tiers.length > 0, 'verification.yaml must declare tiers');
  const known = new Set(FAILURE_CLASSES);

  const problems = doc.tiers.flatMap((tier) => {
    if (!tier.failureClass) {
      return [`tier '${tier.id}' declares no failureClass, so its failure routes to the keyword classifier`];
    }
    if (!known.has(tier.failureClass)) {
      return [`tier '${tier.id}' -> '${tier.failureClass}'`];
    }
    return [];
  });
  assert.deepEqual(problems, [],
    'a tier naming a class recovery.js does not know produces no targeted recovery action — the '
    + `strategy table has no entry for it. Declared classes: ${FAILURE_CLASSES.join(', ')}.\n  `
    + problems.join('\n  '));
});
