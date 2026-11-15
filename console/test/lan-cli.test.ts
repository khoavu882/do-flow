'use strict';

// The device actions (feature 160, IC-001, journey 3): `--action pair`, `devices` (text and --json) and
// `revoke`, run through main() against a scratch config home with no core and no listening.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { main } = require('../src/main.ts');
const { createLanStore } = require('../src/lan-store.ts');

const FP = 'ab'.repeat(32);
const CORE = path.join(os.tmpdir(), 'no-core-needed.js');

function scratch(t: any) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-lan-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectA = path.join(root, 'a');
  const projectB = path.join(root, 'b');
  fs.mkdirSync(projectA);
  fs.mkdirSync(projectB);
  const config = path.join(root, 'config');
  const consoleDir = path.join(config, 'doflow', 'console');
  const store = createLanStore({ dir: consoleDir });
  return { root, projectA, projectB, config, consoleDir, store };
}

async function run(world: { config: string, root: string }, argv: string[], extra: { isTTY?: boolean, env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(['--core', CORE, ...argv], {
    env: { XDG_CONFIG_HOME: world.config, HOME: world.config, ...(extra.env ?? {}) },
    cwd: world.root,
    stdout: { write: (text: string) => out.push(text), isTTY: extra.isTTY === true },
    stderr: { write: (text: string) => err.push(text) },
    signals: new EventEmitter(),
    interfaces: () => ({ en0: [{ address: '192.168.1.23', family: 'IPv4', internal: false }] }),
  });
  return { code, out: out.join(''), err: err.join('') };
}

const pairDevice = async (store: any, name: string, scope: 'view' | 'control' = 'view', via: 'browser' | 'native' = 'browser') => {
  const { code } = await store.mintCode(scope);
  return (await store.consumeCode(code, { name, via, address: '192.168.1.40' })).device;
};
const startConsole = (store: any, project: string, port: number) => store.registerConsole({ project, address: '192.168.1.23', port, fingerprint: FP });

test('pair prints the block of the only running Console, mints a code that pairs, and honours --scope', async (t) => {
  const world = scratch(t);
  await startConsole(world.store, world.projectA, 47380);
  const result = await run(world, ['--action', 'pair']);
  assert.equal(result.code, 0);
  assert.equal(result.err, '');
  assert.match(result.out, /^doflow ui: LAN mode on https:\/\/192\.168\.1\.23:47380\n {2}address {6}192\.168\.1\.23 \(en0, running Console\)\n {2}fingerprint {2}SHA-256 (AB:){31}AB\n/);
  const [, code] = /pairing code ([a-z2-7]{26}) \(one use, expires \d\d:\d\d, scope view\)/.exec(result.out)!;
  assert.match(result.out, new RegExp(`link {9}https://192\\.168\\.1\\.23:47380/#pair=${code}&fp=${FP}&v=1\\n {2}\\(QR code shown on a terminal only\\)\\n$`));
  const paired = await world.store.consumeCode(code, { name: 'p', via: 'native', address: '192.168.1.40' });
  assert.equal(paired.device.scope, 'view');
  const control = await run(world, ['--action', 'pair', '--scope', 'control']);
  const [, second] = /pairing code ([a-z2-7]{26}) \(.*scope control\)/.exec(control.out)!;
  assert.equal((await world.store.consumeCode(second, { name: 'c', via: 'native', address: 'x' })).device.scope, 'control');
});

test('pair draws the QR on a terminal and not otherwise', async (t) => {
  const world = scratch(t);
  await startConsole(world.store, world.projectA, 47380);
  const tty = await run(world, ['--action', 'pair'], { isTTY: true });
  assert.match(tty.out, /\u2580/);
  assert.equal(tty.out.includes('QR code shown on a terminal only'), false);
  const plain = await run(world, ['--action', 'pair'], { isTTY: true, env: { NO_COLOR: '1' } });
  assert.equal(plain.out.includes('\x1b['), false);
  assert.match(plain.out, /\(if it does not scan, use the link\)/);
});

test('pair with no Console running exits 1; a stopped or dead one does not count', async (t) => {
  const world = scratch(t);
  const none = await run(world, ['--action', 'pair']);
  assert.deepEqual([none.code, none.out], [1, '']);
  assert.equal(none.err, 'doflow ui: no LAN Console is running; start one with doflow ui --lan\n');
  await startConsole(world.store, world.projectA, 47380);
  await world.store.stopConsole(world.projectA);
  assert.equal((await run(world, ['--action', 'pair'])).code, 1);
  const dead = createLanStore({ dir: world.consoleDir, pid: 2 ** 22 + 12345 });
  await dead.registerConsole({ project: world.projectB, address: '192.168.1.23', port: 47381, fingerprint: FP });
  assert.equal((await run(world, ['--action', 'pair'])).code, 1, 'a pid that is not alive is not running');
  assert.equal(world.store.list().length, 0);
});

test('pair with several Consoles needs a project: exit 2 lists project and port; --project picks one', async (t) => {
  const world = scratch(t);
  await startConsole(world.store, world.projectA, 47380);
  await startConsole(world.store, world.projectB, 47381);
  const several = await run(world, ['--action', 'pair']);
  assert.equal(several.code, 2);
  assert.equal(several.out, '');
  assert.match(several.err, new RegExp(`several LAN Consoles are running; name one project:\\n {2}${world.projectA} 47380\\n {2}${world.projectB} 47381\\n`));
  const picked = await run(world, ['--action', 'pair', '--project', world.projectB]);
  assert.equal(picked.code, 0);
  assert.match(picked.out, /LAN mode on https:\/\/192\.168\.1\.23:47381\n/);
  const other = await run(world, ['--action', 'pair', '--project', world.root]);
  assert.equal(other.code, 1, 'a project with no Console is none running');
});

test('devices lists in a table with a print-safe name, and --json has the fixed shape', async (t) => {
  const world = scratch(t);
  const empty = await run(world, ['--action', 'devices']);
  assert.deepEqual([empty.code, empty.out], [0, 'no devices paired\n']);
  const kai = await pairDevice(world.store, 'Kai phone');
  const tablet = await pairDevice(world.store, 'Tablet', 'control', 'native');
  await world.store.revoke(tablet.id);
  const text = await run(world, ['--action', 'devices']);
  assert.equal(text.code, 0);
  const lines = text.out.trimEnd().split('\n');
  assert.match(lines[0], /^id +name +scope +via +paired +last seen +last address +state$/);
  assert.match(lines[1], new RegExp(`^${kai.id} +Kai phone +view +browser +\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d +\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d +192\\.168\\.1\\.40 +active$`));
  assert.match(lines[2], /Tablet +control +native .* +revoked$/);

  const json = JSON.parse((await run(world, ['--action', 'devices', '--json'])).out);
  assert.deepEqual(Object.keys(json), ['v', 'devices']);
  assert.equal(json.v, 1);
  assert.deepEqual(Object.keys(json.devices[0]), ['id', 'name', 'scope', 'via', 'pairedAt', 'lastSeenAt', 'lastAddress', 'state', 'revokedAt']);
  assert.deepEqual(json.devices.map((d: any) => [d.name, d.state, d.revokedAt === null]), [['Kai phone', 'active', true], ['Tablet', 'revoked', false]]);
  assert.equal(JSON.stringify(json).includes('tokenSha256'), false);
});

test('devices shows the transport of each device, and a control code never makes a browser device control', async (t) => {
  const world = scratch(t);
  await pairDevice(world.store, 'Browser phone', 'control', 'browser');
  await pairDevice(world.store, 'Native app', 'control', 'native');
  const lines = (await run(world, ['--action', 'devices'])).out.trimEnd().split('\n');
  assert.match(lines[1], /Browser phone +view +browser /);
  assert.match(lines[2], /Native app +control +native /);
  const json = JSON.parse((await run(world, ['--action', 'devices', '--json'])).out);
  assert.deepEqual(json.devices.map((d: any) => [d.via, d.scope]), [['browser', 'view'], ['native', 'control']]);
});

test('devices prints a name through the print-safe filter even when the stored one carries controls', async (t) => {
  const world = scratch(t);
  const device = await pairDevice(world.store, 'plain');
  const file = path.join(world.consoleDir, 'lan.json');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.devices[0].name = 'A\u001b[31mB\u202eC\u0007';
  fs.writeFileSync(file, JSON.stringify(data));
  const text = (await run(world, ['--action', 'devices'])).out;
  assert.equal(/[\u0000-\u001f\u007f\u202e]/.test(text.replace(/\n/g, '')), false);
  assert.match(text, /A\[31mBC/);
  assert.equal(device.id.length, 14);
});

test('revoke: exit 0 revoked, exit 0 already revoked, exit 1 unknown; a device is refused afterwards', async (t) => {
  const world = scratch(t);
  const device = await pairDevice(world.store, 'Kai phone');
  const first = await run(world, ['--action', 'revoke', '--device', device.id]);
  assert.deepEqual([first.code, first.out, first.err], [0, `revoked ${device.id} "Kai phone"\n`, '']);
  const again = await run(world, ['--action', 'revoke', '--device', device.id]);
  assert.deepEqual([again.code, again.out], [0, `${device.id} was already revoked\n`]);
  const unknown = await run(world, ['--action', 'revoke', '--device', 'd-000000000000']);
  assert.deepEqual([unknown.code, unknown.out, unknown.err], [1, '', 'doflow ui: no device d-000000000000\n']);
  assert.equal(world.store.list()[0].state, 'revoked');
});

test('a store that cannot be read or locked makes every action exit 1 with the path and writes nothing', async (t) => {
  const world = scratch(t);
  fs.mkdirSync(world.consoleDir, { recursive: true });
  const file = path.join(world.consoleDir, 'lan.json');
  fs.writeFileSync(file, 'not json');
  for (const argv of [['--action', 'pair'], ['--action', 'devices'], ['--action', 'devices', '--json'], ['--action', 'revoke', '--device', 'd-0123456789ab']]) {
    const result = await run(world, argv);
    assert.equal(result.code, 1, argv.join(' '));
    assert.equal(result.out, '');
    assert.match(result.err, /lan\.json is unreadable/);
  }
  assert.equal(fs.readFileSync(file, 'utf8'), 'not json');
  fs.rmSync(file);
  fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, host: os.hostname(), at: Date.now(), id: 'held' }));
  const busy = await run(world, ['--action', 'revoke', '--device', 'd-0123456789ab']);
  assert.equal(busy.code, 1);
  assert.match(busy.err, /lan\.json/);
  const noHome = await run(world, ['--action', 'devices'], { env: { XDG_CONFIG_HOME: '', HOME: '' } });
  assert.equal(noHome.code, 1);
  assert.match(noHome.err, /no config home/);
});

test('an action never loads the core: a core path that does not exist is not looked at', async (t) => {
  const world = scratch(t);
  assert.equal((await run(world, ['--action', 'devices'])).code, 0);
  assert.equal(fs.existsSync(CORE), false);
});
