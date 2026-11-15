'use strict';

// main() in LAN mode (feature 160, IC-001, IC-008, design §8). The real core answers the version handshake;
// the config home is a scratch XDG_CONFIG_HOME, the interfaces are injected, and the listen is on 127.0.0.1
// (`--listen-address 127.0.0.1` with the address check injected as accepting it: no LAN address is bound).
// The automatic address choice listens on nothing in a test, so its success is covered by lan-address.test.ts
// and its refusals here.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../src/main.ts');
const { createLanStore } = require('../src/lan-store.ts');

const CORE = path.join(__dirname, '..', '..', 'bin', 'doflow.js');
const LOOPBACK = { lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: false }] };

function scratch(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lan-main-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  return { root, project, config: path.join(root, 'config'), consoleDir: path.join(root, 'config', 'doflow', 'console') };
}

/** Runs main() with captured output; `stop()` sends SIGTERM and resolves with the exit code. */
function launch(argv: string[], world: { project: string, config: string }, extra: any = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  const io = {
    env: { ...process.env, XDG_CONFIG_HOME: world.config, HOME: world.config, ...(extra.env ?? {}) },
    cwd: world.project,
    stdout: { write: (text: string) => out.push(text), isTTY: false },
    stderr: { write: (text: string) => err.push(text) },
    signals,
    interfaces: () => extra.interfaces ?? LOOPBACK,
    addressCheck: () => null,
  };
  const done = main(['--core', CORE, '--project', world.project, ...argv], io);
  const ready = async () => {
    const start = Date.now();
    while (out.length === 0 && Date.now() - start < 20_000) {
      if (await Promise.race([done.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 25))])) break;
    }
  };
  return { out, err, done, ready, stop: () => { signals.emit('SIGTERM'); return done; } };
}

const LAN = ['--lan', '--listen-address', '127.0.0.1'];
const portOf = (text: string) => Number(/LAN mode on https:\/\/127\.0\.0\.1:(\d+)/.exec(text)![1]);
const fingerprintOf = (text: string) => /fingerprint {2}SHA-256 ([0-9A-F:]{95})/.exec(text)![1].replace(/:/g, '').toLowerCase();

test('--lan prints the IC-003 block once on stdout, registers a console entry, and a second start reuses the port and the fingerprint', async (t) => {
  const world = scratch(t);
  const first = launch(LAN, world);
  await first.ready();
  assert.equal(first.out.length, 1, 'one stdout write');
  const block = first.out[0];
  assert.match(block, /^doflow ui: LAN mode on https:\/\/127\.0\.0\.1:\d+\n {2}address {6}127\.0\.0\.1 \(lo0, given with --listen-address\)\n {2}fingerprint {2}SHA-256 /);
  assert.match(block, /\n {2}pairing code [a-z2-7]{26} \(one use, expires \d\d:\d\d, scope view\)\n {2}link {9}https:\/\/127\.0\.0\.1:\d+\/#pair=[a-z2-7]{26}&fp=[0-9a-f]{64}&v=1\n {2}\(QR code shown on a terminal only\)\n$/);
  const port = portOf(block);
  assert.equal(port >= 47380 && port <= 47399, true, `first free port of the range, got ${port}`);
  const stderr = first.err.join('');
  assert.match(stderr, /doflow ui: lan address 127\.0\.0\.1 \(lo0\): given with --listen-address\n/);
  assert.match(stderr, /doflow ui: certificate issued: SHA-256 [0-9A-F:]{95}, valid until \d{4}-\d\d-\d\d\n/);
  assert.equal(stderr.includes(/pairing code ([a-z2-7]{26})/.exec(block)![1]), false, 'the code never reaches stderr');

  const store = createLanStore({ dir: world.consoleDir });
  const [entry] = store.liveConsoles();
  assert.deepEqual([entry.project, entry.address, entry.port, entry.fingerprint, entry.pid], [world.project, '127.0.0.1', port, fingerprintOf(block), process.pid]);
  assert.equal(fs.statSync(path.join(world.consoleDir, 'tls', 'key.pem')).mode & 0o777, 0o600);

  assert.equal(await first.stop(), 0);
  assert.equal(store.liveConsoles().length, 0, 'stoppedAt is set');
  assert.equal(store.rememberedPort(world.project), port, 'and the port is remembered');

  const second = launch(LAN, world);
  await second.ready();
  assert.equal(portOf(second.out[0]), port, 'the same port');
  assert.equal(fingerprintOf(second.out[0]), fingerprintOf(block), 'the same certificate');
  assert.match(second.err.join(''), /certificate reused: /);
  assert.equal(await second.stop(), 0);
});

test('the boot code pairs a device over https, and the paired cookie reads /api/info', async (t) => {
  const world = scratch(t);
  const run = launch(LAN, world);
  await run.ready();
  const block = run.out[0];
  t.after(() => run.stop());
  const [, code] = /pairing code ([a-z2-7]{26})/.exec(block)!;
  const port = portOf(block);
  const certPath = path.join(world.consoleDir, 'tls', 'cert-127.0.0.1.pem');
  const call = (method: string, target: string, headers: Record<string, string>, body?: string): Promise<any> => new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, method, path: target, ca: fs.readFileSync(certPath), servername: '', headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res: any) => {
      const chunks: any[] = [];
      res.on('data', (c: any) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const payload = JSON.stringify({ v: 1, code, name: 'Test browser' });
  const paired = await call('POST', '/api/pair', { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)), Origin: `https://127.0.0.1:${port}`, 'Sec-Fetch-Site': 'same-origin' }, payload);
  assert.equal(paired.status, 200);
  const cookie = paired.headers['set-cookie'][0].split(';')[0];
  const info = await call('GET', '/api/info', { Cookie: cookie });
  assert.equal(info.status, 200);
  assert.equal((await call('GET', '/api/info', {})).status, 401, 'no credential, no data');
  assert.equal(run.err.join('').includes(code), false);
  assert.equal(run.err.join('').includes(cookie.split('=')[1]), false);
  assert.match(run.err.join(''), /doflow ui: paired d-[0-9a-f]{12} "Test browser" scope view via browser from 127\.0\.0\.1\n/);
});

test('no candidate and several candidates exit 2 naming every private address and listen on nothing', async (t) => {
  const world = scratch(t);
  const none = launch(['--lan'], world, { interfaces: { docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }], lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] } });
  assert.equal(await none.done, 2);
  assert.match(none.err.join(''), /no private IPv4 address on a non-virtual interface\n {2}172\.17\.0\.1 \(docker0\)\npass --listen-address <address>/);
  const several = launch(['--lan'], world, { interfaces: { en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }], en1: [{ address: '10.0.0.5', family: 'IPv4', internal: false }] } });
  assert.equal(await several.done, 2);
  assert.match(several.err.join(''), /several private IPv4 addresses on non-virtual interfaces\n {2}192\.168\.1\.5 \(en0\)\n {2}10\.0\.0\.5 \(en1\)\npass --listen-address/);
  assert.deepEqual([none.out, several.out], [[], []]);
  assert.equal(fs.existsSync(path.join(world.consoleDir, 'lan.json')), false, 'no entry was written');
  assert.equal(fs.existsSync(path.join(world.consoleDir, 'tls')), false, 'no certificate was made');
});

test('flag combinations that exclude each other exit 2 with the usage line', async (t) => {
  const world = scratch(t);
  const refuse = async (argv: string[], pattern: RegExp) => {
    const run = launch(argv, world);
    assert.equal(await run.done, 2, argv.join(' '));
    assert.match(run.err.join(''), pattern, argv.join(' '));
    assert.match(run.err.join(''), /usage: doflow-ui /);
  };
  await refuse(['--lan', '--tls-cert', '/abs/c.pem', '--tls-key', '/abs/k.pem'], /--lan cannot be combined with --tls-cert or --tls-key/);
  await refuse(['--lan', '--tls-cert', '/abs/c.pem'], /--lan cannot be combined/);
  await refuse(['--action', 'devices', '--lan'], /--action cannot be combined/);
  await refuse(['--action', 'devices', '--port', '1'], /--action cannot be combined/);
  await refuse(['--action', 'revoke'], /needs --device/);
  await refuse(['--action', 'revoke', '--device', 'd-xyz'], /--device must look like/);
  await refuse(['--action', 'devices', '--device', 'd-0123456789ab'], /only for --action revoke/);
  await refuse(['--action', 'devices', '--scope', 'view'], /--scope is only for --action pair/);
  await refuse(['--action', 'pair', '--scope', 'admin'], /--scope is only for --action pair/);
  await refuse(['--action', 'pair', '--json'], /--json is only for --action devices/);
  await refuse(['--action', 'nope'], /--action must be pair, devices or revoke/);
  await refuse(['--json'], /only for --action/);
  await refuse(['--scope', 'view'], /only for --action/);
  await refuse(['--lan', '--lan'], /--lan given twice/);
  assert.equal(fs.existsSync(world.consoleDir), false);
});

test('a store that cannot be read stops the LAN boot with exit 1 naming the file, and nothing is overwritten', async (t) => {
  const world = scratch(t);
  fs.mkdirSync(world.consoleDir, { recursive: true });
  fs.writeFileSync(path.join(world.consoleDir, 'lan.json'), '{ broken');
  const run = launch(LAN, world);
  assert.equal(await run.done, 1);
  assert.match(run.err.join(''), /device store .*lan\.json is unreadable .*move it aside to start over/);
  assert.equal(fs.readFileSync(path.join(world.consoleDir, 'lan.json'), 'utf8'), '{ broken');
  assert.deepEqual(run.out, []);
  const noHome = launch(LAN, world, { env: { XDG_CONFIG_HOME: '', HOME: '' } });
  assert.equal(await noHome.done, 1);
  assert.match(noHome.err.join(''), /no config home/);
});

test('loopback creates no console folder and prints the one launch line', async (t) => {
  const world = scratch(t);
  const run = launch([], world);
  await run.ready();
  assert.equal(run.out.length, 1);
  assert.match(run.out[0], /^doflow ui: http:\/\/127\.0\.0\.1:\d+\/#c=[0-9a-f]{64}\n$/);
  assert.equal(await run.stop(), 0);
  assert.equal(fs.existsSync(world.config), false, 'nothing under the config home');
});

test('an explicit port that is taken exits 1 and leaves no console entry', async (t) => {
  const world = scratch(t);
  const net = require('node:net');
  const holder = net.createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const taken = holder.address().port;
  const refused = launch([...LAN, '--port', String(taken)], world);
  assert.equal(await refused.done, 1);
  assert.match(refused.err.join(''), new RegExp(`cannot listen on 127\\.0\\.0\\.1:${taken} \\(`));
  assert.equal(fs.existsSync(path.join(world.consoleDir, 'lan.json')), false, 'no entry after a failed listen');
});

test('a taken port of the range is skipped: the next free one is used and remembered', async (t) => {
  const world = scratch(t);
  const net = require('node:net');
  const holders: any[] = [];
  for (let port = 47380; port <= 47381; port += 1) {
    const holder = net.createServer();
    const bound = await new Promise<boolean>((resolve) => { holder.once('error', () => resolve(false)); holder.listen(port, '127.0.0.1', () => resolve(true)); });
    if (bound) holders.push(holder);
    else t.skip(`port ${port} is in use on this machine`);
  }
  t.after(() => holders.forEach((holder) => holder.close()));
  if (holders.length < 2) return;
  const run = launch(LAN, world);
  await run.ready();
  assert.equal(portOf(run.out[0]), 47382);
  assert.equal(await run.stop(), 0);
  assert.equal(createLanStore({ dir: world.consoleDir }).rememberedPort(world.project), 47382);
});
