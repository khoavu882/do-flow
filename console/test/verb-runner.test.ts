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
} = require('../src/verb-runner.ts');

const FAKE_CORE = path.join(__dirname, 'fixtures', 'fake-core.js');
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
  assert.deepEqual(actions.filter((action: string) => /^(slot|worker|roadmap|primary) /.test(action)).sort(),
    ['primary observed', 'roadmap status', 'slot peek', 'worker status']);
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
