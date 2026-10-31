'use strict';

// maint-thin (user ruling 2026-10-26): roadmap gating moves from the write to the activation. A seed apply or amend
// is allowed while autopilot is on, and the rows it writes land `proposed`; autopilot (pick, stepRow, decide-gate)
// never acts on a proposed row; `roadmap promote <id...>` is person-only (an interactive terminal, then a [y/N] answer on
// /dev/tty) and makes them ready. While autopilot is verifiably off, seed lands rows ready, as before. Each case has a negative control.

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
  assert.equal(handleSeedCommand({ isTTY: true, action: 'apply', draft, root: dir, json: true, gitFacts: FACTS, readSwitch: ON, out: on.fn, err: on.fn }), 0);
  assert.deepEqual(JSON.parse(on.lines[0]).proposed, ['131']);
  assert.deepEqual(rowsOf(dir).map((r: any) => [r.id, r.proposed ?? null]), [['130', null], ['131', true]]);

  // amend of the ready row 130 while on: it is proposed again (an unattended change to a ready row waits for a person)
  fs.writeFileSync(draft, JSON.stringify({ schema: 1, rows: [row('130', { title: 'Row 130 amended' })] }));
  assert.equal(handleSeedCommand({ isTTY: true, action: 'amend', draft, root: dir, json: true, gitFacts: FACTS, readSwitch: ON, out: () => {}, err: () => {} }), 0);
  assert.equal(rowsOf(dir).find((r: any) => r.id === '130').proposed, true);

  // negative control: with autopilot verifiably off the same writes land ready
  const offDir = store(t, [row('130')]);
  const offDraft = path.join(offDir, 'draft.json');
  fs.writeFileSync(offDraft, JSON.stringify({ schema: 1, rows: [row('131')] }));
  const off = capture();
  assert.equal(handleSeedCommand({ isTTY: true, action: 'apply', draft: offDraft, root: offDir, json: true, gitFacts: FACTS, readSwitch: OFF, out: off.fn, err: off.fn }), 0);
  assert.deepEqual(JSON.parse(off.lines[0]).proposed, []);
  assert.deepEqual(rowsOf(offDir).map((r: any) => r.proposed ?? null), [null, null]);
});

const YES = () => 'y';
// a reader that records its prompts, so a test can prove whether a prompt was shown
const asker = (answer: string | null | (() => string | null)) => {
  const prompts: string[] = [];
  return { prompts, confirm: (p: string) => { prompts.push(p); return typeof answer === 'function' ? answer() : answer; } };
};
const rawRows = (dir: string) => fs.readFileSync(path.join(dir, 'agent-docs/roadmap/rows.json'), 'utf8');

test('promote asks the person: y or yes (any case) promotes, and the prompt lists the ids and titles', (t) => {
  for (const answer of ['y', 'Y', 'yes', 'YES', ' yes ']) {
    const dir = store(t, [row('130', { proposed: true }), row('131', { proposed: true })]);
    const a = asker(answer);
    const out = capture();
    assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130', '131'], root: dir, json: true, gitFacts: FACTS, confirm: a.confirm, out: out.fn, err: out.fn }), 0, answer);
    assert.deepEqual(JSON.parse(out.lines[0]).promoted, ['130', '131']);
    assert.equal(a.prompts.length, 1);
    assert.match(a.prompts[0], /130 {2}Row 130\n {2}131 {2}Row 131\nPromote 2 row\(s\): 130 131\? \[y\/N\] $/);
    assert.deepEqual(rowsOf(dir).map((r: any) => r.proposed ?? null), [null, null]);
  }
});

test('promote refuses needs-person-confirm with zero writes on n, empty, junk, EOF (null) and a throwing reader', (t) => {
  const dir = store(t, [row('130', { proposed: true })]);
  const before = rawRows(dir);
  const tablePath = path.join(dir, 'agent-docs/roadmap/ROADMAP.md');
  const tableBefore = fs.readFileSync(tablePath, 'utf8');
  const answers: Array<string | null | (() => string | null)> = ['n', 'N', '', 'no', 'yep', 'y y', null, () => { throw new Error('tty closed'); }];
  for (const answer of answers) {
    const out = capture();
    assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: dir, json: true, gitFacts: FACTS, confirm: asker(answer).confirm, out: out.fn, err: out.fn }), 1);
    const refused = JSON.parse(out.lines[0]);
    assert.equal(refused.reason, 'needs-person-confirm');
    assert.equal(refused.ok, false);
    assert.equal(refused.writes, 0);
    assert.deepEqual(refused.promoted, []);
  }
  assert.equal(rawRows(dir), before);
  assert.equal(fs.readFileSync(tablePath, 'utf8'), tableBefore);
  const text = capture();
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: dir, gitFacts: FACTS, confirm: asker('n').confirm, out: text.fn, err: text.fn }), 1);
  assert.match(text.lines[0], /^roadmap promote: refused: needs-person-confirm$/);
});

test('promote with no controlling terminal to read (the default reader finds no /dev/tty) refuses needs-person-confirm and writes nothing', (t) => {
  const dir = store(t, [row('130', { proposed: true })]);
  const before = rawRows(dir);
  const realOpen = fs.openSync;
  const opened: string[] = [];
  fs.openSync = ((p: any, ...rest: any[]) => {
    if (p === '/dev/tty') { opened.push(p); throw Object.assign(new Error('ENXIO: no such device or address'), { code: 'ENXIO' }); }
    return (realOpen as any)(p, ...rest);
  }) as any;
  t.after(() => { fs.openSync = realOpen; });
  const out = capture();
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: dir, json: true, gitFacts: FACTS, out: out.fn, err: out.fn }), 1);
  assert.deepEqual(opened, ['/dev/tty'], 'the default reader opens /dev/tty');
  assert.equal(JSON.parse(out.lines[0]).reason, 'needs-person-confirm');
  assert.equal(rawRows(dir), before);
});

test('promote validates before it asks: an unknown, ready or repeated id is a finding and no prompt is shown', (t) => {
  const dir = store(t, [row('130', { proposed: true }), row('131')]);
  const before = rawRows(dir);
  const a = asker(YES);
  const out = capture();
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130', '131', '199', '130'], root: dir, json: true, gitFacts: FACTS, confirm: a.confirm, out: out.fn, err: out.fn }), 1);
  assert.deepEqual(JSON.parse(out.lines[0]).findings.map((f: any) => [f.rule, f.rowId]),
    [['row-not-proposed', '131'], ['row-not-found', '199'], ['duplicate-id', '130']]);
  assert.deepEqual(a.prompts, []);
  assert.equal(rawRows(dir), before);
});

test('promote drops the mark, so the row is picked; text output names the ids; an unnamed proposed row stays proposed', (t) => {
  const dir = store(t, [row('130', { proposed: true }), row('131', { proposed: true })]);
  const out = capture();
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: dir, gitFacts: FACTS, confirm: YES, out: out.fn, err: out.fn }), 0);
  assert.match(out.lines[0], /^roadmap promote: ok, 1 promoted: 130$/);
  const rows = rowsOf(dir);
  assert.equal(Object.hasOwn(rows[0], 'proposed'), false);
  assert.equal(rows[1].proposed, true, 'negative control: an unnamed proposed row stays proposed');
  assert.equal(pick(rows, deriveStatus(rows, {}).statuses).picked.id, '130');
  assert.match(fs.readFileSync(path.join(dir, 'agent-docs/roadmap/ROADMAP.md'), 'utf8'), /\| 130 \| Row 130 \| feature \| - \| not-started \| - \| pick \|/);
});

test('promote: no ids or a malformed id is usage (exit 2) and never prompts', (t) => {
  const dir = store(t, [row('130', { proposed: true })]);
  const a = asker(YES);
  assert.equal(handlePromoteCommand({ isTTY: true, ids: [], root: dir, gitFacts: FACTS, confirm: a.confirm, out: () => {}, err: () => {} }), 2);
  assert.equal(handlePromoteCommand({ isTTY: true, ids: ['../x'], root: dir, gitFacts: FACTS, confirm: a.confirm, out: () => {}, err: () => {} }), 2);
  assert.deepEqual(a.prompts, []);
});

test('promote without an interactive terminal on stdin is refused needs-person-tty before any prompt, whatever the reader would answer', (t) => {
  const dir = store(t, [row('130', { proposed: true })]);
  const before = rawRows(dir);
  const a = asker(YES);
  for (const isTTY of [false, undefined]) {
    const out = capture();
    const code = handlePromoteCommand({ ...(isTTY === undefined ? {} : { isTTY }), ids: ['130'], root: dir, json: true, gitFacts: FACTS, confirm: a.confirm, out: out.fn, err: out.fn });
    assert.equal(code, 1);
    assert.equal(JSON.parse(out.lines[0]).reason, 'needs-person-tty');
    assert.equal(JSON.parse(out.lines[0]).writes, 0);
  }
  assert.deepEqual(a.prompts, []);
  assert.equal(rawRows(dir), before);
});

test('promote does not read the autopilot switch: on, off, a sentinel, an unreadable file and an empty home give the same result', (t) => {
  const settingsOf = (home: string) => path.join(home, '.config/doflow/settings.json');
  const put = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
  const states: Array<[string, (home: string) => void]> = [
    ['on', (home) => put(settingsOf(home), JSON.stringify({ schema: 1, 'autopilot.enabled': 'on' }))],
    ['off', (home) => put(settingsOf(home), JSON.stringify({ schema: 1, 'autopilot.enabled': 'off' }))],
    ['sentinel', (home) => put(path.join(home, '.config/doflow/autopilot/off'), '')],
    ['unreadable', (home) => put(settingsOf(home), '{not json')],
    ['empty home', () => {}],
  ];
  for (const [name, setup] of states) {
    const home = tempDir(t, 'doflow-promote-home-');
    setup(home);
    const snapshot = () => (fs.existsSync(settingsOf(home)) ? fs.readFileSync(settingsOf(home), 'utf8') : null);
    const settingsBefore = snapshot();
    const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, DOFLOW_AUTOPILOT_ENABLED: process.env.DOFLOW_AUTOPILOT_ENABLED };
    process.env.HOME = home;
    process.env.XDG_CONFIG_HOME = path.join(home, '.config');
    if (name === 'on') process.env.DOFLOW_AUTOPILOT_ENABLED = 'on'; else delete process.env.DOFLOW_AUTOPILOT_ENABLED;
    try {
      const dir = store(t, [row('130', { proposed: true })]);
      const out = capture();
      assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: dir, json: true, gitFacts: FACTS, confirm: YES, out: out.fn, err: out.fn }), 0, name);
      assert.deepEqual(JSON.parse(out.lines[0]).promoted, ['130'], name);
      const refusedDir = store(t, [row('130', { proposed: true })]);
      const refused = capture();
      assert.equal(handlePromoteCommand({ isTTY: true, ids: ['130'], root: refusedDir, json: true, gitFacts: FACTS, confirm: () => 'n', out: refused.fn, err: refused.fn }), 1, name);
      assert.equal(JSON.parse(refused.lines[0]).reason, 'needs-person-confirm', name);
    } finally {
      for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
    assert.equal(snapshot(), settingsBefore, `${name}: the switch is not changed`);
  }
});

test('mutation: no flag, option or environment variable bypasses the prompt; the default reader tries /dev/tty and never stdin', (t) => {
  const dir = store(t, [row('130', { proposed: true })]);
  const before = rawRows(dir);
  const realOpen = fs.openSync;
  const realRead = fs.readSync;
  const seen: string[] = [];
  fs.openSync = ((p: any, ...rest: any[]) => { if (p === '/dev/tty') { seen.push('open'); throw Object.assign(new Error('ENXIO'), { code: 'ENXIO' }); } return (realOpen as any)(p, ...rest); }) as any;
  fs.readSync = ((fd: any, ...rest: any[]) => { if (fd === 0) seen.push('stdin'); return (realRead as any)(fd, ...rest); }) as any;
  const names = ['DOFLOW_YES', 'DOFLOW_PROMOTE_YES', 'DOFLOW_ASSUME_YES', 'DOFLOW_NON_INTERACTIVE', 'YES', 'CI'];
  const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
  t.after(() => {
    fs.openSync = realOpen; fs.readSync = realRead;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v as string; }
  });
  for (const n of names) process.env[n] = '1';
  const out = capture();
  const bypass: any = { yes: true, force: true, assumeYes: true, y: true, env: { ...process.env, DOFLOW_YES: '1' } };
  assert.equal(handlePromoteCommand({ ...bypass, isTTY: true, ids: ['130'], root: dir, json: true, gitFacts: FACTS, out: out.fn, err: out.fn }), 1);
  assert.equal(JSON.parse(out.lines[0]).reason, 'needs-person-confirm');
  assert.deepEqual(seen, ['open'], 'only /dev/tty was tried; stdin was never read for the answer');
  assert.equal(rawRows(dir), before);
  // the source declares no such switch either
  const source = fs.readFileSync(path.join(__dirname, '../../src/runtime/roadmap/seed.ts'), 'utf8');
  const promote = source.slice(source.indexOf('function readTtyAnswer'), source.indexOf('module.exports')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.equal(/process\.env|--yes|assumeYes|options\.yes|\byes\b\s*[,=:]/.test(promote), false, 'promote reads no environment variable and declares no yes option');
});

test('maint-thin: seed lands rows ready only with a terminal AND autopilot verifiably off; otherwise proposed, never refused', (t) => {
  const land = (isTTY: any, readSwitch: any) => {
    const dir = store(t, [row('130')]);
    const draft = path.join(dir, 'draft.json');
    fs.writeFileSync(draft, JSON.stringify({ schema: 1, rows: [row('131')] }));
    const out = capture();
    const code = handleSeedCommand({ ...(isTTY === undefined ? {} : { isTTY }), action: 'apply', draft, root: dir, json: true, gitFacts: FACTS, readSwitch, out: out.fn, err: out.fn });
    return { code, proposed: JSON.parse(out.lines[0]).proposed, stored: rowsOf(dir).find((r: any) => r.id === '131').proposed ?? null };
  };
  // no terminal, switch off: proposed (the redirect a model controls cannot land ready rows)
  assert.deepEqual(land(false, OFF), { code: 0, proposed: ['131'], stored: true });
  assert.deepEqual(land(undefined, OFF), { code: 0, proposed: ['131'], stored: true });
  // terminal, switch on: proposed
  assert.deepEqual(land(true, ON), { code: 0, proposed: ['131'], stored: true });
  // terminal and switch verifiably off: ready
  assert.deepEqual(land(true, OFF), { code: 0, proposed: [], stored: null });
});
