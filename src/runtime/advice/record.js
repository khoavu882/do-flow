'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveStorePath } = require('../storage/roots.ts');

const RETAINED_DAYS = 90;
const PARTITION_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function timestamp(now = () => new Date()) {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function selectedStore(roots, requestedStore) {
  if (requestedStore && roots?.[requestedStore]) return { store: requestedStore, root: roots[requestedStore] };
  if (roots?.['project-state']) return { store: 'project-state', root: roots['project-state'] };
  if (roots?.['user-state']) return { store: 'user-state', root: roots['user-state'] };
  return null;
}

function appendLine({ roots, at, line, fsImpl = fs, store }) {
  try {
    const selected = selectedStore(roots, store);
    if (!selected) return null;
    const directory = resolveStorePath({ store: { root: selected.store, path: 'advice/picks' }, roots, fsImpl });
    if (!directory) return null;
    const file = path.join(directory, `${at.slice(0, 10)}.jsonl`);
    try { if (fsImpl.lstatSync(file).isSymbolicLink()) return null; }
    catch (error) { if (error.code !== 'ENOENT') return null; }
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    fsImpl.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return { file, store: selected.store };
  } catch {
    return null;
  }
}

function appendPick({
  roots, now = () => new Date(), fsImpl = fs, kind, answer, question,
  staticAnswer = null, provider = null, model = null, state, caller, taskId = null, durationMs = 0,
} = {}) {
  try {
    if (typeof state !== 'string' || !answer || !question) return null;
    const at = timestamp(now);
    if (!at) return null;
    const epoch = Date.parse(at);
    const pickId = `adv-${String(epoch).padStart(13, '0')}-${crypto.randomBytes(3).toString('hex')}`;
    const options = question.type === 'choice' ? Object.keys(question.options || {})
      : question.type === 'score' ? [...(question.criteria || [])] : ['no', 'yes'];
    const instructions = kind === 'adhoc' && typeof question.instructions === 'string'
      ? question.instructions.slice(0, 500) : null;
    const line = {
      schema: 1,
      type: 'pick',
      pickId,
      at,
      kind,
      question: answer.name,
      qtype: answer.type,
      options,
      instructions,
      pick: answer.pick,
      strength: answer.strength?.word ?? null,
      between: answer.strength?.between ?? null,
      probabilities: answer.probabilities,
      confidence: answer.confidence ?? null,
      static: staticAnswer ?? null,
      provider: provider ?? null,
      model: model ?? null,
      stateDigest: `sha256:${crypto.createHash('sha256').update(state, 'utf8').digest('hex')}`,
      stateBytes: Buffer.byteLength(state, 'utf8'),
      caller,
      taskId: taskId ?? null,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    };
    if (answer.type === 'score') {
      line.criteria = [...(question.criteria || [])];
      line.pickIndex = answer.pickIndex;
      line.score = answer.score;
    }
    const written = appendLine({ roots, at, line, fsImpl });
    return written ? { pickId, file: written.file, store: written.store } : null;
  } catch {
    return null;
  }
}

function appendMiss({ roots, now = () => new Date(), fsImpl = fs, kind, caller, reason, model = null, durationMs = 0 } = {}) {
  try {
    const at = timestamp(now);
    if (!at) return null;
    const line = {
      schema: 1, type: 'miss', at, kind, caller, reason,
      model: model ?? null,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    };
    return appendLine({ roots, at, line, fsImpl });
  } catch { return null; }
}

function appendOutcome({ roots, now = () => new Date(), fsImpl = fs, pickId, actual, source, store } = {}) {
  try {
    const at = timestamp(now);
    if (!at) return null;
    const line = { schema: 1, type: 'outcome', pickId, at, actual, source };
    return appendLine({ roots, at, line, fsImpl, store });
  } catch { return null; }
}

function cutoffDate(now, maxAgeDays = RETAINED_DAYS) {
  const at = timestamp(now);
  if (!at) return null;
  const cutoff = new Date(Date.parse(at) - maxAgeDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

function partitionFiles(root, cutoff, fsImpl) {
  if (!root) return [];
  const directory = path.join(root, 'advice', 'picks');
  try {
    return fsImpl.readdirSync(directory)
      .filter((name) => PARTITION_NAME.test(name) && name.slice(0, 10) >= cutoff)
      .sort()
      .map((name) => path.join(directory, name));
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
    return [{ unreadable: true, file: directory }];
  }
}

function readWindow({ roots, now = () => new Date(), maxAgeDays = RETAINED_DAYS, fsImpl = fs } = {}) {
  const cutoff = cutoffDate(now, maxAgeDays);
  if (!cutoff) return { records: [], unreadable: 0 };
  const records = [];
  let unreadable = 0;
  for (const store of ['project-state', 'user-state']) {
    for (const item of partitionFiles(roots?.[store], cutoff, fsImpl)) {
      if (typeof item !== 'string') { unreadable += 1; continue; }
      let contents;
      try { contents = fsImpl.readFileSync(item, 'utf8'); } catch { unreadable += 1; continue; }
      for (const line of contents.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('record must be an object');
          records.push({ record, file: item, store });
        } catch { unreadable += 1; }
      }
    }
  }
  return { records, unreadable };
}

function findPick({ pickId, roots, now = () => new Date(), fsImpl = fs } = {}) {
  if (typeof pickId !== 'string') return null;
  const window = readWindow({ roots, now, fsImpl });
  const found = window.records.find((entry) => entry.record.type === 'pick' && entry.record.pickId === pickId);
  return found ? { pick: found.record, file: found.file, store: found.store } : null;
}

module.exports = { appendPick, appendMiss, appendOutcome, readWindow, findPick };
