'use strict';

// The machine-wide device store (feature 160, IC-004, data model §7): `<config home>/console/lan.json`, one
// JSON file holding paired devices, pending pairing codes and the LAN Consoles that run or ran. This module
// is its only writer. A write takes `lan.json.lock` (created exclusively, waited on up to 2 s, a stale one
// moved aside), reads the file again, changes it, writes a temp file, fsyncs and renames it over `lan.json`,
// so two processes never lose each other's change. A read stats the file and reloads when it changed, so a
// revoke written by any process is seen by every Console on its next request: no timer, no `fs.watch`.
// An unreadable or invalid file is never overwritten: writers throw `store-unreadable` and `verify` refuses.
// Secrets are held as SHA-256 only; nothing here logs.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const IDLE_MS = 30 * DAY_MS;
const TOUCH_MS = 60 * 60 * 1000;
const TOMBSTONE_MS = 30 * DAY_MS;
const CONSOLE_KEEP_MS = 90 * DAY_MS;
const MAX_CODES = 16;
const MAX_DEVICES = 64;
const NAME_MAX = 40;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 30_000;
const LEFTOVER_MS = 60_000;
const LAN_FILE = 'lan.json';
const TOKEN_PREFIX = 'dfd1_';

type Scope = 'view' | 'control';
type Via = 'browser' | 'native';
type Device = { id: string, name: string, scope: Scope, via: Via, tokenSha256: string, pairedAt: string, lastSeenAt: string, lastAddress: string, revokedAt: string | null };
type Code = { sha256: string, scope: Scope, issuedAt: string, expiresAt: string };
type ConsoleEntry = { project: string, address: string, port: number, fingerprint: string, host: string, pid: number, startedAt: string, stoppedAt: string | null };
type Data = { v: 1, devices: Device[], codes: Code[], consoles: ConsoleEntry[] };
type DeviceView = Omit<Device, 'tokenSha256'>;
type Options = { dir: string, now?: () => number, host?: string, pid?: number, lockWaitMs?: number };

class StoreError extends Error {
  code: 'store-busy' | 'store-unreadable';
  constructor(code: 'store-busy' | 'store-unreadable', message: string) {
    super(message);
    this.code = code;
  }
}

const sha256Hex = (value: string): string => crypto.createHash('sha256').update(value, 'utf8').digest('hex');
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const emptyData = (): Data => ({ v: 1, devices: [], codes: [], consoles: [] });
const serialize = (data: Data): string => `${JSON.stringify(data, null, 2)}\n`;

/** A device name made safe to store and print: control and format characters out, whitespace collapsed, at most 40 characters, `device` when nothing is left. */
function cleanName(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim() : '';
  return Array.from(text).slice(0, NAME_MAX).join('').trim() || 'device';
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
/** 16 random bytes as 26 lowercase RFC 4648 base32 characters, no padding. */
function newCode(): string {
  const bytes = crypto.randomBytes(16);
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += BASE32[(buffer >>> (bits - 5)) & 31]; bits -= 5; }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(buffer << (5 - bits)) & 31];
  return out;
}

// ---- schema ----

const isHex64 = (value: unknown) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const isTime = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const isScope = (value: unknown) => value === 'view' || value === 'control';

/** Throws a short reason when `value` is not a store of schema 1. */
function validate(value: any): Data {
  const fail = (reason: string): never => { throw new Error(reason); };
  if (value === null || typeof value !== 'object' || Array.isArray(value) || value.v !== 1) fail('not a version 1 store');
  for (const key of ['devices', 'codes', 'consoles']) if (!Array.isArray(value[key])) fail(`"${key}" is not a list`);
  const seen = new Set<string>();
  for (const d of value.devices) {
    if (d === null || typeof d !== 'object' || !/^d-[0-9a-f]{12}$/.test(d.id) || typeof d.name !== 'string' || !isScope(d.scope)
      || (d.via !== 'browser' && d.via !== 'native') || !isHex64(d.tokenSha256) || !isTime(d.pairedAt) || !isTime(d.lastSeenAt)
      || typeof d.lastAddress !== 'string' || (d.revokedAt !== null && !isTime(d.revokedAt))) fail('a device record is malformed');
    if (seen.has(d.id) || seen.has(d.tokenSha256)) fail('a device id or token digest is repeated');
    seen.add(d.id);
    seen.add(d.tokenSha256);
  }
  for (const c of value.codes) {
    if (c === null || typeof c !== 'object' || !isHex64(c.sha256) || !isScope(c.scope) || !isTime(c.issuedAt) || !isTime(c.expiresAt)) fail('a code record is malformed');
  }
  for (const e of value.consoles) {
    if (e === null || typeof e !== 'object' || typeof e.project !== 'string' || typeof e.address !== 'string' || !Number.isInteger(e.port)
      || !isHex64(e.fingerprint) || typeof e.host !== 'string' || !Number.isInteger(e.pid) || !isTime(e.startedAt)
      || (e.stoppedAt !== null && !isTime(e.stoppedAt))) fail('a console record is malformed');
  }
  return value as Data;
}

function parse(text: string): Data {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('not valid JSON');
  }
  return validate(value);
}

const view = ({ tokenSha256, ...rest }: Device): DeviceView => rest;
const ms = (iso: string) => Date.parse(iso);

function createLanStore(options: Options) {
  const dir = options.dir;
  const now = options.now ?? Date.now;
  const host = options.host ?? require('node:os').hostname();
  const pid = options.pid ?? process.pid;
  const lockWaitMs = options.lockWaitMs ?? LOCK_WAIT_MS;
  const file = path.join(dir, LAN_FILE);
  const lock = `${file}.lock`;
  const unreadable = (reason: string) => new StoreError('store-unreadable', `device store ${file} is unreadable (${reason}); move it aside to start over, every device pairs again`);

  // ---- read side: a stat-keyed cache ----

  let cache: { key: string, data: Data | null, error: string | null } | null = null;
  const statKey = (): string => {
    try {
      const s = fs.statSync(file);
      return `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
    } catch (error: any) {
      return error && error.code === 'ENOENT' ? 'absent' : `error:${error && error.code}`;
    }
  };
  /** The store's current content (reloaded when the file changed on disk) or the reason it cannot be read. */
  function current(): { data: Data } | { error: string } {
    const key = statKey();
    if (cache === null || cache.key !== key) {
      let text: string | null = null;
      let readError: string | null = null;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error: any) {
        if (!error || error.code !== 'ENOENT') readError = `cannot read: ${error && error.code ? error.code : 'error'}`;
      }
      if (readError !== null) {
        cache = { key, data: null, error: readError };
      } else if (text === null) {
        cache = { key, data: emptyData(), error: null };
      } else {
        try {
          cache = { key, data: parse(text), error: null };
        } catch (error: any) {
          cache = { key, data: null, error: error.message };
        }
      }
    }
    const seen = cache as { data: Data | null, error: string | null };
    return seen.error === null ? { data: seen.data as Data } : { error: seen.error };
  }

  // ---- write side: lock, reload, change, rename ----

  const owner = () => JSON.stringify({ pid, host, at: now(), id: crypto.randomBytes(8).toString('hex') });

  function lockIsStale(text: string): boolean {
    try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) return true; } catch { return false; }
    let who: any = null;
    try { who = JSON.parse(text); } catch { /* no readable owner: left to the age rule */ }
    if (!who || !Number.isInteger(who.pid) || who.pid <= 0 || who.host !== host) return false;
    try { process.kill(who.pid, 0); } catch (error: any) { return !!error && error.code === 'ESRCH'; }
    return false;
  }

  /** Moves a stale lock aside, reads it back and deletes it only when it is the one judged stale. */
  function reclaim(): void {
    let text: string;
    try { text = fs.readFileSync(lock, 'utf8'); } catch { return; }
    if (!lockIsStale(text)) return;
    const aside = `${lock}.${pid}.${crypto.randomBytes(4).toString('hex')}.gone`;
    try { fs.renameSync(lock, aside); } catch { return; }
    let moved: string | null = null;
    try { moved = fs.readFileSync(aside, 'utf8'); } catch { /* swept by another writer */ }
    // A fresh lock another writer took since the judgment is linked back and left held.
    if (moved !== null && moved !== text) {
      try { fs.linkSync(aside, lock); } catch { /* another writer took the name */ }
    }
    try { fs.rmSync(aside, { force: true }); } catch { /* the next writer's sweep removes it */ }
  }

  function prepareDir(): void {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  }

  function sweepLeftovers(): void {
    try {
      for (const name of fs.readdirSync(dir)) {
        const leftover = (name.startsWith(`${LAN_FILE}.`) && name.endsWith('.tmp')) || (name.startsWith(`${LAN_FILE}.lock.`) && name.endsWith('.gone'));
        if (!leftover) continue;
        try { if (Date.now() - fs.statSync(path.join(dir, name)).mtimeMs > LEFTOVER_MS) fs.rmSync(path.join(dir, name), { force: true }); } catch { /* gone already */ }
      }
    } catch { /* nothing to sweep */ }
  }

  async function acquire(): Promise<() => void> {
    prepareDir();
    const deadline = Date.now() + lockWaitMs;
    const mine = owner();
    for (;;) {
      try {
        const fd = fs.openSync(lock, 'wx', 0o600);
        try { fs.writeSync(fd, mine); } finally { fs.closeSync(fd); }
        return () => {
          // Only this call's own lock is removed: a lock reclaimed from under a stalled writer is another's.
          try { if (fs.readFileSync(lock, 'utf8') === mine) fs.rmSync(lock, { force: true }); } catch { /* already gone */ }
        };
      } catch (error: any) {
        if (!error || error.code !== 'EEXIST') throw new StoreError('store-busy', `device store lock ${lock} cannot be taken (${error && error.code ? error.code : 'error'})`);
      }
      reclaim();
      if (Date.now() >= deadline) throw new StoreError('store-busy', `device store lock ${lock} is held by another process`);
      await sleep(LOCK_POLL_MS);
    }
  }

  function prune(data: Data, t: number): void {
    data.codes = data.codes.filter((c) => ms(c.expiresAt) > t);
    data.devices = data.devices.filter((d) => (d.revokedAt === null ? t - ms(d.lastSeenAt) <= IDLE_MS : t - ms(d.revokedAt) <= TOMBSTONE_MS));
    data.consoles = data.consoles.filter((e) => t - ms(e.startedAt) <= CONSOLE_KEEP_MS && fs.existsSync(e.project));
  }

  /** Runs `change` on the freshly read, pruned store under the lock; writes only when the content changed. */
  async function mutate<T>(change: (data: Data, t: number) => T): Promise<T> {
    const release = await acquire();
    try {
      sweepLeftovers();
      let text: string | null = null;
      try {
        text = fs.readFileSync(file, 'utf8');
      } catch (error: any) {
        if (!error || error.code !== 'ENOENT') throw unreadable(`cannot read: ${error && error.code ? error.code : 'error'}`);
      }
      let data: Data;
      try {
        data = text === null ? emptyData() : parse(text);
      } catch (error: any) {
        throw unreadable(error.message);
      }
      const before = text === null ? serialize(emptyData()) : serialize(data);
      const t = now();
      prune(data, t);
      const result = change(data, t);
      const after = serialize(data);
      if (after !== before) {
        const temp = `${file}.${pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        const fd = fs.openSync(temp, 'w', 0o600);
        try {
          fs.writeSync(fd, after);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temp, file);
      }
      return result;
    } finally {
      release();
    }
  }

  const load = (): Data => {
    const read = current();
    if ('error' in read) throw unreadable(read.error);
    return read.data;
  };

  return {
    file,
    dir,

    /** Null when the store can be used (absent counts), else why not: LAN boot and the actions refuse on it. */
    check(): string | null {
      const read = current();
      return 'error' in read ? unreadable(read.error).message : null;
    },

    /** Runs `fn` holding the store lock (a boot step that must not interleave with another Console's). `fn` must not call a store write. */
    async withLock<T>(fn: () => T | Promise<T>): Promise<T> {
      const release = await acquire();
      try {
        return await fn();
      } finally {
        release();
      }
    },

    /** A new one-use pairing code of `scope`, valid for 5 minutes, and its expiry (ms). At most 16 stay pending. */
    async mintCode(scope: Scope): Promise<{ code: string, expiresAt: number }> {
      if (!isScope(scope)) throw new Error('scope must be view or control');
      const code = newCode();
      return mutate((data, t) => {
        data.codes.push({ sha256: sha256Hex(code), scope, issuedAt: new Date(t).toISOString(), expiresAt: new Date(t + CODE_TTL_MS).toISOString() });
        while (data.codes.length > MAX_CODES) data.codes.shift();
        return { code, expiresAt: t + CODE_TTL_MS };
      });
    },

    /** Spends `code` for a new device and returns its token (shown once), or why not. Exactly one of two racing calls wins. */
    async consumeCode(code: string, { name, via, address }: { name: string, via: Via, address: string }):
      Promise<{ device: DeviceView, token: string } | { refused: 'pair-refused' | 'device-limit' }> {
      const guess = Buffer.from(sha256Hex(String(code)), 'hex');
      return mutate((data, t) => {
        // Every pending code is compared, so a guess takes the same time whichever it matches.
        let hit = -1;
        data.codes.forEach((c, index) => { if (crypto.timingSafeEqual(guess, Buffer.from(c.sha256, 'hex')) && hit < 0) hit = index; });
        if (hit < 0) return { refused: 'pair-refused' as const };
        if (data.devices.filter((d) => d.revokedAt === null).length >= MAX_DEVICES) return { refused: 'device-limit' as const };
        const [spent] = data.codes.splice(hit, 1);
        const token = `${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
        let id = '';
        do { id = `d-${crypto.randomBytes(6).toString('hex')}`; } while (data.devices.some((d) => d.id === id));
        const stamp = new Date(t).toISOString();
        const device: Device = { id, name: cleanName(name), scope: spent.scope, via, tokenSha256: sha256Hex(token), pairedAt: stamp, lastSeenAt: stamp, lastAddress: String(address), revokedAt: null };
        data.devices.push(device);
        return { device: view(device), token };
      });
    },

    /** The device holding the token whose SHA-256 is `tokenSha256`, or the refusal code (with the device's `id` when it is known). Reads only. */
    verify(tokenSha256: string): { device: DeviceView } | { refused: 'device-revoked' | 'device-expired', id: string } | { refused: 'device-unpaired' | 'store-unreadable' } {
      const read = current();
      if ('error' in read) return { refused: 'store-unreadable' };
      const found = isHex64(tokenSha256) ? read.data.devices.find((d) => d.tokenSha256 === tokenSha256) : undefined;
      if (!found) return { refused: 'device-unpaired' };
      if (found.revokedAt !== null) return { refused: 'device-revoked', id: found.id };
      if (now() - ms(found.lastSeenAt) > IDLE_MS) return { refused: 'device-expired', id: found.id };
      return { device: view(found) };
    },

    /** Records the last-seen time and address of device `id`, only when the stored time is an hour old. True when written. */
    async touch(id: string, address: string): Promise<boolean> {
      const read = current();
      if ('error' in read) return false;
      const known = read.data.devices.find((d) => d.id === id);
      if (!known || known.revokedAt !== null || now() - ms(known.lastSeenAt) < TOUCH_MS) return false;
      return mutate((data, t) => {
        const device = data.devices.find((d) => d.id === id);
        if (!device || device.revokedAt !== null || t - ms(device.lastSeenAt) < TOUCH_MS) return false;
        device.lastSeenAt = new Date(t).toISOString();
        device.lastAddress = String(address);
        return true;
      });
    },

    async revoke(id: string): Promise<'revoked' | 'already' | 'unknown'> {
      return mutate((data, t) => {
        const device = data.devices.find((d) => d.id === id);
        if (!device) return 'unknown' as const;
        if (device.revokedAt !== null) return 'already' as const;
        device.revokedAt = new Date(t).toISOString();
        return 'revoked' as const;
      });
    },

    /** Every device with its derived state (`active`, `expired`, `revoked`), no token digests. Reads only. */
    list(): Array<DeviceView & { state: 'active' | 'expired' | 'revoked' }> {
      const t = now();
      return load().devices.map((d) => ({ ...view(d), state: d.revokedAt !== null ? 'revoked' as const : t - ms(d.lastSeenAt) > IDLE_MS ? 'expired' as const : 'active' as const }));
    },

    /** Records this process as the Console of `entry.project` (one entry per project). */
    async registerConsole(entry: { project: string, address: string, port: number, fingerprint: string }): Promise<void> {
      if (!path.isAbsolute(entry.project) || !Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535 || !isHex64(entry.fingerprint)) {
        throw new Error('console entry needs an absolute project, a port and a 64-hex fingerprint');
      }
      await mutate((data, t) => {
        data.consoles = data.consoles.filter((e) => e.project !== entry.project);
        data.consoles.push({ project: entry.project, address: entry.address, port: entry.port, fingerprint: entry.fingerprint, host, pid, startedAt: new Date(t).toISOString(), stoppedAt: null });
      });
    },

    /** Marks the entry of `project` stopped when it is `pid`'s on this host. The entry stays: it remembers the port. */
    async stopConsole(project: string, stoppedPid: number = pid): Promise<void> {
      await mutate((data, t) => {
        const entry = data.consoles.find((e) => e.project === project && e.pid === stoppedPid && e.host === host);
        if (entry && entry.stoppedAt === null) entry.stoppedAt = new Date(t).toISOString();
      });
    },

    /** Entries not stopped whose process is alive on this host. Reads only. */
    liveConsoles(): ConsoleEntry[] {
      return load().consoles.filter((e) => {
        if (e.stoppedAt !== null || e.host !== host) return false;
        try { process.kill(e.pid, 0); return true; } catch (error: any) { return !!error && error.code === 'EPERM'; }
      });
    },

    /** The port `project`'s Console used last, running or not, else null. */
    rememberedPort(project: string): number | null {
      const entry = load().consoles.find((e) => e.project === project);
      return entry ? entry.port : null;
    },
  };
}

module.exports = {
  createLanStore, StoreError, cleanName, sha256Hex, newCode,
  CODE_TTL_MS, IDLE_MS, TOUCH_MS, TOMBSTONE_MS, CONSOLE_KEEP_MS, MAX_CODES, MAX_DEVICES, NAME_MAX, LAN_FILE, TOKEN_PREFIX,
};
