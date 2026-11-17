'use strict';

// Row 170 (design D3, IC-003; owner ruling R-10): the spool of one started session's control channel,
// `<main>/.doflow/state/channel-spool/<runId>/`. A verb drops one message file; the session's supervisor takes it,
// deletes it and writes the record to the harness's stdin. This module is the spool's only fs writer (store
// `channel-spool` in core/registry/storage.json).
//
// Bounds: the directory is 0700 and each file 0600, at most 64 KiB, created `wx` under a `.tmp` name and renamed, so a
// reader never sees half a file. Nothing here follows a link: the store directory and the run's directory are checked
// with lstat, and a message file is opened with O_NOFOLLOW (plus O_NONBLOCK, so a planted FIFO cannot block the
// reader) after an lstat that refuses anything but a regular file. Windows has no O_NOFOLLOW: the flag is used where
// the platform defines it, and the lstat check runs everywhere (designed for, not run on Windows).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { RUN_ID } = require('./run-store.ts');

const STORE = 'channel-spool';
/** IC-003: the most bytes one message file holds. */
const FILE_MAX = 64 * 1024;
/** The most files one take reads; the rest wait for the next one. */
const TAKE_MAX = 16;
const NAME = /^([0-9]{1,16})-([0-9a-f]{8})\.json$/;
const KINDS = Object.freeze(['follow-up', 'steer', 'stop']);
const NOFOLLOW: number = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
const NONBLOCK: number = typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0;

type Message = { v: 1; kind: 'follow-up' | 'steer' | 'stop'; requestId: string | null; by: string; at: string; text?: string };
type Taken = { name: string; ok: true; message: Message } | { name: string; ok: false; reason: string };

class SpoolError extends Error {
  declare code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SpoolError';
    this.code = code;
  }
}

function storeDir(root: string): string { return path.join(root, '.doflow', 'state', STORE); }

/** `<root>/.doflow/state/channel-spool/<runId>`; a malformed run id throws. */
function spoolDir(root: string, runId: string): string {
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) throw new SpoolError('usage', `run id '${runId}' is not 'w-' plus 12 hex characters`);
  return path.join(storeDir(root), runId);
}

/** 'dir' for a real directory, 'absent', or 'unsafe' for a link or anything else at `p` (lstat: never follows). */
function kindAt(p: string): 'dir' | 'absent' | 'unsafe' {
  try {
    const info = fs.lstatSync(p);
    return info.isDirectory() && !info.isSymbolicLink() ? 'dir' : 'unsafe';
  } catch (error: any) {
    if (error?.code === 'ENOENT') return 'absent';
    throw error;
  }
}

/** The run's spool directory when it and the store directory are real directories; null when either is absent. */
function existingDir(root: string, runId: string): string | null {
  const dir = spoolDir(root, runId);
  for (const p of [storeDir(root), dir]) {
    const kind = kindAt(p);
    if (kind === 'absent') return null;
    if (kind === 'unsafe') throw new SpoolError('spool-unsafe', `${p} is not a directory`);
  }
  return dir;
}

/** Creates the run's spool directory, mode 0700 (the store directory too). Returns its path. */
function createSpool(root: string, runId: string): string {
  const dir = spoolDir(root, runId);
  fs.mkdirSync(path.dirname(storeDir(root)), { recursive: true });
  for (const p of [storeDir(root), dir]) {
    try {
      fs.mkdirSync(p, { mode: 0o700 });
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (kindAt(p) !== 'dir') throw new SpoolError('spool-unsafe', `${p} is not a directory`);
    fs.chmodSync(p, 0o700);
  }
  return dir;
}

function validMessage(value: any): value is Message {
  return value !== null && typeof value === 'object' && value.v === 1 && KINDS.includes(value.kind)
    && (value.requestId === null || typeof value.requestId === 'string') && typeof value.by === 'string' && value.by !== ''
    && typeof value.at === 'string' && (value.text === undefined || typeof value.text === 'string');
}

/**
 * Drops one message for the supervisor: `<ms>-<8 hex>.json`, 0600, written whole under a `.tmp` name (`wx`) and renamed.
 * Throws `spool-missing` when the session has no spool (its channel is not open), `message-too-large` over 64 KiB.
 */
function dropMessage(root: string, runId: string, message: { kind: string; requestId: string | null; by: string; at: string; text?: string }) {
  const body: any = { v: 1, kind: message?.kind, requestId: message?.requestId ?? null, by: message?.by, at: message?.at };
  if (message?.text !== undefined) body.text = message.text;
  if (!validMessage(body)) throw new SpoolError('usage', 'a spool message needs kind, requestId, by and at, and text only as a string');
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  if (bytes.length > FILE_MAX) throw new SpoolError('message-too-large', `a spool message is ${bytes.length} bytes; the most is ${FILE_MAX}`);
  const dir = existingDir(root, runId);
  if (dir === null) throw new SpoolError('spool-missing', `the session ${runId} has no open spool`);
  const name = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`;
  const tmp = path.join(dir, `${name}.tmp`);
  const fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o600);
  try {
    fs.writeSync(fd, bytes, 0, bytes.length, 0);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(tmp, { force: true });
    throw error;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, path.join(dir, name));
  return { name, bytes: bytes.length };
}

const order = (a: string, b: string): number => {
  const [, ams, ahex] = NAME.exec(a) as RegExpExecArray;
  const [, bms, bhex] = NAME.exec(b) as RegExpExecArray;
  return Number(ams) - Number(bms) || (ahex < bhex ? -1 : ahex > bhex ? 1 : 0);
};

/** The message names waiting in the spool, oldest first (no file is opened). */
function waitingNames(root: string, runId: string): string[] {
  const dir = existingDir(root, runId);
  if (dir === null) return [];
  return fs.readdirSync(dir).filter((name: string) => NAME.test(name)).sort(order);
}

/** Reads one message file without following a link; null with the reason when it is refused. */
function readOne(file: string): { message: Message } | { reason: string } {
  let info: any;
  try {
    info = fs.lstatSync(file);
  } catch (error: any) {
    return { reason: error?.code === 'ENOENT' ? 'gone' : 'unreadable' };
  }
  if (info.isSymbolicLink()) return { reason: 'symlink' };
  if (!info.isFile()) return { reason: 'not-a-file' };
  if (info.size > FILE_MAX) return { reason: 'too-large' };
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW | NONBLOCK);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) return { reason: 'not-a-file' };
    const buffer = Buffer.alloc(FILE_MAX + 1);
    let length = 0;
    for (;;) {
      const read = fs.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
      if (length > FILE_MAX) return { reason: 'too-large' };
    }
    let value: any;
    try { value = JSON.parse(buffer.subarray(0, length).toString('utf8')); } catch { return { reason: 'malformed' }; }
    return validMessage(value) ? { message: value } : { reason: 'malformed' };
  } catch (error: any) {
    return { reason: error?.code === 'ELOOP' || error?.code === 'EMLINK' ? 'symlink' : error?.code === 'ENOENT' ? 'gone' : 'unreadable' };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * Takes up to 16 waiting messages, oldest name first. Each file is read (regular file, no link, at most 64 KiB) and
 * DELETED before this returns, whether it was taken or refused; a refused one is `{ ok: false, reason }` (`symlink`,
 * `not-a-file`, `too-large`, `malformed`, `unreadable`). A file gone before it was read is left out.
 */
function takeMessages(root: string, runId: string): Taken[] {
  const dir = existingDir(root, runId);
  if (dir === null) return [];
  const out: Taken[] = [];
  for (const name of waitingNames(root, runId).slice(0, TAKE_MAX)) {
    const file = path.join(dir, name);
    const read = readOne(file);
    try { fs.unlinkSync(file); } catch { /* gone already */ }
    if ('message' in read) out.push({ name, ok: true, message: read.message });
    else if (read.reason !== 'gone') out.push({ name, ok: false, reason: read.reason });
  }
  return out;
}

/** Removes the run's spool directory and what it holds; a link in its place is removed, never followed. */
function removeSpool(root: string, runId: string): void {
  const dir = spoolDir(root, runId);
  if (kindAt(storeDir(root)) !== 'dir') return;
  const kind = kindAt(dir);
  if (kind === 'absent') return;
  if (kind === 'unsafe') fs.unlinkSync(dir);
  else fs.rmSync(dir, { recursive: true, force: true });
}

module.exports = { STORE, FILE_MAX, SpoolError, spoolDir, createSpool, dropMessage, waitingNames, takeMessages, removeSpool };
