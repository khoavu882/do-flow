'use strict';

// The device store (feature 160, IC-004, data model §7). Everything under a temp dir with an injected
// clock; "another Console" is a second store instance over the same dir, and "another process" is a real
// child (test/helpers/lan-race.ts). Nothing reads the real config home.

const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createLanStore, StoreError, cleanName, sha256Hex, MAX_CODES, MAX_DEVICES, IDLE_MS, TOUCH_MS, TOMBSTONE_MS, CONSOLE_KEEP_MS, TOKEN_PREFIX, MAX_FILE_BYTES } = require('../src/lan-store.ts');

const DAY = 24 * 60 * 60 * 1000;
const made: string[] = [];
const scratch = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lan-store-'));
  made.push(dir);
  return dir;
};
afterEach(() => { for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function clock(start = Date.UTC(2026, 10, 15, 10, 0, 0)) {
  let t = start;
  return { now: () => t, advance: (by: number) => { t += by; } };
}
const open = (dir: string, c: { now: () => number } = clock(), extra: any = {}) => createLanStore({ dir, now: c.now, host: 'testhost', pid: process.pid, lockWaitMs: 300, ...extra });
const pair = async (store: any, scope: 'view' | 'control' = 'view', name = 'Pixel', via: 'browser' | 'native' = scope === 'control' ? 'native' : 'browser') => {
  const { code } = await store.mintCode(scope);
  const result = await store.consumeCode(code, { name, via, address: '192.168.1.40' });
  assert.equal('token' in result, true);
  return result as { device: any, token: string };
};
const digestOf = (token: string) => sha256Hex(token);
const text = (dir: string) => fs.readFileSync(path.join(dir, 'lan.json'), 'utf8');

test('two child processes consume one code at once: exactly one device is added, the other is pair-refused', async () => {
  const dir = scratch();
  const store = open(dir, { now: Date.now });
  const real = createLanStore({ dir });
  const { code } = await real.mintCode('view');
  const go = path.join(dir, 'go');
  const helper = path.join(__dirname, 'helpers', 'lan-race.ts');
  const children = ['one', 'two'].map((name) => {
    const child = cp.spawn(process.execPath, [helper, dir, go, 'consume', code, name], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    const ready = new Promise<void>((resolve) => child.stdout.on('data', (chunk: any) => { out += chunk; if (out.includes('ready\n')) resolve(); }));
    const done = new Promise<any>((resolve) => child.on('close', () => resolve(JSON.parse(out.split('\n').filter(Boolean).pop() as string))));
    return { ready, done };
  });
  await Promise.all(children.map((child) => child.ready));
  fs.writeFileSync(go, '');
  const results = await Promise.all(children.map((child) => child.done));
  assert.equal(results.filter((r) => r.token !== undefined).length, 1, JSON.stringify(results));
  assert.deepEqual(results.filter((r) => r.token === undefined), [{ refused: 'pair-refused' }]);
  assert.equal(real.list().length, 1);
  assert.equal(store.list().length, 1);
});

test('four processes minting at once lose none of their codes', async () => {
  const dir = scratch();
  fs.mkdirSync(dir, { recursive: true });
  const go = path.join(dir, 'go');
  const helper = path.join(__dirname, 'helpers', 'lan-race.ts');
  const children = [0, 1, 2, 3].map(() => {
    const child = cp.spawn(process.execPath, [helper, dir, go, 'mint', 'view'], { stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    const ready = new Promise<void>((resolve) => child.stdout.on('data', (chunk: any) => { out += chunk; if (out.includes('ready\n')) resolve(); }));
    const done = new Promise<any>((resolve) => child.on('close', () => resolve(JSON.parse(out.split('\n').filter(Boolean).pop() as string))));
    return { ready, done };
  });
  await Promise.all(children.map((child) => child.ready));
  fs.writeFileSync(go, '');
  const minted = await Promise.all(children.map((child) => child.done));
  assert.equal(new Set(minted.map((m) => m.code)).size, 4, JSON.stringify(minted));
  const file = JSON.parse(text(dir));
  assert.deepEqual(file.codes.map((c: any) => c.sha256).sort(), minted.map((m) => sha256Hex(m.code)).sort());
});

test('a code is 26 base32 characters, valid for five minutes, spent by one use', async () => {
  const dir = scratch();
  const c = clock();
  const store = open(dir, c);
  const { code, expiresAt } = await store.mintCode('view');
  assert.match(code, /^[a-z2-7]{26}$/);
  assert.equal(expiresAt, c.now() + 5 * 60 * 1000);
  assert.equal(text(dir).includes(code), false, 'only the digest is stored');
  const first = await store.consumeCode(code, { name: 'A', via: 'browser', address: '10.0.0.2' });
  assert.equal('token' in first, true);
  assert.deepEqual(await store.consumeCode(code, { name: 'B', via: 'browser', address: '10.0.0.2' }), { refused: 'pair-refused' });
  const late = (await store.mintCode('view')).code;
  c.advance(5 * 60 * 1000);
  assert.deepEqual(await store.consumeCode(late, { name: 'C', via: 'browser', address: '10.0.0.2' }), { refused: 'pair-refused' });
  assert.deepEqual(await store.consumeCode('nonsense', { name: 'D', via: 'browser', address: '10.0.0.2' }), { refused: 'pair-refused' });
  assert.equal(store.list().length, 1);
});

test('the code fixes the scope, and the token is dfd1_ plus 43 base64url characters stored as its SHA-256', async () => {
  const dir = scratch();
  const store = open(dir);
  const { device, token } = await pair(store, 'control', 'Tablet');
  assert.equal(device.scope, 'control');
  assert.match(token, /^dfd1_[A-Za-z0-9_-]{43}$/);
  assert.equal(token.startsWith(TOKEN_PREFIX), true);
  assert.match(device.id, /^d-[0-9a-f]{12}$/);
  const file = JSON.parse(text(dir));
  assert.equal(file.devices[0].tokenSha256, digestOf(token));
  assert.equal(file.devices[0].via, 'native', 'the transport is recorded per device');
  assert.equal(text(dir).includes(token), false);
  assert.equal('tokenSha256' in device, false);
  await assert.rejects(store.mintCode('admin'), /scope/);
});

test('a revoke written by instance B is refused by instance A on its next verify, with no restart', async () => {
  const dir = scratch();
  const c = clock();
  const a = open(dir, c);
  const b = open(dir, c);
  const { device, token } = await pair(a);
  assert.equal('device' in a.verify(digestOf(token)), true);
  assert.equal('device' in b.verify(digestOf(token)), true);
  assert.equal(await b.revoke(device.id), 'revoked');
  assert.deepEqual(a.verify(digestOf(token)), { refused: 'device-revoked', id: device.id });
  assert.equal(await a.revoke(device.id), 'already');
  assert.equal(await a.revoke('d-000000000000'), 'unknown');
  assert.deepEqual(a.verify(digestOf('dfd1_unknown')), { refused: 'device-unpaired' });
  assert.deepEqual(a.verify('not hex'), { refused: 'device-unpaired' });
});

test('a pairing done by instance B is accepted by instance A (a restart or a second Console)', async () => {
  const dir = scratch();
  const a = open(dir);
  const b = open(dir);
  assert.deepEqual(a.verify(digestOf('dfd1_x')), { refused: 'device-unpaired' });
  const { token } = await pair(b);
  assert.equal('device' in a.verify(digestOf(token)), true);
  const restarted = open(dir);
  assert.equal('device' in restarted.verify(digestOf(token)), true);
});

test('a device idle for more than 30 days is expired; list says so', async () => {
  const dir = scratch();
  const c = clock();
  const store = open(dir, c);
  const { token, device } = await pair(store);
  c.advance(IDLE_MS);
  assert.equal('device' in store.verify(digestOf(token)), true, 'exactly 30 days is not yet idle');
  c.advance(1);
  assert.deepEqual(store.verify(digestOf(token)), { refused: 'device-expired', id: device.id });
  assert.equal(store.list()[0].state, 'expired');
});

test('touch writes at most hourly and never for a revoked or unknown device', async () => {
  const dir = scratch();
  const c = clock();
  const store = open(dir, c);
  const { device } = await pair(store);
  const written = () => fs.statSync(path.join(dir, 'lan.json')).ino;
  const before = written();
  c.advance(TOUCH_MS - 1);
  assert.equal(await store.touch(device.id, '192.168.1.99'), false);
  assert.equal(written(), before, 'no write inside the hour');
  c.advance(1);
  assert.equal(await store.touch(device.id, '192.168.1.99'), true);
  assert.equal(store.list()[0].lastAddress, '192.168.1.99');
  assert.equal(store.list()[0].lastSeenAt, new Date(c.now()).toISOString());
  assert.equal(await store.touch(device.id, '192.168.1.98'), false);
  await store.revoke(device.id);
  c.advance(TOUCH_MS);
  assert.equal(await store.touch(device.id, '192.168.1.97'), false);
  assert.equal(await store.touch('d-aaaaaaaaaaaa', '192.168.1.97'), false);
});

test('pruning on a write drops spent codes, idle devices, old tombstones and stale console entries', async () => {
  const dir = scratch();
  const c = clock();
  const store = open(dir, c);
  const project = scratch();
  const idle = await pair(store, 'view', 'idle');
  const revoked = await pair(store, 'view', 'revoked');
  await store.revoke(revoked.device.id);
  await store.registerConsole({ project, address: '10.0.0.2', port: 47380, fingerprint: 'a'.repeat(64) });
  await store.mintCode('view');
  c.advance(TOMBSTONE_MS + 1);
  const keeper = await pair(store, 'view', 'keeper'); // a write at the new time
  let file = JSON.parse(text(dir));
  assert.deepEqual(file.devices.map((d: any) => d.name), ['idle', 'keeper'], 'the old tombstone is gone; the idle device is kept, as expired, for another 30 days');
  assert.equal(file.codes.length, 0);
  assert.equal(file.consoles.length, 1);
  c.advance(CONSOLE_KEEP_MS);
  await store.revoke(keeper.device.id);
  file = JSON.parse(text(dir));
  assert.deepEqual(file.devices, [], 'both idle devices went at 60 days (the keeper was one: the revoke found it gone)');
  assert.equal(file.consoles.length, 0, 'not started for 90 days');
  await store.registerConsole({ project, address: '10.0.0.2', port: 47380, fingerprint: 'a'.repeat(64) });
  fs.rmSync(project, { recursive: true });
  await store.mintCode('view');
  assert.equal(JSON.parse(text(dir)).consoles.length, 0, 'the project directory is gone');
  assert.equal(idle.token.length > 0, true);
});

test('at most 16 codes stay pending and 64 devices stay paired', async () => {
  const dir = scratch();
  const store = open(dir);
  const codes: string[] = [];
  for (let i = 0; i < MAX_CODES + 2; i += 1) codes.push((await store.mintCode('view')).code);
  assert.equal(JSON.parse(text(dir)).codes.length, MAX_CODES);
  assert.deepEqual(await store.consumeCode(codes[0], { name: 'x', via: 'browser', address: 'a' }), { refused: 'pair-refused' }, 'the oldest was dropped');
  assert.equal('token' in await store.consumeCode(codes[2], { name: 'x', via: 'browser', address: 'a' }), true);

  const full = open(scratch());
  for (let i = 0; i < MAX_DEVICES; i += 1) await pair(full, 'view', `d${i}`);
  const { code } = await full.mintCode('view');
  assert.deepEqual(await full.consumeCode(code, { name: 'one too many', via: 'browser', address: 'a' }), { refused: 'device-limit' });
  const first = full.list()[0];
  await full.revoke(first.id);
  assert.equal('token' in await full.consumeCode(code, { name: 'fits now', via: 'browser', address: 'a' }), true, 'the refused code was not spent');
});

test('names are cleaned: control and format characters out, whitespace collapsed, 40 characters, device when empty', async () => {
  assert.equal(cleanName('  Kai‮\u0007 \t phone\n'), 'Kai phone');
  assert.equal(cleanName('\u001b[31mred\u001b[0m'), '[31mred[0m');
  assert.equal(cleanName('x'.repeat(100)), 'x'.repeat(40));
  assert.equal(cleanName('​\u0000  '), 'device');
  assert.equal(cleanName(42), 'device');
  const dir = scratch();
  const store = open(dir);
  const { device } = await pair(store, 'view', '\u001b[2Jevil\u0000');
  assert.equal(device.name, '[2Jevil');
  assert.equal(text(dir).includes('\\u001b'), false);
});

test('a stale lock (dead pid on this host, or older than 30 s) is moved aside and the write goes through', async () => {
  const dir = scratch();
  fs.mkdirSync(dir, { recursive: true });
  const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const lock = path.join(dir, 'lan.json.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: Number(dead.stdout), host: 'testhost', at: Date.now(), id: 'x' }));
  const store = open(dir);
  await store.mintCode('view');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.readdirSync(dir).some((name: string) => name.endsWith('.gone')), false, 'the moved-aside file is deleted');

  // Alive pid, same host, but the lock file is 31 s old: stale by age.
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'testhost', at: Date.now(), id: 'y' }));
  const old = new Date(Date.now() - 31_000);
  fs.utimesSync(lock, old, old);
  await store.mintCode('view');
  assert.equal(fs.existsSync(lock), false);
  assert.equal(JSON.parse(text(dir)).codes.length, 2);
});

test('a young lock held by a live process is waited on, then refused as store-busy', async () => {
  const dir = scratch();
  fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, 'lan.json.lock');
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'testhost', at: Date.now(), id: 'z' }));
  const store = open(dir, clock(), { lockWaitMs: 150 });
  const started = Date.now();
  await assert.rejects(store.mintCode('view'), (error: any) => error instanceof StoreError && error.code === 'store-busy' && error.message.includes(lock));
  assert.equal(Date.now() - started >= 140, true);
  assert.equal(fs.existsSync(lock), true, 'a live holder keeps its lock');
  // A lock from another host is never judged by pid: only by age.
  fs.writeFileSync(lock, JSON.stringify({ pid: 999999, host: 'elsewhere', at: Date.now(), id: 'w' }));
  await assert.rejects(store.mintCode('view'), /held by another process/);
  // Releasing leaves no lock behind and does not remove a lock that is not this call's own.
  fs.rmSync(lock);
  await store.mintCode('view');
  assert.equal(fs.existsSync(lock), false);
});

test('an unreadable or invalid file is refused by every call and never overwritten', async () => {
  const dir = scratch();
  const store = open(dir);
  await pair(store);
  const file = path.join(dir, 'lan.json');
  for (const bad of ['{ not json', '{"v":2,"devices":[],"codes":[],"consoles":[]}', '{"v":1,"devices":[{"id":"nope"}],"codes":[],"consoles":[]}', '[]', '']) {
    fs.writeFileSync(file, bad);
    const fresh = open(dir);
    assert.match(fresh.check(), new RegExp(file.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')));
    assert.deepEqual(fresh.verify(digestOf('dfd1_x')), { refused: 'store-unreadable' });
    await assert.rejects(fresh.mintCode('view'), (error: any) => error instanceof StoreError && error.code === 'store-unreadable' && error.message.includes(file) && /move it aside/.test(error.message));
    await assert.rejects(fresh.revoke('d-000000000000'), /unreadable/);
    assert.throws(() => fresh.list(), /unreadable/);
    assert.equal(fs.readFileSync(file, 'utf8'), bad, 'never overwritten');
  }
  assert.equal(fs.existsSync(`${file}.lock`), false);
});

test('a running store notices a file that became unreadable, and notices when it is fixed', async () => {
  const dir = scratch();
  const store = open(dir);
  const { token } = await pair(store);
  const good = text(dir);
  fs.writeFileSync(path.join(dir, 'lan.json'), 'garbage that is a different length');
  assert.deepEqual(store.verify(digestOf(token)), { refused: 'store-unreadable' });
  fs.writeFileSync(path.join(dir, 'lan.json'), good);
  assert.equal('device' in store.verify(digestOf(token)), true);
});

test('modes: the directory is 0700 and the store file 0600; no temp file is left', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const dir = path.join(scratch(), 'console');
  const store = open(dir);
  await pair(store);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(dir, 'lan.json')).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(dir), ['lan.json']);
});

test('leftover temp and moved-aside files older than a minute are swept by the next writer', async () => {
  const dir = scratch();
  const store = open(dir);
  await store.mintCode('view');
  const stale = [`lan.json.99999.deadbeef.tmp`, `lan.json.lock.99999.deadbeef.gone`];
  const fresh = 'lan.json.88888.cafebabe.tmp';
  for (const name of [...stale, fresh]) fs.writeFileSync(path.join(dir, name), '');
  const old = new Date(Date.now() - 120_000);
  for (const name of stale) fs.utimesSync(path.join(dir, name), old, old);
  await store.mintCode('view');
  assert.deepEqual(fs.readdirSync(dir).filter((name: string) => name !== 'lan.json').sort(), [fresh]);
});

test('console entries: one per project, remembered after stop, live only while the process is', async () => {
  const dir = scratch();
  const store = open(dir);
  const project = scratch();
  const other = scratch();
  assert.equal(store.rememberedPort(project), null);
  assert.deepEqual(store.liveConsoles(), []);
  await store.registerConsole({ project, address: '192.168.1.23', port: 47381, fingerprint: 'b'.repeat(64) });
  await store.registerConsole({ project: other, address: '192.168.1.23', port: 47382, fingerprint: 'b'.repeat(64) });
  assert.equal(store.rememberedPort(project), 47381);
  assert.deepEqual(store.liveConsoles().map((e: any) => e.port).sort(), [47381, 47382]);
  await store.registerConsole({ project, address: '192.168.1.23', port: 47383, fingerprint: 'c'.repeat(64) });
  assert.equal(JSON.parse(text(dir)).consoles.filter((e: any) => e.project === project).length, 1);
  assert.equal(store.rememberedPort(project), 47383);
  await store.stopConsole(project, 4242424); // another pid's entry is not ours to stop
  assert.equal(store.liveConsoles().length, 2);
  await store.stopConsole(project);
  assert.deepEqual(store.liveConsoles().map((e: any) => e.project), [other]);
  assert.equal(store.rememberedPort(project), 47383, 'a stopped Console still remembers its port');
  assert.equal(JSON.parse(text(dir)).consoles.find((e: any) => e.project === project).stoppedAt !== null, true);
  // A dead pid or another host is not live.
  const dead = cp.spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  const file = JSON.parse(text(dir));
  file.consoles.find((e: any) => e.project === other).pid = Number(dead.stdout);
  fs.writeFileSync(path.join(dir, 'lan.json'), JSON.stringify(file));
  assert.deepEqual(store.liveConsoles(), []);
  file.consoles.find((e: any) => e.project === other).pid = process.pid;
  file.consoles.find((e: any) => e.project === other).host = 'elsewhere';
  fs.writeFileSync(path.join(dir, 'lan.json'), JSON.stringify(file));
  assert.deepEqual(store.liveConsoles(), []);
  await assert.rejects(store.registerConsole({ project: 'relative', address: 'a', port: 1, fingerprint: 'b'.repeat(64) }), /absolute project/);
  await assert.rejects(store.registerConsole({ project, address: 'a', port: 70000, fingerprint: 'b'.repeat(64) }), /absolute project/);
});

test('withLock holds the lock while it runs and releases it after, also on a throw', async () => {
  const dir = scratch();
  const store = open(dir, clock(), { lockWaitMs: 100 });
  const rival = open(dir, clock(), { lockWaitMs: 100 });
  const inside = await store.withLock(async () => {
    await assert.rejects(rival.mintCode('view'), (error: any) => error.code === 'store-busy');
    return 'ran';
  });
  assert.equal(inside, 'ran');
  await assert.rejects(store.withLock(() => { throw new Error('boom'); }), /boom/);
  await rival.mintCode('view');
});

test('the hash of a token is the plain SHA-256 hex a request can compute', () => {
  assert.equal(sha256Hex('abc'), crypto.createHash('sha256').update('abc').digest('hex'));
});

// ---- review 160: transport, expiry, file and folder trust, the lock ----

test('a device paired over the browser transport is view for ever: a control code pairs it as view, and a stored browser+control record reads as view', async () => {
  const dir = scratch();
  const store = open(dir);
  const viaBrowser = await pair(store, 'control', 'browser phone', 'browser');
  assert.equal(viaBrowser.device.scope, 'view');
  assert.equal(viaBrowser.device.via, 'browser');
  const viaNative = await pair(store, 'control', 'app', 'native');
  assert.equal(viaNative.device.scope, 'control');
  // A hand-edited or older file that says browser + control is not invalid: it reads as view, in every view of it.
  const file = path.join(dir, 'lan.json');
  const data = JSON.parse(text(dir));
  data.devices.find((d: any) => d.name === 'browser phone').scope = 'control';
  fs.writeFileSync(file, JSON.stringify(data));
  const fresh = open(dir);
  assert.equal(fresh.check(), null);
  assert.equal(fresh.verify(digestOf(viaBrowser.token)).device.scope, 'view');
  assert.deepEqual(fresh.list().map((d: any) => [d.name, d.via, d.scope]).sort(), [['app', 'native', 'control'], ['browser phone', 'browser', 'view']]);
  await fresh.revoke(viaNative.device.id);
  assert.equal(JSON.parse(text(dir)).devices.find((d: any) => d.name === 'browser phone').scope, 'view', 'a write persists the corrected scope');
});

test('an idle-expired device reads device-expired for another 30 days, does not count toward the 64, and is dropped after that', async () => {
  const dir = scratch();
  const c = clock();
  const store = open(dir, c);
  const idle = await pair(store, 'view', 'idle');
  c.advance(IDLE_MS + 1);
  await pair(store, 'view', 'other'); // a write: the old behaviour pruned the expired device here
  assert.deepEqual(store.verify(digestOf(idle.token)), { refused: 'device-expired', id: idle.device.id });
  assert.equal(store.list().find((d: any) => d.name === 'idle').state, 'expired');
  c.advance(TOMBSTONE_MS - 2);
  await pair(store, 'view', 'again');
  assert.deepEqual(store.verify(digestOf(idle.token)), { refused: 'device-expired', id: idle.device.id }, 'still kept just inside the 60 days');
  c.advance(10);
  await pair(store, 'view', 'later');
  assert.deepEqual(store.verify(digestOf(idle.token)), { refused: 'device-unpaired' }, 'gone after the window');

  const full = open(scratch(), c);
  for (let i = 0; i < MAX_DEVICES; i += 1) await pair(full, 'view', `d${i}`);
  c.advance(IDLE_MS + 1);
  const { code } = await full.mintCode('view');
  assert.equal('token' in await full.consumeCode(code, { name: 'room', via: 'browser', address: 'a' }), true, 'expired devices free their places');
});

test('lan.json must be a regular file: a symlink, a directory and a FIFO are store-unreadable and are never followed, read or replaced', { skip: process.platform === 'win32' && 'POSIX file types' }, async () => {
  const dir = scratch();
  const file = path.join(dir, 'lan.json');
  const elsewhere = path.join(scratch(), 'other.json');
  fs.writeFileSync(elsewhere, '{"v":1,"devices":[],"codes":[],"consoles":[]}');
  for (const [label, make] of [
    ['symlink to a good file', () => fs.symlinkSync(elsewhere, file)],
    ['dangling symlink', () => fs.symlinkSync(path.join(dir, 'nowhere'), file)],
    ['directory', () => fs.mkdirSync(file)],
    ['fifo', () => cp.execFileSync('mkfifo', [file])],
  ] as const) {
    fs.rmSync(file, { recursive: true, force: true });
    make();
    const store = open(dir);
    assert.match(store.check(), /not a regular file/, label);
    assert.deepEqual(store.verify(digestOf('dfd1_x')), { refused: 'store-unreadable' }, label);
    await assert.rejects(store.mintCode('view'), (error: any) => error instanceof StoreError && error.code === 'store-unreadable' && /not a regular file/.test(error.message), label);
    assert.equal(fs.readFileSync(elsewhere, 'utf8').includes('devices'), true, 'the link target was not written');
    assert.equal(fs.lstatSync(file).isFile(), false, `${label} was not replaced`);
  }
});

test('lan.json larger than 1 MiB is store-unreadable without being read into a parse; one at the limit is read', async () => {
  const dir = scratch();
  const file = path.join(dir, 'lan.json');
  const filler = (bytes: number) => `{"v":1,"devices":[],"codes":[],"consoles":[],"pad":"${'x'.repeat(bytes)}"}`;
  fs.writeFileSync(file, filler(MAX_FILE_BYTES));
  const store = open(dir);
  assert.match(store.check(), /larger than 1048576 bytes/);
  await assert.rejects(store.mintCode('view'), (error: any) => error.code === 'store-unreadable');
  assert.equal(fs.statSync(file).size > MAX_FILE_BYTES, true, 'never overwritten');
  const exact = '{"v":1,"devices":[],"codes":[],"consoles":[]}';
  fs.writeFileSync(file, `${exact}${' '.repeat(MAX_FILE_BYTES - exact.length)}`);
  assert.equal(fs.statSync(file).size, MAX_FILE_BYTES);
  assert.equal(open(dir).check(), null);
});

test('wrong types in lan.json are store-unreadable, each reported by the check', async () => {
  const dir = scratch();
  const file = path.join(dir, 'lan.json');
  const good = { id: 'd-0123456789ab', name: 'n', scope: 'view', via: 'browser', tokenSha256: 'a'.repeat(64), pairedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), lastAddress: 'x', revokedAt: null };
  for (const bad of [
    { v: 1, devices: {}, codes: [], consoles: [] },
    { v: 1, devices: [{ ...good, scope: 'admin' }], codes: [], consoles: [] },
    { v: 1, devices: [{ ...good, via: 'carrier-pigeon' }], codes: [], consoles: [] },
    { v: 1, devices: [{ ...good, tokenSha256: 'short' }], codes: [], consoles: [] },
    { v: 1, devices: [{ ...good, pairedAt: 12 }], codes: [], consoles: [] },
    { v: 1, devices: [good, good], codes: [], consoles: [] },
    { v: 1, devices: [], codes: [{ sha256: 'a'.repeat(64), scope: 'view', issuedAt: 'x', expiresAt: 'y' }], consoles: [] },
    { v: 1, devices: [], codes: [], consoles: [{ project: 1 }] },
  ]) {
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.notEqual(open(dir).check(), null, JSON.stringify(bad).slice(0, 80));
  }
});

test('the store folder must be this user\'s: one owned by someone else is refused for reads and writes, and nothing is created in it', { skip: (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) && 'needs a POSIX non-root user' }, async () => {
  const store = open('/usr');
  assert.match(store.check(), /not owned by this user/);
  assert.deepEqual(store.verify(digestOf('dfd1_x')), { refused: 'store-unreadable' });
  await assert.rejects(store.mintCode('view'), (error: any) => error instanceof StoreError && error.code === 'store-unreadable' && /not owned by this user/.test(error.message));
  assert.equal(fs.existsSync('/usr/lan.json.lock'), false);
});

test('a folder that others can write is refused by a reader; a writer sets it to 0700 and the store heals', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const dir = scratch();
  const store = open(dir);
  await pair(store);
  fs.chmodSync(dir, 0o777);
  assert.match(open(dir).check(), /writable by others/);
  await store.mintCode('view'); // a writer repairs the mode first
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  assert.equal(open(dir).check(), null);
});

test('modes under umask 0: the folder is 0700, lan.json and its lock 0600, whatever the process umask', { skip: process.platform === 'win32' && 'POSIX modes' }, async () => {
  const before = process.umask(0);
  try {
    const dir = path.join(scratch(), 'console');
    const store = open(dir);
    await pair(store);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'lan.json')).mode & 0o777, 0o600);
    let during = 0;
    await store.withLock(() => { during = fs.statSync(path.join(dir, 'lan.json.lock')).mode & 0o777; });
    assert.equal(during, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['lan.json']);
  } finally {
    process.umask(before);
  }
});

test('a writer whose lock was taken from under it gives up with store-busy instead of renaming over the file, and leaves no temp file', async () => {
  const dir = scratch();
  const lock = path.join(dir, 'lan.json.lock');
  let steal = false;
  const c = clock();
  const store = createLanStore({ dir, host: 'testhost', pid: process.pid, lockWaitMs: 300, now: () => {
    // Called once under the lock, before the write: another writer's lock lands on the name.
    if (steal && fs.existsSync(lock)) fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, host: 'testhost', at: 1, id: 'someone-else' }));
    return c.now();
  } });
  await pair(store);
  const before = text(dir);
  steal = true;
  await assert.rejects(store.mintCode('view'), (error: any) => error instanceof StoreError && error.code === 'store-busy' && /taken over/.test(error.message));
  assert.equal(text(dir), before, 'the file was not replaced');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['lan.json', 'lan.json.lock'], 'no temp file; the other writer\'s lock is left alone');
  assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).id, 'someone-else');
});
