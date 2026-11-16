'use strict';

// Row 174 (O-2, O-3, O-5): a shadow decision-model call runs in a detached child, so it never costs wall time on a
// command a person waits on, and every advice kind's budgetMs bounds its call, shadow or act. The model is a fake
// server; every spawn here runs with HOME and XDG_CONFIG_HOME in a temp dir and the advice endpoint on the fake, so no
// detached child can reach a real model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { startFakeServer, answering } = require('../helper/fake-decision-server.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { readWindow } = require('../../src/runtime/advice/record.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { createAdviceClient } = require('../../src/runtime/advice/client.ts');
const { materializeKind } = require('../../src/runtime/advice/kinds.ts');
const { interceptDecisionPoint } = require('../../src/runtime/advice/shadow-dispatcher.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const DISPATCHER = path.join(REPO_ROOT, 'src/runtime/advice/shadow-dispatcher.ts');
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const ADVICE = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry;
const TIER = materializeKind('tier', { adviceRegistry: ADVICE }).question;
const SHADOW = { kind: 'tier', mode: 'shadow', model: 'm' };
/** How long past its budget a detached child may take to start, ask, record and exit on a loaded machine. */
const CHILD_SLACK_MS = 3000;

const budgetOf = (kind: string) => ADVICE.kinds.find((entry: any) => entry.id === kind).budgetMs;

/** The shipped registry with one kind's budgetMs replaced; a full registry crosses to the detached child as data. */
function registryWith(kind: string, budgetMs: number) {
  const registry = JSON.parse(JSON.stringify(ADVICE));
  registry.kinds.find((entry: any) => entry.id === kind).budgetMs = budgetMs;
  return registry;
}

async function waitFor(check: () => any, ms = 5000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return check();
}

const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/**
 * A fake model answering `route` (the stalled reply by default) that keeps every connection, so a test can tell
 * whether the caller dropped its request: a detached child that exits closes its sockets.
 */
async function fakeModel(t: any, route: any = { stall: true }) {
  const fake: any = await startFakeServer({ routes: { 'POST /v1/systemone': route } });
  const sockets: any[] = [];
  fake.server.on('connection', (socket: any) => sockets.push(socket));
  t.after(() => fake.close());
  return {
    origin: fake.origin,
    asks: () => fake.requests.filter((request: any) => request.pathname === '/v1/systemone'),
    allClosed: () => sockets.every((socket: any) => socket.destroyed),
    sockets,
  };
}

/** A project and a user home under one temp dir with advice on against `origin`, the roots, records and slot files. */
function store(t: any, origin: string) {
  const dir = tempDir(t, 'doflow-advice-detach-');
  const projectRoot = path.join(dir, 'proj');
  fs.mkdirSync(projectRoot);
  const env = { HOME: path.join(dir, 'home'), XDG_CONFIG_HOME: path.join(dir, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot, env });
  fs.mkdirSync(roots['config-home'], { recursive: true });
  fs.writeFileSync(path.join(roots['config-home'], 'settings.json'), JSON.stringify({
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': origin, 'advice.model': 'clef-flash',
  }));
  const slots = path.join(roots['user-state'], 'advice', 'shadow-slots');
  return {
    dir, projectRoot, env, roots, slots,
    lines: () => readWindow({ roots }).records.map((entry: any) => entry.record),
    slotFiles: () => (fs.existsSync(slots) ? fs.readdirSync(slots).sort() : []),
  };
}

function ctx(s: any, extra: any = {}) {
  const state = 'Implement an integration spanning several runtime modules.';
  return {
    kind: 'tier', caller: 'brief-tools', state, staticPick: 'light', taskId: 'task-abc',
    questionSet: { state, questions: [TIER] }, adviceRegistry: ADVICE, projectRoot: s.projectRoot, env: s.env, ...extra,
  };
}

/** Holds every one of the user's shadow slots as `holder` (pid, startedAt, budgetMs) would. */
function holdSlots(s: any, holder: any) {
  fs.mkdirSync(s.slots, { recursive: true });
  for (let index = 0; index < ADVICE.shadowSlots; index += 1) {
    fs.writeFileSync(path.join(s.slots, `slot-${index}.json`), JSON.stringify({ token: `held${index}`, budgetMs: 60000, ...holder }));
  }
}

/** The pid of a process that has exited. */
function deadPid() {
  const run = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(run.stdout);
}

// ── A1: the command a person waits on is not held by the model ───────────────────────────────────────────────────

/**
 * One scratch checkout and user home for the three commands that ask a shadow kind: a git repository with one change
 * (review start), a task with one evidence item (claim link) and advice on against `origin`.
 * `kinds(mode)` sets every asked kind to `mode` in the project settings.
 */
function cliFixture(t: any, origin: string) {
  const dir = tempDir(t, 'doflow-advice-detach-cli-');
  const home = path.join(dir, 'home');
  const work = path.join(dir, 'work');
  const config = path.join(dir, 'doflow-config');
  fs.mkdirSync(path.join(home, '.config', 'doflow'), { recursive: true });
  fs.mkdirSync(work);
  const env: any = {
    PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    DOFLOW_TELEMETRY: 'off', DOFLOW_AUTOPILOT_ENABLED: 'off', DOFLOW_CONFIG_DIR: config, TMPDIR: process.env.TMPDIR,
  };
  if (process.env.NODE_COMPILE_CACHE) env.NODE_COMPILE_CACHE = process.env.NODE_COMPILE_CACHE;
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), text);
  };
  const git = (...args: string[]) => {
    const res = spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: work, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr);
    return res.stdout.trim();
  };
  const cli = (...args: string[]) => {
    const res = spawnSync(process.execPath, [CLI, ...args], { cwd: work, env, encoding: 'utf8' });
    assert.equal(res.status, 0, res.stderr || res.stdout);
    return JSON.parse(res.stdout);
  };
  fs.writeFileSync(path.join(home, '.config', 'doflow', 'settings.json'), JSON.stringify({
    schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': origin, 'advice.model': 'clef-flash',
  }));
  git('init', '-q', '-b', 'main');
  put('.git/info/exclude', '.doflow/\n');
  put('src/a.ts', 'export const ttl = 300; // the cache TTL is 300 seconds\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  put('docs/a.md', 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'change');
  const head = git('rev-parse', 'HEAD');
  const slug = '174-detach';
  put(`.doflow/state/orchestration/${slug}.json`, JSON.stringify({ taskId: slug, taskClass: 'bug', state: 'ACTIVE', program: [], history: [] }));
  put(`.doflow/state/verification/runs/${slug}.jsonl`, `${JSON.stringify({ schema: 1, taskId: slug, head, clean: true, verdict: 'PASS', risk: 'LOW', at: '2026-10-23T00:00:00.000Z', reportSha256: 'x' })}\n`);
  const evidence = cli('evidence', '--action', 'add', '--task-id', 't1', '--kind', 'exact-search', '--provenance', 'extracted',
    '--provider', 'rg', '--capability', 'exact-search', '--locator', 'src/a.ts:1', '--content', 'the cache TTL is 300 seconds', '--json').evidence[0].id;
  const roots = resolveRoots({ registry: STORAGE, projectRoot: work, env });
  return {
    roots,
    kinds: (mode: string) => put('.doflow/settings.json', JSON.stringify({ advice: { kinds: { 'task-class': mode, 'claim-support': mode, 'review-depth': mode } } })),
    /** Each command's argument list; `claim link` links a fresh claim on every run, so every run does the same work. */
    commands: {
      classify: { kind: 'task-class', args: () => ['classify', '--task-class', 'bug', '--calling-skill', 'do', '--request', 'A broken behavior needs a repair.', '--json'] },
      'claim link': {
        kind: 'claim-support',
        args: () => ['claim', '--action', 'link', '--task-id', 't1', '--evidence-id', evidence, '--relation', 'supports', '--json',
          '--claim-id', cli('claim', '--action', 'add', '--task-id', 't1', '--statement', 'The cache TTL is 300 seconds', '--json').claim.id],
      },
      'review start': { kind: 'review-depth', args: () => ['review', '--action', 'start', '--slug', slug, '--base', base, '--json'] },
    } as Record<string, { kind: string; args: () => string[] }>,
    /** Runs the CLI to its exit and returns the wall time; a run still alive at `killAfterMs` is killed and fails. */
    run: (args: string[], killAfterMs: number) => new Promise<{ ms: number; code: any; out: string }>((resolve) => {
      const started = process.hrtime.bigint();
      const child = spawn(process.execPath, [CLI, ...args], { cwd: work, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', (chunk: any) => { out += chunk; });
      child.stderr.on('data', (chunk: any) => { out += chunk; });
      const killer = setTimeout(() => child.kill('SIGKILL'), killAfterMs);
      child.on('close', (code: any) => {
        clearTimeout(killer);
        resolve({ ms: Number(process.hrtime.bigint() - started) / 1e6, code, out });
      });
    }),
  };
}

/**
 * Off/shadow pairs per command in A1. Each pair runs both arms back to back, in alternating order (off then shadow, then
 * shadow then off), so load that drifts across the run hits both arms of a pair alike and neither arm always goes first.
 */
const A1_PAIRS = 9;

test('A1: classify, claim link and review start end within 100 ms of the kind-off run while the model stalls', async (t) => {
  const model = await fakeModel(t);
  const f = cliFixture(t, model.origin);
  f.kinds('off');
  for (const [name, command] of Object.entries(f.commands)) {
    const times: Record<string, number[]> = { off: [], shadow: [] };
    const asksBefore = model.asks().length;
    const linesBefore = readWindow({ roots: f.roots }).records.length;
    const budget = budgetOf(command.kind);
    const slotDir = path.join(f.roots['user-state'], 'advice', 'shadow-slots');
    const slotPids = () => (fs.existsSync(slotDir) ? fs.readdirSync(slotDir) : []).map((name: string) => {
      try { return JSON.parse(fs.readFileSync(path.join(slotDir, name), 'utf8')).pid; } catch { return null; }
    }).filter(Number.isInteger);
    const children = new Set<number>();
    let lastShadowAt = 0;
    for (let pair = 0; pair < A1_PAIRS; pair += 1) {
      for (const mode of pair % 2 === 0 ? ['off', 'shadow'] : ['shadow', 'off']) {
        if (mode === 'shadow') {
          // Untimed set-up: a free slot for this run's child, which would otherwise record a busy miss and never ask.
          const free = await waitFor(() => slotPids().length < ADVICE.shadowSlots, budget + CHILD_SLACK_MS);
          assert.ok(free, `${name}: every shadow slot was still held ${budget + CHILD_SLACK_MS} ms later`);
        }
        f.kinds(mode);
        const killAfter = mode === 'off' ? 30000 : median(times.off.length ? times.off : [30000]) + 2000;
        const res = await f.run(command.args(), killAfter);
        assert.equal(res.code, 0, `${name} (${mode}) exited ${res.code}: ${res.out.slice(0, 500)}`);
        times[mode].push(res.ms);
        if (mode === 'shadow') {
          lastShadowAt = Date.now();
          // The detached child holds a slot while the stalled model keeps it waiting: its pid is read from there.
          const known = children.size;
          await waitFor(() => { slotPids().forEach((pid: number) => children.add(pid)); return children.size > known; }, budget - 200);
        }
      }
    }
    // The statistic: the median over the pairs of (shadow run - off run of the same pair). A paired difference cancels
    // the load both runs of a pair share, and the median of nine ignores the few pairs a burst of load hit on one side.
    const diffs = times.shadow.map((ms, index) => ms - times.off[index]);
    const gap = median(diffs);
    t.diagnostic(`${name}: off ${times.off.map(Math.round).join('/')} ms, shadow ${times.shadow.map(Math.round).join('/')} ms, paired differences ${diffs.map(Math.round).join('/')} ms, median ${Math.round(gap)} ms`);
    assert.ok(gap <= 100, `${name} with the kind in shadow took ${Math.round(gap)} ms longer (median of ${A1_PAIRS} paired differences) than with it off`);
    // Every detached call reached the stalled model, dropped it at the kind budget, recorded a timeout and exited.
    assert.equal(children.size, A1_PAIRS, `${name}: each shadow run left one detached child holding a slot`);
    const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch (error: any) { return error.code === 'ESRCH'; } };
    const settled = await waitFor(() => readWindow({ roots: f.roots }).records.length >= linesBefore + A1_PAIRS && model.allClosed()
      && slotPids().length === 0 && [...children].every(gone), Math.max(0, lastShadowAt + budget + CHILD_SLACK_MS - Date.now()));
    assert.ok(settled, `${name}: a detached child was still running ${budget + CHILD_SLACK_MS} ms after the last spawn (`
      + `${readWindow({ roots: f.roots }).records.length - linesBefore} of ${A1_PAIRS} recorded, sockets all closed ${model.allClosed()}, `
      + `${slotPids().length} slots held, ${[...children].filter((pid) => !gone(pid)).length} children alive)`);
    assert.equal(model.asks().length - asksBefore, A1_PAIRS, `${name}: one model request per shadow run`);
    const lines = readWindow({ roots: f.roots }).records.slice(linesBefore).map((entry: any) => entry.record);
    assert.deepEqual(lines.map((line: any) => [line.type, line.kind, line.mode, line.reason]), Array(A1_PAIRS).fill(['miss', command.kind, 'shadow', 'timeout']));
    for (const line of lines) assert.ok(line.durationMs >= budget - 50 && line.durationMs < budget + 1000, `${name}: a call ran ${line.durationMs} ms against its ${budget} ms budget`);
  }
});

// ── O-5: the payload reaches the child in memory and survives the parent's exit ──────────────────────────────────

// The shipped registry stays behind, so its payload fits one pipe buffer; an injected registry crosses with the state,
// past 64 KiB, and the parent's write waits for the child to read it.
for (const [which, registry] of [['the shipped registry', ADVICE], ['an injected registry (a payload past 64 KiB)', registryWith('tier', budgetOf('tier') - 1)]]) {
  test(`O-5: a near-maximal state reaches the detached child whole although the parent exits right after the call, with ${which}`, async (t) => {
    const model = await fakeModel(t, answering(() => 'frontier'));
    const s = store(t, model.origin);
    // 200 bytes under limits.maxStateBytes, with enough newlines that the state's JSON form plus a registry is past
    // 64 KiB, while the request body (the state's JSON form plus the question) stays within limits.maxBodyBytes.
    const newlines = 11500;
    const state = 'a\n'.repeat(newlines) + 'b'.repeat(ADVICE.limits.maxStateBytes - 200 - 2 * newlines);
    assert.equal(Buffer.byteLength(state), ADVICE.limits.maxStateBytes - 200);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) + Buffer.byteLength(JSON.stringify(registry)) > 65536);
    const context = { ...ctx(s), state, questionSet: { state, questions: [TIER] }, adviceRegistry: registry };
    const script = `
      const { interceptDecisionPoint } = require(${JSON.stringify(DISPATCHER)});
      const context = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
      const started = process.hrtime.bigint();
      interceptDecisionPoint(context, { roots: ${JSON.stringify(s.roots)}, shadowConfig: ${JSON.stringify(SHADOW)} }).then((res) => {
        process.stdout.write(JSON.stringify({ mode: res.mode, ms: Number(process.hrtime.bigint() - started) / 1e6 }));
        process.exit(0);
      });`;
    const parent = spawnSync(process.execPath, ['-e', script], { input: JSON.stringify(context), env: s.env, encoding: 'utf8', timeout: 15000 });
    assert.equal(parent.status, 0, parent.stderr);
    const out = JSON.parse(parent.stdout);
    assert.equal(out.mode, 'shadow');
    t.diagnostic(`parent-side cost of the shadow call with a ${Buffer.byteLength(state)}-byte state: ${out.ms.toFixed(1)} ms`);
    const [line] = (await waitFor(() => s.lines().length && s.lines())) || [];
    assert.equal(line?.type, 'pick', JSON.stringify(line));
    assert.equal(line.pick, 'frontier');
    assert.equal(line.stateBytes, Buffer.byteLength(state));
    assert.equal(line.stateDigest, `sha256:${crypto.createHash('sha256').update(state, 'utf8').digest('hex')}`);
    assert.equal(model.asks()[0].body.state, state, 'the model was asked with the whole state');
    const picks = path.join(s.roots['project-state'], 'advice', 'picks');
    const stored = fs.readdirSync(picks).map((name: string) => fs.readFileSync(path.join(picks, name), 'utf8')).join('');
    assert.equal(stored.includes('b'.repeat(64)), false, 'the record keeps a digest, never the state text');
  });
}

// ── A4: the kind budget bounds a shadow child and an act call ────────────────────────────────────────────────────

test('A4: a detached shadow call stops at its kind budgetMs against a stalled model, not at timeoutMs', async (t) => {
  const model = await fakeModel(t);
  const s = store(t, model.origin);
  const registry = registryWith('tier', 400);
  assert.equal(registry.timeoutMs, 15000);
  const spawned = Date.now();
  const res = await interceptDecisionPoint(ctx(s, { adviceRegistry: registry }), { roots: s.roots, shadowConfig: SHADOW });
  assert.equal(res.mode, 'shadow');
  assert.ok(Date.now() - spawned < 400, 'the dispatcher returned before the budget');
  const ended = await waitFor(() => s.lines().length === 1 && model.allClosed() && s.slotFiles().length === 0, 400 + CHILD_SLACK_MS);
  assert.ok(ended, `the detached call was still running ${400 + CHILD_SLACK_MS} ms after it was spawned`);
  const [line] = s.lines();
  assert.deepEqual([line.type, line.mode, line.reason], ['miss', 'shadow', 'timeout']);
  assert.ok(line.durationMs >= 380 && line.durationMs < 1400, `the call ran ${line.durationMs} ms against a 400 ms kind budget`);
  assert.equal(model.asks().length, 1);
});

test('A4: an act call and the advice client stop at the kind budgetMs against a stalled model, not at timeoutMs', async (t) => {
  const model = await fakeModel(t);
  const s = store(t, model.origin);
  const registry = registryWith('tier', 400);
  const adviceClient = createAdviceClient({ adviceRegistry: registry, roots: s.roots });
  let started = Date.now();
  const res = await interceptDecisionPoint(ctx(s, { adviceRegistry: registry }), {
    adviceClient, roots: s.roots, benchGate: async () => ({ passed: true, reason: 'injected' }), shadowConfig: { ...SHADOW, mode: 'act' },
  });
  const actMs = Date.now() - started;
  assert.ok(actMs >= 380 && actMs < 2000, `the act call took ${actMs} ms against a 400 ms kind budget`);
  assert.equal(res.mode, 'act');
  assert.equal(res.effectiveDecision, 'light');
  assert.deepEqual(s.lines().map((line: any) => [line.type, line.mode, line.reason]), [['miss', 'act', 'timeout']]);
  // The client on its own, with no caller signal, keeps the same bound.
  started = Date.now();
  const asked = await adviceClient.ask({ questionSet: ctx(s).questionSet, kind: 'tier', staticAnswer: 'light', caller: 'brief-tools', record: false });
  const clientMs = Date.now() - started;
  assert.deepEqual([asked.status, asked.reason], ['unavailable', 'timeout']);
  assert.ok(clientMs >= 380 && clientMs < 2000, `the client call took ${clientMs} ms against a 400 ms kind budget`);
  assert.ok(await waitFor(() => model.allClosed(), 1000), 'both requests were dropped');
});

// ── O-2: the user-level slot set and the failed spawn ───────────────────────────────────────────────────────────

test('O-2: a call that finds every shadow slot held by a live, in-budget call records a busy miss and makes no call', async (t) => {
  const model = await fakeModel(t, answering(() => 'frontier'));
  const s = store(t, model.origin);
  holdSlots(s, { pid: process.pid, startedAt: Date.now() });
  const held = s.slotFiles().map((name: string) => fs.readFileSync(path.join(s.slots, name), 'utf8'));
  await interceptDecisionPoint(ctx(s), { roots: s.roots, shadowConfig: SHADOW });
  const lines = (await waitFor(() => s.lines().length && s.lines())) || [];
  assert.deepEqual(lines.map((line: any) => [line.type, line.mode, line.reason]), [['miss', 'shadow', 'busy']]);
  assert.equal(model.asks().length, 0, 'a busy call asks nothing');
  assert.deepEqual(s.slotFiles().map((name: string) => fs.readFileSync(path.join(s.slots, name), 'utf8')), held, 'the held slots are untouched');
});

for (const [why, holder] of [
  ['its process is gone', () => ({ pid: deadPid(), startedAt: Date.now() })],
  ['it is older than its budget plus the margin', () => ({ pid: process.pid, startedAt: Date.now() - 3_600_000, budgetMs: 1000 })],
] as Array<[string, () => any]>) {
  test(`O-2: a stale slot (${why}) is reclaimed: the call runs, and frees the slot it took`, async (t) => {
    const model = await fakeModel(t, answering(() => 'frontier'));
    const s = store(t, model.origin);
    holdSlots(s, holder());
    await interceptDecisionPoint(ctx(s), { roots: s.roots, shadowConfig: SHADOW });
    const lines = (await waitFor(() => s.lines().length && s.lines())) || [];
    assert.deepEqual(lines.map((line: any) => [line.type, line.pick]), [['pick', 'frontier']]);
    assert.equal(model.asks().length, 1);
    assert.ok(await waitFor(() => s.slotFiles().length === ADVICE.shadowSlots - 1), 'the reclaimed slot was taken, then freed');
    assert.deepEqual(s.slotFiles(), Array.from({ length: ADVICE.shadowSlots }, (_v, index) => `slot-${index}.json`).slice(1));
  });
}

test('O-2: a spawn that throws, or a child that fails to start, records a spawn-failed miss and makes no call', async (t) => {
  const model = await fakeModel(t, answering(() => 'frontier'));
  const s = store(t, model.origin);
  const throwing = () => { throw new Error('spawn refused'); };
  const res = await interceptDecisionPoint(ctx(s), { roots: s.roots, spawn: throwing, shadowConfig: SHADOW });
  assert.deepEqual([res.mode, res.effectiveDecision], ['shadow', 'light']);
  assert.deepEqual(s.lines().map((line: any) => [line.type, line.mode, line.reason]), [['miss', 'shadow', 'spawn-failed']]);
  const missing = (_command: string, args: string[], options: any) => spawn(path.join(s.dir, 'no-such-node'), args, options);
  await interceptDecisionPoint(ctx(s), { roots: s.roots, spawn: missing, shadowConfig: SHADOW });
  const lines = await waitFor(() => s.lines().length === 2 && s.lines());
  assert.deepEqual(lines.map((line: any) => [line.type, line.reason]), [['miss', 'spawn-failed'], ['miss', 'spawn-failed']]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(model.asks().length, 0);
});

test('O-2: a call with no static answer (advise --kind without --static) records a pick, not a config-invalid miss', async (t) => {
  const model = await fakeModel(t, answering(() => 'LOW'));
  const s = store(t, model.origin);
  const levels = { LOW: { description: 'Low risk' }, MEDIUM: { description: 'Medium risk' }, HIGH: { description: 'High risk' } };
  const question = materializeKind('verify-risk', { adviceRegistry: ADVICE, sources: { verification: { riskLevels: levels } } }).question;
  const state = 'A change to the payment path.';
  // The shape `advise --kind verify-risk` hands the dispatcher without --static: staticPick is '' and staticAnswer is absent.
  await interceptDecisionPoint({
    kind: 'verify-risk', caller: 'advise', state, staticPick: '', staticAnswer: undefined, taskId: null,
    questionSet: { state, questions: [question] }, adviceRegistry: ADVICE, projectRoot: s.projectRoot, env: s.env,
  }, { roots: s.roots, shadowConfig: { kind: 'verify-risk', mode: 'shadow', model: 'm' } });
  const lines = (await waitFor(() => s.lines().length && s.lines())) || [];
  assert.deepEqual(lines.map((line: any) => [line.type, line.kind, line.pick, line.reason]), [['pick', 'verify-risk', 'LOW', undefined]], JSON.stringify(lines));
  assert.equal(model.asks().length, 1);
});
