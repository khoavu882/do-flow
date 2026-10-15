'use strict';

// 078 E.1 — emitContext(), the launcher-side claims and the IC-015 ledger (IC-001 emit half,
// IC-012 TypeScript claim, IC-015; DEC-001, DEC-007). emitContext() runs in process against a temp
// XDG_CONFIG_HOME; the hook side is the real policies/emission.sh under /bin/bash, so the slot and
// the ledger are proved shared with the adapter rather than with a copy of its format.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { emitContext } = require('../../src/runtime/context-pack.ts');
const { grantSummary, writeSummary } = require('../../src/runtime/context/summary-store.ts');

const REPO = path.resolve(__dirname, '..', '..');
const POLICIES = path.join(REPO, 'core/harnesses/shared/hooks/policies');
const REFUSAL = 'refused:mandatory-over-budget';
const PACK_END = '[end of pack]';
const GRANT_HEADER = '[Granted summary from lineage';
const LEDGER_LINE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\t(grant|pack|optional-dropped)\t[^\t]+\t[^\t]+\t(hook|launcher)$/;

const DRIVER = [
  'set -euo pipefail',
  '. "$1/lib.sh"',
  '. "$1/summary-store.sh"',
  '. "$1/emission-rules.sh"',
  '. "$1/emission.sh"',
  'doflow_emit_prompt "$EM_SID" "$EM_CWD" "" "" ""',
  'printf \'%s\\n\' "${DF_EMIT_REASON:-}" >"$EM_ROOT/reason"',
  '',
].join('\n');

/** A temp store, a working directory and a launched identity (run r1, lineage w1, attempt 1). */
function world(t, { role = 'worker', attempt = '1' } = {}) {
  const root = tempDir(t, 'doflow-context-emit-');
  const w = { root, cwd: path.join(root, 'work'), xdg: path.join(root, 'config') };
  w.store = path.join(w.xdg, 'doflow/session-env');
  w.unit = path.join(w.store, 'sessions', `L.r1.w1.${attempt}`);
  fs.mkdirSync(w.cwd, { recursive: true });
  fs.mkdirSync(w.xdg, { recursive: true });
  w.env = {
    HOME: root,
    XDG_CONFIG_HOME: w.xdg,
    PATH: process.env.PATH,
    TMPDIR: process.env.TMPDIR || '/tmp',
    DOFLOW_RUN_ID: 'r1',
    DOFLOW_LINEAGE_ID: 'w1',
    DOFLOW_ATTEMPT: attempt,
    DOFLOW_SESSION_ROLE: role,
  };
  w.emit = (options = {}) => emitContext({ event: 'launch', cwd: w.cwd, env: w.env, ...options });
  return w;
}

/** A summary in the default main scope, granted to (r1, w1); returns its id. */
function grant(w, at, body) {
  const env = { ...w.env, DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '' };
  assert.ok(writeSummary({ worktree: w.cwd, run: 'local', lineage: 'main', compactedAt: at, sessionId: 'owner', branch: 'topic', body, env }));
  return grantSummary({ summary: 'pending', toRun: 'r1', toLineage: 'w1', fromWorktree: w.cwd, fromRun: 'local', fromLineage: 'main', env }).summaryId;
}

function grantsLeft(w) {
  const dir = path.join(w.store, 'grants/r1/w1');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function ledger(w) {
  const file = path.join(w.unit, 'emitted');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function count(text, needle) {
  return text.split(needle).length - 1;
}

/** One UserPromptSubmit through the real hook adapter, with the world's launcher environment. */
function hookPrompt(w, sid) {
  const driver = path.join(w.root, 'driver.sh');
  fs.writeFileSync(driver, DRIVER);
  const r = spawnSync('/bin/bash', [driver, POLICIES], {
    cwd: w.cwd,
    encoding: 'utf8',
    env: { ...w.env, EM_ROOT: w.root, EM_SID: sid, EM_CWD: w.cwd, DOFLOW_AGENT: 'claude' },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, reason: fs.readFileSync(path.join(w.root, 'reason'), 'utf8').trim() };
}

test('IC-001 peek decides and renders, takes no claim and writes no ledger line', (t) => {
  const w = world(t);
  const id = grant(w, '2026-10-14T10:00:00Z', 'Granted body');
  const before = grantsLeft(w);

  const peeked = w.emit({ peek: true });
  assert.equal(peeked.decision.reason, 'emit');
  assert.ok(peeked.text.includes(PACK_END), 'peek renders the pack');
  assert.ok(peeked.text.includes('Granted body'), 'peek renders the grant');
  assert.equal(peeked.committed, false);
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), false, 'no slot');
  assert.deepEqual(grantsLeft(w), before, 'the grant is not claimed');
  assert.deepEqual(before, [`${id}.md`]);
  assert.equal(fs.existsSync(path.join(w.unit, 'emitted')), false, 'no ledger line');

  // The real launch after a peek still finds everything in place.
  const launched = w.emit();
  assert.equal(launched.decision.reason, 'emit');
  assert.equal(launched.text, peeked.text);
  assert.equal(launched.committed, true);
  assert.deepEqual(grantsLeft(w), []);
});

test('IC-015 a second launch for the unit is silent; the ledger line is the IC-015 format', (t) => {
  const w = world(t);
  const first = w.emit();
  assert.equal(first.decision.reason, 'emit');
  assert.ok(first.pack && /^sha256:[0-9a-f]{64}$/.test(first.pack.packDigest));
  const lines = ledger(w);
  assert.equal(lines.length, 1);
  assert.match(lines[0], LEDGER_LINE);
  assert.deepEqual(lines[0].split('\t').slice(1), ['pack', first.pack.packDigest, 'emitted', 'launcher']);

  const second = w.emit();
  assert.equal(second.decision.reason, 'silent:already-bootstrapped');
  assert.equal(second.text, null);
  assert.equal(second.committed, false);
  assert.equal(ledger(w).length, 1, 'no second line');
});

test('FR-013 a worker launch carries the pack and at most one grant, never git, nudge or warning', (t) => {
  const w = world(t, { role: 'worker' });
  grant(w, '2026-10-14T10:00:00Z', 'First granted body');
  const second = grant(w, '2026-10-14T11:00:00Z', 'Second granted body');
  // Material the hook would render on a main prompt: a git capture and a warning.
  const project = path.join(w.store, 'projects');
  fs.mkdirSync(project, { recursive: true });
  const { cwdHash } = require('../../src/runtime/context/identity.ts');
  fs.mkdirSync(path.join(project, cwdHash(w.cwd)), { recursive: true });
  fs.writeFileSync(path.join(project, cwdHash(w.cwd), 'uncommitted-warning.txt'), 'two files uncommitted\n');

  const r = w.emit({ nudge: 'nudge' });
  assert.equal(r.decision.reason, 'emit');
  assert.ok(r.text.includes(PACK_END));
  assert.equal(count(r.text, GRANT_HEADER), 1, 'exactly one grant');
  assert.ok(r.text.includes('First granted body'), 'the oldest grant first');
  for (const absent of ['Git context', 'Not a git repository', 'Prior session warning', 'two files uncommitted']) {
    assert.equal(r.text.includes(absent), false, `no ${absent}`);
  }
  assert.deepEqual(Object.keys(r.decision.actions).sort(), ['grant', 'pack', 'slot', 'summary']);
  assert.deepEqual(grantsLeft(w), [`${second}.md`], 'the second grant waits for a later event');
});

test('IC-015 a pack line the hook wrote is read back by delta as its since', (t) => {
  const w = world(t);
  const digest = w.emit({ peek: true }).pack.packDigest;
  // The unit bootstrapped and recorded by the hook side, byte for byte its line format.
  fs.mkdirSync(w.unit, { recursive: true });
  fs.writeFileSync(path.join(w.unit, 'injected'), '');
  const control = w.emit({ event: 'delta', peek: true });
  assert.equal(control.decision.reason, 'emit', 'without the line, delta delivers the pack');

  fs.writeFileSync(path.join(w.unit, 'emitted'), `2026-10-14T10:05:00Z\tpack\t${digest}\temitted\thook\n`);
  const delta = w.emit({ event: 'delta' });
  assert.equal(delta.decision.reason, 'silent:unchanged');
  assert.equal(delta.text, null);
  assert.equal(delta.pack.packDigest, digest);
  assert.equal(ledger(w).length, 1, 'silence writes no line');
});

test('IC-015 a refusal line the hook adapter wrote silences the same refusal for emitContext', (t) => {
  const w = world(t, { role: 'main' });
  const id = grant(w, '2026-10-14T10:00:00Z', 'x'.repeat(4000));
  w.env.DOFLOW_CONTEXT_MAX_BYTES = '3000';

  // Peek first: the over-budget grant renders as its pointer and refuses.
  const before = w.emit({ event: 'prompt', sessionId: 'sess-1', peek: true });
  assert.equal(before.decision.reason, REFUSAL);
  assert.ok(before.text.includes('withheld'), 'the pointer renders');

  const hook = hookPrompt(w, 'sess-1');
  assert.equal(hook.reason, REFUSAL);
  assert.deepEqual(ledger(w).map((l) => l.split('\t').slice(1)), [['grant', id, REFUSAL, 'hook']]);

  const after = w.emit({ event: 'prompt', sessionId: 'sess-1' });
  assert.equal(after.decision.reason, 'silent:already-bootstrapped');
  assert.equal(after.text, null);
  assert.equal(ledger(w).length, 1);
});

test('IC-015 a slot the hook took first makes launch silent', (t) => {
  const w = world(t);
  const hook = hookPrompt(w, 'sess-1');
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), true, 'the hook bootstrapped the launched unit');
  assert.equal(hook.reason, 'silent:unchanged');
  const launched = w.emit();
  assert.equal(launched.decision.reason, 'silent:already-bootstrapped');
  assert.equal(launched.text, null);
  assert.equal(launched.committed, false);
});

test('IC-015 a slot launch took first makes the hook prompt silent', (t) => {
  const w = world(t, { role: 'main' });
  fs.mkdirSync(path.join(w.store, 'sessions', 'sess-1'), { recursive: true });
  fs.writeFileSync(path.join(w.store, 'sessions', 'sess-1', 'git-context.json'), JSON.stringify({ is_git_repo: true, branch: 'topic', sha: 'abc1234', commits: [], uncommitted_count: 0, stash_count: 0 }));
  assert.equal(w.emit().decision.reason, 'emit');
  const hook = hookPrompt(w, 'sess-1');
  assert.equal(hook.reason, 'silent:already-bootstrapped');
  assert.equal(hook.out, '{}\n');
});

test('IC-001 launch without a launched identity is a usage error; overflow refuses and gives the slot back', (t) => {
  const w = world(t);
  const env = { ...w.env, DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '' };
  assert.throws(() => emitContext({ event: 'launch', cwd: w.cwd, env, sessionId: 's' }), (e) => e.code === 'USAGE_ERROR');

  const refused = w.emit({ maxBytes: 300 });
  assert.equal(refused.decision.reason, REFUSAL);
  assert.match(refused.text, /^OVERFLOW \(exit 3\)/);
  assert.equal(refused.committed, false);
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), false, 'the slot is released');
  assert.deepEqual(ledger(w), []);
});
