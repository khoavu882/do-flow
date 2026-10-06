'use strict';

// MCP entry ownership for the adapters that keep DoFlow's servers as members of a JSON map in a
// file the harness shares with its user. Ownership is one ledger row per harness, file and server,
// whose fingerprint is the entry value DoFlow last verified there. A same-named entry no row claims
// is the user's and is never touched; an owned entry whose value no longer matches its row was
// edited outside DoFlow and is released, never overwritten or removed. While a harness holds no MCP
// row at all, an entry equal to DoFlow's own rendering of a server it may adopt is DoFlow's.
//
// Plan changes carry DoFlow's own entry and a fingerprint of the value plan saw, never file text:
// the lifecycle copies every change into the recovery record, and an MCP file may hold secrets. For
// the same reason a file DoFlow cannot read is described by a fixed reason, never parser output.
const fs = require('node:fs');
const path = require('node:path');
const { fingerprint } = require('./copy-tree');

const REASONS = Object.freeze({
  json: 'invalid JSON',
  root: 'top-level value is not an object',
  container: 'server container is not an object',
});

function isObject(value) { return Boolean(value) && typeof value === 'object' && !Array.isArray(value); }

function entryFingerprint(value) { return fingerprint(value); }

function fingerprintOrNull(value) { return value === undefined ? null : entryFingerprint(value); }

/** Deep equality that ignores key order, so a reformatted entry still equals DoFlow's rendering. */
function sameValue(a, b) { return a !== undefined && b !== undefined && entryFingerprint(a) === entryFingerprint(b); }

function shortId(id) { const text = String(id); return text.length > 40 ? `${text.slice(0, 37)}...` : text; }

function shortPath(file) { return file.length > 80 ? `...${file.slice(-77)}` : file; }

const NOTICES = Object.freeze({
  collision: (id, file) => `MCP: kept your own entry '${shortId(id)}' in ${path.basename(file)} and did not register DoFlow's; rename or remove yours to let DoFlow manage it.`,
  released: (id, file) => `MCP: entry '${shortId(id)}' in ${path.basename(file)} was changed outside DoFlow; it is yours now and DoFlow no longer updates or removes it.`,
  untouched: (file) => `MCP: left ${shortPath(file)} untouched because it cannot be edited safely; DoFlow no longer manages the entries in it.`,
});

function refusal(label, file, reason) { return `${label}: ${file}: ${reason}; DoFlow did not change the file`; }

/** Read one MCP file as a JSON object. `servers` is null when the file or its container is absent. */
function readMcpFile(file, container, { fsImpl = fs } = {}) {
  if (!fsImpl.existsSync(file)) return { ok: true, doc: null, servers: null };
  let doc;
  try { doc = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch { return { ok: false, reason: REASONS.json }; }
  if (!isObject(doc)) return { ok: false, reason: REASONS.root };
  if (doc[container] === undefined) return { ok: true, doc, servers: null };
  if (!isObject(doc[container])) return { ok: false, reason: REASONS.container };
  return { ok: true, doc, servers: doc[container] };
}

/** The `files` map plan and verify take: the scope's MCP file and every file an own row names. */
function readMcpFiles({ file, ownRows = [], container, fsImpl = fs }) {
  const targets = new Set([file, ...ownRows.map((row) => row.target)]);
  return Object.fromEntries([...targets].map((target) => {
    const read = readMcpFile(target, container, { fsImpl });
    return [target, read.ok ? { ok: true, servers: read.servers } : read];
  }));
}

function renderedById(selected, adoptable) {
  const rendered = new Map();
  for (const { id, entry } of [...selected, ...adoptable]) if (!rendered.has(id)) rendered.set(id, entry);
  return rendered;
}

/** Shared by plan, verify and ownedMcpIds, so the three read one entry the same way. */
function ownershipView({ file, files, selected = [], adoptable = [], ownRows = [], foreignRows = [] }) {
  const rendered = renderedById(selected, adoptable);
  const valueOf = (target, id) => (files[target]?.ok ? files[target].servers?.[id] : undefined);
  const matches = (row, value) => {
    if (value === undefined) return false;
    const recorded = row.fingerprint ?? null;
    return recorded !== null ? entryFingerprint(value) === recorded : sameValue(value, rendered.get(row.identity));
  };
  const rowsFor = (id) => ownRows.filter((row) => row.identity === id && row.target === file);
  // A legacy row is consumed alongside the current one, but never preferred over it.
  const rowFor = (id) => { const rows = rowsFor(id); return rows.find((row) => !row.legacy) ?? rows[0] ?? null; };
  const adoptionOpen = ownRows.length === 0;
  const adoptableIds = new Set(adoptable.map((server) => server.id));
  const selectedIds = new Set(selected.map((server) => server.id));
  /** An equal entry no own row claims is DoFlow's when another harness's row claims it, or when it
   * may be adopted. */
  const claimable = (id, entry) => {
    const value = valueOf(file, id);
    return sameValue(value, entry) && (foreignRows.some((row) => row.identity === id && row.target === file)
      || (adoptionOpen && adoptableIds.has(id)));
  };
  /** Adoptable entries DoFlow takes out because nothing selects them any more. */
  const adoptedRemovals = () => (adoptionOpen && files[file]?.ok
    ? adoptable.filter(({ id, entry }) => !selectedIds.has(id) && sameValue(valueOf(file, id), entry)) : []);
  return { rendered, valueOf, matches, rowsFor, rowFor, claimable, adoptedRemovals };
}

function orderOf(selected, adoptable) {
  const ids = [...renderedById(selected, adoptable).keys()];
  const rank = (id) => { const index = ids.indexOf(id); return index < 0 ? ids.length : index; };
  return (a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1
    : rank(a.identity) - rank(b.identity) || (a.identity < b.identity ? -1 : a.identity > b.identity ? 1 : 0));
}

/**
 * Decide every MCP entry change for one harness at one scope. `selected` and `adoptable` are the
 * adapter's rendered entries `[{ id, entry }]`; `ownRows` its rows (legacy ones flagged `legacy`);
 * `foreignRows` other harnesses' rows; `identityFor` composes the adapter's ownership identity.
 */
function planMcpEntries({ file, files, selected = [], adoptable = [], ownRows = [], foreignRows = [], removing = false,
  identityFor, assetId, renderer, label }) {
  const view = ownershipView({ file, files, selected, adoptable, ownRows, foreignRows });
  const changes = [];
  const conflicts = [];
  const notices = [];
  const base = (fields) => ({ assetId, kind: 'mcp-server', sourceVersion: 'registry-v1', projection: { renderer }, ...fields });
  const write = (operation, id, entry) => base({
    target: file, operation, identity: id, ownershipIdentity: identityFor(id),
    before: fingerprintOrNull(view.valueOf(file, id)), entry, fingerprint: entryFingerprint(entry), afterFingerprint: entryFingerprint(entry),
  });
  const drop = (row, release) => base({
    target: row.target, operation: 'remove', identity: row.identity, ownershipIdentity: row.ownershipIdentity,
    before: fingerprintOrNull(view.valueOf(row.target, row.identity)), fingerprint: row.fingerprint ?? null,
    ...(release ? { release: true } : {}),
  });

  const broken = Object.keys(files).filter((target) => !files[target].ok).sort();
  for (const target of broken) {
    if (removing) notices.push(NOTICES.untouched(target));
    else conflicts.push(refusal(label, target, files[target].reason));
  }

  const consumed = new Set();
  if (!removing && files[file]?.ok) {
    for (const { id, entry } of selected) {
      const rows = view.rowsFor(id);
      for (const row of rows) consumed.add(row);
      const row = view.rowFor(id);
      const value = view.valueOf(file, id);
      if (row && value !== undefined && !view.matches(row, value)) {
        for (const item of rows) changes.push(drop(item, true));
        notices.push(NOTICES.released(id, file));
        continue;
      }
      if (row || value === undefined) {
        if (value === undefined) changes.push(write('create', id, entry));
        else if (!sameValue(value, entry)) changes.push(write('update', id, entry));
        // The row verify records under the adapter's identity replaces the legacy one in this run.
        for (const item of rows) if (item.legacy) changes.push(drop(item, true));
      } else if (!view.claimable(id, entry)) {
        notices.push(NOTICES.collision(id, file));
      }
    }
  }

  for (const row of ownRows) {
    if (consumed.has(row)) continue;
    if (!files[row.target]?.ok) {
      if (removing) changes.push(drop(row, true));
      continue;
    }
    const value = view.valueOf(row.target, row.identity);
    if (value === undefined) changes.push(drop(row, true));
    else if (view.matches(row, value)) changes.push(drop(row, false));
    else {
      changes.push(drop(row, true));
      notices.push(NOTICES.released(row.identity, row.target));
    }
  }

  for (const { id } of view.adoptedRemovals()) {
    const value = view.valueOf(file, id);
    changes.push(base({
      target: file, operation: 'remove', identity: id, ownershipIdentity: identityFor(id),
      before: entryFingerprint(value), fingerprint: entryFingerprint(value),
    }));
  }

  return { changes: changes.sort(orderOf(selected, adoptable)), conflicts, notices };
}

/** Apply one file's planned changes to the server map read now. Each change goes ahead only while
 * its entry still holds what plan saw, or already holds the change's end state, which makes two
 * harnesses' changes to one shared entry in one run idempotent. Release changes touch nothing. */
function applyMcpEntries(servers, changes) {
  const next = { ...(servers || {}) };
  for (const change of changes) {
    if (change.release) continue;
    const current = next[change.identity];
    const settled = change.operation === 'remove' ? current === undefined : sameValue(current, change.entry);
    if (!settled && fingerprintOrNull(current) !== (change.before ?? null)) {
      throw new Error(`MCP: ${change.target} changed after planning; nothing was written, re-run the command`);
    }
    if (change.operation === 'remove') delete next[change.identity];
    else next[change.identity] = change.entry;
  }
  return next;
}

/**
 * Statuses and ledger resources for one harness's MCP entries. `files` is read after apply,
 * `snapshot` is what plan read: an entry plan found holding the user's value stays the user's,
 * whatever it holds now.
 */
function verifyMcpEntries({ file, files, snapshot, selected = [], adoptable = [], ownRows = [], foreignRows = [], removing = false,
  identityFor, assetId, renderer, label, harness, sourceVersion = 'unknown' }) {
  const now = ownershipView({ file, files, selected, adoptable, ownRows, foreignRows });
  const then = ownershipView({ file, files: snapshot, selected, adoptable, ownRows, foreignRows });
  const statuses = [];
  const resources = [];
  const conflicts = [];
  const report = (id, target, ownershipIdentity, status) => statuses.push({
    harness, assetId, capability: 'mcp', identity: id, target, ownershipIdentity, status,
  });

  if (!removing) {
    for (const target of Object.keys(files).filter((item) => !files[item].ok).sort()) conflicts.push(refusal(label, target, files[target].reason));
  }

  const consumed = new Set();
  if (!removing) {
    for (const { id, entry } of selected) {
      for (const row of now.rowsFor(id)) consumed.add(row);
      if (!files[file]?.ok) continue;
      const before = then.valueOf(file, id);
      const row = then.rowFor(id);
      const usersBefore = before !== undefined && (row ? !then.matches(row, before) : !then.claimable(id, entry));
      const value = now.valueOf(file, id);
      if (usersBefore) report(id, file, identityFor(id), 'not-managed');
      else if (sameValue(value, entry)) {
        report(id, file, identityFor(id), 'managed');
        resources.push({
          assetId, target: file, ownershipIdentity: identityFor(id), kind: 'mcp-server', identity: id,
          fingerprint: entryFingerprint(value), sourceVersion, projection: { renderer },
        });
      } else report(id, file, identityFor(id), 'missing');
    }
  }

  const leftover = (value, matching, target) => {
    if (!files[target]?.ok) return 'not-managed';
    if (value === undefined) return 'absent';
    return matching ? 'retained' : 'not-managed';
  };
  for (const row of ownRows) {
    if (consumed.has(row)) continue;
    const value = now.valueOf(row.target, row.identity);
    report(row.identity, row.target, row.ownershipIdentity, leftover(value, now.matches(row, value), row.target));
  }
  if (removing) {
    for (const { id, entry } of then.adoptedRemovals()) {
      const value = now.valueOf(file, id);
      report(id, file, identityFor(id), leftover(value, sameValue(value, entry), file));
    }
  }
  return { statuses, resources, conflicts };
}

/** The ids DoFlow owns in this harness's MCP file now, in rendering order: those an own row matches,
 * and, while the harness holds no row, adoptable entries equal to DoFlow's rendering. A file that
 * cannot be read contributes none. */
function ownedMcpIds({ file, files, selected = [], adoptable = [], ownRows = [] }) {
  const view = ownershipView({ file, files, selected, adoptable, ownRows });
  const owned = new Set(ownRows.filter((row) => view.matches(row, view.valueOf(row.target, row.identity))).map((row) => row.identity));
  if (!ownRows.length) {
    for (const { id, entry } of adoptable) if (sameValue(view.valueOf(file, id), entry)) owned.add(id);
  }
  const order = [...view.rendered.keys()];
  return [...order.filter((id) => owned.has(id)), ...[...owned].filter((id) => !order.includes(id)).sort()];
}

function isSymlink(file, fsImpl) {
  try { return fsImpl.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

/** A symlinked MCP file is written through to the file it points at, so the link stays a link. */
function writePath(file, fsImpl) {
  if (!isSymlink(file, fsImpl)) return file;
  try { return fsImpl.realpathSync(file); } catch { return path.resolve(path.dirname(file), fsImpl.readlinkSync(file)); }
}

/** Write a JSON document atomically, keeping the existing file's permission bits: an MCP file kept
 * private for its tokens stays so. Creates missing directories; never deletes a file. */
function writeMcpJson(file, doc, { fsImpl = fs } = {}) {
  const dest = writePath(file, fsImpl);
  fsImpl.mkdirSync(path.dirname(dest), { recursive: true });
  const mode = fsImpl.existsSync(dest) ? fsImpl.statSync(dest).mode & 0o7777 : null;
  const temp = path.join(path.dirname(dest), `.${path.basename(dest)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temp, `${JSON.stringify(doc, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', ...(mode === null ? {} : { mode }) });
    if (mode !== null) fsImpl.chmodSync(temp, mode);
    fsImpl.renameSync(temp, dest);
  } finally {
    if (fsImpl.existsSync(temp)) fsImpl.rmSync(temp, { force: true });
  }
  return dest;
}

/**
 * Carry out an adapter's `kind: 'mcp-server'` changes: one fresh read and one write per file, with
 * every file's next document computed before the first write. An emptied container is kept as `{}`
 * or its member deleted, as the harness expects. Returns the number of files written.
 */
function writeMcpEntries(changes, { container, keepEmptyContainer = false, fsImpl = fs } = {}) {
  const byFile = new Map();
  for (const change of changes) {
    if (change.kind !== 'mcp-server' || change.release) continue;
    if (!byFile.has(change.target)) byFile.set(change.target, []);
    byFile.get(change.target).push(change);
  }
  const writes = [];
  for (const [file, group] of byFile) {
    const read = readMcpFile(file, container, { fsImpl });
    if (!read.ok) throw new Error(`MCP: ${file} changed after planning; nothing was written, re-run the command`);
    const servers = applyMcpEntries(read.servers, group);
    if (entryFingerprint(servers) === entryFingerprint(read.servers ?? {})) continue;
    const doc = { ...(read.doc ?? {}) };
    if (Object.keys(servers).length || keepEmptyContainer) doc[container] = servers;
    else delete doc[container];
    writes.push([file, doc]);
  }
  for (const [file, doc] of writes) writeMcpJson(file, doc, { fsImpl });
  return writes.length;
}

module.exports = {
  NOTICES, entryFingerprint, readMcpFiles, planMcpEntries, applyMcpEntries, verifyMcpEntries, ownedMcpIds,
  writeMcpJson, writeMcpEntries,
};
