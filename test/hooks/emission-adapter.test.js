'use strict';

// 078 D.1 — the hook emission adapter policies/emission.sh and the IC-015 ledger (IC-004, IC-015;
// DEC-015, DEC-016, DEC-017). The adapter is driven directly under /bin/bash (3.2 on macOS) with a
// temp XDG_CONFIG_HOME and a PATH whose `node` and `doflow-run` record any call, and whose `jq`
// counts its processes before running the real one.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '..', '..');
const POLICIES = path.join(REPO, 'core/harnesses/shared/hooks/policies');
const BASH = '/bin/bash';
const REAL_JQ = spawnSync('/bin/sh', ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout.trim();
const GRANT_ID = 's-20261014T100000Z-Ab12Cd';
const REFUSAL = 'refused:mandatory-over-budget';
const GIT = { is_git_repo: true, branch: 'topic', sha: 'abc1234', commits: ['one', 'two'], uncommitted_count: 0, stash_count: 0 };

const DRIVER = [
  'set -euo pipefail',
  'P=$1',
  '. "$P/lib.sh"',
  '. "$P/summary-store.sh"',
  '. "$P/emission-rules.sh"',
  '. "$P/emission.sh"',
  'if [ -n "${EM_SETUP:-}" ]; then eval "$EM_SETUP"; fi',
  'if [ -n "${EM_CALL:-}" ]; then eval "$EM_CALL"; else',
  '  doflow_emit_prompt "$EM_SID" "$EM_CWD" "${EM_TITLE:-}" "${EM_SUB:-}" "${EM_NUDGE:-}"',
  'fi',
  'printf \'%s\\n%s\\n\' "${DF_EMIT_REASON:-}" "${DF_EMIT_NUDGE:-}" >"$EM_ROOT/reason"',
  '',
].join('\n');

// Shell snippets for EM_SETUP; each runs inside the driver with lib.sh and the store loaded.
const SETUP = {
  summary: (run = 'local', lineage = 'main') =>
    `doflow_summary_write "$EM_CWD" ${run} ${lineage} "" 2026-10-14T09:00:00Z other-session manual topic main "Prior work body"\n`,
  warning: 'p=$(ensure_project_dir "$EM_CWD"); printf \'two files uncommitted\\n\' >"$p/uncommitted-warning.txt"\n',
  // Another caller bootstraps this unit between the state read and the slot claim.
  raceSlot: 'eval "_em_real_peek() $(declare -f doflow_summary_peek | sed 1d)"\n'
    + 'doflow_summary_peek() { _em_real_peek "$@"; mkdir -p "$SESSION_DIR/$EM_SID"; : >"$SESSION_DIR/$EM_SID/injected"; }\n',
  // Logs, at each claim, whether the slot is taken and the warning is still in place.
  logClaims: 'eval "_em_real_sclaim() $(declare -f doflow_summary_claim | sed 1d)"\n'
    + 'eval "_em_real_gclaim() $(declare -f doflow_grant_claim | sed 1d)"\n'
    + '_em_log() { p=$(ensure_project_dir "$EM_CWD"); i=n; w=n; [ ! -e "$SESSION_DIR/$EM_SID/injected" ] || i=y; [ ! -f "$p/uncommitted-warning.txt" ] || w=y; echo "$1 slot=$i warning=$w" >>"$EM_ROOT/order"; }\n'
    + 'doflow_summary_claim() { _em_log summary; _em_real_sclaim "$@"; }\n'
    + 'doflow_grant_claim() { _em_log grant; _em_real_gclaim "$@"; }\n',
  failGrantClaim: 'doflow_grant_claim() { return 1; }\n',
};

function world(t) {
  const root = tempDir(t, 'doflow-emission-');
  const w = {
    root,
    home: path.join(root, 'home'),
    xdg: path.join(root, 'config'),
    cwd: path.join(root, 'work'),
    bin: path.join(root, 'bin'),
    driver: path.join(root, 'driver.sh'),
  };
  w.sessions = path.join(w.xdg, 'doflow/session-env/sessions');
  w.store = path.join(w.xdg, 'doflow/session-env');
  for (const dir of [w.home, w.xdg, w.cwd, w.bin]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(w.driver, DRIVER);
  for (const name of ['node', 'doflow-run']) {
    fs.writeFileSync(path.join(w.bin, name), `#!/bin/sh\necho "${name}" >>"$EM_ROOT/spawned"\nexit 1\n`, { mode: 0o755 });
  }
  fs.writeFileSync(path.join(w.bin, 'jq'),
    `#!/bin/sh\necho jq >>"$EM_ROOT/jq-count"\n[ -z "$EM_JQ_FAIL" ] || exit 5\nexec "${REAL_JQ}" "$@"\n`, { mode: 0o755 });
  return w;
}

function run(w, sid, env = {}) {
  for (const f of ['jq-count', 'reason']) fs.rmSync(path.join(w.root, f), { force: true });
  const r = spawnSync(BASH, [w.driver, POLICIES], {
    encoding: 'utf8',
    cwd: w.cwd,
    env: {
      HOME: w.home,
      XDG_CONFIG_HOME: w.xdg,
      PATH: `${w.bin}:${process.env.PATH}`,
      TMPDIR: process.env.TMPDIR || '/tmp',
      EM_ROOT: w.root,
      EM_SID: sid,
      EM_CWD: w.cwd,
      DOFLOW_AGENT: 'claude',
      ...env,
    },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(w.root, 'spawned')), false, 'no node or doflow-run process on the hook path');
  const count = fs.existsSync(path.join(w.root, 'jq-count'))
    ? fs.readFileSync(path.join(w.root, 'jq-count'), 'utf8').split('\n').filter(Boolean).length : 0;
  const [reason = '', nudge = ''] = fs.readFileSync(path.join(w.root, 'reason'), 'utf8').split('\n');
  return { out: r.stdout, jq: count, reason, nudge };
}

function context(out) {
  return JSON.parse(out).hookSpecificOutput;
}

function writeGit(w, sid) {
  fs.mkdirSync(path.join(w.sessions, sid), { recursive: true });
  fs.writeFileSync(path.join(w.sessions, sid, 'git-context.json'), JSON.stringify(GIT));
}

function writeGrant(w, run, lineage, body) {
  const dir = path.join(w.store, 'grants', run, lineage);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${GRANT_ID}.md`);
  fs.writeFileSync(file, `---\nsummary_id: ${GRANT_ID}\nfrom_lineage: l0\ncompacted_at: 2026-10-14T10:00:00Z\nbranch: topic\n---\n\n${body}\n`);
  return file;
}

function filesNamed(dir, test) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...filesNamed(full, test));
    else if (test(entry.name)) found.push(full);
  }
  return found;
}

const pendingSummaries = (w) => filesNamed(path.join(w.store, 'summaries'), (n) => n === 'summary.md');
const claimedLeft = (w) => filesNamed(w.store, (n) => n.startsWith('.claimed.'));
const warningFiles = (w) => filesNamed(path.join(w.store, 'projects'), (n) => n === 'uncommitted-warning.txt');
const captures = (w) => {
  const file = path.join(w.xdg, 'doflow/failures/events.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};

const WORKER = { DOFLOW_SESSION_ROLE: 'worker', DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'l1', DOFLOW_ATTEMPT: '1' };

test('the PATH shim records a node or doflow-run call (positive control for the no-process checks)', (t) => {
  const w = world(t);
  const r = spawnSync(BASH, ['-c', 'node -e 1; doflow-run x; true'], {
    env: { PATH: `${w.bin}:${process.env.PATH}`, EM_ROOT: w.root }, encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(fs.readFileSync(path.join(w.root, 'spawned'), 'utf8'), 'node\ndoflow-run\n');
});

test('IC-004: silence prints {} and a newline, with no jq process', (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w.sessions, 'sess-1'), { recursive: true });
  fs.writeFileSync(path.join(w.sessions, 'sess-1', 'injected'), '');
  const later = run(w, 'sess-1');
  assert.equal(later.out, '{}\n');
  assert.equal(later.jq, 0);
  assert.equal(later.reason, 'silent:already-bootstrapped');

  // A solo worker's first prompt claims the slot and renders nothing.
  const worker = run(w, 'sess-2', { DOFLOW_SESSION_ROLE: 'worker' });
  assert.equal(worker.out, '{}\n');
  assert.equal(worker.reason, 'silent:unchanged');
  assert.ok(fs.existsSync(path.join(w.sessions, 'sess-2', 'injected')));

  // An empty session id prints nothing at all.
  assert.equal(run(w, '').out, '');
});

test('IC-004: the bootstrap renders once, in one jq process, then the unit is silent', (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  const first = run(w, 'sess-1');
  assert.equal(first.jq, 1, 'one jq process for the render');
  assert.equal(first.reason, 'emit');
  const ctx = context(first.out);
  assert.equal(ctx.hookEventName, 'UserPromptSubmit');
  assert.equal(ctx.additionalContext, 'Git context — branch: topic | abc1234\nLast commits: one · two\nUncommitted files: 0');
  assert.equal(ctx.sessionTitle, 'topic — abc1234');
  assert.ok(fs.existsSync(path.join(w.sessions, 'sess-1', 'injected')));

  const second = run(w, 'sess-1');
  assert.equal(second.out, '{}\n');
  assert.equal(second.jq, 0);

  writeGit(w, 'sess-codex');
  assert.equal(context(run(w, 'sess-codex', { DOFLOW_AGENT: 'codex' }).out).sessionTitle, undefined, 'Codex never carries sessionTitle');
  writeGit(w, 'sess-titled');
  assert.equal(context(run(w, 'sess-titled', { EM_TITLE: 'mine' }).out).sessionTitle, undefined, 'a payload title suppresses sessionTitle');
});

test('IC-004: EEXIST on the slot makes every bootstrap-only segment skip', (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  const r = run(w, 'sess-1', { EM_SETUP: SETUP.summary() + SETUP.warning + SETUP.raceSlot });
  assert.equal(r.out, '{}\n');
  assert.equal(r.reason, 'silent:already-bootstrapped');
  assert.equal(pendingSummaries(w).length, 1, 'the summary stays for the caller that bootstrapped');
  assert.equal(warningFiles(w).length, 1, 'the warning stays');
  assert.deepEqual(claimedLeft(w), []);
});

test('IC-004: claims run in the order slot, summary, grant, warning', (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  writeGrant(w, 'local', 'main', 'Granted body');
  const r = run(w, 'sess-1', { EM_SETUP: SETUP.summary() + SETUP.warning + SETUP.logClaims });
  assert.deepEqual(fs.readFileSync(path.join(w.root, 'order'), 'utf8').split('\n').filter(Boolean),
    ['summary slot=y warning=y', 'grant slot=y warning=y']);
  assert.equal(warningFiles(w).length, 0, 'the warning is claimed last');
  assert.equal(pendingSummaries(w).length, 0);
  assert.deepEqual(claimedLeft(w), [], 'claimed copies are removed after the render');
  assert.equal(context(r.out).additionalContext,
    'Git context — branch: topic | abc1234\nLast commits: one · two\nUncommitted files: 0'
    + '\n\n[Prior session summary, compacted 2026-10-14T09:00:00Z on branch topic]\nPrior work body'
    + '\n[Prior session warning: two files uncommitted]'
    + '\n\n[Granted summary from lineage l0, compacted 2026-10-14T10:00:00Z on branch topic]\nGranted body');
});

test('IC-004: a failed claim stops the claims with the silent response and a capture', (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  writeGrant(w, 'local', 'main', 'Granted body');
  const r = run(w, 'sess-1', { EM_SETUP: SETUP.summary() + SETUP.warning + SETUP.failGrantClaim });
  assert.equal(r.out, '{}\n');
  assert.equal(r.reason, 'fault:grant');
  assert.equal(warningFiles(w).length, 1, 'no claim after the failed one');
  assert.ok(captures(w).some((c) => c.command === 'user-prompt-submit' && c.kind === 'emission-grant'));
});

test('IC-004, IC-015: an over-budget grant renders its pointer once, with one refusal ledger line', (t) => {
  const w = world(t);
  const grant = writeGrant(w, 'r1', 'l1', 'x'.repeat(1000));
  const env = { ...WORKER, DOFLOW_CONTEXT_MAX_BYTES: '300' };
  const ledger = path.join(w.sessions, 'L.r1.l1.1', 'emitted');

  const first = run(w, 'sess-w', env);
  assert.equal(first.reason, REFUSAL);
  assert.equal(context(first.out).additionalContext,
    `[Granted summary ${GRANT_ID} withheld: 1000 bytes exceed the 300-byte context budget]`);
  assert.ok(fs.existsSync(grant), 'an over-budget grant is never claimed');
  const lines = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\dZ\\tgrant\\t${GRANT_ID}\\t${REFUSAL}\\thook$`));

  const second = run(w, 'sess-w', env);
  assert.equal(second.out, '{}\n', 'the second refusal is silent');
  assert.equal(second.jq, 0);
  assert.equal(fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).length, 1, 'no duplicate ledger line');
});

test('IC-015: a ledger line is appended only when (kind, key, outcome) is absent', (t) => {
  const w = world(t);
  const dir = path.join(w.sessions, 'u1');
  const call = `_doflow_em_ledger_add "$SESSION_DIR/u1" grant ${GRANT_ID} ${REFUSAL} hook`;
  run(w, 'u1', { EM_CALL: `${call}; ${call}; _doflow_em_ledger_add "$SESSION_DIR/u1" grant ${GRANT_ID} emitted hook` });
  const lines = fs.readFileSync(path.join(dir, 'emitted'), 'utf8').split('\n').filter(Boolean).map((l) => l.split('\t').slice(1));
  assert.deepEqual(lines, [['grant', GRANT_ID, REFUSAL, 'hook'], ['grant', GRANT_ID, 'emitted', 'hook']]);
});

test('IC-004: a render fault prints {} and captures emission-render; the claim is not restored', (t) => {
  const w = world(t);
  writeGit(w, 'sess-1');
  const r = run(w, 'sess-1', { EM_SETUP: SETUP.summary(), EM_JQ_FAIL: '1' });
  assert.equal(r.out, '{}\n');
  assert.equal(r.reason, 'fault:render');
  assert.equal(r.jq, 1);
  assert.ok(captures(w).some((c) => c.command === 'user-prompt-submit' && c.kind === 'emission-render'));
  assert.equal(pendingSummaries(w).length, 0);
  assert.deepEqual(claimedLeft(w), []);
});

test('IC-004: a nudge on a later prompt renders alone and is reported', (t) => {
  const w = world(t);
  fs.mkdirSync(path.join(w.sessions, 'sess-1'), { recursive: true });
  fs.writeFileSync(path.join(w.sessions, 'sess-1', 'injected'), '');
  const r = run(w, 'sess-1', { EM_NUDGE: 'Try "/do" for this.' });
  assert.equal(context(r.out).additionalContext, 'Try "/do" for this.');
  assert.equal(context(r.out).sessionTitle, undefined, 'no git segment, no title');
  assert.equal(r.nudge, 'rendered');
});
