'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// 078 E.1 — emitContext(), the launcher-side claims and the IC-015 ledger (IC-001 emit half,
// IC-012 TypeScript claim, IC-015; DEC-001, DEC-007). emitContext() runs in process against a temp
// XDG_CONFIG_HOME; the hook side is the real policies/emission.sh under /bin/bash, so the slot and
// the ledger are proved shared with the adapter rather than with a copy of its format.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { emitContext } = require('../../src/runtime/context-pack.ts');
const { grantSummary } = require('../../src/runtime/context/summary-store.ts');
const { writeSummary } = require('../helper/summary-fixture.ts');

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
function world(t: any, { role = 'worker', attempt = '1' }: any = {}) {
  const root = tempDir(t, 'doflow-context-emit-');
  const w: any = { root, cwd: path.join(root, 'work'), xdg: path.join(root, 'config') };
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
  w.emit = (options: any = {}) => emitContext({ event: 'launch', cwd: w.cwd, env: w.env, ...options });
  return w;
}

/** A summary in the default main scope, granted to (r1, w1); returns its id. */
function grant(w: any, at: any, body: any) {
  const env: any = { ...w.env, DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '' };
  assert.ok(writeSummary({ worktree: w.cwd, run: 'local', lineage: 'main', compactedAt: at, sessionId: 'owner', branch: 'topic', body, env }));
  return grantSummary({ summary: 'pending', toRun: 'r1', toLineage: 'w1', fromWorktree: w.cwd, fromRun: 'local', fromLineage: 'main', env }).summaryId;
}

function grantsLeft(w: any) {
  const dir = path.join(w.store, 'grants/r1/w1');
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

function ledger(w: any) {
  const file = path.join(w.unit, 'emitted');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
}

function count(text: any, needle: any) {
  return text.split(needle).length - 1;
}

/** One UserPromptSubmit through the real hook adapter, with the world's launcher environment. */
function hookPrompt(w: any, sid: any) {
  const driver = path.join(w.root, 'driver.sh');
  fs.writeFileSync(driver, DRIVER);
  const r = spawnSync(bashPath(), [driver, POLICIES], {
    cwd: w.cwd,
    encoding: 'utf8',
    env: { ...w.env, EM_ROOT: w.root, EM_SID: sid, EM_CWD: w.cwd, DOFLOW_AGENT: 'claude' },
  });
  assert.equal(r.status, 0, r.stderr);
  return { out: r.stdout, reason: fs.readFileSync(path.join(w.root, 'reason'), 'utf8').trim() };
}

test('IC-001 peek decides and renders, takes no claim and writes no ledger line', (t) => {
  const w: any = world(t);
  const id = grant(w, '2026-10-14T10:00:00Z', 'Granted body');
  const before = grantsLeft(w);

  const peeked: any = w.emit({ peek: true });
  assert.equal(peeked.decision.reason, 'emit');
  assert.ok(peeked.text.includes(PACK_END), 'peek renders the pack');
  assert.ok(peeked.text.includes('Granted body'), 'peek renders the grant');
  assert.equal(peeked.committed, false);
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), false, 'no slot');
  assert.deepEqual(grantsLeft(w), before, 'the grant is not claimed');
  assert.deepEqual(before, [`${id}.md`]);
  assert.equal(fs.existsSync(path.join(w.unit, 'emitted')), false, 'no ledger line');

  // The real launch after a peek still finds everything in place.
  const launched: any = w.emit();
  assert.equal(launched.decision.reason, 'emit');
  assert.equal(launched.text, peeked.text);
  assert.equal(launched.committed, true);
  assert.deepEqual(grantsLeft(w), []);
});

test('IC-015 a second launch for the unit is silent; the ledger line is the IC-015 format', (t) => {
  const w = world(t);
  const first: any = w.emit();
  assert.equal(first.decision.reason, 'emit');
  assert.ok(first.pack && /^sha256:[0-9a-f]{64}$/.test(first.pack.packDigest));
  const lines = ledger(w);
  assert.equal(lines.length, 1);
  assert.match(lines[0], LEDGER_LINE);
  assert.deepEqual(lines[0].split('\t').slice(1), ['pack', first.pack.packDigest, 'emitted', 'launcher']);

  const second: any = w.emit();
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
  const project: any = path.join(w.store, 'projects');
  fs.mkdirSync(project, { recursive: true });
  const { cwdHash } = require('../../src/runtime/context/identity.ts');
  fs.mkdirSync(path.join(project, cwdHash(w.cwd)), { recursive: true });
  fs.writeFileSync(path.join(project, cwdHash(w.cwd), 'uncommitted-warning.txt'), 'two files uncommitted\n');

  const r: any = w.emit({ nudge: 'nudge' });
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
  const w: any = world(t);
  const digest: any = w.emit({ peek: true }).pack.packDigest;
  // The unit bootstrapped and recorded by the hook side, byte for byte its line format.
  fs.mkdirSync(w.unit, { recursive: true });
  fs.writeFileSync(path.join(w.unit, 'injected'), '');
  const control: any = w.emit({ event: 'delta', peek: true });
  assert.equal(control.decision.reason, 'emit', 'without the line, delta delivers the pack');

  fs.writeFileSync(path.join(w.unit, 'emitted'), `2026-10-14T10:05:00Z\tpack\t${digest}\temitted\thook\n`);
  const delta: any = w.emit({ event: 'delta' });
  assert.equal(delta.decision.reason, 'silent:unchanged');
  assert.equal(delta.text, null);
  assert.equal(delta.pack.packDigest, digest);
  assert.equal(ledger(w).length, 1, 'silence writes no line');
});

test('IC-015 a refusal line the hook adapter wrote silences the same refusal for emitContext', (t) => {
  const w: any = world(t, { role: 'main' });
  const id = grant(w, '2026-10-14T10:00:00Z', 'x'.repeat(4000));
  w.env.DOFLOW_CONTEXT_MAX_BYTES = '3000';

  // Peek first: the over-budget grant renders as its pointer and refuses.
  const before: any = w.emit({ event: 'prompt', sessionId: 'sess-1', peek: true });
  assert.equal(before.decision.reason, REFUSAL);
  assert.ok(before.text.includes('withheld'), 'the pointer renders');

  const hook = hookPrompt(w, 'sess-1');
  assert.equal(hook.reason, REFUSAL);
  assert.deepEqual(ledger(w).map((l: any) => l.split('\t').slice(1)), [['grant', id, REFUSAL, 'hook']]);

  const after: any = w.emit({ event: 'prompt', sessionId: 'sess-1' });
  assert.equal(after.decision.reason, 'silent:already-bootstrapped');
  assert.equal(after.text, null);
  assert.equal(ledger(w).length, 1);
});

test('IC-015 a slot the hook took first makes launch silent', (t) => {
  const w: any = world(t);
  const hook = hookPrompt(w, 'sess-1');
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), true, 'the hook bootstrapped the launched unit');
  assert.equal(hook.reason, 'silent:unchanged');
  const launched: any = w.emit();
  assert.equal(launched.decision.reason, 'silent:already-bootstrapped');
  assert.equal(launched.text, null);
  assert.equal(launched.committed, false);
});

test('IC-015 a slot launch took first makes the hook prompt silent', (t) => {
  const w: any = world(t, { role: 'main' });
  fs.mkdirSync(path.join(w.store, 'sessions', 'sess-1'), { recursive: true });
  fs.writeFileSync(path.join(w.store, 'sessions', 'sess-1', 'git-context.json'), JSON.stringify({ is_git_repo: true, branch: 'topic', sha: 'abc1234', commits: [], uncommitted_count: 0, stash_count: 0 }));
  assert.equal(w.emit().decision.reason, 'emit');
  const hook = hookPrompt(w, 'sess-1');
  assert.equal(hook.reason, 'silent:already-bootstrapped');
  assert.equal(hook.out, '{}\n');
});

test('IC-001 launch without a launched identity is a usage error; overflow refuses and gives the slot back', (t) => {
  const w: any = world(t);
  const env: any = { ...w.env, DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '' };
  assert.throws(() => emitContext({ event: 'launch', cwd: w.cwd, env, sessionId: 's' }), (e: any) => e.code === 'USAGE_ERROR');

  const refused: any = w.emit({ maxBytes: 300 });
  assert.equal(refused.decision.reason, REFUSAL);
  assert.match(refused.text, /^OVERFLOW \(exit 3\)/);
  assert.equal(refused.committed, false);
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), false, 'the slot is released');
  assert.deepEqual(ledger(w), []);
});

// DEC-034: a launch has one byte budget, shared by the pack and the prompt segments.
function packBytes(w: any, maxBytes: any) {
  const alone = w.emit({ peek: true, maxBytes });
  assert.equal(alone.decision.reason, 'emit');
  assert.ok(alone.text.includes(PACK_END));
  return Buffer.byteLength(alone.text, 'utf8');
}

test('DEC-034 a launch whose pack plus grant exceed the budget stays within it, the grant as its pointer', (t) => {
  const w = world(t);
  const maxBytes = 8192;
  const pack = packBytes(w, maxBytes);
  const size = maxBytes - pack + 200;
  const id = grant(w, '2026-10-14T10:00:00Z', 'g'.repeat(size));
  assert.ok(size + 200 < maxBytes, 'the grant alone fits the budget');

  const r: any = w.emit({ maxBytes });
  assert.equal(r.decision.reason, REFUSAL);
  assert.ok(Buffer.byteLength(r.text, 'utf8') <= maxBytes, `${Buffer.byteLength(r.text, 'utf8')} > ${maxBytes}`);
  assert.ok(r.text.includes(PACK_END), 'the pack is delivered');
  assert.ok(r.text.includes(`[Granted summary ${id} withheld:`), 'the grant renders as its pointer');
  assert.equal(r.text.includes('g'.repeat(size)), false, 'not the whole grant');
  assert.deepEqual(grantsLeft(w), [`${id}.md`], 'a withheld grant is not consumed');
  assert.ok(ledger(w).some((l: any) => l.split('\t').slice(1).join('\t') === `grant\t${id}\t${REFUSAL}\tlauncher`));
});

test('DEC-034 a launch where everything fits is unchanged: the pack, a blank line, the whole grant', (t) => {
  const w = world(t);
  const pack: any = w.emit({ peek: true }).text;
  grant(w, '2026-10-14T10:00:00Z', 'Small granted body');

  const r: any = w.emit();
  assert.equal(r.decision.reason, 'emit');
  assert.equal(r.text, `${pack}\n\n[Granted summary from lineage main, compacted 2026-10-14T10:00:00Z on branch topic]\nSmall granted body`);
  assert.ok(Buffer.byteLength(r.text, 'utf8') <= 16384);
  assert.deepEqual(grantsLeft(w), []);
});

// ── Review batch B (DEC-038, DEC-039, DEC-041, DEC-042, DEC-043) ────────────────────────────────

const store = require('../../src/runtime/context/summary-store.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');

/** A default-main session's environment: no launcher variables. */
function mainEnv(w: any) {
  return { ...w.env, DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '', DOFLOW_SESSION_ROLE: '' };
}

/** A grant record placed directly, as a pre-DEC-039 grantSummary could address it. */
function placeGrant(w: any, run: any, lineage: any, id: any, body: any) {
  const dir = path.join(w.store, 'grants', run, lineage);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.md`), `---\nsummary_id: ${id}\nfrom_lineage: main\ncompacted_at: 2026-10-14T10:00:00Z\nbranch: topic\n---\n\n${body}\n`);
  return dir;
}

function bootstrapped(w: any, unit: any) {
  fs.mkdirSync(path.join(w.store, 'sessions', unit), { recursive: true });
  fs.writeFileSync(path.join(w.store, 'sessions', unit, 'injected'), '');
}

test('DEC-039 a default-main prompt never reads a grant under local/main; a launched unit still gets its own', (t) => {
  const w: any = world(t);
  const env = mainEnv(w);
  placeGrant(w, 'local', 'main', 's-20261014T100000Z-AAAAAA', 'stray grant body');
  bootstrapped(w, 'sess-m');
  const r = emitContext({ event: 'prompt', cwd: w.cwd, env, sessionId: 'sess-m' });
  assert.equal(r.decision.reason, 'silent:already-bootstrapped');
  assert.equal(r.text, null);
  assert.ok(fs.existsSync(path.join(w.store, 'grants/local/main/s-20261014T100000Z-AAAAAA.md')), 'the grant is not consumed');

  // Negative control: the launched worker (r1, w1) receives a grant addressed to it.
  placeGrant(w, 'r1', 'w1', 's-20261014T100000Z-BBBBBB', 'launched grant body');
  bootstrapped(w, 'L.r1.w1.1');
  const launched: any = emitContext({ event: 'prompt', cwd: w.cwd, env: w.env, sessionId: 'sess-w' });
  assert.equal(launched.decision.reason, 'emit');
  assert.ok(launched.text.includes('launched grant body'));
});

test('L1-05 a grant swapped between peek and claim is not delivered, and the other grant is untouched', (t) => {
  const w: any = world(t);
  const dir = placeGrant(w, 'r1', 'w1', 's-20261014T100000Z-EEEEEE', 'peeked body');
  const realPeek = store.peekGrant;
  store.peekGrant = (...args: any[]) => {
    const peeked = realPeek(...args);
    fs.rmSync(path.join(dir, 's-20261014T100000Z-EEEEEE.md'));
    placeGrant(w, 'r1', 'w1', 's-20261014T090000Z-AAAAAA', 'older body that arrived later');
    return peeked;
  };
  let r;
  try {
    r = emitContext({ event: 'prompt', cwd: w.cwd, env: w.env, sessionId: 'sess-w' });
  } finally {
    store.peekGrant = realPeek;
  }
  assert.equal(r.text, null, 'nothing renders: the fitted grant vanished');
  assert.deepEqual(grantsLeft(w), ['s-20261014T090000Z-AAAAAA.md'], 'the newcomer stays for a later event');
  assert.deepEqual(ledger(w), []);
});

/** A pending default-main summary larger than a 100-byte budget; returns its id. */
function bigSummary(w: any) {
  return writeSummary({ worktree: w.cwd, run: 'local', lineage: 'main', compactedAt: '2026-10-14T10:00:00Z', sessionId: 'owner', branch: 'topic', body: 's'.repeat(500), env: mainEnv(w) }).summaryId;
}

test('DEC-041 a summary the budget drops writes one optional-dropped line keyed by its id', (t) => {
  const w: any = world(t);
  const env: any = { ...mainEnv(w), DOFLOW_CONTEXT_MAX_BYTES: '100' };
  const id = bigSummary(w);
  const r = emitContext({ event: 'prompt', cwd: w.cwd, env, sessionId: 'sess-m' });
  assert.equal(r.decision.reason, 'emit');
  assert.equal(r.text, 'Git context unavailable for this session.');
  const lines: any = ledger({ unit: path.join(w.store, 'sessions', 'sess-m') });
  assert.equal(lines.length, 1);
  assert.match(lines[0], LEDGER_LINE);
  assert.deepEqual(lines[0].split('\t').slice(1), ['optional-dropped', id, 'over-budget', 'launcher']);
  emitContext({ event: 'prompt', cwd: w.cwd, env, sessionId: 'sess-m' });
  assert.equal(ledger({ unit: path.join(w.store, 'sessions', 'sess-m') }).length, 1, 'a repeat writes none');
});

test('DEC-038 a ledger write that throws after the claim gives the summary and the slot back', (t) => {
  const w: any = world(t);
  const env: any = { ...mainEnv(w), DOFLOW_CONTEXT_MAX_BYTES: '100' };
  bigSummary(w);
  const scope = store.summaryScope(w.cwd, 'local', 'main', env);
  const realAppend = fs.appendFileSync;
  fs.appendFileSync = () => {
    const error: any = new Error('ENOSPC: no space left on device');
    error.code = 'ENOSPC';
    throw error;
  };
  try {
    assert.throws(() => emitContext({ event: 'prompt', cwd: w.cwd, env, sessionId: 'sess-m' }), /ENOSPC/);
  } finally {
    fs.appendFileSync = realAppend;
  }
  assert.deepEqual(fs.readdirSync(scope), ['summary.md'], 'the summary is back, no claimed file left');
  assert.equal(fs.existsSync(path.join(w.store, 'sessions/sess-m/injected')), false, 'the slot is released');
  assert.equal(store.peekSummary(w.cwd, 'local', 'main', 'sess-m', env).own, 'pending');
});

test('DEC-043 a legacy summary is adopted on the first default-main prompt and emitted; peek renders it in place', (t) => {
  const w = world(t);
  const env = mainEnv(w);
  const dir: any = path.join(w.store, 'projects', cwdHash(w.cwd));
  fs.mkdirSync(dir, { recursive: true });
  const legacy = path.join(dir, 'last-compact-summary.md');
  fs.writeFileSync(legacy, '---\ncompacted_at: 2026-10-01T09:00:00Z\nsession_id: old\ntrigger: auto\nbranch: topic\n---\n\ncarried-over body\n');

  const peeked = emitContext({ event: 'prompt', cwd: w.cwd, env, sessionId: 'sess-m', peek: true });
  assert.ok(peeked.text.includes('carried-over body'));
  assert.ok(fs.existsSync(legacy), 'peek adopts nothing');

  const r = emitContext({ event: 'prompt', cwd: w.cwd, env, sessionId: 'sess-m' });
  assert.equal(r.decision.reason, 'emit');
  assert.equal(r.text, peeked.text);
  assert.ok(r.text.includes('[Prior session summary, compacted 2026-10-01T09:00:00Z on branch topic]\ncarried-over body'));
  assert.deepEqual(fs.readdirSync(dir), [], 'the legacy file and its .adopting name are gone');
  assert.deepEqual(fs.readdirSync(store.summaryScope(w.cwd, 'local', 'main', env)), [], 'adopted, then claimed');
});

test('DEC-042 an unsafe session id is silent for every lineage kind and touches nothing', (t) => {
  const w: any = world(t);
  for (const env of [mainEnv(w), w.env]) {
    const r = emitContext({ event: 'prompt', cwd: w.cwd, env, sessionId: '../x' });
    assert.deepEqual({ reason: r.decision.reason, text: r.text, committed: r.committed }, { reason: 'fault:unit', text: null, committed: false });
  }
  assert.equal(fs.existsSync(path.join(w.store, 'sessions')), false);
});
