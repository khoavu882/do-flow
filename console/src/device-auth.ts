'use strict';

// Paired-device authentication and the pairing route for LAN mode (feature 160, IC-005 to IC-007).
// `authenticate(ctx)` reads the one credential a request's class allows (cookie for a browser, Bearer for a
// native client; server.ts has already refused both together), asks the store (stat-keyed, so a revoke
// from any process is seen on the next request), writes last-seen at most hourly and hands the handler a
// frozen `{ scope, deviceId }` session, one object per device per process. `pairRoute()` is `POST /api/pair`,
// the only route reachable without a device. Secrets (codes, tokens, digests, cookies, bodies) are never
// logged or echoed: `log` receives the event lines of design IC-008 and nothing else.

const { errorReply, jsonReply, readBody } = require('./routes.ts');
const { readCookie, DEVICE_COOKIE } = require('./session.ts');
const { sha256Hex, cleanName, StoreError } = require('./lan-store.ts');

const COOKIE_MAX_AGE_S = 30 * 24 * 60 * 60;
const BODY_CAP = 1024;
const NAME_RAW_MAX = 120;
const WINDOW_MS = 10 * 60 * 1000;
const FAILS_PER_ADDRESS = 5;
const FAILS_OVERALL = 20;
const LOG_EVERY_MS = 60_000;
const TOKEN = /^dfd1_[A-Za-z0-9_-]{43}$/;
const BEARER = /^Bearer (dfd1_[A-Za-z0-9_-]{43})$/;
const CODE = /^[a-z2-7]{26}$/;

type Reply = { status: number, headers?: Record<string, string>, body?: string | Uint8Array };
type Session = Readonly<{ scope: 'view' | 'control', deviceId: string }>;
type Window = { start: number, count: number };

const deviceCookie = (token: string) => `${DEVICE_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_S}`;
const clearingCookie = () => `${DEVICE_COOKIE}=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`;
const withCookie = (reply: Reply, cookie: string): Reply => ({ ...reply, headers: { ...reply.headers, 'Set-Cookie': cookie } });

/** `{ mode: 'lan', authenticate, pairRoute }` over `store` (lan-store.ts). `log(line)` gets IC-008's event lines without the `doflow ui: ` prefix. */
function createDeviceAuth({ store, now = Date.now, log = () => {} }: { store: any, now?: () => number, log?: (line: string) => void }) {
  const sessions = new Map<string, Session>();
  const sessionFor = (device: { id: string, scope: 'view' | 'control' }): Session => {
    const key = `${device.id}:${device.scope}`;
    let session = sessions.get(key);
    if (!session) {
      session = Object.freeze({ scope: device.scope, deviceId: device.id });
      sessions.set(key, session);
    }
    return session;
  };

  // Each kind of line is said at most once per key (per minute where the design says so).
  const said = new Map<string, number>();
  const sayOnce = (key: string, line: string, everyMs = Infinity) => {
    const t = now();
    const last = said.get(key);
    if (last !== undefined && t - last < everyMs) return;
    said.set(key, t);
    if (said.size > 512) for (const [name, at] of said) if (t - at >= LOG_EVERY_MS) said.delete(name);
    log(line);
  };

  const tokenOf = (ctx: any): string | null => {
    const headers = ctx.req.headers;
    if (ctx.clientClass === 'native') {
      const match = BEARER.exec(typeof headers.authorization === 'string' ? headers.authorization : '');
      return match ? match[1] : null;
    }
    const cookie = readCookie(headers.cookie, DEVICE_COOKIE);
    return cookie !== null && TOKEN.test(cookie) ? cookie : null;
  };

  async function authenticate(ctx: any): Promise<{ session: Session, refresh?: string } | { reply: Reply }> {
    const browser = ctx.clientClass !== 'native';
    const token = tokenOf(ctx);
    if (token === null) return { reply: errorReply(401, 'device-unpaired') };
    const result = store.verify(sha256Hex(token));
    if ('device' in result) {
      let refresh: string | undefined;
      try {
        const address = ctx.req.socket && typeof ctx.req.socket.remoteAddress === 'string' ? ctx.req.socket.remoteAddress : '';
        if (await store.touch(result.device.id, address) && browser) refresh = deviceCookie(token);
      } catch (error: any) {
        sayOnce('touch', `lan entry not updated: ${error && error.code ? error.code : 'error'}`, LOG_EVERY_MS);
      }
      return { session: sessionFor(result.device), ...(refresh ? { refresh } : {}) };
    }
    switch (result.refused) {
      case 'store-unreadable':
        sayOnce('unreadable', `device store unreadable: ${store.check() ?? 'cannot be read'}`, LOG_EVERY_MS);
        return { reply: errorReply(503, 'store-unreadable') };
      case 'device-revoked':
      case 'device-expired': {
        sayOnce(`refused:${result.id}`, `device ${result.id} refused: ${result.refused === 'device-revoked' ? 'revoked' : 'expired'}`);
        const reply = errorReply(401, result.refused);
        return { reply: browser ? withCookie(reply, clearingCookie()) : reply };
      }
      default:
        return { reply: errorReply(401, 'device-unpaired') };
    }
  }

  // ---- POST /api/pair ----

  let overall: Window = { start: 0, count: 0 };
  const byAddress = new Map<string, Window>();
  const fresh = (entry: Window | undefined, t: number): Window => (entry && t - entry.start < WINDOW_MS ? entry : { start: t, count: 0 });
  const retryAfter = (entry: Window, t: number) => Math.max(1, Math.ceil((entry.start + WINDOW_MS - t) / 1000));

  /** Seconds to wait when this address or the Console as a whole has used up its failed codes, else null. */
  function waitFor(address: string, t: number): number | null {
    overall = fresh(overall, t);
    const mine = fresh(byAddress.get(address), t);
    if (mine.count >= FAILS_PER_ADDRESS) return retryAfter(mine, t);
    if (overall.count >= FAILS_OVERALL) return retryAfter(overall, t);
    return null;
  }

  function recordFailure(address: string, t: number): void {
    overall = fresh(overall, t);
    const mine = fresh(byAddress.get(address), t);
    overall.count += 1;
    mine.count += 1;
    byAddress.set(address, mine);
    for (const [name, entry] of byAddress) if (t - entry.start >= WINDOW_MS) byAddress.delete(name);
    sayOnce(`pair:${address}`, `pairing refused from ${address} (${mine.count} in this window)`, LOG_EVERY_MS);
    if (mine.count === FAILS_PER_ADDRESS) log(`pairing paused for ${retryAfter(mine, t)} s: too many failed codes`);
    else if (overall.count === FAILS_OVERALL) log(`pairing paused for ${retryAfter(overall, t)} s: too many failed codes`);
  }

  function pairRoute() {
    return {
      method: 'POST' as const,
      path: '/api/pair',
      handler: async (ctx: any): Promise<Reply> => {
        const address = ctx.req.socket && typeof ctx.req.socket.remoteAddress === 'string' ? ctx.req.socket.remoteAddress : '';
        const wait = waitFor(address, now());
        if (wait !== null) return withHeader(errorReply(429, 'pair-rate-limited'), 'Retry-After', String(wait));
        const text = await readBody(ctx.req, BODY_CAP);
        let body: any = null;
        try {
          body = text === null ? null : JSON.parse(text);
        } catch { /* a body that is not JSON is a usage error */ }
        if (body === null || typeof body !== 'object' || Array.isArray(body)
          || Object.keys(body).sort().join() !== 'code,name,v' || body.v !== 1
          || typeof body.code !== 'string' || typeof body.name !== 'string' || body.name.length > NAME_RAW_MAX) return errorReply(400, 'usage');
        const code = body.code.toLowerCase();
        if (!CODE.test(code)) return errorReply(400, 'usage');
        const via = ctx.clientClass === 'native' ? 'native' : 'browser';
        let result: any;
        try {
          result = await store.consumeCode(code, { name: cleanName(body.name), via, address });
        } catch (error: any) {
          if (error instanceof StoreError) {
            if (error.code === 'store-unreadable') sayOnce('unreadable', `device store unreadable: ${store.check() ?? 'cannot be read'}`, LOG_EVERY_MS);
            return errorReply(503, error.code);
          }
          throw error;
        }
        if ('refused' in result) {
          if (result.refused === 'device-limit') return errorReply(409, 'device-limit');
          recordFailure(address, now());
          return errorReply(401, 'pair-refused');
        }
        const { device, token } = result;
        log(`paired ${device.id} "${device.name}" scope ${device.scope} via ${via} from ${address}`);
        const shown = { v: 1, device: { id: device.id, name: device.name, scope: device.scope } };
        return via === 'native'
          ? jsonReply(200, { ...shown, token })
          : withCookie(jsonReply(200, shown), deviceCookie(token));
      },
    };
  }

  return { mode: 'lan' as const, authenticate, pairRoute };
}

function withHeader(reply: Reply, name: string, value: string): Reply {
  return { ...reply, headers: { ...reply.headers, [name]: value } };
}

module.exports = { createDeviceAuth, deviceCookie, clearingCookie, COOKIE_MAX_AGE_S };
