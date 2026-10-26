'use strict';

// maint-thin (user ruling 2026-10-26): roadmap gating moves from the write to the activation. A seed apply or amend
// is allowed while autopilot is on, and the rows it writes land `proposed`; autopilot (pick, stepRow, decide-gate)
// never acts on a proposed row; `roadmap promote <id...>` is person-only (the fail-closed seed reader) and makes them
// ready. While autopilot is verifiably off, seed lands rows ready, as before. Each case has a negative control.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { seedFindings, deriveStatus, pick, render, renderRoadmapFile } = require('../../src/runtime/roadmap/rows.ts');
const { loadPolicy, evaluate } = require('../../src/runtime/roadmap/gates.ts');
const { sha256Digest } = require('../../src/runtime/roadmap/facts.ts');
const { handleSeedCommand, handlePromoteCommand } = require('../../src/runtime/roadmap/seed.ts');

const FACTS = { developHead: 'h', merges: [], branches: [], unreadable: [] };
const ON = () => ({ enabled: true, switch: null });
const OFF = () => ({ enabled: false, switch: null });
const row = (id: string, extra: any = {}) => ({ id, slug: `${id}-r`, title: `Row ${id}`, class: 'feature', needs: [], writeSet: [`src/${id}/`], ...extra });

function store(t: any, rows: any[]) {
  const dir = tempDir(t, 'doflow-roadmap-proposed-');
  const storeDir = path.join(dir, 'agent-docs', 'roadmap');
  fs.mkdirSync(storeDir, { recursive: true });
  fs.writeFileSync(path.join(storeDir, 'rows.json'), JSON.stringify({ schema: 1, rows }, null, 2) + '\n');
  renderRoadmapFile({ roadmapPath: path.join(storeDir, 'ROADMAP.md'), content: render(rows, deriveStatus(rows, {}).statuses) });
  return dir;
}
const rowsOf = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8')).rows;
const capture = () => { const lines: string[] = []; return { lines, fn: (s: string) => lines.push(s) }; };

test('rows: proposed is a known row key, only true; a proposed row derives status proposed and is never picked', () => {
  assert.deepEqual(seedFindings({ schema: 1, rows: [row('130', { proposed: true })] }), []);
  assert.deepEqual(seedFindings({ schema: 1, rows: [row('130', { proposed: false })] }).map((f: any) => f.rule), ['seed-invalid']);
  const rows = [row('130', { proposed: true }), row('131')];
  const { statuses } = deriveStatus(rows, {});
  assert.equal(statuses.get('130').status, 'proposed');
  assert.equal(statuses.get('131').status, 'not-started', 'negative control: a row without the mark is ready');
  const picked = pick(rows, statuses);
  assert.equal(picked.picked.id, '131');
  assert.equal(picked.skips['130'], 'row-proposed');
  assert.equal(pick([row('130', { proposed: true })], deriveStatus([row('130', { proposed: true })], {}).statuses).picked, null);
  // a branch a person started by hand is in flight; the mark still keeps autopilot off it (stepRow skips it)
  assert.equal(deriveStatus([row('130', { proposed: true })], { branches: ['feat/130-r'] }).statuses.get('130').status, 'in-flight');
});

test('decide-gate by policy denies row-proposed for a proposed row; the same row without the mark is not denied for it', () => {
  const policy = loadPolicy(fs.readFileSync(path.join(__dirname, '../../core/registry/gates.json'))).policy;
  const facts = (value: any) => [{ name: 'row', value, locator: 'fixture:row', sha256: sha256Digest(JSON.stringify(value)) }];
  const denied = evaluate(policy, 'feature', 'gate-0', facts(row('130', { proposed: true })));
  assert.equal(denied.decision, 'deny');
  assert.deepEqual(denied.reasons, ['row-proposed']);
  const ready = evaluate(policy, 'feature', 'gate-0', facts(row('130')));
  assert.equal(ready.reasons.includes('row-proposed'), false);
});

test('seed apply and amend while autopilot is on land the written rows proposed; while off they land ready', (t) => {
  const dir = store(t, [row('130')]);
  const draft = path.join(dir, 'draft.json');
  fs.writeFileSync(draft, JSON.stringify({ schema: 1, rows: [row('131')] }));
  const on = capture();
  assert.equal(handleSeedCommand({ action: 'apply', draft, root: dir, json: true, gitFacts: FACTS, readSwitch: ON, out: on.fn, err: on.fn }), 0);
  assert.deepEqual(JSON.parse(on.lines[0]).proposed, ['131']);
  assert.deepEqual(rowsOf(dir).map((r: any) => [r.id, r.proposed ?? null]), [['130', null], ['131', true]]);

  // amend of the ready row 130 while on: it is proposed again (an unattended change to a ready row waits for a person)
  fs.writeFileSync(draft, JSON.stringify({ schema: 1, rows: [row('130', { title: 'Row 130 amended' })] }));
  assert.equal(handleSeedCommand({ action: 'amend', draft, root: dir, json: true, gitFacts: FACTS, readSwitch: ON, out: () => {}, err: () => {} }), 0);
  assert.equal(rowsOf(dir).find((r: any) => r.id === '130').proposed, true);

  // negative control: with autopilot verifiably off the same writes land ready
  const offDir = store(t, [row('130')]);
  const offDraft = path.join(offDir, 'draft.json');
  fs.writeFileSync(offDraft, JSON.stringify({ schema: 1, rows: [row('131')] }));
  const off = capture();
  assert.equal(handleSeedCommand({ action: 'apply', draft: offDraft, root: offDir, json: true, gitFacts: FACTS, readSwitch: OFF, out: off.fn, err: off.fn }), 0);
  assert.deepEqual(JSON.parse(off.lines[0]).proposed, []);
  assert.deepEqual(rowsOf(offDir).map((r: any) => r.proposed ?? null), [null, null]);
});

test('promote is person only: refused needs-person unless autopilot is verifiably off, and writes nothing', (t) => {
  const dir = store(t, [row('130', { proposed: true })]);
  const before = fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8');
  const out = capture();
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: dir, json: true, gitFacts: FACTS, readSwitch: ON, out: out.fn, err: out.fn }), 1);
  const refused = JSON.parse(out.lines[0]);
  assert.equal(refused.reason, 'needs-person');
  assert.equal(refused.writes, 0);
  assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'), before);
});

test('promote with autopilot off drops the mark, so the row is picked; text output names the ids', (t) => {
  const dir = store(t, [row('130', { proposed: true }), row('131', { proposed: true })]);
  const out = capture();
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: dir, gitFacts: FACTS, readSwitch: OFF, out: out.fn, err: out.fn }), 0);
  assert.match(out.lines[0], /^roadmap promote: ok, 1 promoted: 130$/);
  const rows = rowsOf(dir);
  assert.equal(Object.hasOwn(rows[0], 'proposed'), false);
  assert.equal(rows[1].proposed, true, 'negative control: an unnamed proposed row stays proposed');
  assert.equal(pick(rows, deriveStatus(rows, {}).statuses).picked.id, '130');
  assert.match(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/ROADMAP.md'), 'utf8'), /\| 130 \| Row 130 \| feature \| - \| not-started \| - \| pick \|/);
});

test('promote is all or nothing: an unknown, a ready or a repeated id is a finding and nothing is written; no ids is usage', (t) => {
  const dir = store(t, [row('130', { proposed: true }), row('131')]);
  const before = fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8');
  const out = capture();
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130', '131', '199', '130'], root: dir, json: true, gitFacts: FACTS, readSwitch: OFF, out: out.fn, err: out.fn }), 1);
  assert.deepEqual(JSON.parse(out.lines[0]).findings.map((f: any) => [f.rule, f.rowId]),
    [['row-not-proposed', '131'], ['row-not-found', '199'], ['duplicate-id', '130']]);
  assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'), before);
  assert.equal(handlePromoteCommand({ isTTY: true, ids: [], root: dir, gitFacts: FACTS, readSwitch: OFF, out: () => {}, err: () => {} }), 2);
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['../x'], root: dir, gitFacts: FACTS, readSwitch: OFF, out: () => {}, err: () => {} }), 2);
});

test('maint-thin P1: promote without an interactive terminal is refused needs-person-tty even with autopilot off (an env redirect reads as off)', (t) => {
  const dir = store(t, [row('130', { proposed: true })]);
  const before = fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8');
  for (const isTTY of [false, undefined]) {
    const out = capture();
    const code = handlePromoteCommand({ ...(isTTY === undefined ? {} : { isTTY }), ids: ['130'], root: dir, json: true, gitFacts: FACTS, readSwitch: OFF, out: out.fn, err: out.fn });
    assert.equal(code, 1);
    assert.equal(JSON.parse(out.lines[0]).reason, 'needs-person-tty');
    assert.equal(JSON.parse(out.lines[0]).writes, 0);
  }
  assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'), before);
  // the switch stays a second check: a terminal with autopilot on is still refused needs-person
  const on = capture();
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: dir, json: true, gitFacts: FACTS, readSwitch: ON, out: on.fn, err: on.fn }), 1);
  assert.equal(JSON.parse(on.lines[0]).reason, 'needs-person');
  assert.equal(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8'), before);
});
