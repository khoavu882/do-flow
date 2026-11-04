'use strict';

// Launch code and session (design C3; FR-003; 092 IC-011). One 256-bit code per store, valid for
// 5 min and exchanged once for a 256-bit session token; tokens live in this process's memory only and
// die with it (no re-mint, no persistence). Codes and tokens are compared as SHA-256 digests, so every
// guess, of any length, takes the same single `timingSafeEqual` over two 32-byte buffers. Nothing here
// logs: the code's one appearance is the stdout line C.1 prints from `mintLaunchCode()` (IC-002).

const crypto = require('node:crypto');

const LAUNCH_CODE_TTL_MS = 5 * 60 * 1000;
const PHONE_SESSION_TTL_MS = 72 * 60 * 60 * 1000;
const SECRET_BYTES = 32;

type Session = Readonly<{ scope: 'read' | 'phone' }>;
type Sessions = {
  mintLaunchCode(): string,
  exchange(code: string): string | null,
  verify(token: unknown): Session | null,
};

const digest = (value: string) => crypto.createHash('sha256').update(value, 'utf8').digest();

function createSessions(options: { now?: () => number, ttlMs?: number, scope?: Session['scope'], sessionTtlMs?: number } = {}): Sessions {
  const now = options.now ?? Date.now;
  // ttlMs intentionally remains the one-use launch-code TTL.
  const ttlMs = options.ttlMs ?? LAUNCH_CODE_TTL_MS;
  const scope = options.scope ?? 'read';
  const sessionTtlMs = options.sessionTtlMs ?? (scope === 'phone' ? PHONE_SESSION_TTL_MS : undefined);
  let minted = false;
  let code: { hash: any, expiresAt: number } | null = null;
  // Keyed by the token's SHA-256 hex, so the token itself is never held.
  const sessions = new Map<string, { session: Session, expiresAt?: number }>();

  return {
    mintLaunchCode() {
      if (minted) throw new Error('the launch code is minted once per process');
      minted = true;
      const value = crypto.randomBytes(SECRET_BYTES).toString('hex');
      code = { hash: digest(value), expiresAt: now() + ttlMs };
      return value;
    },
    exchange(guess: string) {
      // With no live code the guess is still compared, against a random digest, so the path is the same.
      const expected = code ? code.hash : crypto.randomBytes(SECRET_BYTES);
      const equal = crypto.timingSafeEqual(digest(String(guess)), expected);
      if (!code || !equal) return null;
      const live = now() < code.expiresAt;
      code = null; // a matched code is spent whether or not it was still live
      if (!live) return null;
      const token = crypto.randomBytes(SECRET_BYTES).toString('hex');
      const session: Session = Object.freeze({ scope });
      sessions.set(digest(token).toString('hex'), {
        session,
        ...(sessionTtlMs === undefined ? {} : { expiresAt: now() + sessionTtlMs }),
      });
      return token;
    },
    verify(token: unknown) {
      if (typeof token !== 'string' || token === '') return null;
      const key = digest(token).toString('hex');
      const entry = sessions.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== undefined && now() >= entry.expiresAt) {
        sessions.delete(key);
        return null;
      }
      return entry.session;
    },
  };
}

// The process's store: C.1 calls `mintLaunchCode()` once at boot, ROUTES checks against the same store.
const processSessions = createSessions();
const mintLaunchCode = () => processSessions.mintLaunchCode();

const cookieName = (port: number) => `doflow_ui_${port}`;

// No Max-Age or Expires: a browser-session cookie whose server-side session dies with the process.
const sessionCookie = (port: number, token: string, secure = false) => `${cookieName(port)}=${token}; HttpOnly; SameSite=Strict; Path=/${secure ? '; Secure' : ''}`;

// The value of cookie `name` in a Cookie header, or null.
function readCookie(header: unknown, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq).trim() === name) return pair.slice(eq + 1).trim();
  }
  return null;
}

module.exports = { createSessions, processSessions, mintLaunchCode, cookieName, sessionCookie, readCookie, LAUNCH_CODE_TTL_MS, PHONE_SESSION_TTL_MS };
