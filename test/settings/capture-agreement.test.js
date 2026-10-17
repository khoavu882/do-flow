'use strict';

// Feature 086, task A.2: the four readers of `failure.capture` agree at 2.0. Capture is read by four
// separate pieces of code: the bash dispatcher (bin/doflow-run, capture_failure_write), the bash
// policy helper (policies/capture-failure.sh, doflow_capture_failure), the JS hook runner
// (stream-hook-runner.js, captureHookFailure) and Node (failure/home.ts, captureIsOff). Each row of
// the table below sets an environment and a sentinel, asks every reader whether capture is on, and
// requires one answer, equal to the 2.0 value pinned by C17-C20 in compat-matrix.test.js. The three
// writers answer by whether they append a line to the events file; Node answers with captureIsOff.
//
// policies/lib.sh holds no capture reader (it only resolves the config home), so the "policy path"
// reader is capture-failure.sh, the helper the guard policies call.
//
// Bash runs as /bin/bash (3.2.57 on macOS) with an explicit environment; nothing reads the real home.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createSettingsEnv, REPO } = require('../helper/settings-fixtures');
const { failureHome, captureIsOff } = require('../../src/runtime/failure/home.ts');

const POSIX = process.platform !== 'win32';
const BASH = '/bin/bash';
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const POLICY_HELPER = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'capture-failure.sh');
const RUNNER = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'stream-hook-runner.js');

/** The two functions of the dispatcher that make up its capture reader, cut from the shipped file. */
function dispatcherFunctions() {
  const lines = fs.readFileSync(DISPATCHER, 'utf8').split('\n');
  const out = [];
  for (const name of ['capture_failure_write', 'capture_failure']) {
    const start = lines.findIndex((line) => line === `${name}() {`);
    assert.notEqual(start, -1, `${name} is defined in doflow-run`);
    const end = lines.findIndex((line, i) => i > start && line === '}');
    assert.notEqual(end, -1, `${name} ends`);
    out.push(...lines.slice(start, end + 1), '');
  }
  return `CAPTURE_VERB=""\n${out.join('\n')}`;
}

// `word` undefined leaves DOFLOW_FAILURE_CAPTURE unset; `xdg` is 'absolute' (XDG_CONFIG_HOME set to
// the fixture folder) or 'unset' (the home falls back to $HOME/.config); `sentinel` puts the
// failures/off file where that row's readers look; `off` is the 2.0 answer (C17-C20).
const ROWS = [];
for (const xdg of ['absolute', 'unset']) {
  ROWS.push({ name: 'unset, no sentinel', xdg, word: undefined, sentinel: false, off: false });
  ROWS.push({ name: 'unset, sentinel', xdg, word: undefined, sentinel: true, off: true });
  ROWS.push({ name: 'on, sentinel (env cannot turn a sentinel on)', xdg, word: 'on', sentinel: true, off: true });
  ROWS.push({ name: 'off, sentinel', xdg, word: 'off', sentinel: true, off: true });
  for (const word of ['off', 'OFF', ' off ', '0', '  0\t', 'false', 'No']) {
    ROWS.push({ name: `word ${JSON.stringify(word)}`, xdg, word, sentinel: false, off: true });
  }
  for (const word of ['maybe', 'on', '1', 'true', 'offf', '']) {
    ROWS.push({ name: `word ${JSON.stringify(word)}`, xdg, word, sentinel: false, off: false });
  }
}

/** A fresh fixture for one row: its environment, the failures home and the events file. */
function rowEnv(t, row) {
  const f = createSettingsEnv(t, { prefix: 'doflow-capture-agreement-' });
  const env = { PATH: process.env.PATH, HOME: f.home };
  if (row.xdg === 'absolute') env.XDG_CONFIG_HOME = f.xdg;
  if (row.word !== undefined) env.DOFLOW_FAILURE_CAPTURE = row.word;
  const home = failureHome(env);
  assert.equal(home, row.xdg === 'absolute' ? f.failuresDir : path.join(f.home, '.config', 'doflow', 'failures'));
  if (row.sentinel) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'off'), 'off\n');
  }
  return { f, env, home, events: path.join(home, 'events.jsonl') };
}

const wrote = (events) => fs.existsSync(events) && fs.readFileSync(events, 'utf8').trim().length > 0;

/** The readers. Each takes the row's setup and returns true when capture is OFF for it. */
const READERS = {
  'bash dispatcher (doflow-run)'({ f, env, events }) {
    const script = `set -euo pipefail\n${dispatcherFunctions()}\ncapture_failure dispatcher probe-kind 2`;
    const r = spawnSync(BASH, ['-c', script], { cwd: f.project, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return !wrote(events);
  },
  'bash policy helper (capture-failure.sh)'({ f, env, events }) {
    const r = spawnSync(BASH, ['-c', 'set -uo pipefail; . "$1"; doflow_capture_failure pre-bash-guard patterns-missing', 'x', POLICY_HELPER],
      { cwd: f.project, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return !wrote(events);
  },
  'JS hook runner (stream-hook-runner.js)'({ f, env, events }) {
    const code = `process.stdout.write(String(require(${JSON.stringify(RUNNER)}).captureHookFailure({ command: 'probe', kind: 'probe-kind' })))`;
    const r = spawnSync(process.execPath, ['-e', code], { cwd: f.project, env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout === 'true', wrote(events), 'the runner reports a write exactly when a line is there');
    return !wrote(events);
  },
  'Node captureIsOff (failure/home.ts)'({ env, home }) {
    return captureIsOff(home, env);
  },
};

/** Runs every reader over every row (fresh fixture per reader and row); returns the disagreements. */
function disagreements(readers, rows, t) {
  const found = [];
  for (const row of rows) {
    const answers = {};
    for (const [name, read] of Object.entries(readers)) answers[name] = read(rowEnv(t, row));
    const distinct = new Set(Object.values(answers));
    if (distinct.size !== 1 || !distinct.has(row.off)) found.push({ row: `${row.xdg} xdg: ${row.name}`, expected: row.off, answers });
  }
  return found;
}

test('the four capture readers give one on/off answer on every row, equal to the 2.0 value', { skip: !POSIX }, (t) => {
  assert.equal(Object.keys(READERS).length, 4);
  const found = disagreements(READERS, ROWS, t);
  assert.deepEqual(found, [], `readers disagree: ${JSON.stringify(found, null, 1)}`);
});

test('control: the table has on, off and sentinel rows on both home shapes, so agreement is not trivial', () => {
  for (const xdg of ['absolute', 'unset']) {
    assert.ok(ROWS.some((r) => r.xdg === xdg && r.off), `${xdg}: an off row`);
    assert.ok(ROWS.some((r) => r.xdg === xdg && !r.off), `${xdg}: an on row`);
    assert.ok(ROWS.some((r) => r.xdg === xdg && r.sentinel), `${xdg}: a sentinel row`);
  }
});

test('negative control: a reader that differs from the others makes the agreement check fail', { skip: !POSIX }, (t) => {
  // A deliberately wrong reader: the word is compared case-sensitively and without trimming.
  const strict = ({ env, home }) => {
    const word = env.DOFLOW_FAILURE_CAPTURE;
    if (word !== undefined && ['off', '0', 'false', 'no'].includes(word)) return true;
    return fs.existsSync(path.join(home, 'off'));
  };
  const found = disagreements({ ...READERS, 'stub (case-sensitive)': strict }, ROWS, t);
  const names = found.map((x) => x.row);
  assert.ok(found.length > 0, 'the stub disagrees somewhere');
  assert.ok(names.some((n) => n.includes('"OFF"')), 'OFF is one of the rows it gets wrong');
  assert.ok(names.some((n) => n.includes('" off "')), 'a padded word is another');
  assert.ok(!names.some((n) => n.includes('"maybe"')), 'rows where it matches the others stay out');
  for (const x of found) {
    assert.deepEqual(Object.keys(x.answers).filter((k) => x.answers[k] !== x.expected), ['stub (case-sensitive)'], x.row);
  }
});
