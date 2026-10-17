'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ID = 'hybrid-c-v1';
const CONFIGS = ['A', 'B', 'C'];
const CORPORA = ['code', 'guidance'];

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

module.exports = { ID, CONFIGS, CORPORA, acquireInvocationLock, reserveSixSlots, releaseBeforeEvaluation };
