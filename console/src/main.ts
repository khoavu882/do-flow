'use strict';

// The `doflow-ui` process (IC-002; feature 160 IC-001, IC-008). Boot order: parse flags (unknown or bad: exit 2) ->
// a device action (`--action pair|devices|revoke`) runs against the machine-wide store and exits, never
// listening -> core version handshake through the verb runner (outside `doflowCore`, or no version: exit 2
// naming what was found and what is needed) -> loopback: bind 127.0.0.1 (listen error: exit 1), mint the
// launch code, print the one stdout line; LAN (`--lan`, or an own certificate): config home, store readable,
// address, certificate under the store lock, listen on the remembered or first free port of 47380-47399,
// register the console entry, mint a boot code, print the pairing block once on stdout. No browser is opened.
// One events supervisor and one live hub (feature 149, IC-009, IC-010) are made beside the runner; the
// supervisor starts its child only while a `/api/live` connection follows a channel (DEC-017).
// SIGINT/SIGTERM stop the hub (its supervisor ends the child) and the runner (its children are killed), mark
// the console entry stopped, close the server (open streams are cut) and exit 0, within 2 s. Loopback mode
// creates nothing under the config home.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createVerbRunner } = require('./verb-runner.ts');
const { createLiveChild } = require('./live-child.ts');
const { createLiveHub } = require('./live.ts');
const { handshake } = require('./handshake.ts');
const { createServer, BIND_HOST, remoteAddressError } = require('./server.ts');
const { consoleRoutes } = require('./routes.ts');
const { processSessions } = require('./session.ts');
const { createDeviceAuth } = require('./device-auth.ts');
const { chooseLanAddress } = require('./lan-address.ts');
const { ensureCertificate, fingerprintOf, certWatch } = require('./lan-cert.ts');
const { payloadBlock, colonPairs } = require('./pair-payload.ts');
const { openStore, runAction } = require('./lan-cli.ts');
const { doflowCore } = require('../package.json');

const WEB_ROOT = path.join(__dirname, '..', 'web');
const SHUTDOWN_MS = 2_000;
const LAN_PORTS = Array.from({ length: 20 }, (_, i) => 47380 + i);
const DEVICE_ID = /^d-[0-9a-f]{12}$/;
const USAGE = 'usage: doflow-ui --core <absolute path to bin/doflow.js> [--project <absolute dir>] [--port <0..65535>]'
  + ' [--lan [--listen-address <private local IP>] | --listen-address <private local IP> --tls-cert <absolute path> --tls-key <absolute path>]'
  + ' | --action pair [--scope view|control] | --action devices [--json] | --action revoke --device <id>';
const VALUE_FLAGS = ['--core', '--project', '--port', '--listen-address', '--tls-cert', '--tls-key', '--action', '--device', '--scope'];
const SWITCHES = ['--lan', '--json'];

type Flags = {
  core: string, project: string, projectGiven: boolean, port: number, portGiven: boolean,
  lan: boolean, listenAddress?: string, tlsCert?: string, tlsKey?: string,
  action?: 'pair' | 'devices' | 'revoke', device?: string, scope?: 'view' | 'control', json: boolean,
};
type Io = {
  env: Record<string, string | undefined>,
  cwd: string,
  stdout: { write(text: string): unknown, isTTY?: boolean },
  stderr: { write(text: string): unknown },
  signals: { once(signal: string, fn: () => void): unknown },
  /** Tests: the interfaces the address choice reads, and the check an explicit address must pass. */
  interfaces?: () => Record<string, any[] | undefined>,
  addressCheck?: (address: string) => string | null,
};

/** The flags, or the reason they are refused. A value flag takes the next argument, once; `--lan` and `--json` take none. */
function parseFlags(argv: readonly string[], cwd: string, addressCheck: (address: string) => string | null = remoteAddressError): Flags | { error: string } {
  const given: Record<string, string> = {};
  const switches = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (SWITCHES.includes(name)) {
      if (switches.has(name)) return { error: `${name} given twice` };
      switches.add(name);
      continue;
    }
    if (!VALUE_FLAGS.includes(name)) return { error: `unknown argument ${JSON.stringify(name)}` };
    if (Object.hasOwn(given, name)) return { error: `${name} given twice` };
    if (index + 1 >= argv.length) return { error: `${name} needs a value` };
    given[name] = argv[index + 1];
    index += 1;
  }
  const core = given['--core'];
  if (core === undefined) return { error: '--core is required' };
  if (!path.isAbsolute(core)) return { error: '--core must be an absolute path' };
  const project = given['--project'] ?? cwd;
  if (!path.isAbsolute(project)) return { error: '--project must be an absolute path' };
  try {
    if (!fs.statSync(project).isDirectory()) return { error: '--project is not a directory' };
  } catch {
    return { error: '--project does not exist' };
  }
  const portText = given['--port'] ?? '0';
  const port = /^\d{1,5}$/.test(portText) ? Number(portText) : NaN;
  if (!(port >= 0 && port <= 65535)) return { error: '--port must be an integer 0..65535' };
  const base = { core, project, projectGiven: given['--project'] !== undefined, port, portGiven: given['--port'] !== undefined, json: switches.has('--json') };
  const listenAddress = given['--listen-address'];
  const tlsCert = given['--tls-cert'];
  const tlsKey = given['--tls-key'];
  const action = given['--action'];
  const device = given['--device'];
  const scope = given['--scope'];
  const lan = switches.has('--lan');

  if (action !== undefined) {
    if (action !== 'pair' && action !== 'devices' && action !== 'revoke') return { error: '--action must be pair, devices or revoke' };
    if (lan || base.portGiven || listenAddress !== undefined || tlsCert !== undefined || tlsKey !== undefined) {
      return { error: '--action cannot be combined with --lan, --port, --listen-address, --tls-cert or --tls-key' };
    }
    if ((action === 'revoke') !== (device !== undefined)) return { error: action === 'revoke' ? '--action revoke needs --device <id>' : '--device is only for --action revoke' };
    if (device !== undefined && !DEVICE_ID.test(device)) return { error: '--device must look like d-<12 hex digits>' };
    if (scope !== undefined && (action !== 'pair' || (scope !== 'view' && scope !== 'control'))) return { error: '--scope is only for --action pair and is view or control' };
    if (base.json && action !== 'devices') return { error: '--json is only for --action devices' };
    return { ...base, lan: false, action, ...(device === undefined ? {} : { device }), ...(scope === undefined ? {} : { scope: scope as 'view' | 'control' }) };
  }
  if (device !== undefined || scope !== undefined || base.json) return { error: '--device, --scope and --json are only for --action' };

  if (lan && (tlsCert !== undefined || tlsKey !== undefined)) return { error: '--lan cannot be combined with --tls-cert or --tls-key; the generated and your own certificate exclude each other' };
  if (!lan && (listenAddress !== undefined || tlsCert !== undefined || tlsKey !== undefined)) {
    if (listenAddress === undefined || tlsCert === undefined || tlsKey === undefined) {
      return { error: '--listen-address, --tls-cert, and --tls-key must be supplied together' };
    }
  }
  if (listenAddress !== undefined) {
    if (net.isIP(listenAddress) === 0) return { error: '--listen-address must be a literal IP address, not a DNS name' };
    if (tlsCert !== undefined && (!path.isAbsolute(tlsCert) || !path.isAbsolute(tlsKey as string))) return { error: '--tls-cert and --tls-key must be absolute paths' };
    const problem = addressCheck(listenAddress);
    if (problem) return { error: problem };
  }
  return { ...base, lan: lan || listenAddress !== undefined, ...(listenAddress === undefined ? {} : { listenAddress }), ...(tlsCert === undefined ? {} : { tlsCert, tlsKey }) };
}

const detailOf = (error: any) => (error && typeof error.message === 'string' ? error.message : error && error.code ? error.code : 'error');

type Lan = { app: any, block: string, stop: () => Promise<void> } | { exit: number, message: string };

/** LAN boot after the handshake (design §8): config home, store, address, certificate, listen, entry, boot code. */
async function startLan(flags: Flags, io: Io, serving: { runner: any, live: any }): Promise<Lan> {
  const say = (line: string) => io.stderr.write(`doflow ui: ${line}\n`);
  const opened = openStore(io.env);
  if ('error' in opened) return { exit: 1, message: opened.error };
  const { store, dir } = opened;
  const problem = store.check();
  if (problem) return { exit: 1, message: problem };

  const interfaces = (io.interfaces ?? os.networkInterfaces)();
  let address: string;
  let iface: string;
  let rule: string;
  if (flags.listenAddress) {
    address = flags.listenAddress;
    iface = Object.keys(interfaces).find((name) => (interfaces[name] ?? []).some((entry: any) => entry && entry.address === address)) ?? 'listen-address';
    rule = 'given with --listen-address';
  } else {
    const chosen = chooseLanAddress(interfaces);
    if ('error' in chosen) {
      const seen = chosen.seen.map((entry: any) => `\n  ${entry.address} (${entry.iface})`).join('');
      return { exit: 2, message: `${chosen.error}${seen}\npass --listen-address <address>` };
    }
    ({ address, iface, rule } = chosen);
  }
  say(`lan address ${address} (${iface}): ${rule}`);

  let certPath: string;
  let keyPath: string;
  let ownCert = false;
  if (flags.tlsCert) {
    certPath = flags.tlsCert;
    keyPath = flags.tlsKey as string;
    ownCert = true;
  } else {
    try {
      const cert = await store.withLock(() => ensureCertificate(dir, address, Date.now()));
      ({ certPath, keyPath } = cert);
      say(`certificate ${cert.issued ? 'issued' : 'reused'}: SHA-256 ${colonPairs(cert.fingerprint)}, valid until ${new Date(cert.validTo).toISOString().slice(0, 10)}`);
    } catch (error: any) {
      return { exit: 1, message: `certificate for ${address} failed (${detailOf(error)})` };
    }
  }

  let watch: any;
  try {
    watch = certWatch({ certPath, log: say });
  } catch (error: any) {
    return { exit: 1, message: `certificate ${certPath} cannot be read (${detailOf(error)})` };
  }
  const auth = createDeviceAuth({ store, log: say, certState: () => watch.check() });
  const routes = consoleRoutes(serving.runner, auth, serving.live, { projectRoot: flags.project, home: os.homedir() });
  const remembered = store.rememberedPort(flags.project);
  const ports: number[] = flags.portGiven ? [flags.port] : [...new Set<number>([...(remembered === null ? [] : [remembered]), ...LAN_PORTS])];
  let app: any = null;
  let lastError: any = null;
  for (const port of ports) {
    try {
      app = await createServer({
        webRoot: WEB_ROOT, port, mode: 'lan', host: address, routes, tls: { certPath, keyPath }, authenticate: auth.authenticate,
        ...(io.addressCheck ? { addressCheck: io.addressCheck } : {}),
      });
      break;
    } catch (error: any) {
      lastError = error;
      if (!(error && error.code === 'EADDRINUSE' && ports.length > 1)) return { exit: 1, message: `cannot listen on ${address}:${port} (${detailOf(error)})` };
    }
  }
  if (app === null) return { exit: 1, message: `cannot listen on ${address}: no free port among ${LAN_PORTS[0]}-${LAN_PORTS[LAN_PORTS.length - 1]} (${detailOf(lastError)})` };

  let fingerprint: string;
  let boot: { code: string, expiresAt: number };
  try {
    fingerprint = fingerprintOf(fs.readFileSync(certPath));
    await store.registerConsole({ project: flags.project, address, port: app.port, fingerprint });
    boot = await store.mintCode('view');
  } catch (error: any) {
    await app.close();
    return { exit: 1, message: `cannot register this Console (${detailOf(error)})` };
  }
  if (ownCert) say(`certificate from ${certPath}: SHA-256 ${colonPairs(fingerprint)}`);
  const { code, expiresAt } = boot;
  const block = payloadBlock({
    host: address, port: app.port, code, fingerprint, interfaceName: iface, rule, scope: 'view', expiresAt,
    tty: io.stdout.isTTY === true, color: !io.env.NO_COLOR,
  });
  // Once now (an own certificate may already be near its end) and once a day while the Console runs.
  watch.check();
  const daily = setInterval(() => watch.check(), 24 * 60 * 60 * 1000);
  daily.unref();
  const stop = async () => {
    clearInterval(daily);
    try {
      await store.stopConsole(flags.project, process.pid);
    } catch (error: any) {
      say(`lan entry not updated: ${error && error.code ? error.code : 'error'}`);
    }
  };
  return { app, block, stop };
}

/** Runs the Console; resolves with the exit code (on a boot failure, or once a signal has shut it down). */
async function main(argv: readonly string[], io: Io = { env: process.env, cwd: process.cwd(), stdout: process.stdout, stderr: process.stderr, signals: process }): Promise<number> {
  const flags = parseFlags(argv, io.cwd, io.addressCheck);
  if ('error' in flags) {
    io.stderr.write(`doflow ui: ${flags.error}\n${USAGE}\n`);
    return 2;
  }
  if (flags.action) return runAction(flags, io);
  const runner = createVerbRunner({ corePath: flags.core, projectRoot: flags.project, env: io.env });
  const live = createLiveHub({ runner, supervisor: createLiveChild({ runner }) });
  const checked = await handshake(runner);
  if (!checked.ok || !checked.inRange) {
    live.stop();
    runner.stop();
    const found = checked.ok ? checked.version : `no version (${checked.code})`;
    io.stderr.write(`doflow ui: core version out of range: found ${found} at ${flags.core}, needed ${doflowCore}\n`);
    return 2;
  }

  let app: any;
  let announce: string;
  let afterStop: () => Promise<void> = async () => {};
  if (flags.lan) {
    const started = await startLan(flags, io, { runner, live });
    if ('exit' in started) {
      live.stop();
      runner.stop();
      io.stderr.write(`doflow ui: ${started.message}\n`);
      return started.exit;
    }
    ({ app, block: announce, stop: afterStop } = started);
  } else {
    try {
      app = await createServer({
        webRoot: WEB_ROOT,
        port: flags.port,
        // 151 IC-006: paths and text are placed under the runner's project root and the home folder.
        routes: consoleRoutes(runner, processSessions, live, { projectRoot: flags.project, home: os.homedir() }),
      });
    } catch (error: any) {
      live.stop();
      runner.stop();
      io.stderr.write(`doflow ui: cannot listen on ${BIND_HOST}:${flags.port} (${detailOf(error)})\n`);
      return 1;
    }
    announce = `doflow ui: ${app.origin}/#c=${processSessions.mintLaunchCode()}\n`;
  }
  io.stdout.write(announce);

  return new Promise<number>((resolve) => {
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      live.stop();
      runner.stop();
      let timer: any;
      const deadline = new Promise<void>((done) => { timer = setTimeout(done, SHUTDOWN_MS - 250); });
      Promise.race([Promise.all([app.close(), afterStop()]), deadline]).then(() => {
        clearTimeout(timer);
        resolve(0);
      });
    };
    io.signals.once('SIGINT', shutdown);
    io.signals.once('SIGTERM', shutdown);
  });
}

module.exports = { main, parseFlags, USAGE };
