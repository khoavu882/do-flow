'use strict';

// Console verb runner (feature 093, IC-003 over 092 IC-009; FR-002). A fake core
// (fixtures/fake-core.js) logs the argv, environment and cwd it was started with, then echoes,
// sleeps, fails or floods stdout as FAKE_CORE_MODE says. Timers run on an injected fake clock, so
// no case waits 10 s or 30 s of real time.

const { test, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  createVerbRunner,
  SHAPES,
  SHAPE_IDS,
  IDENTITY_VARIABLES,
  PASS_THROUGH,
  OUTPUT_CAP_BYTES,
  KILL_GRACE_MS,
  POOL_SIZE,
  RESERVED_SLOTS,
  FLEET_ERROR_STATUS,
  FOLLOW_SHAPES,
  FOLLOW_SHAPE_IDS,
  FOLLOW_LINE_CAP_BYTES,
  FOLLOW_STDERR_LINE_BYTES,
  fleetError,
} = require('../src/verb-runner.ts');
const { EventEmitter } = require('node:events');

const FAKE_CORE = path.join(__dirname, 'fixtures', 'fake-core.js');
const KEY_A = 'aaaaaaaaaaaaaaaa';
const KEY_B = 'bbbbbbbbbbbbbbbb';
const AGENT = '0123456789abcdef';
/** The fake core's top-level worker run in mode `worker-reads` (fixtures/fake-core.js). */
const RUN_ID = 'w-1a2b3c4d5e6f';
const IDENTITY_SOURCE = path.join(__dirname, '..', '..', 'src', 'runtime', 'context', 'identity.ts');

function fakeClock() {
  let now = 0;
  const timers = new Set<{ at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const handle = { at: now + ms, fn };
      timers.add(handle);
      return handle;
    },
    clearTimeout(handle: any) {
      timers.delete(handle);
    },
    advance(ms: number) {
      now += ms;
      for (const handle of [...timers].sort((a, b) => a.at - b.at)) {
        if (handle.at <= now) {
          timers.delete(handle);
          handle.fn();
        }
      }
    },
  };
}

const realDelay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Every child any case spawned; a case that fails part-way must not leave a sleeping fake core
// holding this test process open.
const allChildren: any[] = [];
after(() => {
  for (const child of allChildren) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
});

// The temp dirs the running case made, by the paths mkdtemp returned, and how many setup() calls made them.
// After each case those exact paths are removed and checked gone; nothing else is deleted.
const caseDirs: string[] = [];
let caseSetups = 0;
afterEach(() => {
  const created = caseDirs.splice(0);
  const setups = caseSetups;
  caseSetups = 0;
  for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(created.length, 2 * setups, 'each setup() made two temp dirs');
  assert.deepEqual(created.filter((dir) => fs.existsSync(dir)), [], 'a temp dir of this case is still there');
});

/** A runner over the fake core, a spawn wrapper that records each child, and the start log. */
function setup(mode: string, extraEnv: Record<string, string> = {}, options: any = {}) {
  caseSetups += 1;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-verb-runner-'));
  caseDirs.push(dir);
  const projectMade = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-verb-project-'));
  caseDirs.push(projectMade);
  const project = fs.realpathSync(projectMade);
  const log = path.join(dir, 'starts.jsonl');
  const children: any[] = [];
  const spawnCalls: any[] = [];
  let live = 0;
  let maxLive = 0;
  const clock = options.clock ?? fakeClock();
  const runner = createVerbRunner({
    corePath: options.corePath ?? FAKE_CORE,
    projectRoot: project,
    env: { FAKE_CORE_MODE: mode, FAKE_CORE_LOG: log, ...extraEnv },
    clock,
    spawnImpl:
      options.spawnImpl ??
      ((command: string, args: string[], spawnOptions: any) => {
        spawnCalls.push({ command, args, options: spawnOptions });
        const child = childProcess.spawn(command, args, spawnOptions);
        children.push(child);
        allChildren.push(child);
        live += 1;
        maxLive = Math.max(maxLive, live);
        child.on('close', () => {
          live -= 1;
        });
        return child;
      }),
  });
  const starts = (): any[] =>
    fs.existsSync(log)
      ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line: string) => JSON.parse(line))
      : [];
  /** Real-time wait (bounded) until the fake core has logged `count` starts. */
  const startsReach = async (count: number) => {
    for (let i = 0; i < 500 && starts().length < count; i++) await realDelay(10);
    assert.equal(starts().length, count, `expected ${count} fake-core starts`);
  };
  return { runner, clock, project, starts, startsReach, children, spawnCalls, maxLive: () => maxLive };
}

const EXPECTED_SHAPES = {
  list: { argv: ['orchestrate', '--action', 'list', '--json'], params: {} },
  status: { argv: ['orchestrate', '--action', 'status', '--task-id', 't-1', '--slug', 's.1', '--json'], params: { taskId: 't-1', slug: 's.1' } },
  timeline: { argv: ['orchestrate', '--action', 'timeline', '--task-id', 't-1', '--slug', 's.1', '--json'], params: { taskId: 't-1', slug: 's.1' } },
  attempts: { argv: ['task-attempt', '--action', 'inspect', '--slug', 's.1', '--json'], params: { slug: 's.1' } },
  workflow: { argv: ['workflow', '--task-class', 'feature', '--json'], params: { taskClass: 'feature' } },
  capabilities: { argv: ['capabilities', '--json'], params: {} },
  version: { argv: ['--version', '--json'], params: {} },
  observed: { argv: ['primary', '--action', 'observed', '--json'], params: {} },
  slots: { argv: ['slot', '--action', 'peek', '--json'], params: {} },
  'worker-status': { argv: ['worker', '--action', 'status', '--slug', 's.1', '--task', 'A.2', '--token', '2', '--json'], params: { slug: 's.1', task: 'A.2', token: '2' } },
  roadmap: { argv: ['roadmap', '--action', 'status', '--json'], params: {} },
  // IC-024: the Fleet shapes. `tree`, `transcript` and `traffic` are scoped to a project (fleet cases below).
  projects: { argv: ['fleet', '--action', 'projects', '--json'], params: {} },
  tree: { argv: ['fleet', '--action', 'tree', '--json'], params: { projectKey: KEY_A }, scoped: true },
  transcript: { argv: ['transcript', '--action', 'read', '--agent', AGENT, '--limit', '200', '--json'], params: { projectKey: KEY_A, agent: AGENT, limit: '200' }, scoped: true },
  traffic: { argv: ['transcript', '--action', 'stats', '--window', '10', '--json'], params: { projectKey: KEY_A }, scoped: true },
  // 150 IC-010: the worker chain reads. `worker-log`'s optional `--slug`, `--cursor` and `--before` are in the case below.
  'worker-runs': { argv: ['worker-runs', '--slug', 's.1', '--json'], params: { slug: 's.1' } },
  'worker-result': { argv: ['worker-result', '--slug', 's.1', '--worker-run', RUN_ID, '--json'], params: { slug: 's.1', runId: RUN_ID } },
  'worker-run-status': { argv: ['worker', '--action', 'status', '--slug', 's.1', '--worker-run', RUN_ID, '--json'], params: { slug: 's.1', runId: RUN_ID } },
  'worker-log': { argv: ['worker-log', '--worker-run', RUN_ID, '--stream', 'out', '--json'], params: { runId: RUN_ID, stream: 'out' } },
};

test('the allow-list is the frozen IC-003 table and nothing else', () => {
  assert.deepEqual([...SHAPE_IDS], Object.keys(EXPECTED_SHAPES));
  assert.ok(Object.isFrozen(SHAPES) && Object.isFrozen(SHAPE_IDS));
  for (const id of SHAPE_IDS) {
    assert.ok(Object.isFrozen(SHAPES[id]) && Object.isFrozen(SHAPES[id].argv), `${id} is frozen`);
  }
  assert.throws(() => {
    SHAPES.start = { argv: ['orchestrate', '--action', 'start'] };
  }, TypeError);
  assert.throws(() => {
    SHAPES.list.argv.push('--forced');
  }, TypeError);
});

test('each IC-003 shape spawns process.execPath <core> <argv> --json, shell off, cwd the project', async () => {
  for (const [id, expected] of Object.entries(EXPECTED_SHAPES)) {
    if ((expected as any).scoped) continue; // run with a project's cwd: see the fleet cases
    const { runner, project, starts, spawnCalls } = setup('echo');
    const result = await runner.run(id, expected.params);
    assert.equal(result.ok, true, `${id}: ${JSON.stringify(result)}`);
    // workflow first asks the version, its cache key (IC-003).
    assert.equal(spawnCalls.length, id === 'workflow' ? 2 : 1);
    if (id === 'workflow') assert.deepEqual(spawnCalls[0].args, [FAKE_CORE, ...EXPECTED_SHAPES.version.argv]);
    const call = spawnCalls[spawnCalls.length - 1];
    assert.equal(call.command, process.execPath);
    assert.deepEqual(call.args, [FAKE_CORE, ...expected.argv]);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.cwd, project);
    const start = starts().at(-1);
    assert.deepEqual(start.argv, expected.argv, id);
    assert.equal(start.cwd, project);
    if (id === 'version') assert.equal(result.json, '9.9.9-fake');
    else assert.deepEqual(result.json, { argv: expected.argv });
    assert.equal(result.exit, 0);
  }
});

test('write verbs, flags, unknown shapes and bad parameters are refused as usage before any spawn', async () => {
  const { runner, starts, spawnCalls } = setup('echo');
  const refused: Array<[string, any]> = [
    ['decide-gate', {}],
    ['start', {}],
    ['complete-stage', {}],
    ['indicators', {}],
    ['doctor', {}],
    ['--forced', {}],
    ['-g', {}],
    ['__proto__', {}],
    ['constructor', {}],
    ['toString', {}],
    ['status', { taskId: '-x', slug: 'ok' }],
    ['status', { taskId: '--forced', slug: 'ok' }],
    ['status', { taskId: 'ok', slug: 'a/b' }],
    ['status', { taskId: 'ok', slug: '' }],
    ['status', { taskId: 'ok', slug: '.hidden' }],
    ['status', { taskId: 'ok', slug: 'a b' }],
    ['status', { taskId: 'ok', slug: 'a\nb' }],
    ['status', { taskId: 'ok' }],
    ['status', { taskId: 'ok', slug: 'ok', g: 'x' }],
    ['status', { taskId: 1, slug: 'ok' }],
    ['status', null],
    ['status', 'taskId'],
    ['list', { forced: 'yes' }],
    ['attempts', { slug: '-g' }],
    ['workflow', { taskClass: '../x' }],
    // IC-018: the writing and signalling actions of the Sessions verbs have no shape, and no parameter reaches the action.
    ['slot', {}],
    ['slot-list', {}],
    ['slot-release', {}],
    ['worker', {}],
    ['worker-cancel', {}],
    ['slots', { action: 'list' }],
    ['slots', { action: 'release' }],
    ['worker-status', { slug: 's.1', task: 'A.2', token: '2', action: 'cancel' }],
    ['worker-status', { slug: 's.1', task: 'A.2' }],
    ['worker-status', { slug: 's.1', task: 'A.2', token: '-1' }],
    ['worker-status', { slug: 's.1', task: '--action=cancel', token: '2' }],
    ['worker-status', { slug: 's.1', task: 'A.2', token: 2 }],
    ['roadmap', { action: 'next' }],
    ['observed', { action: 'resolve' }],
    // IC-024: keys, cursor and limit are checked against their patterns before they reach argv.
    ['tree', {}],
    ['tree', { projectKey: 'AAAAAAAAAAAAAAAA' }],
    ['tree', { projectKey: 'aaaaaaaaaaaaaaa' }],
    ['tree', { projectKey: 'aaaaaaaaaaaaaaaaa' }],
    ['tree', { projectKey: '../../../etc/passwd' }],
    ['tree', { projectKey: KEY_A, root: '/tmp' }],
    ['traffic', { projectKey: KEY_A, window: '60' }],
    ['projects', { projectKey: KEY_A }],
    ['transcript', { projectKey: KEY_A, limit: '10' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT }],
    ['transcript', { projectKey: KEY_A, agent: 'FEDCBA9876543210', limit: '10' }],
    ['transcript', { projectKey: KEY_A, agent: '--action=cancel', limit: '10' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '0' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '501' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '007' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '1.5' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '-1' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: 10 }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '10', cursor: '1:2:3' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '10', cursor: '1:2:3:x' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '10', cursor: '1:2:3:4 --limit' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '10', cursor: '-1:2:3:4' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '10', cursor: '' }],
    ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '10', action: 'stats' }],
  ];
  for (const [shape, params] of refused) {
    const result = await runner.run(shape, params);
    assert.deepEqual(result, { ok: false, code: 'usage', exit: null }, `${shape} ${JSON.stringify(params)}`);
  }
  assert.equal(spawnCalls.length, 0);
  assert.equal(starts().length, 0);
});

test('no shape is a write or signal action of the Sessions verbs: slot list and release, worker cancel', () => {
  const actionOf = (argv: readonly unknown[]) => `${argv[0]} ${argv[argv.indexOf('--action') + 1]}`;
  const actions = SHAPE_IDS.map((id: string) => actionOf(SHAPES[id].argv));
  for (const refused of ['slot list', 'slot release', 'slot run', 'worker cancel', 'worker run', 'worker evidence']) {
    assert.ok(!actions.includes(refused), `${refused} is on the allow-list`);
  }
  // 150 IC-010: `worker-run-status` is the same `worker status` read by run id; the list gains it on purpose.
  assert.deepEqual(actions.filter((action: string) => /^(slot|worker|roadmap|primary) /.test(action)).sort(),
    ['primary observed', 'roadmap status', 'slot peek', 'worker status', 'worker status']);
});

test('the child environment has no DOFLOW_* but the four pass-throughs and DOFLOW_UPKEEP=off, and no identity variable', async () => {
  const planted: Record<string, string> = {
    KEEP_ME: 'kept',
    DOFLOW_RUN_ID: 'run-1',
    DOFLOW_ATTEMPT: '1',
    DOFLOW_LINEAGE_ID: 'lin-1',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_WORKTREE: '/tmp',
    DOFLOW_SCOPE: 'global',
    DOFLOW_UPKEEP: 'on',
    doflow_lower_case: 'x',
    DOFLOW_CONFIG_DIR: '/cfg',
    DOFLOW_TELEMETRY: 'off',
    DOFLOW_FAILURE_CAPTURE: 'off',
    DOFLOW_RETENTION_HOURS: '12',
  };
  for (const name of IDENTITY_VARIABLES) if (!(name in planted)) planted[name] = 'identity';
  const { runner, starts } = setup('echo', planted);
  assert.equal((await runner.run('list', {})).ok, true);
  const env = starts()[0].env;
  const doflow = Object.keys(env).filter((name) => name.toUpperCase().startsWith('DOFLOW_')).sort();
  assert.deepEqual(doflow, [...PASS_THROUGH, 'DOFLOW_UPKEEP'].sort());
  for (const name of PASS_THROUGH) assert.equal(env[name], planted[name]);
  assert.equal(env.DOFLOW_UPKEEP, 'off');
  for (const name of IDENTITY_VARIABLES) assert.equal(name in env, false, `${name} reached the child`);
  assert.equal(env.KEEP_ME, 'kept');

  // Pass-throughs are passed only when set.
  const bare = setup('echo', { DOFLOW_RUN_ID: 'run-1' });
  assert.equal((await bare.runner.run('list', {})).ok, true);
  const bareDoflow = Object.keys(bare.starts()[0].env).filter((name) => name.startsWith('DOFLOW_'));
  assert.deepEqual(bareDoflow, ['DOFLOW_UPKEEP']);
});

/** Every environment name identity.ts reads or names; each must be in the runner's strip list. */
function unstrippedIdentityNames(source: string, stripped: readonly string[]): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\bDOFLOW_[A-Z0-9_]+\b/g)) names.add(match[0]);
  for (const match of source.matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(match[1]);
  for (const match of source.matchAll(/\benv\[\s*['"`]([^'"`]+)['"`]\s*\]/g)) names.add(match[1]);
  return [...names].filter((name) => !stripped.includes(name)).sort();
}

test('every identity variable of src/runtime/context/identity.ts is on the strip list', () => {
  const source = fs.readFileSync(IDENTITY_SOURCE, 'utf8');
  for (const name of ['DOFLOW_RUN_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_LINEAGE_ID', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE']) {
    assert.ok(source.includes(name), `scan sanity: identity.ts names ${name}`);
  }
  assert.deepEqual(unstrippedIdentityNames(source, IDENTITY_VARIABLES), []);
  // Control: a name identity.ts gains is reported until the runner strips it.
  const grown = `${source}\nconst extra = env.HARNESS_SESSION_TOKEN || env['OTHER_ID'] || env.DOFLOW_NEW_ID;\n`;
  assert.deepEqual(unstrippedIdentityNames(grown, IDENTITY_VARIABLES), ['DOFLOW_NEW_ID', 'HARNESS_SESSION_TOKEN', 'OTHER_ID']);
});

test('a child still running at 10 s is killed and reported as core-error', async () => {
  const { runner, clock, startsReach, children } = setup('sleep');
  const pending = runner.run('list', {});
  await startsReach(1);
  clock.advance(9_999); // IC-003: 10 s
  await realDelay(50);
  assert.equal(children[0].exitCode, null);
  assert.equal(children[0].signalCode, null);
  clock.advance(1);
  assert.deepEqual(await pending, { ok: false, code: 'core-error', exit: null, reason: 'timeout' });
  assert.equal(children[0].signalCode, 'SIGTERM');
});

test('a child that ignores SIGTERM is SIGKILLed after the grace', async () => {
  const { runner, clock, startsReach, children } = setup('ignore-term');
  const pending = runner.run('list', {});
  await startsReach(1);
  clock.advance(10_000);
  await realDelay(100);
  assert.equal(children[0].signalCode, null, 'SIGTERM was ignored');
  clock.advance(KILL_GRACE_MS);
  assert.deepEqual(await pending, { ok: false, code: 'core-error', exit: null, reason: 'timeout' });
  assert.equal(children[0].signalCode, 'SIGKILL');
});

test('concurrent calls with the same argv share one spawn; different argv do not', async () => {
  const { runner, starts } = setup('delay', { FAKE_CORE_DELAY_MS: '100' });
  const [a, b, c] = await Promise.all([
    runner.run('status', { taskId: 't', slug: 's' }),
    runner.run('status', { taskId: 't', slug: 's' }),
    runner.run('status', { taskId: 't2', slug: 's' }),
  ]);
  assert.deepEqual(a, b);
  assert.equal(a.ok && c.ok, true);
  assert.equal(starts().length, 2);
});

test('at most two children run at once', async () => {
  const { runner, starts, maxLive } = setup('delay', { FAKE_CORE_DELAY_MS: '150' });
  const results = await Promise.all(['a', 'b', 'c', 'd', 'e'].map((slug) => runner.run('attempts', { slug })));
  assert.ok(results.every((result: any) => result.ok));
  assert.equal(starts().length, 5);
  assert.equal(maxLive(), 2);
});

test('cache lifetimes: 2 s for runs, 30 s for capabilities, process lifetime for version and workflow', async () => {
  const { runner, clock, starts } = setup('echo');
  await runner.run('list', {});
  clock.advance(1999);
  await runner.run('list', {});
  assert.equal(starts().length, 1, 'list cached under 2 s');
  clock.advance(1);
  await runner.run('list', {});
  assert.equal(starts().length, 2, 'list re-spawned at 2 s');

  await runner.run('capabilities', {});
  clock.advance(29_999);
  await runner.run('capabilities', {});
  assert.equal(starts().length, 3, 'capabilities cached under 30 s');
  clock.advance(1);
  await runner.run('capabilities', {});
  assert.equal(starts().length, 4, 'capabilities re-spawned at 30 s');

  await runner.run('workflow', { taskClass: 'feature' });
  await runner.run('workflow', { taskClass: 'bug' });
  const afterWorkflows = starts().map((start: any) => start.argv[0]);
  assert.deepEqual(afterWorkflows.slice(4), ['--version', 'workflow', 'workflow'], 'workflow asks the version once');
  clock.advance(10 * 24 * 3600 * 1000);
  await runner.run('workflow', { taskClass: 'feature' });
  await runner.run('workflow', { taskClass: 'bug' });
  await runner.run('version', {});
  assert.equal(starts().length, 7, 'version and workflow live for the process');
});

test('cache lifetimes of the IC-018 shapes: 5 s for observed, slots and worker-status, 10 s for roadmap', async () => {
  const cases: Array<[string, any, number]> = [
    ['observed', {}, 5_000],
    ['slots', {}, 5_000],
    ['worker-status', { slug: 's', task: 'A.1', token: '1' }, 5_000],
    ['roadmap', {}, 10_000],
  ];
  for (const [shape, params, ttl] of cases) {
    const { runner, clock, starts } = setup('echo');
    await runner.run(shape, params);
    clock.advance(ttl - 1);
    await runner.run(shape, params);
    assert.equal(starts().length, 1, `${shape} cached under ${ttl} ms`);
    clock.advance(1);
    await runner.run(shape, params);
    assert.equal(starts().length, 2, `${shape} re-spawned at ${ttl} ms`);
  }
});

test('workflow is keyed by the core version, and not cached when the version is unknown', async () => {
  const versionText = '1.0.0';
  const versions: string[] = [];
  const { runner, starts } = setup('echo', {}, {
    spawnImpl: (command: string, args: string[], options: any) => {
      if (args[1] === '--version') {
        versions.push(versionText);
        return childProcess.spawn(command, ['-e', `process.stdout.write(${JSON.stringify(versionText)})`], options);
      }
      return childProcess.spawn(command, args, options);
    },
  });
  await runner.run('workflow', { taskClass: 'feature' });
  await runner.run('workflow', { taskClass: 'feature' });
  assert.equal(starts().length, 1);
  assert.deepEqual(versions, ['1.0.0']);

  const broken = setup('echo', {}, {
    spawnImpl: (command: string, args: string[], options: any) =>
      args[1] === '--version'
        ? childProcess.spawn(command, ['-e', 'process.exitCode = 3'], options)
        : childProcess.spawn(command, args, options),
  });
  assert.equal((await broken.runner.run('workflow', { taskClass: 'feature' })).ok, true);
  assert.equal((await broken.runner.run('workflow', { taskClass: 'feature' })).ok, true);
  assert.equal(broken.starts().length, 2, 'no version, no workflow cache');
});

test('exit 1 with [ERROR] on stderr backs that argv off for 30 s; stderr is never returned or logged', async () => {
  const { runner, clock, starts } = setup('error');
  const captured: string[] = [];
  const originals = { log: console.log, error: console.error, warn: console.warn, write: process.stderr.write };
  const capture = (...args: any[]) => {
    captured.push(args.map(String).join(' '));
    return true;
  };
  console.log = console.error = console.warn = capture;
  process.stderr.write = capture;
  let first: any;
  let during: any;
  let edge: any;
  try {
    first = await runner.run('status', { taskId: 't', slug: 's' });
    during = await runner.run('status', { taskId: 't', slug: 's' });
    clock.advance(29_999); // IC-003: 30 s
    edge = await runner.run('status', { taskId: 't', slug: 's' });
    clock.advance(1);
    await runner.run('status', { taskId: 't', slug: 's' });
  } finally {
    console.log = originals.log;
    console.error = originals.error;
    console.warn = originals.warn;
    process.stderr.write = originals.write;
  }
  assert.deepEqual(first, { ok: false, code: 'core-error', exit: 1 });
  assert.deepEqual(during, { ok: false, code: 'core-error', exit: 1, reason: 'backoff' });
  assert.deepEqual(edge, during);
  assert.equal(starts().length, 2, 'one spawn, then none for 30 s, then one');
  for (const result of [first, during, edge]) assert.equal(JSON.stringify(result).includes('secret-stderr-text'), false);
  assert.equal(captured.some((line) => line.includes('secret-stderr-text')), false, 'stderr was logged');
});

test('exit 1 without [ERROR] does not back off; other exits are core-error with the exit code', async () => {
  const plain = setup('exit1');
  assert.deepEqual(await plain.runner.run('list', {}), { ok: false, code: 'core-error', exit: 1 });
  await plain.runner.run('list', {});
  assert.equal(plain.starts().length, 2);
  const two = setup('exit2');
  assert.deepEqual(await two.runner.run('list', {}), { ok: false, code: 'core-error', exit: 2 });
});

test('stdout over 4 MiB is core-error; exactly 4 MiB is accepted', async () => {
  assert.equal(OUTPUT_CAP_BYTES, 4 * 1024 * 1024);
  const over = setup('big');
  assert.deepEqual(await over.runner.run('list', {}), { ok: false, code: 'core-error', exit: null, reason: 'output-cap' });
  const atCap = setup('at-cap');
  const result = await atCap.runner.run('list', {});
  assert.equal(result.ok, true);
  assert.equal(result.json.length, OUTPUT_CAP_BYTES - 2);
});

test('non-JSON stdout is core-error; version is a non-empty line of text', async () => {
  assert.deepEqual(await setup('text').runner.run('list', {}), { ok: false, code: 'core-error', exit: 0, reason: 'not-json' });
  assert.deepEqual(await setup('empty').runner.run('list', {}), { ok: false, code: 'core-error', exit: 0, reason: 'not-json' });
  assert.deepEqual(await setup('empty').runner.run('version', {}), { ok: false, code: 'core-error', exit: 0, reason: 'not-json' });
  assert.deepEqual(await setup('text').runner.run('version', {}), { ok: true, json: 'not json', exit: 0 });
});

test('a missing core or a failed spawn is core-unreachable', async () => {
  const missing = setup('echo', {}, { corePath: path.join(os.tmpdir(), 'no-such-doflow', 'bin', 'doflow.js') });
  assert.deepEqual(await missing.runner.run('list', {}), { ok: false, code: 'core-unreachable', exit: null });
  assert.equal(missing.spawnCalls.length, 0);
  const failing = setup('echo', {}, {
    spawnImpl: (_command: string, args: string[], options: any) => childProcess.spawn(path.join(os.tmpdir(), 'no-such-node-binary'), args, options),
  });
  assert.deepEqual(await failing.runner.run('list', {}), { ok: false, code: 'core-unreachable', exit: null });
});

test('stop() kills running children and answers queued calls as core-unreachable', async () => {
  const { runner, startsReach, children } = setup('sleep');
  const calls = ['a', 'b', 'c'].map((slug) => runner.run('attempts', { slug }));
  await startsReach(2);
  runner.stop();
  const results = await Promise.all(calls);
  assert.deepEqual(results[2], { ok: false, code: 'core-unreachable', exit: null });
  assert.equal(results[0].ok || results[1].ok, false);
  assert.ok(children.every((child: any) => child.signalCode === 'SIGKILL'));
  assert.equal(children.length, 2);
});

// ---- V.7: the Fleet shapes (IC-024) ----
//
// A second fake core stands in for `fleet` and `transcript`: it logs argv, cwd and the environment like the first,
// answers `fleet --action projects` with the file named by FAKE_PROJECTS_FILE (so a case can change the answer), and
// echoes `{argv, cwd}` for everything else. FAKE_ERROR_CWD makes `fleet --action tree` fail with [ERROR] in that
// directory; mode `agent-missing` answers `transcript --action read` with the core's `agent-not-in-project` error.

const fleetDirs: string[] = [];
const FLEET_CORE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-fleet-core-'));
fleetDirs.push(FLEET_CORE_DIR);
const FLEET_CORE = path.join(FLEET_CORE_DIR, 'fleet-core.js');
fs.writeFileSync(FLEET_CORE, `'use strict';
const fs = require('node:fs');
const argv = process.argv.slice(2);
if (process.env.FAKE_CORE_LOG) fs.appendFileSync(process.env.FAKE_CORE_LOG, JSON.stringify({ argv, env: process.env, cwd: process.cwd() }) + '\\n');
const done = () => {
  if (argv[0] === 'fleet' && argv[2] === 'tree' && process.env.FAKE_ERROR_CWD === process.cwd()) {
    process.stderr.write('[ERROR] fleet: boom\\n');
    process.exitCode = 1;
  } else if (process.env.FAKE_CORE_MODE === 'agent-missing' && argv[0] === 'transcript' && argv[2] === 'read') {
    process.stdout.write(JSON.stringify({ v: 1, error: 'agent-not-in-project' }));
    process.exitCode = 1;
  } else if (argv[0] === 'fleet' && argv[2] === 'projects') {
    process.stdout.write(fs.readFileSync(process.env.FAKE_PROJECTS_FILE, 'utf8'));
  } else {
    process.stdout.write(JSON.stringify({ argv, cwd: process.cwd() }));
  }
};
if (process.env.FAKE_CORE_MODE === 'delay') setTimeout(done, Number(process.env.FAKE_CORE_DELAY_MS || 200)); else done();
`);
after(() => {
  for (const dir of fleetDirs) fs.rmSync(dir, { recursive: true, force: true });
});

/** A runner over the fleet fake core with two project roots known to its `projects` answer. */
function fleetSetup(mode = 'echo', extraEnv: Record<string, string> = {}, errorOn?: 'A' | 'B') {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-fleet-roots-'));
  fleetDirs.push(made);
  const rootA = path.join(fs.realpathSync(made), 'a');
  const rootB = path.join(fs.realpathSync(made), 'b');
  fs.mkdirSync(rootA);
  fs.mkdirSync(rootB);
  const file = path.join(made, 'projects.json');
  const entry = (projectKey: string, root: string) => ({ projectKey, root, label: path.basename(root), current: false, checkouts: 1, sources: ['hook-dirs'], lastRecordAt: null });
  const writeProjects = (list: Array<[string, string]>) => fs.writeFileSync(file, JSON.stringify({
    v: 1, store: 'present', projects: list.map(([key, root]) => entry(key, root)), excluded: { missing: 0, temp: 0, notDoflow: 0, unreadable: 0 }, truncated: false,
  }));
  writeProjects([[KEY_A, rootA], [KEY_B, rootB]]);
  const base = setup(mode, { FAKE_PROJECTS_FILE: file, ...(errorOn ? { FAKE_ERROR_CWD: errorOn === 'A' ? rootA : rootB } : {}), ...extraEnv }, { corePath: FLEET_CORE });
  return { ...base, rootA, rootB, writeProjects };
}

test('the Fleet shapes run in their project root, found by key from the last projects read; projects runs in the console project', async () => {
  const f = fleetSetup('echo');
  // No projects read yet: every key is unknown, and nothing is spawned.
  for (const shape of [['tree', { projectKey: KEY_A }], ['traffic', { projectKey: KEY_A }], ['transcript', { projectKey: KEY_A, agent: AGENT, limit: '9' }]] as Array<[string, any]>) {
    assert.deepEqual(await f.runner.run(shape[0], shape[1]), { ok: false, code: 'project-not-found', exit: null }, shape[0]);
  }
  assert.equal(f.spawnCalls.length, 0);

  const listed = await f.runner.run('projects', {});
  assert.equal(listed.ok, true);
  assert.equal(f.starts()[0].cwd, f.project);
  assert.deepEqual(f.starts()[0].argv, ['fleet', '--action', 'projects', '--json']);

  const tree = await f.runner.run('tree', { projectKey: KEY_A });
  const treeB = await f.runner.run('tree', { projectKey: KEY_B });
  const traffic = await f.runner.run('traffic', { projectKey: KEY_B });
  const read = await f.runner.run('transcript', { projectKey: KEY_A, agent: AGENT, cursor: '12:34:5:6789', limit: '50' });
  const readFresh = await f.runner.run('transcript', { projectKey: KEY_B, agent: AGENT, limit: '500' });
  assert.deepEqual([tree, treeB, traffic, read, readFresh].map((r: any) => r.ok), [true, true, true, true, true]);
  const [, aTree, bTree, bTraffic, aRead, bRead] = f.starts();
  assert.deepEqual([aTree.cwd, bTree.cwd, bTraffic.cwd, aRead.cwd, bRead.cwd], [f.rootA, f.rootB, f.rootB, f.rootA, f.rootB]);
  assert.deepEqual(aTree.argv, ['fleet', '--action', 'tree', '--json']);
  assert.deepEqual(bTraffic.argv, ['transcript', '--action', 'stats', '--window', '10', '--json']);
  assert.deepEqual(aRead.argv, ['transcript', '--action', 'read', '--agent', AGENT, '--cursor', '12:34:5:6789', '--limit', '50', '--json']);
  assert.deepEqual(bRead.argv, ['transcript', '--action', 'read', '--agent', AGENT, '--limit', '500', '--json']);
  // The key and the root are never argv; the same environment rules apply to the Fleet children.
  for (const start of f.starts()) {
    assert.ok(!start.argv.includes(KEY_A) && !start.argv.some((a: string) => a.includes('/')), JSON.stringify(start.argv));
    assert.equal(start.env.DOFLOW_UPKEEP, 'off');
  }
  for (const call of f.spawnCalls) assert.equal(call.options.shell, false);

  // A key that matches the pattern but was not in the projects answer: refused before any spawn.
  const before = f.spawnCalls.length;
  assert.deepEqual(await f.runner.run('tree', { projectKey: 'cccccccccccccccc' }), { ok: false, code: 'project-not-found', exit: null });
  assert.equal(f.spawnCalls.length, before);
});

test('the key map is replaced by each projects read, not merged', async () => {
  const f = fleetSetup('echo');
  await f.runner.run('projects', {});
  assert.equal((await f.runner.run('tree', { projectKey: KEY_A })).ok, true);
  f.writeProjects([[KEY_B, f.rootB]]);
  f.clock.advance(10_000);
  assert.equal((await f.runner.run('projects', {})).ok, true);
  assert.deepEqual(await f.runner.run('tree', { projectKey: KEY_A }), { ok: false, code: 'project-not-found', exit: null });
  assert.equal((await f.runner.run('tree', { projectKey: KEY_B })).ok, true);
  // A root that is not absolute, or a key that is not 16 hex, never enters the map.
  fs.writeFileSync(path.join(path.dirname(f.rootA), 'projects.json'), JSON.stringify({ v: 1, projects: [{ projectKey: KEY_A, root: 'relative/dir' }, { projectKey: 'XYZ', root: f.rootA }, { projectKey: KEY_B, root: f.rootB }] }));
  f.clock.advance(10_000);
  await f.runner.run('projects', {});
  assert.deepEqual(await f.runner.run('tree', { projectKey: KEY_A }), { ok: false, code: 'project-not-found', exit: null });
  assert.equal((await f.runner.run('tree', { projectKey: KEY_B })).ok, true);
  // A body that is not a list leaves the map as it was.
  fs.writeFileSync(path.join(path.dirname(f.rootA), 'projects.json'), JSON.stringify({ v: 1 }));
  f.clock.advance(10_000);
  await f.runner.run('projects', {});
  assert.equal((await f.runner.run('tree', { projectKey: KEY_B })).ok, true);
});

test('the runner key is (projectKey, argv): single flight, cache and backoff are per project', async () => {
  const f = fleetSetup('delay', { FAKE_CORE_DELAY_MS: '80' }, 'A');
  await f.runner.run('projects', {});
  const base = f.starts().length;
  // Same argv, two projects: two spawns; the same project twice: one.
  const [a1, a2, b1] = await Promise.all([f.runner.run('traffic', { projectKey: KEY_A }), f.runner.run('traffic', { projectKey: KEY_A }), f.runner.run('traffic', { projectKey: KEY_B })]);
  assert.deepEqual([a1.ok, a2.ok, b1.ok], [true, true, true]);
  assert.equal(f.starts().length - base, 2);
  assert.deepEqual(f.starts().slice(base).map((s: any) => s.cwd).sort(), [f.rootA, f.rootB].sort());
  // Cached per project for 5 s.
  await f.runner.run('traffic', { projectKey: KEY_A });
  await f.runner.run('traffic', { projectKey: KEY_B });
  assert.equal(f.starts().length - base, 2);
  f.clock.advance(5_000);
  await f.runner.run('traffic', { projectKey: KEY_A });
  assert.equal(f.starts().length - base, 3);
  // Backoff: project A's tree fails with [ERROR] and exit 1; A is held for 30 s, B is not.
  const failed = await f.runner.run('tree', { projectKey: KEY_A });
  assert.deepEqual(failed, { ok: false, code: 'core-error', exit: 1 });
  const held = await f.runner.run('tree', { projectKey: KEY_A });
  assert.deepEqual(held, { ok: false, code: 'core-error', exit: 1, reason: 'backoff' });
  assert.equal((await f.runner.run('tree', { projectKey: KEY_B })).ok, true);
  assert.equal(f.starts().filter((s: any) => s.argv[0] === 'fleet' && s.argv[2] === 'tree').length, 2);
});

test('cache lifetimes of the Fleet shapes: 10 s projects, 5 s tree and traffic, transcript never', async () => {
  const f = fleetSetup('echo');
  const count = (shape: string) => f.starts().filter((s: any) => (shape === 'projects' ? s.argv[2] === 'projects' : shape === 'tree' ? s.argv[2] === 'tree' : s.argv[2] === shape)).length;
  await f.runner.run('projects', {});
  await f.runner.run('tree', { projectKey: KEY_A });
  await f.runner.run('traffic', { projectKey: KEY_A });
  const read = { projectKey: KEY_A, agent: AGENT, limit: '10' };
  await f.runner.run('transcript', read);
  await f.runner.run('transcript', read);
  await f.runner.run('transcript', read);
  assert.equal(count('read'), 3, 'transcript is never cached');
  f.clock.advance(4_999);
  await f.runner.run('projects', {});
  await f.runner.run('tree', { projectKey: KEY_A });
  await f.runner.run('traffic', { projectKey: KEY_A });
  assert.deepEqual([count('projects'), count('tree'), count('stats')], [1, 1, 1]);
  f.clock.advance(1);
  await f.runner.run('tree', { projectKey: KEY_A });
  await f.runner.run('traffic', { projectKey: KEY_A });
  await f.runner.run('projects', {});
  assert.deepEqual([count('projects'), count('tree'), count('stats')], [1, 2, 2]);
  f.clock.advance(5_000);
  await f.runner.run('projects', {});
  assert.equal(count('projects'), 2);
});

test('a third slot is reserved for transcript: it runs while two other reads hold the pool, and no other shape can take it', async () => {
  assert.equal(POOL_SIZE, 2);
  assert.equal(RESERVED_SLOTS, 1);
  const f = fleetSetup('delay', { FAKE_CORE_DELAY_MS: '300' });
  await f.runner.run('projects', {});
  const argvs = () => f.starts().map((s: any) => s.argv[0]);
  const base = f.starts().length;
  const held = [f.runner.run('attempts', { slug: 'a' }), f.runner.run('attempts', { slug: 'b' })];
  const fourth = f.runner.run('observed', {}); // queued behind the pool
  const read = f.runner.run('transcript', { projectKey: KEY_A, agent: AGENT, limit: '10' });
  const readToo = f.runner.run('transcript', { projectKey: KEY_A, agent: AGENT, limit: '11' }); // the reserved slot is busy: queued
  await f.startsReach(base + 3);
  assert.deepEqual(argvs().slice(base).sort(), ['task-attempt', 'task-attempt', 'transcript']);
  assert.equal(f.maxLive(), POOL_SIZE + RESERVED_SLOTS);
  const results = await Promise.all([...held, fourth, read, readToo]);
  assert.ok(results.every((r: any) => r.ok));
  assert.equal(f.starts().length, base + 5);
  assert.equal(f.maxLive(), POOL_SIZE + RESERVED_SLOTS, 'never more than pool + reserved');
});

test('the reserved slot is not taken by a shape other than transcript', async () => {
  const f = fleetSetup('delay', { FAKE_CORE_DELAY_MS: '250' });
  await f.runner.run('projects', {});
  const base = f.starts().length;
  const calls = [f.runner.run('attempts', { slug: 'a' }), f.runner.run('attempts', { slug: 'b' }), f.runner.run('observed', {}), f.runner.run('traffic', { projectKey: KEY_A })];
  await f.startsReach(base + 2);
  await realDelay(100);
  assert.equal(f.starts().length, base + 2, 'the third and fourth reads wait for the pool, not the reserved slot');
  assert.equal(f.maxLive(), POOL_SIZE);
  await Promise.all(calls);
  assert.equal(f.maxLive(), POOL_SIZE);
});

test('IC-005 Fleet error codes: project-not-found from the runner, the others from a core exit 1 id', async () => {
  assert.deepEqual({ ...FLEET_ERROR_STATUS }, { 'cannot-list-projects': 502, 'project-not-found': 404, 'agent-not-in-project': 404, 'session-not-in-project': 404, 'stream-limit': 429, 'live-unavailable': 503, 'core-lacks-verb': 501, 'unknown-run': 404 });
  assert.ok(Object.isFrozen(FLEET_ERROR_STATUS));
  const f = fleetSetup('agent-missing');
  await f.runner.run('projects', {});
  const gone = await f.runner.run('transcript', { projectKey: KEY_A, agent: AGENT, limit: '10' });
  assert.deepEqual(gone, { ok: false, code: 'core-error', exit: 1, errorId: 'agent-not-in-project' });
  assert.deepEqual(fleetError('transcript', gone), { status: 404, code: 'agent-not-in-project' });
  assert.deepEqual(fleetError('tree', { code: 'project-not-found', exit: null }), { status: 404, code: 'project-not-found' });
  assert.deepEqual(fleetError('transcript', { code: 'core-error', exit: 1, errorId: 'session-not-in-project' }), { status: 404, code: 'session-not-in-project' });
  assert.deepEqual(fleetError('projects', { code: 'core-error', exit: 1, errorId: 'cannot-list-projects' }), { status: 502, code: 'cannot-list-projects' });
  // Not Fleet codes: a code on the wrong shape, a different exit, no id, or a runner failure.
  assert.equal(fleetError('tree', { code: 'core-error', exit: 1, errorId: 'agent-not-in-project' }), null);
  assert.equal(fleetError('transcript', { code: 'core-error', exit: 2, errorId: 'agent-not-in-project' }), null);
  assert.equal(fleetError('projects', { code: 'core-error', exit: 1 }), null);
  assert.equal(fleetError('projects', { code: 'core-unreachable', exit: null }), null);
  assert.equal(fleetError('list', { code: 'core-error', exit: 1, errorId: 'stream-limit' }), null);
  assert.equal(fleetError('toString', { code: 'core-error', exit: 1, errorId: 'cannot-list-projects' }), null);
});


// ---- 149 B.1: the follow path (IC-008) ----
//
// Cases that need byte-exact chunking or a scripted exit use an in-process stand-in child; the others
// run fake-core.js in mode `events` through a real spawn (FAKE_EVENTS_SCRIPT picks its behaviour).

const FOLLOW_ARGV = ['events', '--follow', '--control', 'stdin', '--json'];

/** A child_process stand-in: stdout and stderr emit what the case pushes, stdin records writes, kill records signals. */
function fakeChild() {
  const child: any = new EventEmitter();
  child.pid = 4242;
  child.signals = [] as string[];
  child.kill = (signal: string) => {
    child.signals.push(signal);
    return true;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.written = [] as string[];
  child.stdin.ended = false;
  child.stdin.write = (text: string) => {
    child.stdin.written.push(text);
    return true;
  };
  child.stdin.end = () => {
    child.stdin.ended = true;
    child.stdin.writable = false;
  };
  child.out = (text: string | Buffer) => child.stdout.emit('data', Buffer.isBuffer(text) ? text : Buffer.from(text));
  child.err = (text: string) => child.stderr.emit('data', Buffer.from(text));
  child.close = (code: number | null, signal: string | null = null) => child.emit('close', code, signal);
  return child;
}

/** A runner whose follow spawns get stand-in children; pooled spawns run the real fake core. */
function followSetup(mode = 'echo', extraEnv: Record<string, string> = {}) {
  const fakes: any[] = [];
  const base = setup(mode, extraEnv, {
    spawnImpl: (command: string, args: string[], spawnOptions: any) => {
      base.spawnCalls.push({ command, args, options: spawnOptions });
      if (args[1] === 'events') {
        const child = fakeChild();
        fakes.push(child);
        return child;
      }
      const child = childProcess.spawn(command, args, spawnOptions);
      base.children.push(child);
      allChildren.push(child);
      return child;
    },
  });
  return { ...base, fakes };
}

/** The real fake core in mode `events`, every spawn recorded. */
function eventsSetup(script: string, extraEnv: Record<string, string> = {}) {
  return setup('events', { FAKE_EVENTS_SCRIPT: script, ...extraEnv });
}

test('the follow allow-list is exactly IC-008 events, frozen, and a shape added to either list is caught', async () => {
  const exactFollow = (ids: readonly string[]) => assert.deepEqual([...ids], ['events']);
  const exactShapes = (ids: readonly string[]) => assert.deepEqual([...ids], Object.keys(EXPECTED_SHAPES));
  exactFollow(FOLLOW_SHAPE_IDS);
  exactShapes(SHAPE_IDS);
  assert.deepEqual(FOLLOW_SHAPES.events.argv, ['events', '--follow', '--control', 'stdin']);
  assert.ok(Object.isFrozen(FOLLOW_SHAPES) && Object.isFrozen(FOLLOW_SHAPE_IDS) && Object.isFrozen(FOLLOW_SHAPES.events) && Object.isFrozen(FOLLOW_SHAPES.events.argv));
  assert.throws(() => {
    FOLLOW_SHAPES.tail = { argv: ['events', '--follow', '--channels', 'now'] };
  }, TypeError);
  assert.throws(() => {
    FOLLOW_SHAPES.events.argv.push('--channels');
  }, TypeError);
  // Controls: the exact assertions fail on a list that gained a shape.
  assert.throws(() => exactFollow([...FOLLOW_SHAPE_IDS, 'tail']), assert.AssertionError);
  assert.throws(() => exactShapes([...SHAPE_IDS, 'events']), assert.AssertionError);
  // The two lists do not overlap: a follow shape is not a pooled read, and a pooled shape cannot be followed.
  assert.deepEqual(FOLLOW_SHAPE_IDS.filter((id: string) => SHAPE_IDS.includes(id)), []);
  const { runner, spawnCalls } = followSetup();
  assert.deepEqual(await runner.run('events', {}), { ok: false, code: 'usage', exit: null });
  for (const id of ['list', 'transcript', 'nope', '__proto__', 'toString', '', 42 as any]) assert.equal(runner.follow(id), null, String(id));
  assert.equal(spawnCalls.length, 0);
});

test('follow spawns process.execPath <core> events --follow --control stdin --json: env stripped, shell off, cwd the project, stdio piped', async () => {
  const planted = { KEEP_ME: 'kept', DOFLOW_RUN_ID: 'run-1', DOFLOW_SESSION_ROLE: 'main', DOFLOW_SCOPE: 'global', DOFLOW_UPKEEP: 'on', DOFLOW_CONFIG_DIR: '/cfg' };
  const { runner, project, spawnCalls, starts, startsReach } = eventsSetup('follow', planted);
  const handle = runner.follow('events');
  assert.ok(handle);
  assert.equal(spawnCalls.length, 1);
  const call = spawnCalls[0];
  assert.equal(call.command, process.execPath);
  assert.deepEqual(call.args, [FAKE_CORE, ...FOLLOW_ARGV]);
  assert.deepEqual(call.options.stdio, ['pipe', 'pipe', 'pipe']);
  assert.equal(call.options.shell, false);
  assert.equal(call.options.cwd, project);
  assert.equal(call.options.windowsHide, true);
  await startsReach(1);
  const start = starts()[0];
  assert.deepEqual(start.argv, FOLLOW_ARGV);
  assert.equal(start.cwd, project);
  for (const name of ['DOFLOW_RUN_ID', 'DOFLOW_SESSION_ROLE', 'DOFLOW_SCOPE', ...IDENTITY_VARIABLES]) assert.equal(name in start.env, false, `${name} reached the follow child`);
  assert.equal(start.env.DOFLOW_UPKEEP, 'off');
  assert.equal(start.env.DOFLOW_CONFIG_DIR, '/cfg');
  assert.equal(start.env.KEEP_ME, 'kept');
  handle.end();
  assert.deepEqual(await handle.exited, { code: 0, signal: null, lines: 0, sawError: false, sawUnknown: false, reason: 'exit' });
});

test('follow takes no pool slot and has no timeout or 4 MiB cap: two pooled calls run while it lives', async () => {
  const { runner, clock, fakes, startsReach } = followSetup('delay', { FAKE_CORE_DELAY_MS: '400' });
  const handle = runner.follow('events');
  assert.ok(handle);
  const lines: string[] = [];
  handle.onLine((line: string) => lines.push(line));
  let finished = 0;
  const pooled = [runner.run('attempts', { slug: 'a' }), runner.run('attempts', { slug: 'b' })];
  for (const call of pooled) call.then(() => (finished += 1));
  await startsReach(2);
  assert.equal(finished, 0, 'both pooled children started together while the follow child lives');
  assert.ok((await Promise.all(pooled)).every((result: any) => result.ok));
  // No 10 s timeout: the follow child is still unsignalled long after.
  clock.advance(10 * 60_000);
  assert.deepEqual(fakes[0].signals, []);
  // No 4 MiB stdout cap: 17 lines of 256 KiB (4.25 MiB) all pass.
  const line = 'x'.repeat(FOLLOW_LINE_CAP_BYTES);
  for (let i = 0; i < 17; i++) fakes[0].out(`${line}\n`);
  assert.equal(lines.length, 17);
  assert.ok(lines.length * FOLLOW_LINE_CAP_BYTES > OUTPUT_CAP_BYTES);
  assert.deepEqual(fakes[0].signals, []);
  fakes[0].close(0);
  assert.equal((await handle.exited).lines, 17);
});

test('one follow child at a time: a second follow while one lives is null, a new one may start after it exits, none after stop()', async () => {
  const { runner, fakes, spawnCalls } = followSetup();
  const first = runner.follow('events');
  assert.ok(first);
  assert.equal(runner.follow('events'), null);
  assert.equal(spawnCalls.length, 1);
  fakes[0].close(0);
  assert.equal((await first.exited).reason, 'exit');
  const second = runner.follow('events');
  assert.ok(second, 'a new follow once the first has exited');
  assert.equal(spawnCalls.length, 2);
  runner.stop();
  assert.deepEqual(fakes[1].signals, ['SIGKILL']);
  assert.equal(fakes[1].stdin.ended, true);
  fakes[1].close(null, 'SIGKILL');
  assert.deepEqual(await second.exited, { code: null, signal: 'SIGKILL', lines: 0, sawError: false, sawUnknown: false, reason: 'stopped' });
  assert.equal(runner.follow('events'), null, 'a stopped runner follows nothing');
  assert.equal(spawnCalls.length, 2);
});

test('send writes one IC-005 line; onLine gets complete lines across chunks; lines counts them', async () => {
  const { runner, fakes } = followSetup();
  const handle = runner.follow('events');
  const child = fakes[0];
  assert.equal(handle.send({ op: 'sub', ch: 'tasks:feat-a' }), true);
  assert.equal(handle.send({ op: 'unsub', ch: 'now', extra: 'dropped' } as any), true);
  assert.equal(handle.send({ op: 'write', ch: 'now' } as any), false);
  assert.equal(handle.send({ op: 'sub', ch: 7 } as any), false);
  assert.deepEqual(child.stdin.written, ['{"op":"sub","ch":"tasks:feat-a"}\n', '{"op":"unsub","ch":"now"}\n']);
  const seen: string[] = [];
  const alsoSeen: string[] = [];
  handle.onLine((line: string) => seen.push(line));
  handle.onLine((line: string) => alsoSeen.push(line));
  const euro = Buffer.from('€');
  child.out('ab');
  child.out('c\nde');
  child.out(Buffer.concat([Buffer.from('f'), euro.subarray(0, 1)]));
  child.out(Buffer.concat([euro.subarray(1), Buffer.from('\n\ntail-without-newline')]));
  assert.deepEqual(seen, ['abc', 'def€', '']);
  assert.deepEqual(alsoSeen, seen);
  // EPIPE on a dead child's stdin is swallowed; send is false from then on.
  child.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
  assert.equal(handle.send({ op: 'sub', ch: 'now' }), false);
  child.close(0);
  const exit = await handle.exited;
  assert.deepEqual(exit, { code: 0, signal: null, lines: 3, sawError: false, sawUnknown: false, reason: 'exit' });
  assert.equal(seen.includes('tail-without-newline'), false, 'a partial line at exit is not a line');
});

test('end(): stdin end and SIGTERM, then SIGKILL after KILL_GRACE_MS; send is false after end', async () => {
  const { runner, clock, fakes } = followSetup();
  const handle = runner.follow('events');
  const child = fakes[0];
  handle.end();
  assert.equal(child.stdin.ended, true);
  assert.deepEqual(child.signals, ['SIGTERM']);
  assert.equal(handle.send({ op: 'sub', ch: 'now' }), false);
  handle.end();
  assert.deepEqual(child.signals, ['SIGTERM'], 'a second end() does nothing');
  clock.advance(KILL_GRACE_MS - 1);
  assert.deepEqual(child.signals, ['SIGTERM']);
  clock.advance(1);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  child.close(null, 'SIGKILL');
  assert.deepEqual(await handle.exited, { code: null, signal: 'SIGKILL', lines: 0, sawError: false, sawUnknown: false, reason: 'exit' });
});

test('a stdout line over 262144 bytes before its newline is SIGKILLed as line-cap; exactly the cap is a line', async () => {
  assert.equal(FOLLOW_LINE_CAP_BYTES, 262_144);
  const { runner, fakes } = followSetup();
  const handle = runner.follow('events');
  const child = fakes[0];
  const seen: string[] = [];
  handle.onLine((line: string) => seen.push(line));
  child.out('a'.repeat(FOLLOW_LINE_CAP_BYTES - 10));
  child.out(`${'a'.repeat(10)}\n`);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, FOLLOW_LINE_CAP_BYTES);
  assert.deepEqual(child.signals, []);
  child.out('b'.repeat(FOLLOW_LINE_CAP_BYTES));
  assert.deepEqual(child.signals, [], 'the partial line is at the cap, not over it');
  child.out('b');
  assert.deepEqual(child.signals, ['SIGKILL']);
  assert.equal(child.stdin.ended, true);
  child.out('\nlate line\n');
  assert.equal(seen.length, 1, 'nothing is delivered after the cap');
  runner.stop(); // stop() after the cap keeps the reason
  child.close(null, 'SIGKILL');
  assert.deepEqual(await handle.exited, { code: null, signal: 'SIGKILL', lines: 1, sawError: false, sawUnknown: false, reason: 'line-cap' });

  // The real fake core: 262145 bytes with no newline, then it waits to be killed.
  const real = eventsSetup('over-cap');
  const overCap = real.runner.follow('events');
  assert.deepEqual(await overCap.exited, { code: null, signal: 'SIGKILL', lines: 0, sawError: false, sawUnknown: false, reason: 'line-cap' });
});

test('stop() ends the follow child with the pooled children; exited is stopped', async () => {
  const mixed = followSetup('sleep');
  const handle = mixed.runner.follow('events');
  const pooled = mixed.runner.run('list', {});
  await mixed.startsReach(1);
  mixed.runner.stop();
  assert.deepEqual(mixed.fakes[0].signals, ['SIGKILL']);
  assert.deepEqual(await pooled, { ok: false, code: 'core-unreachable', exit: null });
  assert.equal(mixed.children[0].signalCode, 'SIGKILL');
  mixed.fakes[0].close(null, 'SIGKILL');
  assert.equal((await handle.exited).reason, 'stopped');

  // The real fake core in control mode.
  const { runner, startsReach, children } = eventsSetup('follow');
  const real = runner.follow('events');
  await startsReach(1);
  runner.stop();
  assert.deepEqual(await real.exited, { code: null, signal: 'SIGKILL', lines: 0, sawError: false, sawUnknown: false, reason: 'stopped' });
  assert.equal(children[0].signalCode, 'SIGKILL');
  assert.equal(runner.follow('events'), null);
});

test('stderr is scanned for [ERROR] and an unknown flag, command or verb only, in bounded lines, and never returned', async () => {
  const { runner, fakes } = followSetup();
  const split = runner.follow('events');
  fakes[0].err('[ERR');
  fakes[0].err('OR] events: boom\nunknown fl');
  fakes[0].err("ag '--x'\n");
  fakes[0].close(1);
  const exit = await split.exited;
  assert.deepEqual(exit, { code: 1, signal: null, lines: 0, sawError: true, sawUnknown: true, reason: 'exit' });
  assert.equal(JSON.stringify(exit).includes('boom'), false);

  // A stderr line far longer than the scan buffer still has its marker found; nothing else is matched.
  const long = runner.follow('events');
  fakes[1].err('x'.repeat(FOLLOW_STDERR_LINE_BYTES * 4));
  fakes[1].err(`${'y'.repeat(100)} [ERROR] late marker\n`);
  fakes[1].err('unknown option here; the unknown-flag word order is not this\n');
  fakes[1].close(1);
  assert.deepEqual(await long.exited, { code: 1, signal: null, lines: 0, sawError: true, sawUnknown: false, reason: 'exit' });
});

test('the real fake core: old-core replies set sawUnknown, an internal fault sets sawError, a clean run sets neither', async () => {
  const cases: Array<[string, any]> = [
    ['old-flag', { code: 1, signal: null, lines: 0, sawError: false, sawUnknown: true, reason: 'exit' }],
    ['old-command', { code: 1, signal: null, lines: 0, sawError: false, sawUnknown: true, reason: 'exit' }],
    ['old-verb', { code: 2, signal: null, lines: 0, sawError: false, sawUnknown: true, reason: 'exit' }],
    ['fault', { code: 1, signal: null, lines: 0, sawError: true, sawUnknown: false, reason: 'exit' }],
    ['usage', { code: 2, signal: null, lines: 0, sawError: false, sawUnknown: false, reason: 'exit' }],
    ['frames', { code: 0, signal: null, lines: 2, sawError: false, sawUnknown: false, reason: 'exit' }],
  ];
  for (const [script, expected] of cases) {
    const { runner } = eventsSetup(script);
    const handle = runner.follow('events');
    const exit = await handle.exited;
    assert.deepEqual(exit, expected, script);
    assert.equal(JSON.stringify(exit).includes('secret-stderr-text'), false);
    assert.equal(handle.send({ op: 'sub', ch: 'now' }), false, `${script}: send after exit`);
  }
  const exitTwo = eventsSetup('frames', { FAKE_EVENTS_EXIT: '2', FAKE_EVENTS_COUNT: '1' });
  assert.deepEqual(await exitTwo.runner.follow('events').exited, { code: 2, signal: null, lines: 1, sawError: false, sawUnknown: false, reason: 'exit' });
});

test('the real fake core in control mode: sub over stdin gets a scripted snapshot frame; stdin EOF ends it with 0', async () => {
  const { runner } = eventsSetup('follow');
  const handle = runner.follow('events');
  const frames: any[] = [];
  let resolveTwo: () => void = () => {};
  const two = new Promise<void>((resolve) => {
    resolveTwo = resolve;
  });
  handle.onLine((line: string) => {
    frames.push(JSON.parse(line));
    if (frames.length === 2) resolveTwo();
  });
  assert.equal(handle.send({ op: 'sub', ch: 'now' }), true);
  assert.equal(handle.send({ op: 'sub', ch: 'tasks:feat-a' }), true);
  await two;
  assert.deepEqual(frames.map((frame) => [frame.v, frame.ch, frame.type]), [[1, 'now', 'snapshot'], [1, 'tasks:feat-a', 'snapshot']]);
  for (const frame of frames) assert.match(frame.id, /^[0-9a-f]{8}-[1-9][0-9]{0,15}$/);
  handle.end();
  assert.deepEqual(await handle.exited, { code: 0, signal: null, lines: 2, sawError: false, sawUnknown: false, reason: 'exit' });
});

test('a missing core or a failed spawn is spawn-failed: exited resolves, send is false, and a later follow may start', async () => {
  const missing = setup('events', {}, { corePath: path.join(os.tmpdir(), 'no-such-doflow', 'bin', 'doflow.js') });
  const gone = missing.runner.follow('events');
  assert.ok(gone);
  assert.deepEqual(await gone.exited, { code: null, signal: null, lines: 0, sawError: false, sawUnknown: false, reason: 'spawn-failed' });
  assert.equal(gone.send({ op: 'sub', ch: 'now' }), false);
  gone.end();
  assert.equal(missing.spawnCalls.length, 0);

  const failing = setup('events', {}, {
    spawnImpl: (_command: string, args: string[], options: any) => childProcess.spawn(path.join(os.tmpdir(), 'no-such-node-binary'), args, options),
  });
  const failed = failing.runner.follow('events');
  assert.deepEqual(await failed.exited, { code: null, signal: null, lines: 0, sawError: false, sawUnknown: false, reason: 'spawn-failed' });
  assert.equal(failed.send({ op: 'sub', ch: 'now' }), false);
  assert.ok(failing.runner.follow('events'), 'spawn-failed leaves no live follow child');
  failing.runner.stop();

  const throwing = setup('events', {}, {
    spawnImpl: () => {
      throw new Error('spawn refused');
    },
  });
  assert.equal((await throwing.runner.follow('events').exited).reason, 'spawn-failed');
});

// ---- 150 B.1: the worker chain shapes and the old-core marker on the pooled path (IC-010) ----

const CHILD_RUN_ID = 'w-0f0e0d0c0b0a';
const LOG_CURSOR = '8812345:4096:0:1762581600000';

test('worker-log argv with and without its optional --slug, --cursor and --before, in the IC-010 order', async () => {
  const cases: Array<[any, string[]]> = [
    [{ runId: RUN_ID, stream: 'err' }, ['worker-log', '--worker-run', RUN_ID, '--stream', 'err', '--json']],
    [{ runId: RUN_ID, stream: 'out', slug: 'feat-a' }, ['worker-log', '--slug', 'feat-a', '--worker-run', RUN_ID, '--stream', 'out', '--json']],
    [{ runId: RUN_ID, stream: 'out', cursor: LOG_CURSOR }, ['worker-log', '--worker-run', RUN_ID, '--stream', 'out', '--cursor', LOG_CURSOR, '--json']],
    [{ runId: RUN_ID, stream: 'err', before: LOG_CURSOR }, ['worker-log', '--worker-run', RUN_ID, '--stream', 'err', '--before', LOG_CURSOR, '--json']],
    [{ stream: 'out', before: LOG_CURSOR, slug: 'feat-a', runId: RUN_ID }, ['worker-log', '--slug', 'feat-a', '--worker-run', RUN_ID, '--stream', 'out', '--before', LOG_CURSOR, '--json']],
  ];
  const { runner, starts, spawnCalls, project } = setup('echo');
  for (const [params, argv] of cases) {
    const result = await runner.run('worker-log', params);
    assert.deepEqual(result, { ok: true, json: { argv }, exit: 0 }, JSON.stringify(params));
    assert.deepEqual(spawnCalls.at(-1).args, [FAKE_CORE, ...argv]);
    assert.equal(spawnCalls.at(-1).options.shell, false);
    assert.equal(starts().at(-1).cwd, project);
  }
  assert.equal(starts().length, cases.length);
});

test('a bad run id, stream, slug or cursor on the worker shapes is refused as usage before any spawn', async () => {
  const { runner, starts, spawnCalls } = setup('echo');
  const refused: Array<[string, any]> = [
    ['worker-result', { slug: 's', runId: 'w-1A2B3C4D5E6F' }],
    ['worker-result', { slug: 's', runId: 'w-1a2b3c4d5e6' }],
    ['worker-result', { slug: 's', runId: 'w-1a2b3c4d5e6f0' }],
    ['worker-result', { slug: 's', runId: '1a2b3c4d5e6f' }],
    ['worker-result', { slug: 's', runId: 'x-1a2b3c4d5e6f' }],
    ['worker-result', { slug: 's', runId: `${RUN_ID}\n` }],
    ['worker-result', { slug: 's', runId: '--worker-run' }],
    ['worker-result', { slug: 's', runId: 1 }],
    ['worker-result', { runId: RUN_ID }],
    ['worker-result', { slug: '-g', runId: RUN_ID }],
    ['worker-result', { slug: 's', runId: RUN_ID, stream: 'out' }],
    ['worker-run-status', { slug: 's' }],
    ['worker-run-status', { slug: 's', runId: 'w-zzzzzzzzzzzz' }],
    ['worker-run-status', { slug: 's', runId: RUN_ID, task: 'A.1', token: '1' }],
    ['worker-run-status', { slug: 's', runId: RUN_ID, action: 'cancel' }],
    ['worker-runs', {}],
    ['worker-runs', { slug: '../x' }],
    ['worker-runs', { slug: 's', runId: RUN_ID }],
    ['worker-log', { runId: RUN_ID }],
    ['worker-log', { stream: 'out' }],
    ['worker-log', { runId: RUN_ID, stream: 'last' }],
    ['worker-log', { runId: RUN_ID, stream: 'OUT' }],
    ['worker-log', { runId: RUN_ID, stream: 'out ' }],
    ['worker-log', { runId: RUN_ID, stream: 'outerr' }],
    ['worker-log', { runId: RUN_ID, stream: 'out\n' }],
    ['worker-log', { runId: RUN_ID, stream: '' }],
    ['worker-log', { runId: RUN_ID, stream: 'out', cursor: '1:2:3' }],
    ['worker-log', { runId: RUN_ID, stream: 'out', before: '1:2:3:x' }],
    ['worker-log', { runId: RUN_ID, stream: 'out', before: '' }],
    ['worker-log', { runId: RUN_ID, stream: 'out', slug: '.hidden' }],
    ['worker-log', { runId: RUN_ID, stream: 'out', limit: '10' }],
    ['worker-log', { runId: 'W-1a2b3c4d5e6f', stream: 'out' }],
  ];
  for (const [shape, params] of refused) {
    assert.deepEqual(await runner.run(shape, params), { ok: false, code: 'usage', exit: null }, `${shape} ${JSON.stringify(params)}`);
  }
  assert.equal(spawnCalls.length, 0);
  assert.equal(starts().length, 0);
  // Control: the same shapes with good parameters do spawn.
  assert.equal((await runner.run('worker-log', { runId: RUN_ID, stream: 'err' })).ok, true);
  assert.equal(spawnCalls.length, 1);
});

test('worker-log is never cached; worker-runs, worker-result and worker-run-status are cached for 2 s', async () => {
  const log = setup('echo');
  for (let i = 0; i < 3; i++) assert.equal((await log.runner.run('worker-log', { runId: RUN_ID, stream: 'out' })).ok, true);
  assert.equal(log.starts().length, 3, 'worker-log spawned every time');
  assert.equal(SHAPES['worker-log'].ttl, 0);
  assert.equal(SHAPES['worker-log'].reserved, undefined, 'worker-log takes no reserved slot');

  const cases: Array<[string, any]> = [
    ['worker-runs', { slug: 's' }],
    ['worker-result', { slug: 's', runId: RUN_ID }],
    ['worker-run-status', { slug: 's', runId: RUN_ID }],
  ];
  for (const [shape, params] of cases) {
    const { runner, clock, starts } = setup('echo');
    await runner.run(shape, params);
    clock.advance(1_999);
    await runner.run(shape, params);
    assert.equal(starts().length, 1, `${shape} cached under 2 s`);
    clock.advance(1);
    await runner.run(shape, params);
    assert.equal(starts().length, 2, `${shape} re-spawned at 2 s`);
  }
});

test('worker-log waits for the pool and never takes the reserved slot', async () => {
  const { runner, starts, startsReach, maxLive } = setup('delay', { FAKE_CORE_DELAY_MS: '250' });
  const calls = [runner.run('attempts', { slug: 'a' }), runner.run('attempts', { slug: 'b' }), runner.run('worker-log', { runId: RUN_ID, stream: 'out' })];
  await startsReach(2);
  await realDelay(100);
  assert.equal(starts().length, 2, 'worker-log waits while the pool is full');
  assert.ok((await Promise.all(calls)).every((result: any) => result.ok));
  assert.equal(starts().length, 3);
  assert.equal(maxLive(), POOL_SIZE);
});

test('the real fake core in mode worker-reads: the four bodies, and unknown-run maps to 404 on worker-result and worker-log', async () => {
  const { runner } = setup('worker-reads');
  const runs = await runner.run('worker-runs', { slug: 'feat-a' });
  assert.equal(runs.ok, true);
  assert.equal(runs.json.slug, 'feat-a');
  assert.deepEqual(runs.json.runs.map((r: any) => [r.runId, r.childOf]), [[RUN_ID, null], [CHILD_RUN_ID, RUN_ID]]);
  assert.deepEqual(Object.keys(runs.json.runs[0]), ['runId', 'task', 'token', 'harness', 'childOf', 'phase', 'endState', 'createdAt', 'startedAt', 'endedAt', 'edit']);

  const result = await runner.run('worker-result', { slug: 'feat-a', runId: RUN_ID });
  assert.deepEqual(Object.keys(result.json), ['v', 'runId', 'task', 'token', 'harness', 'phase', 'endState', 'endedAt', 'reportStatus', 'readOnly', 'isolation', 'resultOffered', 'withheld', 'quota']);

  const status = await runner.run('worker-run-status', { slug: 'feat-a', runId: RUN_ID });
  assert.equal(status.json.disposition, 'status');
  assert.equal(typeof status.json.deadline, 'string');
  assert.equal(status.json.process.kind, 'exited');
  assert.equal(typeof status.json.process.pid, 'number', 'the planted pid is in the raw body for the projector cases');
  assert.equal(typeof status.json.pgid, 'number');

  const tail = await runner.run('worker-log', { runId: RUN_ID, stream: 'out' });
  assert.equal(tail.ok, true);
  assert.deepEqual(tail.json.pieces.filter((p: any) => p.cut).map((p: any) => p.at + Buffer.byteLength(p.text)), [32_768], 'one piece cut at the grid');
  assert.deepEqual([tail.json.from, tail.json.to, tail.json.size, tail.json.eof, tail.json.before], [0, tail.json.size, tail.json.size, true, null]);
  const forward = await runner.run('worker-log', { runId: RUN_ID, stream: 'out', cursor: tail.json.cursor });
  assert.deepEqual([forward.json.from, forward.json.to, forward.json.pieces], [tail.json.size, tail.json.size, []]);
  const backward = await runner.run('worker-log', { runId: RUN_ID, stream: 'out', before: `8812345:32768:0:1` });
  assert.deepEqual(backward.json.pieces.map((p: any) => p.at), [0, 10]);
  const reset = await runner.run('worker-log', { runId: RUN_ID, stream: 'err', cursor: '1:5:0:1' });
  assert.equal(reset.json.reset, true);

  for (const shape of ['worker-result', 'worker-log']) {
    const missing = await runner.run(shape, { slug: 'feat-a', runId: 'w-ffffffffffff', ...(shape === 'worker-log' ? { stream: 'out' } : {}) });
    assert.deepEqual(missing, { ok: false, code: 'core-error', exit: 1, errorId: 'unknown-run' }, shape);
    assert.deepEqual(fleetError(shape, missing), { status: 404, code: 'unknown-run' }, shape);
  }
});

test('the IC-010 status codes: core-lacks-verb 501, unknown-run 404 on worker-result and worker-log only', () => {
  assert.equal(FLEET_ERROR_STATUS['core-lacks-verb'], 501);
  assert.equal(FLEET_ERROR_STATUS['unknown-run'], 404);
  const unknownRun = { code: 'core-error', exit: 1, errorId: 'unknown-run' };
  assert.deepEqual(fleetError('worker-result', unknownRun), { status: 404, code: 'unknown-run' });
  assert.deepEqual(fleetError('worker-log', unknownRun), { status: 404, code: 'unknown-run' });
  // Controls: another shape, another exit, another id, and the old-core failure (the routes map it, IC-010).
  assert.equal(fleetError('worker-runs', unknownRun), null);
  assert.equal(fleetError('worker-run-status', unknownRun), null);
  assert.equal(fleetError('transcript', unknownRun), null);
  assert.equal(fleetError('worker-log', { ...unknownRun, exit: 2 }), null);
  assert.equal(fleetError('worker-log', { code: 'core-error', exit: 1, errorId: 'log-unreadable' }), null);
  assert.equal(fleetError('worker-log', { code: 'core-error', exit: 2, errorId: 'store-unreadable' }), null);
  assert.equal(fleetError('worker-result', { code: 'core-error', exit: 1, reason: 'old-core' } as any), null);
});

test('an older core: each new shape is old-core on the pooled path, never cached and never backed off', async () => {
  const { runner, starts } = setup('old-core');
  const cases: Array<[string, any, number]> = [
    ['worker-runs', { slug: 's' }, 1],
    ['worker-result', { slug: 's', runId: RUN_ID }, 1],
    ['worker-log', { runId: RUN_ID, stream: 'out' }, 1],
    ['worker-run-status', { slug: 's', runId: RUN_ID }, 2], // RK2: an unknown-flag line, exit 2
  ];
  for (const [shape, params, exit] of cases) {
    for (let i = 0; i < 2; i++) {
      assert.deepEqual(await runner.run(shape, params), { ok: false, code: 'core-error', exit, reason: 'old-core' }, `${shape} call ${i + 1}`);
    }
  }
  assert.equal(starts().length, 2 * cases.length, 'every call spawned: no cache, no backoff');
  // Control: the old core still answers the shapes it has.
  assert.equal((await runner.run('worker-status', { slug: 's', task: 'A.1', token: '1' })).ok, true);
});

test('the old-core result needs exit 1 or 2, empty stdout, the unknown marker and no [ERROR]; stderr is never returned', async () => {
  /** A runner whose pooled spawns are stand-in children that write `stdout`, then `stderr` in chunks, then exit. */
  const scripted = (stdout: string, stderr: string[], exit: number) => {
    let spawns = 0;
    const base = setup('echo', {}, {
      spawnImpl: () => {
        spawns += 1;
        const child = fakeChild();
        setImmediate(() => {
          if (stdout) child.out(stdout);
          for (const chunk of stderr) child.err(chunk);
          child.close(exit);
        });
        return child;
      },
    });
    return { ...base, spawns: () => spawns };
  };
  const oldCore = { ok: false, code: 'core-error', reason: 'old-core' };
  const cases: Array<[string, string, string[], number, any]> = [
    ['unknown command, exit 1', '', ["doflow: unknown command 'worker-log' secret-stderr-text\n"], 1, { ...oldCore, exit: 1 }],
    ['unknown flag, exit 2', '', ["doflow: unknown flag '--worker-run'\n"], 2, { ...oldCore, exit: 2 }],
    ['unknown verb, no newline', '', ["unknown verb 'worker-log'"], 2, { ...oldCore, exit: 2 }],
    ['marker split across chunks', '', ['doflow: unkn', "own comm", "and 'worker-runs'\n"], 1, { ...oldCore, exit: 1 }],
    ['[ERROR] present', '', ["[ERROR] boom secret-stderr-text\ndoflow: unknown command 'x'\n"], 1, { ok: false, code: 'core-error', exit: 1 }],
    ['exit 3', '', ["doflow: unknown command 'x'\n"], 3, { ok: false, code: 'core-error', exit: 3 }],
    ['stdout not empty', '{"v":1,"ok":false,"error":"usage"}', ["doflow worker-log: unknown flag '--x'\n"], 2, { ok: false, code: 'core-error', exit: 2, errorId: 'usage' }],
    ['no marker', '', ['doflow worker-log: --stream must be out or err\n'], 2, { ok: false, code: 'core-error', exit: 2 }],
    ['unknown option is not the marker', '', ['unknown option here\n'], 1, { ok: false, code: 'core-error', exit: 1 }],
  ];
  for (const [name, stdout, stderr, exit, expected] of cases) {
    const s = scripted(stdout, stderr, exit);
    const first = await s.runner.run('worker-log', { runId: RUN_ID, stream: 'out' });
    assert.deepEqual(first, expected, name);
    assert.equal(JSON.stringify(first).includes('secret-stderr-text'), false, `${name}: stderr text returned`);
    await s.runner.run('worker-log', { runId: RUN_ID, stream: 'out' });
    // Only the [ERROR] exit 1 backs off: its second call does not spawn.
    assert.equal(s.spawns(), name === '[ERROR] present' ? 1 : 2, `${name}: spawns`);
  }
});
