'use strict';

// B.3 — fingerprints, entries and settlements (IC-013) and the `failure` verb (IC-019), plus the
// overview's `failures` field. Every spawn runs under a scratch HOME and XDG_CONFIG_HOME (DEC-041).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const store = require('../../src/runtime/failure/store');
const { ROTATE_AT_BYTES } = require('../../src/runtime/failure/capture');
const { buildOverview } = require('../../src/runtime/lifecycle/overview');

const BIN = path.resolve(__dirname, '..', '..', 'bin', 'doflow.js');
const scratch = createScratch('doflow-failure-verb-');
after(() => scratch.remove());

let n = 0;
/** A scratch machine: its own HOME, XDG folder, failure home and a project folder. */
function machine(name) {
  const dir = path.join(scratch.dir, `${name}-${n++}`);
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const project = path.join(dir, 'project');
  for (const d of [home, xdg, project]) fs.mkdirSync(d, { recursive: true });
  const failures = path.join(xdg, 'doflow', 'failures');
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: '', GIT_CONFIG_GLOBAL: path.join(dir, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  const markDoflowRepo = () => fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: '@khoavu882/doflow' }));
  return { dir, home, xdg, project, failures, env, markDoflowRepo };
}

const LINE = {
  v: 1, at: '2026-10-03T10:00:00.000Z', source: 'cli', command: 'decision', harness: 'none', version: '1.14.0',
  project: '~/work/app', kind: 'TypeError', message: 'Cannot read properties of undefined (reading "...")',
  frame: 'src/runtime/decision-register.js:normalizeItem', exit: 1,
};
const line = (over = {}) => ({ ...LINE, ...over });

function writeEvents(m, lines, file = 'events.jsonl') {
  fs.mkdirSync(m.failures, { recursive: true });
  fs.writeFileSync(path.join(m.failures, file), lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
}

function run(m, args, { env = {}, cwd = m.project } = {}) {
  const result = spawnSync(process.execPath, [BIN, 'failure', ...args], { cwd, env: { ...m.env, ...env }, encoding: 'utf8', timeout: 60000 });
  let json = null;
  try { json = JSON.parse(result.stdout); } catch { /* text output */ }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, json };
}

const fpOf = (over) => store.fingerprint(line(over));

describe('fingerprint (IC-013)', () => {
  test('16 lower-case hex characters, stable', () => {
    assert.match(fpOf(), /^[0-9a-f]{16}$/);
    assert.equal(fpOf(), fpOf());
  });
  test('depends on source, command, kind, message and frame', () => {
    const base = fpOf();
    for (const over of [{ source: 'dispatcher' }, { command: 'verify' }, { kind: 'RangeError' }, { message: 'other' }, { frame: 'src/x.js:y' }, { frame: null }]) {
      assert.notEqual(fpOf(over), base, JSON.stringify(over));
    }
  });
  test('does not depend on version, time, project, harness or exit', () => {
    assert.equal(fpOf({ version: '9.9.9', at: '2027-01-01T00:00:00.000Z', project: '~/other', harness: 'codex', exit: 2 }), fpOf());
  });
  test('an absent frame hashes as an empty string', () => {
    const text = ['cli', 'decision', 'TypeError', 'm', ''].join('\n');
    const expected = require('node:crypto').createHash('sha256').update(text).digest('hex').slice(0, 16);
    assert.equal(store.fingerprint({ source: 'cli', command: 'decision', kind: 'TypeError', message: 'm', frame: null }), expected);
  });
});

describe('entries and statuses (IC-013)', () => {
  const events = (...overs) => overs.map((o) => line(o));
  const T = (n) => `2026-10-0${n}T10:00:00.000Z`;
  const settle = (as, at, extra = {}) => ({ at, fp: fpOf(), as, reason: 'r', followup: null, ...extra });

  test('no settlement: new, with the count and times derived from events', () => {
    const [entry] = store.foldEntries(events({ at: T(1) }, { at: T(3), version: '1.14.2', project: '~/work/site', harness: 'codex', exit: 2 }, { at: T(2) }), []);
    assert.equal(entry.status, 'new');
    assert.equal(entry.count, 3);
    assert.equal(entry.sinceSettlement, 3);
    assert.deepEqual([entry.firstSeen, entry.lastSeen], [T(1), T(3)]);
    assert.deepEqual([entry.firstVersion, entry.lastVersion], ['1.14.0', '1.14.2']);
    assert.deepEqual(entry.harnesses, ['codex', 'none']);
    assert.deepEqual(entry.exitCodes, [1, 2]);
    assert.deepEqual(entry.projects, ['~/work/site', '~/work/app']);
    assert.equal(entry.settlement, null);
  });
  test('noise stays noise whatever follows', () => {
    const [entry] = store.foldEntries(events({ at: T(1) }, { at: T(5) }), [settle('noise', T(2))]);
    assert.equal(entry.status, 'noise');
    assert.equal(entry.sinceSettlement, 1);
  });
  test('fixed with no later event is fixed; one later event makes it regressed', () => {
    assert.equal(store.foldEntries(events({ at: T(1) }), [settle('fixed', T(2))])[0].status, 'fixed');
    const [regressed] = store.foldEntries(events({ at: T(1) }, { at: T(3) }), [settle('fixed', T(2))]);
    assert.equal(regressed.status, 'regressed');
    assert.equal(regressed.count, 2);
    assert.equal(regressed.sinceSettlement, 1);
  });
  test('imported stays imported', () => {
    const [entry] = store.foldEntries(events({ at: T(1) }, { at: T(5) }), [settle('imported', T(2), { followup: 'FU-abc234' })]);
    assert.equal(entry.status, 'imported');
    assert.equal(entry.settlement.followup, 'FU-abc234');
  });
  test('the latest settlement applies', () => {
    const [entry] = store.foldEntries(events({ at: T(1) }), [settle('noise', T(2)), settle('fixed', T(3))]);
    assert.equal(entry.status, 'fixed');
  });
  test('projects keeps the five most recent distinct values, newest first', () => {
    const many = [1, 2, 3, 4, 5, 6, 7].map((i) => line({ at: `2026-10-03T10:00:0${i}.000Z`, project: `~/p${i}` }));
    many.push(line({ at: '2026-10-03T10:00:09.000Z', project: '~/p3' }));
    assert.deepEqual(store.foldEntries(many, [])[0].projects, ['~/p3', '~/p7', '~/p6', '~/p5', '~/p4']);
  });
  test('different fingerprints are different entries, newest lastSeen first', () => {
    const entries = store.foldEntries(events({ at: T(1) }, { at: T(2), kind: 'RangeError' }), []);
    assert.deepEqual(entries.map((e) => e.kind), ['RangeError', 'TypeError']);
  });
});

describe('print-safe output', () => {
  // ESC, BEL, a clear-screen, a right-to-left override, an isolate, an RLM and a C1 control.
  const HOSTILE = 'm\u001b]0;pwned\u0007n\u001b[2Jo\u202ep\u2067q\u200fr\u009bs';
  const UNSAFE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u061C\u200E\u200F\u202A-\u202E\u2066-\u2069\u2028\u2029]/;
  test('a forged failure line prints clean in list, text and json, and the fingerprint is the stored text\'s', () => {
    const m = machine('hostile');
    const forged = line({ message: HOSTILE, project: `~/p${HOSTILE}`, kind: `K${HOSTILE}` });
    writeEvents(m, [forged]);
    const text = run(m, ['--action', 'list']);
    const json = run(m, ['--action', 'list', '--json']);
    for (const r of [text, json]) {
      assert.equal(r.status, 0, r.stderr);
      assert.equal(UNSAFE.test(r.stdout), false, JSON.stringify(r.stdout));
    }
    assert.match(text.stdout, /Km\uFFFD\]0;pwned\uFFFDn\uFFFD\[2Jo\uFFFDp/);
    assert.equal(json.json.entries[0].fp, store.fingerprint(forged), 'a settlement made before this change still matches');
    assert.equal(UNSAFE.test(JSON.stringify(json.json)), false);
    const all = run(m, ['--action', 'list', '--all', '--json']);
    assert.equal(UNSAFE.test(JSON.stringify(all.json)), false);
  });
  test('the overview in the DoFlow repository prints a forged failure clean', () => {
    const m = machine('hostile-overview');
    m.markDoflowRepo();
    writeEvents(m, [line({ message: HOSTILE })]);
    const r = spawnSync(process.execPath, [BIN, 'lifecycle', '--maintain'], { cwd: m.project, env: m.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /failures: 1 new or regressed/);
    assert.equal(UNSAFE.test(r.stdout), false, JSON.stringify(r.stdout));
  });
});

describe('reading the files (IC-015)', () => {
  test('rotated files are read oldest first, then the live file; bad lines are skipped and counted', () => {
    const m = machine('read');
    writeEvents(m, [line({ at: '2026-10-01T00:00:00.000Z', kind: 'A1' })], 'events-20261001T000000Z-1.jsonl');
    writeEvents(m, [line({ at: '2026-10-02T00:00:00.000Z', kind: 'A2' }), 'not json', '{"v":1}', JSON.stringify({ ...line(), source: 'elsewhere' })], 'events-20261002T000000Z-1.jsonl');
    writeEvents(m, [line({ at: '2026-10-03T00:00:00.000Z', kind: 'A3' }), '{"truncated'], 'events.jsonl');
    const { events, skippedLines } = store.readEvents(m.failures);
    assert.deepEqual(events.map((e) => e.kind), ['A1', 'A2', 'A3']);
    assert.equal(skippedLines, 4);
  });
  test('a missing folder reads as empty', () => {
    const m = machine('empty');
    assert.deepEqual(store.readEvents(m.failures), { events: [], skippedLines: 0, unreadable: [] });
    assert.equal(fs.existsSync(m.failures), false, 'reading creates nothing');
  });
});

describe('a FIFO at the failure file', { skip: process.platform === 'win32' }, () => {
  test('list reports the file unreadable at once, in text and json; nothing is read from it', () => {
    const m = machine('fifo');
    fs.mkdirSync(m.failures, { recursive: true });
    spawnSync('mkfifo', [path.join(m.failures, 'events.jsonl')]);
    const started = Date.now();
    const json = run(m, ['--action', 'list', '--json']);
    const text = run(m, ['--action', 'list']);
    assert.ok(Date.now() - started < 10000);
    assert.equal(json.status, 0, json.stderr);
    assert.deepEqual([json.json.unreadable, json.json.entries], [['events.jsonl'], []]);
    assert.match(text.stdout, /unreadable failure files \(not read\): events\.jsonl/);
  });
  test('a symlink to /dev/zero at the failure file is unreadable too', () => {
    const m = machine('zero');
    fs.mkdirSync(m.failures, { recursive: true });
    fs.symlinkSync('/dev/zero', path.join(m.failures, 'events.jsonl'));
    assert.deepEqual(run(m, ['--action', 'list', '--json']).json.unreadable, ['events.jsonl']);
  });
  test('a missing file is simply empty, not unreadable', () => {
    assert.deepEqual(run(machine('missing'), ['--action', 'list', '--json']).json.unreadable, []);
  });
});

describe('failure --action list', () => {
  test('an empty store: exit 0, empty list, capture on, nothing created', () => {
    const m = machine('list-empty');
    const r = run(m, ['--action', 'list', '--json']);
    assert.equal(r.status, 0);
    assert.deepEqual(r.json, { ok: true, action: 'list', capture: 'on', entries: [], counts: { new: 0, regressed: 0, noise: 0, fixed: 0, imported: 0 }, skippedLines: 0, unreadable: [], next: [] });
    assert.equal(fs.existsSync(m.failures), false);
  });
  test('shows new and regressed entries by default and every status with --all', () => {
    const m = machine('list-all');
    const noisy = { kind: 'RangeError' };
    const fixed = { kind: 'ReferenceError' };
    writeEvents(m, [line(), line({ at: '2026-10-04T10:00:00.000Z' }), line(noisy), line(fixed)]);
    fs.writeFileSync(path.join(m.failures, 'settlements.jsonl'), [
      { v: 1, at: '2026-10-05T00:00:00.000Z', fp: fpOf(noisy), as: 'noise', reason: 'expected', followup: null },
      { v: 1, at: '2026-10-05T00:00:00.000Z', fp: fpOf(fixed), as: 'fixed', reason: 'guarded', followup: null },
    ].map((s) => JSON.stringify(s)).join('\n') + '\n');
    const byDefault = run(m, ['--action', 'list', '--json']);
    assert.deepEqual(byDefault.json.entries.map((e) => e.status), ['new']);
    assert.equal(byDefault.json.entries[0].count, 2);
    assert.deepEqual(byDefault.json.counts, { new: 1, regressed: 0, noise: 1, fixed: 1, imported: 0 });
    assert.deepEqual(Object.keys(byDefault.json.entries[0]), ['fp', 'status', 'count', 'command', 'kind', 'message', 'lastSeen', 'lastVersion']);
    assert.match(byDefault.json.next[0], /^Settle each entry: doflow-run failure --action settle --fp <fp>/);
    const all = run(m, ['--action', 'list', '--all', '--json']);
    assert.deepEqual(all.json.entries.map((e) => e.status).sort(), ['fixed', 'new', 'noise']);
  });
  test('reports capture off when the sentinel exists, and still reads', () => {
    const m = machine('list-off');
    writeEvents(m, [line()]);
    fs.writeFileSync(path.join(m.failures, 'off'), 'x');
    const r = run(m, ['--action', 'list', '--json']);
    assert.equal(r.json.capture, 'off');
    assert.equal(r.json.entries.length, 1);
  });
  test('rotates the live file at 1 MiB before it reads', () => {
    const m = machine('list-rotate');
    fs.mkdirSync(m.failures, { recursive: true });
    const live = path.join(m.failures, 'events.jsonl');
    fs.writeFileSync(live, `${JSON.stringify(line())}\n`);
    fs.appendFileSync(live, 'x'.repeat(ROTATE_AT_BYTES));
    const r = run(m, ['--action', 'list', '--json']);
    assert.equal(r.status, 0);
    assert.equal(r.json.entries.length, 1);
    assert.equal(fs.existsSync(live), false);
    assert.equal(fs.readdirSync(m.failures).filter((f) => /^events-.*\.jsonl$/.test(f)).length, 1);
  });
  test('with HOME unset and no XDG_CONFIG_HOME: home null, exit 0, empty lists', () => {
    const m = machine('list-nohome');
    const env = { ...m.env };
    delete env.HOME;
    delete env.XDG_CONFIG_HOME;
    const result = spawnSync(process.execPath, [BIN, 'failure', '--action', 'list', '--json'], { cwd: m.project, env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    const json = JSON.parse(result.stdout);
    assert.equal(json.home, null);
    assert.deepEqual(json.entries, []);
  });
  test('text output names the entry and the next step', () => {
    const m = machine('list-text');
    writeEvents(m, [line()]);
    const r = run(m, ['--action', 'list']);
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes(fpOf()));
    assert.match(r.stdout, /next: Settle each entry/);
  });
  test('-g is ignored', () => {
    const m = machine('list-global');
    writeEvents(m, [line()]);
    const r = run(m, ['--action', 'list', '-g', '--json']);
    assert.equal(r.status, 0);
    assert.equal(r.json.entries.length, 1);
  });
});

describe('failure --action settle', () => {
  test('usage errors exit 2 and write nothing', () => {
    const m = machine('settle-usage');
    writeEvents(m, [line()]);
    const fp = fpOf();
    for (const args of [
      ['--action', 'settle'],
      ['--action', 'settle', '--fp', 'zzzz', '--as', 'noise', '--reason', 'r'],
      ['--action', 'settle', '--fp', fp],
      ['--action', 'settle', '--fp', fp, '--as', 'ignored', '--reason', 'r'],
      ['--action', 'settle', '--fp', fp, '--as', 'noise'],
      ['--action', 'settle', '--fp', fp, '--as', 'fixed'],
      ['--action', 'settle', '--fp', fp, '--as', 'noise', '--reason', 'two\nlines'],
      ['--action', 'bogus'],
      [],
    ]) {
      const r = run(m, [...args, '--json']);
      assert.equal(r.status, 2, args.join(' '));
      assert.equal(r.json.status, 'USAGE');
    }
    assert.equal(fs.existsSync(path.join(m.failures, 'settlements.jsonl')), false);
  });
  test('an unknown fingerprint is refused with exit 1 and writes nothing', () => {
    const m = machine('settle-unknown');
    writeEvents(m, [line()]);
    const r = run(m, ['--action', 'settle', '--fp', '0123456789abcdef', '--as', 'noise', '--reason', 'r', '--json']);
    assert.equal(r.status, 1);
    assert.equal(r.json.finding, 'unknown-fp');
    assert.match(r.json.message, /Nothing was written\.$/);
    assert.equal(fs.existsSync(path.join(m.failures, 'settlements.jsonl')), false);
  });
  test('noise: written, listed no more by default, and a masked reason is stored', () => {
    const m = machine('settle-noise');
    writeEvents(m, [line()]);
    const secret = `npm_${'a1B2'.repeat(9)}`;
    const r = run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'noise', '--reason', `expected on CI ${secret}`, '--json']);
    assert.equal(r.status, 0);
    assert.deepEqual([r.json.action, r.json.as, r.json.followup], ['settle', 'noise', null]);
    const stored = fs.readFileSync(path.join(m.failures, 'settlements.jsonl'), 'utf8');
    assert.ok(!stored.includes(secret));
    assert.deepEqual(Object.keys(JSON.parse(stored)), ['v', 'at', 'fp', 'as', 'reason', 'followup']);
    assert.equal(run(m, ['--action', 'list', '--json']).json.entries.length, 0);
    assert.equal(run(m, ['--action', 'list', '--all', '--json']).json.entries[0].status, 'noise');
  });
  test('fixed hides the entry, and the same failure seen again is regressed and listed again', () => {
    const m = machine('settle-fixed');
    writeEvents(m, [line({ at: '2026-10-01T00:00:00.000Z' })]);
    assert.equal(run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'fixed', '--reason', 'guarded since 1.14.1', '--json']).status, 0);
    assert.equal(run(m, ['--action', 'list', '--json']).json.entries.length, 0);
    fs.appendFileSync(path.join(m.failures, 'events.jsonl'), `${JSON.stringify(line({ at: '2999-01-01T00:00:00.000Z', version: '1.14.2' }))}\n`);
    const again = run(m, ['--action', 'list', '--json']);
    assert.deepEqual(again.json.entries.map((e) => [e.status, e.count, e.lastVersion]), [['regressed', 2, '1.14.2']]);
    assert.equal(again.json.counts.regressed, 1);
  });
  test('imported is refused outside the DoFlow repository', () => {
    const m = machine('settle-import-no');
    writeEvents(m, [line()]);
    fs.writeFileSync(path.join(m.project, 'package.json'), JSON.stringify({ name: 'some-app' }));
    const r = run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']);
    assert.equal(r.status, 1);
    assert.equal(r.json.finding, 'not-doflow-repo');
    assert.equal(fs.existsSync(path.join(m.failures, 'settlements.jsonl')), false);
    assert.equal(fs.existsSync(path.join(m.project, '.doflow', 'state', 'lifecycle')), false, 'no store folder is left behind');
  });
  test('imported in the DoFlow repository creates a follow-up and records its id', () => {
    const m = machine('settle-import');
    m.markDoflowRepo();
    writeEvents(m, [line()]);
    const r = run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.json.followup.statement, 'DoFlow decision TypeError: Cannot read properties of undefined (reading "...")');
    assert.deepEqual(r.json.followup.source, { kind: 'failure', ref: fpOf() });
    assert.equal(r.json.followup.state, 'open');
    assert.match(r.json.followup.id, /^FU-[0-9a-hjkmnp-tv-z]{6}$/);
    assert.equal(r.json.events.length, 1);
    assert.match(r.json.events[0], /^\.doflow\/state\/lifecycle\/events\/\d{8}T\d{9}Z-[0-9a-z]{6}\.json$/);
    const event = JSON.parse(fs.readFileSync(path.join(m.project, r.json.events[0]), 'utf8'));
    assert.equal(event.type, 'followup.added');
    assert.equal(event.by, 'agent');
    assert.deepEqual(event.data, { id: r.json.followup.id, statement: r.json.followup.statement, source: { kind: 'failure', ref: fpOf() } });
    const settlement = JSON.parse(fs.readFileSync(path.join(m.failures, 'settlements.jsonl'), 'utf8').trim());
    assert.deepEqual([settlement.as, settlement.followup], ['imported', r.json.followup.id]);
    // The follow-up is a normal open item, and the entry is no longer listed by default.
    const list = spawnSync(process.execPath, [BIN, 'followup', '--action', 'list', '--json'], { cwd: m.project, env: m.env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(list.stdout).items.map((i) => i.id), [r.json.followup.id]);
    assert.equal(run(m, ['--action', 'list', '--json']).json.entries.length, 0);
  });
  test('imported copies an old agent-docs/lifecycle store first and adds the follow-up beside it', () => {
    const m = machine('settle-import-legacy');
    m.markDoflowRepo();
    writeEvents(m, [line()]);
    const legacy = path.join(m.project, 'agent-docs', 'lifecycle', 'events');
    fs.mkdirSync(legacy, { recursive: true });
    const old = { v: 1, id: '20261001T000000000Z-aaaaaa', type: 'followup.added', at: '2026-10-01T00:00:00.000Z', by: 'agent', data: { id: 'FU-aaaaaa', statement: 'from the old store', source: { kind: 'manual' } } };
    fs.writeFileSync(path.join(legacy, `${old.id}.json`), JSON.stringify(old));
    const r = run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /^doflow failure: note: the lifecycle store is now \.doflow\/state\/lifecycle\/events; agent-docs\/lifecycle\/ is no longer read and can be deleted$/m);
    const events = fs.readdirSync(path.join(m.project, '.doflow', 'state', 'lifecycle', 'events')).sort();
    assert.deepEqual(events, [`${old.id}.json`, path.basename(r.json.events[0])].sort());
    const list = spawnSync(process.execPath, [BIN, 'followup', '--action', 'list', '--json'], { cwd: m.project, env: m.env, encoding: 'utf8' });
    assert.deepEqual(JSON.parse(list.stdout).items.map((i) => i.id).sort(), ['FU-aaaaaa', r.json.followup.id].sort());
    assert.deepEqual(fs.readdirSync(legacy), [`${old.id}.json`], 'the old folder is unchanged');
  });
  test('imported refuses with store-locked when the project store cannot be locked, and records no settlement', () => {
    const m = machine('settle-import-locked');
    m.markDoflowRepo();
    writeEvents(m, [line()]);
    const preload = path.join(m.dir, 'locked-preload.js');
    fs.writeFileSync(preload, `const store = require(${JSON.stringify(path.resolve(__dirname, '..', '..', 'src', 'runtime', 'lifecycle', 'event-store'))});
store.readFold = () => { throw new store.StoreLockedError("Could not lock 'events' after 5s. Nothing was written."); };
`);
    const r = spawnSync(process.execPath, ['-r', preload, BIN, 'failure', '--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json'], { cwd: m.project, env: m.env, encoding: 'utf8' });
    assert.equal(r.status, 1, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { ok: false, action: 'settle', finding: 'store-locked', message: "Could not lock 'events' after 5s. Nothing was written." });
    assert.equal(fs.existsSync(path.join(m.failures, 'settlements.jsonl')), false);
  });
  test('the statement of an entry with no message has no trailing colon, and is cut to 280 characters', () => {
    const { importedStatement } = require('../../src/runtime/failure/cli');
    assert.equal(importedStatement({ command: 'mcp-tool-guard', kind: 'policy-file-missing', message: '' }), 'DoFlow mcp-tool-guard policy-file-missing');
    assert.equal(importedStatement({ command: 'x', kind: 'TypeError', message: 'm'.repeat(500) }).length, 280);
    assert.equal(importedStatement({ command: 'x', kind: 'TypeError', message: 'a\nb\u202Ec' }), 'DoFlow x TypeError: a b c');
  });
  test('a second import of one fingerprint is refused and creates no second follow-up', () => {
    const m = machine('settle-import-twice');
    m.markDoflowRepo();
    writeEvents(m, [line()]);
    assert.equal(run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']).status, 0);
    const second = run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']);
    assert.equal(second.status, 1);
    assert.equal(second.json.finding, 'already-imported');
    assert.equal(fs.readdirSync(path.join(m.project, '.doflow', 'state', 'lifecycle', 'events')).length, 1);
  });
  test('with no resolvable home it reports home null and exits 0', () => {
    const m = machine('settle-nohome');
    const env = { ...m.env };
    delete env.HOME;
    delete env.XDG_CONFIG_HOME;
    const result = spawnSync(process.execPath, [BIN, 'failure', '--action', 'settle', '--fp', '0123456789abcdef', '--as', 'noise', '--reason', 'r', '--json'], { cwd: m.project, env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).home, null);
  });
});

describe('failure --action capture', () => {
  test('status: on by default, and reading it creates nothing', () => {
    const m = machine('capture-status');
    const r = run(m, ['--action', 'capture', '--json']);
    assert.deepEqual(r.json, { ok: true, action: 'capture', effective: 'on', sentinel: false, env: null });
    assert.equal(fs.existsSync(m.failures), false);
  });
  test('--set off creates the sentinel holding the time, --set on removes it', () => {
    const m = machine('capture-set');
    const off = run(m, ['--action', 'capture', '--set', 'off', '--json']);
    assert.deepEqual(off.json, { ok: true, action: 'capture', effective: 'off', sentinel: true, env: null });
    assert.match(fs.readFileSync(path.join(m.failures, 'off'), 'utf8'), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z\n$/);
    assert.equal(run(m, ['--action', 'capture', '--json']).json.effective, 'off');
    const on = run(m, ['--action', 'capture', '--set', 'on', '--json']);
    assert.deepEqual(on.json, { ok: true, action: 'capture', effective: 'on', sentinel: false, env: null });
    assert.equal(fs.existsSync(path.join(m.failures, 'off')), false);
    assert.equal(run(m, ['--action', 'capture', '--set', 'on', '--json']).status, 0, 'switching on twice is fine');
  });
  test('the environment turns it off but cannot turn it on over the sentinel', () => {
    const m = machine('capture-env');
    assert.deepEqual(run(m, ['--action', 'capture', '--json'], { env: { DOFLOW_FAILURE_CAPTURE: 'off' } }).json,
      { ok: true, action: 'capture', effective: 'off', sentinel: false, env: 'off' });
    run(m, ['--action', 'capture', '--set', 'off']);
    assert.deepEqual(run(m, ['--action', 'capture', '--json'], { env: { DOFLOW_FAILURE_CAPTURE: 'on' } }).json,
      { ok: true, action: 'capture', effective: 'off', sentinel: true, env: 'on' });
  });
  test('an invalid --set is a usage error', () => {
    const m = machine('capture-bad');
    assert.equal(run(m, ['--action', 'capture', '--set', 'maybe', '--json']).status, 2);
    assert.equal(fs.existsSync(m.failures), false);
  });
  test('with no resolvable home it reports home null and changes nothing', () => {
    const m = machine('capture-nohome');
    const env = { ...m.env };
    delete env.HOME;
    delete env.XDG_CONFIG_HOME;
    const result = spawnSync(process.execPath, [BIN, 'failure', '--action', 'capture', '--set', 'off', '--json'], { cwd: m.project, env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).home, null);
  });
});

describe('overview failures field (IC-007)', () => {
  const overview = (m, options) => {
    const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME, CAP: process.env.DOFLOW_FAILURE_CAPTURE };
    process.env.HOME = m.home;
    process.env.XDG_CONFIG_HOME = m.xdg;
    delete process.env.DOFLOW_FAILURE_CAPTURE;
    try { return buildOverview({ root: m.project, ...options }); } finally {
      for (const [key, value] of [['HOME', saved.HOME], ['XDG_CONFIG_HOME', saved.XDG], ['DOFLOW_FAILURE_CAPTURE', saved.CAP]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  };

  test('maintain mode in the DoFlow repository lists the new and regressed entries only', () => {
    const m = machine('ov-doflow');
    m.markDoflowRepo();
    const settledNoise = { kind: 'RangeError' };
    writeEvents(m, [line(), line(settledNoise)]);
    fs.writeFileSync(path.join(m.failures, 'settlements.jsonl'), `${JSON.stringify({ v: 1, at: '2026-10-05T00:00:00.000Z', fp: fpOf(settledNoise), as: 'noise', reason: 'r', followup: null })}\n`);
    const result = overview(m, { maintain: true });
    assert.deepEqual(result.failures.map((e) => [e.fp, e.status]), [[fpOf(), 'new']]);
    assert.ok(result.next.some((l) => l.startsWith('Settle a failure entry: doflow-run failure --action settle --fp <fp>')));
  });
  test('maintain mode in the DoFlow repository with no failures is an empty list', () => {
    const m = machine('ov-doflow-empty');
    m.markDoflowRepo();
    const result = overview(m, { maintain: true });
    assert.deepEqual(result.failures, []);
    assert.ok(!result.next.some((l) => l.includes('failure --action')));
  });
  test('discovery mode and any other project give null', () => {
    const doflow = machine('ov-discovery');
    doflow.markDoflowRepo();
    writeEvents(doflow, [line()]);
    assert.equal(overview(doflow, { maintain: false }).failures, null);
    const other = machine('ov-other');
    fs.writeFileSync(path.join(other.project, 'package.json'), JSON.stringify({ name: 'some-app' }));
    writeEvents(other, [line()]);
    assert.equal(overview(other, { maintain: true }).failures, null);
    const bare = machine('ov-nopkg');
    assert.equal(overview(bare, { maintain: true }).failures, null);
  });
  test('the overview writes nothing and never rotates the failure files', () => {
    const m = machine('ov-readonly');
    m.markDoflowRepo();
    fs.mkdirSync(m.failures, { recursive: true });
    const live = path.join(m.failures, 'events.jsonl');
    fs.writeFileSync(live, `${JSON.stringify(line())}\n${'x'.repeat(ROTATE_AT_BYTES)}`);
    overview(m, { maintain: true });
    assert.deepEqual(fs.readdirSync(m.failures), ['events.jsonl']);
    assert.equal(fs.existsSync(path.join(m.project, '.doflow', 'state', 'lifecycle')), false);
  });
});

describe('overview text form lists failures', () => {
  const text = (m, args) => spawnSync(process.execPath, [BIN, 'lifecycle', ...args], { cwd: m.project, env: m.env, encoding: 'utf8' });

  test('maintain text in the DoFlow repository prints the failures and the settle next line', () => {
    const m = machine('ov-text');
    m.markDoflowRepo();
    writeEvents(m, [line()]);
    const r = text(m, ['--maintain']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^failures: 1 new or regressed$/m);
    assert.ok(r.stdout.includes(`  ${fpOf()}  new  x1  decision TypeError: Cannot read properties of undefined (reading "...")  (last seen 2026-10-03T10:00:00.000Z, 1.14.0)`));
    assert.match(r.stdout, /^next: Settle a failure entry: doflow-run failure --action settle --fp <fp>/m);
  });
  test('discovery text and other projects print no failures line', () => {
    const m = machine('ov-text-none');
    m.markDoflowRepo();
    writeEvents(m, [line()]);
    assert.ok(!/failures:/.test(text(m, []).stdout));
    const other = machine('ov-text-other');
    writeEvents(other, [line()]);
    assert.ok(!/failures:/.test(text(other, ['--maintain']).stdout));
  });
});

describe('import dedupe and no-home text (review fixes)', () => {
  const follow = (m) => JSON.parse(spawnSync(process.execPath, [BIN, 'followup', '--action', 'list', '--state', 'all', '--json'], { cwd: m.project, env: m.env, encoding: 'utf8' }).stdout).items;

  test('import, settle as noise, import again: the second import is refused and exactly one follow-up exists', () => {
    const m = machine('dedupe');
    m.markDoflowRepo();
    writeEvents(m, [line()]);
    assert.equal(run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']).status, 0);
    assert.equal(run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'noise', '--reason', 'seen it', '--json']).status, 0);
    const again = run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']);
    assert.equal(again.status, 1);
    assert.equal(again.json.finding, 'already-imported');
    assert.equal(follow(m).filter((i) => i.source.kind === 'failure').length, 1);
  });

  test('a failure between the settlement and the follow-up leaves no duplicate on retry', () => {
    const m = machine('dedupe-retry');
    m.markDoflowRepo();
    writeEvents(m, [line()]);
    // The events folder cannot be created while a file sits where its parent should be.
    fs.mkdirSync(path.join(m.project, '.doflow', 'state'), { recursive: true });
    fs.writeFileSync(path.join(m.project, '.doflow', 'state', 'lifecycle'), 'in the way');
    const failed = run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']);
    assert.notEqual(failed.status, 0, 'the follow-up write failed');
    fs.rmSync(path.join(m.project, '.doflow', 'state', 'lifecycle'));
    const retry = run(m, ['--action', 'settle', '--fp', fpOf(), '--as', 'imported', '--json']);
    assert.equal(retry.status, 0, retry.stderr + retry.stdout);
    assert.equal(follow(m).filter((i) => i.source.kind === 'failure').length, 1);
    const settlements = fs.readFileSync(path.join(m.failures, 'settlements.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(settlements[settlements.length - 1].followup, retry.json.followup.id, 'the last settlement names the follow-up that exists');
  });

  const noHome = (m) => { const env = { ...m.env }; delete env.HOME; delete env.XDG_CONFIG_HOME; return env; };

  test('text mode without a resolvable home says so and reports capture off, for list, capture and settle', () => {
    const m = machine('nohome-text');
    for (const args of [['--action', 'list'], ['--action', 'capture'], ['--action', 'settle', '--fp', '0123456789abcdef', '--as', 'noise', '--reason', 'r']]) {
      const r = spawnSync(process.execPath, [BIN, 'failure', ...args], { cwd: m.project, env: noHome(m), encoding: 'utf8' });
      assert.equal(r.status, 0, args.join(' '));
      assert.match(r.stdout, /^home: none \(capture skipped\)$/m, args.join(' '));
      assert.ok(!/capture on/.test(r.stdout), args.join(' '));
    }
    const list = spawnSync(process.execPath, [BIN, 'failure', '--action', 'list', '--json'], { cwd: m.project, env: noHome(m), encoding: 'utf8' });
    assert.deepEqual([JSON.parse(list.stdout).home, JSON.parse(list.stdout).capture], [null, 'off']);
    const cap = spawnSync(process.execPath, [BIN, 'failure', '--action', 'capture', '--json'], { cwd: m.project, env: noHome(m), encoding: 'utf8' });
    assert.deepEqual([JSON.parse(cap.stdout).home, JSON.parse(cap.stdout).effective], [null, 'off']);
  });
});
