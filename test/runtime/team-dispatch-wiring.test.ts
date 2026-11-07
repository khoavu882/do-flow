'use strict';

// 143 D.1 (IC-001, IC-003; FR-001, FR-003, FR-004, FR-005, FR-006, NFR-002): the dispatch half of the team
// wiring, tested where `loop.ts` and `admission.ts` meet `teamGate`. Fixtures are the dispatch sandbox
// (test/helper/dispatch-sandbox.ts: a scratch git repo, the disjoint plan, a real 080 ledger and a real
// dispatch store). Two kinds of case:
//   - `admit()` called directly, with and without a `team`, in two identical sandboxes with a fixed clock, so
//     the return value, the stored dispatch store and the attempt ledger can be compared field by field;
//   - `doflow dispatch --action step` run as a child process, with the telemetry switch on and off.
// Every directory is a temp directory; no network, no model call. POSIX only (the sandbox is).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');

const REPO = path.join(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SRC = path.join(REPO, 'src', 'runtime');
const attempts = require(path.join(SRC, 'task-attempts.ts'));
const store = require(path.join(SRC, 'dispatch', 'store.ts'));
const { admit } = require(path.join(SRC, 'dispatch', 'admission.ts'));
const { teamGate, evaluateAdmission } = require(path.join(SRC, 'team', 'evaluate.ts'));

const SLUG = '143-wiring-fixture';
const POSIX: any = { skip: process.platform === 'win32' && 'the dispatch sandbox is POSIX only (NFR-005)' };
const DRIVER: any = { pid: process.pid, start: null };
const CLOCK = () => new Date('2026-01-01T00:00:00.000Z');
const SUBAGENT = () => ({ mode: 'subagent', harness: 'claude' });
/** The fields of one `team.verdict` line: the common fields the writer adds plus the seven IC-003 fields. */
const LINE_KEYS = ['attempt', 'count', 'kind', 'lineage', 'mode', 'outcome', 'reason', 'rule', 'run', 'site', 'task', 'timestamp'];
const IS_ROOT = typeof process.getuid === 'function' && process.getuid() === 0;

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────────

function git(cwd: any, env: any, args: any) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Replaces ids, times, hashes and the sandbox's absolute paths, so two sandboxes compare equal. */
function normalize(value: any, sb: any) {
  // `traceId` is minted into the attempt ledger only while telemetry is on (not by the team wiring), so it is
  // dropped: the telemetry-off and telemetry-on runs compared below would otherwise differ by it alone.
  let text = typeof value === 'string' ? value : JSON.stringify(value, (k, v) => (k === 'traceId' ? undefined : v), 2);
  for (const r of [sb.root, sb.dir, sb.home].filter(Boolean).sort((a: string, b: string) => b.length - a.length)) text = text.split(r).join('<ROOT>');
  return text.split(process.execPath).join('<NODE>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<TS>')
    .replace(/\b[dpw]-[0-9a-f]{12}(\.c\d+)?\b/g, (m: string) => `<${m[0]}-ID>`)
    .replace(/\b[0-9a-f]{40}\b/g, '<SHA40>')
    .replace(/\b[0-9a-f]{64}\b/g, '<SHA64>')
    .replace(/\b[0-9a-f]{16}\/[0-9a-f]{12}\b/g, '<RUNKEY>')
    .replace(/\b[0-9a-f]{12}\b/g, '<HEX12>')
    .replace(/\b\d+(\.\d+)?ms\b/g, '<MS>')
    .replace(/"(ms|durationMs|elapsedMs|pid)": \d+/g, '"$1": <N>')
    .replace(/"start": "[A-Z][a-z]{2} [A-Z][a-z]{2} +\d+ [\d:]+ \d{4}"/g, '"start": "<PS-START>"')
    .replace(/"(worktreeKey|traceId|spanId)": "[0-9a-f]+"/g, '"$1": "<HEX>"');
}

/** A started 080 run plus a seeded dispatch run for `slug`; returns the handles a case needs. */
function seedRun(sb: any, { concurrency = 2, mode = 'auto' }: any = {}) {
  const { root, env } = sb;
  const ledgerFile = attempts.storeFile(root, SLUG);
  const common: any = { file: ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root };
  const started = attempts.start({ ...common, by: 'main' });
  assert.equal(started.disposition, 'started', JSON.stringify(started));
  const file = store.storeFileFor(root, SLUG);
  const head = git(root, env, ['rev-parse', 'HEAD']);
  store.mutateDispatch(file, (s: any) => {
    s.run = {
      dispatchRunId: store.newDispatchRunId(), state: 'running', runKey: started.runKey, epoch: started.epoch,
      concurrency, mode, reserveTokens: null, spawnGrant: null,
      integration: { worktree: null, branch: null, base: head, head },
      verify: { argv: sb.verifyArgv, argvSha256: null, argvCount: sb.verifyArgv.length, timeoutSeconds: 30 },
    };
    return { write: true, result: null };
  });
  return { ledgerFile, file, ctx: { ledgerFile, fsImpl: fs, roots: [root], slug: SLUG, env, cwd: root } };
}

/**
 * A sandbox with a seeded run, the run ledger directory the telemetry writer appends under, and optionally a
 * project `settings.json`. `settings` is an object (written as JSON) or a function receiving the file path.
 */
function project(t: any, { concurrency = 2, settings = null, env: extraEnv = {} }: any = {}) {
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
  const doflow = path.join(sb.root, '.doflow');
  const runs = path.join(doflow, 'state', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const settingsFile = path.join(doflow, 'settings.json');
  if (typeof settings === 'function') settings(settingsFile);
  else if (settings) fs.writeFileSync(settingsFile, JSON.stringify(settings));
  const env: any = { ...sb.env, ...extraEnv };
  const seeded = seedRun({ ...sb, env }, { concurrency });
  const telemetryDir = path.join(runs, 'telemetry');
  const lines = (): any[] => {
    if (!fs.existsSync(telemetryDir) || !fs.statSync(telemetryDir).isDirectory()) return [];
    return fs.readdirSync(telemetryDir).filter((n: string) => n.endsWith('.jsonl')).sort()
      .flatMap((n: string) => fs.readFileSync(path.join(telemetryDir, n), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)));
  };
  const rawText = () => (fs.existsSync(telemetryDir) && fs.statSync(telemetryDir).isDirectory()
    ? fs.readdirSync(telemetryDir).map((n: string) => fs.readFileSync(path.join(telemetryDir, n), 'utf8')).join('') : '');
  const gate = () => teamGate({ projectRoot: sb.root, env });
  const read = () => store.readDispatch(seeded.file);
  const ledger = () => JSON.parse(fs.readFileSync(seeded.ledgerFile, 'utf8'));
  const pass = (extra: any = {}) => admit({
    root: sb.root, slug: SLUG, ctx: seeded.ctx, env, driver: DRIVER, by: 'main', modeFor: SUBAGENT, now: CLOCK, ...extra,
  });
  /** What a pass leaves behind, normalised: its return value, the dispatch store and the attempt ledger. */
  const snapshot = (result: any) => normalize({ result, dispatch: read(), ledger: ledger() }, sb);
  const worktrees = () => git(sb.root, env, ['worktree', 'list', '--porcelain']).split('\n').filter((l: string) => l.startsWith('worktree '));
  return { sb, root: sb.root, env, ...seeded, telemetryDir, runs, settingsFile, lines, rawText, gate, read, ledger, pass, snapshot, worktrees };
}

/**
 * The snapshot of one pass in a fresh sandbox with no `team` (the pre-wiring behaviour). `gated` instead runs
 * the pass with the real gate and the telemetry switch off: the reference for block mode, where the gate's
 * decision is part of the outcome and only the recording is to be taken away.
 */
function reference(t: any, options: any = {}, gated = false) {
  const p = project(t, gated ? { ...options, env: { ...options.env, DOFLOW_TELEMETRY: 'off' } } : options);
  return p.snapshot(p.pass(gated ? { team: p.gate() } : {}));
}

const lineFields = (line: any) => ({
  site: line.site, rule: line.rule, outcome: line.outcome, reason: line.reason, mode: line.mode, task: line.task, count: line.count,
});

/** A child-process `doflow dispatch` run in the sandbox; the telemetry switch comes from `extraEnv`. */
function cli(sb: any, args: string[], extraEnv: any = {}) {
  return spawnSync(process.execPath, [CLI, 'dispatch', ...args], { cwd: sb.root, env: { ...sb.env, ...extraEnv }, encoding: 'utf8' });
}

/** Starts a sequential, concurrency-2 run and takes one step (as the A.1 baseline captured it). */
function cliStep(t: any, { json = false, settings = null, extraEnv = {}, prepare = null }: any = {}) {
  const sb = makeDispatchSandbox(t, { plan: 'disjoint', slug: SLUG });
  const doflow = path.join(sb.root, '.doflow');
  fs.mkdirSync(path.join(doflow, 'state', 'runs'), { recursive: true });
  if (settings) fs.writeFileSync(path.join(doflow, 'settings.json'), JSON.stringify(settings));
  if (prepare) prepare(sb);
  const started = cli(sb, ['--action', 'start', '--slug', SLUG, '--by', 'main', '--mode', 'sequential', '--concurrency', '2', '--verify-argv', JSON.stringify(sb.verifyArgv)], extraEnv);
  assert.equal(started.status, 0, started.stderr || started.stdout);
  const res = cli(sb, ['--action', 'step', '--slug', SLUG, '--by', 'main', ...(json ? ['--json'] : [])], extraEnv);
  const file = store.storeFileFor(sb.root, SLUG);
  const telemetryDir = path.join(doflow, 'state', 'runs', 'telemetry');
  const lines = fs.existsSync(telemetryDir) && fs.statSync(telemetryDir).isDirectory()
    ? fs.readdirSync(telemetryDir).flatMap((n: string) => fs.readFileSync(path.join(telemetryDir, n), 'utf8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l)))
    : [];
  return {
    sb, res, lines,
    out: normalize(res.stdout || '', sb), err: normalize(res.stderr || '', sb), exit: res.status,
    record: normalize({ dispatch: store.readDispatch(file), ledger: JSON.parse(fs.readFileSync(attempts.storeFile(sb.root, SLUG), 'utf8')) }, sb),
  };
}

// ── (1) default and advisory output equals the pre-wiring behaviour ─────────────────────────────────

test('FR-004: admit() with a teamGate and the team keys unset leaves the return value, store and ledger as admit() without team', POSIX, (t) => {
  const baseline = reference(t);
  const p = project(t);
  assert.equal(p.gate().mode, 'advisory');
  const result = p.pass({ team: p.gate() });
  assert.equal(p.snapshot(result), baseline);
  assert.equal(result.admitted.length, 2, 'advisory with the cap-1 default still admits both candidates');
});

test('FR-004: explicit advisory with writerCap 1 and a refused second writer still leaves the pass unchanged', POSIX, (t) => {
  const settings = { 'team.enforcement': 'advisory', 'team.writerCap': 1 };
  const baseline = reference(t, { settings });
  const p = project(t, { settings });
  const gate = p.gate();
  assert.equal(gate.mode, 'advisory');
  const result = p.pass({ team: gate });
  assert.equal(p.snapshot(result), baseline);
  assert.equal(result.admitted.length, 2, 'advisory: both writers are admitted although the cap is 1');
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1', 'A.2']);
});

test('FR-004: `dispatch --action step` stdout, exit code and stored record are the same with the wiring recording and with telemetry off', POSIX, (t) => {
  for (const json of [false, true]) {
    const off = cliStep(t, { json, extraEnv: { DOFLOW_TELEMETRY: 'off' } });
    const unset = cliStep(t, { json });
    const advisory = cliStep(t, { json, settings: { 'team.enforcement': 'advisory' } });
    assert.equal(off.exit, 0, off.err);
    assert.equal(off.lines.length, 0, 'telemetry off writes no line');
    for (const other of [unset, advisory]) {
      assert.equal(other.exit, off.exit);
      assert.equal(other.out, off.out, 'stdout');
      assert.equal(other.err, off.err, 'stderr');
      assert.equal(other.record, off.record, 'the stored step record, dispatch store and ledger');
      assert.equal(other.lines.length, 1, 'sequential mode, one slot: one evaluated candidate, one line');
      assert.deepEqual(lineFields(other.lines[0]), {
        site: 'dispatch-admit', rule: 'admission', outcome: 'admitted', reason: null, mode: 'advisory', task: 'A.1', count: null,
      });
    }
  }
});

test('FR-004: block mode with no refusal leaves the step output and stored record as with telemetry off', POSIX, (t) => {
  const off = cliStep(t, { extraEnv: { DOFLOW_TELEMETRY: 'off' } });
  const block = cliStep(t, { settings: { 'team.enforcement': 'block' } });
  assert.equal(block.exit, off.exit);
  assert.equal(block.out, off.out);
  assert.equal(block.record, off.record);
  assert.equal(block.lines.length, 1);
  assert.equal(block.lines[0].mode, 'block');
  assert.equal(block.lines[0].outcome, 'admitted');
});

// ── (2) one line per evaluated candidate, IC-003 fields only ────────────────────────────────────────

test('FR-003: one team.verdict line per evaluated candidate, carrying the IC-003 fields only and no path', POSIX, (t) => {
  const p = project(t, { concurrency: 4, settings: { 'team.writerCap': 4 } });
  const result = p.pass({ team: p.gate() });
  assert.equal(result.admitted.length, 4);
  const lines = p.lines();
  assert.equal(lines.length, 4, 'A.1 to A.4 are each evaluated once');
  for (const line of lines) {
    assert.deepEqual(Object.keys(line).sort(), LINE_KEYS);
    assert.equal(line.kind, 'team.verdict');
  }
  assert.deepEqual(lines.map(lineFields), ['A.1', 'A.2', 'A.3', 'A.4'].map((task) => ({
    site: 'dispatch-admit', rule: 'admission', outcome: 'admitted', reason: null, mode: 'advisory', task, count: null,
  })));
  const raw = p.rawText();
  for (const leak of ['src/a.js', 'src/b.js', p.root, 'README']) assert.equal(raw.includes(leak), false, `no ${leak} in the line`);
});

test('FR-003: candidates skipped before the evaluation point are not evaluated', POSIX, (t) => {
  const p = project(t, { concurrency: 2, settings: { 'team.writerCap': 4 } });
  const result = p.pass({ team: p.gate() });
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1', 'A.2']);
  assert.deepEqual(result.skipped.map((s: any) => [s.task, s.reason]), [['A.3', 'concurrency'], ['A.4', 'concurrency']]);
  assert.deepEqual(p.lines().map((l: any) => l.task), ['A.1', 'A.2'], 'the two `concurrency` skips are not evaluated');
});

test('FR-003: a pass that evaluates nothing records nothing', POSIX, (t) => {
  const p = project(t, { concurrency: 1 });
  assert.equal(p.pass().admitted.length, 1, 'the first pass (no team) fills the one slot');
  assert.equal(p.pass({ team: p.gate() }).outcome, 'concurrency-full');
  assert.equal(p.lines().length, 0);
  assert.equal(fs.existsSync(p.telemetryDir), false, 'no telemetry directory is created');
});

// ── (3) WRITER_CAP_EXCEEDED for the second writer ───────────────────────────────────────────────────

test('FR-001: at writerCap 1 the second writer gets WRITER_CAP_EXCEEDED and, in advisory, is still admitted', POSIX, (t) => {
  const p = project(t, { concurrency: 2 });
  const gate = p.gate();
  assert.deepEqual([gate.mode, gate.limits.writerCap], ['advisory', 1]);
  const result = p.pass({ team: gate });
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1', 'A.2'], 'advisory admits both');
  assert.deepEqual(result.skipped.filter((s: any) => String(s.reason).startsWith('team:')), []);
  assert.deepEqual(p.lines().map(lineFields), [
    { site: 'dispatch-admit', rule: 'admission', outcome: 'admitted', reason: null, mode: 'advisory', task: 'A.1', count: null },
    { site: 'dispatch-admit', rule: 'admission', outcome: 'refused', reason: 'WRITER_CAP_EXCEEDED', mode: 'advisory', task: 'A.2', count: null },
  ]);
});

test('FR-001: a raised writerCap admits the second writer and records no refusal', POSIX, (t) => {
  const p = project(t, { concurrency: 2, settings: { 'team.writerCap': 2 } });
  const result = p.pass({ team: p.gate() });
  assert.equal(result.admitted.length, 2);
  assert.deepEqual(p.lines().map((l: any) => l.outcome), ['admitted', 'admitted']);
});

// ── (4) block mode ──────────────────────────────────────────────────────────────────────────────────

test('FR-006: block mode skips the refused writer as team:WRITER_CAP_EXCEEDED and creates no worktree or dispatch for it', POSIX, (t) => {
  const p = project(t, { concurrency: 2, settings: { 'team.enforcement': 'block' } });
  const gate = p.gate();
  assert.equal(gate.mode, 'block');
  const result = p.pass({ team: gate });
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1']);
  assert.deepEqual(result.skipped.map((s: any) => [s.task, s.reason]), [
    ['A.2', 'team:WRITER_CAP_EXCEEDED'], ['A.3', 'team:WRITER_CAP_EXCEEDED'], ['A.4', 'team:WRITER_CAP_EXCEEDED'],
  ], 'the loop continues past each refused candidate');
  assert.ok(result.actions.some((a: any) => /skipped:team:WRITER_CAP_EXCEEDED/.test(JSON.stringify(a))), 'the skip is a step action');

  const dispatches = Object.values(p.read().dispatches) as any[];
  assert.deepEqual(dispatches.map((d) => d.task), ['A.1'], 'no dispatch record for a blocked task');
  const attemptTrees = p.worktrees().filter((w: string) => w.includes(`${path.sep}dispatch-worktrees${path.sep}`));
  assert.equal(attemptTrees.length, 1, `one attempt worktree (A.1's) exists: ${attemptTrees.join(' | ')}`);
  assert.equal(p.worktrees().length, 2, 'the main checkout plus the one admitted attempt worktree');

  assert.deepEqual(p.lines().map((l: any) => [l.task, l.outcome, l.reason, l.mode]), [
    ['A.1', 'admitted', null, 'block'],
    ['A.2', 'refused', 'WRITER_CAP_EXCEEDED', 'block'],
    ['A.3', 'refused', 'WRITER_CAP_EXCEEDED', 'block'],
    ['A.4', 'refused', 'WRITER_CAP_EXCEEDED', 'block'],
  ], 'a block-mode refused dispatch-admit line marks a skipped candidate');
});

test('FR-006: block mode admits both writers when the cap allows it', POSIX, (t) => {
  const p = project(t, { concurrency: 2, settings: { 'team.enforcement': 'block', 'team.writerCap': 2 } });
  const result = p.pass({ team: p.gate() });
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1', 'A.2']);
  assert.deepEqual(result.skipped.filter((s: any) => String(s.reason).startsWith('team:')), []);
});

// ── (5) the verdict is recorded after the store lock is released ────────────────────────────────────

test('NFR-002: evaluate runs while the store lock is held; record runs after it is released and after the write', POSIX, (t) => {
  const p = project(t, { concurrency: 2 });
  const lock = `${p.file}.lock`;
  const real = p.gate();
  const events: string[] = [];
  let evaluated = 0;
  let recorded: any[] | null = null;
  let storedAtRecord: string[] = [];
  const team = {
    mode: real.mode, limits: real.limits,
    evaluate: (input: any) => {
      evaluated += 1;
      events.push(`evaluate:${input.task}:lock=${fs.existsSync(lock)}`);
      return real.evaluate(input);
    },
    record: (verdicts: any[]) => {
      events.push(`record:lock=${fs.existsSync(lock)}`);
      storedAtRecord = (Object.values(p.read().dispatches) as any[]).map((d) => d.task);
      recorded = verdicts;
    },
  };
  const result = p.pass({ team });
  assert.equal(result.admitted.length, 2);
  assert.equal(evaluated, 2);
  assert.deepEqual(events, ['evaluate:A.1:lock=true', 'evaluate:A.2:lock=true', 'record:lock=false'], 'the lock probe sees the lock held in evaluate and gone in record');
  assert.equal(recorded!.length, 2, 'record is called once with every verdict of the pass');
  assert.deepEqual(storedAtRecord, ['A.1', 'A.2'], 'the admitted slots were already written when record ran');
  assert.equal(p.lines().length, 0, 'the injected recorder replaced the telemetry write');
});

test('NFR-002: the real recorder runs after the lock too (the line exists once admit returns, the lock does not)', POSIX, (t) => {
  const p = project(t, { concurrency: 2 });
  const real = p.gate();
  let lockAtWrite: boolean | null = null;
  const team = { ...real, record: (v: any[]) => { lockAtWrite = fs.existsSync(`${p.file}.lock`); real.record(v); } };
  p.pass({ team });
  assert.equal(lockAtWrite, false);
  assert.equal(p.lines().length, 2);
});

// ── (6) faults never change the step ────────────────────────────────────────────────────────────────

for (const mode of ['advisory', 'block']) {
  test(`FR-005: a throwing evaluate leaves the pass as without team and never throws (${mode})`, POSIX, (t) => {
    const baseline = reference(t);
    const p = project(t, { settings: { 'team.enforcement': mode } });
    const real = p.gate();
    let calls = 0;
    const team = { ...real, evaluate: () => { calls += 1; throw new Error('evaluate boom'); } };
    let result: any;
    assert.doesNotThrow(() => { result = p.pass({ team }); });
    assert.equal(calls, 2, 'both candidates reached the evaluation');
    assert.equal(p.snapshot(result), baseline);
    assert.equal(p.lines().length, 0, 'a throwing evaluate yields no verdict to record');
  });

  test(`FR-005: a throwing recorder leaves the pass as with a working recorder and never throws (${mode})`, POSIX, (t) => {
    const baseline = reference(t, { settings: { 'team.enforcement': mode } }, true);
    const p = project(t, { settings: { 'team.enforcement': mode } });
    let calls = 0;
    const team = { ...p.gate(), record: () => { calls += 1; throw new Error('record boom'); } };
    let result: any;
    assert.doesNotThrow(() => { result = p.pass({ team }); });
    assert.equal(calls, 1);
    assert.equal(p.snapshot(result), baseline);
  });
}

test('FR-005: an unwritable telemetry location (a file where the directory belongs) leaves the pass unchanged', POSIX, (t) => {
  const baseline = reference(t);
  const p = project(t);
  fs.writeFileSync(p.telemetryDir, 'not a directory');
  let result: any;
  assert.doesNotThrow(() => { result = p.pass({ team: p.gate() }); });
  assert.equal(p.snapshot(result), baseline);
  assert.equal(fs.readFileSync(p.telemetryDir, 'utf8'), 'not a directory', 'the obstruction was not replaced');
});

test('FR-005: a read-only telemetry directory leaves the pass unchanged', { skip: (process.platform === 'win32' || IS_ROOT) && 'permission bits are not enforced here' }, (t) => {
  const baseline = reference(t);
  const p = project(t);
  fs.mkdirSync(p.telemetryDir);
  fs.chmodSync(p.telemetryDir, 0o500);
  t.after(() => { try { fs.chmodSync(p.telemetryDir, 0o700); } catch { /* the sandbox is already gone */ } });
  let result: any;
  assert.doesNotThrow(() => { result = p.pass({ team: p.gate() }); });
  assert.equal(p.snapshot(result), baseline);
  assert.deepEqual(fs.readdirSync(p.telemetryDir), [], 'nothing was written');
});

test('FR-005: `dispatch --action step` with an unwritable telemetry location prints what telemetry off prints', POSIX, (t) => {
  const off = cliStep(t, { extraEnv: { DOFLOW_TELEMETRY: 'off' } });
  const blocked = cliStep(t, {
    prepare: (sb: any) => fs.writeFileSync(path.join(sb.root, '.doflow', 'state', 'runs', 'telemetry'), 'not a directory'),
  });
  assert.equal(blocked.exit, off.exit);
  assert.equal(blocked.out, off.out);
  assert.equal(blocked.err, off.err);
  assert.equal(blocked.record, off.record);
});

for (const [label, make] of [
  ['malformed JSON', (file: string) => fs.writeFileSync(file, '{"team.enforcement": "block"')],
  ['a directory where the file belongs', (file: string) => fs.mkdirSync(file)],
  ['a wrongly typed value', (file: string) => fs.writeFileSync(file, JSON.stringify({ 'team.enforcement': 7, 'team.writerCap': 'many', 'team.maxAttempts': null }))],
] as Array<[string, (file: string) => void]>) {
  test(`FR-005: unreadable project settings (${label}) give advisory, the shipped limits and an unchanged pass`, POSIX, (t) => {
    const baseline = reference(t);
    const p = project(t, { settings: make });
    let gate: any;
    assert.doesNotThrow(() => { gate = p.gate(); });
    assert.deepEqual([gate.mode, gate.limits], ['advisory', { writerCap: 1, maxAttempts: 3 }]);
    let result: any;
    assert.doesNotThrow(() => { result = p.pass({ team: gate }); });
    assert.equal(p.snapshot(result), baseline);
    assert.equal(p.lines().length, 2, 'both candidates were still evaluated and recorded');
    assert.equal(p.lines()[1].mode, 'advisory');
  });
}

test('FR-005: a settings file the process cannot read (mode 000) gives advisory and an unchanged pass', { skip: (process.platform === 'win32' || IS_ROOT) && 'permission bits are not enforced here' }, (t) => {
  const baseline = reference(t);
  const p = project(t, { settings: { 'team.enforcement': 'block' } });
  fs.chmodSync(p.settingsFile, 0o000);
  t.after(() => { try { fs.chmodSync(p.settingsFile, 0o600); } catch { /* the sandbox is already gone */ } });
  const gate = p.gate();
  assert.equal(gate.mode, 'advisory');
  assert.equal(p.snapshot(p.pass({ team: gate })), baseline);
});

// ── (7) an `error` verdict never blocks ─────────────────────────────────────────────────────────────

test('FR-005/FR-006: an error verdict never blocks, even in block mode, and is recorded as eval-fault', POSIX, (t) => {
  const baseline = reference(t);
  const p = project(t, { settings: { 'team.enforcement': 'block' } });
  const real = p.gate();
  assert.equal(real.mode, 'block');
  // The module's own error path: limits the controller cannot be built with give `error` / `eval-fault`.
  const team = { ...real, evaluate: (input: any) => evaluateAdmission(input, null as any) };
  assert.equal(team.evaluate({ task: 'A.1', files: ['src/a.js'], mode: 'block' }).outcome, 'error');
  const result = p.pass({ team });
  assert.equal(p.snapshot(result), baseline, 'the pass equals the no-team pass');
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1', 'A.2']);
  assert.deepEqual(result.skipped.filter((s: any) => String(s.reason).startsWith('team:')), []);
  const lines = p.lines();
  assert.deepEqual(lines.map((l: any) => [l.task, l.outcome, l.reason, l.mode]), [
    ['A.1', 'error', 'eval-fault', 'block'], ['A.2', 'error', 'eval-fault', 'block'],
  ]);
});

test('FR-005/FR-006: evaluateAdmission itself answers error/eval-fault for an unusable input and never throws', () => {
  for (const input of [null, undefined, {}, { task: 'A.1', files: ['x'], active: [{ task: 'B', files: ['x'] }], mode: 'block' }] as any[]) {
    let v: any;
    assert.doesNotThrow(() => { v = evaluateAdmission(input, { writerCap: 1, maxAttempts: 3 }); });
    assert.equal(v.site, 'dispatch-admit');
    assert.ok(['admitted', 'refused', 'error'].includes(v.outcome), v.outcome);
    if (v.outcome === 'error') assert.equal(v.reason, 'eval-fault');
  }
});

// ── (8) DOFLOW_TELEMETRY=off ────────────────────────────────────────────────────────────────────────

test('DOFLOW_TELEMETRY=off writes no line and no telemetry directory, and the pass is unchanged', POSIX, (t) => {
  const baseline = reference(t);
  const p = project(t, { env: { DOFLOW_TELEMETRY: 'off' }, settings: { 'team.enforcement': 'advisory' } });
  const result = p.pass({ team: p.gate() });
  assert.equal(p.snapshot(result), baseline);
  assert.equal(p.lines().length, 0);
  assert.equal(fs.existsSync(p.telemetryDir), false);
});

test('DOFLOW_TELEMETRY=off in block mode still skips the refused writer but writes no line', POSIX, (t) => {
  const p = project(t, { env: { DOFLOW_TELEMETRY: 'off' }, settings: { 'team.enforcement': 'block' } });
  const result = p.pass({ team: p.gate() });
  assert.deepEqual(result.admitted.map((a: any) => a.task), ['A.1']);
  assert.equal(result.skipped[0].reason, 'team:WRITER_CAP_EXCEEDED', 'enforcement does not depend on the recording switch');
  assert.equal(p.lines().length, 0);
});
