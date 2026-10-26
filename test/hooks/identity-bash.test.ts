'use strict';

// The bash identity source policies/identity.sh (feature 078, IC-007, IC-009): every IC-007 row,
// the unknown-role diagnostic, binding and inheritance, invalid ids, what sourcing the file does, and
// the harness lib.sh fallback when an install lacks identity.sh. Runs under macOS /bin/bash 3.2.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const REPO = path.resolve(__dirname, '..', '..');
const POLICIES = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies');
const IDENTITY = path.join(POLICIES, 'identity.sh');
const BASH = process.platform === 'darwin' ? '/bin/bash' : 'bash';
const DIAGNOSTIC = '[doflow] unknown DOFLOW_SESSION_ROLE; treating session as worker';
const FIELDS: any = ['RUN', 'ATTEMPT', 'LINEAGE', 'ROLE', 'WORKTREE', 'KIND', 'UNIT'];
const CLEAR: any = { DOFLOW_RUN_ID: '', DOFLOW_ATTEMPT: '', DOFLOW_LINEAGE_ID: '', DOFLOW_SESSION_ROLE: '', DOFLOW_WORKTREE: '', DOFLOW_FAILURE_CAPTURE: '' };

const scratch = createScratch('doflow-identity-bash-');
const SESSIONS = path.join(scratch.xdg, 'doflow', 'session-env', 'sessions');
const FAILURES = path.join(scratch.xdg, 'doflow', 'failures', 'events.jsonl');
test.after(() => scratch.remove());

let seq = 0;
function dir(name: any) {
  const d = path.join(scratch.dir, `${name}${seq++}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

/** Runs `body` after sourcing identity.sh under `set -euo pipefail`, as the policy named `policy`. */
function sh(body: any, env: any = {}, args: any = [], policy: any = 'user-prompt-submit.sh') {
  const script = `set -euo pipefail\n. "${IDENTITY}"\n${body}`;
  return spawnSync(BASH, ['-c', script, policy, ...args], { env: scratch.env({ ...CLEAR, ...env }), encoding: 'utf8' });
}

/** doflow_identity <sid> <cwd> once; returns the DF_ID_* fields, stdout and stderr. */
function identity(sid: any, cwd: any, env: any = {}) {
  const print = FIELDS.map((f: any) => `printf '%s=%s\\n' ${f} "$DF_ID_${f}"`).join('\n');
  const r: any = sh(`doflow_identity "$1" "$2"\n${print}`, env, [sid, cwd]);
  assert.equal(r.status, 0, r.stderr);
  const id: any = {};
  for (const line of r.stdout.trim().split('\n')) {
    const at = line.indexOf('=');
    id[line.slice(0, at).toLowerCase()] = line.slice(at + 1);
  }
  return { id, stderr: r.stderr };
}

function failures(kind: any) {
  if (!fs.existsSync(FAILURES)) return [];
  return fs.readFileSync(FAILURES, 'utf8').trim().split('\n').filter(Boolean).map((l: any) => JSON.parse(l)).filter((e: any) => e.kind === kind);
}
function clearFailures() { fs.rmSync(FAILURES, { force: true }); }
function sessionEntries() { return fs.existsSync(SESSIONS) ? fs.readdirSync(SESSIONS).sort() : []; }

// ── IC-007 rows ─────────────────────────────────────────────────────────────────────────────────

test('unset role is main, default-main, from the launcher variables only, never the payload', () => {
  // The payload looks like a worker's (a worktrees path, an agent-shaped session id); it must not matter.
  const cwd = dir('repo/.claude/worktrees/agent-x');
  const { id, stderr } = identity('agent-a1b2', cwd);
  assert.deepEqual(id, { run: 'local', attempt: '', lineage: 'main', role: 'main', worktree: cwd, kind: 'default-main', unit: 'agent-a1b2' });
  assert.equal(stderr, '');
});

test('role is case-insensitive; worker defaults its lineage to solo', () => {
  const cwd = dir('p');
  assert.equal(identity('s1', cwd, { DOFLOW_SESSION_ROLE: 'MaIn' }).id.kind, 'default-main');
  const { id, stderr } = identity('s1', cwd, { DOFLOW_SESSION_ROLE: 'WORKER' });
  assert.deepEqual(id, { run: 'local', attempt: '', lineage: 'solo', role: 'worker', worktree: cwd, kind: 'solo', unit: 's1' });
  assert.equal(stderr, '');
});

test('an unknown role is worker and prints the diagnostic once per process', () => {
  const cwd = dir('p');
  const r = sh(`doflow_identity s1 '${cwd}'; doflow_identity s1 '${cwd}'; doflow_session_role; echo "R=$DF_ID_ROLE"`, { DOFLOW_SESSION_ROLE: 'boss' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'worker\nR=worker\n');
  assert.equal(r.stderr, `${DIAGNOSTIC}\n`);
});

test('doflow_session_role keeps its output and diagnostic text', () => {
  for (const [role, out, err] of [['', 'main', ''], ['main', 'main', ''], ['Worker', 'worker', ''], ['x', 'worker', `${DIAGNOSTIC}\n`]]) {
    const r = sh('r=$(doflow_session_role); printf "%s\\n" "$r"', { DOFLOW_SESSION_ROLE: role });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, `${out}\n`, `role ${JSON.stringify(role)}`);
    assert.equal(r.stderr, err, `role ${JSON.stringify(role)}`);
  }
});

test('run, lineage and attempt all valid is launched with unit L.<run>.<lineage>.<attempt>, bound to the session', () => {
  const cwd = dir('p');
  const run = `R${'x'.repeat(55)}`; // 56 characters, the DEC-024 maximum
  const { id }: any = identity('sess-1', cwd, { DOFLOW_RUN_ID: run, DOFLOW_LINEAGE_ID: 'lin_1-a', DOFLOW_ATTEMPT: '9999', DOFLOW_SESSION_ROLE: 'worker' });
  assert.deepEqual(id, { run, attempt: '9999', lineage: 'lin_1-a', role: 'worker', worktree: cwd, kind: 'launched', unit: `L.${run}.lin_1-a.9999` });
  assert.equal(fs.readFileSync(path.join(SESSIONS, id.unit, 'bound'), 'utf8'), 'sess-1\n');
});

test('an invalid attempt is as unset: not launched, nothing bound', () => {
  const cwd = dir('p');
  for (const attempt of ['0', '10000', '01', '1.5', 'abc', '-1']) {
    const { id }: any = identity('s-att', cwd, { DOFLOW_RUN_ID: 'runA', DOFLOW_LINEAGE_ID: 'linA', DOFLOW_ATTEMPT: attempt });
    assert.equal(id.attempt, '', attempt);
    assert.equal(id.kind, 'solo', attempt);
    assert.equal(id.unit, 's-att', attempt);
  }
  assert.ok(!sessionEntries().some((e: any) => e.startsWith('L.runA.')), 'an unlaunched unit was bound');
});

test('an invalid run is unlaunched with lineage solo, is captured, and never reaches a path', () => {
  const cwd = dir('p');
  const before = sessionEntries();
  for (const run of ['local', '../evil', 'a.b', 'a/b', '-lead', `R${'x'.repeat(56)}`, 'sp ace']) {
    clearFailures();
    const r = sh(`doflow_identity s-bad '${cwd}'; echo "$DF_ID_RUN $DF_ID_LINEAGE $DF_ID_KIND $DF_ID_UNIT"`,
      { DOFLOW_RUN_ID: run, DOFLOW_LINEAGE_ID: 'linB', DOFLOW_ATTEMPT: '1' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'local solo solo s-bad\n', run);
    assert.equal(r.stderr, '', run);
    const caught = failures('identity-invalid');
    assert.equal(caught.length, 1, run);
    assert.equal(caught[0].command, 'user-prompt-submit');
  }
  assert.deepEqual(sessionEntries(), before);
});

test('an invalid lineage is solo, is captured, and never reaches a path', () => {
  const cwd = dir('p');
  const before = sessionEntries();
  for (const lineage of ['../up', 'x.y', '_lead', `L${'y'.repeat(56)}`]) {
    clearFailures();
    const { id, stderr }: any = identity('s-lin', cwd, { DOFLOW_RUN_ID: 'runC', DOFLOW_LINEAGE_ID: lineage, DOFLOW_ATTEMPT: '1' });
    assert.deepEqual([id.run, id.lineage, id.kind, id.unit], ['runC', 'solo', 'solo', 's-lin'], lineage);
    assert.equal(stderr, '');
    assert.equal(failures('identity-invalid').length, 1, lineage);
  }
  assert.deepEqual(sessionEntries(), before);
});

test('a valid run without a lineage or attempt is solo; a valid launch captures nothing', () => {
  const cwd = dir('p');
  clearFailures();
  assert.deepEqual(identity('s2', cwd, { DOFLOW_RUN_ID: 'runD' }).id, { run: 'runD', attempt: '', lineage: 'main', role: 'main', worktree: cwd, kind: 'solo', unit: 's2' });
  assert.equal(identity('s2', cwd, { DOFLOW_RUN_ID: 'runD', DOFLOW_LINEAGE_ID: 'l', DOFLOW_ATTEMPT: '3' }).id.kind, 'launched');
  assert.equal(failures('identity-invalid').length, 0);
});

test('worktree: an absolute existing directory canonicalised, else the payload cwd', () => {
  const cwd = dir('p');
  const real = dir('wt');
  const link = path.join(scratch.dir, `wt-link${seq++}`);
  fs.symlinkSync(real, link);
  assert.equal(identity('s', cwd, { DOFLOW_WORKTREE: link }).id.worktree, real);
  assert.equal(identity('s', cwd, { DOFLOW_WORKTREE: `${real}/` }).id.worktree, real);
  assert.equal(identity('s', cwd, { DOFLOW_WORKTREE: 'relative/dir' }).id.worktree, cwd);
  assert.equal(identity('s', cwd, { DOFLOW_WORKTREE: path.join(real, 'missing') }).id.worktree, cwd);
  const file = path.join(real, 'f');
  fs.writeFileSync(file, '');
  assert.equal(identity('s', cwd, { DOFLOW_WORKTREE: file }).id.worktree, cwd);
});

// ── The shared IC-007 corpus (G38.6): every case in test/fixtures/identity/cases.json ───────────

const CASES = JSON.parse(fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'identity', 'cases.json'), 'utf8'));

/** A fresh store root and the cases.json placeholders under it ($CWD, $WT, $WT_LINK, $FILE). */
function corpusLayout() {
  const root = dir('corpus');
  const places: any = { $CWD: path.join(root, 'cwd'), $WT: path.join(root, 'wt'), $WT_LINK: path.join(root, 'wt-link'), $FILE: path.join(root, 'file.txt') };
  fs.mkdirSync(places.$CWD);
  fs.mkdirSync(places.$WT);
  fs.symlinkSync(places.$WT, places.$WT_LINK);
  fs.writeFileSync(places.$FILE, 'x\n');
  const config = path.join(root, 'config');
  fs.mkdirSync(config);
  return { places, config };
}
const subst = (v: any, places: any) => (typeof v === 'string' ? v.replace(/\$(CWD|WT_LINK|WT|FILE)/g, (m) => places[m]) : v);

/** The DEC-044 store setups a binding event may name (see the cases.json comment). */
function applySetup(setup: any, sessions: any, unit: any, sessionId: any) {
  if (setup === undefined) return;
  const bound = path.join(sessions, unit, 'bound');
  if (setup === 'store-unwritable') {
    fs.mkdirSync(path.dirname(sessions), { recursive: true });
    fs.writeFileSync(sessions, '');
  } else if (setup === 'bound-symlink') {
    const target = path.join(dir('bound-target'), 'bound');
    fs.writeFileSync(target, `${sessionId}\n`);
    fs.mkdirSync(path.dirname(bound), { recursive: true });
    fs.symlinkSync(target, bound);
  } else if (setup === 'bound-empty') {
    fs.mkdirSync(path.dirname(bound), { recursive: true });
    fs.writeFileSync(bound, '');
  } else {
    throw new Error(`unknown binding setup ${setup}`);
  }
}
const substAll = (o: any, places: any) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Array.isArray(v) ? v : subst(v, places)]));

/** One doflow_identity call in its own process, as one hook event; diagnostics as cases.json names them. */
function corpusEvent(config: any, env: any, sid: any, cwd: any) {
  const events = path.join(config, 'doflow', 'failures', 'events.jsonl');
  const read = () => (fs.existsSync(events) ? fs.readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((l: any) => JSON.parse(l).kind) : []);
  const before = read().length;
  const { id, stderr } = identity(sid, cwd, { XDG_CONFIG_HOME: config, SESSION_DIR: '', ...env });
  const codes: any = new Set(read().slice(before));
  if (stderr === `${DIAGNOSTIC}\n`) codes.add('role-unknown');
  else assert.equal(stderr, '', 'unexpected stderr');
  return { ...id, diagnostics: [...codes].sort() };
}

for (const c of CASES.identity) {
  test(`corpus identity case: ${c.name}`, () => {
    const { places, config } = corpusLayout();
    const got = corpusEvent(config, substAll(c.env, places), c.sessionId, subst(c.cwd, places));
    assert.deepEqual(got, substAll(c.expect, places));
  });
}

for (const s of CASES.binding) {
  test(`corpus binding sequence: ${s.name}`, () => {
    const { places, config } = corpusLayout();
    const sessions = path.join(config, 'doflow', 'session-env', 'sessions');
    for (const [i, e] of s.events.entries()) {
      const env: any = { ...substAll(s.env, places), ...substAll(e.env || {}, places) };
      const unit = `L.${env.DOFLOW_RUN_ID}.${env.DOFLOW_LINEAGE_ID}.${env.DOFLOW_ATTEMPT}`;
      applySetup(e.setup, sessions, unit, e.sessionId);
      assert.deepEqual(corpusEvent(config, env, e.sessionId, subst(e.cwd, places)), substAll(e.expect, places), `event ${i}`);
      if (e.bound === null) {
        const isDir = fs.existsSync(sessions) && fs.statSync(sessions).isDirectory();
        const found = isDir ? fs.readdirSync(sessions, { recursive: true }).filter((f: any) => path.basename(f) === 'bound') : [];
        assert.deepEqual(found, [], `event ${i}: no bound file expected`);
      } else {
        assert.equal(fs.readFileSync(path.join(sessions, unit, 'bound'), 'utf8').replace(/\n$/, ''), e.bound, `event ${i}`);
      }
    }
  });
}

// ── Binding and inheritance (DEC-008) ───────────────────────────────────────────────────────────

test('the binding session stays launched; a different session is inherited solo, keeps its role, captured once', () => {
  const cwd = dir('p');
  const env: any = { DOFLOW_RUN_ID: 'runE', DOFLOW_LINEAGE_ID: 'linE', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker' };
  clearFailures();
  assert.equal(identity('first', cwd, env).id.kind, 'launched');
  assert.equal(identity('first', cwd, env).id.kind, 'launched', 'the bound session on a later event');
  assert.equal(fs.readFileSync(path.join(SESSIONS, 'L.runE.linE.1', 'bound'), 'utf8'), 'first\n');

  const r = sh(`doflow_identity second '${cwd}'; doflow_identity second '${cwd}'; echo "$DF_ID_KIND $DF_ID_LINEAGE $DF_ID_ROLE $DF_ID_UNIT"`, env);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'solo solo worker second\n');
  assert.equal(failures('identity-inherited').length, 1);
  assert.equal(fs.readFileSync(path.join(SESSIONS, 'L.runE.linE.1', 'bound'), 'utf8'), 'first\n', 'bound is never rewritten');
  assert.ok(!sessionEntries().includes('second'), 'identity creates no directory for an inherited session');
});

test('L1-12 an unreadable bound file is inherited without a word on stderr', { skip: process.getuid?.() === 0 && 'root reads mode 000' }, () => {
  const cwd = dir('p');
  const env: any = { DOFLOW_RUN_ID: 'runU', DOFLOW_LINEAGE_ID: 'linU', DOFLOW_ATTEMPT: '1' };
  const unit = path.join(SESSIONS, 'L.runU.linU.1');
  fs.mkdirSync(unit, { recursive: true });
  fs.writeFileSync(path.join(unit, 'bound'), 'other\n', { mode: 0o000 });
  try {
    const r: any = identity('mine', cwd, env);
    assert.equal(r.stderr, '');
    assert.equal(r.id.kind, 'solo');
  } finally {
    fs.chmodSync(path.join(unit, 'bound'), 0o600);
  }
});

test('binding leaves the caller\'s noclobber setting as it found it', () => {
  const cwd = dir('p');
  const env: any = { DOFLOW_RUN_ID: 'runF', DOFLOW_LINEAGE_ID: 'linF', DOFLOW_ATTEMPT: '1' };
  const off = sh(`doflow_identity s '${cwd}'; case $- in *C*) echo on;; *) echo off;; esac`, env);
  assert.equal(off.stdout, 'off\n');
  const on = sh(`set -C; doflow_identity s '${cwd}'; case $- in *C*) echo on;; *) echo off;; esac`, env);
  assert.equal(on.stdout, 'on\n');
});

// ── Sourcing and the single definition (IC-009) ─────────────────────────────────────────────────

test('sourcing identity.sh prints nothing, sets no option or variable, and defines functions only', () => {
  const snap = 'set -o; shopt; echo "flags=$-"; trap -p; compgen -v | grep -v "^_$\\|^BASH_\\|^FUNCNAME$\\|^PIPESTATUS$\\|^LINENO$\\|^RANDOM$\\|^SECONDS$\\|^[FS][12]$" | sort';
  const r = spawnSync(BASH, ['-c', `set -euo pipefail; F1=$(declare -F); S1=$(${snap}); . "$1" >out 2>err; F2=$(declare -F); S2=$(${snap})
    [ "$S1" = "$S2" ] || { echo STATE-CHANGED; diff <(echo "$S1") <(echo "$S2"); }
    cat out err; diff <(echo "$F1") <(echo "$F2") | sed -n 's/^> declare -f //p'`, 'bash', IDENTITY],
  { cwd: dir('src'), env: scratch.env(CLEAR), encoding: 'utf8' });
  assert.equal(r.status, 1, r.stderr); // diff exits 1 because functions were added
  assert.deepEqual(r.stdout.trim().split('\n').sort(), ['_doflow_identity_capture', '_doflow_role_resolve', 'doflow_identity', 'doflow_session_role']);
});

test('identity.sh is the only definition of doflow_session_role and doflow_identity', () => {
  const found: any = [];
  const walk = (d: any) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.sh$/.test(e.name) && /^\s*doflow_(session_role|identity)\(\)/m.test(fs.readFileSync(p, 'utf8'))) found.push(path.relative(REPO, p));
    }
  };
  walk(path.join(REPO, 'core', 'harnesses'));
  // The harness copies carry only the IC-009 broken-install fallback, inside the else branch.
  assert.deepEqual(found.sort(), [
    'core/harnesses/claude/hooks/lib.sh', 'core/harnesses/codex/hooks/lib.sh',
    'core/harnesses/shared/hooks/policies/identity.sh']);
  for (const h of ['claude', 'codex']) {
    const text = fs.readFileSync(path.join(REPO, 'core', 'harnesses', h, 'hooks', 'lib.sh'), 'utf8');
    assert.match(text, /^ {2}\. "\$\{BASH_SOURCE\[0\]%\/\*\}\/\.\.\/\.\.\/\.doflow\/shared\/hooks\/policies\/identity\.sh"$/m, h);
    assert.ok(!/DOFLOW_SESSION_ROLE/.test(text), `${h} lib.sh still reads DOFLOW_SESSION_ROLE itself`);
  }
  const lib = fs.readFileSync(path.join(POLICIES, 'lib.sh'), 'utf8');
  assert.match(lib, /^\. "\$_DOFLOW_LIB_DIR\/identity\.sh"$/m);
  assert.ok(!/doflow_session_role\(\)|DOFLOW_SESSION_ROLE/.test(lib), 'policies/lib.sh keeps an inline copy');
});

test('policies/lib.sh provides both functions through identity.sh', () => {
  const r = spawnSync(BASH, ['-c', `. "$1"; doflow_session_role; doflow_identity s "$PWD"; echo "$DF_ID_KIND"`, 'bash', path.join(POLICIES, 'lib.sh')],
    { cwd: dir('lib'), env: scratch.env({ ...CLEAR, DOFLOW_SESSION_ROLE: 'worker' }), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'worker\nsolo\n');
});

// ── Harness lib.sh in an install mirror ─────────────────────────────────────────────────────────

test('harness lib.sh uses identity.sh when installed, and falls back to worker with identity-missing when it is absent', () => {
  const mirror = path.join(scratch.dir, 'mirror');
  const built = spawnSync('bash', [path.join(REPO, 'test', 'hooks', 'build-install-mirror.sh'), mirror], { encoding: 'utf8' });
  assert.equal(built.status, 0, built.stderr);
  const role = (h: any) => spawnSync(BASH, ['-c', '. "$1"; doflow_session_role', 'post-compact.sh', path.join(mirror, `.${h}`, 'hooks', 'lib.sh')],
    { env: scratch.env({ ...CLEAR, DOFLOW_SESSION_ROLE: 'main' }), encoding: 'utf8' });

  for (const h of ['claude', 'codex']) {
    const r = role(h);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'main\n', h);
  }
  fs.rmSync(path.join(mirror, '.doflow', 'shared', 'hooks', 'policies', 'identity.sh'));
  for (const h of ['claude', 'codex']) {
    clearFailures();
    const r = role(h);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'worker\n', h);
    assert.equal(r.stderr, '', h);
    const caught = failures('identity-missing');
    assert.equal(caught.length, 1, h);
    assert.equal(caught[0].command, 'post-compact');
  }
});
