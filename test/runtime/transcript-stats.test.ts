'use strict';

// Row 093 V.6 (IC-023): `doflow transcript --action stats` counts traffic over a window from the V.4 readers in
// metadata mode and says who works with whom, with no write. Scratch HOME and config home hold V.2's synthetic
// fixtures (their cwd rewritten to the scratch project; event times 2026-01-01T00:00:01..11Z, so every module call
// passes `now`), real git repositories, hand-written hook observations, attempt and worker-run stores and a plan.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { V8_ROOT, LOCATION_ROOTS } = require('../fixtures/transcripts/v8/scan.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');
const { computeStats } = require('../../src/runtime/transcripts/stats.ts');
const { handleTranscriptCommand } = require('../../src/runtime/transcripts/command.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const ID = 'fa000000-0000-4000-8000-00000000';
const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const AK = (harness: string, ...rest: string[]) => sha16([harness, ...rest].join(':'));
const NOW = Date.parse('2026-01-01T00:00:30.000Z');
const AGENT_KEYS = ['agentKey', 'harness', 'model', 'eventsPerMin', 'toolCalls', 'toolErrors', 'toolDurationMs', 'tokens', 'lastRecordAt'];

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

function repo(dir: string) {
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
}

function env(f: any): any {
  return {
    HOME: f.home, XDG_CONFIG_HOME: f.config, PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', COPILOT_HOME: '', PI_CODING_AGENT_SESSION_DIR: '',
    TMPDIR: process.env.TMPDIR,
  };
}

function session(f: any, harness: string, rawId: string, cwd: string, model = `${harness}-fixture-1`) {
  const top = fs.realpathSync(cwd);
  const dir = path.join(f.store, 'primary', cwdHash(top), harness);
  fs.mkdirSync(dir, { recursive: true });
  const observedAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(dir, `${sha16(rawId)}.json`), JSON.stringify({ schema: 1, harness, model, event: 'SessionStart', observedAt, session: sha16(rawId) }));
  const sdir = path.join(f.store, 'sessions', rawId);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'git-context.json'), JSON.stringify({ cwd: top, captured_at: observedAt, branch: 'main' }));
}

function writeStore(f: any, dir: string, slug: string, data: any) {
  const d = path.join(f.main, '.doflow', 'state', dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${slug}.json`), JSON.stringify(data));
}

function retarget(dir: string, from: string, to: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) retarget(full, from, to);
    else if (!e.name.startsWith('opencode.db')) fs.writeFileSync(full, fs.readFileSync(full, 'utf8').split(from).join(to));
  }
}

function world(t: any, { fixtures = true } = {}) {
  clearCheckoutCache();
  const root = tempDir(t, 'doflow-transcript-stats-');
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj'), other: path.join(root, 'other') };
  f.store = path.join(f.config, 'doflow', 'session-env');
  fs.mkdirSync(f.home);
  fs.mkdirSync(f.store, { recursive: true });
  repo(f.main);
  repo(f.other);
  if (fixtures) {
    const real = fs.realpathSync(f.main);
    for (const [harness, parts] of Object.entries(LOCATION_ROOTS) as Array<[string, string[]]>) {
      const target = path.join(f.home, ...parts);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(V8_ROOT, harness), target, { recursive: true });
      retarget(target, '/work/fixture-project', real);
    }
    const piRoot = path.join(f.home, ...LOCATION_ROOTS.pi);
    fs.renameSync(path.join(piRoot, '--work-fixture-project--'), path.join(piRoot, `--${real.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`));
  }
  return f;
}

function scenario(f: any) {
  session(f, 'claude', `${ID}c001`, f.main);
  session(f, 'codex', `${ID}d001`, f.main);
  session(f, 'pi', `${ID}a001`, f.main);
  session(f, 'kiro', `${ID}e001`, f.main);
  session(f, 'copilot', `${ID}f001`, f.main);
  session(f, 'antigravity', `${ID}b001`, f.main);
  session(f, 'opencode', `${ID}0c00`, f.main);
  session(f, 'claude', `${ID}c0aa`, f.main); // no file anywhere
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const info = fs.lstatSync(file, { bigint: true });
      const rel = path.relative(root, file);
      if (info.isDirectory()) { out[rel] = `dir ${info.mtimeNs}`; visit(file); } else out[rel] = `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')} ${info.mtimeNs}`;
    }
  };
  visit(root);
  return out;
}

const unknown = () => 'unknown';
const stats = (f: any, opts: any = {}) => {
  clearCheckoutCache();
  const r = computeStats({ env: env(f), cwd: f.main, now: () => NOW, alive: unknown, ...opts });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.body;
};
const agent = (body: any, key: string) => body.agents.find((a: any) => a.agentKey === key);
const cli = (f: any, args: string[]) => spawnSync(process.execPath, [CLI, 'transcript', ...args], { cwd: f.main, env: env(f), encoding: 'utf8' });

test('the exact field set, and known counts per harness over the window', (t) => {
  const f = world(t);
  scenario(f);
  const body = stats(f);
  assert.deepEqual(Object.keys(body), ['v', 'projectKey', 'windowMin', 'agents', 'models', 'pairs', 'notChecked']);
  assert.deepEqual([body.v, body.windowMin, body.notChecked, body.projectKey], [1, 10, 0, cwdHash(fs.realpathSync(f.main))]);
  for (const a of body.agents) assert.deepEqual(Object.keys(a), AGENT_KEYS);
  const dur = (p50: number | null) => (p50 === null ? null : { p50, max: p50, n: 1 });
  const expected: Array<[string, string, number, number, number | null, number | null, any]> = [
    // harness, main id, events per minute, tool calls, tool errors, p50, tokens
    ['claude', 'c001', 0.7, 1, 0, 1000, { input: 180, output: 60, cacheRead: 300, cacheWrite: 30, reasoning: null }],
    ['codex', 'd001', 0.6, 1, null, 1000, { input: 80, output: 40, cacheRead: 20, cacheWrite: 5, reasoning: 8 }],
    ['kiro', 'e001', 0.5, 1, 0, null, { input: 90, output: 45, cacheRead: 10, cacheWrite: 2, reasoning: null }],
    ['copilot', 'f001', 0.7, 1, 0, 1000, { input: 180, output: 90, cacheRead: 10, cacheWrite: 2, reasoning: 5 }],
    ['pi', 'a001', 0.6, 1, 0, 321, { input: 100, output: 40, cacheRead: 10, cacheWrite: 2, reasoning: 6 }],
  ];
  for (const [harness, id, perMin, calls, errors, p50, tokens] of expected) {
    const a = agent(body, AK(harness, `${ID}${id}`));
    assert.deepEqual([a.harness, a.model, a.eventsPerMin, a.toolCalls, a.toolErrors, a.toolDurationMs, a.tokens], [harness, `${harness}-fixture-1`, perMin, calls, errors, dur(p50), tokens], harness);
    assert.match(a.lastRecordAt, harness === 'kiro' ? /^\d{4}-\d\d-\d\dT/ : /^2026-01-01T00:00:/, 'Kiro keeps no time per record, so the tree falls back to the hook record');
  }
});

test('unknown is null, never 0: Codex records no tool status, Kiro no tool duration, unlinked agents nothing', (t) => {
  const f = world(t);
  scenario(f);
  const body = stats(f);
  const codex = agent(body, AK('codex', `${ID}d001`));
  const kiro = agent(body, AK('kiro', `${ID}e001`));
  assert.equal(codex.toolErrors, null, 'tool results with no recorded status');
  assert.equal(kiro.toolDurationMs, null);
  for (const key of [AK('antigravity', `${ID}b001`), AK('opencode', `${ID}0c00`), AK('claude', `${ID}c0aa`)]) {
    const a = agent(body, key);
    assert.deepEqual([a.eventsPerMin, a.toolCalls, a.toolErrors, a.toolDurationMs, a.tokens], [null, null, null, null, null]);
  }
  // A window with nothing in it on a readable transcript is a known zero for counts and null for tokens.
  const quiet = stats(f, { windowMin: 1, now: () => NOW + 3 * 60000 });
  for (const harness of ['claude', 'codex', 'pi', 'copilot']) {
    const a = agent(quiet, AK(harness, `${ID}${{ claude: 'c001', codex: 'd001', pi: 'a001', copilot: 'f001' }[harness]}`));
    assert.deepEqual([a.eventsPerMin, a.toolCalls, a.toolErrors, a.toolDurationMs, a.tokens], [0, 0, 0, null, null], harness);
  }
});

test('Kiro has no per-record time: its events count through the newest turn end_timestamp', (t) => {
  const f = world(t);
  scenario(f);
  const key = AK('kiro', `${ID}e001`);
  // The turn ends at 00:00:09. Window of one minute ending 00:01:05 starts 00:00:05: the turn is inside, all five events count.
  assert.equal(agent(stats(f, { windowMin: 1, now: () => Date.parse('2026-01-01T00:01:05.000Z') }), key).eventsPerMin, 5);
  // Ending 00:01:15 the window starts 00:00:15: the turn is outside, and the five events do not count.
  assert.equal(agent(stats(f, { windowMin: 1, now: () => Date.parse('2026-01-01T00:01:15.000Z') }), key).eventsPerMin, 0);
  // Claude has a time per record: of its seven events three are at or after 00:00:05.
  assert.equal(agent(stats(f, { windowMin: 1, now: () => Date.parse('2026-01-01T00:01:05.000Z') }), AK('claude', `${ID}c001`)).eventsPerMin, 3);
});

test('without a companion turn the Kiro window is unknown, so null', (t) => {
  const f = world(t);
  scenario(f);
  const companion = path.join(f.home, ...LOCATION_ROOTS.kiro, `${ID}e001.json`);
  const j = JSON.parse(fs.readFileSync(companion, 'utf8'));
  j.user_turn_metadatas = [];
  fs.writeFileSync(companion, JSON.stringify(j));
  const a = agent(stats(f), AK('kiro', `${ID}e001`));
  assert.deepEqual([a.eventsPerMin, a.tokens], [null, null]);
});

test('models group the agents, and same-model pairs name no task', (t) => {
  const f = world(t, { fixtures: false });
  session(f, 'claude', `${ID}c001`, f.main, 'shared-model-1');
  session(f, 'codex', `${ID}d001`, f.main, 'shared-model-1');
  session(f, 'pi', `${ID}a001`, f.main, 'solo-model-1');
  const body = stats(f);
  const [c, x, p] = [AK('claude', `${ID}c001`), AK('codex', `${ID}d001`), AK('pi', `${ID}a001`)];
  assert.deepEqual(body.pairs, [{ a: [c, x].sort()[0], b: [c, x].sort()[1], basis: 'same-model', task: null, tasks: null }]);
  assert.deepEqual(body.models.map((m: any) => [m.model, m.agents, m.eventsPerMin, m.toolCalls, m.tokens]), [['shared-model-1', 2, null, null, null], ['solo-model-1', 1, null, null, null]]);
  assert.ok(![c, x].includes(p));
});

test('model rows add the counts of their agents', (t) => {
  const f = world(t);
  scenario(f);
  const body = stats(f);
  const row = body.models.find((m: any) => m.model === 'claude-fixture-1');
  const mine = body.agents.filter((a: any) => a.model === 'claude-fixture-1');
  assert.equal(row.agents, mine.length);
  assert.equal(row.toolCalls, mine.reduce((n: number, a: any) => n + (a.toolCalls ?? 0), 0));
  assert.equal(body.models.find((m: any) => m.model === 'kiro-fixture-1').tokens.input, 90);
});

function activeWork(f: any) {
  const run = (n: number, task: string) => ({
    token: n, owner: `fixture-owner-${n}`, mode: 'sequential', state: 'active', result: null, startedAt: '2026-01-01T00:00:01.000Z', runKey: `wk${n}/run${n}/lin${n}`, task,
  });
  writeStore(f, 'task-attempts', 'feat', {
    slug: 'feat', tasks: { 'A.1': { attempts: [run(1, 'A.1')] }, 'A.2': { attempts: [run(2, 'A.2')] } },
  });
  fs.mkdirSync(path.join(f.main, 'agent-docs', 'doflow', 'feat'), { recursive: true });
  fs.writeFileSync(path.join(f.main, 'agent-docs', 'doflow', 'feat', 'plan.md'), ['# Plan', '', '## 8. Tasks', '', '- [ ] A.1 one — files: src/a.ts', '- [ ] A.2 two — files: src/a.ts, src/b.ts', ''].join('\n'));
}

test('overlap pairs carry the two task ids, in the order of the pair', (t) => {
  const f = world(t, { fixtures: false });
  activeWork(f);
  const body = stats(f);
  const [r1, r2] = [sha16('doflow:wk1/run1/lin1'), sha16('doflow:wk2/run2/lin2')];
  const [a, b] = [r1, r2].sort();
  assert.deepEqual(body.pairs, [{ a, b, basis: 'overlap', task: null, tasks: a === r1 ? ['A.1', 'A.2'] : ['A.2', 'A.1'] }]);
});

test('same-task pairs carry the task id', (t) => {
  const f = world(t, { fixtures: false });
  activeWork(f);
  writeStore(f, 'worker-runs', 'feat', {
    slug: 'feat', runs: {
      'w-bbbbbbbbbbbb': { runId: 'w-bbbbbbbbbbbb', task: 'A.1', token: 1, seq: 1, harness: 'codex', phase: 'running', startedAt: '2026-01-01T00:06:00.000Z', childOf: null, supervisor: { pid: 1, start: 'x' }, caller: { runKey: 'wk1/run1/lin1', run: 'run1', lineage: 'lin1' } },
      'w-cccccccccccc': { runId: 'w-cccccccccccc', task: 'A.1', token: 1, seq: 1, harness: 'codex', phase: 'ended', startedAt: '2026-01-01T00:06:00.000Z', childOf: null, end: { state: 'exited', at: '2026-01-01T00:07:00.000Z' } },
    },
  });
  const body = stats(f);
  const same = body.pairs.filter((p: any) => p.basis === 'same-task');
  const [r1, w1] = [sha16('doflow:wk1/run1/lin1'), sha16('worker:w-bbbbbbbbbbbb')];
  assert.deepEqual(same, [{ a: [r1, w1].sort()[0], b: [r1, w1].sort()[1], basis: 'same-task', task: 'A.1', tasks: null }], 'the ended run holds nothing');
  assert.ok(body.pairs.some((p: any) => p.basis === 'overlap' && p.tasks.includes('A.2')));
});

test('at most 32 agents are read, the rest counted in notChecked', (t) => {
  const f = world(t, { fixtures: false });
  for (let i = 0; i < 40; i++) session(f, 'claude', `bound-session-${String(i).padStart(3, '0')}`, f.main);
  const body = stats(f);
  assert.equal(body.agents.length, 32);
  assert.equal(body.notChecked, 8);
});

test('no planted marker and no raw id or path in the body', (t) => {
  const f = world(t);
  scenario(f);
  const json = JSON.stringify(stats(f));
  for (const needle of ['fa000000', f.root, '/work/', 'FIXTURE-', 'fx-Secret', 'example.invalid']) assert.ok(!json.includes(needle), needle);
});

test('CLI: the shape, the window, the text form, and usage errors exit 2', (t) => {
  const f = world(t);
  scenario(f);
  const json = cli(f, ['--action', 'stats', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const body = JSON.parse(json.stdout);
  assert.deepEqual([body.windowMin, body.agents.length > 0], [10, true]);
  assert.equal(JSON.parse(cli(f, ['--action', 'stats', '--window', '60', '--json']).stdout).windowMin, 60);
  const text = cli(f, ['--action', 'stats']);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes('window 10') && !text.stdout.includes(f.root));
  for (const argv of [['--action', 'stats', '--window', '0'], ['--action', 'stats', '--window', '61'], ['--action', 'stats', '--window', 'x'], ['--action', 'stats', '--agent', '0123456789abcdef'], ['--action', 'stats', '--limit', '5'], ['--action', 'stats', '--bogus']]) {
    const r = cli(f, argv);
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stderr}${r.stdout}`);
  }
  const saved = process.exitCode;
  t.after(() => { process.exitCode = saved; });
  const lines: string[] = [];
  assert.equal(handleTranscriptCommand({ action: 'stats', window: '5', json: true, flags: ['--action', '--window'], env: env(f), cwd: f.main, alive: unknown, now: () => NOW, out: (l: string) => lines.push(l) }), 0);
  assert.equal(JSON.parse(lines[0]).windowMin, 5);
});

test('stats with upkeep due leaves project, user state, config home and every harness home byte-identical', (t) => {
  const f = world(t);
  scenario(f);
  activeWork(f);
  for (const dir of [path.join(f.main, '.doflow', 'state'), path.join(f.home, '.doflow', 'state')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'upkeep-due'), '1\n');
  }
  const before = snapshot(f.root);
  for (const extra of [['--json'], []]) {
    const r = cli(f, ['--action', 'stats', ...extra]);
    assert.equal(r.status, 0, r.stderr);
  }
  assert.deepEqual(snapshot(f.root), before);
});
