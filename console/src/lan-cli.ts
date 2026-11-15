'use strict';

// The three device actions of `doflow ui` (feature 160, IC-001, journey 3): `--action pair`, `--action devices`
// and `--action revoke --device <id>`. They run without the core handshake and without listening: they open
// the machine-wide store, do one thing, print and exit. `openStore` is also how the LAN boot finds the store.

const os = require('node:os');
const path = require('node:path');
const { createLanStore, StoreError } = require('./lan-store.ts');
const { payloadBlock } = require('./pair-payload.ts');

type Io = {
  env: Record<string, string | undefined>,
  stdout: { write(text: string): unknown, isTTY?: boolean },
  stderr: { write(text: string): unknown },
  interfaces?: () => Record<string, any[] | undefined>,
};

const NO_CONSOLE = 'no LAN Console is running; start one with doflow ui --lan';

/** `<config home>/doflow/console` by the core's rule (an absolute XDG_CONFIG_HOME, else an absolute HOME/.config), or null. */
function consoleDir(env: Record<string, string | undefined>): string | null {
  const usable = (name: string) => (typeof env[name] === 'string' && path.isAbsolute(env[name] as string) ? (env[name] as string) : null);
  const xdg = usable('XDG_CONFIG_HOME');
  const home = usable('HOME');
  const base = xdg !== null ? xdg : home !== null ? path.join(home, '.config') : null;
  return base === null ? null : path.join(base, 'doflow', 'console');
}

/** The store over that folder, or why there is none. Nothing is created on disk here. */
function openStore(env: Record<string, string | undefined>): { store: any, dir: string } | { error: string } {
  const dir = consoleDir(env);
  if (dir === null) return { error: 'no config home: set XDG_CONFIG_HOME or HOME to an absolute path' };
  return { store: createLanStore({ dir }), dir };
}

const printSafe = (text: string) => text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
const two = (value: number) => String(value).padStart(2, '0');
const stamp = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
};

function table(rows: string[][]): string {
  const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));
  return rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join('  ')).join('\n');
}

/** Runs the action in `flags`; resolves with the exit code. Output goes to `io`; nothing here listens. */
async function runAction(flags: any, io: Io): Promise<number> {
  const fail = (code: number, message: string) => { io.stderr.write(`doflow ui: ${message}\n`); return code; };
  const opened = openStore(io.env);
  if ('error' in opened) return fail(1, opened.error);
  const { store } = opened;
  try {
    const problem = store.check();
    if (problem) return fail(1, problem);

    if (flags.action === 'devices') {
      const devices = store.list();
      if (flags.json) {
        io.stdout.write(`${JSON.stringify({ v: 1, devices: devices.map((d: any) => ({ id: d.id, name: d.name, scope: d.scope, via: d.via, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt, lastAddress: d.lastAddress, state: d.state, revokedAt: d.revokedAt })) })}\n`);
        return 0;
      }
      if (devices.length === 0) {
        io.stdout.write('no devices paired\n');
        return 0;
      }
      const rows = [['id', 'name', 'scope', 'via', 'paired', 'last seen', 'last address', 'state'],
        ...devices.map((d: any) => [d.id, printSafe(d.name), d.scope, d.via, stamp(d.pairedAt), stamp(d.lastSeenAt), printSafe(d.lastAddress), d.state])];
      io.stdout.write(`${table(rows)}\n`);
      return 0;
    }

    if (flags.action === 'revoke') {
      const known = store.list().find((d: any) => d.id === flags.device);
      const outcome = await store.revoke(flags.device);
      if (outcome === 'unknown') return fail(1, `no device ${flags.device}`);
      io.stdout.write(outcome === 'revoked' ? `revoked ${flags.device} "${printSafe(known ? known.name : '')}"\n` : `${flags.device} was already revoked\n`);
      return 0;
    }

    // pair: the payload of the running LAN Console of this project, or of the only one running.
    const live = store.liveConsoles();
    const matching = flags.projectGiven ? live.filter((entry: any) => entry.project === flags.project) : live;
    if (matching.length === 0) return fail(1, NO_CONSOLE);
    if (matching.length > 1) {
      return fail(2, `several LAN Consoles are running; name one project:\n${matching.map((entry: any) => `  ${entry.project} ${entry.port}`).join('\n')}`);
    }
    const entry = matching[0];
    const { code, expiresAt } = await store.mintCode(flags.scope ?? 'view');
    const interfaces = (io.interfaces ?? os.networkInterfaces)();
    const iface = Object.keys(interfaces).find((name) => (interfaces[name] ?? []).some((e: any) => e && e.address === entry.address)) ?? 'unknown';
    io.stdout.write(payloadBlock({
      host: entry.address, port: entry.port, code, fingerprint: entry.fingerprint, interfaceName: iface, rule: 'running Console',
      scope: flags.scope ?? 'view', expiresAt, tty: io.stdout.isTTY === true, color: !io.env.NO_COLOR,
    }));
    return 0;
  } catch (error: any) {
    if (error instanceof StoreError) return fail(1, error.message);
    throw error;
  }
}

module.exports = { runAction, openStore, consoleDir, printSafe, NO_CONSOLE };
