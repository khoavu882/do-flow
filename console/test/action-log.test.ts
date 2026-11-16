'use strict';

// The action log store (feature 162, D10, IC-008). Everything under a scratch folder with an injected clock;
// "another Console process" is a real child started with the running Node. Nothing reads the real config home.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createActionLog, openActionLog, ActionLogError, ACTION_LOG_BYTES, LINE_MAX_BYTES } = require('../src/action-log.ts');

const MODULE = path.resolve(__dirname, '../src/action-log.ts');
const made: string[] = [];
const children: any[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-action-log-'));
  made.push(dir);
  return dir;
};
afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function clock(start = Date.UTC(2026, 10, 15, 10, 0, 30)) {
  let t = start;
  return { now: () => t, advance: (by: number) => { t += by; } };
}
const open = (dir: string, extra: any = {}) => createActionLog({ dir: path.join(dir, 'console'), lockWaitMs: 200, ...extra });
const linesOf = (file: string): any[] => fs.readFileSync(file, 'utf8').split('\n').filter((l: string) => l !== '').map((l: string) => JSON.parse(l));
const modeOf = (p: string) => fs.statSync(p).mode & 0o777;
const refused = async (promise: Promise<unknown>, reason: string) => {
  await assert.rejects(promise, (error: any) => error instanceof ActionLogError && error.code === 'action-log-unwritable' && error.reason === reason);
};

test('ACTION_LOG_BYTES is the literal the registry matches', () => {
  assert.equal(ACTION_LOG_BYTES, 1048576);
  assert.match(fs.readFileSync(MODULE, 'utf8'), /ACTION_LOG_BYTES = 1048576;/);
});

test('one append writes one whole line: the closed fields, the file 0600, the folder set to 0700', async () => {
  const root = scratch();
  const folder = path.join(root, 'console');
  fs.mkdirSync(folder, { mode: 0o755 });
  fs.chmodSync(folder, 0o755);
  const log = open(root, { now: clock().now, pid: 4242 });
  const first = await log.begin({ id: 'req-1', actor: { kind: 'device', deviceId: 'd-0123456789ab', scope: 'control', transport: 'native' }, address: '192.168.1.20', action: 'decide-gate', project: 'p1234567890abcdef', target: { taskId: 'T1', gateId: 'gate-a' }, expect: { revision: 7 }, input: { decision: 'approve', textChars: 0 } });
  await log.end({ id: 'req-1', outcome: 'applied', current: { state: 'RUNNING', revision: 8 }, exit: 0, ms: 412 });
  assert.equal(first.pid, 4242);
  assert.equal(modeOf(path.join(folder, 'actions.ndjson')), 0o600);
  assert.equal(modeOf(folder), 0o700);
  const lines = linesOf(path.join(folder, 'actions.ndjson'));
  assert.equal(lines.length, 2);
  assert.deepEqual(Object.keys(lines[0]), ['v', 'at', 'pid', 'seq', 'phase', 'id', 'actor', 'address', 'action', 'project', 'target', 'expect', 'input', 'outcome', 'code', 'current', 'exit', 'ms', 'count']);
  assert.deepEqual(lines[0].actor, { kind: 'device', deviceId: 'd-0123456789ab', scope: 'control', transport: 'native' });
  assert.deepEqual(lines[0].target, { slug: null, taskId: 'T1', gateId: 'gate-a', runId: null, worktreeKey: null, harness: null, model: null });
  assert.equal(lines[0].phase, 'begin');
  assert.equal(lines[0].at, '2026-11-15T10:00:30.000Z');
  assert.equal(lines[0].pid, 4242);
  assert.equal(lines[1].phase, 'end');
  assert.equal(lines[1].seq, lines[0].seq + 1);
  assert.equal(lines[1].exit, 0);
  assert.equal(lines[1].actor.kind, 'unknown');
});

test('a hostile string never shapes a line: newlines, quotes and free text become null, an unknown enum is refused', async () => {
  const root = scratch();
  const log = open(root);
  await log.end({ id: 'x"}\n{"phase":"end"', action: 'a b', address: 'evil\nhost', target: { slug: '../../etc', gateId: 'ok' }, code: 'stale\r\n', outcome: 'refused' });
  const text = fs.readFileSync(path.join(root, 'console', 'actions.ndjson'), 'utf8');
  assert.equal(text.split('\n').length, 2);
  const [line] = linesOf(path.join(root, 'console', 'actions.ndjson'));
  assert.equal(line.id, null);
  assert.equal(line.action, null);
  assert.equal(line.address, null);
  assert.equal(line.target.slug, null);
  assert.equal(line.target.gateId, 'ok');
  assert.equal(line.code, null);
  await refused(log.end({ outcome: 'exploded' }), 'invalid-field');
  await refused(log.end({ actor: { transport: 'carrier-pigeon' } }), 'invalid-field');
  assert.equal(linesOf(path.join(root, 'console', 'actions.ndjson')).length, 1);
});

test('a line over 2 KiB throws and nothing is written; 2 KiB exactly is accepted', async () => {
  const root = scratch();
  const log = open(root);
  await refused(log.writeLine('x'.repeat(LINE_MAX_BYTES)), 'line-too-long');
  assert.equal(fs.existsSync(path.join(root, 'console', 'actions.ndjson')), false);
  await log.writeLine('x'.repeat(LINE_MAX_BYTES - 1));
  assert.equal(fs.statSync(path.join(root, 'console', 'actions.ndjson')).size, LINE_MAX_BYTES);
  // the lines the module builds stay far below the cap, even with every token at its longest
  const long = 'a'.repeat(80);
  await log.begin({ id: long, action: long, project: long, actor: { deviceId: long }, target: { slug: long, taskId: long, gateId: long, runId: long }, input: { decision: long }, code: long, current: { state: long } });
});

test('at ACTION_LOG_BYTES the log is renamed over the older generation and the append starts a new file; one byte less does not rotate', async () => {
  const root = scratch();
  const folder = path.join(root, 'console');
  const log = open(root);
  await log.begin({ id: 'seed' });
  const file = path.join(folder, 'actions.ndjson');
  const older = path.join(folder, 'actions.1.ndjson');
  fs.writeFileSync(older, 'previous generation\n');
  fs.truncateSync(file, ACTION_LOG_BYTES - 1);
  await log.begin({ id: 'below' });
  assert.equal(fs.existsSync(older) && fs.readFileSync(older, 'utf8') === 'previous generation\n', true, 'one byte under the bound does not rotate');
  assert.ok(fs.statSync(file).size > ACTION_LOG_BYTES);
  await log.begin({ id: 'at' });
  assert.equal(fs.statSync(older).size > ACTION_LOG_BYTES, true, 'the full generation became the older one');
  const fresh = linesOf(file);
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].id, 'at');
  assert.equal(modeOf(file), 0o600);
  assert.equal(fs.existsSync(path.join(folder, 'actions.lock')), false, 'the lock is released');
});

test('a lock older than 10 s is removed and the rotation goes on; a younger lock held past the wait refuses the append', async () => {
  const root = scratch();
  const folder = path.join(root, 'console');
  const log = open(root);
  await log.begin({ id: 'seed' });
  const file = path.join(folder, 'actions.ndjson');
  const lock = path.join(folder, 'actions.lock');
  fs.truncateSync(file, ACTION_LOG_BYTES);
  fs.writeFileSync(lock, '');
  await refused(log.begin({ id: 'blocked' }), 'lock-busy');
  assert.equal(fs.statSync(file).size, ACTION_LOG_BYTES, 'nothing was written');
  const old = new Date(Date.now() - 20_000);
  fs.utimesSync(lock, old, old);
  await log.begin({ id: 'after' });
  assert.equal(linesOf(file).length, 1);
  assert.equal(fs.statSync(path.join(folder, 'actions.1.ndjson')).size, ACTION_LOG_BYTES);
  assert.equal(fs.existsSync(lock), false);
});

test('a symlinked actions.ndjson is refused, nothing is written through it, and a directory or an FIFO under the name is refused too', async () => {
  const root = scratch();
  const folder = path.join(root, 'console');
  const log = open(root);
  await log.begin({ id: 'seed' });
  const file = path.join(folder, 'actions.ndjson');
  const target = path.join(root, 'victim.txt');
  fs.writeFileSync(target, 'victim\n');
  fs.rmSync(file);
  fs.symlinkSync(target, file);
  await refused(log.begin({ id: 'nope' }), 'not-regular');
  assert.equal(fs.readFileSync(target, 'utf8'), 'victim\n');
  fs.rmSync(file);
  fs.mkdirSync(file);
  await refused(log.begin({ id: 'nope' }), 'not-regular');
  assert.deepEqual(fs.readdirSync(file), []);
  fs.rmdirSync(file);
  cp.execFileSync('mkfifo', [file]);
  await refused(log.begin({ id: 'nope' }), 'not-regular');
});

test('a folder that is not a directory refuses the append', async () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, 'console'), 'in the way');
  await refused(open(root).begin({ id: 'nope' }), 'folder');
});

test('summary writes one line per key per minute with the count, once the minute has passed', async () => {
  const root = scratch();
  const file = path.join(root, 'console', 'actions.ndjson');
  const c = clock(Date.UTC(2026, 10, 15, 10, 0, 5));
  const log = open(root, { now: c.now });
  const device = { actor: { kind: 'device', deviceId: 'd-0123456789ab', scope: 'control', transport: 'native' } };
  await log.summary('unauthenticated', '10.0.0.9', { address: '10.0.0.9' });
  await log.summary('unauthenticated', '10.0.0.9', { address: '10.0.0.9' });
  await log.summary('unauthenticated', '10.0.0.8', { address: '10.0.0.8' });
  await log.summary('rate-limited', 'd-0123456789ab', device);
  c.advance(20_000);
  await log.summary('unauthenticated', '10.0.0.9', { address: '10.0.0.9' });
  assert.equal(fs.existsSync(file), false, 'the minute has not passed: nothing is written yet');
  c.advance(60_000);
  await log.summary('rate-limited', 'd-0123456789ab', device);
  const lines = linesOf(file);
  assert.equal(lines.length, 3);
  assert.ok(lines.every((l: any) => l.phase === 'summary' && l.at === '2026-11-15T10:00:00.000Z'));
  const by = (code: string, key: string) => lines.find((l: any) => l.code === code && (l.address === key || l.actor.deviceId === key));
  assert.equal(by('unauthenticated', '10.0.0.9').count, 3);
  assert.equal(by('unauthenticated', '10.0.0.8').count, 1);
  assert.equal(by('rate-limited', 'd-0123456789ab').count, 1);
  assert.equal(lines.filter((l: any) => l.code === 'rate-limited').length, 1);
  await log.flush(true);
  const all = linesOf(file);
  assert.equal(all.length, 4);
  assert.equal(all[3].count, 1);
  assert.equal(all[3].at, '2026-11-15T10:01:00.000Z');
  assert.equal(all[3].code, 'rate-limited');
  await log.flush(true);
  assert.equal(linesOf(file).length, 4, 'a written bucket is not written again');
});

test('162 finding: the refusals before an actor exists are summary codes of actor kind none, one line per reason per minute whoever sent them', async () => {
  const root = scratch();
  const file = path.join(root, 'console', 'actions.ndjson');
  const c = clock(Date.UTC(2026, 10, 15, 10, 0, 5));
  const log = open(root, { now: c.now });
  for (let i = 0; i < 500; i += 1) {
    await log.summary('forbidden-origin', 'none', { actor: { kind: 'none' } });
    await log.summary('unsupported-media', 'none', { actor: { kind: 'none' } });
  }
  c.advance(60_000);
  await log.flush(false);
  const lines = linesOf(file);
  assert.deepEqual(lines.map((l: any) => [l.phase, l.code, l.count, l.actor, l.address, l.outcome]), [
    ['summary', 'forbidden-origin', 500, { kind: 'none', deviceId: null, scope: null, transport: null }, null, 'refused'],
    ['summary', 'unsupported-media', 500, { kind: 'none', deviceId: null, scope: null, transport: null }, null, 'refused'],
  ]);
  assert.ok(lines.every((l: any) => JSON.stringify(l).length < 2048));
  await assert.rejects(log.append('begin', { actor: { kind: 'nobody' } }), { reason: 'invalid-field' });
});

test('summary buckets are bounded: keys past the cap count under one overflow bucket', async () => {
  const root = scratch();
  const file = path.join(root, 'console', 'actions.ndjson');
  const log = open(root, { now: clock().now });
  for (let i = 0; i < 600; i += 1) await log.summary('unauthenticated', `10.0.${Math.floor(i / 250)}.${i % 250}`, { address: `10.0.${Math.floor(i / 250)}.${i % 250}` });
  await log.flush(true);
  const lines = linesOf(file);
  assert.equal(lines.length, 513);
  assert.equal(lines.reduce((sum: number, l: any) => sum + l.count, 0), 600);
});

test('162 review A-2: the two refusals before an actor exist keep their own bucket past the cap, and expired buckets leave before a new one is chosen', async () => {
  const root = scratch();
  const file = path.join(root, 'console', 'actions.ndjson');
  const c = clock(Date.UTC(2026, 10, 15, 10, 0, 5));
  const log = open(root, { now: c.now });
  for (let i = 0; i < 512; i += 1) await log.summary('unauthenticated', `10.1.${Math.floor(i / 250)}.${i % 250}`, { address: `10.1.${Math.floor(i / 250)}.${i % 250}` });
  // The cap is full in this minute: the pre-actor reasons still count under their own bucket, actor none.
  await log.summary('forbidden-origin', 'none', { actor: { kind: 'none' } });
  await log.summary('unsupported-media', 'none', { actor: { kind: 'none' } });
  // The next minute, before any flush: the 514 expired buckets are written first, then the new one is chosen.
  c.advance(60_000);
  await log.summary('forbidden-origin', 'none', { actor: { kind: 'none' } });
  await log.summary('forbidden-origin', 'none', { actor: { kind: 'none' } });
  await log.flush(true);
  const lines = linesOf(file);
  const early = (code: string) => lines.filter((l: any) => l.code === code).map((l: any) => [l.at, l.count, l.actor.kind]);
  assert.deepEqual(early('forbidden-origin'), [['2026-11-15T10:00:00.000Z', 1, 'none'], ['2026-11-15T10:01:00.000Z', 2, 'none']]);
  assert.deepEqual(early('unsupported-media'), [['2026-11-15T10:00:00.000Z', 1, 'none']]);
  assert.equal(lines.filter((l: any) => l.code === 'unauthenticated').length, 512);
  // A caller cannot widen or rename a reserved bucket: any key or base counts on the one actor-none line.
  await log.summary('unsupported-media', '10.0.0.9', { address: '10.0.0.9', actor: { kind: 'local' } });
  await log.flush(true);
  assert.deepEqual(linesOf(file).slice(-1).map((l: any) => [l.code, l.count, l.actor.kind, l.address]), [['unsupported-media', 1, 'none', null]]);
});

test('two child processes appending 200 lines each leave 400 whole JSON lines', async (t: any) => {
  const root = scratch();
  const folder = path.join(root, 'console');
  const script = `
    const { createActionLog } = require(process.argv[1]);
    const log = createActionLog({ dir: process.argv[2] });
    (async () => { for (let i = 0; i < 200; i += 1) await log.begin({ id: process.argv[3] + '-' + i, action: 'decide-gate' }); })()
      .catch((error) => { process.stderr.write(String(error && error.message)); process.exit(1); });
  `;
  const run = (tag: string) => new Promise<{ code: number | null, stderr: string }>((resolve, reject) => {
    const child = cp.spawn(process.execPath, ['-e', script, MODULE, folder, tag], { stdio: ['ignore', 'ignore', 'pipe'] });
    children.push(child);
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code: number | null) => resolve({ code, stderr }));
  });
  t.after(() => { for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const results = await Promise.all([run('a'), run('b')]);
  assert.deepEqual(results, [{ code: 0, stderr: '' }, { code: 0, stderr: '' }]);
  const lines = linesOf(path.join(folder, 'actions.ndjson'));
  assert.equal(lines.length, 400);
  assert.equal(lines.filter((l: any) => l.id.startsWith('a-')).length, 200);
  assert.equal(lines.filter((l: any) => l.id.startsWith('b-')).length, 200);
  assert.equal(new Set(lines.map((l: any) => `${l.pid}:${l.seq}`)).size, 400);
});

test('openActionLog follows the core config-home rule and returns null without a config home', async () => {
  const root = scratch();
  const xdg = path.join(root, 'xdg');
  const log = openActionLog({ XDG_CONFIG_HOME: xdg, HOME: path.join(root, 'home') });
  await log.begin({ id: 'viaxdg' });
  assert.equal(linesOf(path.join(xdg, 'doflow', 'console', 'actions.ndjson'))[0].id, 'viaxdg');
  const viaHome = openActionLog({ HOME: path.join(root, 'home') });
  await viaHome.begin({ id: 'viahome' });
  assert.equal(linesOf(path.join(root, 'home', '.config', 'doflow', 'console', 'actions.ndjson'))[0].id, 'viahome');
  assert.equal(openActionLog({ HOME: 'relative' }), null);
});

test('162 review 9: every target id the action routes accept (up to ID_MAX characters) is recorded, and a line with every field at its bound fits 2 KiB', async () => {
  const { ID_MAX } = require('../src/verb-runner.ts');
  assert.equal(ID_MAX, 128);
  const root = scratch();
  const log = open(root);
  const at = (c: string) => `a${c.repeat(ID_MAX - 1)}`;
  // 165: the start fields at their bounds too: a model of 128 characters, a harness of 32.
  const target = { slug: at('s'), taskId: at('t'), gateId: at('g'), runId: 'w-0123456789ab', worktreeKey: '0123456789abcdef', harness: `a${'-'.repeat(31)}`, model: `a${'/'.repeat(127)}` };
  const t80 = 'x'.repeat(80);
  await log.begin({ id: t80, actor: { kind: 'device', deviceId: t80, scope: 'control', transport: 'native' }, address: 'f'.repeat(45), action: t80, project: t80,
    target, expect: { revision: Number.MAX_SAFE_INTEGER }, input: { decision: t80, textChars: Number.MAX_SAFE_INTEGER, entry: 'none' }, outcome: 'replayed', code: t80,
    current: { state: t80, revision: Number.MAX_SAFE_INTEGER }, exit: Number.MAX_SAFE_INTEGER, ms: Number.MAX_SAFE_INTEGER });
  const [line] = linesOf(path.join(root, 'console', 'actions.ndjson'));
  assert.deepEqual(line.target, target);
  await log.begin({ target: { slug: `${at('s')}s` } });
  assert.equal(linesOf(path.join(root, 'console', 'actions.ndjson'))[1].target.slug, null, 'past the bound the routes refuse it; the log never carries it');
});

test('165 FR-010: a start line records the worktree key, the harness, the model or default, the entry and the prompt length; a value outside its rule is null, an unknown entry refused', async () => {
  const root = scratch();
  const log = open(root);
  await log.begin({ id: 'r', action: 'start-session', project: '0123456789abcdef', target: { worktreeKey: 'fedcba9876543210', harness: 'claude', model: 'openrouter/anthropic/claude@v5' }, input: { textChars: 47, entry: 'do' } });
  await log.end({ id: 'r', action: 'start-session', target: { worktreeKey: 'FEDCBA9876543210', harness: 'Claude Code', model: 'two words', runId: 'w-0123456789ab' }, input: { entry: 'none' }, outcome: 'applied', exit: 0, ms: 1200 });
  await log.end({ id: 'r', target: { model: 'default' }, outcome: 'replayed' });
  const [begin, end, replay] = linesOf(path.join(root, 'console', 'actions.ndjson'));
  assert.deepEqual(begin.target, { slug: null, taskId: null, gateId: null, runId: null, worktreeKey: 'fedcba9876543210', harness: 'claude', model: 'openrouter/anthropic/claude@v5' });
  assert.deepEqual(begin.input, { decision: null, textChars: 47, entry: 'do' });
  assert.deepEqual(end.target, { slug: null, taskId: null, gateId: null, runId: 'w-0123456789ab', worktreeKey: null, harness: null, model: null });
  assert.equal(end.input.entry, 'none');
  assert.equal(replay.target.model, 'default');
  await refused(log.end({ input: { entry: 'auto' } }), 'invalid-field');
});

test('165: start-rate-limited is a summary code', async () => {
  const { SUMMARY_CODES } = require('../src/action-log.ts');
  assert.ok(SUMMARY_CODES.includes('start-rate-limited'));
});
