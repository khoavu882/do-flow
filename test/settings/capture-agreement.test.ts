'use strict';

// Feature 086: the four readers of `failure.capture` agree. Capture is read by four separate pieces
// of code: the bash dispatcher (bin/doflow-run, capture_failure_write), the bash policy helper
// (policies/capture-failure.sh, doflow_capture_failure), the JS hook runner (stream-hook-runner.js,
// captureHookFailure) and Node (failure/home.ts, captureIsOff). Each row sets an environment, a
// sentinel and a settings.json, asks every reader whether capture is on, and requires one answer
// equal to the row's expected value. The three writers answer by whether they append a line to the
// events file; Node answers with captureIsOff (or "skipped" when failureHome is null).
//
// A.2 pinned the env and sentinel rows (C17-C20, unchanged from earlier betas). B.2 adds the home shapes of
// IC-003 (C21-C23 in this release: a relative XDG_CONFIG_HOME is ignored and a usable HOME decides), the
// settings.json file faults (unreadable, dangling link, folder, unsearchable folder, FIFO) and the
// IC-004 corpus through all four readers (B.3 added the Node column to the corpus).
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
const { tempDir }: any = require('../helper/tmp.ts');
const { createSettingsEnv, REPO }: any = require('../helper/settings-fixtures.ts');
const { failureHome, captureIsOff, captureSwitch }: any = require('../../src/runtime/failure/home.ts');
const { readLexicalCapture }: any = require('../../src/runtime/settings/lexical.ts');

const POSIX = process.platform !== 'win32';
const ROOT = POSIX && typeof process.getuid === 'function' && process.getuid() === 0;
// Keep macOS's Bash 3.2 as the default, but let this test file be exercised with another host Bash.
const BASH = process.env.DOFLOW_TEST_BASH || '/bin/bash';
const BASH_MAJOR = (() => {
  const result = spawnSync(BASH, ['--version'], { encoding: 'utf8' });
  const match = `${result.stdout || ''}\n${result.stderr || ''}`.match(/\bversion\s+(\d+)\./i);
  return match ? Number(match[1]) : null;
})();
const BASH_3_REGEX_SKIP_REASON = BASH_MAJOR !== null && BASH_MAJOR >= 4
  ? `requires Bash 3.x regex semantics; detected Bash ${BASH_MAJOR}`
  : false;
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const POLICY_HELPER = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', 'capture-failure.sh');
const RUNNER = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'stream-hook-runner.js');

/** The lines from `# BEGIN <name>` to `# END <name>` in `lines`, inclusive. */
function block(lines: any, name: any, file: any) {
  const start = lines.findIndex((line: any) => line.startsWith(`# BEGIN ${name} `));
  assert.notEqual(start, -1, `${file} has the ${name} block`);
  const end = lines.findIndex((line: any, i: any) => i > start && line === `# END ${name}`);
  assert.notEqual(end, -1, `${file}: the ${name} block ends`);
  return lines.slice(start, end + 1);
}

/** The dispatcher's capture reader cut from `text`: its two marked blocks and its two functions. */
function dispatcherFunctions(text = fs.readFileSync(DISPATCHER, 'utf8')) {
  const lines = text.split('\n');
  const out = [...block(lines, 'doflow-config-home v1', 'doflow-run'), '', ...block(lines, 'doflow-settings-lexical v1', 'doflow-run'), ''];
  for (const name of ['capture_failure_write', 'capture_failure']) {
    const start = lines.findIndex((line: any) => line === `${name}() {`);
    assert.notEqual(start, -1, `${name} is defined in doflow-run`);
    const end = lines.findIndex((line: any, i: any) => i > start && line === '}');
    assert.notEqual(end, -1, `${name} ends`);
    out.push(...lines.slice(start, end + 1), '');
  }
  return `CAPTURE_VERB=""\n${out.join('\n')}`;
}

// ── rows ───────────────────────────────────────────────────────────────────────────────────────

// `word` undefined leaves DOFLOW_FAILURE_CAPTURE unset; `xdg` is 'absolute' (XDG_CONFIG_HOME set to
// the fixture folder) or 'unset' (the home falls back to $HOME/.config); `sentinel` puts the
// failures/off file where that row's readers look; `off` is the expected answer (C17-C20, unchanged
// from earlier betas).
const ROWS: any = [];
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

// IC-003 home shapes in this release. `relative-xdg`: XDG_CONFIG_HOME relative and HOME absolute (case 9,
// C23 flipped: HOME decides). `relative-xdg, no HOME` (case 7) and `no HOME, no XDG` (case 1, C22):
// no config home, capture skipped, nothing created anywhere.
const HOME_ROWS = [
  { name: 'relative XDG, absolute HOME: $HOME/.config decides (C23)', xdg: 'relative', off: false },
  { name: 'relative XDG, absolute HOME, sentinel under $HOME/.config', xdg: 'relative', sentinel: true, off: true },
  { name: 'relative XDG, absolute HOME, settings.json off under $HOME/.config', xdg: 'relative', settings: { text: '{"failure.capture":"off"}' }, off: true },
  { name: 'relative XDG, HOME unset: no config home (case 7)', xdg: 'relative', noHome: true, off: true },
  { name: 'HOME and XDG unset: no config home (case 1, C22)', xdg: 'unset', noHome: true, off: true },
];

// settings.json shapes that are not a readable regular file (IC-004 file cases, B.1 parity item).
// `settings.text` is a regular file; `settings.kind` one of the faults. Expected: Node's answer.
const FILE_ROWS: any = [];
for (const xdg of ['absolute', 'unset']) {
  FILE_ROWS.push({ name: 'settings.json on', xdg, settings: { text: '{"failure.capture":"on"}' }, off: false });
  FILE_ROWS.push({ name: 'settings.json off', xdg, settings: { text: '{"failure.capture":"off"}' }, off: true });
  FILE_ROWS.push({ name: 'settings.json off with env on (env cannot turn it on)', xdg, word: 'on', settings: { text: '{"failure.capture":"off"}' }, off: true });
  FILE_ROWS.push({ name: 'settings.json without the key', xdg, settings: { text: '{"schema":1}' }, off: false });
  FILE_ROWS.push({ name: 'a folder named settings.json is off', xdg, settings: { kind: 'folder' }, off: true });
  FILE_ROWS.push({ name: 'a dangling settings.json link is no setting', xdg, settings: { kind: 'dangling' }, off: false });
  FILE_ROWS.push({ name: 'a FIFO named settings.json is off and never opened', xdg, settings: { kind: 'fifo' }, off: true });
  if (!ROOT) {
    FILE_ROWS.push({ name: 'an unreadable settings.json holding "on" is off', xdg, settings: { kind: 'unreadable' }, off: true });
    FILE_ROWS.push({ name: 'settings.json in a folder that cannot be searched is off', xdg, settings: { kind: 'parent' }, off: true });
  }
}

// The IC-004 corpus (the strings of test/settings/lexical.test.js), each written as the bytes of
// settings.json; `answer` is the lexical rule's result, and capture is off only for 'off'.
const BOM = '\u00ef\u00bb\u00bf';
const NBSP = '\u00c2\u00a0'; // U+00A0 as its two UTF-8 bytes, latin1 characters
const CORPUS = [
  ['pretty LF', '{\n  "schema": 1,\n  "failure.capture": "on"\n}\n', 'on'],
  ['pretty LF off', '{\n  "schema": 1,\n  "failure.capture": "off"\n}\n', 'off'],
  ['compact', '{"schema":1,"failure.capture":"on"}', 'on'],
  ['wide spaces', '{"failure.capture"   :   "on"}', 'on'],
  ['wide spaces off', '{"failure.capture"   :   "off"}', 'off'],
  ['pair split over lines', '{"failure.capture"\n:\n"on"}', 'on'],
  ['CRLF', '{\r\n  "schema": 1,\r\n  "failure.capture": "on"\r\n}\r\n', 'on'],
  ['CRLF off', '{\r\n  "failure.capture": "off"\r\n}\r\n', 'off'],
  ['tab, VT and FF as space', '{"failure.capture"\t:\u000b\u000c"off"}', 'off'],
  ['BOM then on', `${BOM}{"failure.capture":"on"}`, 'on'],
  ['BOM then off', `${BOM}{"failure.capture":"off"}`, 'off'],
  ['OFF', '{"failure.capture":"OFF"}', 'off'],
  ['ON is not on', '{"failure.capture":"ON"}', 'off'],
  ['"off " with a space', '{"failure.capture":"off "}', 'off'],
  ['bare true', '{"failure.capture":true}', 'off'],
  ['empty value', '{"failure.capture":}', 'off'],
  ['duplicate on then off', '{"failure.capture":"on","failure.capture":"off"}', 'off'],
  ['duplicate off then on', '{"failure.capture":"off","failure.capture":"on"}', 'off'],
  ['duplicate on then on', '{"failure.capture":"on","failure.capture":"on"}', 'on'],
  ['another key whose value is the key text', '{"other":"failure.capture","failure.capture":"on"}', 'on'],
  ['the key text alone is no setting', '{"other":"failure.capture"}', null],
  ['escaped key text inside a string', '{"x":"\\"failure.capture\\":\\"off\\""}', null],
  ['nested object is not the flat key', '{"failure":{"capture":"off"}}', null],
  ['broken JSON still reads the pair', '{"failure.capture":"off" garbage ]]', 'off'],
  ['junk after the closing quote (OI-1)', '{"failure.capture":"on"abc,}', 'on'],
  ['unterminated on', '{"failure.capture":"on', 'off'],
  ['NUL ends the text', '{"failure.capture":"on"}\0{"failure.capture":"off"}', 'on'],
  ['non-breaking space is not space', `{"failure.capture"${NBSP}:"off"}`, null],
  ['non-breaking space after the colon', `{"failure.capture":${NBSP}"on"}`, 'off'],
];
const CORPUS_ROWS = CORPUS.map(([name, text, answer]) => ({ name: `corpus: ${name}`, xdg: 'absolute', settings: { text }, off: answer === 'off' }));

// IC-004 read-error rows: ELOOP and ENOTDIR are unset; EACCES from an unsearchable ancestor is
// unset too. An immediate parent that exists but cannot be searched remains off per the bash check.
const READ_ERROR_CORPUS = [
  ['ELOOP settings link', 'loop', null],
  ['ENOTDIR settings ancestor', 'enotdir', null],
  ['ancestor EACCES', 'ancestor-eacces', null],
];

// ── fixtures ───────────────────────────────────────────────────────────────────────────────────

/** A fresh fixture for one row: its environment, the failures home and the events file. */
function rowEnv(t: any, row: any) {
  const f = createSettingsEnv(t, { prefix: 'doflow-capture-agreement-' });
  const env: any = { PATH: process.env.PATH };
  if (!row.noHome) env.HOME = f.home;
  if (row.xdg === 'absolute') env.XDG_CONFIG_HOME = f.xdg;
  if (row.xdg === 'relative') env.XDG_CONFIG_HOME = 'rel-xdg';
  if (row.word !== undefined) env.DOFLOW_FAILURE_CAPTURE = row.word;
  const home = failureHome(env);
  const expectedHome = row.noHome ? null : row.xdg === 'absolute' ? f.failuresDir : path.join(f.home, '.config', 'doflow', 'failures');
  assert.equal(home, expectedHome, 'the row resolves the failure home it means to');
  const restore: any = [];
  if (home && row.sentinel) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'off'), 'off\n');
  }
  if (home && row.settings) {
    const config = path.dirname(home);
    const file = path.join(config, 'settings.json');
    fs.mkdirSync(config, { recursive: true });
    const kind = row.settings.kind;
    if (kind === undefined) fs.writeFileSync(file, Buffer.from(row.settings.text, 'latin1'));
    else if (kind === 'folder') fs.mkdirSync(file);
    else if (kind === 'dangling') fs.symlinkSync(path.join(config, 'nowhere.json'), file);
    else if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [file]).status, 0, 'mkfifo');
    else if (kind === 'unreadable') {
      fs.writeFileSync(file, '{"failure.capture":"on"}');
      fs.chmodSync(file, 0o000);
      restore.push(() => fs.chmodSync(file, 0o600));
    } else if (kind === 'parent') {
      fs.writeFileSync(file, '{"failure.capture":"on"}');
      fs.chmodSync(config, 0o000);
      restore.push(() => fs.chmodSync(config, 0o700));
    } else throw new Error(`unknown settings kind ${kind}`);
  }
  return {
    f, env, home, events: home && path.join(home, 'events.jsonl'),
    done() { for (const undo of restore) undo(); },
  };
}

/** True when nothing was appended: no events file, or an empty one. Rows with no home check that nothing was created. */
function noLine(setup: any) {
  if (setup.home === null) {
    assert.deepEqual(fs.readdirSync(setup.f.project), ['.doflow'], 'nothing created in the working directory');
    assert.deepEqual(fs.readdirSync(setup.f.home), [], 'nothing created in the fixture home');
    return true;
  }
  setup.done();
  return !(fs.existsSync(setup.events) && fs.readFileSync(setup.events, 'utf8').trim().length > 0);
}

// ── readers ────────────────────────────────────────────────────────────────────────────────────

/** The dispatcher reader over `text` (default: the shipped file). */
function dispatcherReader(text?: any) {
  const script = `set -euo pipefail\n${dispatcherFunctions(text)}\ncapture_failure dispatcher probe-kind 2`;
  return (setup: any) => {
    const r = spawnSync(BASH, ['-c', script], { cwd: setup.f.project, env: setup.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return noLine(setup);
  };
}

/** The policy helper reader over the file `helper` (default: the shipped file). */
function policyReader(helper = POLICY_HELPER) {
  return (setup: any) => {
    const r = spawnSync(BASH, ['-c', 'set -uo pipefail; . "$1"; doflow_capture_failure pre-bash-guard patterns-missing', 'x', helper],
      { cwd: setup.f.project, env: setup.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return noLine(setup);
  };
}

const READERS = {
  'bash dispatcher (doflow-run)': dispatcherReader(),
  'bash policy helper (capture-failure.sh)': policyReader(),
  'JS hook runner (stream-hook-runner.js)'(setup: any) {
    const code = `process.stdout.write(String(require(${JSON.stringify(RUNNER)}).captureHookFailure({ command: 'probe', kind: 'probe-kind' })))`;
    const r = spawnSync(process.execPath, ['-e', code], { cwd: setup.f.project, env: setup.env, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const off = noLine(setup);
    assert.equal(r.stdout === 'true', !off, 'the runner reports a write exactly when a line is there');
    return off;
  },
  'Node captureIsOff (failure/home.ts)'(setup: any) {
    const off = setup.home === null ? true : captureIsOff(setup.home, setup.env);
    setup.done();
    return off;
  },
};

/** Runs every reader over every row (fresh fixture per reader and row); returns the disagreements. */
function disagreements(readers: any, rows: any, t: any) {
  const found = [];
  for (const row of rows) {
    const answers: any = {};
    for (const [name, read] of Object.entries(readers)) {
      const setup = rowEnv(t, row);
      try { answers[name] = (read as any)(setup); } finally { setup.done(); }
    }
    const distinct = new Set(Object.values(answers));
    if (distinct.size !== 1 || !distinct.has(row.off)) found.push({ row: `${row.xdg} xdg: ${row.name}`, expected: row.off, answers });
  }
  return found;
}

/** A scratch copy of capture-failure.sh with `from` replaced by `to` inside its lexical block. */
function patchedHelper(t: any, from: any, to: any) {
  const text = fs.readFileSync(POLICY_HELPER, 'utf8');
  const lines = text.split('\n');
  const lex = block(lines, 'doflow-settings-lexical v1', 'capture-failure.sh').join('\n');
  assert.ok(lex.includes(from), `the lexical block contains ${from}`);
  const dir = createSettingsEnv(t, { prefix: 'doflow-capture-patched-' }).dir;
  const file = path.join(dir, 'capture-failure.sh');
  fs.writeFileSync(file, text.replace(lex, lex.split(from).join(to)));
  return file;
}

// ── tests ──────────────────────────────────────────────────────────────────────────────────────

const DATA_ONLY_IMPORT = [path.resolve(__dirname, '../e2e/config-list.test.js'), path.resolve(__dirname, '../e2e/config-list.test.ts')].includes(module.parent?.filename);
if (!DATA_ONLY_IMPORT) {
test('the four capture readers give one on/off answer on every env and sentinel row (C17-C20)', { skip: !POSIX }, (t: any) => {
  assert.equal(Object.keys(READERS).length, 4);
  assert.equal(ROWS.length, 34);
  const found = disagreements(READERS, ROWS, t);
  assert.deepEqual(found, [], `readers disagree: ${JSON.stringify(found, null, 1)}`);
});

test('the four readers agree on the IC-003 home shapes in this release (C21-C23)', { skip: !POSIX }, (t: any) => {
  const found = disagreements(READERS, HOME_ROWS, t);
  assert.deepEqual(found, [], `readers disagree: ${JSON.stringify(found, null, 1)}`);
});

test('the four readers agree on settings.json and its file faults (unreadable, dangling, folder, unsearchable folder, FIFO)', { skip: !POSIX }, (t: any) => {
  const found = disagreements(READERS, FILE_ROWS, t);
  assert.deepEqual(found, [], `readers disagree: ${JSON.stringify(found, null, 1)}`);
});

test('the four readers agree with the IC-004 corpus answers (Node included)', { skip: !POSIX }, (t: any) => {
  assert.equal(Object.keys(READERS).length, 4);
  const found = disagreements(READERS, CORPUS_ROWS, t);
  assert.deepEqual(found, [], `readers disagree: ${JSON.stringify(found, null, 1)}`);
});

test('negative control: the Node column of the corpus is live (a corpus row Node would read wrongly fails)', { skip: !POSIX }, (t: any) => {
  const wrong = CORPUS_ROWS.map((row) => (row.name === 'corpus: junk after the closing quote (OI-1)' ? { ...row, off: !row.off } : row));
  const found = disagreements({ node: READERS['Node captureIsOff (failure/home.ts)'] }, wrong, t);
  assert.deepEqual(found.map((x) => x.row), ['absolute xdg: corpus: junk after the closing quote (OI-1)']);
});

test('the two bash readers carry byte-identical config-home and lexical blocks', () => {
  for (const name of ['doflow-config-home v1', 'doflow-settings-lexical v1']) {
    const a = block(fs.readFileSync(DISPATCHER, 'utf8').split('\n'), name, 'doflow-run');
    const b = block(fs.readFileSync(POLICY_HELPER, 'utf8').split('\n'), name, 'capture-failure.sh');
    assert.deepEqual(a, b, name);
  }
});

test('control: the tables have on, off and sentinel rows on both home shapes, so agreement is not trivial', () => {
  for (const xdg of ['absolute', 'unset']) {
    assert.ok(ROWS.some((r: any) => r.xdg === xdg && r.off), `${xdg}: an off row`);
    assert.ok(ROWS.some((r: any) => r.xdg === xdg && !r.off), `${xdg}: an on row`);
    assert.ok(ROWS.some((r: any) => r.xdg === xdg && r.sentinel), `${xdg}: a sentinel row`);
    assert.ok(FILE_ROWS.some((r: any) => r.xdg === xdg && r.off) && FILE_ROWS.some((r: any) => r.xdg === xdg && !r.off), `${xdg}: file rows both ways`);
  }
  assert.ok(CORPUS_ROWS.some((r: any) => r.off) && CORPUS_ROWS.some((r: any) => !r.off), 'corpus rows both ways');
});

test('negative control: a reader that differs from the others makes the agreement check fail', { skip: !POSIX }, (t: any) => {
  // A deliberately wrong reader: the word is compared case-sensitively and without trimming.
  const strict = (setup: any) => {
    const word = setup.env.DOFLOW_FAILURE_CAPTURE;
    if (word !== undefined && ['off', '0', 'false', 'no'].includes(word)) return true;
    return fs.existsSync(path.join(setup.home, 'off'));
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

test('negative control: a bash block with DD-3\'s original bare class [^,}[:space:]]* reads "on"abc as off and fails the corpus', { skip: !POSIX }, (t: any) => {
  const helper = patchedHelper(t, '[^,}"[:space:]]*', '[^,}[:space:]]*');
  const found = disagreements({ 'patched helper': policyReader(helper) }, CORPUS_ROWS, t);
  assert.deepEqual(found.map((x) => x.row), ['absolute xdg: corpus: junk after the closing quote (OI-1)']);
});

// bash 3.2's regex has no \s (DD-3 probe): `\s*` matches only an empty run, so `"k": "on"` captures
// the empty bare value after the colon (off) and `"k"   :   "off"` does not match at all (no setting).
test('negative control: a bash block whose regex uses \\s fails the corpus on bash 3.2', {
  skip: !POSIX ? 'requires POSIX' : BASH_3_REGEX_SKIP_REASON,
}, (t: any) => {
  const helper = patchedHelper(t, '[[:space:]]*:[[:space:]]*', '\\s*:\\s*');
  const found = disagreements({ 'patched helper': policyReader(helper) }, CORPUS_ROWS, t).map((x) => x.row);
  assert.ok(found.includes('absolute xdg: corpus: pretty LF'), JSON.stringify(found));
  assert.ok(found.includes('absolute xdg: corpus: wide spaces off'), JSON.stringify(found));
  assert.ok(!found.includes('absolute xdg: corpus: compact'), 'a row without whitespace still agrees');
});

test('negative control: a dispatcher block without the unsearchable-folder check reads that row as on', { skip: !POSIX || ROOT }, (t: any) => {
  const text = fs.readFileSync(DISPATCHER, 'utf8');
  const check = '    if [ -n "$d" ] && [ "$d" != "$f" ] && [ -d "$d" ] && [ ! -x "$d" ]; then DOFLOW_LEX_CAPTURE="off"; fi\n';
  assert.ok(text.includes(check));
  // The capture write cannot land in an unsearchable folder anyway, so the row is checked on the
  // lexical function itself: the shipped block says off, the stripped one says nothing.
  const lexOf = (source: any) => {
    const lines = source.split('\n');
    const script = `set -euo pipefail\nexport LC_ALL=C\n${block(lines, 'doflow-settings-lexical v1', 'doflow-run').join('\n')}\ndoflow_lex_capture "$1"; printf '%s' "$DOFLOW_LEX_CAPTURE"`;
    const setup = rowEnv(t, { xdg: 'absolute', settings: { kind: 'parent' } });
    try {
      return spawnSync(BASH, ['-c', script, 'x', path.join(path.dirname(setup.home), 'settings.json')], { encoding: 'utf8' }).stdout;
    } finally { setup.done(); }
  };
  assert.equal(lexOf(text), 'off');
  assert.equal(lexOf(text.replace(check, '')), '');
});
}

test('IC-004 read-error corpus: ELOOP, ENOTDIR and ancestor EACCES are unset in all four readers', { skip: !POSIX || ROOT }, (t: any) => {
  const dispatcher = fs.readFileSync(DISPATCHER, 'utf8');
  const helper = fs.readFileSync(POLICY_HELPER, 'utf8');
  const runnerLines = fs.readFileSync(RUNNER, 'utf8').split('\n');
  const runnerStart = runnerLines.findIndex((line: any) => line.startsWith('// BEGIN doflow-settings-lexical v1'));
  const runnerEnd = runnerLines.findIndex((line: any, i: any) => i > runnerStart && line === '// END doflow-settings-lexical v1');
  assert.ok(runnerStart >= 0 && runnerEnd > runnerStart, 'runner lexical block exists');
  const runnerRead = new Function('fs', 'path', `${runnerLines.slice(runnerStart, runnerEnd + 1).join('\n')}\nreturn readLexicalCapture;`)(fs, path);

  const bashRead = (source: any, file: any, cwd: any, label: any) => {
    const script = `set -euo pipefail\nexport LC_ALL=C\n${block(source.split('\n'), 'doflow-settings-lexical v1', label).join('\n')}\ndoflow_lex_capture "$1"; printf '%s' "$DOFLOW_LEX_CAPTURE"`;
    const result = spawnSync(BASH, ['-c', script, 'x', file], { cwd, env: { PATH: process.env.PATH }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout || null;
  };

  for (const [name, kind, expected] of READ_ERROR_CORPUS) {
    const dir = tempDir(t, `doflow-lexical-${kind}-`);
    const xdg = path.join(dir, 'xdg');
    const config = path.join(xdg, 'doflow');
    const file = path.join(config, 'settings.json');
    let restore = () => {};
    if (kind === 'loop') {
      fs.mkdirSync(config, { recursive: true });
      fs.symlinkSync(file, file);
    } else if (kind === 'enotdir') {
      fs.mkdirSync(xdg, { recursive: true });
      fs.writeFileSync(config, 'not a directory');
    } else {
      fs.mkdirSync(config, { recursive: true });
      fs.writeFileSync(file, '{"failure.capture":"on"}');
      fs.chmodSync(xdg, 0o000);
      restore = () => fs.chmodSync(xdg, 0o700);
    }

    try {
      const actual = {
        'bash dispatcher': bashRead(dispatcher, file, dir, 'doflow-run'),
        'bash policy helper': bashRead(helper, file, dir, 'capture-failure.sh'),
        'JS hook runner': runnerRead(file),
        'Node': readLexicalCapture(file),
      };
      assert.deepEqual(actual, {
        'bash dispatcher': expected,
        'bash policy helper': expected,
        'JS hook runner': expected,
        'Node': expected,
      }, name);
    } finally { restore(); }
  }
});

test('captureSwitch delegates decidedBy to the resolver origin', (t: any) => {
  const f = createSettingsEnv(t);
  f.writeUserSettings({ schema: 1, 'failure.capture': 'off' });
  const settings = f.userFile('settings.json');
  const sentinel = f.writeSentinel();

  const sentinelState = captureSwitch(f.failuresDir, f.env());
  assert.equal(sentinelState.decidedBy, sentinel);
  fs.unlinkSync(sentinel);
  assert.equal(captureSwitch(f.failuresDir, f.env()).decidedBy, settings);
  fs.unlinkSync(settings);
  assert.equal(captureSwitch(f.failuresDir, f.env({ DOFLOW_FAILURE_CAPTURE: 'off' })).decidedBy, 'DOFLOW_FAILURE_CAPTURE');

  const noHome = captureSwitch(null, { DOFLOW_FAILURE_CAPTURE: 'off' });
  assert.equal(noHome.decidedBy, null);
});

module.exports = { ROWS, HOME_ROWS, FILE_ROWS, CORPUS_ROWS, rowEnv };
