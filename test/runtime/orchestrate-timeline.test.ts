'use strict';

// 093 IC-012: `orchestrate --action timeline`, one run's recorded events without free text. It
// resolves the run as `status` does, writes nothing and refuses every flag `list` refuses except
// `--task-id` and `--slug`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');
const { handleOrchestrateCommand } = require('../../src/runtime/workflow-orchestrator.ts');

const REPO = path.resolve(__dirname, '..', '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const STORE = path.join('.doflow', 'state', 'orchestration');
const MARKER = 'ZZ-MARKER-7f3';
const EVENT_KEYS = ['at', 'action', 'node', 'outcome', 'decision', 'forced', 'synthetic'];
const BODY_KEYS = ['v', 'taskId', 'featureSlug', 'revision', 'startedAt', 'events', 'otherEvents'];
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function project(t: any) {
  const root = tempDir(t, 'doflow-orchestrate-timeline-');
  fs.writeFileSync(path.join(root, 'a.js'), 'module.exports = 1;\n');
  const git = (...args: any[]) => execFileSync('git', ['-C', root, ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('add', '-A');
  git('commit', '-qm', 'init');
  git('branch', '-M', 'main');
  return root;
}

function runCli(cwd: any, args: any, options: any = {}) {
  const home = path.join(cwd, '.test-home');
  const config = path.join(cwd, '.test-config');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(config, { recursive: true });
  const env: any = { ...process.env, DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off', HOME: home, XDG_CONFIG_HOME: config, ...options.env };
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key];
  const result = spawnSync(process.execPath, [DOFLOW, ...args], { cwd, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function ok(cwd: any, args: any) {
  const result = runCli(cwd, ['orchestrate', ...args, '--json']);
  assert.equal(result.status, 0, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
  return JSON.parse(result.stdout);
}

function timeline(cwd: any, args: any) {
  return ok(cwd, ['--action', 'timeline', ...args]);
}

/** The handler in-process, for the refusal table (the dispatcher fills these same options). */
function orchestrate(stateRoot: any, options: any = {}): any {
  const out: any = [];
  const err: any = [];
  const { log, error } = console;
  const exitCode = process.exitCode;
  console.log = (...args) => { out.push(args.join(' ')); };
  console.error = (...args) => { err.push(args.join(' ')); };
  let status;
  try {
    clearCheckoutCache();
    status = handleOrchestrateCommand({ stateRoot, ...options });
  } finally {
    console.log = log;
    console.error = error;
    process.exitCode = exitCode;
  }
  return { status, stdout: out.join('\n'), stderr: err.join('\n') };
}

/** Every path, size, inode and mtime under the given roots' `.doflow`, so any write shows. */
function snapshot(roots: any[]) {
  return roots.map((root) => {
    const entries: any[] = [];
    const visit = (dir: string) => {
      let names: string[];
      try { names = fs.readdirSync(dir).sort(); } catch { return; }
      for (const name of names) {
        const file = path.join(dir, name);
        const info = fs.lstatSync(file, { bigint: true });
        entries.push(`${path.relative(root, file)} ${info.mtimeNs} ${info.ino} ${info.isFile() ? fs.readFileSync(file).toString('base64') : 'd'}`);
        if (info.isDirectory()) visit(file);
      }
    };
    visit(path.join(root, '.doflow'));
    return entries;
  });
}

const event = (action: string, fields: any = {}) => ({ action, node: null, outcome: null, decision: null, forced: false, synthetic: false, ...fields });
const shapeOf = (events: any[]) => events.map(({ at, ...rest }: any) => rest);

test('IC-012: a run walked with real verbs gives its events in journal order with exactly the contract fields', (t) => {
  const root = project(t);
  const slug = ['--slug', 'feat-tl'];
  ok(root, ['--action', 'start', '--task-id', 't1', '--task-class', 'feature', ...slug]);
  ok(root, ['--action', 'complete-stage', '--task-id', 't1', '--stage', 'discovery', '--result', 'passed', '--note', `done ${MARKER}`, ...slug]);
  ok(root, ['--action', 'decide-gate', '--task-id', 't1', '--gate', 'gate-0', '--decision', 'approve', '--forced', '--note', `forced ${MARKER}`, ...slug]);
  ok(root, ['--action', 'annotate', '--task-id', 't1', '--node', 'discovery', '--note', `again ${MARKER}`, ...slug]);
  const status = ok(root, ['--action', 'status', '--task-id', 't1', ...slug]);

  const body = timeline(root, ['--task-id', 't1', ...slug]);
  assert.deepEqual(Object.keys(body), BODY_KEYS);
  assert.equal(body.v, 1);
  assert.equal(body.taskId, 't1');
  assert.equal(body.featureSlug, 'feat-tl');
  assert.equal(body.revision, status.revision);
  assert.match(body.startedAt, ISO);
  assert.equal(body.otherEvents, 0);
  for (const entry of body.events) {
    assert.deepEqual(Object.keys(entry), EVENT_KEYS);
    assert.match(entry.at, ISO);
  }
  assert.deepEqual(shapeOf(body.events), [
    event('start'),
    event('complete-stage', { node: 'discovery', outcome: 'passed' }),
    event('decide-gate', { node: 'gate-0', decision: 'approve', forced: true }),
    event('annotate', { node: 'discovery' }),
  ]);
  const times = body.events.map((entry: any) => Date.parse(entry.at));
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
});

test('IC-012: skip-stage, a backfilled stage, a rejection and complete-run carry their own fields', (t) => {
  const root = project(t);
  // research: an optional first stage to skip, then the last stage completes the run.
  ok(root, ['--action', 'start', '--task-id', 'r1', '--task-class', 'research']);
  ok(root, ['--action', 'skip-stage', '--task-id', 'r1', '--stage', 'scoping', '--reason', `not needed ${MARKER}`]);
  ok(root, ['--action', 'complete-stage', '--task-id', 'r1', '--stage', 'synthesis', '--result', 'failed']);
  assert.deepEqual(shapeOf(timeline(root, ['--task-id', 'r1']).events), [
    event('start'),
    event('skip-stage', { node: 'scoping' }),
    event('complete-stage', { node: 'synthesis', outcome: 'failed' }),
    event('complete-run'),
  ]);

  // bug: catch-up backfills the stage it walks past, which is synthetic, never work done.
  ok(root, ['--action', 'catch-up', '--task-id', 'b1', '--task-class', 'bug', '--stage', 'root-cause', '--note', MARKER]);
  ok(root, ['--action', 'complete-stage', '--task-id', 'b1', '--stage', 'root-cause']);
  assert.deepEqual(shapeOf(timeline(root, ['--task-id', 'b1']).events), [
    event('start'),
    event('complete-stage', { node: 'reproduction', outcome: 'unverified', synthetic: true }),
    event('complete-stage', { node: 'root-cause', outcome: 'unverified' }),
  ]);

  // feature: a rejected gate.
  ok(root, ['--action', 'start', '--task-id', 'f1', '--task-class', 'feature']);
  ok(root, ['--action', 'complete-stage', '--task-id', 'f1', '--stage', 'discovery']);
  ok(root, ['--action', 'decide-gate', '--task-id', 'f1', '--gate', 'gate-0', '--decision', 'reject', '--note', MARKER]);
  assert.deepEqual(shapeOf(timeline(root, ['--task-id', 'f1']).events).slice(-1), [
    event('decide-gate', { node: 'gate-0', decision: 'reject' }),
  ]);
});

test('IC-012: journal entries keep only closed values; other actions are counted, never shown', (t) => {
  const root = project(t);
  const file = path.join(root, STORE, 'j1.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({
    version: 1, taskId: 'j1', taskClass: 'feature', workflowName: 'Feature', terminalStage: null, state: 'RUNNING',
    cursor: 0, program: [{ type: 'stage', id: 'x', status: 'pending' }], startedAt: 'yesterday', revision: 7,
    traceId: 'a'.repeat(32), runKey: MARKER,
    history: [
      { at: '2026-10-26T01:00:00.000Z', action: 'start', detail: `task-class=feature ${MARKER}` },
      { at: '2026-10-26T01:01:00.000Z', action: 'complete-stage', node: 'a', backfilled: false, executionStatus: 'imported', outcome: 'passed', note: MARKER, consultations: [{ server: MARKER }] },
      { at: '2026-10-26T01:02:00.000Z', action: 'skip-stage', node: 'b', backfilled: true, note: MARKER },
      { at: '2026-10-26T01:03:00.000Z', action: 'skip-gate', node: 'g', backfilled: false, note: 'anchor stage skipped' },
      { at: '2026-10-26T01:04:00.000Z', action: 'decide-gate', node: 'gate-a', detail: 'approve', by: MARKER, policy: { id: MARKER }, inputs: [MARKER], note: MARKER, forced: false },
      { at: '2026-10-26T01:05:00.000Z', action: 'decide-gate', node: 'gate-b', detail: `approve ${MARKER}`, forced: 'yes' },
      { at: 'not a time', action: 'annotate', node: `bad id ${MARKER}`, outcome: MARKER, note: MARKER, forced: true },
      { at: '2026-10-26T01:06:00.000Z', action: `handoff-${MARKER}`, node: 'x', note: MARKER },
      'not an entry',
      { at: '2026-10-26T01:07:00.000Z', action: 'complete-run', outcome: 'passed', detail: 'approve' },
    ],
  }));

  const body = timeline(root, ['--task-id', 'j1']);
  assert.equal(body.revision, 7);
  assert.equal(body.startedAt, null);
  assert.equal(body.featureSlug, null);
  assert.equal(body.otherEvents, 2);
  assert.deepEqual(body.events.map((entry: any) => entry.at), [
    '2026-10-26T01:00:00.000Z', '2026-10-26T01:01:00.000Z', '2026-10-26T01:02:00.000Z', '2026-10-26T01:03:00.000Z',
    '2026-10-26T01:04:00.000Z', '2026-10-26T01:05:00.000Z', null, '2026-10-26T01:07:00.000Z',
  ]);
  assert.deepEqual(shapeOf(body.events), [
    event('start'),
    event('complete-stage', { node: 'a', outcome: 'passed', synthetic: true }),
    event('skip-stage', { node: 'b', synthetic: true }),
    event('skip-gate', { node: 'g' }),
    event('decide-gate', { node: 'gate-a', decision: 'approve' }),
    event('decide-gate', { node: 'gate-b' }),
    event('annotate', { forced: true }),
    event('complete-run'),
  ]);
});

test('IC-012: no note, detail text, decider, consultation or trace id reaches either output form', (t) => {
  const root = project(t);
  const slug = ['--slug', 'feat-m'];
  ok(root, ['--action', 'start', '--task-id', 'm1', '--task-class', 'feature', ...slug]);
  ok(root, ['--action', 'complete-stage', '--task-id', 'm1', '--stage', 'discovery', '--note', MARKER, ...slug]);
  ok(root, ['--action', 'decide-gate', '--task-id', 'm1', '--gate', 'gate-0', '--decision', 'approve', '--note', MARKER, ...slug]);
  ok(root, ['--action', 'annotate', '--task-id', 'm1', '--node', 'discovery', '--note', MARKER, ...slug]);
  const file = path.join(root, STORE, 'feat-m', 'm1.json');
  assert.ok(fs.readFileSync(file, 'utf8').includes(MARKER), 'the marker is in the journal');

  const json = runCli(root, ['orchestrate', '--action', 'timeline', '--task-id', 'm1', ...slug, '--json']);
  assert.equal(json.status, 0, json.stderr);
  assert.equal(json.stdout.includes(MARKER), false, json.stdout);
  for (const key of ['note', 'detail', 'by', 'consultations', 'traceId', 'runKey']) {
    assert.equal(json.stdout.includes(`"${key}"`), false, `${key} reached the JSON`);
  }
  const text = runCli(root, ['orchestrate', '--action', 'timeline', '--task-id', 'm1', ...slug]);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout.includes(MARKER), false, text.stdout);
  assert.equal(text.stderr, '');
  // Text: a header, then one line per event of closed values only.
  const lines = text.stdout.trimEnd().split('\n');
  assert.equal(lines[0], `Timeline m1 feat-m rev ${JSON.parse(json.stdout).revision}`);
  assert.equal(lines.length, 1 + JSON.parse(json.stdout).events.length);
  for (const line of lines.slice(1)) {
    assert.match(line, /^\S+ (start|complete-stage|skip-stage|skip-gate|decide-gate|annotate|complete-run) \S+ \S+( forced)?( synthetic)?$/);
  }
  assert.match(lines[3], /^\S+ decide-gate gate-0 approve$/);
});

test('IC-012: flat and namespaced runs resolve as status does, and an unknown or ambiguous id exits 1 like status', (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'flat1', '--task-class', 'bug']);
  ok(root, ['--action', 'start', '--task-id', 'T.5', '--task-class', 'bug', '--slug', 'aaa']);
  const same = (args: string[]) => {
    const status = ok(root, ['--action', 'status', ...args]);
    const body = timeline(root, args);
    assert.equal(body.taskId, status.taskId, args.join(' '));
    assert.equal(body.revision, status.revision, args.join(' '));
    return body;
  };
  assert.equal(same(['--task-id', 'flat1']).featureSlug, null);
  assert.equal(same(['--task-id', 'T.5', '--slug', 'aaa']).featureSlug, 'aaa');
  // No --slug: the one namespaced run of the id, as status opens it (FU-wrnnaq).
  assert.equal(same(['--task-id', 'T.5']).featureSlug, 'aaa');

  for (const args of [['--task-id', 'nope'], ['--task-id', 'T.5', '--slug', 'bbb']]) {
    const status = runCli(root, ['orchestrate', '--action', 'status', ...args, '--json']);
    const body = runCli(root, ['orchestrate', '--action', 'timeline', ...args, '--json']);
    assert.equal(status.status, 1, args.join(' '));
    assert.equal(body.status, 1, args.join(' '));
    assert.equal(body.stdout, '');
    assert.match(body.stderr, /\[ERROR\] orchestrate: No workflow run for task/);
  }
  ok(root, ['--action', 'start', '--task-id', 'T.5', '--task-class', 'bug', '--slug', 'bbb']);
  const status = runCli(root, ['orchestrate', '--action', 'status', '--task-id', 'T.5']);
  const body = runCli(root, ['orchestrate', '--action', 'timeline', '--task-id', 'T.5']);
  assert.equal(status.status, 1);
  assert.equal(body.status, 1);
  assert.equal(body.stderr, status.stderr);
  assert.equal(body.stdout, '');
});

test('IC-012: every flag list refuses, except --task-id and --slug, exits 2 before any read', (t) => {
  const root = project(t);
  ok(root, ['--action', 'start', '--task-id', 'flag-run', '--task-class', 'bug']);
  const flags: any = [
    ['--task-class', { taskClass: 'bug' }], ['--gate', { gate: 'g' }],
    ['--decision', { decision: 'approve' }], ['--policy', { policy: 'g' }], ['--forced', { forced: true }],
    ['--note', { note: 'n' }], ['--reason', { reason: 'r' }], ['--stage', { stage: 's' }], ['--node', { node: 'n' }],
    ['--verification-plan', { verificationPlan: 'v' }], ['--scope', { scope: 'x' }], ['--invariants', { invariants: 'i' }],
    ['--result', { result: 'passed' }], ['--mcp-outcome', { mcpOutcome: ['context7=used'] }],
    ['--calling-skill', { callingSkill: 'do-test' }], ['--dry-run', { dryRun: true }],
  ];
  for (const [flag, options] of flags) {
    const result: any = orchestrate(root, { action: 'timeline', taskId: 'flag-run', json: true, ...options });
    assert.equal(result.status, 2, `${flag}: ${result.stderr}`);
    assert.match(result.stderr + result.stdout, new RegExp(`'${flag}' has no effect on action 'timeline'`));
    assert.equal(result.stdout.includes('"events"'), false, `${flag}: timeline printed events before refusing`);
  }
  for (const args of [['--note', 'n'], ['--forced', '--note', 'n'], ['--dry-run'], ['--task-class', 'bug']]) {
    const result = runCli(root, ['orchestrate', '--action', 'timeline', '--task-id', 'flag-run', ...args, '--json']);
    assert.equal(result.status, 2, `${args[0]}: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr + result.stdout, new RegExp(`'${args[0]}' has no effect on action 'timeline'`));
  }
  // --task-id is required, as for status.
  assert.equal(orchestrate(root, { action: 'timeline', json: true }).status, 2);
  assert.equal(orchestrate(root, { action: 'timeline', taskId: 'flag-run', slug: null, json: true }).status, 0);
});

test('IC-012: timeline writes nothing, here or from a linked worktree, under DOFLOW_UPKEEP=off', (t) => {
  const main = project(t);
  const linked = `${main}-linked`;
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'timeline-nosweep', linked, 'HEAD'], { stdio: 'ignore' });
  t.after(() => fs.rmSync(linked, { recursive: true, force: true }));
  ok(main, ['--action', 'start', '--task-id', 'w1', '--task-class', 'bug', '--slug', 'feat-w']);
  ok(main, ['--action', 'complete-stage', '--task-id', 'w1', '--stage', 'reproduction', '--slug', 'feat-w']);
  // A record left in the worktree's own store: a sweep would move it to the main checkout.
  const left = path.join(linked, STORE, 'feat-x', 'w2.json');
  fs.mkdirSync(path.dirname(left), { recursive: true });
  fs.copyFileSync(path.join(main, STORE, 'feat-w', 'w1.json'), left);
  fs.writeFileSync(left, fs.readFileSync(left, 'utf8').replace(/"w1"/g, '"w2"').replace(/"feat-w"/g, '"feat-x"'));

  for (const [cwd, args] of [
    [main, ['--task-id', 'w1', '--slug', 'feat-w']],
    [main, ['--task-id', 'w1']],
    [linked, ['--task-id', 'w1', '--slug', 'feat-w']],
    [linked, ['--task-id', 'w2', '--slug', 'feat-x']],
  ] as Array<[string, string[]]>) {
    for (const json of [['--json'], []]) {
      const before = snapshot([main, linked]);
      const result = runCli(cwd, ['orchestrate', '--action', 'timeline', ...args, ...json]);
      const label = `${cwd === main ? 'main' : 'linked'} ${args.join(' ')} ${json.join('')}`;
      assert.equal(result.status, 0, `${label}: ${result.stdout}${result.stderr}`);
      assert.deepEqual(snapshot([main, linked]), before, `${label} changed a store`);
      assert.equal(result.stdout.includes(main), false, `${label} printed an absolute path`);
    }
  }
  assert.ok(fs.existsSync(left));
  assert.equal(fs.existsSync(path.join(main, STORE, 'feat-x', 'w2.json')), false);
});
