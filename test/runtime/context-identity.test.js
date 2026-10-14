'use strict';

// 078 A.2 (IC-007): resolveIdentity() and cwdHash() against the shared identity corpus
// test/fixtures/identity/cases.json, which policies/identity.sh must also satisfy (G38.6).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { ID_PATTERN, UNKNOWN_ROLE_LINE, cwdHash, resolveIdentity, stateDir } = require('../../src/runtime/context/identity.ts');

const REPO = path.resolve(__dirname, '../..');
const LIB_SH = path.join(REPO, 'core/harnesses/shared/hooks/policies/lib.sh');
const CASES = JSON.parse(fs.readFileSync(path.join(REPO, 'test/fixtures/identity/cases.json'), 'utf8'));
const IDENTITY_VARS = ['DOFLOW_RUN_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_LINEAGE_ID', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];

/** The placeholder directories every case refers to, under one temp root. */
function layout(t) {
  const root = tempDir(t, 'doflow-identity-');
  const places = {
    $CWD: path.join(root, 'cwd'),
    $WT: path.join(root, 'wt'),
    $WT_LINK: path.join(root, 'wt-link'),
    $FILE: path.join(root, 'file.txt'),
  };
  fs.mkdirSync(places.$CWD);
  fs.mkdirSync(places.$WT);
  fs.symlinkSync(places.$WT, places.$WT_LINK);
  fs.writeFileSync(places.$FILE, 'x\n');
  return { root, places };
}

function sub(value, places) {
  if (typeof value !== 'string') return value;
  return value.replace(/\$(CWD|WT_LINK|WT|FILE)/g, (m) => places[m]);
}

function subAll(obj, places) {
  return Object.fromEntries(Object.entries(obj).map(([k, v]) => [k, Array.isArray(v) ? v : sub(v, places)]));
}

/** IC-007's bash field names, so the comparison is the one G38.6 makes against identity.sh. */
function asFields(id) {
  return {
    run: id.run, attempt: id.attempt, lineage: id.lineage, role: id.role,
    worktree: id.worktree, kind: id.lineageKind, unit: id.unitId, diagnostics: id.diagnostics,
  };
}

const quiet = () => {};

test('identity cases: the corpus covers every IC-007 row, inheritance and each invalid value', () => {
  assert.equal(CASES.idPattern, ID_PATTERN.source);
  const names = CASES.identity.map((c) => c.name).join('\n');
  for (const needle of ['unset', 'case-insensitive', 'unknown role', 'launched', 'invalid run', 'invalid lineage',
    'invalid attempt', 'worktree relative', 'worktree missing', 'run local explicit']) {
    assert.ok(names.includes(needle), `no identity case mentions "${needle}"`);
  }
  for (const v of IDENTITY_VARS) {
    assert.ok(CASES.identity.some((c) => v in c.env), `no case sets ${v}`);
  }
  assert.ok(CASES.binding.some((s) => s.events.some((e) => e.expect.diagnostics.includes('identity-inherited'))));
  for (const kind of ['launched', 'default-main', 'solo']) {
    assert.ok(CASES.identity.some((c) => c.expect.kind === kind), `no case expects kind ${kind}`);
  }
});

for (const c of CASES.identity) {
  test(`identity case: ${c.name}`, (t) => {
    const { root, places } = layout(t);
    const env = { XDG_CONFIG_HOME: path.join(root, 'config'), ...subAll(c.env, places) };
    const id = resolveIdentity(env, { cwd: sub(c.cwd, places), sessionId: c.sessionId, warn: quiet });
    assert.deepEqual(asFields(id), subAll(c.expect, places));
    assert.equal(id.session, c.sessionId);
  });
}

for (const s of CASES.binding) {
  test(`binding sequence: ${s.name}`, (t) => {
    const { root, places } = layout(t);
    const config = path.join(root, 'config');
    const sessions = path.join(stateDir({ XDG_CONFIG_HOME: config }), 'sessions');
    for (const [i, e] of s.events.entries()) {
      const env = { XDG_CONFIG_HOME: config, ...subAll(s.env, places), ...subAll(e.env || {}, places) };
      const id = resolveIdentity(env, { cwd: sub(e.cwd, places), sessionId: e.sessionId, bind: true, warn: quiet });
      assert.deepEqual(asFields(id), subAll(e.expect, places), `event ${i}`);
      if (e.bound === null) {
        const found = fs.existsSync(sessions)
          ? fs.readdirSync(sessions, { recursive: true }).filter((f) => path.basename(f) === 'bound') : [];
        assert.deepEqual(found, [], `event ${i}: no bound file expected`);
      } else {
        const unit = `L.${env.DOFLOW_RUN_ID}.${env.DOFLOW_LINEAGE_ID}.${env.DOFLOW_ATTEMPT}`;
        const text = fs.readFileSync(path.join(sessions, unit, 'bound'), 'utf8');
        assert.equal(text.replace(/\n$/, ''), e.bound, `event ${i}`);
      }
    }
  });
}

test('binding: bind false never touches the store', (t) => {
  const { root, places } = layout(t);
  const env = { XDG_CONFIG_HOME: path.join(root, 'config'), DOFLOW_RUN_ID: 'r', DOFLOW_ATTEMPT: '1', DOFLOW_LINEAGE_ID: 'l' };
  const id = resolveIdentity(env, { cwd: places.$CWD, sessionId: 's' });
  assert.equal(id.lineageKind, 'launched');
  assert.equal(fs.existsSync(path.join(root, 'config')), false);
});

test('binding: a bound file written by bash without a trailing newline still matches', (t) => {
  const { root, places } = layout(t);
  const env = { XDG_CONFIG_HOME: path.join(root, 'config'), DOFLOW_RUN_ID: 'r', DOFLOW_ATTEMPT: '1', DOFLOW_LINEAGE_ID: 'l' };
  const dir = path.join(stateDir(env), 'sessions', 'L.r.l.1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'bound'), 's');
  assert.equal(resolveIdentity(env, { cwd: places.$CWD, sessionId: 's', bind: true }).lineageKind, 'launched');
  assert.equal(fs.readFileSync(path.join(dir, 'bound'), 'utf8'), 's');
});

test('role: the unknown-role line goes to stderr once per process, never stdout', () => {
  const script = `const { resolveIdentity } = require(${JSON.stringify(path.join(REPO, 'src/runtime/context/identity.ts'))});
for (const r of ['boss', 'other', 'MAIN', 'boss']) resolveIdentity({ DOFLOW_SESSION_ROLE: r }, { cwd: '/', sessionId: 's' });`;
  const r = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
  assert.equal(r.stderr, UNKNOWN_ROLE_LINE);
  assert.equal(UNKNOWN_ROLE_LINE, '[doflow] unknown DOFLOW_SESSION_ROLE; treating session as worker\n');
});

test('store root matches policies/lib.sh STATE_DIR', () => {
  assert.equal(stateDir({ XDG_CONFIG_HOME: '/x/cfg', HOME: '/h' }), '/x/cfg/doflow/session-env');
  assert.equal(stateDir({ HOME: '/h' }), '/h/.config/doflow/session-env');
  assert.equal(stateDir({ XDG_CONFIG_HOME: '', HOME: '/h' }), '/h/.config/doflow/session-env');
  const r = spawnSync('/bin/bash', ['-c', 'source "$1"; printf "%s" "$STATE_DIR"', 'x', LIB_SH],
    { env: { PATH: process.env.PATH, HOME: '/h', XDG_CONFIG_HOME: '' }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, stateDir({ HOME: '/h', XDG_CONFIG_HOME: '' }));
});

for (const c of CASES.cwdHash) {
  test(`cwdHash corpus: ${JSON.stringify(c.path)}`, () => {
    assert.equal(cwdHash(c.path), c.hash);
  });
}

test('cwdHash equals bash cwd_hash on live paths: directory, symlinked directory, file, symlinked file, dangling link', (t) => {
  const { root, places } = layout(t);
  fs.symlinkSync(places.$FILE, path.join(root, 'file-link'));
  fs.symlinkSync(path.join(root, 'gone'), path.join(root, 'dangling'));
  const paths = [places.$CWD, places.$WT_LINK, `${places.$WT_LINK}/`, places.$FILE,
    path.join(root, 'file-link'), path.join(root, 'dangling'), path.join(root, 'cwd', '..', 'wt')];
  const r = spawnSync('/bin/bash', ['-c', 'source "$1"; shift; for p in "$@"; do cwd_hash "$p"; done', 'x', LIB_SH, ...paths],
    { env: { PATH: process.env.PATH, HOME: root }, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(paths.map(cwdHash), r.stdout.trim().split('\n'));
});
