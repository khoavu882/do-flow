'use strict';

// B.5 — the hook capture helper and its two calls inside the fail-open branches of the guard
// policies (IC-018, DEC-018, DEC-032). The real policy folder is copied into a scratch directory so
// the pattern files can be removed. Every point runs with capture on and capture off and the two must
// agree byte for byte on stdout, stderr and exit status, including with malformed stdin and with HOME
// unset. Every spawn runs under a scratch HOME and XDG_CONFIG_HOME (DEC-041).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const POLICIES = path.resolve(__dirname, '..', '..', 'core', 'harnesses', 'shared', 'hooks', 'policies');
const HAS_JQ = spawnSync('jq', ['--version']).status === 0;
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const scratch = createScratch('doflow-hook-capture-');
after(() => scratch.remove());

let n = 0;
/** A scratch machine with its own copy of the policy folder, optionally without the two pattern files. */
function machine(name, { patterns = true } = {}) {
  const dir = path.join(scratch.dir, `${name}-${n++}`);
  const pol = path.join(dir, 'policies');
  fs.cpSync(POLICIES, pol, { recursive: true });
  if (!patterns) {
    fs.rmSync(path.join(pol, 'blocked-patterns.conf'));
    fs.rmSync(path.join(pol, 'mcp-policy.conf'));
  }
  const m = { dir, pol, home: path.join(dir, 'home'), xdg: path.join(dir, 'xdg'), cwd: path.join(dir, 'project') };
  for (const d of [m.home, m.xdg, m.cwd]) fs.mkdirSync(d, { recursive: true });
  m.failures = path.join(m.xdg, 'doflow', 'failures');
  m.events = path.join(m.failures, 'events.jsonl');
  return m;
}

function run(m, policy, stdin, { env = {}, dropHome = false, cwd = m.cwd } = {}) {
  const full = { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: '', ...env };
  if (dropHome) { delete full.HOME; delete full.XDG_CONFIG_HOME; }
  const r = spawnSync(BASH, [path.join(m.pol, policy), ...[]], { cwd, env: full, input: stdin, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const lines = (m) => (fs.existsSync(m.events) ? fs.readFileSync(m.events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const bash = (tool, command) => JSON.stringify({ tool_name: tool, tool_input: { command } });

/** Same call with capture on and off in twin machines; the two must be identical. */
function pair(policy, stdin, { patterns = false, env = {}, dropHome = false } = {}) {
  const on = machine('on', { patterns });
  const off = machine('off', { patterns });
  const a = run(on, policy, stdin, { env, dropHome });
  const b = run(off, policy, stdin, { env: { ...env, DOFLOW_FAILURE_CAPTURE: 'off' }, dropHome });
  assert.deepEqual(a, b, 'output or exit status differs between capture on and off');
  assert.equal(fs.existsSync(off.failures), false, 'capture off creates no folder');
  return { on, off, a };
}

describe('pre-bash-guard patterns-missing', { skip: !HAS_JQ && 'jq is not installed' }, () => {
  const cases = [
    ['an allowed command', bash('Bash', 'ls -la'), 0],
    ['a floor deny (rm -rf /)', bash('Bash', 'rm -rf /'), 2],
    ['a floor deny of the home directory', bash('Bash', 'rm -rf ~'), 2],
    ['the run_shell_command tool name', bash('run_shell_command', 'echo hi'), 0],
  ];
  for (const [name, stdin, status] of cases) {
    test(`${name}: recorded once; output and status identical with capture off`, () => {
      const { on, a } = pair('pre-bash-guard.sh', stdin);
      assert.equal(a.status, status);
      const out = lines(on);
      assert.equal(out.length, 1);
      assert.deepEqual([out[0].source, out[0].command, out[0].kind, out[0].message, out[0].frame, out[0].exit], ['hook', 'pre-bash-guard', 'patterns-missing', '', null, null]);
    });
  }
  for (const [name, stdin] of [
    ['malformed stdin', 'not json at all'],
    ['empty stdin', ''],
    ['a non-Bash tool', bash('Read', 'ls')],
    ['an empty command', bash('Bash', '')],
    ['a JSON document with no tool name', '{"a":1}'],
  ]) {
    test(`${name}: never reaches the fail-open branch, so nothing is recorded, output identical`, () => {
      const { on, a } = pair('pre-bash-guard.sh', stdin);
      assert.equal(a.status, 0);
      assert.equal(lines(on).length, 0);
      assert.equal(fs.existsSync(on.failures), false);
    });
  }
  test('with the pattern file present nothing is recorded and a deny is unchanged', () => {
    const { on, a } = pair('pre-bash-guard.sh', bash('Bash', 'rm -rf /'), { patterns: true });
    assert.equal(a.status, 2);
    assert.equal(lines(on).length, 0);
    assert.equal(fs.existsSync(on.failures), false);
  });
  test('HOME unset with no XDG_CONFIG_HOME: skipped, output and status identical', () => {
    for (const stdin of [bash('Bash', 'ls'), bash('Bash', 'rm -rf /'), 'not json']) {
      const { a } = pair('pre-bash-guard.sh', stdin, { dropHome: true });
      assert.ok([0, 2].includes(a.status));
    }
  });
  test('a relative XDG_CONFIG_HOME is skipped', () => {
    const m = machine('relxdg', { patterns: false });
    const r = run(m, 'pre-bash-guard.sh', bash('Bash', 'ls'), { env: { XDG_CONFIG_HOME: 'rel/cfg' } });
    assert.equal(r.status, 0);
    assert.equal(fs.existsSync(path.join(m.cwd, 'rel')), false);
    assert.equal(fs.existsSync(path.join(m.home, '.config')), false);
  });
  test('without XDG_CONFIG_HOME the line lands in $HOME/.config/doflow/failures', () => {
    const m = machine('homeconfig', { patterns: false });
    const env = { ...process.env, HOME: m.home, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: '' };
    delete env.XDG_CONFIG_HOME;
    spawnSync(BASH, [path.join(m.pol, 'pre-bash-guard.sh')], { cwd: m.cwd, env, input: bash('Bash', 'ls'), encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(m.home, '.config', 'doflow', 'failures', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  });
  test('an unwritable store is silent', () => {
    const on = machine('unwritable', { patterns: false });
    const blocker = path.join(on.dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const a = run(on, 'pre-bash-guard.sh', bash('Bash', 'rm -rf /'), { env: { XDG_CONFIG_HOME: blocker } });
    const b = run(on, 'pre-bash-guard.sh', bash('Bash', 'rm -rf /'), { env: { DOFLOW_FAILURE_CAPTURE: 'off' } });
    assert.deepEqual(a, b);
    assert.equal(a.status, 2);
  });
  test('the switch: env values and the sentinel turn it off', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'No']) {
      const m = machine('switch', { patterns: false });
      run(m, 'pre-bash-guard.sh', bash('Bash', 'ls'), { env: { DOFLOW_FAILURE_CAPTURE: value } });
      assert.equal(fs.existsSync(m.failures), false, value);
    }
    const m = machine('sentinel', { patterns: false });
    fs.mkdirSync(m.failures, { recursive: true });
    fs.writeFileSync(path.join(m.failures, 'off'), 'x');
    run(m, 'pre-bash-guard.sh', bash('Bash', 'ls'), { env: { DOFLOW_FAILURE_CAPTURE: 'on' } });
    assert.deepEqual(fs.readdirSync(m.failures), ['off']);
  });
  test('a missing helper file changes nothing', () => {
    const m = machine('nohelper', { patterns: false });
    fs.rmSync(path.join(m.pol, 'capture-failure.sh'));
    const withHelper = machine('withhelper', { patterns: false });
    const a = run(m, 'pre-bash-guard.sh', bash('Bash', 'rm -rf /'));
    const b = run(withHelper, 'pre-bash-guard.sh', bash('Bash', 'rm -rf /'), { env: { DOFLOW_FAILURE_CAPTURE: 'off' } });
    assert.deepEqual(a, b);
    assert.equal(fs.existsSync(m.failures), false);
  });
  test('a hostile helper that sets -e, installs a trap, prints and exits non-zero changes nothing (the subshell isolates it)', () => {
    const hostile = (m) => fs.writeFileSync(path.join(m.pol, 'capture-failure.sh'),
      'set -euo pipefail\ntrap \'exit 9\' EXIT\ndoflow_capture_failure() { echo oops; echo err >&2; false; exit 9; }\n');
    for (const stdin of [bash('Bash', 'ls'), bash('Bash', 'rm -rf /')]) {
      const bad = machine('hostile', { patterns: false });
      hostile(bad);
      const good = machine('good', { patterns: false });
      const a = run(bad, 'pre-bash-guard.sh', stdin);
      const b = run(good, 'pre-bash-guard.sh', stdin, { env: { DOFLOW_FAILURE_CAPTURE: 'off' } });
      assert.deepEqual(a, b);
    }
  });
});

describe('mcp-tool-guard policy-file-missing', { skip: !HAS_JQ && 'jq is not installed' }, () => {
  const mcp = JSON.stringify({ tool_name: 'mcp__srv__tool', tool_input: {} });
  test('recorded once; output and status identical with capture off', () => {
    const { on, a } = pair('mcp-tool-guard.sh', mcp);
    assert.deepEqual([a.status, a.stdout, a.stderr], [0, '', '']);
    const out = lines(on);
    assert.equal(out.length, 1);
    assert.deepEqual([out[0].source, out[0].command, out[0].kind, out[0].message, out[0].frame, out[0].exit], ['hook', 'mcp-tool-guard', 'policy-file-missing', '', null, null]);
  });
  test('the single-underscore Gemini spelling is recorded too', () => {
    const { on } = pair('mcp-tool-guard.sh', JSON.stringify({ tool_name: 'mcp_srv_tool' }));
    assert.equal(lines(on).length, 1);
  });
  for (const [name, stdin] of [['malformed stdin', '{not json'], ['empty stdin', ''], ['a non-MCP tool', JSON.stringify({ tool_name: 'Bash' })]]) {
    test(`${name}: nothing recorded, output identical`, () => {
      const { on, a } = pair('mcp-tool-guard.sh', stdin);
      assert.equal(a.status, 0);
      assert.equal(lines(on).length, 0);
    });
  }
  test('with the policy file present a deny is unchanged and nothing is recorded', () => {
    const on = machine('deny-on');
    const off = machine('deny-off');
    for (const m of [on, off]) fs.writeFileSync(path.join(m.pol, 'mcp-policy.conf'), 'mcp__srv__tool\tno thanks\n');
    const a = run(on, 'mcp-tool-guard.sh', mcp);
    const b = run(off, 'mcp-tool-guard.sh', mcp, { env: { DOFLOW_FAILURE_CAPTURE: 'off' } });
    assert.deepEqual(a, b);
    assert.equal(a.status, 2);
    assert.match(a.stderr, /no thanks/);
    assert.equal(fs.existsSync(on.failures), false);
  });
  test('HOME unset: skipped, output and status identical', () => {
    const { a } = pair('mcp-tool-guard.sh', mcp, { dropHome: true });
    assert.equal(a.status, 0);
  });
});

describe('the helper (IC-018)', () => {
  const HELPER = path.join(POLICIES, 'capture-failure.sh');
  /** Sources the helper under the guards' own options and calls it. */
  function call(m, args, { env = {}, helper = HELPER, cwd = m.cwd, options = 'set -uo pipefail' } = {}) {
    const full = { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: '', ...env };
    const r = spawnSync(BASH, ['-c', `${options}; . "$1"; shift; doflow_capture_failure "$@"; echo "status=$?"`, 'x', helper, ...args], { cwd, env: full, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  }

  test('writes one line: the IC-011 fields, no output, status 0, under the guards\' set -uo pipefail', () => {
    const m = machine('h-line', { patterns: false });
    fs.mkdirSync(path.join(m.home, 'work', 'app'), { recursive: true });
    const r = call(m, ['pre-bash-guard', 'patterns-missing'], { env: { DOFLOW_AGENT: 'codex' }, cwd: path.join(m.home, 'work', 'app') });
    assert.deepEqual([r.status, r.stdout, r.stderr], [0, 'status=0\n', '']);
    const [line] = lines(m);
    assert.deepEqual(Object.keys(line), ['v', 'at', 'source', 'command', 'harness', 'version', 'project', 'kind', 'message', 'frame', 'exit']);
    assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    assert.deepEqual([line.source, line.command, line.harness, line.project, line.kind, line.message, line.frame, line.exit],
      ['hook', 'pre-bash-guard', 'codex', '~/work/app', 'patterns-missing', '', null, null]);
  });
  test('works under no options and under set -e too (it is sourced in a subshell, but must not depend on that)', () => {
    for (const options of [':', 'set -e', 'set -euo pipefail']) {
      const m = machine('h-options', { patterns: false });
      const r = call(m, ['mcp-tool-guard', 'policy-file-missing'], { options });
      assert.equal(r.stdout, 'status=0\n', options);
      assert.equal(lines(m).length, 1, options);
    }
  });
  test('script_version comes from the nearest install manifest above the helper, then the global one', () => {
    const m = machine('h-version', { patterns: false });
    const proj = path.join(m.dir, 'proj');
    fs.mkdirSync(path.join(proj, '.claude', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(proj, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(proj, '.doflow', '.install-manifest.json'), JSON.stringify({ script_version: '3.1.4', last_operation: 'install' }, null, 2));
    const copy = path.join(proj, '.claude', 'hooks', 'capture-failure.sh');
    fs.copyFileSync(HELPER, copy);
    call(m, ['pre-bash-guard', 'patterns-missing'], { helper: copy });
    assert.equal(lines(m)[0].version, '3.1.4');
    const global = machine('h-version-global', { patterns: false });
    fs.mkdirSync(path.join(global.home, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(global.home, '.doflow', '.install-manifest.json'), JSON.stringify({ script_version: '2.0.1' }, null, 2));
    const loose = path.join(global.dir, 'capture-failure.sh');
    fs.copyFileSync(HELPER, loose);
    call(global, ['pre-bash-guard', 'patterns-missing'], { helper: loose });
    assert.equal(lines(global)[0].version, '2.0.1');
    const none = machine('h-version-none', { patterns: false });
    fs.copyFileSync(HELPER, path.join(none.dir, 'capture-failure.sh'));
    call(none, ['pre-bash-guard', 'patterns-missing'], { helper: path.join(none.dir, 'capture-failure.sh') });
    assert.equal(lines(none)[0].version, 'unknown');
  });
  test('invalid policy and point names: a bad policy becomes unknown, a bad point records nothing', () => {
    const m = machine('h-names', { patterns: false });
    call(m, ['Bad Name;', 'patterns-missing']);
    call(m, ['pre-bash-guard', 'bad point"']);
    call(m, ['pre-bash-guard', '']);
    assert.deepEqual(lines(m).map((l) => [l.command, l.kind]), [['unknown', 'patterns-missing']]);
  });
  test('a working directory with quotes, backslashes, control characters and unicode stays one valid JSON line, within 1000 bytes', () => {
    const m = machine('h-escape', { patterns: false });
    const nasty = path.join(m.dir, 'we"ird\\na\tme caf\u00e9 \u4e2d');
    fs.mkdirSync(nasty);
    call(m, ['pre-bash-guard', 'patterns-missing'], { cwd: nasty });
    const raw = fs.readFileSync(m.events, 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 1);
    assert.ok(lines(m)[0].project.includes('we"ird\\na me caf'));
    assert.ok(Buffer.byteLength(raw) <= 1000);
  });
  test('a very long working directory is cut and the line stays within 1000 bytes', () => {
    const m = machine('h-long', { patterns: false });
    const long = path.join(m.dir, 'q"'.repeat(60));
    fs.mkdirSync(long, { recursive: true });
    call(m, ['pre-bash-guard', 'patterns-missing'], { cwd: long, env: { DOFLOW_AGENT: 'a'.repeat(40) } });
    assert.ok(Buffer.byteLength(fs.readFileSync(m.events, 'utf8')) <= 1000);
    assert.equal(lines(m).length, 1);
  });
  test('it appends and never rotates', () => {
    const m = machine('h-append', { patterns: false });
    fs.mkdirSync(m.failures, { recursive: true });
    fs.writeFileSync(m.events, '');
    fs.truncateSync(m.events, 1048576);
    fs.appendFileSync(m.events, '\n');
    call(m, ['pre-bash-guard', 'patterns-missing']);
    call(m, ['pre-bash-guard', 'patterns-missing']);
    assert.deepEqual(fs.readdirSync(m.failures), ['events.jsonl']);
    assert.ok(fs.statSync(m.events).size > 1048576);
  });
  test('the folder is 0700 and the new file 0600', { skip: process.platform === 'win32' }, () => {
    const m = machine('h-modes', { patterns: false });
    call(m, ['pre-bash-guard', 'patterns-missing']);
    assert.equal(fs.statSync(m.failures).mode & 0o777, 0o700);
    assert.equal(fs.statSync(m.events).mode & 0o777, 0o600);
  });
  test('it reads no stdin', () => {
    const m = machine('h-stdin', { patterns: false });
    const r = spawnSync(BASH, ['-c', '. "$1"; doflow_capture_failure pre-bash-guard patterns-missing; echo "left=$(cat)"', 'x', HELPER],
      { cwd: m.cwd, env: { ...process.env, HOME: m.home, XDG_CONFIG_HOME: m.xdg, DOFLOW_FAILURE_CAPTURE: '' }, input: 'payload-stays-here', encoding: 'utf8' });
    assert.equal(r.stdout, 'left=payload-stays-here\n');
  });
  test('the same line the Node writer would produce folds into one entry with the Node writer\'s lines', () => {
    const { fingerprint } = require('../../src/runtime/failure/store');
    const m = machine('h-fp', { patterns: false });
    call(m, ['pre-bash-guard', 'patterns-missing']);
    call(m, ['pre-bash-guard', 'patterns-missing']);
    const [a, b] = lines(m);
    assert.equal(fingerprint(a), fingerprint(b));
  });
});

describe('what the guard policies must not do (DEC-018, DEC-032)', () => {
  const read = (name) => fs.readFileSync(path.join(POLICIES, name), 'utf8');
  const code = (text) => text.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');

  for (const policy of ['pre-bash-guard.sh', 'mcp-tool-guard.sh']) {
    test(`${policy} calls the helper only as a discarded subshell, and does not source lib.sh, set -e or trap`, () => {
      const text = code(read(policy));
      assert.equal((text.match(/capture-failure\.sh/g) || []).length, 1);
      assert.match(text, /\( \. "\$\(dirname "\$0"\)\/capture-failure\.sh"; doflow_capture_failure [a-z-]+ [a-z-]+ \) >\/dev\/null 2>&1 \|\| true/);
      assert.ok(!/lib\.sh/.test(text), 'sources lib.sh');
      assert.ok(!/^\s*set\s+-[a-zA-Z]*e/m.test(text), 'sets -e');
      assert.ok(!/\btrap\b/.test(text), 'installs a trap');
      assert.match(text, /^set -uo pipefail$/m);
    });
  }
  test('the helper sets no shell option and installs no trap', () => {
    const text = code(read('capture-failure.sh'));
    assert.ok(!/^\s*set\s+[-+]/m.test(text));
    assert.ok(!/\btrap\b/.test(text));
    assert.ok(!/\bshopt\b/.test(text));
    assert.ok(!/^\s*(source|\.)\s+/m.test(text), 'the helper sources nothing');
  });
  test('no policy file under shared/hooks has a global ERR trap', () => {
    for (const name of fs.readdirSync(POLICIES).filter((f) => f.endsWith('.sh'))) {
      assert.ok(!/trap\s+[^\n]*\bERR\b/.test(read(name)), `${name} installs an ERR trap`);
    }
  });
  test('the helper file is executable like its siblings', { skip: process.platform === 'win32' }, () => {
    assert.ok((fs.statSync(path.join(POLICIES, 'capture-failure.sh')).mode & 0o111) !== 0);
  });
});
