'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const dns = require('node:dns');

function displayEndpoint(value: any): string {
  return typeof value === 'string' ? value : String(value ?? '');
}

function ipv4Octets(address: any): number[] | null {
  if (typeof address !== 'string' || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) return null;
  const octets = address.split('.').map(Number);
  return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : null;
}

function ipv6Words(address: any): number[] | null {
  if (typeof address !== 'string' || !address.includes(':')) return null;
  let value = address.toLowerCase();
  if (value.includes('.')) {
    const lastColon = value.lastIndexOf(':');
    const octets = ipv4Octets(value.slice(lastColon + 1));
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    value = `${value.slice(0, lastColon + 1)}${high}:${low}`;
  }
  const doubleColon = value.indexOf('::');
  if (doubleColon !== -1 && value.indexOf('::', doubleColon + 2) !== -1) return null;
  let words: string[];
  if (doubleColon === -1) {
    words = value.split(':');
    if (words.length !== 8) return null;
  } else {
    const left = value.slice(0, doubleColon) ? value.slice(0, doubleColon).split(':') : [];
    const right = value.slice(doubleColon + 2) ? value.slice(doubleColon + 2).split(':') : [];
    const zeros = 8 - left.length - right.length;
    if (zeros < 1) return null;
    words = [...left, ...Array(zeros).fill('0'), ...right];
  }
  if (words.length !== 8 || words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))) return null;
  return words.map((word) => Number.parseInt(word, 16));
}

function isLoopback(address: any): boolean {
  const octets = ipv4Octets(address);
  if (octets) return octets[0] === 127;
  const words = ipv6Words(address);
  if (!words) return false;
  if (words.slice(0, 7).every((word) => word === 0) && words[7] === 1) return true;
  const mapped = words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (!mapped) return false;
  return (words[6] >> 8) === 127;
}

function literalFamily(address: any): 4 | 6 {
  return ipv4Octets(address) ? 4 : 6;
}

function isLiteralIp(host: any): boolean {
  return Boolean(ipv4Octets(host) || ipv6Words(host));
}

function refuse(value: any, file?: string): { ok: false; message: string } {
  return {
    ok: false,
    message: `decision model: endpoint ${value} refused: only loopback addresses are allowed (127.0.0.0/8, ::1); set in ${file || 'provider default'}`,
  };
}

/** `signal`, when given, ends the lookup the way its timeout does; an already-aborted signal skips the lookup. */
function lookupAll(host: string, lookup: any, timeoutMs?: number, signal?: any): Promise<any> {
  return new Promise((resolve, reject) => {
    const aborted = () => Object.assign(new Error('decision model DNS validation aborted by the caller'), { code: 'ADVICE_TIMEOUT' });
    if (signal?.aborted) { reject(aborted()); return; }
    let settled = false;
    const onAbort = () => finish(aborted());
    const finish = (error: any, addresses?: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      if (error) reject(error);
      else resolve(addresses);
    };
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => {
      finish(Object.assign(new Error('decision model DNS validation timed out'), { code: 'ADVICE_TIMEOUT' }));
    }, Math.max(0, timeoutMs as number)) : undefined;
    signal?.addEventListener?.('abort', onAbort, { once: true });
    try {
      const returned = lookup(host, { all: true, verbatim: true }, finish);
      if (returned && typeof returned.then === 'function') returned.then((addresses: any) => finish(null, addresses), finish);
      else if (Array.isArray(returned)) finish(null, returned);
    } catch (error) {
      finish(error);
    }
  });
}

function pinnedLookup(address: string, family: number) {
  return (hostname: string, options: any, callback?: any) => {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }
    if (typeof callback !== 'function') throw new TypeError('lookup callback is required');
    if (options?.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
}

async function checkEndpoint(value: any, { lookup = dns.lookup, file, timeoutMs, signal }: any = {}): Promise<any> {
  const display = displayEndpoint(value);
  let url: any;
  try { url = new URL(display); } catch { return refuse(display, file); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return refuse(display, file);

  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isLiteralIp(host)) {
    if (!isLoopback(host)) return refuse(display, file);
    const family = literalFamily(host);
    return { ok: true, address: host, family, pinnedLookup: pinnedLookup(host, family) };
  }

  let addresses: any;
  try { addresses = await lookupAll(host, lookup, timeoutMs, signal); } catch (error: any) {
    if (error?.code === 'ADVICE_TIMEOUT') return { ok: false, reason: 'timeout', message: error.message };
    return refuse(display, file);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) return refuse(display, file);
  const checked: any[] = addresses.map((entry: any) => {
    if (!entry || typeof entry.address !== 'string') return null;
    return { address: entry.address, family: literalFamily(entry.address) };
  });
  if (checked.some((entry: any) => !entry || !isLoopback(entry.address))) return refuse(display, file);
  const first = checked[0];
  return { ok: true, address: first.address, family: first.family, pinnedLookup: pinnedLookup(first.address, first.family) };
}

module.exports = { checkEndpoint };
