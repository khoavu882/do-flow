'use strict';

// G42 — dispatch and integration loop (082 IC-039, DEC-015, DEC-032, DEC-043, DEC-047). Six checks,
// each a pure function over injected text or parsed data, run once on the shipped tree and once on
// an in-memory copy seeded with one violation per check. `dispatch.test.js` already holds G9.
//
//   G42.1 storage.json declares `dispatch`, `dispatch-envelopes` and `dispatch-worktrees` with
//         IC-037's root, path, entry and rule
//   G42.2 every harness declares `isolatedEdit`, loadRegistry reports no error containing
//         " worker 'isolatedEdit'", and EDIT_BASELINE is BASELINE with `read-only` replaced by
//         `isolated-edit`
//   G42.3 operating-modes.md User controls: the Autonomous cells of Pause, Inspect, Cancel, Take over
//         and Resume are `implemented` with a `src/runtime/dispatch/controls.ts#` locator; Take
//         over's Manual / assisted cell and both Redirect cells are `target`
//   G42.4 trace_run's format string declares run, lineage and attempt; each value variable is
//         assigned only inside an `if [[ ... =~ ... ]]` test (as a JSON string) and otherwise holds
//         null; RUN_FIELDS declares the three as `token`
//   G42.5 no dispatch module contains `process.kill` or `.kill(`, only verify-run.ts references
//         `escalate`, and IC-032's lease rule calls verify-run.ts's exported endVerification
//   G42.6 no dispatch module holds the literals 'push', 'fetch', 'config', '--no-verify',
//         'checkout' or 'merge'

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const registryModule = require('../../src/registry/index.ts');

const HARNESS_COUNT = 8;
const DISPATCH_DIR = 'src/runtime/dispatch';
const escapeRe = (s: any) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const read = (rel: any) => fs.readFileSync(path.join(REPO, rel), 'utf8');

// ── G42.1 ───────────────────────────────────────────────────────────────────────────────────────

/** IC-037's root, path, entry and rule for the three dispatch stores. */
const DISPATCH_STORES = Object.freeze({
  dispatch: { root: 'project-state', path: 'dispatch', entry: 'record', rule: 'work' },
  'dispatch-envelopes': { root: 'project-state', path: 'dispatch-envelopes', entry: 'file', rule: 'count-and-age' },
  'dispatch-worktrees': { root: 'project-state', path: 'dispatch-worktrees', entry: 'dir', rule: 'existing' },
});

function storeFindings(storage: any) {
  const findings: any = [];
  const stores = Array.isArray(storage?.stores) ? storage.stores : [];
  for (const [id, expected] of Object.entries(DISPATCH_STORES)) {
    const store = stores.find((s: any) => s && s.id === id);
    if (!store) { findings.push(`G42.1: store '${id}' is not declared in storage.json`); continue; }
    for (const [field, value] of Object.entries(expected)) {
      if (store[field] !== value) findings.push(`G42.1: store '${id}' ${field} is ${JSON.stringify(store[field])}, expected ${JSON.stringify(value)}`);
    }
  }
  return findings;
}

// ── G42.2 ───────────────────────────────────────────────────────────────────────────────────────

const ISOLATED_EDIT_ERROR = " worker 'isolatedEdit'";

/** The string array a `const <name> = Object.freeze([...])` declaration holds, or null. */
function frozenArray(source: any, name: any) {
  const m = source.match(new RegExp(`^const ${escapeRe(name)} = Object\\.freeze\\(\\[([^\\]]*)\\]\\)`, 'm'));
  if (!m) return null;
  return [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
}

function isolatedEditFindings(registry: any, errors: any, readinessSource: any) {
  const findings = errors.filter((e: any) => e.includes(ISOLATED_EDIT_ERROR)).map((e: any) => `G42.2: ${e}`);
  const harnesses = registry?.harnesses ?? [];
  if (harnesses.length !== HARNESS_COUNT) findings.push(`G42.2: registry has ${harnesses.length} harnesses, expected ${HARNESS_COUNT}`);
  for (const harness of harnesses) {
    if (!harness.worker || !Object.hasOwn(harness.worker, 'isolatedEdit')) {
      findings.push(`G42.2: harness '${harness.id}' does not declare worker 'isolatedEdit'`);
    }
  }
  const base = frozenArray(readinessSource, 'BASELINE');
  const edit = frozenArray(readinessSource, 'EDIT_BASELINE');
  if (!base || !edit) {
    findings.push('G42.2: readiness.ts does not declare both BASELINE and EDIT_BASELINE');
  } else {
    const expected = base.map((r) => (r === 'read-only' ? 'isolated-edit' : r));
    if (!base.includes('read-only') || JSON.stringify(edit) !== JSON.stringify(expected)) {
      findings.push(`G42.2: EDIT_BASELINE is [${edit.join(', ')}], expected [${expected.join(', ')}]`);
    }
  }
  return findings;
}

/** The shipped registry and its validator errors; a failed load is read back from the throw. */
function shippedRegistry() {
  try {
    const registry = registryModule.loadRegistry({ repoRoot: REPO });
    return { registry, errors: registry.validation.errors };
  } catch (error: any) {
    if (!error.validation) throw error;
    return { registry: null, errors: error.validation.errors };
  }
}

// ── G42.3 ───────────────────────────────────────────────────────────────────────────────────────

const AUTONOMOUS_CONTROLS: any = ['Pause', 'Inspect', 'Cancel', 'Take over', 'Resume'];
const CONTROLS_LOCATOR = '`src/runtime/dispatch/controls.ts#';

/** The pipe-table under `## <heading>`, as rows keyed by header name. */
function sectionTable(doc: any, heading: any) {
  const lines = doc.split('\n');
  const start = lines.findIndex((l: any) => l.trim() === `## ${heading}`);
  if (start < 0) return null;
  const end = lines.findIndex((l: any, i: any) => i > start && /^## /.test(l));
  const body = lines.slice(start + 1, end < 0 ? lines.length : end).filter((l: any) => l.trim().startsWith('|'));
  if (body.length < 2) return null;
  const cells = (l: any) => l.trim().replace(/^\||\|$/g, '').split('|').map((c: any) => c.trim());
  const header = cells(body[0]);
  return body.slice(2).map((l: any) => Object.fromEntries(cells(l).map((c: any, i: any) => [header[i], c])));
}

function controlFindings(doc: any) {
  const rows = sectionTable(doc, 'User controls');
  if (!rows) return ['G42.3: operating-modes.md has no User controls table'];
  const findings: any = [];
  const row = (name: any) => rows.find((r: any) => r.Control === name);
  const cell = (name: any, column: any, want: any) => {
    const r = row(name);
    if (!r) { findings.push(`G42.3: User controls has no ${name} row`); return null; }
    if (r[column] !== want) findings.push(`G42.3: ${column} ${name} is '${r[column]}', expected '${want}'`);
    return r;
  };
  for (const name of AUTONOMOUS_CONTROLS) {
    const r = cell(name, 'Autonomous', 'implemented');
    if (r && !(r.Locator ?? '').includes(CONTROLS_LOCATOR)) findings.push(`G42.3: ${name} has no src/runtime/dispatch/controls.ts# locator`);
  }
  cell('Take over', 'Manual / assisted', 'target');
  cell('Redirect', 'Manual / assisted', 'target');
  cell('Redirect', 'Autonomous', 'target');
  return findings;
}

// ── G42.4 ───────────────────────────────────────────────────────────────────────────────────────

const IDENTITY_FIELDS: any = ['run', 'lineage', 'attempt'];

/** The `trace_run() { ... }` function of the dispatcher, or null. */
function traceRunBody(script: any) {
  const m = script.match(/^trace_run\(\) \{\n([\s\S]*?)^\}$/m);
  return m ? m[1] : null;
}

function traceRunFindings(script: any, ledgerSource: any) {
  const body = traceRunBody(script);
  if (body === null) return ['G42.4: doflow-run declares no trace_run function'];
  const findings: any = [];
  const joined = body.replace(/\\\n\s*/g, ' ');
  const printf = joined.match(/printf '([^']*)'((?:\s+"[^"]*")*)/);
  if (!printf) return ['G42.4: trace_run has no printf format string'];
  const format = printf[1];
  const args = [...printf[2].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  const placeholders: any = [...format.matchAll(/"([a-z_]+)":("?)%s\2/g)];
  for (const field of IDENTITY_FIELDS) {
    const index = placeholders.findIndex((p: any) => p[1] === field);
    if (index < 0) { findings.push(`G42.4: trace_run's format string does not declare "${field}":%s`); continue; }
    if (placeholders[index][2]) findings.push(`G42.4: trace_run's "${field}" placeholder is quoted; the value carries its own quotes or null`);
    const arg = args[index] ?? '';
    const variable = arg.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/)?.[1];
    if (!variable) { findings.push(`G42.4: trace_run's "${field}" value ${JSON.stringify(arg)} is not a variable`); continue; }
    if (!new RegExp(`^\\s*local\\b[^\\n]*\\b${variable}=null\\b`, 'm').test(body)) {
      findings.push(`G42.4: trace_run's "${field}" variable ${variable} does not default to null`);
    }
    for (const line of body.split('\n')) {
      const assigns: any = [...line.matchAll(new RegExp(`(?:^|[\\s;])${variable}=(\\S+)`, 'g'))];
      for (const a of assigns) {
        if (/^\s*local\b/.test(line) && a[1] === 'null') continue;
        const guarded = /^\s*if \[\[ [^\]]*=~[^\]]* \]\]; then /.test(line);
        if (!guarded) { findings.push(`G42.4: trace_run assigns ${variable} outside an if [[ ... =~ ... ]] test`); continue; }
        if (!/^"\\"\$\{[A-Z_]+\}\\""(?:;|$)/.test(a[1])) findings.push(`G42.4: trace_run assigns ${variable} an unquoted value ${a[1].replace(/;.*$/, '')}`);
      }
    }
  }
  for (const field of IDENTITY_FIELDS) {
    const re: any = new RegExp(`\\{ key: '${field}', wire: '${field}', type: '([a-z]+)' \\}`);
    const m = ledgerSource.match(re);
    if (!m) findings.push(`G42.4: RUN_FIELDS does not declare ${field}`);
    else if (m[1] !== 'token') findings.push(`G42.4: RUN_FIELDS declares ${field} as ${m[1]}, expected token`);
  }
  return findings;
}

// ── G42.5 ───────────────────────────────────────────────────────────────────────────────────────

/** Every `src/runtime/dispatch/*.ts` module's text, keyed by file name. */
function dispatchModules() {
  const dir = path.join(REPO, DISPATCH_DIR);
  return Object.fromEntries(fs.readdirSync(dir).filter((n: any) => n.endsWith('.ts')).sort()
    .map((n: any) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]));
}

function signalFindings(modules: any) {
  const findings: any = [];
  for (const [name, text] of Object.entries(modules)) {
    if (text.includes('process.kill')) findings.push(`G42.5: ${name} contains process.kill`);
    if (text.includes('.kill(')) findings.push(`G42.5: ${name} contains .kill(`);
    if (name !== 'verify-run.ts' && /\bescalate\b/.test(text)) findings.push(`G42.5: ${name} references escalate; only verify-run.ts may`);
  }
  const verify = modules['verify-run.ts'];
  const exports = verify?.match(/^module\.exports = \{([^}]*)\}/m)?.[1] ?? '';
  if (!/\bendVerification\b/.test(exports)) findings.push('G42.5: verify-run.ts does not export endVerification');
  const owner = Object.entries(modules).find(([, text]) => /^(?:async )?function leaseRule\(/m.test(text));
  if (!owner) {
    findings.push('G42.5: no dispatch module declares IC-032\'s leaseRule');
  } else {
    const [name, text] = owner;
    const start = text.search(/^(?:async )?function leaseRule\(/m);
    const end = text.indexOf('\n}\n', start);
    const body = text.slice(start, end < 0 ? text.length : end);
    const imported = /\{[^}]*\bendVerification\b[^}]*\}\s*=\s*require\('\.\/verify-run\.ts'\)/.test(text);
    if (!imported || !/\bendVerification\(/.test(body)) findings.push(`G42.5: ${name} leaseRule does not call verify-run.ts's endVerification`);
  }
  return findings;
}

// ── G42.6 ───────────────────────────────────────────────────────────────────────────────────────

const FORBIDDEN_LITERALS: any = ['push', 'fetch', 'config', '--no-verify', 'checkout', 'merge'];

function literalFindings(modules: any) {
  const findings: any = [];
  for (const [name, text] of Object.entries(modules)) {
    for (const literal of FORBIDDEN_LITERALS) {
      if (new RegExp(`(['"\`])${escapeRe(literal)}\\1`).test(text)) findings.push(`G42.6: ${name} holds the literal '${literal}'`);
    }
  }
  return findings;
}

// ── Helpers ─────────────────────────────────────────────────────────────────────────────────────

function assertOne(findings: any, pattern: any) {
  assert.equal(findings.length, 1, `expected exactly one finding, got:\n- ${findings.join('\n- ')}`);
  assert.match(findings[0], pattern);
}

/** Replaces `from` with `to` once, failing when `from` is absent so a control cannot pass vacuously. */
function seed(text: any, from: any, to: any) {
  assert.ok(text.includes(from), `seed: text must contain ${JSON.stringify(from)}`);
  return text.replace(from, to);
}

const storage = () => JSON.parse(read('core/registry/storage.json'));
const readiness = () => read('src/runtime/worker/readiness.ts');
const modesDoc = () => read('docs/specs/operating-modes.md');
const dispatcher = () => read('core/shared/scripts/doflow/bin/doflow-run');
const ledger = () => read('src/runtime/trace/ledger.ts');

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

test('G42.1: storage.json declares dispatch, dispatch-envelopes and dispatch-worktrees per IC-037', () => {
  assert.deepEqual(storeFindings(storage()), []);
});

test('G42.1 control: a dropped store and a changed rule are each reported', () => {
  const dropped = storage();
  dropped.stores = dropped.stores.filter((s: any) => s.id !== 'dispatch-envelopes');
  assertOne(storeFindings(dropped), /^G42\.1: store 'dispatch-envelopes' is not declared/);
  const changed = storage();
  changed.stores.find((s: any) => s.id === 'dispatch-worktrees').rule = 'count-and-age';
  assertOne(storeFindings(changed), /^G42\.1: store 'dispatch-worktrees' rule is "count-and-age", expected "existing"$/);
});

test('G42.2: every harness declares isolatedEdit, no isolatedEdit error, EDIT_BASELINE swaps read-only for isolated-edit', () => {
  const { registry, errors } = shippedRegistry();
  assert.ok(registry, `registry failed to load:\n- ${errors.join('\n- ')}`);
  assert.deepEqual(isolatedEditFindings(registry, errors, readiness()), []);
});

test('G42.2 control: a dropped harness entry and a drifted EDIT_BASELINE are each reported', () => {
  const registry = structuredClone(shippedRegistry().registry);
  const harness = registry.harnesses[2];
  delete harness.worker.isolatedEdit;
  const errors = registryModule.validateRegistry(registry, { repoRoot: REPO }).errors;
  assertOne(isolatedEditFindings(registry, errors, readiness()), new RegExp(`^G42\\.2: harness '${escapeRe(harness.id)}' does not declare worker 'isolatedEdit'$`));

  const drifted = seed(readiness(), "'structured-output', 'isolated-edit',", "'structured-output', 'read-only',");
  assertOne(isolatedEditFindings(shippedRegistry().registry, [], drifted), /^G42\.2: EDIT_BASELINE is \[.*read-only.*\], expected/);
});

test('G42.2 control: a validator error naming isolatedEdit is reported', () => {
  const registry = structuredClone(shippedRegistry().registry);
  const harness = registry.harnesses.find((h: any) => h.worker.isolatedEdit.status === 'unknown');
  assert.ok(harness, 'control precondition: a harness whose isolatedEdit is unknown (codex is supported since 109)');
  assert.equal(harness.worker.isolatedEdit.status, 'unknown', 'control precondition: isolatedEdit is unknown');
  harness.worker.isolatedEdit.argv = ['--edit'];
  const errors = registryModule.validateRegistry(registry, { repoRoot: REPO }).errors;
  assertOne(isolatedEditFindings(registry, errors, readiness()), /^G42\.2: .* worker 'isolatedEdit'/);
});

test('G42.3: Autonomous controls are implemented with a controls.ts# locator; Take over manual and Redirect stay target', () => {
  assert.deepEqual(controlFindings(modesDoc()), []);
});

test('G42.3 control: an Autonomous cell flipped to target is reported', () => {
  const doc = seed(modesDoc(), '| Inspect | implemented | implemented |', '| Inspect | implemented | target |');
  assertOne(controlFindings(doc), /^G42\.3: Autonomous Inspect is 'target', expected 'implemented'$/);
});

test('G42.3 control: a dropped controls.ts locator and an implemented Redirect cell are each reported', () => {
  const noLocator = seed(modesDoc(), ', `src/runtime/dispatch/controls.ts#resume`', '');
  assertOne(controlFindings(noLocator), /^G42\.3: Resume has no src\/runtime\/dispatch\/controls\.ts# locator$/);
  const redirect = seed(modesDoc(), '| Redirect | target | target |', '| Redirect | target | implemented |');
  assertOne(controlFindings(redirect), /^G42\.3: Autonomous Redirect is 'implemented', expected 'target'$/);
  const takeOver = seed(modesDoc(), '| Take over | target |', '| Take over | implemented |');
  assertOne(controlFindings(takeOver), /^G42\.3: Manual \/ assisted Take over is 'implemented', expected 'target'$/);
});

test('G42.4: trace_run records run, lineage and attempt only from pattern-tested values; RUN_FIELDS declares them token', () => {
  assert.deepEqual(traceRunFindings(dispatcher(), ledger()), []);
});

test('G42.4 control: an unquoted trace_run value is reported', () => {
  const script = seed(dispatcher(), 'then lineage_v="\\"${DOFLOW_LINEAGE_ID}\\""', 'then lineage_v="${DOFLOW_LINEAGE_ID}"');
  assertOne(traceRunFindings(script, ledger()), /^G42\.4: trace_run assigns lineage_v an unquoted value/);
});

test('G42.4 control: an unguarded assignment, a dropped field and a retyped RUN_FIELDS entry are each reported', () => {
  const unguarded = seed(dispatcher(), '  mkdir -p "$runs_dir"', '  attempt_v="\\"${DOFLOW_ATTEMPT}\\""\n  mkdir -p "$runs_dir"');
  assertOne(traceRunFindings(unguarded, ledger()), /^G42\.4: trace_run assigns attempt_v outside an if \[\[ \.\.\. =~ \.\.\. \]\] test$/);
  const dropped = seed(dispatcher(), ',"run":%s,', ',');
  const droppedFindings = traceRunFindings(dropped, ledger());
  assert.ok(droppedFindings.some((f: any) => /does not declare "run":%s/.test(f)), droppedFindings.join('\n'));
  const retyped = seed(ledger(), "{ key: 'attempt', wire: 'attempt', type: 'token' }", "{ key: 'attempt', wire: 'attempt', type: 'uint' }");
  assertOne(traceRunFindings(dispatcher(), retyped), /^G42\.4: RUN_FIELDS declares attempt as uint, expected token$/);
});

test('G42.5: dispatch code signals only the verification group, through verify-run.ts', () => {
  assert.deepEqual(signalFindings(dispatchModules()), []);
});

test('G42.5 control: an added process.kill is reported', () => {
  const modules = dispatchModules();
  modules['loop.ts'] += '\nfunction stray(pid) { return process.kill(pid, 0); }\n';
  const got = signalFindings(modules);
  // `process.kill(` also contains `.kill(`; the one module is named under both spellings.
  assert.deepEqual(got, ['G42.5: loop.ts contains process.kill', 'G42.5: loop.ts contains .kill(']);
});

test('G42.5 control: escalate outside verify-run.ts and a lease rule not calling endVerification are each reported', () => {
  const escalating = dispatchModules();
  escalating['controls.ts'] += '\nconst { escalate } = require(\'../worker/process-tree.ts\');\n';
  assertOne(signalFindings(escalating), /^G42\.5: controls\.ts references escalate; only verify-run\.ts may$/);
  const lease = dispatchModules();
  lease['controls.ts'] = seed(lease['controls.ts'], 'verification = await endVerification(verifying,', 'verification = await Promise.resolve(verifying,');
  assertOne(signalFindings(lease), /^G42\.5: controls\.ts leaseRule does not call verify-run\.ts's endVerification$/);
});

test('G42.6: no dispatch module holds a push, fetch, config, --no-verify, checkout or merge literal', () => {
  assert.deepEqual(literalFindings(dispatchModules()), []);
});

test('G42.6 control: an added push argv is reported', () => {
  const modules = dispatchModules();
  modules['integrate.ts'] += "\nconst stray = ['git', 'push', 'origin'];\n";
  assertOne(literalFindings(modules), /^G42\.6: integrate\.ts holds the literal 'push'$/);
});
