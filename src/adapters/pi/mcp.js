'use strict';

// Pi MCP projection: DoFlow's stdio servers merged per server into the mcpServers map of Pi's
// mcp.json. Ownership is one ledger row per server and file, whose fingerprint is the entry value
// DoFlow last verified there. A same-named entry DoFlow holds no row for is the user's and is never
// touched; an owned entry whose value no longer matches its row was edited by the user and is
// released, not overwritten or removed. The file itself is edited by splicing members into its
// original text (./json-members.js), so every byte DoFlow does not own survives.
//
// Plan changes carry DoFlow's own entry and a hash of the text plan read, never the file's text:
// the lifecycle copies every change into the recovery record, and a user's mcp.json may hold secrets.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { fingerprint } = require('../copy-tree');
const { SKELETON, readDocument, insertMember, replaceValue, removeMember, renderNewDocument } = require('./json-members');

const HARNESS = 'pi';
const ASSET_ID = 'guidance.codex-pointer';
const RENDERER = 'pi-mcp';
const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const ABSENT_DOCUMENT = Object.freeze({ ok: true, root: null, servers: null });

const NOTICES = Object.freeze({
  surface: 'MCP: stdio servers are registered in the mcpServers map of Pi\'s mcp.json for its built-in MCP (Pi 0.99.0 or later; project entries override user entries from Pi 1.0.1).',
  extension: 'MCP: an installed extension that registers /mcp, such as pi-mcp-adapter, replaces Pi\'s built-in MCP, and Pi then does not read mcp.json.',
  trust: 'MCP: Pi reads .pi/mcp.json only after this project is trusted (/trust or --approve); DoFlow does not grant trust.',
});

function sha256(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function shorten(name) { return name.length > 40 ? `${name.slice(0, 37)}...` : name; }

function collisionNotice(key, id) {
  return `MCP: kept your own entry '${shorten(key)}' and did not register DoFlow's '${shorten(id)}'; rename or remove yours to let DoFlow manage it.`;
}

function releasedNotice(id) {
  return `MCP: entry '${shorten(id)}' was changed outside DoFlow; it is yours now and DoFlow no longer updates or removes it.`;
}

/** Pi treats two server names that differ only in `-` versus `_` as one server. */
function piServerKey(name) { return name.replace(/_/g, '-'); }

function refusalFor(file, reason) { return `Pi MCP: ${file}: ${reason}; DoFlow did not change the file`; }

/** DoFlow's entry for one catalog server, or the reason Pi cannot take it. */
function renderPiEntry(server) {
  if (server.transport !== 'stdio' || typeof server.command !== 'string' || !server.command) {
    return { refusal: `Pi MCP: server '${server.id}' is not a stdio server; DoFlow writes only stdio entries for Pi` };
  }
  if (typeof server.id !== 'string' || !SERVER_NAME.test(server.id)) {
    return { refusal: `Pi MCP: server id '${server.id}' is not a valid Pi server name` };
  }
  const entry = { command: server.command };
  if (Array.isArray(server.args) && server.args.length) entry.args = [...server.args];
  if (server.env && typeof server.env === 'object' && Object.keys(server.env).length) entry.env = { ...server.env };
  return { entry };
}

function mcpRows(ledger) {
  return (ledger?.resources || []).filter((row) => row.harness === HARNESS && row.kind === 'mcp-server');
}

function readSnapshotFile(file, fsImpl) {
  if (!fsImpl.existsSync(file)) return { exists: false, text: '', hash: sha256(''), doc: ABSENT_DOCUMENT };
  const bytes = fsImpl.readFileSync(file);
  const text = bytes.toString('utf8');
  // A splice writes the decoded text back, so bytes that do not survive a UTF-8 round trip would be
  // rewritten; such a file is refused like any other one DoFlow cannot edit safely.
  const doc = Buffer.from(text, 'utf8').equals(bytes) ? readDocument(text) : { ok: false, reason: 'file is not valid UTF-8' };
  return { exists: true, text, hash: sha256(bytes), doc };
}

/** Read the selected server file and every file a ledger row names. Nothing is read when there is
 * neither a selection nor a row, so a run with no Pi MCP work touches no MCP file. */
function discoverPiMcp({ selected = [], rows = [], file, fsImpl = fs }) {
  const files = new Set(rows.map((row) => row.target));
  if (selected.length) files.add(file);
  return Object.fromEntries([...files].map((target) => [target, readSnapshotFile(target, fsImpl)]));
}

function memberOf(doc, key) { return doc.servers?.members.find((member) => member.key === key) ?? null; }

function twinOf(doc, key) {
  return doc.servers?.members.find((member) => member.key !== key && piServerKey(member.key) === piServerKey(key)) ?? null;
}

function sameValue(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function baseChange({ target, operation, id, snapshot }) {
  return {
    assetId: ASSET_ID, target, operation,
    ownershipIdentity: `doflow:${HARNESS}:mcp-server:${id}`,
    kind: 'mcp-server', identity: id, baseHash: snapshot[target]?.hash ?? sha256(''),
    sourceVersion: 'registry-v1', projection: { renderer: RENDERER },
  };
}

function writeChange({ target, operation, id, entry, snapshot }) {
  return { ...baseChange({ target, operation, id, snapshot }), entry, fingerprint: fingerprint(entry), afterFingerprint: fingerprint(entry) };
}

function releaseChange({ row, snapshot }) {
  const id = row.identity;
  return { ...baseChange({ target: row.target, operation: 'remove', id, snapshot }), release: true, fingerprint: row.fingerprint };
}

function planPiMcp({ selected = [], rows = [], file, scope, removing = false, snapshot = {}, assets = [] }) {
  const changes = [];
  const conflicts = [];
  const notices = [];
  if (!removing && !selected.length) return { changes, conflicts, notices };
  if (removing && !rows.length) return { changes, conflicts, notices };
  if (!assets.some((asset) => asset.id === ASSET_ID)) {
    return { changes, conflicts: [`Pi MCP needs the ${ASSET_ID} asset to record ownership`], notices };
  }

  const refused = new Set();
  for (const [target, entry] of Object.entries(snapshot)) {
    if (entry.doc.ok) continue;
    refused.add(target);
    conflicts.push(refusalFor(target, entry.doc.reason));
  }

  const matched = new Set();
  if (!removing) {
    notices.push(NOTICES.surface, NOTICES.extension);
    if (scope === 'project') notices.push(NOTICES.trust);
    const doc = snapshot[file]?.doc ?? ABSENT_DOCUMENT;
    for (const server of selected) {
      const { entry: desired, refusal } = renderPiEntry(server);
      if (refusal) { conflicts.push(refusal); continue; }
      const row = rows.find((item) => item.identity === server.id && item.target === file);
      if (row) matched.add(row);
      const member = memberOf(doc, server.id);
      const twin = twinOf(doc, server.id);
      if (row && member) {
        if (fingerprint(member.value) !== row.fingerprint) {
          changes.push(releaseChange({ row, snapshot }));
          notices.push(releasedNotice(server.id));
        } else if (!sameValue(member.value, desired)) {
          changes.push(writeChange({ target: file, operation: 'update', id: server.id, entry: desired, snapshot }));
        }
      } else if (member || twin) {
        // The user's entry holds the name. An owned row whose own entry is gone is released with it,
        // because re-creating DoFlow's entry beside the user's twin would give Pi two of one server.
        if (row) changes.push(releaseChange({ row, snapshot }));
        notices.push(collisionNotice((member ?? twin).key, server.id));
      } else {
        changes.push(writeChange({ target: file, operation: 'create', id: server.id, entry: desired, snapshot }));
      }
    }
  }

  for (const row of rows) {
    if (matched.has(row)) continue;
    const id = row.identity;
    const member = memberOf(snapshot[row.target]?.doc ?? ABSENT_DOCUMENT, id);
    if (member && fingerprint(member.value) === row.fingerprint) {
      changes.push({ ...baseChange({ target: row.target, operation: 'remove', id, snapshot }), fingerprint: row.fingerprint });
    } else {
      changes.push(releaseChange({ row, snapshot }));
      if (member) notices.push(releasedNotice(id));
    }
  }

  return { changes: changes.filter((change) => !refused.has(change.target)), conflicts, notices };
}

function atomicWrite(file, content, fsImpl) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    fsImpl.renameSync(temp, file);
  } finally {
    if (fsImpl.existsSync(temp)) fsImpl.rmSync(temp, { force: true });
  }
}

/** Replay one file's edits against the text read now, each against a fresh parse of the last result. */
function editedText(text, group) {
  const parse = (current) => {
    const doc = readDocument(current);
    if (!doc.ok) throw new Error(`Pi MCP: cannot edit the planned file: ${doc.reason}`);
    return doc;
  };
  let next = text;
  for (const change of group.filter((item) => item.operation === 'remove')) {
    const doc = parse(next);
    const member = memberOf(doc, change.identity);
    if (member) next = removeMember(next, doc.servers, member);
  }
  for (const change of group.filter((item) => item.operation === 'update')) {
    const doc = parse(next);
    const member = memberOf(doc, change.identity);
    if (member) next = replaceValue(next, member, change.entry, doc);
  }
  const creates = group.filter((item) => item.operation === 'create');
  for (const [index, change] of creates.entries()) {
    const doc = parse(next);
    if (!doc.servers) {
      const entries = Object.fromEntries(creates.slice(index).map((item) => [item.identity, item.entry]));
      return insertMember(next, doc.root, 'mcpServers', entries, doc);
    }
    next = insertMember(next, doc.servers, change.identity, change.entry, doc);
  }
  return next;
}

function applyPiMcp(changes, { fsImpl = fs } = {}) {
  const groups = new Map();
  for (const change of changes) {
    if (!groups.has(change.target)) groups.set(change.target, []);
    groups.get(change.target).push(change);
  }
  let applied = 0;
  for (const [target, all] of groups) {
    const group = all.filter((change) => !change.release);
    if (!group.length) continue;
    const exists = fsImpl.existsSync(target);
    const bytes = exists ? fsImpl.readFileSync(target) : Buffer.alloc(0);
    if (sha256(bytes) !== group[0].baseHash) throw new Error(`Pi MCP: ${target} changed after planning; nothing was written, re-run the command`);
    const text = bytes.toString('utf8');
    const next = exists
      ? editedText(text, group)
      : renderNewDocument(group.filter((change) => change.operation === 'create').map((change) => [change.identity, change.entry]));
    if (next === SKELETON) {
      if (exists) { fsImpl.rmSync(target); applied += 1; }
    } else if (next !== text) {
      atomicWrite(target, next, fsImpl);
      applied += 1;
    }
  }
  return { applied };
}

function statusFor({ id, target, status }) {
  return { harness: HARNESS, assetId: ASSET_ID, capability: 'mcp', identity: id, target,
    ownershipIdentity: `doflow:${HARNESS}:mcp-server:${id}`, status };
}

function resourceFor({ id, target, value }) {
  return { assetId: ASSET_ID, target, ownershipIdentity: `doflow:${HARNESS}:mcp-server:${id}`, kind: 'mcp-server', identity: id,
    fingerprint: fingerprint(value), sourceVersion: 'registry-v1', projection: { renderer: RENDERER } };
}

/** Statuses and ledger resources for the Pi MCP entries. `snapshot` is what plan read before apply:
 * an entry it held that DoFlow did not own then, or held with a value its row no longer matched, is
 * the user's, whatever it holds now. */
function verifyPiMcp({ selected = [], rows = [], file, snapshot = {}, removing = false, fsImpl = fs }) {
  const statuses = [];
  const resources = [];
  const conflicts = [];
  const current = {};
  for (const target of new Set([...(selected.length ? [file] : []), ...rows.map((row) => row.target)])) {
    current[target] = readSnapshotFile(target, fsImpl).doc;
    if (!current[target].ok) conflicts.push(refusalFor(target, current[target].reason));
  }
  const memberNow = (target, id) => (current[target]?.ok ? memberOf(current[target], id) : null);
  const foreign = (target, id) => {
    const before = snapshot[target]?.doc;
    if (!before?.ok) return false;
    const row = rows.find((item) => item.identity === id && item.target === target);
    const member = memberOf(before, id);
    if (!member) return Boolean(twinOf(before, id));
    return !row || fingerprint(member.value) !== row.fingerprint;
  };

  const verified = new Set();
  if (!removing) {
    for (const server of selected) {
      const { entry: desired } = renderPiEntry(server);
      if (!desired) continue;
      verified.add(`${file}\u0000${server.id}`);
      const member = memberNow(file, server.id);
      if (foreign(file, server.id)) statuses.push(statusFor({ id: server.id, target: file, status: 'not-managed' }));
      else if (member && sameValue(member.value, desired)) {
        statuses.push(statusFor({ id: server.id, target: file, status: 'managed' }));
        resources.push(resourceFor({ id: server.id, target: file, value: member.value }));
      } else statuses.push(statusFor({ id: server.id, target: file, status: 'missing' }));
    }
  }

  for (const row of rows) {
    const id = row.identity;
    if (verified.has(`${row.target}\u0000${id}`)) continue;
    const member = memberNow(row.target, id);
    let status;
    if (!member) status = 'absent';
    else if (foreign(row.target, id) || fingerprint(member.value) !== row.fingerprint) status = 'not-managed';
    else if (!removing && !selected.length) status = 'managed';
    else status = 'retained';
    statuses.push(statusFor({ id, target: row.target, status }));
    if (status === 'managed') resources.push(resourceFor({ id, target: row.target, value: member.value }));
  }
  return { statuses, resources, conflicts };
}

module.exports = { NOTICES, renderPiEntry, piServerKey, mcpRows, discoverPiMcp, planPiMcp, applyPiMcp, verifyPiMcp };
