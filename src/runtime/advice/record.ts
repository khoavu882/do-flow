'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { resolveStorePath } = require('../storage/roots.ts');

const RETAINED_DAYS = 90;
const PARTITION_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function timestamp(now: any = () => new Date()): string | null {
  const value = typeof now === 'function' ? now() : now;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function selectedStore(roots: any, requestedStore?: string): { store: string; root: string } | null {
  if (requestedStore && roots?.[requestedStore]) return { store: requestedStore, root: roots[requestedStore] };
  if (roots?.['project-state']) return { store: 'project-state', root: roots['project-state'] };
  if (roots?.['user-state']) return { store: 'user-state', root: roots['user-state'] };
  return null;
}

function appendLine({ roots, at, line, fsImpl = fs, store }: any): { file: string; store: string } | null {
  try {
    const selected = selectedStore(roots, store);
    if (!selected) return null;
    const directory = resolveStorePath({ store: { root: selected.store, path: 'advice/picks' }, roots, fsImpl });
    if (!directory) return null;
    const file = path.join(directory, `${at.slice(0, 10)}.jsonl`);
    try { if (fsImpl.lstatSync(file).isSymbolicLink()) return null; }
    catch (error: any) { if (error.code !== 'ENOENT') return null; }
    fsImpl.mkdirSync(path.dirname(file), { recursive: true });
    // One whole line per call, written through an O_APPEND descriptor: each write lands at the end of the file as one
    // piece, so lines from concurrent writers (the command and any detached shadow children) never interleave.
    fsImpl.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf8');
    return { file, store: selected.store };
  } catch {
    return null;
  }
}

// The extra payload of a pick (141 IC-007, DEC-028): only the key `claimSupport`, rebuilt field by field from an
// allowlist, so a caller cannot put a claim or passage text on a line. A value that is not the expected shape drops the
// whole object, never a part of it.
const ID_CHARS = 128;

function isPlainObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function countOrNull(value: any): number | null {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** The `claimSupport` object of IC-007: ledger ids, the relation and status words, byte counts; never a claim or passage. */
function cleanClaimSupport(value: any): any | null {
  if (!isPlainObject(value)) return null;
  const word = (item: any) => (typeof item === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(item) ? item : null);
  const id = (item: any) => (typeof item === 'string' && item.length > 0 ? item.slice(0, ID_CHARS) : null);
  if (value.relation !== 'supports' && value.relation !== 'contradicts') return null;
  const claimId = id(value.claimId);
  const evidenceId = id(value.evidenceId);
  const claimStatus = word(value.claimStatus);
  if (!claimId || !evidenceId || !claimStatus) return null;
  return {
    claimId, evidenceId, relation: value.relation, claimStatus,
    claimBytes: countOrNull(value.claimBytes) ?? 0,
    passageBytes: countOrNull(value.passageBytes) ?? 0,
    truncated: value.truncated === true,
  };
}

const PICK_ID = /^adv-[0-9]{13}-[0-9a-f]{6}$/;

function newPickId(epoch: number = Date.now()): string {
  return `adv-${String(epoch).padStart(13, '0')}-${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * `pickId` lets a caller that returned an id before the line is written (the shadow dispatcher) keep it; `mode`
 * and `elevated` are the dispatcher's and are written only when given.
 */
function appendPick({
  roots, now = () => new Date(), fsImpl = fs, kind, answer, question,
  staticAnswer = null, provider = null, model = null, state, caller, taskId = null, durationMs = 0,
  pickId: givenPickId, mode, elevated, extra,
}: any = {}): { pickId: string; file: string; store: string } | null {
  try {
    if (typeof state !== 'string' || !answer || !question) return null;
    const at = timestamp(now);
    if (!at) return null;
    const pickId = typeof givenPickId === 'string' && PICK_ID.test(givenPickId) ? givenPickId : newPickId(Date.parse(at));
    const claimSupport = kind === 'claim-support' ? cleanClaimSupport(extra?.claimSupport) : null;
    const options = question.type === 'choice' ? Object.keys(question.options || {})
      : question.type === 'score' ? [...(question.criteria || [])] : ['no', 'yes'];
    const instructions = kind === 'adhoc' && typeof question.instructions === 'string'
      ? question.instructions.slice(0, 500) : null;
    const line: any = {
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
    if (mode !== undefined) line.mode = mode;
    if (elevated !== undefined) line.elevated = elevated === true;
    if (claimSupport) line.claimSupport = claimSupport;
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

function appendMiss({ roots, now = () => new Date(), fsImpl = fs, kind, caller, reason, model = null, durationMs = 0, mode }: any = {}): any {
  try {
    const at = timestamp(now);
    if (!at) return null;
    const line: any = {
      schema: 1, type: 'miss', at, kind, caller, reason,
      model: model ?? null,
      durationMs: Number.isFinite(durationMs) ? durationMs : 0,
    };
    if (mode !== undefined) line.mode = mode;
    return appendLine({ roots, at, line, fsImpl });
  } catch { return null; }
}

/**
 * A pick the person was shown (175 O-6): the dispatcher showed or acted on it (mode `show` or `act`), or it answered an ad
 * hoc ask that was not a shadow one (an ad hoc ask under a shadow rollout is recorded with mode `shadow` and never shown).
 */
function wasShown(pick: any): boolean {
  return pick?.mode === 'show' || pick?.mode === 'act' || (pick?.kind === 'adhoc' && pick?.mode !== 'shadow');
}

/** What the person did with a shown recommendation (175 IC-010): the `followed` label of an outcome line. */
const FOLLOWED = ['followed', 'partly', 'overruled'];

/**
 * One outcome line for `pickId`: `actual` (the option that was done) and `followed` (a FOLLOWED word), each written only
 * when given; at least one is required, and a `followed` outside FOLLOWED writes nothing.
 */
function appendOutcome({ roots, now = () => new Date(), fsImpl = fs, pickId, actual, followed, source, store }: any = {}): any {
  try {
    const at = timestamp(now);
    if (!at) return null;
    if (followed !== undefined && !FOLLOWED.includes(followed)) return null;
    if (actual === undefined && followed === undefined) return null;
    const line: any = { schema: 1, type: 'outcome', pickId, at, source };
    if (actual !== undefined) line.actual = actual;
    if (followed !== undefined) line.followed = followed;
    return appendLine({ roots, at, line, fsImpl, store });
  } catch { return null; }
}

function cutoffDate(now: any, maxAgeDays: number = RETAINED_DAYS): string | null {
  const at = timestamp(now);
  if (!at) return null;
  const cutoff = new Date(Date.parse(at) - maxAgeDays * 24 * 60 * 60 * 1000);
  return cutoff.toISOString().slice(0, 10);
}

type StoreState = 'read' | 'absent' | 'unreadable';
type Partition = { store: string; day: string; read: boolean; unreadableLines: number };

/** The store's listing outcome (151 IC-002): `read` with the window's partition files, `absent`, or `unreadable`. */
function partitionFiles(root: string | undefined, cutoff: string, fsImpl: any): { state: StoreState; files: string[] } {
  if (!root) return { state: 'absent', files: [] };
  const directory = path.join(root, 'advice', 'picks');
  try {
    const files = fsImpl.readdirSync(directory)
      .filter((name: string) => PARTITION_NAME.test(name) && name.slice(0, 10) >= cutoff)
      .sort()
      .map((name: string) => path.join(directory, name));
    return { state: 'read', files };
  } catch (error: any) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return { state: 'absent', files: [] };
    return { state: 'unreadable', files: [] };
  }
}

/**
 * The records of the retained window, with what was read to find them (151 IC-002, additive): `stores` per record
 * store, and one `partitions` entry per partition file inside the cutoff. `unreadable` keeps its meaning: one per
 * store that could not be listed, per partition that could not be read and per line that is not a JSON object.
 */
function readWindow({ roots, now = () => new Date(), maxAgeDays = RETAINED_DAYS, fsImpl = fs }: any = {}): {
  records: any[]; unreadable: number; stores: Record<'project-state' | 'user-state', StoreState>; partitions: Partition[];
} {
  const stores: Record<'project-state' | 'user-state', StoreState> = { 'project-state': 'unreadable', 'user-state': 'unreadable' };
  const partitions: Partition[] = [];
  const cutoff = cutoffDate(now, maxAgeDays);
  // With no cutoff nothing is listed, so no store claims to be read.
  if (!cutoff) return { records: [], unreadable: 0, stores, partitions };
  const records: any[] = [];
  let unreadable = 0;
  for (const store of ['project-state', 'user-state'] as const) {
    const listing = partitionFiles(roots?.[store], cutoff, fsImpl);
    stores[store] = listing.state;
    if (listing.state === 'unreadable') unreadable += 1;
    for (const file of listing.files) {
      const day = path.basename(file).slice(0, 10);
      const partition: Partition = { store, day, read: false, unreadableLines: 0 };
      partitions.push(partition);
      let contents: string;
      try { contents = fsImpl.readFileSync(file, 'utf8'); } catch { unreadable += 1; continue; }
      partition.read = true;
      for (const line of contents.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const record = JSON.parse(line);
          if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('record must be an object');
          records.push({ record, file, store, day });
        } catch { unreadable += 1; partition.unreadableLines += 1; }
      }
    }
  }
  return { records, unreadable, stores, partitions };
}

function findPick({ pickId, roots, now = () => new Date(), fsImpl = fs }: any = {}): any {
  if (typeof pickId !== 'string') return null;
  const window = readWindow({ roots, now, fsImpl });
  const found = window.records.find((entry: any) => entry.record.type === 'pick' && entry.record.pickId === pickId);
  return found ? { pick: found.record, file: found.file, store: found.store } : null;
}

module.exports = { appendPick, appendMiss, appendOutcome, readWindow, findPick, newPickId, wasShown, FOLLOWED };
