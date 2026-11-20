'use strict';

// 180 IC-180-E3: the default `readStored` of a hook-state session-effort source. It reads the one file the shared bridge
// step observe-effort.sh writes, <config home>/doflow/session-env/effort/<sessionKey>.json, and takes it only with the
// exact six keys, schema 1, the asked harness and session key, and a regular file in place (never a link). Scratch
// config homes and fixture files only.

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createScratch } = require('../../helper/scratch-env.ts');
const { readStoredEffort, storedEffortReader } = require('../../../src/runtime/context/effort-store.ts');

const scratch = createScratch('doflow-effort-store-');
after(() => scratch.remove());

const KEY = '0123456789abcdef';
const record = (extra: any = {}) => ({ schema: 1, harness: 'alpha', level: 'xhigh', event: 'PreToolUse', observedAt: '2026-11-20T10:00:00Z', session: KEY, ...extra });
let n = 0;
/** A fresh store root holding `value` (an object is written as one JSON line, a string as is) under `key`. */
function root(value: any, key = KEY): string {
  const dir = path.join(scratch.dir, `root-${n++}`);
  fs.mkdirSync(path.join(dir, 'effort'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'effort', `${key}.json`), typeof value === 'string' ? value : `${JSON.stringify(value)}\n`);
  return dir;
}
const read = (dir: string | null, extra: any = {}) => readStoredEffort({ root: dir, harness: 'alpha', sessionKey: KEY, ...extra });

test('a well-formed record gives its level and observedAt', () => {
  assert.deepEqual(read(root(record())), { level: 'xhigh', observedAt: '2026-11-20T10:00:00Z' });
});

test('a missing store, file or root reads as nothing stored', () => {
  assert.equal(read(null), null);
  assert.equal(read(path.join(scratch.dir, 'absent')), null);
  assert.equal(read(root(record()), { sessionKey: 'fedcba9876543210' }), null);
});

test('a record without the exact six keys, schema 1, the asked harness or session key is refused', () => {
  const { event, ...five } = record();
  for (const [label, value] of [
    ['five keys', five], ['a seventh key', record({ extra: 1 })], ['schema 2', record({ schema: 2 })],
    ['another harness', record({ harness: 'beta' })], ['another session', record({ session: 'fedcba9876543210' })],
    ['a non-string level', record({ level: 3 })], ['an empty level', record({ level: '' })], ['an empty event', record({ event: '' })],
    ['a bad observedAt', record({ observedAt: 'yesterday' })], ['an array', [record()]],
  ] as const) assert.equal(read(root(value)), null, label);
  assert.equal(read(root('{"schema":1,')), null, 'unparsable JSON');
});

test('a malformed session key is refused before any path is built', () => {
  assert.equal(read(root(record(), '..'), { sessionKey: '..' }), null);
  assert.equal(read(root(record({ session: 'ABCDEF0123456789' }), 'ABCDEF0123456789'), { sessionKey: 'ABCDEF0123456789' }), null);
});

test('a link in place of the file is never followed', { skip: process.platform === 'win32' }, () => {
  const dir = root(record());
  const file = path.join(dir, 'effort', `${KEY}.json`);
  const target = path.join(dir, 'target.json');
  fs.renameSync(file, target);
  fs.symlinkSync(target, file);
  assert.equal(read(dir), null);
});

test('storedEffortReader reads under the config home of the env it is given, and nothing with no config home', () => {
  const env = scratch.env();
  const file = path.join(env.XDG_CONFIG_HOME, 'doflow', 'session-env', 'effort', `${KEY}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record())}\n`);
  const before = Date.parse('2026-11-20T09:00:00Z');
  assert.deepEqual(storedEffortReader(env, { startedAt: before })({ harness: 'alpha', sessionKey: KEY }), { level: 'xhigh', observedAt: '2026-11-20T10:00:00Z' });
  assert.equal(storedEffortReader({ HOME: '', XDG_CONFIG_HOME: '' }, { startedAt: before })({ harness: 'alpha', sessionKey: KEY }), null);
});

test('storedEffortReader takes a record observed since the reading process started (whole seconds), and none from before', () => {
  const env = scratch.env();
  const file = path.join(env.XDG_CONFIG_HOME, 'doflow', 'session-env', 'effort', `${KEY}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(record())}\n`);
  const at = (iso: string) => storedEffortReader(env, { startedAt: Date.parse(iso) })({ harness: 'alpha', sessionKey: KEY });
  assert.equal(at('2026-11-20T10:00:00.900Z')?.level, 'xhigh', 'observed in the second the process started');
  assert.equal(at('2026-11-20T10:00:01Z'), null, 'observed before the process started: the environment is newer');
  const recent = { ...record(), observedAt: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString().replace('.000Z', 'Z') };
  fs.writeFileSync(file, `${JSON.stringify(recent)}\n`);
  assert.equal(storedEffortReader(env)({ harness: 'alpha', sessionKey: KEY })?.level, 'xhigh', 'by default, since this process started');
});
