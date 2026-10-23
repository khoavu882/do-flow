'use strict';

// 078 review batch A — fault paths of the hook emission adapter (policies/emission.sh) and the
// summary store (DEC-038..043): lost claim races, slot release on a fault, the warning claimed by
// rename, the optional-dropped ledger, the nudge marked after render, the session id check for
// every lineage kind, grants for launched units only, and the private truncated summary.
// Driven under /bin/bash (3.2 on macOS) with a temp XDG_CONFIG_HOME. EM_POLICIES points the suite
// at another policies directory, which is how each case is shown failing against the old code.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { spawnBash } = require('../helper/home-less-bash');

const REPO = path.resolve(__dirname, '..', '..');
const POLICIES = process.env.EM_POLICIES || path.join(REPO, 'core/harnesses/shared/hooks/policies');
const GRANT_ID = 's-20261014T100000Z-Ab12Cd';
const GIT = { is_git_repo: true, branch: 'topic', sha: 'abc1234', commits: ['one'], uncommitted_count: 0, stash_count: 0 };
const GIT_TEXT = 'Git context — branch: topic | abc1234\nLast commits: one\nUncommitted files: 0';
const AS_ROOT = process.getuid?.() === 0;
const LAUNCHED = { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'l1', DOFLOW_ATTEMPT: '1' };
const LAUNCHED_UNIT = 'L.r1.l1.1';

const DRIVER = [
  'set -euo pipefail',
  'P=$1',
  '. "$P/lib.sh"',
  '. "$P/summary-store.sh"',
  '. "$P/emission-rules.sh"',
  '. "$P/emission.sh"',
  'if [ -n "${EM_SETUP:-}" ]; then eval "$EM_SETUP"; fi',
  'if [ -n "${EM_CALL:-}" ]; then eval "$EM_CALL"; else',
  '  doflow_emit_prompt "$EM_SID" "$EM_CWD" "" "" "${EM_NUDGE:-}"',
  'fi',
  'printf \'%s\\n\' "${DF_EMIT_REASON:-}" >"$EM_ROOT/reason"',
  '',
].join('\n');

// Wraps a store function: `$1` runs before the real one.
const before = (fn, body) => `eval "_em_real_${fn}() $(declare -f ${fn} | sed 1d)"\n`
  + `${fn}() { ${body}; _em_real_${fn} "$@"; }\n`;

const SUMMARY = (run = 'local', lineage = 'main', body = 'Prior work body') =>
  `doflow_summary_write "$EM_CWD" ${run} ${lineage} "" 2026-10-14T09:00:00Z other-session manual topic main "${body}"\n`;
const WARNING = 'p=$(ensure_project_dir "$EM_CWD"); printf \'two files uncommitted\\n\' >"$p/uncommitted-warning.txt"\n';

function world(t) {
  const root = tempDir(t, 'doflow-emission-faults-');
  const w = { root, home: path.join(root, 'home'), xdg: path.join(root, 'config'), cwd: path.join(root, 'work') };
  w.sessions = path.join(w.xdg, 'doflow/session-env/sessions');
  w.store = path.join(w.xdg, 'doflow/session-env');
  w.driver = path.join(root, 'driver.sh');
  for (const dir of [w.home, w.xdg, w.cwd]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(w.driver, DRIVER);
  return w;
}

function run(w, sid, env = {}) {
  const r = spawnBash([w.driver, POLICIES], {
    encoding: 'utf8',
    cwd: w.cwd,
    env: {
      HOME: w.home,
      XDG_CONFIG_HOME: w.xdg,
      PATH: process.env.PATH,
      TMPDIR: process.env.TMPDIR || '/tmp',
      EM_ROOT: w.root,
      EM_SID: sid,
      EM_CWD: w.cwd,
      DOFLOW_AGENT: 'claude',
      ...env,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  const reasonFile = path.join(w.root, 'reason');
  const reason = fs.existsSync(reasonFile) ? fs.readFileSync(reasonFile, 'utf8').trim() : '';
  return { out: r.stdout, err: r.stderr, reason };
}

const ctx = (out) => (out.trim() === '{}' ? '' : JSON.parse(out).hookSpecificOutput.additionalContext);

function writeGit(w, sid) {
  fs.mkdirSync(path.join(w.sessions, sid), { recursive: true });
  fs.writeFileSync(path.join(w.sessions, sid, 'git-context.json'), JSON.stringify(GIT));
}

function writeGrant(w, run, lineage, body = 'Granted body') {
  const dir = path.join(w.store, 'grants', run, lineage);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${GRANT_ID}.md`);
  fs.writeFileSync(file, `---\nsummary_id: ${GRANT_ID}\nfrom_lineage: l0\n---\n\n${body}\n`);
  return file;
}

function find(dir, pred) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) found.push(...find(full, pred));
    else if (pred(e.name)) found.push(full);
  }
  return found;
}

const summaries = (w) => find(path.join(w.store, 'summaries'), (n) => n === 'summary.md');
const captures = (w) => {
  const file = path.join(w.xdg, 'doflow/failures/events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const ledger = (w, unit) => {
  const file = path.join(w.sessions, unit, 'emitted');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t').slice(1)) : [];
};

test('L1-01: a summary lost between peek and claim still bootstraps with git context; the next prompt is silent', (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  const steal = before('doflow_summary_claim', 'rm -f "$DF_SUMMARY_FILE"');
  const first = run(w, 'sess-1', { EM_SETUP: SUMMARY() + steal });
  assert.equal(first.reason, 'emit');
  assert.equal(ctx(first.out), GIT_TEXT);
  assert.equal(run(w, 'sess-1').out, '{}\n');
});

test('L1-01: a grant lost between peek and claim still bootstraps with git context; the next prompt is silent', (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  const grant = writeGrant(w, 'r1', 'l1');
  const steal = before('doflow_grant_claim', `rm -f "${grant}"`);
  const first = run(w, 'sess-1', { ...LAUNCHED, EM_SETUP: steal });
  assert.equal(first.reason, 'emit');
  assert.equal(ctx(first.out), GIT_TEXT);
  assert.equal(run(w, 'sess-1', LAUNCHED).out, '{}\n');
});

test('L1-01: an unwritable scope gives {} with no slot left, and the next writable prompt bootstraps', { skip: AS_ROOT && 'root writes any folder' }, (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  run(w, 'seed', { EM_CALL: SUMMARY() });
  const [file] = summaries(w);
  const scope = path.dirname(file);
  fs.chmodSync(scope, 0o555);
  try {
    const first = run(w, 'sess-1');
    assert.equal(first.out, '{}\n');
    assert.equal(first.reason, 'fault:summary');
    assert.equal(fs.existsSync(path.join(w.sessions, 'sess-1', 'injected')), false, 'the slot is released');
    assert.ok(captures(w).some((c) => c.kind === 'emission-summary'));
  } finally { fs.chmodSync(scope, 0o755); }
  const next = run(w, 'sess-1');
  assert.equal(ctx(next.out), `${GIT_TEXT}\n\n[Prior session summary, compacted 2026-10-14T09:00:00Z on branch topic]\nPrior work body`);
});

test('L1-03: an unreadable warning renders no empty warning and writes nothing to stderr', { skip: AS_ROOT && 'root reads any file' }, (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  const lock = WARNING + 'chmod 000 "$p/uncommitted-warning.txt"\n';
  const r = run(w, 'sess-1', { EM_SETUP: lock });
  assert.doesNotMatch(r.out, /Prior session warning/);
  assert.equal(r.err, '');
  for (const f of find(path.join(w.store, 'projects'), (n) => n.startsWith('uncommitted-warning'))) fs.chmodSync(f, 0o644);
});

test('L1-03: two first prompts deliver the warning once, and both bootstrap', (t) => {
  const w = world(t);
  writeGit(w, 'sess-a');
  writeGit(w, 'sess-b');
  // sess-b runs its whole first prompt while sess-a sits between its state read and its claims.
  const race = before('doflow_summary_peek',
    'if [ -z "${_em_nested:-}" ]; then _em_nested=1; ( doflow_emit_prompt sess-b "$EM_CWD" "" "" "" ) >"$EM_ROOT/b.out" 2>&1; fi');
  const a = run(w, 'sess-a', { EM_SETUP: WARNING + race });
  const b = fs.readFileSync(path.join(w.root, 'b.out'), 'utf8');
  assert.match(ctx(b), /\[Prior session warning: two files uncommitted\]/);
  assert.equal(a.reason, 'emit', 'the loser bootstraps without the warning');
  assert.equal(ctx(a.out), GIT_TEXT);
  assert.deepEqual(find(path.join(w.store, 'projects'), (n) => n.startsWith('uncommitted-warning')), []);
});

test('L2-01: a summary over the budget writes one optional-dropped line; a repeat writes none', (t) => {
  const w = world(t);
  const env = { DOFLOW_CONTEXT_MAX_BYTES: '120' };
  run(w, 'seed', { EM_CALL: SUMMARY('local', 'main', 'x'.repeat(500)) });
  const [file] = summaries(w);
  const bytes = fs.readFileSync(file);
  const sid = /summary_id: (\S+)/.exec(bytes.toString())[1];
  const first = run(w, 'sess-1', env);
  assert.equal(ctx(first.out), 'Git context unavailable for this session.');
  assert.deepEqual(ledger(w, 'sess-1'), [['optional-dropped', sid, 'over-budget', 'hook']]);
  // The same summary again on a fresh slot drops the same key: no second line.
  fs.writeFileSync(file, bytes);
  fs.rmSync(path.join(w.sessions, 'sess-1', 'injected'));
  run(w, 'sess-1', env);
  assert.equal(ledger(w, 'sess-1').length, 1);
});

test('L1-08: a dropped nudge leaves no nudged marker, and the next prompt nudges and marks', (t) => {
  const w = world(t);
  const marker = path.join(w.store, 'nudge', 'sess-1');
  fs.mkdirSync(path.join(w.sessions, 'sess-1'), { recursive: true });
  fs.writeFileSync(path.join(w.sessions, 'sess-1', 'injected'), '');
  const nudge = 'Try /do for this request. '.repeat(4);
  const dropped = run(w, 'sess-1', { EM_NUDGE: nudge, DOFLOW_CONTEXT_MAX_BYTES: '20' });
  assert.equal(dropped.out, '{}\n');
  assert.equal(fs.existsSync(marker), false);
  assert.deepEqual(ledger(w, 'sess-1'), [['optional-dropped', 'nudge', 'over-budget', 'hook']]);
  const next = run(w, 'sess-1', { EM_NUDGE: nudge });
  assert.equal(ctx(next.out), nudge);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'nudged\n');
});

test('L1-07: a ../x session id is {} with an emission-unit capture, for a launched identity too', (t) => {
  const w = world(t);
  writeGit(w, 'x');
  const r = run(w, '../x', LAUNCHED);
  assert.equal(r.out, '{}\n');
  assert.equal(r.reason, 'fault:unit');
  assert.ok(captures(w).some((c) => c.kind === 'emission-unit'));
  assert.equal(fs.existsSync(path.join(w.sessions, LAUNCHED_UNIT, 'injected')), false);
});

test('L1-02: unlaunched worker and default-main sessions never read grants/local/*', (t) => {
  const w = world(t);
  const files = [writeGrant(w, 'local', 'main'), writeGrant(w, 'local', 'solo')];
  const log = before('doflow_grant_peek', 'echo peek >>"$EM_ROOT/peeks"');
  writeGit(w, 'sess-main');
  writeGit(w, 'sess-worker');
  assert.doesNotMatch(run(w, 'sess-main', { EM_SETUP: log }).out, /Granted/);
  assert.doesNotMatch(run(w, 'sess-worker', { DOFLOW_SESSION_ROLE: 'worker', EM_SETUP: log }).out, /Granted/);
  assert.equal(fs.existsSync(path.join(w.root, 'peeks')), false, 'no grant peek for an unlaunched identity');
  for (const f of files) assert.ok(fs.existsSync(f));
});

test('L1-02 negative control: a launched unit still receives its grant', (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  const grant = writeGrant(w, 'r1', 'l1');
  const r = run(w, 'sess-1', { ...LAUNCHED, DOFLOW_SESSION_ROLE: 'worker' });
  assert.match(ctx(r.out), /\[Granted summary from lineage l0\]\nGranted body/);
  assert.equal(fs.existsSync(grant), false);
});

test('L1-11: the truncated copy of a claimed summary is 0600', (t) => {
  const w = world(t);
  run(w, 'seed', { EM_CALL: SUMMARY('local', 'main', 'y'.repeat(70000)) });
  const r = run(w, 'sess-1', {
    EM_SETUP: 'umask 022\n',
    EM_CALL: 'doflow_summary_claim "$EM_CWD" local main u1 sess-1 && printf "%s" "$DF_SUMMARY_CLAIMED" >"$EM_ROOT/claimed"',
  });
  assert.equal(r.err, '');
  const claimed = fs.readFileSync(path.join(w.root, 'claimed'), 'utf8');
  assert.equal(fs.statSync(claimed).size, 65536);
  assert.equal(fs.statSync(claimed).mode & 0o777, 0o600);
});
