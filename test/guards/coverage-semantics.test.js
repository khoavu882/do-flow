'use strict';

// G39 — coverage semantics (078 IC-021, DEC-019). Three checks, each a pure function over injected
// inputs, run once on the shipped tree and once per negative control that seeds one violation and
// expects exactly one named finding.
//
//   G39.1 end-of-turn events: stop rows, stop-check fixtures and endOfTurn agree; no never-list event;
//         every event is in bench/inventory/coverage.json as that event or as the harness's '*'
//         row (DEC-036); non-empty events carry external doc or
//         types provenance
//   G39.2 behaviours: one entry per behaviour x harness; enforced tests exist; limitations are
//         non-empty; identity is enforced only with live provenance
//   G39.3 the rendered behaviour block in docs/capability-map.md equals renderBehaviourMatrix()
//
// validateCoverage() (src/registry/index.ts) checks shape; this guard checks meaning.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { renderBehaviourMatrix, BEHAVIOUR_ORDER, HARNESS_ORDER } = require('../../src/lifecycle/coverage.ts');
// The docs block renders the registry through the docs generator's inert() (Markdown and HTML in a
// registry value are escaped), so the shipped block is compared with that rendering.
const { inert } = require('../../src/release/docs-blocks.ts');

const NEVER_END_OF_TURN = new Set(['SessionEnd', 'SubagentStop', 'PreCompact', 'PreCompress', 'PostToolUse',
  'AfterTool', 'tool_execution_start', 'SessionStart', 'agentSpawn']);
const START = '<!-- BEGIN GENERATED:context-behaviour-matrix -->';
const END = '<!-- END GENERATED:context-behaviour-matrix -->';

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

function readJson(rel) { return JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8')); }

// Each stop-check fixture as { file, harness, event }. The native event is the payload's
// hook_event_name, else the expected envelope's event; a fixture naming neither (raw stdin cases,
// policy goldens) declares no native event and is not a G39.1 input.
function stopFixtures() {
  const root = path.join(REPO, 'test/fixtures/hooks');
  const out = [];
  for (const harness of fs.readdirSync(root)) {
    const dir = path.join(root, harness, 'stop-check');
    if (!HARNESS_ORDER.includes(harness) || !fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
      const fixture = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      const event = fixture.native?.hook_event_name ?? fixture.expect?.envelope?.event;
      if (typeof event !== 'string') continue;
      out.push({ file: `${harness}/stop-check/${name}`, harness: fixture.expect?.envelope?.harness ?? harness, event });
    }
  }
  return out;
}

function shipped() {
  return {
    coverage: readJson('core/registry/lifecycle.json').coverage,
    fixtures: stopFixtures(),
    inventory: readJson('bench/inventory/coverage.json'),
    doc: fs.readFileSync(path.join(REPO, 'docs/capability-map.md'), 'utf8'),
    exists: (rel) => fs.existsSync(path.join(REPO, rel)),
  };
}

const clone = (value) => JSON.parse(JSON.stringify(value));
const isExternal = (item) => (item.kind === 'doc' && /^https?:\/\//.test(item.locator || '')) || item.kind === 'types';

// ── G39.1 end-of-turn events ────────────────────────────────────────────────────────────────────

function g391({ coverage, fixtures, inventory }) {
  const findings = [];
  const eot = new Map((coverage.endOfTurn || []).map((entry) => [entry.harness, entry]));
  const eventsOf = (harness) => eot.get(harness)?.events || [];
  for (const row of coverage.rows.filter((r) => r.timing === 'stop' && r.event !== '*')) {
    if (!eventsOf(row.harness).includes(row.event)) findings.push(`G39.1 stop row ${row.policy}/${row.harness}/${row.event}/${row.profile} outside endOfTurn`);
  }
  for (const fixture of fixtures) {
    if (!eventsOf(fixture.harness).includes(fixture.event)) findings.push(`G39.1 fixture ${fixture.file} event ${fixture.event} outside endOfTurn`);
  }
  const inventoried = new Set(inventory.rows.map((r) => `${r.harness}\0${r.event}`));
  for (const entry of coverage.endOfTurn || []) {
    for (const event of entry.events) {
      if (NEVER_END_OF_TURN.has(event)) findings.push(`G39.1 ${entry.harness} endOfTurn names never-list event ${event}`);
      if (!inventoried.has(`${entry.harness}\0${event}`) && !inventoried.has(`${entry.harness}\0*`)) findings.push(`G39.1 ${entry.harness} endOfTurn event ${event} absent from inventory`);
    }
    if (entry.events.length > 0 && !(entry.provenance || []).some(isExternal)) findings.push(`G39.1 ${entry.harness} endOfTurn lacks external doc or types provenance`);
  }
  return findings;
}

// ── G39.2 behaviours ────────────────────────────────────────────────────────────────────────────

function g392({ coverage, exists }) {
  const findings = [];
  const seen = new Map();
  for (const entry of coverage.behaviours || []) {
    const key = `${entry.behaviour}/${entry.harness}`;
    seen.set(key, (seen.get(key) || 0) + 1);
    if (entry.status === 'enforced') {
      for (const file of entry.tests || []) if (!exists(file)) findings.push(`G39.2 ${key} names missing test ${file}`);
      if (entry.behaviour === 'identity' && !(entry.provenance || []).some((p) => p.kind === 'live')) findings.push(`G39.2 ${key} enforced without live provenance`);
    }
    if (entry.status === 'limitation' && !String(entry.limitation || '').trim()) findings.push(`G39.2 ${key} empty limitation`);
  }
  for (const behaviour of BEHAVIOUR_ORDER) for (const harness of HARNESS_ORDER) {
    const count = seen.get(`${behaviour}/${harness}`) || 0;
    if (count === 0) findings.push(`G39.2 ${behaviour}/${harness} missing`);
    if (count > 1) findings.push(`G39.2 ${behaviour}/${harness} duplicated`);
  }
  return findings;
}

// ── G39.3 rendered block ────────────────────────────────────────────────────────────────────────

function g393({ coverage, doc }) {
  const a = doc.indexOf(START), b = doc.indexOf(END);
  if (a < 0 || b < a) return ['G39.3 behaviour matrix markers missing'];
  const shipped = doc.slice(a + START.length, b).trim().split('\n');
  const rendered = renderBehaviourMatrix(inert(coverage)).split('\n');
  const findings = [];
  for (let i = 0; i < Math.max(shipped.length, rendered.length); i++) {
    if (shipped[i] !== rendered[i]) findings.push(`G39.3 rendered row ${i} differs from renderBehaviourMatrix()`);
  }
  return findings;
}

// ── Shipped tree ────────────────────────────────────────────────────────────────────────────────

test('G39.1 end-of-turn events agree with stop rows, fixtures, inventory and provenance', () => {
  assert.deepEqual(g391(shipped()), []);
});
test('G39.2 every behaviour x harness pair is present once and well-founded', () => {
  assert.deepEqual(g392(shipped()), []);
});
test('G39.3 the shipped behaviour block equals renderBehaviourMatrix()', () => {
  assert.deepEqual(g393(shipped()), []);
});

// ── Negative controls: one seeded violation, one named finding ──────────────────────────────────

// A mutable copy of the shipped inputs. The G39.1 control compares against the shipped findings,
// so the seed's own finding is isolated from whatever the shipped tree reports.
function cleanBase() {
  const input = shipped();
  input.coverage = clone(input.coverage);
  input.inventory = clone(input.inventory);
  return input;
}

test('G39.1 control: a SessionEnd in endOfTurn is named', () => {
  const input = cleanBase();
  const claude = input.coverage.endOfTurn.find((e) => e.harness === 'claude');
  claude.events.push('SessionEnd');
  const baseline = new Set(g391(shipped()));
  const added = g391(input).filter((f) => !baseline.has(f));
  assert.deepEqual(added, ['G39.1 claude endOfTurn names never-list event SessionEnd']);
});

test('G39.1 control: a harness with neither the event nor a \'*\' inventory row is named', () => {
  const input = cleanBase();
  input.inventory.rows = input.inventory.rows.filter((r) => r.harness !== 'copilot');
  assert.deepEqual(g391(input), ['G39.1 copilot endOfTurn event Stop absent from inventory']);
});

test('G39.2 control: a missing behaviour x harness pair is named', () => {
  const input = cleanBase();
  input.coverage.behaviours = input.coverage.behaviours.filter((e) => !(e.behaviour === 'summary-grant' && e.harness === 'kiro'));
  assert.deepEqual(g392(input), ['G39.2 summary-grant/kiro missing']);
});

test('G39.2 control: identity enforced without live provenance is named', () => {
  const input = cleanBase();
  const entry = input.coverage.behaviours.find((e) => e.behaviour === 'identity' && e.harness === 'claude');
  Object.assign(entry, { status: 'enforced', tests: ['test/guards/coverage-semantics.test.js'], provenance: [{ kind: 'doc', locator: 'https://code.claude.com/docs/en/hooks', date: '2026-10-12' }] });
  delete entry.limitation;
  assert.deepEqual(g392(input), ['G39.2 identity/claude enforced without live provenance']);
});

test('G39.3 control: a hand-edited rendered row is named', () => {
  const input = cleanBase();
  input.doc = input.doc.replace('| identity | kiro | limitation |', '| identity | kiro | enforced |');
  assert.notEqual(input.doc, shipped().doc, 'seed applied');
  assert.equal(g393(input).length, 1);
  assert.match(g393(input)[0], /^G39\.3 rendered row \d+ differs from renderBehaviourMatrix\(\)$/);
});
