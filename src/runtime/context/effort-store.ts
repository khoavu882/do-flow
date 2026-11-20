'use strict';

// 180 IC-180-E3: the default `readStored` of a hook-state session-effort source (session-effort.ts stays file-free). It
// reads the one file the shared bridge step observe-effort.sh writes for a main session,
// <config home>/doflow/session-env/effort/<sessionKey>.json, holding exactly
//   {"schema":1,"harness":"<id>","level":"<level>","event":"<event>","observedAt":"<UTC>","session":"<sessionKey>"}
// A record of another shape, harness or session, a link in place of the file, or any read error is nothing stored.
// The level is passed on as written: the session reader checks it against the harness's levels. The
// `effort-observations` store in core/registry/storage.json owns the folder's lifetime.
// Freshness: an environment level is the level when this process (or the shell it came from) started, and the file is
// written only when the level changes, so a record observed before this process started is older than the environment's
// level and is nothing stored (the env source decides); one observed since is newer and wins. observedAt has whole
// seconds, so the start is compared at whole seconds too.

const fs = require('node:fs');
const path = require('node:path');
const { stateDir } = require('./identity.ts');

import type { ReadStored, StoredEffort } from './session-effort.ts';

const KEYS = 'event,harness,level,observedAt,schema,session';
const KEY_RE = /^[0-9a-f]{16}$/;
const AT_RE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/;

/** The stored level of one session, or null. `root` is the session-env folder (stateDir). */
function readStoredEffort({ root, harness, sessionKey, fsImpl = fs }: {
  root: string | null; harness: string; sessionKey: string; fsImpl?: typeof fs;
}): StoredEffort | null {
  try {
    if (typeof root !== 'string' || typeof sessionKey !== 'string' || !KEY_RE.test(sessionKey)) return null;
    const file = path.join(root, 'effort', `${sessionKey}.json`);
    if (!fsImpl.lstatSync(file).isFile()) return null;
    const value = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== KEYS) return null;
    if (value.schema !== 1 || value.harness !== harness || value.session !== sessionKey) return null;
    if (typeof value.level !== 'string' || value.level === '' || typeof value.event !== 'string' || value.event === '') return null;
    if (typeof value.observedAt !== 'string' || !AT_RE.test(value.observedAt) || !Number.isFinite(Date.parse(value.observedAt))) return null;
    return { level: value.level, observedAt: value.observedAt };
  } catch {
    return null;
  }
}

/** A `readStored` bound to the config home of `env` (none: every read is nothing stored) that takes only a record
 * observed since `startedAt` (ms; default this process's start). */
function storedEffortReader(env: Record<string, string | undefined>, { startedAt = Date.now() - process.uptime() * 1000 }: { startedAt?: number } = {}): ReadStored {
  const root = stateDir(env);
  const since = Math.floor(startedAt / 1000) * 1000;
  return ({ harness, sessionKey }) => {
    const stored = readStoredEffort({ root, harness, sessionKey });
    return stored !== null && Date.parse(stored.observedAt) >= since ? stored : null;
  };
}

module.exports = { readStoredEffort, storedEffortReader };
