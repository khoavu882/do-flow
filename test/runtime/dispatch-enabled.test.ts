'use strict';

// Feature 120 C.4 (IC-010): dispatch start gates enabled workers before creating anything.
// The dispatch sandbox allocates temporary directories through test/helper/tmp.js and supplies
// scratch HOME, XDG_CONFIG_HOME and PATH. No worker, model or network call. POSIX only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.js');
const store = require('../../src/runtime/dispatch/store.ts');
const { executeDispatchCommand } = require('../../src/runtime/dispatch/command.ts');

const SLUG = '120-dispatch-enabled-fixture';
const POSIX = { skip: process.platform === 'win32' && 'tree cleanup is unverified on win32 (NFR-005)' };
const IDENTITY = ['DOFLOW_RUN_ID', 'DOFLOW_LINEAGE_ID', 'DOFLOW_ATTEMPT', 'DOFLOW_SESSION_ROLE', 'DOFLOW_WORKTREE'];
const SOLO = { DOFLOW_RUN_ID: 'local', DOFLOW_LINEAGE_ID: undefined, DOFLOW_ATTEMPT: undefined, DOFLOW_SESSION_ROLE: 'main' };
const BASE_FALLBACK = { mode: 'ask', ladder: null, exhausted: [], holds: {}, events: [], eventsDropped: 0 };

function git(cwd: any, env: any, args: any[]) {
  const r = spawnSync('git', ['-C', cwd, ...args], { env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function withIdentity(base: any, over: any = {}) {
  const env: any = { ...base };
  for (const key of IDENTITY) {
    if (!Object.hasOwn(over, key)) continue;
    if (over[key] === undefined) delete env[key];
    else env[key] = over[key];
  }
  return env;
}

/** IC-010: a fresh project with an optional user-layer workers.enabled value. */
function project(t: any, userList: any = undefined) {
  const exitCode = process.exitCode;
  t.after(() => { process.exitCode = exitCode; });
  const sb = makeDispatchSandbox(t, { plan: 'dependent', slug: SLUG });
  if (userList !== undefined) {
    const settings = path.join(sb.home, '.config', 'doflow', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, `${JSON.stringify({ schema: 1, 'workers.enabled': userList })}\n`);
  }
  const file = store.storeFileFor(sb.root, SLUG);
  const worktrees = path.join(sb.root, '.doflow', 'state', 'dispatch-worktrees');
  const exec = (options: any, over: any = {}) => executeDispatchCommand({
    slug: SLUG, cwd: sb.root, descriptors: sb.descriptors,
    ...options, env: withIdentity(sb.env, over),
  });
  const startWith = (extra: any = {}, over: any = {}) => exec({
    action: 'start', by: 'main', mode: 'sequential',
    verifyArgv: JSON.stringify(sb.verifyArgv), ...extra,
  }, over);
  const bytes = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null);
  return { sb, file, worktrees, exec, startWith, bytes };
}

function assertNothingCreated(p: any) {
  assert.equal(p.bytes(), null, 'no dispatch store');
  assert.equal(fs.existsSync(p.worktrees), false, 'no integration worktree directory');
  assert.equal(git(p.sb.root, p.sb.env, [
    'for-each-ref', '--format=%(refname)', `refs/heads/doflow/${SLUG}/*`,
  ]), '', 'no dispatch branch');
}

function assertRefused(p: any, result: any, reason: any) {
  assert.equal(result.exit, 1, JSON.stringify(result.body));
  assert.equal(result.body.disposition, 'refused');
  assert.equal(result.body.reason, reason);
  assert.equal(Object.hasOwn(result.body, 'cleanup'), false);
  assert.equal(Object.hasOwn(result.body, 'dispatchRunId'), false);
  assertNothingCreated(p);
}

test('IC-010 control: unset workers.enabled preserves the base fallback with or without --harness', POSIX, async (t) => {
  for (const flags of [{}, { harness: 'claude' }]) {
    const p = project(t);
    assert.equal(fs.existsSync(path.join(p.sb.home, '.config', 'doflow', 'settings.json')), false);
    const r = await p.startWith({ mode: 'auto', ...flags });
    assert.equal(r.exit, 0, JSON.stringify(r.body));
    assert.equal(r.body.disposition, 'started');
    const fallback = store.readDispatch(p.file).run.fallback;
    assert.deepEqual(fallback, BASE_FALLBACK);
    assert.equal(Object.hasOwn(fallback, 'inSession'), false);
  }
});

const STARTS = [
  {
    name: 'stores enabled worker order and primary permission',
    list: ['gemini', 'claude', 'primary'], flags: { mode: 'auto' },
    ladder: ['gemini', 'claude'], inSession: true,
  },
  {
    name: 'allows a flag ladder to reorder enabled workers',
    list: ['gemini', 'claude', 'primary'], flags: { mode: 'auto', ladder: 'claude,gemini' },
    ladder: ['claude', 'gemini'], inSession: true,
  },
  {
    name: 'stores an enabled harness as a one-rung ladder',
    list: ['gemini', 'claude', 'primary'], flags: { mode: 'auto', harness: 'gemini' },
    ladder: ['gemini'], inSession: true,
  },
  {
    name: 'auto starts without primary and stores false',
    list: ['codex'], flags: { mode: 'auto' },
    ladder: ['codex'], inSession: false,
  },
  {
    name: 'manual starts without primary',
    list: ['codex'], flags: { mode: 'manual' },
    ladder: ['codex'], inSession: false,
  },
  {
    name: 'primary alone stores an empty worker ladder',
    list: ['primary'], flags: { mode: 'auto' },
    ladder: [], inSession: true,
  },
  {
    name: 'primary alone allows sequential start',
    list: ['primary'], flags: { mode: 'sequential' },
    ladder: [], inSession: true,
  },
  {
    name: 'auto starts with invalid settings and stores an empty ladder and false',
    list: ['gemini', 'held'], flags: { mode: 'auto' },
    ladder: [], inSession: false,
  },
];

for (const item of STARTS) {
  test(`IC-010: ${item.name}`, POSIX, async (t) => {
    const p = project(t, item.list);
    const r = await p.startWith(item.flags);
    assert.equal(r.exit, 0, JSON.stringify(r.body));
    assert.equal(r.body.disposition, 'started');
    const run = store.readDispatch(p.file).run;
    assert.equal(run.mode, item.flags.mode);
    assert.deepEqual(run.fallback, {
      ...BASE_FALLBACK, ladder: item.ladder, inSession: item.inSession,
    });
  });
}

const REFUSALS = [
  {
    name: 'sequential refuses when primary is absent',
    list: ['codex'], flags: { mode: 'sequential' }, reason: 'no-enabled-worker',
    enabled: ['codex'],
    text: 'no-enabled-worker: primary not enabled, do not run in-session',
  },
  {
    name: 'a disabled harness is refused',
    list: ['gemini', 'primary'], flags: { mode: 'auto', harness: 'claude' },
    reason: 'worker-disabled', harness: 'claude', enabled: ['gemini'],
  },
  {
    name: 'a ladder refuses the first disabled rung',
    list: ['gemini', 'primary'], flags: { mode: 'auto', ladder: 'gemini,claude' },
    reason: 'worker-disabled', harness: 'claude', enabled: ['gemini'],
  },
  {
    name: 'multiple disabled rungs are checked in flag order',
    list: ['gemini', 'primary'], flags: { mode: 'auto', ladder: 'codex,claude' },
    reason: 'worker-disabled', harness: 'codex', enabled: ['gemini'],
  },
  {
    name: 'the harness gate precedes the sequential gate',
    list: ['gemini'], flags: { mode: 'sequential', harness: 'claude' },
    reason: 'worker-disabled', harness: 'claude', enabled: ['gemini'],
  },
  {
    name: 'invalid settings refuse an explicit harness',
    list: ['gemini', 'held'], flags: { mode: 'auto', harness: 'gemini' },
    reason: 'workers-enabled-invalid', harness: 'gemini', enabled: [],
  },
  {
    name: 'invalid settings refuse an explicit ladder',
    list: ['gemini', 'held'], flags: { mode: 'auto', ladder: 'gemini' },
    reason: 'workers-enabled-invalid', harness: 'gemini', enabled: [],
  },
  {
    name: 'invalid settings refuse sequential start',
    list: ['gemini', 'held'], flags: { mode: 'sequential' },
    reason: 'workers-enabled-invalid', enabled: [],
    text: 'workers-enabled-invalid: workers.enabled is invalid, do not run in-session',
  },
];

for (const item of REFUSALS) {
  test(`IC-010: ${item.name} before creating anything`, POSIX, async (t) => {
    const p = project(t, item.list);
    const r = await p.startWith(item.flags);
    assertRefused(p, r, item.reason);
    assert.deepEqual(r.body.enabled, item.enabled);
    assert.equal(r.body.origin.layer, 'user');
    assert.equal(r.body.origin.source, path.join(p.sb.home, '.config', 'doflow', 'settings.json'));
    if (item.harness !== undefined) assert.equal(r.body.harness, item.harness);
    if (item.text !== undefined) assert.equal(r.body.text, item.text);
  });
}

test('IC-010: unknown harness and ladder ids remain exit 2 usage with a list set', POSIX, async (t) => {
  const p = project(t, ['gemini', 'primary']);
  for (const flags of [{ harness: 'not-a-harness' }, { ladder: 'not-a-harness' }]) {
    const r = await p.startWith({ mode: 'auto', ...flags });
    assert.equal(r.exit, 2, JSON.stringify(r.body));
    assert.equal(r.body.ok, false);
    assert.equal(r.body.error, 'usage');
    assertNothingCreated(p);
  }
});

test('IC-010: identity refusals precede the enabled-worker gate', POSIX, async (t) => {
  const p = project(t, ['gemini']);
  for (const [over, reason] of [
    [SOLO, 'identity-solo'],
    [{ DOFLOW_SESSION_ROLE: 'worker' }, 'worker-session'],
  ]) {
    const r = await p.startWith({ mode: 'auto', harness: 'claude' }, over);
    assertRefused(p, r, reason);
  }
});
