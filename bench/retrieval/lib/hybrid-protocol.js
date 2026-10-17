'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { SEMBLE_VERSION } = require('../../../src/runtime/knowledge/semble-provider.ts');

const ID = 'hybrid-c-v1';
const CONFIGS = ['A', 'B', 'C'];
const CORPORA = ['code', 'guidance'];
/** DEC-017: hybrid-c-v1 re-measures A/B/C on these tool versions (`--version` first lines). They replace the
 * snapshot's pins for these ids in this protocol only; snapshot.json and the legacy A/B verdict stay as measured. */
const TOOL_PINS = Object.freeze({ semble: SEMBLE_VERSION, graphify: 'graphify 0.9.92', rtk: 'rtk 1.0.1' });

/** Re-grade a `verifySnapshot` outcome against TOOL_PINS: manifest/commit failures (3) stand, tool drift (4) is recomputed. */
function applyToolPins(verified) {
  if (!verified.snapshot || !verified.result || verified.result.tools.length === 0) return verified;
  const pinned = (id) => Object.prototype.hasOwnProperty.call(TOOL_PINS, id);
  const tools = verified.result.tools.map((row) => (pinned(row.id)
    ? { ...row, expected: TOOL_PINS[row.id], ok: row.state === 'present' && row.actual === TOOL_PINS[row.id] } : row));
  const drift = tools.filter((row) => !row.ok);
  const messages = [...String(verified.message || '').split('; ').filter((m) => m && !m.startsWith('tool ')),
    ...drift.map((row) => `tool ${row.id}: pinned "${row.expected}", found "${row.actual}"`)];
  const codes = [...(verified.codes || []).filter((code) => code !== 4), ...(drift.length ? [4] : [])];
  const snapshot = { ...verified.snapshot, tools: verified.snapshot.tools.map((tool) => (pinned(tool.id) ? { ...tool, versionLine: TOOL_PINS[tool.id] } : tool)) };
  return { ...verified, exitCode: codes.includes(3) ? 3 : codes.includes(4) ? 4 : 0, codes, message: messages.join('; ') || undefined,
    result: { ...verified.result, tools }, snapshot };
}

/** Serialize all holdout protocols for one snapshot while evaluation runs. */
function acquireInvocationLock({ repoRoot, snapshotId }) {
  const root = path.join(repoRoot, 'bench', 'retrieval', 'results');
  fs.mkdirSync(root, { recursive: true });
  const lock = path.join(root, `.retrieval-holdout-${snapshotId}.lock`);
  try { fs.mkdirSync(lock); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error(`a holdout invocation is already active for snapshot ${snapshotId}; inspect ${path.relative(repoRoot, lock)}`);
    throw error;
  }
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, protocol: ID, startedAt: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
  let released = false;
  return { lock, release() { if (released) return; released = true; fs.rmSync(lock, { recursive: true, force: true }); } };
}

/** Reserve the complete six-result generation before the caller decrypts any holdout envelope. */
function reserveSixSlots({ repoRoot, snapshotId, sealMeta, resultFiles }) {
  const root = path.join(repoRoot, 'bench', 'retrieval', 'results');
  fs.mkdirSync(root, { recursive: true });
  const slots = [];
  for (const corpus of CORPORA) {
    const meta = sealMeta[corpus];
    if (!meta) throw new Error(`hybrid-c-v1 requires the ${corpus} sealed corpus`);
    for (const config of CONFIGS) slots.push(`holdout-${snapshotId}-g${meta.generation}-${corpus}-${config}.json`);
  }
  const reservationId = `${snapshotId}-g${sealMeta.code.generation}-g${sealMeta.guidance.generation}`;
  const lock = path.join(root, `.hybrid-c-v1-${reservationId}.lock`);
  try { fs.mkdirSync(lock); } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`hybrid-c-v1 reservation is locked; inspect ${path.relative(repoRoot, lock)} and remove it only after confirming no evaluation is active`);
    throw error;
  }
  try {
    const used = new Set(resultFiles || []);
    for (const slot of slots) if (used.has(slot) || fs.existsSync(path.join(root, slot))) throw new Error(`hybrid-c-v1 slot is already consumed: ${slot}`);
    const reservation = path.join(root, `.hybrid-c-v1-${reservationId}.reserved.json`);
    let fd;
    try { fd = fs.openSync(reservation, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new Error(`hybrid-c-v1 slots were already reserved at ${path.relative(repoRoot, reservation)}; inspect that record and prior aggregates before any audited recovery`);
      throw error;
    }
    try { fs.writeFileSync(fd, JSON.stringify({ protocol: ID, snapshotId, slots, reservedAt: new Date().toISOString() }) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    return { reservation, slots };
  } finally { fs.rmdirSync(lock); }
}

function releaseBeforeEvaluation({ repoRoot, reservation }) {
  if (!reservation?.reservation) return;
  const match = /\.hybrid-c-v1-(.+)\.reserved\.json$/.exec(reservation.reservation);
  if (!match) throw new Error('unrecognized hybrid-c-v1 reservation path');
  const lock = path.join(path.dirname(reservation.reservation), `.hybrid-c-v1-${match[1]}.lock`);
  fs.mkdirSync(lock);
  try {
    const current = JSON.parse(fs.readFileSync(reservation.reservation, 'utf8'));
    if (current.protocol !== ID || JSON.stringify(current.slots) !== JSON.stringify(reservation.slots)) throw new Error('reservation identity changed; refusing release');
    const audit = path.join(path.dirname(reservation.reservation), `.hybrid-c-v1-released-${current.snapshotId}-${Date.now()}.json`);
    fs.renameSync(reservation.reservation, audit);
  } finally { fs.rmdirSync(lock); }
}

module.exports = { ID, CONFIGS, CORPORA, TOOL_PINS, applyToolPins, acquireInvocationLock, reserveSixSlots, releaseBeforeEvaluation };
