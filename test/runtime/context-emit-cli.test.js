'use strict';

// 078 E.2 — the `context-emit` and `context-grant` verbs (IC-005, IC-013 verb, DEC-021), run as
// a launcher would run them: through bin/doflow.js and through the doflow-run dispatcher, with a
// temp XDG_CONFIG_HOME and an environment built from scratch, so no DOFLOW_* identity leaks in
// from the shell running the suite.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { writeSummary } = require('../helper/summary-fixture.ts');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const DISPATCHER = path.join(REPO, 'core/shared/scripts/doflow/bin/doflow-run');
const PACK_END = '[end of pack]';
const LAUNCHED = { DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'w1', DOFLOW_ATTEMPT: '1', DOFLOW_SESSION_ROLE: 'worker' };

function world(t) {
  const root = tempDir(t, 'doflow-context-emit-cli-');
  const w = { root, cwd: path.join(root, 'work'), xdg: path.join(root, 'config') };
  w.store = path.join(w.xdg, 'doflow/session-env');
  w.unit = path.join(w.store, 'sessions', 'L.r1.w1.1');
  fs.mkdirSync(w.cwd, { recursive: true });
  fs.mkdirSync(w.xdg, { recursive: true });
  w.base = { HOME: root, XDG_CONFIG_HOME: w.xdg, PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp', FORCE_COLOR: '0' };
  if (process.env.NODE_COMPILE_CACHE) w.base.NODE_COMPILE_CACHE = process.env.NODE_COMPILE_CACHE;
  return w;
}

/** One run of the verb; `via` is 'cli' (node bin/doflow.js) or 'run' (the doflow-run dispatcher). */
function run(w, args, { env = LAUNCHED, via = 'cli' } = {}) {
  const [cmd, argv] = via === 'cli' ? [process.execPath, [CLI, ...args]] : ['/bin/bash', [DISPATCHER, ...args]];
  const r = spawnSync(cmd, argv, { cwd: w.cwd, encoding: 'utf8', env: { ...w.base, ...env } });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function emit(w, extra = [], options = {}) {
  return run(w, ['context-emit', '--event', 'launch', '--cwd', w.cwd, ...extra], options);
}

/** A pending summary in the default main scope of the world's working directory. */
function pending(w, body, at = '2026-10-14T10:00:00Z') {
  const env = { ...w.base };
  assert.ok(writeSummary({ worktree: w.cwd, run: 'local', lineage: 'main', compactedAt: at, sessionId: 'owner', branch: 'topic', body, env }));
}

const GRANT_SOURCE = (w) => ['--from-worktree', w.cwd, '--from-run', 'local', '--from-lineage', 'main'];

test('IC-005 context-emit exits 0 with the text for an emit, then 0 with nothing when silent', (t) => {
  const w = world(t);
  const first = emit(w, [], { via: 'run' });
  assert.equal(first.code, 0, first.stderr);
  assert.ok(first.stdout.includes(PACK_END), 'the pack text alone');
  assert.equal(first.stdout.trimStart().startsWith('{'), false, 'no JSON without --json');
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), true, 'the slot is taken');

  const second = emit(w, [], { via: 'run' });
  assert.equal(second.code, 0, second.stderr);
  assert.equal(second.stdout, '', 'silent prints nothing');
});

test('IC-005 --json prints exactly v, event, identity, decision, text, pack and committed', (t) => {
  const w = world(t);
  const r = emit(w, ['--json']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(Object.keys(out).sort(), ['committed', 'decision', 'event', 'identity', 'pack', 'text', 'v']);
  assert.equal(out.v, 1);
  assert.equal(out.event, 'launch');
  assert.equal(out.identity.unitId, 'L.r1.w1.1');
  assert.equal(out.identity.lineageKind, 'launched');
  assert.equal(out.decision.reason, 'emit');
  assert.ok(out.text.includes(PACK_END));
  assert.match(out.pack.packDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(out.committed, true);

  const silent = JSON.parse(emit(w, ['--json']).stdout);
  assert.equal(silent.decision.reason, 'silent:already-bootstrapped');
  assert.equal(silent.text, null);
  assert.equal(silent.committed, false);
});

test('IC-005 --peek decides and renders but takes no claim and writes no ledger line', (t) => {
  const w = world(t);
  const peeked = emit(w, ['--peek', '--json'], { via: 'run' });
  assert.equal(peeked.code, 0, peeked.stderr);
  const out = JSON.parse(peeked.stdout);
  assert.equal(out.decision.reason, 'emit');
  assert.equal(out.committed, false);
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), false, 'no slot');
  assert.equal(fs.existsSync(path.join(w.unit, 'emitted')), false, 'no ledger line');

  const launched = JSON.parse(emit(w, ['--json']).stdout);
  assert.equal(launched.committed, true, 'the real launch still bootstraps after a peek');
  assert.equal(launched.text, out.text);
});

test('IC-005 identity comes from the environment only: launch without a launched identity exits 2', (t) => {
  const w = world(t);
  for (const via of ['cli', 'run']) {
    const r = emit(w, ['--session', 'sess-1'], { env: {}, via });
    assert.equal(r.code, 2, `${via}: ${r.stderr}`);
    assert.match(r.stderr, /launched identity/);
    assert.equal(r.stdout, '');
  }
  // No flag supplies the identity the environment lacks.
  const flagged = emit(w, ['--run', 'r1'], { env: {} });
  assert.notEqual(flagged.code, 0);
  assert.equal(fs.existsSync(w.unit), false, 'nothing was claimed for the flag-named unit');
});

test('IC-005 usage errors exit 2: missing --cwd, bad --nudge, bad --max-bytes, bad event, invalid identity', (t) => {
  const w = world(t);
  const cases = [
    ['context-emit', '--event', 'launch'],
    ['context-emit', '--event', 'launch', '--cwd', w.cwd, '--nudge', 'loud'],
    ['context-emit', '--event', 'launch', '--cwd', w.cwd, '--max-bytes', '0'],
    ['context-emit', '--event', 'compact', '--cwd', w.cwd],
    ['context-emit', '--event', 'launch', '--cwd', path.join(w.root, 'missing')],
  ];
  for (const args of cases) {
    const r = run(w, args);
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  const invalid = emit(w, [], { env: { ...LAUNCHED, DOFLOW_RUN_ID: 'bad id!' } });
  assert.equal(invalid.code, 2, invalid.stderr);
  const json = emit(w, ['--json'], { env: {} });
  assert.equal(json.code, 2);
  assert.equal(JSON.parse(json.stdout).error, 'usage');
});

test('IC-005 a mandatory overflow exits 3 through both entries and gives the slot back', (t) => {
  const w = world(t);
  for (const via of ['cli', 'run']) {
    const r = emit(w, ['--max-bytes', '300', '--json'], { via });
    assert.equal(r.code, 3, `${via}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision.reason, 'refused:mandatory-over-budget');
    assert.equal(out.committed, false);
  }
  assert.equal(fs.existsSync(path.join(w.unit, 'injected')), false, 'the slot is released');
  const text = emit(w, ['--max-bytes', '300']);
  assert.equal(text.code, 3);
  assert.match(text.stdout, /^OVERFLOW \(exit 3\)/);
});

test('IC-013 context-grant exits 0 created, 1 already present, 1 not found', (t) => {
  const w = world(t);
  pending(w, 'Granted body');
  const created = run(w, ['context-grant', '--summary', 'pending', '--to-run', 'r1', '--to-lineage', 'w1', ...GRANT_SOURCE(w), '--json'], { env: {}, via: 'run' });
  assert.equal(created.code, 0, created.stderr);
  const out = JSON.parse(created.stdout);
  assert.match(out.summaryId, /^s-/);
  assert.equal(out.path, path.join(w.store, 'grants/r1/w1', `${out.summaryId}.md`));
  assert.ok(fs.readFileSync(out.path, 'utf8').includes('Granted body'));

  const again = run(w, ['context-grant', '--summary', out.summaryId, '--to-run', 'r1', '--to-lineage', 'w1', ...GRANT_SOURCE(w)], { env: {} });
  assert.equal(again.code, 1, again.stderr);
  assert.match(again.stderr, /already present/);

  const missing = run(w, ['context-grant', '--summary', 'pending', '--to-run', 'r1', '--to-lineage', 'w1', '--from-worktree', w.cwd, '--from-run', 'local', '--from-lineage', 'other'], { env: {} });
  assert.equal(missing.code, 1, missing.stderr);
});

test('IC-013 context-grant exits 2 on usage and 3 over budget, before any write', (t) => {
  const w = world(t);
  pending(w, 'x'.repeat(4000));
  const usage = [
    ['context-grant', '--summary', 'pending', '--to-lineage', 'w1', ...GRANT_SOURCE(w)],
    ['context-grant', '--summary', 'nope', '--to-run', 'r1', '--to-lineage', 'w1', ...GRANT_SOURCE(w)],
    ['context-grant', '--summary', 'pending', '--to-run', 'r1', '--to-lineage', 'w1', '--max-bytes', 'ten', ...GRANT_SOURCE(w)],
  ];
  for (const args of usage) {
    const r = run(w, args, { env: {} });
    assert.equal(r.code, 2, `${args.join(' ')}: ${r.stderr}`);
  }
  const over = run(w, ['context-grant', '--summary', 'pending', '--to-run', 'r1', '--to-lineage', 'w1', '--max-bytes', '1000', ...GRANT_SOURCE(w), '--json'], { env: {}, via: 'run' });
  assert.equal(over.code, 3, over.stderr);
  assert.equal(JSON.parse(over.stdout).error, 'over-budget');
  assert.equal(fs.existsSync(path.join(w.store, 'grants')), false, 'nothing written');
});
