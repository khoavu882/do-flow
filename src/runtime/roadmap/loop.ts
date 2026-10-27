'use strict';

/**
 * Roadmap loop verb and CLI handler (feature 108, IC-001; FR-001..FR-003, FR-008, FR-014, FR-016,
 * FR-017, FR-019..FR-024; IC-008, IC-010, IC-011, IC-013). Actions: render [--check], status, next
 * and audit. `next` is one deterministic step: kill switch, lease, run record and budget, open merge
 * intent, in-flight rows (perform check, gate, perform envelope, dispatch outcome, merge), pick.
 * Mechanical work spawns only git; skill stages and the implementation dispatch are yielded as
 * `perform` envelopes for the session. Text read from rows, plans and review files is data only.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync: defaultExecFileSync } = require('node:child_process');
const { listCheckouts } = require('../checkouts.ts');
const { withGitMemo } = require('../git-memo.ts');
const {
  parseSeed,
  deriveStatus,
  pick,
  render,
  renderRoadmapFile,
  check,
} = require('./rows.ts');
const { gatherGitFacts, sha256Digest } = require('./facts.ts');
const { loadPolicy, verifyRecordReasons } = require('./gates.ts');
const { mergeRoadmapRow, readOpenIntents, cleanupFeature } = require('./merge.ts');

interface RoadmapCommandOptions {
  action?: string;
  check?: boolean;
  json?: boolean;
  run?: string;
  row?: string;
  cwd?: string;
  root?: string;
  seedPath?: string;
  roadmapPath?: string;
  fsImpl?: any;
  gitFacts?: any;
  [seam: string]: any;
}

// The kill switch (IC-011, FR-016, decisions C9, C4) is settings/autopilot.ts: the env
// DOFLOW_AUTOPILOT_ENABLED, the `autopilot/off` sentinel and the `autopilot.enabled` setting. It is
// loaded on use, so commands that never step the loop (an install dry run) load no settings module.

function resolveMainRoot(cwd: string = process.cwd()): string {
  try {
    const info = listCheckouts({ cwd });
    if (info && info.ok && info.main) return info.main;
  } catch {
    // fallback
  }
  return path.resolve(cwd);
}

function usageError(message: string, json: boolean = false): number {
  if (json) {
    console.log(JSON.stringify({ error: 'usage', detail: message }));
  } else {
    console.error(`doflow roadmap: error: ${message}`);
  }
  process.exitCode = 2;
  return 2;
}

/**
 * Dispatches roadmap CLI actions: render [--check], status, next and audit. `next` resolves to a
 * promise of the exit code (the merge step awaits its fast-forward child).
 */
function handleRoadmapCommand(options: RoadmapCommandOptions = {}): any {
  const {
    action,
    check: isCheck = false,
    json = false,
    row: filterRow,
    cwd = process.cwd(),
    fsImpl = fs,
  } = options;

  if (action === 'next') return nextCommand(options);
  if (action === 'audit') return auditCommand(options);
  if (!action || (action !== 'render' && action !== 'status')) {
    return usageError("--action must be 'render', 'status', 'next' or 'audit'", json);
  }

  const root = options.root || resolveMainRoot(cwd);
  const seedFile = options.seedPath || path.join(root, 'agent-docs', 'roadmap', 'rows.json');
  const roadmapFile = options.roadmapPath || path.join(root, 'agent-docs', 'roadmap', 'ROADMAP.md');

  let seedRaw: string | null = null;
  let parsedSeed: any = null;

  try {
    seedRaw = fsImpl.readFileSync(seedFile, 'utf8');
  } catch (err: any) {
    return usageError(`failed to read seed file at ${seedFile}: ${err.message}`, json);
  }

  let seedParseError: any = null;
  try {
    parsedSeed = parseSeed(seedRaw);
  } catch (err: any) {
    seedParseError = err;
    // In render --check, a seed parse error (e.g. typed-status, duplicate-id, needs-unresolved)
    // is recorded as a check finding rather than crashing usage.
    if (!isCheck) {
      return usageError(`invalid seed: ${err.message}`, json);
    }
  }

  const rows = parsedSeed?.rows || [];
  const factsSnapshot = options.gitFacts || gatherGitFacts({ root });

  if (factsSnapshot.unreadable && factsSnapshot.unreadable.length > 0) {
    const detail = factsSnapshot.unreadable.join(', ');
    if (json) {
      console.log(
        JSON.stringify({
          schema: 1,
          action,
          error: 'cannot-read-facts',
          sources: factsSnapshot.unreadable,
          message: `doflow roadmap: cannot read facts: ${detail}`,
        })
      );
    } else {
      console.error(`doflow roadmap: cannot read facts: ${detail}`);
    }
    process.exitCode = 1;
    return 1;
  }

  const { statuses, rowStatus } = deriveStatus(rows, factsSnapshot);

  if (action === 'status') {
    let openIntents: any[];
    let operational: any;
    try {
      try { openIntents = readOpenIntents({ root, fsImpl }); }
      catch (error: any) { throw new Unreadable(['merge-intents'], error.message); }
      operational = operationalState(path.join(root, '.doflow', 'state', 'roadmap'), fsImpl);
    } catch (error: any) {
      const sources = error instanceof Unreadable ? error.sources : ['run-records'];
      if (json) console.log(JSON.stringify({ schema: 1, action, error: 'cannot-read-facts', sources, message: error.message }));
      else console.error(`doflow roadmap: cannot read ${sources.join(', ')}: ${error.message}`);
      process.exitCode = 1;
      return 1;
    }
    const holdsOf = (id: string | null) => operational.holds.filter((hold: any) => !id || hold.row === id);
    const printOperational = (id: string | null) => {
      for (const hold of holdsOf(id)) console.log(`  Run hold ${hold.row}: ${hold.state}${hold.kind ? ` (${hold.kind})` : ''}: ${hold.reason}`);
      const lease = operational.lease;
      console.log(lease ? `  Lease: pid ${lease.pid} on ${lease.host}${lease.runId ? ` for ${lease.runId}` : ''}` : '  Lease: none');
    };
    const displayStatus = (info: any) => openIntents.some((intent) => intent.row === info.rowId && intent.status === 'merged-unverified')
      ? 'merged-unverified' : info.status;
    const displayRows = Array.from(statuses.values() as Iterable<any>).map((info) => ({ ...info, status: displayStatus(info) }));
    const displayRowStatus = { ...rowStatus };
    for (const info of displayRows) displayRowStatus[info.rowId] = info.status;
    if (filterRow) {
      const singleStatus = statuses.get(filterRow);
      if (!singleStatus) {
        if (json) {
          console.log(
            JSON.stringify({
              schema: 1,
              action: 'status',
              error: 'row-not-found',
              row: filterRow,
            })
          );
        } else {
          console.error(`doflow roadmap: row '${filterRow}' not found`);
        }
        process.exitCode = 1;
        return 1;
      }

      if (json) {
        console.log(
          JSON.stringify({
            schema: 1,
            action: 'status',
            row: filterRow,
            status: displayStatus(singleStatus),
            info: singleStatus,
            intent: openIntents.find((intent) => intent.row === filterRow) || null,
            run: operational.run,
            holds: holdsOf(filterRow),
            lease: operational.lease,
          })
        );
      } else {
        console.log(
          `Row ${filterRow}: ${displayStatus(singleStatus)} (evidence: ${
            singleStatus.evidence ? singleStatus.evidence.shortSha : 'none'
          })`
        );
        const intent = openIntents.find((entry) => entry.row === filterRow);
        if (intent) console.log(`  Open merge intent: ${intent.phase}${intent.status ? ` (${intent.status})` : ''}`);
        printOperational(filterRow);
      }
      return 0;
    }

    if (json) {
      console.log(
        JSON.stringify({
          schema: 1,
          action: 'status',
          rowStatus: displayRowStatus,
          rows: displayRows,
          openIntents,
          run: operational.run,
          holds: holdsOf(null),
          lease: operational.lease,
        })
      );
    } else {
      console.log(`Roadmap status (${rows.length} rows):`);
      for (const [id, info] of statuses.entries()) {
        const ev = info.evidence ? `${info.evidence.shortSha} (${info.evidence.kind})` : '-';
        console.log(`  ${id.padEnd(6)} ${displayStatus(info).padEnd(12)} evidence: ${ev}`);
      }
      for (const intent of openIntents) console.log(`  Open merge intent ${intent.row}: ${intent.phase}${intent.status ? ` (${intent.status})` : ''}`);
      printOperational(null);
    }
    return 0;
  }

  if (action === 'render') {
    if (isCheck) {
      let existingContent: string | null = null;
      try {
        existingContent = fsImpl.readFileSync(roadmapFile, 'utf8');
      } catch {
        existingContent = null;
      }

      const checkResult = check({
        rows,
        gitFacts: factsSnapshot,
        rendered: existingContent,
        seedRaw,
      });

      // If parseSeed threw a specific validation error, ensure it is represented
      if (seedParseError && seedParseError.code) {
        if (!checkResult.findings.some((f: any) => f.rule === seedParseError.code)) {
          checkResult.findings.push({
            rule: seedParseError.code as any,
            message: seedParseError.message,
            rowId: seedParseError.rowId,
          });
          if (seedParseError.rowId && !checkResult.offendingRowIds.includes(seedParseError.rowId)) {
            checkResult.offendingRowIds.push(seedParseError.rowId);
          }
          checkResult.ok = false;
        }
      }

      if (checkResult.ok) {
        if (json) {
          console.log(
            JSON.stringify({
              schema: 1,
              action: 'render',
              check: true,
              exit: 0,
              findings: [],
              offendingRowIds: [],
            })
          );
        } else {
          console.log('doflow roadmap: render --check passed (0 findings)');
        }
        return 0;
      }

      if (json) {
        console.log(
          JSON.stringify({
            schema: 1,
            action: 'render',
            check: true,
            exit: 1,
            findings: checkResult.findings,
            offendingRowIds: checkResult.offendingRowIds,
          })
        );
      } else {
        console.error(`doflow roadmap: render --check found ${checkResult.findings.length} issue(s):`);
        for (const f of checkResult.findings) {
          console.error(`  [${f.rule}] ${f.message}`);
        }
      }
      process.exitCode = 1;
      return 1;
    }

    // Normal render: write ROADMAP.md if bytes differ
    const renderedText = render(rows, statuses);
    const { written } = renderRoadmapFile({
      roadmapPath: roadmapFile,
      content: renderedText,
      fsImpl,
    });

    if (json) {
      console.log(
        JSON.stringify({
          schema: 1,
          action: 'render',
          fileWrites: written ? 1 : 0,
          path: path.relative(root, roadmapFile) || roadmapFile,
        })
      );
    } else {
      console.log(
        `doflow roadmap: rendered ${path.relative(root, roadmapFile) || roadmapFile} (${
          written ? '1 file written' : '0 file writes, up to date'
        })`
      );
    }
    return 0;
  }

  return usageError(`unhandled action '${action}'`, json);
}

// ── state, lease and run record (IC-010, IC-013) ──────────────────────────────────────────────────

const RUN_ID = /^rl-[0-9]{8}-[0-9a-hjkmnp-tv-z]{4}$/;
const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const LOG_LIMIT = 500;
/** C17: gate and merge entries, with their input hashes, outlive the run record's log in audit.jsonl. */
const AUDIT_LIMIT = 10000;
const AUDIT_STEPS = ['gate', 'merge', 'render', 'cleanup'];
const PLAN_FILES = ['plan.md', 'planning/plan.md'];
/** `LOOP_BY` of dispatch/loop.ts, the dispatch loop's own actor; G54 keeps that module out of here. */
const DISPATCH_ACTOR = 'doflow-dispatch';
/** The actor this loop names in the dispatch commands it yields. */
const LOOP_ACTOR = 'doflow-roadmap';
const QUOTA = /^quota\b/i;
/** Stage artifacts, two layouts each (the decision-register.ts artifact list). */
const DOC_ARTIFACTS: Record<string, string[]> = {
  discovery: ['intention/requirement.md', 'requirement.md'],
  design: ['design/design.md', 'design.md'],
  planning: PLAN_FILES,
  review: ['review/findings.json'],
};

/** A fact the loop could not read. It is named in the output and the audit, never read as empty. */
class Unreadable extends Error {
  declare sources: string[];
  constructor(sources: string[], message: string) {
    super(message);
    this.sources = sources;
  }
}

const relCheckpoint = (runId: string): string => `.doflow/state/roadmap/runs/${runId}.json`;

function writeAtomic(file: string, text: string, fsImpl: any): void {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fsImpl.writeFileSync(temp, text, { mode: 0o600 });
    fsImpl.renameSync(temp, file);
  } finally {
    try { fsImpl.unlinkSync(temp); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  }
}

function writeJsonAtomic(file: string, value: any, fsImpl: any): void {
  writeAtomic(file, `${JSON.stringify(value)}\n`, fsImpl);
}

const auditFile = (dir: string): string => path.join(dir, 'audit.jsonl');

/** The durable gate and merge audit (C17): one JSON line each, the last AUDIT_LIMIT kept. */
function readAudit(dir: string, fsImpl: any): any[] {
  let text: string;
  try { text = fsImpl.readFileSync(auditFile(dir), 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw new Unreadable(['roadmap-audit'], error.message); }
  try { return text.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line)); }
  catch (error: any) { throw new Unreadable(['roadmap-audit'], error.message); }
}

function appendAudit(dir: string, entry: any, fsImpl: any): void {
  const lines = readAudit(dir, fsImpl).map((value) => JSON.stringify(value));
  lines.push(JSON.stringify(entry));
  writeAtomic(auditFile(dir), `${lines.slice(-AUDIT_LIMIT).join('\n')}\n`, fsImpl);
}

function newRunId(now: Date): string {
  let suffix = '';
  for (let i = 0; i < 4; i++) suffix += CROCKFORD[crypto.randomInt(CROCKFORD.length)];
  return `rl-${now.toISOString().slice(0, 10).replace(/-/g, '')}-${suffix}`;
}

function readRunFile(file: string, fsImpl: any): any {
  const name = `run-record:${path.basename(file)}`;
  let raw: string;
  try { raw = fsImpl.readFileSync(file, 'utf8'); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw new Unreadable([name], error.message); }
  let value: any;
  try { value = JSON.parse(raw); } catch (error: any) { throw new Unreadable([name], error.message); }
  if (!value || value.schema !== 1 || !RUN_ID.test(value.runId) || !Number.isSafeInteger(value.steps)
    || !Number.isSafeInteger(value.n) || !value.rows || typeof value.rows !== 'object' || !Array.isArray(value.log)) {
    throw new Unreadable([name], 'not a schema 1 run record');
  }
  return value;
}

function readRunRecords(dir: string, fsImpl: any): any[] {
  let names: string[];
  try { names = fsImpl.readdirSync(dir); }
  catch (error: any) { if (error.code === 'ENOENT') return []; throw new Unreadable(['run-records'], error.message); }
  return names.filter((name) => /^rl-.*\.json$/.test(name)).sort()
    .map((name) => readRunFile(path.join(dir, name), fsImpl)).filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.runId < b.runId ? -1 : 1));
}

/**
 * What `status` shows beside the three-valued git status (C18): the lease holder, and the holds and
 * pauses the newest open run record keeps per row.
 */
function operationalState(dir: string, fsImpl: any): { run: string | null; lease: any; holds: any[] } {
  let lease: any = null;
  try {
    const raw = JSON.parse(fsImpl.readFileSync(path.join(dir, 'lease.json'), 'utf8'));
    lease = { pid: raw?.pid ?? null, host: raw?.host ?? null, runId: raw?.runId ?? null, acquiredAt: raw?.acquiredAt ?? null };
  } catch (error: any) { if (error.code !== 'ENOENT') throw new Unreadable(['lease'], error.message); }
  const run = readRunRecords(path.join(dir, 'runs'), fsImpl).filter((record) => !record.closedAt).at(-1) || null;
  const holds: any[] = [];
  for (const [row, slot] of Object.entries(run?.rows || {}) as Array<[string, any]>) {
    if (slot?.held) holds.push({ row, state: 'held', kind: slot.held.kind ?? null, reason: slot.held.reason ?? null });
    if (slot?.paused) holds.push({ row, state: 'paused', kind: null, reason: slot.paused.reason ?? null });
  }
  return { run: run?.runId ?? null, lease, holds };
}

/** The named run, else the newest open run, else a new one (not yet written). */
function loadRunRecord(dir: string, requested: string | undefined, now: Date, fsImpl: any): { record: any; fresh: boolean } {
  const blank = (runId: string) => ({ schema: 1, runId, createdAt: now.toISOString(), closedAt: null, maxSteps: null, steps: 0, n: 0, rows: {}, log: [] });
  if (requested) {
    const existing = readRunFile(path.join(dir, `${requested}.json`), fsImpl);
    return existing ? { record: existing, fresh: false } : { record: blank(requested), fresh: true };
  }
  const open = readRunRecords(dir, fsImpl).filter((record) => !record.closedAt).at(-1);
  return open ? { record: open, fresh: false } : { record: blank(newRunId(now)), fresh: true };
}

/**
 * Liveness without spawning `ps` (NFR-004): a live pid can never be proven to be the recorded
 * process, so it answers `unknown`, which refuses exactly as `true` does (IC-010). Only ESRCH is dead.
 */
function noPsAlive(proc: any): boolean | 'unknown' {
  const { alive } = require('../worker/process-tree.ts');
  return alive(proc, { run: () => null });
}

/**
 * IC-010: `wx` create. A dead same-host holder is reclaimed only by the one caller holding
 * `lease.reclaim` (itself created with `wx`), which re-reads the stale lease and unlinks it while it
 * still has the bytes judged dead; nothing is ever moved aside and put back (C8). Anything else
 * refuses. A caller re-reads its lease at every boundary (ownsLease), so one that lost it stops.
 */
function acquireLease(dir: string, me: any, alive: (proc: any) => boolean | 'unknown', fsImpl: any): { ok: boolean; holder?: any; text?: string } {
  const file = path.join(dir, 'lease.json');
  const reclaim = path.join(dir, 'lease.reclaim');
  const text = `${JSON.stringify(me)}\n`;
  const parse = (raw: string): any => { try { return JSON.parse(raw); } catch { return null; } };
  const holderOf = (): any => { try { return parse(fsImpl.readFileSync(file, 'utf8')); } catch { return null; } };
  // Only a dead holder on this host with a known pid can be proven gone; an unreadable one is unknown.
  const dead = (holder: any): boolean => Boolean(holder) && typeof holder === 'object' && holder.host === me.host
    && Number.isInteger(holder.pid) && alive({ pid: holder.pid, start: holder.start }) === false;
  fsImpl.mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fsImpl.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
      return { ok: true, text };
    } catch (error: any) { if (error.code !== 'EEXIST') throw error; }
    let raw: string;
    try { raw = fsImpl.readFileSync(file, 'utf8'); }
    catch (error: any) { if (error.code === 'ENOENT') continue; throw error; }
    const holder = parse(raw);
    if (!dead(holder)) return { ok: false, holder };
    try { fsImpl.writeFileSync(reclaim, text, { flag: 'wx', mode: 0o600 }); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      // Another reclaimer is at work, unless it died holding the reclaim file.
      let other: string;
      try { other = fsImpl.readFileSync(reclaim, 'utf8'); } catch (readError: any) { if (readError.code === 'ENOENT') continue; throw readError; }
      if (!dead(parse(other))) return { ok: false, holder };
      try { if (fsImpl.readFileSync(reclaim, 'utf8') === other) fsImpl.unlinkSync(reclaim); } catch { /* gone */ }
      continue;
    }
    try {
      let current: string | null = null;
      try { current = fsImpl.readFileSync(file, 'utf8'); } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
      if (current === raw) fsImpl.unlinkSync(file);
    } finally {
      try { fsImpl.unlinkSync(reclaim); } catch { /* already gone */ }
    }
  }
  return { ok: false, holder: holderOf() };
}

/** C8: the lease file still holds this call's own bytes. Gone, unreadable or another's is lost. */
function ownsLease(ctx: any): boolean {
  if (!ctx.leaseText) return true;
  try { return ctx.fsImpl.readFileSync(path.join(ctx.dir, 'lease.json'), 'utf8') === ctx.leaseText; }
  catch { return false; }
}

/** A caller that lost its lease writes nothing more, not even its checkpoint: another caller owns it. */
function leaseLost(ctx: any): { code: number; result: any } {
  let holder: any = null;
  try {
    const raw = JSON.parse(ctx.fsImpl.readFileSync(path.join(ctx.dir, 'lease.json'), 'utf8'));
    holder = { pid: raw?.pid ?? null, host: raw?.host ?? null, runId: raw?.runId ?? null };
  } catch { /* no holder, or an unreadable one */ }
  return { code: 1, result: bare({ outcome: 'denied', reason: 'lease-lost', rule: 'loop/lease', runId: ctx.record?.runId,
    checkpoint: ctx.record && !ctx.fresh ? relCheckpoint(ctx.record.runId) : null, annotations: { holder } }) };
}

function bare(fields: any): any {
  return { schema: 1, runId: fields.runId ?? null, n: null, outcome: fields.outcome, step: null, row: null,
    reason: fields.reason ?? null, reasons: fields.reason ? [fields.reason] : [], rule: fields.rule ?? null, evidence: [], checkpoint: fields.checkpoint ?? null,
    ...(fields.annotations ? { annotations: fields.annotations } : {}) };
}

/** Unlinks the lease only when it is this call's own. */
function releaseLease(dir: string, me: any, fsImpl: any): void {
  const file = path.join(dir, 'lease.json');
  try {
    const held = JSON.parse(fsImpl.readFileSync(file, 'utf8'));
    if (held && held.pid === me.pid && held.host === me.host && held.runId === me.runId && held.acquiredAt === me.acquiredAt) fsImpl.unlinkSync(file);
  } catch { /* gone, unreadable or another holder's: not ours to remove */ }
}

// ── facts ─────────────────────────────────────────────────────────────────────────────────────────

/** Every git command addresses the named checkout; inherited routing variables are dropped. */
function gitOptionsFor(root: string, env: any): any {
  const environment = { ...env };
  for (const key of Object.keys(environment)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete environment[key];
  return { cwd: root, encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 };
}

/** Develop's committed gates.json, narrowed by the main checkout's override (IC-004). */
function loopPolicy(ctx: any): any {
  const { execFileSync } = ctx;
  let base: string | null = null;
  try {
    const head = String(execFileSync('git', ['-C', ctx.root, 'rev-parse', '--verify', 'refs/heads/develop'], ctx.gitOptions)).trim();
    // Read again by gatherGitFacts in the same step: nothing between the two moves develop (file reads under the lease).
    ctx.policyDevelopHead = head;
    if (/^[0-9a-f]{40}$/.test(head)) base = String(execFileSync('git', ['-C', ctx.root, 'show', '--no-textconv', `${head}:core/registry/gates.json`], ctx.gitOptions));
  } catch { /* no-policy */ }
  const { projectLayerSource } = require('../settings/project-layers.ts');
  const layers = projectLayerSource(ctx.root, ctx.fsImpl);
  let override: string | null = null;
  if (layers.layersFrom) {
    try { override = ctx.fsImpl.readFileSync(path.join(layers.layersFrom, 'gates.override.json'), 'utf8'); }
    catch (error: any) { if (error.code !== 'ENOENT') override = ''; }
  }
  return loadPolicy(base, override);
}

function listWorktrees(ctx: any): Map<string, string> {
  const { execFileSync } = ctx;
  const out = String(execFileSync('git', ['-C', ctx.root, 'worktree', 'list', '--porcelain', '-z'], ctx.gitOptions));
  const map = new Map<string, string>();
  for (const block of out.split('\0\0').filter(Boolean)) {
    const fields = block.split('\0');
    const worktree = fields.find((s) => s.startsWith('worktree '))?.slice(9);
    const branch = fields.find((s) => s.startsWith('branch '))?.slice(7);
    if (worktree && branch) map.set(branch, worktree);
  }
  return map;
}

function readHeads(ctx: any, row: any): { developHead: string; featureHead: string } {
  const { execFileSync } = ctx;
  try {
    const developHead = String(execFileSync('git', ['-C', ctx.root, 'rev-parse', '--verify', 'refs/heads/develop'], ctx.gitOptions)).trim();
    const featureHead = String(execFileSync('git', ['-C', ctx.root, 'rev-parse', '--verify', `refs/heads/feat/${row.slug}`], ctx.gitOptions)).trim();
    return { developHead, featureHead };
  } catch (error: any) { throw new Unreadable([`heads:${row.slug}`], error.message); }
}

/** Tripwire input: first-parent commits on develop that revert a merge carrying DoFlow-Policy. */
function autopilotReverts(ctx: any): Array<{ commit: string; merge: string }> {
  const { execFileSync } = ctx;
  const merges = new Set<string>();
  const listed = String(execFileSync('git', ['-C', ctx.root, 'rev-list', '--no-commit-header', '--first-parent', '--merges',
    '--format=%H%x00%(trailers:key=DoFlow-Policy,valueonly)%x1e', 'refs/heads/develop'], ctx.gitOptions));
  for (const record of listed.split('\x1e')) {
    const [sha, policy] = record.trim().split('\0');
    if (/^[0-9a-f]{40}$/.test(sha || '') && (policy || '').trim()) merges.add(sha);
  }
  if (merges.size === 0) return [];
  const log = String(execFileSync('git', ['-C', ctx.root, 'log', '--first-parent', '--fixed-strings', '--grep=This reverts commit',
    '--format=%H%x00%B%x1e', 'refs/heads/develop'], ctx.gitOptions));
  const found: Array<{ commit: string; merge: string }> = [];
  for (const record of log.split('\x1e')) {
    const [commit, body] = record.trim().split('\0');
    if (!/^[0-9a-f]{40}$/.test(commit || '')) continue;
    for (const match of String(body || '').matchAll(/This reverts commit ([0-9a-f]{40})/g)) {
      if (merges.has(match[1])) found.push({ commit, merge: match[1] });
    }
  }
  return found;
}

/** In its own namespace, so retention reads it as undecidable and keeps it (prune-by-done). */
const tripwireFile = (ctx: any): string => path.join(ctx.dir, 'tripwire', 'events.json');

function readTripwire(ctx: any): any {
  const file = tripwireFile(ctx);
  try {
    const value = JSON.parse(ctx.fsImpl.readFileSync(file, 'utf8'));
    if (!value || value.schema !== 1 || !Array.isArray(value.reverts) || !Array.isArray(value.unverified)) throw new Error('not a schema 1 tripwire record');
    return value;
  } catch (error: any) {
    if (error.code === 'ENOENT') return { schema: 1, reverts: [], unverified: [] };
    throw new Unreadable(['tripwire'], error.message);
  }
}

/** The feature folder: the worktree's own, else the main checkout's (the feature-store rule). */
function artifactRootOf(ctx: any, row: any, worktree: string): string {
  const own = path.join(worktree, 'agent-docs', 'doflow', row.slug);
  const main = path.join(ctx.root, 'agent-docs', 'doflow', row.slug);
  return !ctx.fsImpl.existsSync(own) && ctx.fsImpl.existsSync(main) ? main : own;
}

/** The verify run-record file of a checkout, resolved by the writer's own rule (engine.ts). */
function runRecordFileOf(checkout: string, row: any): string {
  const { verificationRunsRoot, verificationRunRecordFile } = require('../verification/engine.ts');
  return verificationRunRecordFile(verificationRunsRoot(checkout), row.slug);
}

/** IC-008: the bytes a stage must change. The implementation artifact is the feature branch head. */
function stageArtifact(ctx: any, row: any, worktree: string, stage: string): { artifact: string; sha256: string | null } {
  if (stage === 'implementation') {
    const { featureHead } = readHeads(ctx, row);
    return { artifact: `refs/heads/feat/${row.slug}`, sha256: sha256Digest(featureHead) };
  }
  if (stage === 'verification') {
    // Where `verify --action report` appends (IC-007): the lifecycle root, not the feature checkout.
    const file = runRecordFileOf(worktree, row);
    try { return { artifact: file, sha256: sha256Digest(ctx.fsImpl.readFileSync(file)) }; }
    catch (error: any) { if (error.code === 'ENOENT') return { artifact: file, sha256: null }; throw new Unreadable([`artifact:${file}`], error.message); }
  }
  const base = artifactRootOf(ctx, row, worktree);
  const candidates = DOC_ARTIFACTS[stage];
  if (!candidates) throw new Unreadable([`stage:${stage}`], `no artifact is declared for stage '${stage}'`);
  for (const rel of candidates) {
    try { return { artifact: rel, sha256: sha256Digest(ctx.fsImpl.readFileSync(path.join(base, rel))) }; }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Unreadable([`artifact:${path.join(base, rel)}`], error.message); }
  }
  return { artifact: candidates[0], sha256: null };
}

/** The feature's change is measured from where it forked from local develop, never origin (G.3 B3). */
function mergeBaseOf(ctx: any, row: any): string {
  const { execFileSync } = ctx;
  try {
    const base = String(execFileSync('git', ['-C', ctx.root, 'merge-base', 'refs/heads/develop', `refs/heads/feat/${row.slug}`], ctx.gitOptions)).trim();
    if (/^[0-9a-f]{40}$/.test(base)) return base;
  } catch { /* named below */ }
  throw new Unreadable([`merge-base:${row.slug}`], 'no merge base of develop and the feature branch');
}

/**
 * The argv `dispatch start --verify-argv` takes (G.3 B2): the seed's `verifyArgv`, else `npm test`
 * when the feature checkout's package.json declares a test script, else null (never guessed).
 */
function verifyArgvOf(ctx: any, row: any, worktree: string): string[] | null {
  if (Array.isArray(row.verifyArgv)) return row.verifyArgv;
  const file = path.join(worktree, 'package.json');
  let manifest: any;
  try { manifest = JSON.parse(ctx.fsImpl.readFileSync(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw new Unreadable([`package-json:${file}`], error.message); }
  const script = manifest?.scripts?.test;
  return typeof script === 'string' && script.trim() ? ['npm', 'test'] : null;
}

/** IC-008 envelope. Argv arrays only: the session runs them, nothing here is a shell string. */
function envelopeFor(ctx: any, row: any, worktree: string, stage: string, skill: string, before: any, verifyCommand: string[] | null = null): any {
  const handoff = ['orchestrate', '--action', 'handoff', '--task-id', row.slug, '--calling-skill', skill, '--note', '<text>'];
  const base = { outcome: 'perform', runId: ctx.record.runId, row: row.id, slug: row.slug, stage, skill, worktree,
    artifactRoot: artifactRootOf(ctx, row, worktree), before, issuedAt: ctx.now().toISOString() };
  const next = ['roadmap', '--action', 'next', '--run', ctx.record.runId];
  if (stage === 'verification') {
    return { ...base, after: [['verify', '--action', 'report', '--task-id', row.slug, '--baseline-ref', mergeBaseOf(ctx, row)], handoff], next };
  }
  if (stage !== 'implementation') return { ...base, after: handoff, next };
  return { ...base, after: [
    ['dispatch', '--action', 'start', '--slug', row.slug, '--by', LOOP_ACTOR, '--billing-cap', 'free', ...(verifyCommand ? ['--verify-argv', JSON.stringify(verifyCommand)] : [])],
    ['dispatch', '--action', 'run', '--slug', row.slug, '--by', LOOP_ACTOR],
    handoff,
  ], next };
}

/** IC-008: performed = the artifact exists, its bytes changed, and the stage's own handoff is newer. */
function performedCheck(ctx: any, row: any, worktree: string, run: any, perform: any): { ok: boolean; current: any } {
  const current = stageArtifact(ctx, row, worktree, perform.stage);
  if (current.sha256 === null) return { ok: false, current };

  // FU-rcshhx: allow adopting rows whose design/plan artifacts were already completed and recorded
  // in the orchestration run history, even if current.sha256 === perform.before?.sha256.
  const isDesignOrPlan = perform.stage === 'design' || perform.stage === 'planning';
  const alreadyCompleted = isDesignOrPlan && (run.history || []).some((entry: any) =>
    entry && entry.node === perform.stage && (entry.action === 'complete-stage' || entry.action === 'annotate')
  );
  if (alreadyCompleted) return { ok: true, current };

  if (current.sha256 === perform.before?.sha256) return { ok: false, current };
  const issued = Date.parse(perform.issuedAt);
  const handedOff = (run.history || []).some((entry: any) => entry && entry.node === perform.stage
    && ((entry.action === 'complete-stage' && !entry.backfilled) || entry.action === 'annotate')
    && Date.parse(entry.at) > issued);
  return { ok: handedOff, current };
}

function orchestrationFor(ctx: any, row: any, worktree: string): { orch: any; run: any } {
  const { WorkflowOrchestrator } = require('../workflow-orchestrator.ts');
  const { findRunFile } = require('../implementation-gate.ts');
  const source = `orchestration:${row.slug}`;
  const found = findRunFile({ stateRoot: worktree, taskId: row.slug, slug: row.slug });
  if (found.status === 'ambiguous') throw new Unreadable([source], `run '${row.slug}' exists in more than one checkout`);
  const runRoot = found.status === 'found' ? found.root : worktree;
  // Row 134: the same planning-exit check the orchestrate verb wires, the plan read where
  // artifactRootOf finds it (the feature checkout, else the main one).
  const planExitCheck = () => require('../plan-content.ts').planStageExit({ roots: [...new Set([worktree, runRoot, ctx.root])], slug: row.slug });
  const orch = new WorkflowOrchestrator({ repoRoot: ctx.repoRoot, projectRoot: runRoot, sourceRoot: worktree,
    stateDir: path.join(runRoot, '.doflow', 'state', 'orchestration'), featureSlug: row.slug, fsImpl: ctx.fsImpl, env: ctx.env, cwd: worktree, planExitCheck });
  let run: any;
  try { run = orch.readRun(row.slug); } catch (error: any) { throw new Unreadable([source], error.message); }
  if (run && (!Array.isArray(run.program) || !Number.isInteger(run.cursor) || typeof run.state !== 'string' || !Array.isArray(run.history))) {
    throw new Unreadable([source], 'not a workflow run journal');
  }
  return { orch, run };
}

/** The dispatch store and the 080 ledger, read without a lock or a process (IC-037 shapes). */
function defaultDispatchFacts(ctx: any, slug: string): any {
  const { readDispatch } = require('../dispatch/store.ts');
  const { readTaskState } = require('../task-state.ts');
  const { storeFile } = require('../task-attempts.ts');
  const store = readDispatch(path.join(ctx.root, '.doflow', 'state', 'dispatch', `${slug}.json`), ctx.fsImpl);
  if (!store.run) return { state: 'none', pause: null };
  const run = store.run;
  const gaps = Array.isArray(run.blockedReport?.gaps) ? run.blockedReport.gaps : [];
  const facts: any = { state: run.state, cause: run.blockedReport?.cause ?? null, resumeReason: run.resumeReason ?? null,
    repeated: gaps.some((gap: any) => typeof gap?.reason === 'string' && gap.reason.endsWith(': repeated')), pause: null,
    integration: run.integration ? { branch: run.integration.branch ?? null, head: run.integration.head ?? null } : null };
  const ledger = readTaskState(ctx.fsImpl, storeFile(ctx.root, slug));
  const own = ledger?.runs && typeof run.runKey === 'string' && Object.hasOwn(ledger.runs, run.runKey) ? ledger.runs[run.runKey] : null;
  if (own?.control === 'paused') {
    const entry = [...(Array.isArray(own.history) ? own.history : [])].reverse().find((h: any) => h?.action === 'pause') || {};
    facts.pause = { by: entry.by ?? null, reason: entry.reason ?? null };
  }
  return facts;
}

/** The 080 resume report digest, read-only (no ack): what `dispatch --action resume --ack` checks. */
function defaultResumeDigest(ctx: any, slug: string, cwd: string): { digest?: string; error?: string } {
  const attempts = require('../task-attempts.ts');
  const res = attempts.resume({ file: attempts.storeFile(ctx.root, slug), fsImpl: ctx.fsImpl,
    roots: [...new Set([path.resolve(cwd), ctx.root])], slug, env: ctx.env, cwd });
  return res.disposition === 'ack-required' && /^sha256:[0-9a-f]{64}$/.test(res.digest) ? { digest: res.digest } : { error: String(res.reason || res.disposition) };
}

/**
 * The IC-007 verify lines of the row on `head`, judged by gate-b's own rule (C20, gates.ts
 * verifyRecordReasons): [] passes, `verify-missing` means none was recorded yet.
 */
function postMergeReasons(row: any, cwd: string, head: string, fsImpl: any): string[] {
  const source = `verification-runs:${row.slug}`;
  let text = '';
  try { text = fsImpl.readFileSync(runRecordFileOf(cwd, row), 'utf8'); }
  catch (error: any) { if (error.code !== 'ENOENT') throw new Unreadable([source], error.message); }
  const records: any[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch (error: any) { throw new Unreadable([source], error.message); }
  }
  return verifyRecordReasons(records, head, row.slug);
}

const verifyPending = (reasons: string[]): boolean => reasons.includes('verify-missing');

/** The feature plan file the post-merge verify reads (plan.md, else planning/plan.md) and its bytes' digest. */
function featurePlan(ctx: any, row: any, worktree: string): { locator: string; sha256: string; exists: boolean } {
  const root = artifactRootOf(ctx, row, worktree);
  for (const rel of PLAN_FILES) {
    const file = path.join(root, rel);
    try { return { locator: file, sha256: sha256Digest(ctx.fsImpl.readFileSync(file)), exists: true }; }
    catch (error: any) { if (error.code !== 'ENOENT') throw new Unreadable([`plan:${file}`], error.message); }
  }
  return { locator: path.join(root, PLAN_FILES[0]), sha256: sha256Digest(''), exists: false };
}

/**
 * C6: the plan the post-merge verify reads (its `doflow-verification` block replaces the verify
 * commands) must be the bytes gate-b approved. The baseline is the plan digest this run recorded at
 * gate-b, else the gate-b journal entry's own input for that plan path (the shipped gate-b reads the
 * plan through plan-verification-absent). A gate-b whose policy never read the plan, approved in an
 * earlier run, has no baseline: the plan was not part of that approval, and it is not compared.
 */
function planChanged(ctx: any, row: any, intent: any): boolean {
  if (!intent.featureWorktree) return false;
  const current = featurePlan(ctx, row, intent.featureWorktree);
  const recorded = ctx.record.rows[row.id]?.gateBPlan;
  if (recorded) return recorded.locator !== current.locator || recorded.sha256 !== current.sha256;
  let inputs: any[] = [];
  try {
    const { run } = orchestrationFor(ctx, row, intent.featureWorktree);
    const entry = [...(run?.history || [])].reverse().find((h: any) => h?.action === 'decide-gate' && h.node === 'gate-b' && h.detail === 'approve');
    inputs = Array.isArray(entry?.inputs) ? entry.inputs : [];
  } catch { /* no readable journal: no baseline */ }
  const root = artifactRootOf(ctx, row, intent.featureWorktree);
  const planInputs = inputs.filter((input: any) => PLAN_FILES.some((rel) => input?.locator === path.join(root, rel)));
  return planInputs.length > 0 && !planInputs.some((input: any) => input.locator === current.locator && input.sha256 === current.sha256);
}

// ── next (IC-001, design §4 step order) ───────────────────────────────────────────────────────────

function auditLine(fields: any): string {
  const subject = fields.slug || fields.row || '-';
  if (fields.outcome === 'stopped') return `stopped by the ${fields.annotations?.switch || 'setting'} switch${fields.annotations?.tripwire ? ` (tripwire: ${fields.annotations.tripwire})` : ''}`;
  if (fields.reason === 'facts-unreadable') return `${subject} cannot read ${(fields.annotations?.unreadable || []).join(', ')}; nothing is assumed unchanged`;
  if (fields.outcome === 'perform') return `perform ${fields.perform?.stage} ${subject} (${fields.perform?.skill})`;
  if (fields.outcome === 'blocked') return `${subject} blocked: ${fields.reason}`;
  if (fields.outcome === 'denied') return `${subject} denied: ${(fields.reasons || [fields.reason]).join(', ')}${fields.rule ? ` (rule ${fields.rule})` : ''}`;
  return `${fields.step || fields.outcome} ${subject}`;
}

/**
 * One output line, one log entry, one checkpoint write (FR-008). Idle is not a step and logs nothing.
 * `step` names pick|gate|merge|render|cleanup whenever the output concerns one: every `acted`, a gate
 * or merge deny, a stop inside S8. It is null for perform, idle, blocked, lease-held, a stop at a step
 * boundary and loop-level denies.
 */
function finish(ctx: any, fields: any): { code: number; result: any } {
  // C8: a call that lost its lease mid-step writes nothing more.
  if (!ownsLease(ctx)) return leaseLost(ctx);
  const { record } = ctx;
  const outcome = fields.outcome;
  const at = ctx.now().toISOString();
  const logged = outcome !== 'idle';
  const step = fields.step ?? null;
  if (logged && AUDIT_STEPS.includes(step)) {
    // Written before the checkpoint, so a failed audit write leaves the run record as it was.
    appendAudit(ctx.dir, { schema: 1, runId: record.runId, n: record.n + 1, at, row: fields.row ?? null, step, outcome,
      reason: fields.reason ?? null, rule: fields.rule ?? null, inputs: fields.evidence ?? [], annotations: fields.annotations ?? null,
      audit: fields.audit || auditLine(fields) }, ctx.fsImpl);
  }
  if (logged) {
    record.n += 1;
    if (['acted', 'perform', 'denied'].includes(outcome)) record.steps += 1;
    if (fields.row) (record.rows[fields.row] ||= {}).lastStep = record.n;
  }
  if (outcome === 'idle' && fields.close && !ctx.fresh) record.closedAt = at;
  const persisted = logged || !ctx.fresh;
  const result: any = {
    schema: 1, runId: persisted ? record.runId : null, n: persisted ? record.n : null, outcome,
    step: fields.step ?? null, row: fields.row ?? null, reason: fields.reason ?? null,
    reasons: fields.reasons ?? (fields.reason ? [fields.reason] : []), rule: fields.rule ?? null,
    evidence: fields.evidence ?? [], checkpoint: persisted ? relCheckpoint(record.runId) : null,
  };
  if (fields.annotations) result.annotations = fields.annotations;
  if (fields.perform) result.perform = fields.perform;
  if (fields.skips) result.skips = fields.skips;
  if (logged) {
    record.log.push({ n: record.n, at, row: result.row, step: result.step, outcome, reason: result.reason, audit: fields.audit || auditLine(fields) });
    if (record.log.length > LOG_LIMIT) record.log = record.log.slice(-LOG_LIMIT);
  }
  if (persisted) writeJsonAtomic(path.join(ctx.runsDir, `${record.runId}.json`), record, ctx.fsImpl);
  return { code: ['acted', 'perform', 'idle'].includes(outcome) ? 0 : 1, result };
}

function unreadableStep(ctx: any, error: Unreadable, row: any = null): { code: number; result: any } {
  return finish(ctx, { outcome: 'denied', reason: 'facts-unreadable', row: row?.id ?? null, slug: row?.slug,
    rule: 'loop/facts', annotations: { unreadable: error.sources } });
}

/**
 * Read immediately before every mutating act: the lease must still be this call's (C8), and an off
 * switch stops here, after the lease, with a checkpoint (C10).
 */
function boundary(ctx: any, row: any = null): { code: number; result: any } | null {
  if (!ownsLease(ctx)) return leaseLost(ctx);
  const state = ctx.readSwitch();
  return state.enabled ? null : finish(ctx, { outcome: 'stopped', row: row?.id ?? null, annotations: { switch: state.switch } });
}

function tripwireNote(ctx: any, kind: 'reverts' | 'unverified', id: string, line: string): void {
  const tripwire = readTripwire(ctx);
  if (!tripwire[kind].includes(id)) tripwire[kind].push(id);
  // C9: the sentinel first, then the event. A crash between the two writes leaves the stop set and
  // the event unrecorded, so the next scan can only trip again (safe); never an event remembered
  // with no stop.
  require('../settings/autopilot.ts').tripSentinel(ctx.env, line, ctx.fsImpl);
  writeJsonAtomic(tripwireFile(ctx), tripwire, ctx.fsImpl);
}

/** The develop checkout holds no feature folder: point verify at the feature plan so scope resolves. */
function postMergePlan(ctx: any, row: any, intent: any): string[] {
  if (!intent.featureWorktree) return [];
  const plan = featurePlan(ctx, row, intent.featureWorktree);
  return plan.exists ? ['--plan-path', plan.locator] : [];
}

/** C16: the archived merge intent of a row (done/<row>.json), or null. */
function archivedIntent(ctx: any, row: any): any {
  const file = path.join(ctx.dir, 'done', `${row.id}.json`);
  try { return JSON.parse(ctx.fsImpl.readFileSync(file, 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return null; throw new Unreadable(['merge-intents'], error.message); }
}

/** Deny reasons of an open intent that only a person resolves: held per row by digest (C16, C6). */
const INTENT_HOLDS = ['develop-moved', 'plan-changed'];

/**
 * A deny that repeats on unchanged inputs is logged once; while the inputs digest is the same the row
 * is skipped, so other rows advance and no budget is spent.
 */
function heldDeny(ctx: any, row: any, kind: string, reason: string, inputsDigest: string, fields: any = {}): any {
  const slot = (ctx.record.rows[row.id] ||= {});
  if (slot.held && slot.held.kind === kind && slot.held.inputsDigest === inputsDigest) return { skip: `held:${slot.held.reason}` };
  slot.held = { kind, reason, inputsDigest };
  const step = fields.step ?? 'merge';
  return finish(ctx, { outcome: 'denied', step, reason, row: row.id, slug: row.slug, rule: `${step}/${reason}`, ...fields });
}

async function mergeStep(ctx: any, row: any, source: { intent?: any; run?: any; worktree?: string; held?: boolean; holdDigest?: string }): Promise<any> {
  const slot = (ctx.record.rows[row.id] ||= {});
  const intent = source.intent || null;
  let gate: any = null;
  let approvedHead: string | null = null;
  if (intent && slot.held?.kind === 'intent') delete slot.held;
  if (!intent) {
    const entry = [...source.run.history].reverse().find((h: any) => h?.action === 'decide-gate' && h.node === 'gate-b' && h.detail === 'approve');
    if (!entry || entry.by !== 'autopilot' || typeof entry.policy?.digest !== 'string') return { skip: 'gate-b-not-by-policy' };
    // C16: an intent a person archived as `abandoned` is neither resumed nor replaced by the loop
    // (merge.ts would resume an archived intent); the row waits for that person.
    if (archivedIntent(ctx, row)?.status === 'abandoned') return { skip: 'intent-abandoned' };
    gate = { id: 'gate-b', digest: entry.policy.digest };
    // C15: the feature head the loop bound at its own gate-b approval, kept in the journal entry, so
    // it holds across runs while develop moves (merge-tree runs on the current develop).
    if (typeof entry.approvedHead === 'string' && /^[0-9a-f]{40}$/.test(entry.approvedHead)) approvedHead = entry.approvedHead;
    else {
      // A gate-b decided outside this loop: bind to the heads its inputs digest names, else head-moved.
      const heads = readHeads(ctx, row);
      const input = (entry.inputs || []).find((i: any) => typeof i?.locator === 'string' && i.locator.endsWith('#heads'));
      if (input && input.sha256 === sha256Digest(JSON.stringify(heads))) approvedHead = heads.featureHead;
      else return finish(ctx, { outcome: 'denied', step: 'merge', reason: 'head-moved', row: row.id, slug: row.slug, rule: 'merge/head-moved' });
    }
    // C7: approval is not retroactive, except that develop's current policy is reloaded before the
    // first intent is written: a gate-b now `never` for this class denies, and nothing is written.
    const current = loopPolicy(ctx);
    const gateB = current.ok ? current.policy.classes?.[row.class]?.['gate-b'] : null;
    const refusal = !current.ok ? current.reason : !gateB ? 'class-unsupported' : gateB.autopilot === 'never' ? 'policy-never' : null;
    if (refusal) return heldDeny(ctx, row, 'merge-policy', refusal, sha256Digest(JSON.stringify([refusal, current.digest ?? null])));
    if (slot.held?.kind === 'merge-policy') delete slot.held;
  }
  if (intent && intent.phase === 'ff-done' && intent.verifiedHead !== intent.commit && !intent.status) {
    // A held row is not advanced: no post-merge perform, no check, no render or cleanup (C2).
    if (source.held) return { skip: 'row-held' };
    // C6: the post-merge verify reads the feature plan, so it must be the plan gate-b approved.
    if (planChanged(ctx, row, intent)) {
      slot.held = { kind: 'intent', reason: 'plan-changed', inputsDigest: source.holdDigest ?? null };
      return finish(ctx, { outcome: 'denied', step: 'merge', reason: 'plan-changed', row: row.id, slug: row.slug, rule: 'merge/plan-changed' });
    }
    if (verifyPending(postMergeReasons(row, intent.developWorktree, intent.commit, ctx.fsImpl))) {
      // The lean post-merge gate is performed by the session on the new develop head (no non-git spawn).
      const before = { artifact: runRecordFileOf(intent.developWorktree, row), sha256: null };
      const perform = { outcome: 'perform', runId: ctx.record.runId, row: row.id, slug: row.slug, stage: 'verification', skill: 'do-test',
        purpose: 'post-merge', worktree: intent.developWorktree, artifactRoot: null, head: intent.commit, before, issuedAt: ctx.now().toISOString(),
        after: ['verify', '--action', 'report', '--task-id', row.slug, '--baseline-ref', intent.developHead, ...postMergePlan(ctx, row, intent)],
        next: ['roadmap', '--action', 'next', '--run', ctx.record.runId] };
      return finish(ctx, { outcome: 'perform', row: row.id, slug: row.slug, perform });
    }
  }
  const startPhase = intent?.phase || null;
  let pending = false;
  const isEnabled = () => {
    if (!ownsLease(ctx)) return { enabled: false, switch: 'lease-lost' };
    const state = ctx.readSwitch();
    if (!state.enabled) return state;
    // A seed hold set after the fast-forward started settles like an off switch (C2, C3).
    if (source.held) return { enabled: false, switch: 'row-held' };
    let open: any;
    try { open = readOpenIntents({ root: ctx.root, fsImpl: ctx.fsImpl }).find((entry: any) => entry.row === row.id); }
    catch (error: any) { throw new Unreadable(['merge-intents'], error.message); }
    if (open && open.phase === 'ff-done' && open.verifiedHead !== open.commit && !open.status
      && verifyPending(postMergeReasons(row, open.developWorktree, open.commit, ctx.fsImpl))) {
      pending = true;
      return { enabled: false, switch: 'verify-pending' };
    }
    return { enabled: true };
  };
  const postMergeCheck = ({ cwd, head }: any) => ({ ok: postMergeReasons(row, cwd, head, ctx.fsImpl).length === 0 });
  const result = await ctx.mergeImpl({ root: ctx.root, row, runId: ctx.record.runId, gate, approvedHead,
    featureWorktree: source.worktree, env: ctx.env, fsImpl: ctx.fsImpl, now: () => ctx.now().getTime(), isEnabled, postMergeCheck,
    seedPath: ctx.seedPath, roadmapPath: ctx.roadmapPath, staleLockSeconds: ctx.policy.merge.staleLockSeconds });
  const step = !startPhase || ['intent', 'built', 'ff-started'].includes(startPhase) ? 'merge' : startPhase === 'ff-done' ? 'render' : 'cleanup';
  const base = { row: row.id, slug: row.slug };
  if (result.outcome === 'stopped') {
    if (result.annotations?.switch === 'lease-lost') return leaseLost(ctx);
    if (result.annotations?.switch === 'row-held') return { skip: 'row-held' };
    if (pending && result.annotations?.switch === 'verify-pending') {
      return finish(ctx, { ...base, outcome: 'acted', step, annotations: { commit: result.commit, pending: 'post-merge-verification' }, audit: `merge ${row.slug} ${result.commit}; post-merge verification pending` });
    }
    // A stop before any intent is a step-boundary stop; inside S8 it names the phase it stopped after.
    const at = !result.phase ? null : result.phase === 'rendered' ? 'render' : result.phase === 'cleaned' ? 'cleanup' : 'merge';
    return finish(ctx, { ...base, outcome: 'stopped', step: at, annotations: { switch: result.annotations?.switch || 'setting', phase: result.phase } });
  }
  if (result.outcome === 'denied') {
    if (result.error === 'cannot-read-facts') return unreadableStep(ctx, new Unreadable(result.sources || ['merge-facts'], 'merge facts'), row);
    // C16: an open intent denied develop-moved (a person committed on develop) is held per row; the
    // way out is a person's: move .doflow/state/roadmap/intents/<row>.json to done/ with
    // "status": "abandoned" (the loop then skips the row with intent-abandoned), or restore develop.
    if (intent && INTENT_HOLDS.includes(result.reason)) slot.held = { kind: 'intent', reason: result.reason, inputsDigest: source.holdDigest ?? null };
    return finish(ctx, { ...base, outcome: 'denied', step: 'merge', reason: result.reason, rule: `merge/${result.reason}` });
  }
  if (result.outcome === 'merged-unverified') {
    tripwireNote(ctx, 'unverified', result.commit, `merged-unverified ${row.id} ${result.commit}`);
    // The post-merge check is part of the merge step, whichever phase this call resumed from.
    return finish(ctx, { ...base, outcome: 'acted', step: 'merge', annotations: { commit: result.commit, status: 'merged-unverified', tripwire: 'merged-unverified', switch: 'sentinel' },
      audit: `merge ${row.slug} ${result.commit} merged-unverified: tripwire set the sentinel` });
  }
  slot.done = true;
  if (result.cleanup === 'cleanup-kept') {
    // A dirty feature worktree is kept for a person (FR-015); retrying it is not another step.
    if (slot.held?.kind === 'cleanup') return { skip: 'cleanup-kept' };
    slot.held = { kind: 'cleanup', reason: 'cleanup-kept' };
  } else delete slot.held;
  // Decision C12: the S8 tail is one cleanup step; `rendered` says whether this call wrote the table.
  const rendered = result.fileWrites > 0;
  return finish(ctx, { ...base, outcome: 'acted', step: 'cleanup', annotations: { commit: result.commit, cleanup: result.cleanup, rendered },
    audit: `cleanup ${row.slug} ${result.commit} (${result.cleanup}${rendered ? ', table rendered' : ''})` });
}

async function gateStep(ctx: any, row: any, orch: any, gateId: string, worktree: string): Promise<any> {
  const slot = (ctx.record.rows[row.id] ||= {});
  const stop = boundary(ctx, row);
  if (stop) return stop;
  // C15: gate-b binds the feature head read here; the journal entry keeps it only when the gate's own
  // heads fact evaluated the same head, so the binding outlives this run.
  const bindHead = gateId === 'gate-b' ? readHeads(ctx, row).featureHead : undefined;
  let result: any;
  try { result = orch.decideGate({ taskId: row.slug, gateId, policy: gateId, now: ctx.now(), ...(bindHead ? { bindHead } : {}) }); }
  catch (error: any) { throw new Unreadable([`gate:${gateId}:${row.slug}`], error.message); }
  const base = { row: row.id, slug: row.slug, rule: result.rule ?? null, evidence: result.inputs || [] };
  if (result.decision === 'pass') {
    delete slot.held;
    if (gateId === 'gate-b') {
      // C6: the plan bytes gate-b approved: its own plan input, else this loop's read right after it.
      const plan = featurePlan(ctx, row, worktree);
      const approved = (result.inputs || []).find((i: any) => i?.locator === plan.locator);
      slot.gateBPlan = { locator: plan.locator, sha256: approved ? approved.sha256 : plan.sha256 };
    }
    return finish(ctx, { ...base, outcome: 'acted', step: 'gate',
      audit: `${gateId} ${row.slug} approved by policy ${result.policy.id}@${result.policy.digest} (${(result.inputs || []).length} inputs)` });
  }
  if (result.reason === 'autopilot-disabled') return finish(ctx, { row: row.id, outcome: 'stopped', annotations: { switch: result.annotations?.switch || 'setting' } });
  const digest = result.inputsDigest || sha256Digest(JSON.stringify([result.reasons, result.policy || null]));
  if (slot.held && slot.held.kind === 'gate' && slot.held.gate === gateId && slot.held.inputsDigest === digest) return { skip: `held:${slot.held.reason}` };
  slot.held = { kind: 'gate', gate: gateId, reason: result.reason, rule: result.rule ?? null, inputsDigest: digest };
  return finish(ctx, { ...base, outcome: 'denied', step: 'gate', reason: result.reason, reasons: result.reasons,
    audit: `${gateId} ${row.slug} denied by policy: ${result.reasons.join(', ')}${result.rule ? ` (rule ${result.rule})` : ''}` });
}

function performStep(ctx: any, row: any, worktree: string, node: any): any {
  const slot = (ctx.record.rows[row.id] ||= {});
  if (node.id === 'review') {
    // IC-007: gate-b's own verify rule, applied before the review envelope is spent. No question, no prompt.
    const head = readHeads(ctx, row).featureHead;
    const reasons = postMergeReasons(row, worktree, head, ctx.fsImpl);
    if (reasons.length) {
      return heldDeny(ctx, row, 'review', reasons[0],
        sha256Digest(JSON.stringify({ reasons, head, record: stageArtifact(ctx, row, worktree, 'verification').sha256 })), { step: 'review', reasons });
    }
    if (slot.held?.kind === 'review') delete slot.held;
  }
  slot.perform = envelopeFor(ctx, row, worktree, node.id, node.skill, stageArtifact(ctx, row, worktree, node.id));
  return finish(ctx, { outcome: 'perform', row: row.id, slug: row.slug, perform: slot.perform });
}

/** FR-020: only the dispatch's own pause is resumed, and only while its report is unchanged. */
function resumeStep(ctx: any, row: any, worktree: string): any {
  const slot = (ctx.record.rows[row.id] ||= {});
  let got: any;
  try { got = ctx.resumeDigest(row.slug, worktree); } catch (error: any) { got = { error: error.message }; }
  if (!got || got.error || !/^sha256:[0-9a-f]{64}$/.test(got.digest || '')) throw new Unreadable([`resume-report:${row.slug}`], got?.error || 'no digest');
  slot.dispatch ||= {};
  if (!slot.dispatch.resumeAck) slot.dispatch.resumeAck = got.digest;
  else if (slot.dispatch.resumeAck !== got.digest) {
    return finish(ctx, { outcome: 'denied', reason: 'report-changed', row: row.id, slug: row.slug, rule: 'dispatch/resume',
      annotations: { recorded: slot.dispatch.resumeAck, current: got.digest } });
  }
  const perform = envelopeFor(ctx, row, worktree, 'implementation', 'do-execute-plan', slot.perform?.before || stageArtifact(ctx, row, worktree, 'implementation'));
  perform.after = [
    ['dispatch', '--action', 'resume', '--slug', row.slug, '--ack', slot.dispatch.resumeAck, '--by', LOOP_ACTOR],
    ['dispatch', '--action', 'run', '--slug', row.slug, '--by', LOOP_ACTOR],
    perform.after[2],
  ];
  slot.perform = perform;
  return finish(ctx, { outcome: 'perform', row: row.id, slug: row.slug, perform });
}

function dispatchFactsOf(ctx: any, row: any): any {
  try { return ctx.dispatchFacts(row.slug); } catch (error: any) { throw new Unreadable([`dispatch:${row.slug}`], error.message); }
}

/**
 * G.3 B2: a completed dispatch leaves its work on `doflow/<slug>/p-*`. Land it on the feature branch
 * by `merge --ff-only` in the feature checkout (switch read first); anything but a fast-forward is
 * `blocked: stuck` with nothing changed. Returns null when there is nothing (more) to land.
 */
function landDispatch(ctx: any, row: any, worktree: string, facts: any): any {
  const { execFileSync } = ctx;
  const slot = (ctx.record.rows[row.id] ||= {});
  const integration = facts?.integration;
  if (facts?.state !== 'completed' || !integration) return null;
  if (typeof integration.branch !== 'string' || !/^doflow\/[A-Za-z0-9][A-Za-z0-9._-]*\/p-[0-9a-f]{12}$/.test(integration.branch)
    || !/^[0-9a-f]{40}$/.test(integration.head || '')) throw new Unreadable([`dispatch:${row.slug}`], 'integration branch or head is not recorded');
  const { featureHead } = readHeads(ctx, row);
  if (featureHead === integration.head) return null;
  let fastForward = false;
  try {
    const branchHead = String(execFileSync('git', ['-C', ctx.root, 'rev-parse', '--verify', `refs/heads/${integration.branch}`], ctx.gitOptions)).trim();
    execFileSync('git', ['-C', ctx.root, 'merge-base', '--is-ancestor', featureHead, integration.head], ctx.gitOptions);
    fastForward = branchHead === integration.head;
  } catch (error: any) { if (error.status !== 1) throw new Unreadable([`integration:${row.slug}`], error.message); }
  const blocked = () => {
    const digest = sha256Digest(JSON.stringify({ facts, featureHead }));
    if (slot.held && slot.held.kind === 'dispatch' && slot.held.inputsDigest === digest) return { skip: `held:${slot.held.reason}` };
    slot.held = { kind: 'dispatch', reason: 'stuck', inputsDigest: digest };
    return finish(ctx, { outcome: 'blocked', reason: 'stuck', row: row.id, slug: row.slug, rule: 'dispatch/not-fast-forward',
      annotations: { dispatch: 'not-fast-forward', branch: integration.branch } });
  };
  if (!fastForward) return blocked();
  const stop = boundary(ctx, row);
  if (stop) return stop;
  // Hooks are disabled: the landing launches only git.
  try { execFileSync('git', ['-C', worktree, '-c', 'core.hooksPath=/dev/null', 'merge', '--ff-only', '-q', integration.branch], ctx.gitOptions); }
  catch { return blocked(); }
  return null;
}

/** Design §4 dispatch map (FR-019, FR-020, FR-022, FR-023; rulings C2, C6). */
function implementationStep(ctx: any, row: any, worktree: string): any {
  const slot = (ctx.record.rows[row.id] ||= {});
  const facts = dispatchFactsOf(ctx, row);
  const verifyCommand = verifyArgvOf(ctx, row, worktree);
  const digest = sha256Digest(JSON.stringify({ facts, verifyCommand }));
  const base = { row: row.id, slug: row.slug };
  const hold = (reason: string, fields: any) => {
    if (slot.held && slot.held.kind === 'dispatch' && slot.held.inputsDigest === digest) return { skip: `held:${slot.held.reason}` };
    slot.held = { kind: 'dispatch', reason, inputsDigest: digest };
    return finish(ctx, { ...base, ...fields });
  };
  const pause = facts?.pause;
  if (pause && ['none', 'running'].includes(facts.state)) {
    slot.paused = { reason: pause.reason };
    if (QUOTA.test(String(pause.reason || ''))) {
      return hold('quota', { outcome: 'blocked', reason: 'quota', rule: 'dispatch/paused', annotations: { pause: pause.reason } });
    }
    if (pause.by !== DISPATCH_ACTOR) {
      return hold('pause-not-machine', { outcome: 'denied', reason: 'pause-not-machine', rule: 'dispatch/paused', annotations: { pause: pause.reason, by: pause.by } });
    }
    return resumeStep(ctx, row, worktree);
  }
  switch (facts?.state) {
    case 'none':
    case 'running': {
      if (slot.held?.kind === 'dispatch' && verifyCommand) delete slot.held;
      delete slot.paused;
      delete slot.dispatch;
      if (!slot.perform || slot.perform.stage !== 'implementation') {
        if (!verifyCommand) {
          return hold('stuck', { outcome: 'blocked', reason: 'stuck', rule: 'dispatch/verify-argv', annotations: { dispatch: 'no-verify-argv' } });
        }
        slot.perform = envelopeFor(ctx, row, worktree, 'implementation', 'do-execute-plan', stageArtifact(ctx, row, worktree, 'implementation'), verifyCommand);
      }
      return finish(ctx, { ...base, outcome: 'perform', perform: slot.perform });
    }
    case 'completed': {
      const landing = landDispatch(ctx, row, worktree, facts);
      if (landing) return landing;
      // The run is still on implementation, so the stage's own handoff has not been recorded.
      if (!slot.perform || slot.perform.stage !== 'implementation') {
        slot.perform = envelopeFor(ctx, row, worktree, 'implementation', 'do-execute-plan',
          { artifact: `refs/heads/feat/${row.slug}`, sha256: slot.claimHead ? sha256Digest(slot.claimHead) : null }, verifyCommand);
      }
      return finish(ctx, { ...base, outcome: 'denied', reason: 'stage-not-performed', rule: 'perform/implementation', perform: slot.perform });
    }
    case 'blocked':
      return hold('stuck', { outcome: 'blocked', reason: 'stuck', rule: facts.repeated ? 'dispatch/repeated' : 'dispatch/blocked', annotations: { dispatch: 'blocked', cause: facts.cause } });
    case 'cancelling':
    case 'cancelled':
      return hold('stuck', { outcome: 'blocked', reason: 'stuck', rule: 'dispatch/cancelled', annotations: { dispatch: 'cancelled' } });
    case 'resume-required':
      return resumeStep(ctx, row, worktree);
    default:
      throw new Unreadable([`dispatch:${row.slug}`], `unknown dispatch run state '${facts?.state}'`);
  }
}

/** One in-flight row: pending perform check, then its orchestration state. Returns a result or a skip. */
async function stepRow(ctx: any, row: any, worktrees: Map<string, string>): Promise<any> {
  const slot = (ctx.record.rows[row.id] ||= {});
  if (row.class !== 'feature') return { skip: 'class-unsupported' };
  // A seed hold (decision C8) also stops autopilot from advancing a row already in flight.
  if (row.hold) return { skip: 'row-held' };
  // maint-thin: so does a proposed row (a branch a person started by hand); a person promotes it first.
  if (row.proposed === true) return { skip: 'row-proposed' };
  if (slot.paused?.reason === 'budget') delete slot.paused;
  const worktree = worktrees.get(`refs/heads/feat/${row.slug}`);
  if (!worktree) return { skip: 'no-worktree' };
  const { orch, run } = orchestrationFor(ctx, row, worktree);
  if (!run) {
    // A claim interrupted after `worktree add`: finish it.
    const stop = boundary(ctx, row);
    if (stop) return stop;
    orch.start({ taskId: row.slug, taskClass: 'feature', now: ctx.now() });
    return finish(ctx, { outcome: 'acted', step: 'pick', row: row.id, slug: row.slug, annotations: { worktree }, audit: `pick ${row.slug}: run started in ${worktree}` });
  }
  const node = run.cursor < run.program.length ? run.program[run.cursor] : null;
  const atImplementation = run.state === 'RUNNING' && node?.type === 'stage' && node.id === 'implementation';
  if (slot.perform && !(atImplementation && slot.perform.stage === 'implementation')) {
    if (slot.perform.stage === 'implementation') {
      // The session handed off right after `dispatch run`: land the dispatch before checking the head.
      const landing = landDispatch(ctx, row, worktree, dispatchFactsOf(ctx, row));
      if (landing) return landing;
    }
    const checked = performedCheck(ctx, row, worktree, run, slot.perform);
    if (!checked.ok && slot.perform.stage === 'planning' && checked.current.sha256 !== null) {
      // Row 134: a written plan whose handoff did not land is the constitution exit refusing it; the
      // row stays at planning with that refusal recorded, and no one is asked.
      try { orch.assertPlanExit(run.program.find((n: any) => n.id === 'planning'), run); } catch (error: any) {
        return finish(ctx, { outcome: 'denied', reason: 'plan-exit-refused', row: row.id, slug: row.slug, rule: 'perform/planning',
          evidence: [{ locator: checked.current.artifact, sha256: checked.current.sha256 }], annotations: { refusal: error.message }, perform: slot.perform });
      }
    }
    if (!checked.ok) {
      return finish(ctx, { outcome: 'denied', reason: 'stage-not-performed', row: row.id, slug: row.slug, rule: `perform/${slot.perform.stage}`,
        evidence: [{ locator: checked.current.artifact, sha256: checked.current.sha256 }], perform: slot.perform });
    }
    delete slot.perform;
  }
  if (run.state === 'REJECTED') return { skip: 'run-rejected' };
  if (run.state === 'AWAITING_GATE' && node?.type === 'gate') return gateStep(ctx, row, orch, node.id, worktree);
  if (run.state === 'COMPLETED') return mergeStep(ctx, row, { run, worktree });
  if (run.state === 'RUNNING' && node?.type === 'stage') {
    return node.id === 'implementation' ? implementationStep(ctx, row, worktree) : performStep(ctx, row, worktree, node);
  }
  throw new Unreadable([`orchestration:${row.slug}`], `run state '${run.state}' has no actionable node`);
}

/** Render if stale (at most one write), then merge.ts's non-force cleanup; a kept row is held. */
function finishMergedRow(ctx: any, row: any, rows: any[], statuses: any, worktree: string | null, worktrees: Map<string, string>): any {
  const slot = (ctx.record.rows[row.id] ||= {});
  const stop = boundary(ctx, row);
  if (stop) return stop;
  const develop = worktrees.get('refs/heads/develop');
  if (!develop) return finish(ctx, { outcome: 'denied', step: 'cleanup', reason: 'no-develop-worktree', row: row.id, slug: row.slug, rule: 'cleanup/no-develop-worktree' });
  const { written } = renderRoadmapFile({ roadmapPath: ctx.roadmapPath, content: render(rows, statuses), fsImpl: ctx.fsImpl });
  let featureHead: string | null = null;
  try { featureHead = String(ctx.execFileSync('git', ['-C', ctx.root, 'rev-parse', '--verify', `refs/heads/feat/${row.slug}`], ctx.gitOptions)).trim(); }
  catch { /* branch already gone: only a leftover worktree remains */ }
  // C10: the switch (and the lease) is read again after the render, right before the cleanup.
  const stopCleanup = boundary(ctx, row);
  if (stopCleanup) return stopCleanup;
  const cleaned = cleanupFeature({ intent: { featureWorktree: worktree, featureBranch: `feat/${row.slug}`, featureHead },
    root: ctx.root, develop, execFileSync: ctx.execFileSync, execOptions: ctx.gitOptions, fsImpl: ctx.fsImpl });
  slot.done = true;
  if (!cleaned) {
    if (slot.held?.kind === 'cleanup' && !written) return { skip: 'cleanup-kept' };
    slot.held = { kind: 'cleanup', reason: 'cleanup-kept' };
  } else delete slot.held;
  const cleanup = cleaned ? 'cleaned' : 'cleanup-kept';
  return finish(ctx, { outcome: 'acted', step: 'cleanup', row: row.id, slug: row.slug, annotations: { cleanup, rendered: written },
    audit: `cleanup ${row.slug} merged without an intent: ${cleanup}${written ? ', table rendered' : ''}` });
}

/** The seed layout, kept a sibling of the main checkout: seed text never chooses an arbitrary path. */
function layoutPath(ctx: any, seed: any, row: any): string | null {
  const template = typeof seed.layout?.worktree === 'string' ? seed.layout.worktree : '{mainParent}/{mainName}-{id}';
  const values: Record<string, string> = { mainParent: path.dirname(ctx.root), mainName: path.basename(ctx.root), id: row.id, slug: row.slug };
  const resolved = path.resolve(template.replace(/\{(mainParent|mainName|id|slug)\}/g, (_: string, key: string) => values[key]));
  return path.dirname(resolved) === path.dirname(ctx.root) && resolved !== ctx.root ? resolved : null;
}

async function claimStep(ctx: any, row: any, seed: any, developHead: string): Promise<any> {
  const { execFileSync } = ctx;
  const worktree = layoutPath(ctx, seed, row);
  if (!worktree) throw new Unreadable(['seed-layout'], 'layout.worktree must name a sibling of the main checkout');
  const stop = boundary(ctx, row);
  if (stop) return stop;
  // Hooks are disabled: the claim launches only git.
  execFileSync('git', ['-C', ctx.root, '-c', 'core.hooksPath=/dev/null', 'worktree', 'add', '-b', `feat/${row.slug}`, worktree, developHead], ctx.gitOptions);
  ctx.record.rows[row.id] = { claimedAt: ctx.now().toISOString(), claimHead: developHead, worktree };
  // C10: read again before the next mutation; a stopped claim is finished by a later call (stepRow).
  const stopStart = boundary(ctx, row);
  if (stopStart) return stopStart;
  const { orch } = orchestrationFor(ctx, row, worktree);
  orch.start({ taskId: row.slug, taskClass: 'feature', now: ctx.now() });
  return finish(ctx, { outcome: 'acted', step: 'pick', row: row.id, slug: row.slug, annotations: { worktree, developHead },
    audit: `pick ${row.slug} at ${developHead} into ${worktree}` });
}

async function underLease(ctx: any, options: any): Promise<any> {
  const { fsImpl } = ctx;
  const loaded = loadRunRecord(ctx.runsDir, options.run, ctx.now(), fsImpl);
  ctx.record = loaded.record;
  ctx.fresh = loaded.fresh;

  const policy = loopPolicy(ctx);
  if (!policy.ok) return finish(ctx, { outcome: 'denied', reason: policy.reason, reasons: policy.reasons, rule: 'loop/policy' });
  ctx.policy = policy.policy;
  const record = ctx.record;
  record.maxSteps = policy.policy.loop.maxSteps;

  // Budget (FR-017): a cap pauses the next row with its checkpoint; it never fails anything.
  if (record.steps >= record.maxSteps) {
    const next = Object.entries(record.rows).filter(([, slot]: any) => !slot.done)
      .sort((a: any, b: any) => (a[1].lastStep ?? 0) - (b[1].lastStep ?? 0) || (a[0] < b[0] ? -1 : 1))[0];
    const rowId = next ? next[0] : null;
    if (rowId) record.rows[rowId].paused = { reason: 'budget', cap: record.maxSteps };
    return finish(ctx, { outcome: 'blocked', reason: 'budget', row: rowId, rule: 'loop/maxSteps',
      annotations: { cap: record.maxSteps, steps: record.steps },
      audit: `blocked: budget, maxSteps ${record.maxSteps} reached after ${record.steps} steps; row ${rowId || '-'} paused with its checkpoint` });
  }

  // Facts. A source that cannot be read is named; it is never read as "nothing changed".
  let seed: any;
  try { seed = parseSeed(fsImpl.readFileSync(ctx.seedPath, 'utf8')); }
  catch (error: any) {
    // A typed status is a closed-vocabulary deny, not an unreadable seed (C4).
    if (error?.code === 'seed-typed-status') {
      return finish(ctx, { outcome: 'denied', reason: 'seed-typed-status', row: error.rowId ?? null, rule: 'loop/seed' });
    }
    throw new Unreadable(['seed'], error.message);
  }
  const facts = options.gitFacts || gatherGitFacts({ root: ctx.root, developHead: ctx.policyDevelopHead });
  if (facts.unreadable?.length) throw new Unreadable(facts.unreadable, 'git facts');
  let intents: any[];
  try { intents = readOpenIntents({ root: ctx.root, fsImpl }); } catch (error: any) { throw new Unreadable(['merge-intents'], error.message); }
  let worktrees: Map<string, string>;
  try { worktrees = listWorktrees(ctx); } catch (error: any) { throw new Unreadable(['worktrees'], error.message); }
  let reverts: any[];
  try { reverts = autopilotReverts(ctx); } catch (error: any) { throw new Unreadable(['develop-history'], error.message); }

  // Tripwire (P2, narrowing only): each revert of an autopilot merge, and each merged-unverified
  // result, sets the sentinel once; a person clears it.
  const tripwire = readTripwire(ctx);
  const revert = reverts.find((entry) => !tripwire.reverts.includes(entry.commit));
  if (revert) {
    tripwireNote(ctx, 'reverts', revert.commit, `revert ${revert.commit} of autopilot merge ${revert.merge}`);
    return finish(ctx, { outcome: 'stopped', annotations: { switch: 'sentinel', tripwire: 'revert', commit: revert.commit, merge: revert.merge } });
  }
  const unverified = intents.find((intent) => intent.status === 'merged-unverified' && !tripwire.unverified.includes(intent.commit));
  if (unverified) {
    tripwireNote(ctx, 'unverified', unverified.commit, `merged-unverified ${unverified.row} ${unverified.commit}`);
    return finish(ctx, { outcome: 'stopped', row: unverified.row, annotations: { switch: 'sentinel', tripwire: 'merged-unverified', commit: unverified.commit } });
  }

  const rows = seed.rows;
  const byId = new Map<string, any>(rows.map((row: any) => [row.id, row]));
  const { statuses } = deriveStatus(rows, facts);
  const skips: Record<string, string> = {};

  // An open merge intent resumes S8 first (design §5).
  for (const intent of intents) {
    if (options.row && intent.row !== options.row) continue;
    const row = byId.get(intent.row);
    if (!row) { skips[intent.row] = 'row-unknown'; continue; }
    // C2: a seed hold set after the intent stops the merge before the fast-forward starts; from
    // ff-started on, mergeStep settles the row as under an off switch.
    if (row.hold && ['intent', 'built'].includes(intent.phase)) { skips[row.id] = 'row-held'; continue; }
    if (row.proposed === true && ['intent', 'built'].includes(intent.phase)) { skips[row.id] = 'row-proposed'; continue; }
    // C16, C6: a hold on this intent (develop-moved, plan-changed) stands while the intent, develop's
    // head and the feature plan are unchanged.
    const slot = (record.rows[row.id] ||= {});
    const holdDigest = sha256Digest(JSON.stringify({ intent, developHead: facts.developHead,
      plan: intent.featureWorktree ? featurePlan(ctx, row, intent.featureWorktree).sha256 : null }));
    if (slot.held?.kind === 'intent' && slot.held.inputsDigest === holdDigest) { skips[row.id] = `held:${slot.held.reason}`; continue; }
    // A merged-unverified intent is retried once a person cleared the sentinel: merge.ts rechecks
    // the head before render and cleanup, and a fresh failure trips the sentinel again.
    const outcome = await mergeStep(ctx, row, { intent, held: Boolean(row.hold), holdDigest });
    if (outcome.skip) { skips[row.id] = outcome.skip; continue; }
    return outcome;
  }

  // In-flight rows, least recently stepped first, then seed order; one row per call (C3).
  const inFlight = rows.filter((row: any) => statuses.get(row.id)?.status === 'in-flight' && !skips[row.id] && (!options.row || row.id === options.row));
  const order = (row: any) => record.rows[row.id]?.lastStep ?? -1;
  inFlight.sort((a: any, b: any) => order(a) - order(b) || rows.indexOf(a) - rows.indexOf(b));
  for (const row of inFlight) {
    let outcome: any;
    try { outcome = await stepRow(ctx, row, worktrees); }
    catch (error: any) { if (error instanceof Unreadable) return unreadableStep(ctx, error, row); throw error; }
    if (outcome.skip) { skips[row.id] = outcome.skip; continue; }
    return outcome;
  }

  // Merged rows with no intent (merged by a person, or archived before cleanup finished): render,
  // then non-force cleanup (design §4 `merged -> render, then cleanup`).
  for (const row of rows) {
    // Only trailer evidence: a row merged by a seeded pre-108 pointer belongs to a person.
    const info = statuses.get(row.id);
    if (info?.status !== 'merged' || info.evidence?.kind !== 'trailer' || skips[row.id] || (options.row && row.id !== options.row)) continue;
    const worktree = worktrees.get(`refs/heads/feat/${row.slug}`) || null;
    if (!worktree && !facts.branches.includes(`feat/${row.slug}`)) continue;
    const outcome = finishMergedRow(ctx, row, rows, statuses, worktree, worktrees);
    if (outcome.skip) { skips[row.id] = outcome.skip; continue; }
    return outcome;
  }

  if (!options.row) {
    const picked = pick(rows, statuses, { wip: ctx.policy.loop.wip });
    if (picked.picked) return claimStep(ctx, picked.picked, seed, facts.developHead);
    for (const [id, reason] of Object.entries(picked.skips)) skips[id] ??= reason as string;
  }
  for (const row of rows) {
    if (skips[row.id]) continue;
    const status = statuses.get(row.id)?.status;
    if (options.row && row.id !== options.row) continue;
    skips[row.id] = status === 'merged' ? 'merged' : status === 'in-flight' ? 'in-flight' : 'not-in-flight';
  }
  return finish(ctx, { outcome: 'idle', skips, close: !options.row && inFlight.length === 0 && intents.length === 0 });
}

/** One `next` (IC-001). Returns the exit code and the JSON line; never throws for a refusal. */
async function next(options: any = {}): Promise<{ code: number; result: any }> {
  // One call, one git memo scope (git-memo.ts): the project root and common directory are asked once.
  return withGitMemo(() => nextInScope(options));
}

async function nextInScope(options: any): Promise<{ code: number; result: any }> {
  const fsImpl = options.fsImpl || fs;
  const env = options.env || process.env;
  const root = options.root || resolveMainRoot(options.cwd || process.cwd());
  const dir = path.join(root, '.doflow', 'state', 'roadmap');
  const ctx: any = {
    root, env, fsImpl, dir, runsDir: path.join(dir, 'runs'),
    now: options.now || (() => new Date()),
    execFileSync: options.execFileSync || defaultExecFileSync,
    gitOptions: gitOptionsFor(root, env),
    repoRoot: options.repoRoot || require('../../helper/repo-root.ts').REPO_ROOT,
    seedPath: options.seedPath || path.join(root, 'agent-docs', 'roadmap', 'rows.json'),
    roadmapPath: options.roadmapPath || path.join(root, 'agent-docs', 'roadmap', 'ROADMAP.md'),
    mergeImpl: options.mergeImpl || mergeRoadmapRow,
    readSwitch: () => require('../settings/autopilot.ts').readKillSwitch(env),
  };
  ctx.dispatchFacts = options.dispatchFacts || ((slug: string) => defaultDispatchFacts(ctx, slug));
  ctx.resumeDigest = options.resumeDigest || ((slug: string, cwd: string) => defaultResumeDigest(ctx, slug, cwd));
  let known: any = null;
  try { known = options.run ? readRunFile(path.join(ctx.runsDir, `${options.run}.json`), fsImpl) : readRunRecords(ctx.runsDir, fsImpl).filter((r) => !r.closedAt).at(-1); }
  catch { /* named below, under the lease */ }

  // 1. Kill switch, before anything is taken or written. An intent at `ff-started` is only settled
  //    (merge.ts, C3): a develop already at the commit records `ff-done` and a proven-dead partial is
  //    repaired, then the call stops; a clean develop still at its old head returns `stopped` with
  //    phase `ff-started` and no new fast-forward.
  const first = ctx.readSwitch();
  let settle = false;
  if (!first.enabled) {
    try { settle = readOpenIntents({ root, fsImpl }).some((intent: any) => intent.phase === 'ff-started'); } catch { settle = false; }
    if (!settle) {
      return { code: 1, result: bare({ outcome: 'stopped', runId: known?.runId, checkpoint: known ? relCheckpoint(known.runId) : null, annotations: { switch: first.switch } }) };
    }
  }

  // 2. Lease, held for this one call.
  const me = { schema: 1, pid: options.pid ?? process.pid, start: new Date(Date.now() - (process as any).uptime() * 1000).toISOString(),
    host: options.host ?? os.hostname(), runId: options.run || known?.runId || null, acquiredAt: ctx.now().toISOString() };
  const lease = acquireLease(dir, me, options.alive || noPsAlive, fsImpl);
  if (!lease.ok) {
    const holder = lease.holder && typeof lease.holder === 'object' ? { pid: lease.holder.pid ?? null, host: lease.holder.host ?? null, runId: lease.holder.runId ?? null } : null;
    return { code: 1, result: bare({ outcome: 'denied', reason: 'lease-held', runId: known?.runId, annotations: { holder } }) };
  }
  ctx.leaseText = lease.text;
  try {
    if (settle) {
      const loaded = loadRunRecord(ctx.runsDir, options.run, ctx.now(), fsImpl);
      ctx.record = loaded.record;
      ctx.fresh = loaded.fresh;
      const policy = loopPolicy(ctx);
      ctx.policy = policy.ok ? policy.policy : { merge: { staleLockSeconds: 120 } };
      const intent = readOpenIntents({ root, fsImpl }).find((entry: any) => entry.phase === 'ff-started');
      const row = parseSeed(fsImpl.readFileSync(ctx.seedPath, 'utf8')).rows.find((entry: any) => entry.id === intent?.row);
      if (intent && row) return await mergeStep(ctx, row, { intent });
      return finish(ctx, { outcome: 'stopped', annotations: { switch: first.switch } });
    }
    return await underLease(ctx, options);
  } catch (error: any) {
    if (error instanceof Unreadable) {
      if (!ctx.record) return { code: 1, result: bare({ outcome: 'denied', reason: 'facts-unreadable', rule: 'loop/facts', annotations: { unreadable: error.sources } }) };
      return unreadableStep(ctx, error);
    }
    throw error;
  } finally {
    releaseLease(dir, me, fsImpl);
  }
}

async function nextCommand(options: any): Promise<number> {
  const json = Boolean(options.json);
  if (options.run !== undefined && !RUN_ID.test(String(options.run))) return usageError('--run must be rl-<yyyymmdd>-<4 crockford characters>', json);
  let out: any;
  try { out = await next(options); }
  catch (error: any) {
    if (json) console.log(JSON.stringify({ schema: 1, action: 'next', error: 'runtime', message: error.message }));
    else console.error(`doflow roadmap: error: ${error.message}`);
    process.exitCode = 2;
    return 2;
  }
  const r = out.result;
  if (json) console.log(JSON.stringify(r));
  else {
    console.log(`roadmap next: ${r.outcome}${r.step ? ` ${r.step}` : ''}${r.row ? ` row ${r.row}` : ''}${r.reason ? `: ${r.reasons.join(', ')}` : ''}${r.annotations?.switch ? ` (switch: ${r.annotations.switch})` : ''}${r.runId ? ` [${r.runId} #${r.n}]` : ''}`);
    if (r.perform) console.log(JSON.stringify(r.perform));
    if (r.skips) for (const [id, reason] of Object.entries(r.skips)) console.log(`  ${id.padEnd(6)} ${reason}`);
  }
  process.exitCode = out.code;
  return out.code;
}

/**
 * `audit`: every logged step of every run (or `--run`), oldest run first. Gate and merge entries
 * the 500-entry log or retention dropped come from audit.jsonl, with their inputs (C17).
 */
function auditCommand(options: any): number {
  const json = Boolean(options.json);
  const fsImpl = options.fsImpl || fs;
  if (options.run !== undefined && !RUN_ID.test(String(options.run))) return usageError('--run must be rl-<yyyymmdd>-<4 crockford characters>', json);
  const root = options.root || resolveMainRoot(options.cwd || process.cwd());
  const dir = path.join(root, '.doflow', 'state', 'roadmap');
  let records: any[];
  let durable: any[];
  try {
    records = readRunRecords(path.join(dir, 'runs'), fsImpl);
    durable = readAudit(dir, fsImpl);
  } catch (error: any) {
    const sources = error instanceof Unreadable ? error.sources : ['run-records'];
    if (json) console.log(JSON.stringify({ schema: 1, action: 'audit', error: 'cannot-read-facts', sources }));
    else console.error(`doflow roadmap: cannot read ${sources.join(', ')}`);
    process.exitCode = 1;
    return 1;
  }
  // A run sorts by its record's createdAt, or by its first audit entry once the record is pruned; an
  // entry in both places is shown once, with the audit file's inputs.
  const byRun = new Map<string, { key: string; entries: Map<number, any> }>();
  const add = (runId: string, entry: any, key: string) => {
    if (options.run && runId !== options.run) return;
    const run = byRun.get(runId) || { key, entries: new Map() };
    byRun.set(runId, run);
    if (key < run.key) run.key = key;
    if (!run.entries.has(entry.n)) run.entries.set(entry.n, { runId, ...entry });
  };
  for (const entry of durable) {
    if (entry && typeof entry.runId === 'string' && Number.isSafeInteger(entry.n)) {
      const rest = { ...entry };
      delete rest.schema;
      delete rest.runId;
      add(entry.runId, rest, String(entry.at));
    }
  }
  for (const record of records) for (const entry of record.log) add(record.runId, entry, record.createdAt);
  const entries = [...byRun.entries()]
    .sort(([a, x], [b, y]) => (x.key < y.key ? -1 : x.key > y.key ? 1 : a < b ? -1 : 1))
    .flatMap(([, run]) => [...run.entries.values()].sort((a, b) => a.n - b.n));
  if (json) console.log(JSON.stringify({ schema: 1, action: 'audit', entries }));
  else for (const entry of entries) console.log(`${entry.at} ${entry.runId} #${entry.n} ${entry.audit}`);
  return 0;
}

module.exports = {
  handleRoadmapCommand,
  next,
  // The lease primitive, exported for its interleaving test (C8).
  acquireLease,
  releaseLease, resolveMainRoot, noPsAlive,
};
