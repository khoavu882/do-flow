'use strict';

// Opt-in capture of a routing decision's input (180 IC-180-G1, design section 8). With the user-level setting
// `advice.capture.state-text` on, each pick of a routing kind also writes one line holding the masked state, cut to
// MAX_TEXT_BYTES at a code-point boundary, to `advice/state-text/<YYYY-MM-DD>.jsonl` in the store the pick went to.
// The setting is `narrow-only`: a project file can turn it off but never on, so a checked-in file cannot start capture.
// With it off nothing is written and the state is never read. Capture is an observer: it never throws, so a failure
// never changes the pick or the answer.
//
// Local-only: the store is read by this file's `readCaptured`, for the `captured-state` replay case source, and by
// nothing else; no export, bundle, telemetry or off-machine reader names it (a source scan in
// test/runtime/advice/state-text.test.ts). Retention is the store's 30 days (core/registry/storage.json).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveStorePath } = require('../storage/roots.ts');
const { maskBody } = require('../mask.ts');

const ROUTING_KINDS: readonly string[] = Object.freeze(['tier', 'task-class', 'verify-risk', 'review-depth', 'mcp-need']);
const STORE_PATH = 'advice/state-text';
const MAX_TEXT_BYTES = 4096;
const RETAINED_DAYS = 30;
const PARTITION_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

// The resolved setting per (config home, project), read once per process on the real file system.
const ENABLED_MEMO = new Map<string, boolean>();

/** Forgets the memoised setting (tests; a process that changed the settings files). */
function resetCaptureSetting(): void {
  ENABLED_MEMO.clear();
}

/** Whether capture is on for these roots: the setting's project view (user, narrowed by the project), or its global view. */
function captureEnabled({ roots, settings, fsImpl = fs }: any = {}): boolean {
  try {
    const projectRoot = roots?.['project-doflow'] ? path.dirname(roots['project-doflow']) : null;
    const view = projectRoot ? 'project' : 'global';
    if (settings) return settings.get('advice.capture.state-text', view).value === true;
    const memoKey = fsImpl === fs ? JSON.stringify([roots?.['config-home'] ?? null, projectRoot]) : null;
    if (memoKey && ENABLED_MEMO.has(memoKey)) return ENABLED_MEMO.get(memoKey)!;
    // The config home the roots were resolved with, as storage/roots.ts reads storage.prune.
    const resolverEnv: Record<string, string> = {};
    if (roots?.['config-home']) resolverEnv.XDG_CONFIG_HOME = path.dirname(roots['config-home']);
    const { loadSettings, registryOn } = require('../settings/resolve.ts');
    const loaded = loadSettings({ projectRoot, global: !projectRoot, env: resolverEnv, fsImpl, ...registryOn(fsImpl) });
    const enabled = loaded.get('advice.capture.state-text', view).value === true;
    if (memoKey) ENABLED_MEMO.set(memoKey, enabled);
    return enabled;
  } catch {
    return false;
  }
}

/** `text` cut to at most `maxBytes` UTF-8 bytes, never inside a character. */
function cutToBytes(text: string, maxBytes: number = MAX_TEXT_BYTES): { text: string; bytes: number; cut: boolean } {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= maxBytes) return { text, bytes: buffer.length, cut: false };
  let end = maxBytes;
  // A continuation byte (10xxxxxx) at `end` means the character starting before it does not fit: back off to its lead byte.
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return { text: buffer.subarray(0, end).toString('utf8'), bytes: end, cut: true };
}

function isoTime(at: any): string | null {
  const value = typeof at === 'function' ? at() : at ?? new Date();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * One capture line for the pick `pickId` in `store` (`project-state` or `user-state`), or null when nothing was written:
 * not a routing kind, capture off, no store, a link in the way, or any failure. `state` is read only once capture is on.
 */
function captureState(input: any = {}): { file: string } | null {
  try {
    const { roots, pickId, kind, store, settings, fsImpl = fs } = input;
    if (!ROUTING_KINDS.includes(kind) || typeof pickId !== 'string' || !roots?.[store]) return null;
    if (!captureEnabled({ roots, settings, fsImpl })) return null;
    const state = input.state;
    if (typeof state !== 'string') return null;
    const at = isoTime(input.at);
    if (!at) return null;
    const directory = resolveStorePath({ store: { root: store, path: STORE_PATH }, roots, fsImpl });
    if (!directory) return null;
    const file = path.join(directory, `${at.slice(0, 10)}.jsonl`);
    try { if (fsImpl.lstatSync(file).isSymbolicLink()) return null; }
    catch (error: any) { if (error.code !== 'ENOENT') return null; }
    const kept = cutToBytes(maskBody(state).text);
    const line = {
      schema: 1, pickId, kind, at,
      stateDigest: `sha256:${crypto.createHash('sha256').update(state, 'utf8').digest('hex')}`,
      text: kept.text, textBytes: kept.bytes, cut: kept.cut,
    };
    fsImpl.mkdirSync(directory, { recursive: true });
    // One whole line through an O_APPEND descriptor, as record.ts writes picks; created readable by this user only.
    fsImpl.appendFileSync(file, `${JSON.stringify(line)}\n`, { encoding: 'utf8', mode: 0o600 });
    return { file };
  } catch {
    return null;
  }
}

/**
 * The captured lines of `kind` inside the retained window, from both stores; `unreadable` counts the partitions and lines
 * that could not be read or are not a capture line. Read-only, and a link is never followed.
 */
function readCaptured({ roots, kind, now = () => new Date(), fsImpl = fs }: any = {}): { lines: any[]; unreadable: number } {
  const lines: any[] = [];
  let unreadable = 0;
  const today = isoTime(now);
  if (!today) return { lines, unreadable };
  const cutoff = new Date(Date.parse(today) - RETAINED_DAYS * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  for (const store of ['project-state', 'user-state']) {
    if (!roots?.[store]) continue;
    const directory = resolveStorePath({ store: { root: store, path: STORE_PATH }, roots, fsImpl });
    if (!directory) continue;
    let names: string[];
    try { names = fsImpl.readdirSync(directory).filter((name: string) => PARTITION_NAME.test(name) && name.slice(0, 10) >= cutoff).sort(); }
    catch { continue; }
    for (const name of names) {
      const file = path.join(directory, name);
      let contents: string;
      try {
        if (!fsImpl.lstatSync(file).isFile()) { unreadable += 1; continue; }
        contents = fsImpl.readFileSync(file, 'utf8');
      } catch { unreadable += 1; continue; }
      for (const text of contents.split('\n')) {
        if (!text.trim()) continue;
        let line: any;
        try { line = JSON.parse(text); } catch { unreadable += 1; continue; }
        if (!line || line.schema !== 1 || typeof line.pickId !== 'string' || typeof line.text !== 'string' || typeof line.stateDigest !== 'string') {
          unreadable += 1;
          continue;
        }
        if (line.kind === kind) lines.push(line);
      }
    }
  }
  return { lines, unreadable };
}

module.exports = { captureState, captureEnabled, readCaptured, cutToBytes, resetCaptureSetting, ROUTING_KINDS, MAX_TEXT_BYTES };
