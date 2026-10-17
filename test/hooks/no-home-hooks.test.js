'use strict';

// Feature 086, task A.2: what the shell hooks do at 2.0 when there is no usable home. Every test
// here is a `2.0-pin:` that flips in B.2 (086), when the hooks resolve the config home through one
// rule instead of `${XDG_CONFIG_HOME:-$HOME/.config}`.
//
// Isolation: every spawn is `/bin/bash` with an explicit environment (PATH, plus whatever the row
// sets; HOME is absent or unset on purpose) and a temp folder as cwd, so no hook can reach the real
// home. Cases whose code would create a folder under `/.config` are not run: the exact expression
// is cut out of the shipped file and evaluated, which writes nothing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const POSIX = process.platform !== 'win32';
const BASH = '/bin/bash';
const HARNESSES = path.resolve(__dirname, '..', '..', 'core', 'harnesses');
const POLICIES = path.join(HARNESSES, 'shared', 'hooks', 'policies');

/** Runs bash with only PATH and `extra` in its environment; the cwd is an empty temp folder. */
function bash(t, args, extra = {}) {
  const cwd = tempDir(t, 'doflow-no-home-');
  const r = spawnSync(BASH, args, { cwd, env: { PATH: process.env.PATH, ...extra }, input: '', encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, cwd, untouched: fs.readdirSync(cwd).length === 0 };
}

const UNBOUND = /: line \d+: HOME: unbound variable\n$/;

// The config-home line of each lib.sh copy and the entry points that source it.
const LIB_COPIES = [
  { name: 'shared policies', lib: path.join(POLICIES, 'lib.sh'), line: 29 },
  { name: 'claude', lib: path.join(HARNESSES, 'claude', 'hooks', 'lib.sh'), line: 21 },
  { name: 'gemini', lib: path.join(HARNESSES, 'gemini', 'hooks', 'lib.sh'), line: 21 },
  { name: 'codex', lib: path.join(HARNESSES, 'codex', 'hooks', 'lib.sh'), line: 21 },
  { name: 'kiro', lib: path.join(HARNESSES, 'kiro', 'hooks', 'lib.sh'), line: 21 },
];

const ENTRY_POINTS = [
  ['claude', 'session-end.sh'], ['claude', 'pre-compact.sh'], ['gemini', 'pre-compact.sh'],
  ['codex', 'session-end.impl.sh'], ['kiro', 'pre-bash-guard.sh'], ['kiro', 'session-start.sh'],
  ['kiro', 'stop-check.sh'], ['kiro', 'mcp-tool-guard.sh'],
];

// flips in B.2 (086)
for (const { name, lib, line } of LIB_COPIES) {
  test(`2.0-pin: ${name} lib.sh with HOME and XDG unset aborts under set -u: "HOME: unbound variable", exit 1`, { skip: !POSIX }, (t) => {
    const r = bash(t, ['-c', '. "$1"; echo reached', 'x', lib]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '', 'nothing after the source line runs');
    assert.ok(r.stderr.endsWith(`${path.basename(lib)}: line ${line}: HOME: unbound variable\n`), r.stderr);
    assert.ok(r.untouched, 'nothing was written to the cwd');
  });

  // flips in B.2 (086)
  test(`2.0-pin: ${name} lib.sh with HOME unset and a relative XDG_CONFIG_HOME takes the relative path as the config home`, { skip: !POSIX }, (t) => {
    const r = bash(t, ['-c', '. "$1"; printf "%s\\n%s\\n" "$DOFLOW_HOME" "$STATE_DIR"', 'x', lib], { XDG_CONFIG_HOME: 'rel-xdg' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'rel-xdg/doflow\nrel-xdg/doflow/session-env\n');
    assert.ok(r.untouched, 'sourcing the library creates nothing');
  });

  // control: a usable HOME makes the same source succeed
  test(`control: ${name} lib.sh with an absolute HOME resolves $HOME/.config/doflow`, { skip: !POSIX }, (t) => {
    const r = bash(t, ['-c', '. "$1"; printf "%s" "$DOFLOW_HOME"', 'x', lib], { HOME: '/nonexistent-doflow-home' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '/nonexistent-doflow-home/.config/doflow');
  });
}

// flips in B.2 (086)
for (const [harness, script] of ENTRY_POINTS) {
  test(`2.0-pin: ${harness}/hooks/${script} with HOME unset aborts in lib.sh before reading stdin, exit 1`, { skip: !POSIX }, (t) => {
    const r = bash(t, [path.join(HARNESSES, harness, 'hooks', script)]);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, UNBOUND);
    assert.match(r.stderr, /hooks\/lib\.sh: line 21: /);
    assert.ok(r.untouched);
  });
}

// flips in B.2 (086)
test('2.0-pin: lib.sh nudge_ledger_active with HOME unset (XDG relative, no DOFLOW_CONFIG_DIR) aborts at line 450', { skip: !POSIX }, (t) => {
  const r = bash(t, ['-c', '. "$1"; nudge_ledger_active "$PWD" s; echo reached', 'x', path.join(POLICIES, 'lib.sh')], { XDG_CONFIG_HOME: 'rel-xdg' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /lib\.sh: line 450: HOME: unbound variable\n$/);
  // control: the DOFLOW_CONFIG_DIR branch never reads HOME
  const ok = bash(t, ['-c', '. "$1"; nudge_ledger_active "$PWD" s && echo "rc=0" || echo "rc=$?"', 'x', path.join(POLICIES, 'lib.sh')],
    { XDG_CONFIG_HOME: 'rel-xdg', DOFLOW_CONFIG_DIR: '/nonexistent-doflow-config' });
  assert.equal(ok.stderr, '');
  assert.match(ok.stdout, /^rc=\d\n$/);
});

// flips in B.2 (086)
test('2.0-pin: summary-store.sh with HOME unset puts the session store under /.config', { skip: !POSIX }, (t) => {
  const r = bash(t, ['-c', '. "$1"; _doflow_ss_root; printf "%s" "$_DF_SS_ROOT"', 'x', path.join(POLICIES, 'summary-store.sh')]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '/.config/doflow/session-env');
  // control: a relative XDG is used as given, an absolute HOME gives $HOME/.config
  assert.equal(bash(t, ['-c', '. "$1"; _doflow_ss_root; printf "%s" "$_DF_SS_ROOT"', 'x', path.join(POLICIES, 'summary-store.sh')], { XDG_CONFIG_HOME: 'rel-xdg' }).stdout, 'rel-xdg/doflow/session-env');
  assert.equal(bash(t, ['-c', '. "$1"; _doflow_ss_root; printf "%s" "$_DF_SS_ROOT"', 'x', path.join(POLICIES, 'summary-store.sh')], { HOME: '/h' }).stdout, '/h/.config/doflow/session-env');
});

// identity.sh and emission.sh create the folder they compute when they run, so the expression is cut
// out of the shipped file (the line starting `sessions="${SESSION_DIR:-`) and evaluated, writing nothing.
for (const file of ['identity.sh', 'emission.sh']) {
  // flips in B.2 (086)
  test(`2.0-pin: ${file} with HOME unset computes the sessions folder as /.config/doflow/session-env/sessions`, { skip: !POSIX }, (t) => {
    const lines = fs.readFileSync(path.join(POLICIES, file), 'utf8').split('\n')
      .filter((line) => /^\s*sessions="\$\{SESSION_DIR:-.*\}"$/.test(line));
    assert.equal(lines.length, 1, `${file} has one sessions= line`);
    const expression = lines[0].trim();
    const run = (extra) => bash(t, ['-c', `${expression}; printf "%s" "$sessions"`], extra);
    const r = run({});
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '/.config/doflow/session-env/sessions');
    // control: SESSION_DIR, a relative XDG and an absolute HOME each change the answer
    assert.equal(run({ SESSION_DIR: '/s' }).stdout, '/s');
    assert.equal(run({ XDG_CONFIG_HOME: 'rel-xdg' }).stdout, 'rel-xdg/doflow/session-env/sessions');
    assert.equal(run({ HOME: '/h' }).stdout, '/h/.config/doflow/session-env/sessions');
  });
}
