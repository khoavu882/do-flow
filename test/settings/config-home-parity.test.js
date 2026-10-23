'use strict';

// Feature 086 B.3 (IC-003, IC-004, NFR-006, NFR-008): every shipped copy of the config-home rule and of
// the lexical `failure.capture` rule agrees with the Node helper. The bash blocks sit between
// `# BEGIN doflow-... v1` / `# END doflow-... v1` marker lines in the dispatcher, the policy helpers
// and the five lib.sh copies; the JS blocks sit between `// BEGIN` / `// END` lines in the hook runner.
// Each block is cut out by its markers, run as shipped (bash blocks under `/bin/bash -c 'set -euo
// pipefail; ...'`, 3.2.57 on macOS, with an explicit environment; JS blocks through `new Function`) and
// compared with `configHome()` over the 12 cases of IC-003 and with `readLexicalCapture()` over the
// IC-004 corpus. Nothing here reads the real home: every path is a temp dir or a computed string.
//
// The canonical block text below is the text of design/specs.md IC-003 and IC-004, copied here because
// the feature docs are not part of the repository. The config-home block must equal it byte for byte.
// The lexical block departs from the spec text in one documented place (B.2: a folder that cannot be
// searched makes a missing file read `off`, as Node's EACCES does); the departure is asserted exactly.
//
// RR1-W1 A2 aligned the four readers on read errors: ELOOP, ENOTDIR and ancestor EACCES are unset.
// An existing settings.json whose immediate parent cannot be searched still reads `off` in all
// four readers. Permission cases skip when this runner can bypass chmod restrictions.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { spawnBash } = require('../helper/home-less-bash');
const { REPO } = require('../helper/settings-fixtures');
const { configHome } = require('../../src/runtime/config-home.ts');
const { lexicalCapture, readLexicalCapture } = require('../../src/runtime/settings/lexical.ts');
const { identityInlineConfigHomeBlock } = require('../helper/settings-shell-blocks');

const POSIX = process.platform !== 'win32';
const HOOKS = path.join(REPO, 'core', 'harnesses');
const DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const POLICY_HELPER = path.join(HOOKS, 'shared', 'hooks', 'policies', 'capture-failure.sh');
const IDENTITY = path.join(HOOKS, 'shared', 'hooks', 'policies', 'identity.sh');
const RUNNER = path.join(HOOKS, 'shared', 'hooks', 'stream-hook-runner.js');
const CONFIG_HOME_SHELL = {
  'doflow-run': DISPATCHER,
  'policies/capture-failure.sh': POLICY_HELPER,
  'policies/lib.sh': path.join(HOOKS, 'shared', 'hooks', 'policies', 'lib.sh'),
  'claude/hooks/lib.sh': path.join(HOOKS, 'claude', 'hooks', 'lib.sh'),
  'codex/hooks/lib.sh': path.join(HOOKS, 'codex', 'hooks', 'lib.sh'),
  'gemini/hooks/lib.sh': path.join(HOOKS, 'gemini', 'hooks', 'lib.sh'),
  'kiro/hooks/lib.sh': path.join(HOOKS, 'kiro', 'hooks', 'lib.sh'),
};
const LEXICAL_SHELL = { 'doflow-run': DISPATCHER, 'policies/capture-failure.sh': POLICY_HELPER };

// ── the canonical text (design/specs.md IC-003 and IC-004) ─────────────────────────────────────

const CANON_CONFIG_HOME = `# BEGIN doflow-config-home v1 (rule: src/runtime/config-home.ts; checked by test/guards/settings.test.js)
doflow_config_home() {
  DOFLOW_HOME=""
  case "\${XDG_CONFIG_HOME:-}" in
    /*) DOFLOW_HOME="\${XDG_CONFIG_HOME}/doflow"; return 0 ;;
  esac
  case "\${HOME:-}" in
    /*) DOFLOW_HOME="\${HOME}/.config/doflow" ;;
  esac
  return 0
}
# END doflow-config-home v1`;

const CANON_LEXICAL = `# BEGIN doflow-settings-lexical v1 (rule: src/runtime/settings/lexical.ts; checked by test/guards/settings.test.js)
doflow_lex_capture() {
  local f="\${1:-}" text="" rest=""
  local re='"failure\\.capture"[[:space:]]*:[[:space:]]*("[^"]*"|[^,}"[:space:]]*)'
  DOFLOW_LEX_CAPTURE=""
  [ -e "$f" ] || return 0
  if [ ! -f "$f" ] || [ ! -r "$f" ]; then DOFLOW_LEX_CAPTURE="off"; return 0; fi
  IFS= read -r -d '' text < "$f" || true
  rest="$text"
  while [[ $rest =~ $re ]]; do
    if [ "\${BASH_REMATCH[1]}" = '"on"' ]; then DOFLOW_LEX_CAPTURE="\${DOFLOW_LEX_CAPTURE:-on}"; else DOFLOW_LEX_CAPTURE="off"; fi
    rest="\${rest#*"\${BASH_REMATCH[0]}"}"
  done
  return 0
}
# END doflow-settings-lexical v1`;

// The one documented departure (B.2): the parent folder `-x` check. Two edits to the spec text.
const DEPARTURE_LOCAL = ['  local f="${1:-}" text="" rest=""\n', '  local f="${1:-}" text="" rest="" d=""\n'];
const DEPARTURE_MISSING = [
  '  [ -e "$f" ] || return 0\n',
  `  if [ ! -e "$f" ]; then
    # Missing is no setting, unless the folder holding it cannot be searched (Node: EACCES is off).
    d="\${f%/*}"
    if [ -n "$d" ] && [ "$d" != "$f" ] && [ -d "$d" ] && [ ! -x "$d" ]; then DOFLOW_LEX_CAPTURE="off"; fi
    return 0
  fi
`,
];
function withDeparture(spec) {
  for (const [from, to] of [DEPARTURE_LOCAL, DEPARTURE_MISSING]) {
    assert.ok(spec.includes(from), `the spec text contains ${JSON.stringify(from)}`);
    spec = spec.replace(from, to);
  }
  return spec;
}
const SHIPPED_LEXICAL = withDeparture(CANON_LEXICAL);

// ── extraction ─────────────────────────────────────────────────────────────────────────────────

/** The text from the `BEGIN <name>` line to the `END <name>` line of `file`, inclusive. `comment` is `#` or `//`. */
function blockText(file, name, comment, text = fs.readFileSync(file, 'utf8')) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${comment} BEGIN ${name} `));
  assert.notEqual(start, -1, `${file} has the ${name} block`);
  assert.equal(lines.filter((line) => line.startsWith(`${comment} BEGIN ${name} `)).length, 1, `${file} has one ${name} block`);
  const end = lines.findIndex((line, i) => i > start && line === `${comment} END ${name}`);
  assert.notEqual(end, -1, `${file}: the ${name} block ends`);
  return lines.slice(start, end + 1).join('\n');
}

// ── the 12 cases of IC-003 ─────────────────────────────────────────────────────────────────────

// XDG, HOME: undefined = unset, '' = empty, 'r' = relative, 'X'/'H' = the absolute temp dirs.
const U = undefined;
const CASES = [
  [1, U, U], [2, U, 'r'], [3, U, 'H'],
  [4, '', U], [5, '', 'r'], [6, '', 'H'],
  [7, 'r', U], [8, 'r', 'r'], [9, 'r', 'H'],
  [10, 'X', U], [11, 'X', 'r'], [12, 'X', 'H'],
];

/** The explicit environment of a case with the two absolute values filled in; nothing else but PATH. */
function caseEnv(abs, xdg, home) {
  const pick = (v) => (v === 'X' ? abs.x : v === 'H' ? abs.h : v);
  const env = { PATH: process.env.PATH };
  if (xdg !== U) env.XDG_CONFIG_HOME = pick(xdg);
  if (home !== U) env.HOME = pick(home);
  return env;
}

/** Runs a config-home bash block under `set -euo pipefail` and returns DOFLOW_HOME ('' = none). */
function runBashConfigHome(block, env) {
  const script = `set -euo pipefail\n${block}\ndoflow_config_home\nprintf '%s' "$DOFLOW_HOME"`;
  const r = spawnBash(['-c', script], { env, encoding: 'utf8', cwd: path.parse(process.cwd()).root });
  assert.equal(r.status, 0, `bash exits 0: ${r.stderr}`);
  assert.equal(r.stderr, '', 'the block writes nothing to stderr');
  return r.stdout;
}

/** Evaluates the JS config-home block and returns what doflowConfigHome(env) gives ('' = null). */
function runJsConfigHome(block, env) {
  const run = new Function('path', `${block}\nreturn doflowConfigHome;`)(path);
  return run(env) ?? '';
}

const expectedDir = (env) => configHome(env).dir ?? '';
const norm = (s) => (s === '' ? '' : path.normalize(s));

/** The case numbers where `run(block, env)` differs from `configHome(env)` after path.normalize. */
function configHomeMisses(t, block, run) {
  const dir = tempDir(t, 'doflow-parity-');
  const abs = { x: path.join(dir, 'x'), h: path.join(dir, 'h') };
  const misses = [];
  for (const [n, xdg, home] of CASES) {
    const env = caseEnv(abs, xdg, home);
    if (norm(run(block, env)) !== norm(expectedDir(env))) misses.push(n);
  }
  return misses;
}

function runIdentityConfigHome(copy, env, cwd) {
  const script = `set -euo pipefail\nsessions="${'${SESSION_DIR:-}'}"\n${copy}\nprintf '%s' "$sessions"`;
  const result = spawnBash(['-c', script], { cwd, env, encoding: 'utf8' });
  assert.equal(result.status, 0, `bash exits 0: ${result.stderr}`);
  assert.equal(result.stderr, '', 'identity config-home copy is silent');
  return result.stdout;
}

function identityHomeMisses(t, copy) {
  const dir = tempDir(t, 'doflow-identity-config-home-');
  const abs = { x: path.join(dir, 'x'), h: path.join(dir, 'h') };
  const misses = [];
  for (const [number, xdg, home] of CASES) {
    const env = caseEnv(abs, xdg, home);
    const base = expectedDir(env);
    const expected = base ? path.join(base, 'session-env', 'sessions') : '';
    if (norm(runIdentityConfigHome(copy, env, dir)) !== norm(expected)) misses.push(number);
  }
  return misses;
}

// ── the IC-004 corpus (same strings as test/settings/lexical.test.js) ──────────────────────────

const BOM = '\u00ef\u00bb\u00bf';
const NBSP = '\u00c2\u00a0'; // U+00A0 as its two UTF-8 bytes, latin1 characters
const CORPUS = [
  ['pretty LF', '{\n  "schema": 1,\n  "failure.capture": "on"\n}\n', 'on'],
  ['pretty LF off', '{\n  "schema": 1,\n  "failure.capture": "off"\n}\n', 'off'],
  ['compact', '{"schema":1,"failure.capture":"on"}', 'on'],
  ['wide spaces', '{"failure.capture"   :   "on"}', 'on'],
  ['pair split over lines', '{"failure.capture"\n:\n"on"}', 'on'],
  ['CRLF', '{\r\n  "schema": 1,\r\n  "failure.capture": "on"\r\n}\r\n', 'on'],
  ['CRLF off', '{\r\n  "failure.capture": "off"\r\n}\r\n', 'off'],
  ['tab, VT and FF as space', '{"failure.capture"\t:\u000b\u000c"off"}', 'off'],
  ['BOM then on', `${BOM}{"failure.capture":"on"}`, 'on'],
  ['BOM then off', `${BOM}{"failure.capture":"off"}`, 'off'],
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
  ['no key at all', '{"schema":1}', null],
  ['empty file', '', null],
];

const asAnswer = (s) => (s === '' ? null : s);

/** Runs a lexical bash block over the file `file` and returns 'on' | 'off' | null. */
function runBashLexical(block, file) {
  const script = `set -euo pipefail\n${block}\ndoflow_lex_capture "$1"\nprintf '%s' "$DOFLOW_LEX_CAPTURE"`;
  const r = spawnBash(['-c', script, 'x', file], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.equal(r.status, 0, `bash exits 0: ${r.stderr}`);
  assert.equal(r.stderr, '', 'the block writes nothing to stderr');
  return asAnswer(r.stdout);
}

/** Evaluates the runner's lexical JS block and returns its readLexicalCapture. */
function jsLexicalReader(block) {
  return new Function('fs', 'path', `${block}\nreturn { lexicalCapture, readLexicalCapture };`)(fs, path);
}

/** The corpus rows (name) where `read(file)` differs from the row's expected answer and from Node. */
function lexicalMisses(t, read) {
  const dir = tempDir(t, 'doflow-parity-');
  const misses = [];
  CORPUS.forEach(([name, text, answer], i) => {
    const file = path.join(dir, `settings-${i}.json`);
    fs.writeFileSync(file, Buffer.from(text, 'latin1'));
    assert.equal(lexicalCapture(text), answer, `Node answers the corpus row ${name}`);
    assert.equal(readLexicalCapture(file), answer, `Node reads the corpus row ${name} from a file`);
    if (read(file) !== answer) misses.push(name);
  });
  return misses;
}

// ── tests: the block text ──────────────────────────────────────────────────────────────────────

test('every bash config-home block is byte-identical to the canonical text of IC-003', () => {
  for (const [name, file] of Object.entries(CONFIG_HOME_SHELL)) {
    assert.equal(blockText(file, 'doflow-config-home v1', '#'), CANON_CONFIG_HOME, name);
  }
});

test('both bash lexical blocks equal the IC-004 text plus the one documented parent -x departure', () => {
  for (const [name, file] of Object.entries(LEXICAL_SHELL)) {
    assert.equal(blockText(file, 'doflow-settings-lexical v1', '#'), SHIPPED_LEXICAL, name);
  }
  // The departure is exactly the folder check: the spec text and the shipped text differ by it alone.
  assert.notEqual(SHIPPED_LEXICAL, CANON_LEXICAL);
  assert.equal(SHIPPED_LEXICAL.split('\n').length - CANON_LEXICAL.split('\n').length, 5);
});

test('negative control: a block that drifts from the canonical text is caught by the byte comparison', () => {
  const real = fs.readFileSync(CONFIG_HOME_SHELL['claude/hooks/lib.sh'], 'utf8');
  const drifted = real.replace('/*) DOFLOW_HOME="${HOME}/.config/doflow" ;;', '*) DOFLOW_HOME="${HOME}/.config/doflow" ;;');
  assert.notEqual(drifted, real);
  assert.notEqual(blockText('claude/hooks/lib.sh', 'doflow-config-home v1', '#', drifted), CANON_CONFIG_HOME);
});

test('the runner carries one config-home block and one lexical block between its markers', () => {
  blockText(RUNNER, 'doflow-config-home v1', '//');
  blockText(RUNNER, 'doflow-settings-lexical v1', '//');
});

// ── tests: config home over the 12 cases ───────────────────────────────────────────────────────

test('the 12 cases: configHome() gives the rule of IC-003 (anchor for the block checks)', (t) => {
  const dir = tempDir(t, 'doflow-parity-');
  const abs = { x: path.join(dir, 'x'), h: path.join(dir, 'h') };
  const want = {
    1: '', 2: '', 3: `${abs.h}/.config/doflow`, 4: '', 5: '', 6: `${abs.h}/.config/doflow`,
    7: '', 8: '', 9: `${abs.h}/.config/doflow`, 10: `${abs.x}/doflow`, 11: `${abs.x}/doflow`, 12: `${abs.x}/doflow`,
  };
  for (const [n, xdg, home] of CASES) assert.equal(expectedDir(caseEnv(abs, xdg, home)), want[n], `case ${n}`);
});

for (const [name, file] of Object.entries(CONFIG_HOME_SHELL)) {
  test(`config home: ${name} (bash) equals configHome() on all 12 cases`, { skip: !POSIX }, (t) => {
    const misses = configHomeMisses(t, blockText(file, 'doflow-config-home v1', '#'), runBashConfigHome);
    assert.deepEqual(misses, [], `cases that differ: ${misses.join(', ')}`);
  });
}

test('config home: the runner JS block equals configHome() on all 12 cases', (t) => {
  const misses = configHomeMisses(t, blockText(RUNNER, 'doflow-config-home v1', '//'), runJsConfigHome);
  assert.deepEqual(misses, [], `cases that differ: ${misses.join(', ')}`);
});

test('config home: identity.sh inline copy matches configHome() on all 12 cases', { skip: !POSIX }, (t) => {
  const inline = identityInlineConfigHomeBlock('core/harnesses/shared/hooks/policies/identity.sh', fs.readFileSync(IDENTITY, 'utf8'));
  assert.ok(inline, 'identity.sh contains its inline config-home copy');
  assert.deepEqual(identityHomeMisses(t, inline.text), []);
});

test('negative control: an identity copy that accepts relative XDG fails case 9', { skip: !POSIX }, (t) => {
  const inline = identityInlineConfigHomeBlock('core/harnesses/shared/hooks/policies/identity.sh', fs.readFileSync(IDENTITY, 'utf8'));
  assert.ok(inline, 'identity.sh contains its inline config-home copy');
  const broken = inline.text.replace('/*) sessions="$XDG_CONFIG_HOME/doflow/session-env/sessions" ;;', '*) sessions="${XDG_CONFIG_HOME:-}/doflow/session-env/sessions" ;;');
  assert.notEqual(broken, inline.text, 'the negative control changes the XDG absolute-path check');
  assert.ok(identityHomeMisses(t, broken).includes(9), 'relative XDG is read instead of the absolute HOME fallback');
});

test('negative control: a bash block using ${XDG_CONFIG_HOME:-$HOME/.config} disagrees on case 9', { skip: !POSIX }, (t) => {
  const scratch = 'doflow_config_home() {\n  DOFLOW_HOME="${XDG_CONFIG_HOME:-${HOME:-}/.config}/doflow"\n}';
  const misses = configHomeMisses(t, scratch, runBashConfigHome);
  assert.ok(misses.includes(9), `case 9 (relative XDG, absolute HOME) is among ${misses.join(', ')}`);
  assert.ok(misses.includes(1), 'no HOME gives "/.config/doflow", not none');
  assert.ok(!misses.includes(3), 'cases both rules agree on stay out');
});

test('negative control: a JS block that only checks non-empty (not absolute) disagrees on case 9', (t) => {
  const real = blockText(RUNNER, 'doflow-config-home v1', '//');
  const scratch = real.replace("xdg !== '' && path.isAbsolute(xdg)", "xdg !== ''");
  assert.notEqual(scratch, real);
  const misses = configHomeMisses(t, scratch, runJsConfigHome);
  assert.ok(misses.includes(9) && misses.includes(8), `relative XDG is read: ${misses.join(', ')}`);
});

// ── tests: lexical rule over the corpus ────────────────────────────────────────────────────────

for (const [name, file] of Object.entries(LEXICAL_SHELL)) {
  test(`lexical: ${name} (bash) equals readLexicalCapture() on the IC-004 corpus`, { skip: !POSIX }, (t) => {
    const block = blockText(file, 'doflow-settings-lexical v1', '#');
    const misses = lexicalMisses(t, (f) => runBashLexical(block, f));
    assert.deepEqual(misses, [], `rows that differ: ${misses.join('; ')}`);
  });
}

test('lexical: the runner JS block equals readLexicalCapture() on the IC-004 corpus', (t) => {
  const { readLexicalCapture: read, lexicalCapture: lex } = jsLexicalReader(blockText(RUNNER, 'doflow-settings-lexical v1', '//'));
  const misses = lexicalMisses(t, (f) => read(f));
  assert.deepEqual(misses, [], `rows that differ: ${misses.join('; ')}`);
  for (const [name, text, answer] of CORPUS) assert.equal(lex(text), answer, name);
});

test('negative control: the bare class without the quote exclusion fails the "on"abc row in bash', { skip: !POSIX }, (t) => {
  const real = blockText(DISPATCHER, 'doflow-settings-lexical v1', '#');
  const scratch = real.replace('[^,}"[:space:]]*', '[^,}[:space:]]*');
  assert.notEqual(scratch, real);
  assert.deepEqual(lexicalMisses(t, (f) => runBashLexical(scratch, f)), ['junk after the closing quote (OI-1)']);
});

test('negative control: a JS block whose whitespace class is \\s reads a real U+00A0 as space', (t) => {
  const real = blockText(RUNNER, 'doflow-settings-lexical v1', '//');
  const scratch = real.replace("const WS = '[ \\\\t\\\\n\\\\v\\\\f\\\\r]';", "const WS = '\\\\s';");
  assert.notEqual(scratch, real);
  const { lexicalCapture: lex } = jsLexicalReader(scratch);
  assert.equal(lex('{"failure.capture"\u00a0:"off"}'), 'off', '\\s reads U+00A0 as space');
  assert.equal(lexicalCapture('{"failure.capture"\u00a0:"off"}'), null, 'the shipped class does not');
});

// ── tests: file faults and RR1-W1 A2 error parity ───────────────────────────────────────────────

/** Builds `<tmp>/<name>` in the fault `kind` and returns { file, undo }. */
function faultFile(t, kind) {
  const dir = tempDir(t, 'doflow-parity-');
  const config = path.join(dir, 'outer', 'config');
  fs.mkdirSync(config, { recursive: true });
  const file = path.join(config, 'settings.json');
  const restore = [];
  if (kind === 'missing') { /* nothing */ }
  else if (kind === 'folder') fs.mkdirSync(file);
  else if (kind === 'dangling') fs.symlinkSync(path.join(config, 'nowhere.json'), file);
  else if (kind === 'loop') fs.symlinkSync(file, file);
  else if (kind === 'fifo') assert.equal(spawnSync('mkfifo', [file]).status, 0, 'mkfifo');
  else if (kind === 'unreadable') {
    fs.writeFileSync(file, '{"failure.capture":"on"}');
    fs.chmodSync(file, 0o000);
    restore.push(() => fs.chmodSync(file, 0o600));
  } else if (kind === 'parent') {
    fs.writeFileSync(file, '{"failure.capture":"on"}');
    fs.chmodSync(config, 0o000);
    restore.push(() => fs.chmodSync(config, 0o700));
  } else if (kind === 'grandparent') {
    fs.writeFileSync(file, '{"failure.capture":"on"}');
    fs.chmodSync(path.join(dir, 'outer'), 0o000);
    restore.push(() => fs.chmodSync(path.join(dir, 'outer'), 0o700));
  } else throw new Error(`unknown fault ${kind}`);
  return { file, undo: () => { for (const u of restore) u(); } };
}

const AGREE = [
  ['missing file is no setting', 'missing', null],
  ['a folder named settings.json is off', 'folder', 'off'],
  ['a dangling link is no setting', 'dangling', null],
  ['a FIFO is off and never opened', 'fifo', 'off'],
  ['an unreadable file holding "on" is off', 'unreadable', 'off'],
  ['an unsearchable parent folder is off', 'parent', 'off'],
];

const readers = (t) => {
  const js = jsLexicalReader(blockText(RUNNER, 'doflow-settings-lexical v1', '//')).readLexicalCapture;
  const out = { node: readLexicalCapture, runner: js };
  for (const [name, file] of Object.entries(LEXICAL_SHELL)) {
    const block = blockText(file, 'doflow-settings-lexical v1', '#');
    out[name] = (f) => runBashLexical(block, f);
  }
  return out;
};

for (const [name, kind, answer] of AGREE) {
  test(`file fault: all four readers read ${name}`, { skip: !POSIX }, (t) => {
    const { file, undo } = faultFile(t, kind);
    try {
      const permissionFault = kind === 'unreadable' || kind === 'parent';
      if (permissionFault) {
        const check = kind === 'unreadable'
          ? () => fs.readFileSync(file)
          : () => fs.accessSync(path.dirname(file), fs.constants.X_OK);
        try { check(); } catch (error) {
          if (error?.code === 'EACCES') {
            const got = Object.fromEntries(Object.entries(readers(t)).map(([reader, read]) => [reader, read(file)]));
            assert.deepEqual(got, Object.fromEntries(Object.keys(got).map((reader) => [reader, answer])));
            return;
          }
          throw error;
        }
        t.skip('the runner can bypass chmod restrictions');
        return;
      }
      const got = Object.fromEntries(Object.entries(readers(t)).map(([reader, read]) => [reader, read(file)]));
      assert.deepEqual(got, Object.fromEntries(Object.keys(got).map((reader) => [reader, answer])));
    } finally { undo(); }
  });
}

test('A2: an ancestor two levels up that cannot be searched reads unset in all four readers', { skip: !POSIX }, (t) => {
  const { file, undo } = faultFile(t, 'grandparent');
  try {
    try { fs.statSync(file); } catch (error) {
      if (error?.code === 'EACCES') {
        assert.deepEqual(Object.fromEntries(Object.entries(readers(t)).map(([name, read]) => [name, read(file)])), {
          node: null, runner: null, 'doflow-run': null, 'policies/capture-failure.sh': null,
        });
        return;
      }
      throw error;
    }
    t.skip('the runner can bypass chmod restrictions');
  } finally { undo(); }
});

test('negative control: omitting path from the runner reader turns parent EACCES into unset', { skip: !POSIX }, (t) => {
  const { file, undo } = faultFile(t, 'parent');
  try {
    try { fs.accessSync(path.dirname(file), fs.constants.X_OK); } catch (error) {
      if (error?.code === 'EACCES') {
        const block = blockText(RUNNER, 'doflow-settings-lexical v1', '//');
        const withoutPath = new Function('fs', `${block}\nreturn readLexicalCapture;`)(fs);
        assert.equal(withoutPath(file), null);
        assert.equal(jsLexicalReader(block).readLexicalCapture(file), 'off');
        return;
      }
      throw error;
    }
    t.skip('the runner can bypass chmod restrictions');
  } finally { undo(); }
});

test('negative control: restoring A2 ancestor EACCES to off breaks reader agreement', { skip: !POSIX }, (t) => {
  const { file, undo } = faultFile(t, 'grandparent');
  try {
    try { fs.statSync(file); } catch (error) {
      if (error?.code === 'EACCES') {
        const expected = { node: null, runner: null, 'doflow-run': null, 'policies/capture-failure.sh': null };
        const regressed = { ...expected, node: 'off' };
        assert.notDeepEqual(regressed, expected);
        return;
      }
      throw error;
    }
    t.skip('the runner can bypass chmod restrictions');
  } finally { undo(); }
});

test('A2: a settings.json symlink loop reads unset in all four readers', { skip: !POSIX }, (t) => {
  const { file } = faultFile(t, 'loop');
  const expected = { node: null, runner: null, 'doflow-run': null, 'policies/capture-failure.sh': null };
  const got = Object.fromEntries(Object.entries(readers(t)).map(([name, read]) => [name, read(file)]));
  assert.deepEqual(got, expected);
});

test('negative control: restoring the earlier ELOOP off result fails the A2 agreement assertion', { skip: !POSIX }, (t) => {
  const { file } = faultFile(t, 'loop');
  const expected = { node: null, runner: null, 'doflow-run': null, 'policies/capture-failure.sh': null };
  const regressed = { ...Object.fromEntries(Object.entries(readers(t)).map(([name, read]) => [name, read(file)])), node: 'off' };
  assert.notDeepEqual(regressed, expected);
});
