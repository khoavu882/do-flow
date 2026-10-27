'use strict';

// Row 093 V.6 (IC-022): `doflow transcript --action read` resolves one agent from the tree's node set, opens its
// transcript through the V.4 readers, and adds DoFlow's own `record` events for every agent, with no write.
// Scratch HOME and config home hold V.2's synthetic fixtures (their cwd rewritten to the scratch project), real
// git repositories, hand-written hook observations and run stores. The module tests inject `alive`; the process
// tests run the shipped verb.

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
const { readAgent } = require('../../src/runtime/transcripts/read.ts');
const { handleTranscriptCommand } = require('../../src/runtime/transcripts/command.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SOURCE = fs.readFileSync(path.join(REPO, 'src/cli/runtime-commands.ts'), 'utf8');
const ID = 'fa000000-0000-4000-8000-00000000';
const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const AK = (harness: string, ...rest: string[]) => sha16([harness, ...rest].join(':'));
const FORBIDDEN = [
  'fx-Secret-4471', 'fixture.person@example.invalid', 'FIXTURE-THINKING-MARKER-7f3a', 'FIXTURE-USER-PROMPT-MARKER-91c2',
  'fixture.attach@example.invalid', 'fixture-unknown-record-type', '/work/fixture-project', '/work/other-project', 'FIXTURE-TOOL-RESULT-TEXT-5e1d',
  'FIXTURE-OTHER-PROJECT-REPLY-2b8d', 'fa000000', 'fixture-missing-keys-record',
];
const EVENT_KEYS = ['seq', 'at', 'kind', 'agentKey', 'model', 'tool', 'text', 'args', 'cut', 'tokens', 'record'];
const BODY_KEYS = ['v', 'agentKey', 'harness', 'reader', 'transcript', 'events', 'cursor', 'reset', 'eof', 'otherRecords', 'unparsable', 'masked', 'warnings'];

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

/** A session as the hooks leave it: a model observation at the checkout and a session directory with its git context. */
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

/** Text files under `dir` with the fixture cwd replaced by the scratch project, so the checkout filter can match. */
function retarget(dir: string, from: string, to: string) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) retarget(full, from, to);
    else if (!e.name.startsWith('opencode.db')) fs.writeFileSync(full, fs.readFileSync(full, 'utf8').split(from).join(to));
  }
}

function world(t: any) {
  clearCheckoutCache();
  const root = tempDir(t, 'doflow-transcript-read-');
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj'), other: path.join(root, 'other') };
  f.store = path.join(f.config, 'doflow', 'session-env');
  fs.mkdirSync(f.home);
  fs.mkdirSync(f.store, { recursive: true });
  repo(f.main);
  repo(f.other);
  const real = fs.realpathSync(f.main);
  for (const [harness, parts] of Object.entries(LOCATION_ROOTS) as Array<[string, string[]]>) {
    const target = path.join(f.home, ...parts);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.cpSync(path.join(V8_ROOT, harness), target, { recursive: true });
    retarget(target, '/work/fixture-project', real);
  }
  const piRoot = path.join(f.home, ...LOCATION_ROOTS.pi);
  fs.renameSync(path.join(piRoot, '--work-fixture-project--'), path.join(piRoot, `--${real.replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`));
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
const read = (f: any, agent: string, opts: any = {}) => {
  clearCheckoutCache();
  return readAgent({ env: env(f), cwd: f.main, agent, alive: unknown, ...opts });
};
const ok = (f: any, agent: string, opts: any = {}) => {
  const r = read(f, agent, opts);
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.body;
};
const cli = (f: any, args: string[]) => spawnSync(process.execPath, [CLI, 'transcript', ...args], { cwd: f.main, env: env(f), encoding: 'utf8' });
const kinds = (body: any) => body.events.map((e: any) => e.kind);

const EXPECT: Record<string, string[]> = {
  claude: ['usage', 'reply', 'tool-call', 'usage', 'tool-result', 'reply', 'usage'],
  codex: ['model-change', 'reply', 'tool-call', 'tool-result', 'usage', 'reply'],
  kiro: ['reply', 'tool-call', 'tool-result', 'reply', 'usage'],
  copilot: ['reply', 'tool-call', 'tool-result', 'subagent-start', 'usage', 'usage', 'reply'],
  pi: ['model-change', 'reply', 'tool-call', 'usage', 'tool-result', 'reply'],
};
const MAIN_ID: Record<string, string> = { claude: 'c001', codex: 'd001', kiro: 'e001', copilot: 'f001', pi: 'a001' };

for (const harness of Object.keys(EXPECT)) {
  test(`${harness}: the exact field set, the reader's events then the agent's record events, masked`, (t) => {
    const f = world(t);
    scenario(f);
    const body = ok(f, AK(harness, `${ID}${MAIN_ID[harness]}`));
    assert.deepEqual(Object.keys(body), BODY_KEYS);
    assert.deepEqual([body.v, body.harness, body.reader, body.transcript], [1, harness, { id: { claude: 'claude-jsonl', codex: 'codex-rollout', kiro: 'kiro-jsonl', copilot: 'copilot-events', pi: 'pi-jsonl' }[harness], status: 'supported' }, { linked: true, reason: null }]);
    assert.deepEqual(kinds(body), [...EXPECT[harness], 'record', 'record']);
    body.events.forEach((e: any, i: number) => {
      assert.deepEqual(Object.keys(e), EVENT_KEYS);
      assert.equal(e.seq, i, 'one running sequence across the reader events and the record events');
      assert.equal(e.agentKey, body.agentKey);
    });
    const records = body.events.filter((e: any) => e.kind === 'record');
    for (const r of records) {
      assert.deepEqual(r.record, { type: 'hook-record', task: null, result: null });
      assert.deepEqual([r.tool, r.text, r.args, r.cut, r.tokens], [null, null, null, false, null]);
      assert.match(r.at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    }
    const reply = body.events.find((e: any) => e.kind === 'reply');
    assert.match(reply.text, /password=<masked> and mail <email>/);
    assert.match(body.cursor, /^[0-9]+:[0-9]+:[0-9]+:[0-9]+$/);
    assert.equal(body.eof, true);
    const json = JSON.stringify(body);
    for (const needle of FORBIDDEN) assert.ok(!json.includes(needle), `${harness} output holds ${needle}`);
    assert.ok(!json.includes(f.root));
  });
}

test('OpenCode, Antigravity and a missing file give exit-0 bodies of record events with their reasons', (t) => {
  const f = world(t);
  scenario(f);
  const cases: Array<[string, string, any, string]> = [
    ['antigravity', 'b001', { id: null, status: 'events-only' }, 'not-linked'],
    ['opencode', '0c00', { id: null, status: 'events-only' }, 'no-reader'],
    ['claude', 'c0aa', { id: 'claude-jsonl', status: 'supported' }, 'not-found'],
  ];
  for (const [harness, id, reader, reason] of cases) {
    const body = ok(f, AK(harness, `${ID}${id}`));
    assert.deepEqual(Object.keys(body), BODY_KEYS);
    assert.deepEqual([body.reader, body.transcript], [reader, { linked: false, reason }], harness);
    assert.deepEqual(kinds(body), ['record', 'record'], harness);
    assert.deepEqual([body.otherRecords, body.unparsable, body.masked, body.warnings, body.reset, body.eof], [0, 0, 0, [], false, true]);
  }
  const r = cli(f, ['--action', 'read', '--agent', AK('antigravity', `${ID}b001`), '--json']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).transcript.reason, 'not-linked');
});

test('a key outside the node set is agent-not-in-project, exit 1', (t) => {
  const f = world(t);
  scenario(f);
  session(f, 'claude', `${ID}c0f2`, f.other); // the second project's session
  assert.deepEqual(read(f, AK('claude', `${ID}c0f2`)), { ok: false, error: 'agent-not-in-project' });
  assert.deepEqual(read(f, '0123456789abcdef'), { ok: false, error: 'agent-not-in-project' });
  const r = cli(f, ['--action', 'read', '--agent', AK('claude', `${ID}c0f2`), '--json']);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout), { v: 1, error: 'agent-not-in-project' });
  const text = cli(f, ['--action', 'read', '--agent', '0123456789abcdef']);
  assert.equal(text.status, 1);
  assert.ok(!(text.stdout + text.stderr).includes(f.root));
});

test('a transcript whose cwd is in a second project is session-not-in-project, exit 1', (t) => {
  const f = world(t);
  session(f, 'claude', `${ID}c0f2`, f.main); // the hook says this project; the transcript file says /work/other-project
  assert.deepEqual(read(f, AK('claude', `${ID}c0f2`)), { ok: false, error: 'session-not-in-project' });
  const r = cli(f, ['--action', 'read', '--agent', AK('claude', `${ID}c0f2`), '--json']);
  assert.equal(r.status, 1);
  assert.deepEqual(JSON.parse(r.stdout), { v: 1, error: 'session-not-in-project' });
  assert.ok(!r.stdout.includes('FIXTURE-OTHER-PROJECT-REPLY-2b8d') && !r.stdout.includes('other-project'));
});

function runs(f: any, endAt = '2026-01-01T00:05:00.000Z') {
  writeStore(f, 'worker-runs', 'feat', {
    slug: 'feat', runs: {
      'w-aaaaaaaaaaaa': { runId: 'w-aaaaaaaaaaaa', task: 'A.1', token: 1, seq: 1, harness: 'codex', phase: 'ended', startedAt: '2026-01-01T00:00:00.000Z', caller: { runKey: 'wk1/run1/lin1', run: 'run1', lineage: 'lin1' }, binding: { model: 'gpt-fixture-1' }, end: { state: 'exited', at: endAt }, childOf: null },
    },
  });
  writeStore(f, 'task-attempts', 'feat', {
    slug: 'feat', tasks: { 'A.1': { attempts: [{ token: 1, owner: 'fixture-owner', mode: 'sequential', state: 'finished', result: 'COMPLETED', startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:04:00.000Z', runKey: 'wk1/run1/lin1' }] } },
  });
}

test('worker runs and attempts give their own record events, with the task and the result', (t) => {
  const f = world(t);
  runs(f);
  const worker = ok(f, sha16('worker:w-aaaaaaaaaaaa'));
  assert.deepEqual([worker.harness, worker.reader, worker.transcript], ['codex', { id: 'codex-rollout', status: 'supported' }, { linked: false, reason: 'not-found' }]);
  assert.deepEqual(worker.events.map((e: any) => [e.at, e.kind, e.record]), [
    ['2026-01-01T00:00:00.000Z', 'record', { type: 'worker-run-start', task: 'A.1', result: null }],
    ['2026-01-01T00:05:00.000Z', 'record', { type: 'worker-run-end', task: 'A.1', result: 'exited' }],
  ]);
  const run = ok(f, sha16('doflow:wk1/run1/lin1'));
  assert.deepEqual([run.harness, run.reader, run.transcript], [null, { id: null, status: 'events-only' }, { linked: false, reason: 'no-reader' }]);
  assert.deepEqual(run.events.map((e: any) => [e.at, e.record]), [
    ['2026-01-01T00:00:01.000Z', { type: 'attempt-claim', task: 'A.1', result: null }],
    ['2026-01-01T00:04:00.000Z', { type: 'attempt-end', task: 'A.1', result: 'COMPLETED' }],
  ]);
  assert.ok(!JSON.stringify([worker, run]).includes('wk1/run1') && !JSON.stringify(worker).includes('w-aaaa'));
});

test('with a cursor only newer record events come back, and an unlinked agent keeps a four-part cursor', (t) => {
  const f = world(t);
  scenario(f);
  runs(f);
  const key = sha16('doflow:wk1/run1/lin1');
  const first = ok(f, key);
  assert.equal(first.events.length, 2);
  assert.match(first.cursor, /^0:0:2:\d+$/);
  const again = ok(f, key, { cursor: first.cursor });
  assert.deepEqual([again.events.length, again.reset, again.cursor], [0, false, first.cursor], 'nothing newer than the cursor');
  writeStore(f, 'task-attempts', 'feat', {
    slug: 'feat', tasks: { 'A.1': { attempts: [
      { token: 1, owner: 'fixture-owner', mode: 'sequential', state: 'finished', result: 'COMPLETED', startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:04:00.000Z', runKey: 'wk1/run1/lin1' },
      { token: 2, owner: 'fixture-owner', mode: 'sequential', state: 'released', startedAt: '2026-01-01T00:06:00.000Z', endedAt: '2026-01-01T00:07:00.000Z', runKey: 'wk1/run1/lin1' },
    ] } },
  });
  const next = ok(f, key, { cursor: first.cursor });
  assert.deepEqual(next.events.map((e: any) => [e.seq, e.record.type, e.record.task, e.record.result]), [[2, 'attempt-claim', 'A.1', null], [3, 'attempt-end', 'A.1', null]]);
  assert.match(next.cursor, /^0:0:4:\d+$/);
  // A linked agent: the main session's hook records are not repeated past the cursor either.
  const claude = AK('claude', `${ID}c001`);
  const a = ok(f, claude);
  const b = ok(f, claude, { cursor: a.cursor });
  assert.deepEqual([b.events.length, b.reset, b.eof], [0, false, true]);
});

test('a transcript cursor survives an append and resets on truncation', (t) => {
  const f = world(t);
  scenario(f);
  const key = AK('claude', `${ID}c001`);
  const file = path.join(f.home, ...LOCATION_ROOTS.claude, '-work-fixture-project', `${ID}c001.jsonl`);
  const first = ok(f, key);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  const last = JSON.parse(lines[lines.length - 1]);
  last.timestamp = '2026-01-01T00:00:20.000Z';
  last.uuid = 'cmain-a9';
  last.message.id = 'msg_cmain_9';
  last.message.content = [{ type: 'text', text: 'FIXTURE-REPLY-APPENDED cmain' }];
  fs.appendFileSync(file, `${JSON.stringify(last)}\n`);
  const next = ok(f, key, { cursor: first.cursor });
  assert.equal(next.reset, false);
  assert.deepEqual(kinds(next).filter((k: string) => k !== 'record' && k !== 'usage'), ['reply']);
  assert.match(next.events.find((e: any) => e.kind === 'reply').text, /FIXTURE-REPLY-APPENDED/);
  fs.writeFileSync(file, `${lines.slice(0, 3).join('\n')}\n`);
  const cut = ok(f, key, { cursor: next.cursor });
  assert.equal(cut.reset, true);
  assert.ok(cut.events.length > 0);
});

test('the limit applies to the reader events', (t) => {
  const f = world(t);
  scenario(f);
  const body = ok(f, AK('claude', `${ID}c001`), { limit: 3 });
  const fromReader = body.events.filter((e: any) => e.kind !== 'record').length;
  assert.ok(fromReader > 0 && fromReader <= 3, `a record that would pass the limit is left for the next read (got ${fromReader})`);
  assert.equal(body.eof, false);
});

test('usage errors exit 2, and a limit past 500 is capped, not refused', (t) => {
  const f = world(t);
  scenario(f);
  const key = AK('claude', `${ID}c001`);
  const cases = [
    [], ['--action', 'bogus'], ['--action', 'read'], ['--action', 'read', '--agent', 'not-hex'], ['--action', 'read', '--agent', key, '--cursor', '1:2:3'],
    ['--action', 'read', '--agent', key, '--limit', 'ten'], ['--action', 'read', '--agent', key, '--limit', '0'], ['--action', 'read', '--agent', key, '--bogus'],
    ['--action', 'read', '--agent', key, '--window', '5'], ['--action', 'read', '--agent'], ['--action'],
  ];
  for (const argv of cases) {
    const r = cli(f, argv);
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stderr}${r.stdout}`);
  }
  const capped = cli(f, ['--action', 'read', '--agent', key, '--limit', '9999', '--json']);
  assert.equal(capped.status, 0, capped.stderr);
  const text = cli(f, ['--action', 'read', '--agent', key]);
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.includes('reply') && !text.stdout.includes(f.root));
  for (const needle of FORBIDDEN) assert.ok(!text.stdout.includes(needle) && !capped.stdout.includes(needle), needle);
});

test('handleTranscriptCommand: usage, the text form and a refusal through the module', (t) => {
  const f = world(t);
  scenario(f);
  const saved = process.exitCode; // the handler sets it, as the CLI relies on; restored so this file's own exit stays clean
  t.after(() => { process.exitCode = saved; });
  const lines: string[] = [];
  const out = (l: string) => lines.push(l);
  assert.equal(handleTranscriptCommand({ action: 'read', agent: AK('codex', `${ID}d001`), json: false, flags: ['--action', '--agent'], env: env(f), cwd: f.main, alive: unknown, out }), 0);
  assert.ok(lines.length > 5 && lines.every((l) => !l.includes(f.root)));
  lines.length = 0;
  assert.equal(handleTranscriptCommand({ action: 'read', agent: AK('codex', `${ID}d001`), json: false, flags: ['--stuff'], env: env(f), cwd: f.main, out }), 2);
  assert.equal(handleTranscriptCommand({ action: 'read', agent: '0123456789abcdef', json: true, flags: [], env: env(f), cwd: f.main, alive: unknown, out }), 1);
  assert.deepEqual(JSON.parse(lines[lines.length - 1]), { v: 1, error: 'agent-not-in-project' });
});

test('NO_UPKEEP holds transcript (IC-022, NFR-003)', () => {
  const set = SOURCE.match(/const NO_UPKEEP = new Set\(\[([^\]]*)\]\)/);
  assert.ok(set, 'NO_UPKEEP is declared as a literal set');
  assert.ok(set[1].split(',').map((v: string) => v.trim().replace(/'/g, '')).includes('transcript'));
});

test('a read with upkeep due leaves project, user state, config home and every harness home byte-identical', (t) => {
  const f = world(t);
  scenario(f);
  runs(f);
  for (const dir of [path.join(f.main, '.doflow', 'state'), path.join(f.home, '.doflow', 'state')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'upkeep-due'), '1\n');
  }
  const before = snapshot(f.root);
  for (const agent of [AK('claude', `${ID}c001`), AK('kiro', `${ID}e001`), AK('antigravity', `${ID}b001`), sha16('doflow:wk1/run1/lin1')]) {
    for (const extra of [['--json'], []]) {
      const r = cli(f, ['--action', 'read', '--agent', agent, ...extra]);
      assert.equal(r.status, 0, r.stderr);
    }
  }
  assert.deepEqual(snapshot(f.root), before);
});
