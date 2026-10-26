'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Retirement sweep (row 127 IC-003, design D2): release, delete or strip what a retired harness
 * installed, driven only by the scope's ledger and the retired record in the registry. The retired
 * harness has no adapter any more, so nothing here calls one.
 *
 * Every retired row gets exactly one change, first matching rule wins:
 *  1. a live change in this run removes or supersedes its target      -> drop-row
 *  2. a non-retired ledger row has the same claim key                  -> release (file stays)
 *  3. kind copy-tree-file | hooks-script: absent -> drop-row; bytes equal the row's fingerprint and the
 *     path resolves to itself -> delete; otherwise keep (named)
 *  3a. a `removal.handover` entry -> handover | defer (T-127-A5, see handoverAction)
 *  4. renderer in `markerSectionRenderers` -> strip-section; no markers -> drop-row; malformed -> keep
 *  5. renderer = `hookCommands.renderer` -> strip-hooks (exact frozen commands only); unparseable -> keep;
 *     no matching command -> drop-row
 *  6. anything else -> keep, `unknown row shape <kind>/<renderer>`
 * Every action except `defer` gives the row up (retiredReleaseKeys). Actions that touch no file carry
 * `release: true`, which keeps them out of the backup set like any other release.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isRetired } = require('../registry/index.ts');
const { ownershipKey, atomicJsonWrite } = require('../state/index.ts');
const { removeTree, readJson } = require('../adapters/copy-tree.ts');
const { removeMarkedSection, MARKER_START, MARKER_END } = require('../helper/marker-merge.ts');

type RetiredAction = 'release' | 'handover' | 'defer' | 'delete' | 'strip-section' | 'strip-hooks' | 'drop-row' | 'keep';

interface RetiredChange {
  harness: string; retired: true; assetId: string; target: string; ownershipKey: string; ownershipIdentity: string;
  action: RetiredAction; reason?: string; operation: 'remove'; release?: boolean;
  /** delete: the bytes the row recorded, re-checked right before the unlink. */
  fingerprint?: string;
  /** strip-hooks: the JSON key and the exact commands to take out of it. */
  hookCommands?: { key: string; commands: string[] };
}

interface RetiredHarnessPlan {
  harness: string; replacement: string; scopeRoot: string; changes: RetiredChange[];
  counts: { deleted: number; stripped: number; released: number; kept: number };
  notices: string[];
}

interface Classification { action: RetiredAction; reason?: string; fingerprint?: string }

const WHOLE_FILE_KINDS = new Set(['copy-tree-file', 'hooks-script']);
/** Actions with no filesystem effect: the row is given up and nothing is written or deleted. */
const NO_FS_EFFECT = new Set<RetiredAction>(['release', 'drop-row', 'keep']);
const COUNTED: Partial<Record<RetiredAction, keyof RetiredHarnessPlan['counts']>> = {
  delete: 'deleted', 'strip-section': 'stripped', 'strip-hooks': 'stripped', release: 'released', handover: 'released', keep: 'kept',
};

/** What one claim covers: a whole file, except an MCP entry, which is claimed on its own because
 * several harnesses keep their servers side by side in one MCP file. The one definition: the
 * lifecycle (src/lifecycle/index.ts) imports it from here, since it requires this module. */
function claimKey(record: any): string {
  return record.kind === 'mcp-server' ? `${record.target}\u0000${record.identity}` : record.target;
}

function sha256(bytes: any): string { return crypto.createHash('sha256').update(bytes).digest('hex'); }

/** Whether `target` is inside `scopeRoot` and resolves to that same place: no symlink between the
 * scope root and the file (the file itself included) leads somewhere else. */
function resolvesInPlace(target: string, scopeRoot: string, fsImpl: any): boolean {
  const rel = path.relative(scopeRoot, target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  try { return fsImpl.realpathSync(target) === path.join(fsImpl.realpathSync(scopeRoot), rel); } catch { return false; }
}

/** The `hooks` value with every handler whose command is in `commands` taken out, and any matcher
 * group, event array or the key itself that this left empty. Containers that were already empty,
 * and every handler not in the list, stay as they are. Returns the new document, or null when no
 * handler matched. */
function stripHookCommands(doc: any, key: string, commands: Set<string>): any | null {
  const hooks = doc[key];
  let removed = false;
  const nextHooks: Record<string, any> = {};
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) { nextHooks[event] = groups; continue; }
    let eventChanged = false;
    const nextGroups: any[] = [];
    for (const group of groups) {
      if (!group || !Array.isArray(group.hooks)) { nextGroups.push(group); continue; }
      const handlers = group.hooks.filter((handler: any) => !commands.has(handler?.command));
      if (handlers.length === group.hooks.length) { nextGroups.push(group); continue; }
      eventChanged = true;
      if (handlers.length) nextGroups.push({ ...group, hooks: handlers });
    }
    if (eventChanged) removed = true;
    if (!eventChanged || nextGroups.length) nextHooks[event] = eventChanged ? nextGroups : groups;
  }
  if (!removed) return null;
  const next = { ...doc };
  if (Object.keys(nextHooks).length) next[key] = nextHooks;
  else delete next[key];
  return next;
}

/** The hooks JSON at `target` parsed, or a reason it cannot be stripped. Absent file -> `absent`. */
function readHooksDoc(target: string, key: string, fsImpl: any): { absent?: true; doc?: any; error?: string } {
  const { exists, value, error } = readJson(target, { fsImpl });
  if (!exists) return { absent: true };
  if (error) return { error: 'not valid JSON' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: 'not a JSON object' };
  if (value[key] !== undefined && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) return { error: `'${key}' is not an object` };
  return { doc: value };
}

/** Marker state of a file, by the same rules removeMarkedSection applies. */
function markerState(text: string): 'none' | 'ok' | 'malformed' {
  const start = text.indexOf(MARKER_START);
  if (start === -1) return 'none';
  const end = text.indexOf(MARKER_END, start + MARKER_START.length);
  if (end === -1 || text.indexOf(MARKER_START, end + MARKER_END.length) !== -1) return 'malformed';
  return 'ok';
}

/** Rule 3a (IC-003, design D7): a row the retired record lists under `removal.handover` (renderer +
 * scope) is handed to the replacement when it is planned in this run, or deferred when it is installed
 * in the scope but not planned. That decision is T-127-A5's; until it lands every row falls through
 * to rule 4. */
function handoverAction(_row: any, _retired: any, _context: any): Classification | null {
  return null;
}

function classify(row: any, retired: any, context: any): Classification {
  const { liveRemoved, superseded, liveClaims, scopeRoot, fsImpl } = context;
  const key = claimKey(row);
  const renderer = row.projection?.renderer;
  // 1. A live change in this run already releases this row (a removal, or a prune naming it).
  if (liveRemoved.has(key) || superseded.has(ownershipKey(row))) return { action: 'drop-row' };
  // 2. A live harness still claims the file.
  if (liveClaims.has(key)) return { action: 'release' };
  // 3. Whole files DoFlow wrote: delete only its own unchanged bytes, at the path it recorded.
  if (WHOLE_FILE_KINDS.has(row.kind)) {
    if (!fsImpl.existsSync(row.target)) return { action: 'drop-row' };
    if (!resolvesInPlace(row.target, scopeRoot, fsImpl)) return { action: 'keep', reason: 'resolves outside its recorded path' };
    if (!fsImpl.statSync(row.target).isFile()) return { action: 'keep', reason: 'not a regular file' };
    const current = sha256(fsImpl.readFileSync(row.target));
    if (current !== row.fingerprint) return { action: 'keep', reason: 'changed since DoFlow wrote it' };
    return { action: 'delete', fingerprint: current };
  }
  // 3a. Handover to the replacement (T-127-A5).
  const handover = handoverAction(row, retired, context);
  if (handover) return handover;
  // 4. A marker section in a file the person also writes.
  if (retired.removal.markerSectionRenderers.includes(renderer)) {
    if (!fsImpl.existsSync(row.target)) return { action: 'drop-row' };
    if (!resolvesInPlace(row.target, scopeRoot, fsImpl)) return { action: 'keep', reason: 'resolves outside its recorded path' };
    const state = markerState(fsImpl.readFileSync(row.target, 'utf8'));
    if (state === 'none') return { action: 'drop-row' };
    if (state === 'malformed') return { action: 'keep', reason: 'malformed DoFlow markers' };
    return { action: 'strip-section' };
  }
  // 5. Hook handlers in a shared JSON file: only the exact frozen commands.
  const hookCommands = retired.removal.hookCommands;
  if (renderer === hookCommands.renderer) {
    const read = readHooksDoc(row.target, hookCommands.key, fsImpl);
    if (read.absent) return { action: 'drop-row' };
    if (read.error) return { action: 'keep', reason: read.error };
    if (!resolvesInPlace(row.target, scopeRoot, fsImpl)) return { action: 'keep', reason: 'resolves outside its recorded path' };
    if (read.doc[hookCommands.key] === undefined) return { action: 'drop-row' };
    return stripHookCommands(read.doc, hookCommands.key, new Set(hookCommands.commands)) ? { action: 'strip-hooks' } : { action: 'drop-row' };
  }
  // 6. Nothing this sweep knows how to take back.
  return { action: 'keep', reason: `unknown row shape ${row.kind ?? '(none)'}/${renderer ?? '(none)'}` };
}

/** One plan per retired harness that still has rows in this scope's ledger, in registry order. A ledger
 * with no retired rows yields []. `livePlanChanges` are the live harnesses' planned changes. */
function planRetiredHarnesses({ registry, ledger, scope, scopeRoot, livePlanChanges = [], fsImpl = fs }: any): RetiredHarnessPlan[] {
  const retiredRecords = Array.isArray(registry?.retired) ? registry.retired : [];
  if (!retiredRecords.length) return [];
  const rows = (ledger?.resources ?? []).filter((row: any) => typeof row?.target === 'string' && typeof row?.harness === 'string');
  const liveRemoved = new Set<string>();
  const superseded = new Set<string>();
  for (const change of livePlanChanges) {
    if (change?.operation !== 'remove' || typeof change.target !== 'string') continue;
    liveRemoved.add(claimKey(change));
    for (const key of change.supersedes ?? []) superseded.add(key);
  }
  const liveClaims = new Set<string>(rows.filter((row: any) => !isRetired(registry, row.harness)).map(claimKey));
  const context = { registry, scope, scopeRoot, livePlanChanges, liveRemoved, superseded, liveClaims, fsImpl };

  const plans: RetiredHarnessPlan[] = [];
  for (const retired of retiredRecords) {
    const own = rows.filter((row: any) => row.harness === retired.id);
    if (!own.length) continue;
    const plan: RetiredHarnessPlan = {
      harness: retired.id, replacement: retired.replacement, scopeRoot, changes: [],
      counts: { deleted: 0, stripped: 0, released: 0, kept: 0 }, notices: [],
    };
    for (const row of own) {
      const { action, reason, fingerprint } = classify(row, retired, context);
      const change: RetiredChange = {
        harness: row.harness, retired: true, assetId: row.assetId, target: row.target,
        ownershipKey: ownershipKey(row), ownershipIdentity: row.ownershipIdentity, action, operation: 'remove',
        ...(reason ? { reason } : {}),
        ...(NO_FS_EFFECT.has(action) ? { release: true } : {}),
        ...(fingerprint ? { fingerprint } : {}),
        ...(action === 'strip-hooks' ? { hookCommands: { key: retired.removal.hookCommands.key, commands: [...retired.removal.hookCommands.commands] } } : {}),
      };
      plan.changes.push(Object.freeze(change) as RetiredChange);
      const counted = COUNTED[action];
      if (counted) plan.counts[counted] += 1;
      if (action === 'keep') plan.notices.push(`kept ${path.relative(scopeRoot, row.target)}: ${reason}`);
    }
    plans.push(plan);
  }
  return plans;
}

/** Carry out the plans: JSON hook strips first, then marker sections, then whole-file deletes, so no
 * settings file is ever left naming a script that is already gone. Each step re-checks what the plan
 * proved and throws rather than act on a file that changed since; the caller's recovery restores. */
function applyRetiredHarnesses(plans: RetiredHarnessPlan[], { fsImpl = fs }: any = {}): void {
  const all = plans.flatMap((plan) => plan.changes.map((change) => ({ change, scopeRoot: plan.scopeRoot })));
  const guard = (change: RetiredChange, scopeRoot: string) => {
    if (fsImpl.existsSync(change.target) && !resolvesInPlace(change.target, scopeRoot, fsImpl)) {
      throw new Error(`Refusing to change retired ${change.harness} resource ${change.target}: it resolves outside its recorded path`);
    }
  };
  for (const { change, scopeRoot } of all) {
    if (change.action !== 'strip-hooks' || !change.hookCommands) continue;
    guard(change, scopeRoot);
    const read = readHooksDoc(change.target, change.hookCommands.key, fsImpl);
    if (read.absent) continue;
    if (read.error) throw new Error(`Refusing to strip retired ${change.harness} hooks from ${change.target}: ${read.error}`);
    if (read.doc[change.hookCommands.key] === undefined) continue;
    const next = stripHookCommands(read.doc, change.hookCommands.key, new Set(change.hookCommands.commands));
    if (next) atomicJsonWrite(change.target, next, { fsImpl });
  }
  for (const { change, scopeRoot } of all) {
    if (change.action !== 'strip-section') continue;
    guard(change, scopeRoot);
    removeMarkedSection(change.target);
  }
  const deletes = all.filter(({ change }) => change.action === 'delete');
  for (const { change, scopeRoot } of deletes) guard(change, scopeRoot);
  removeTree({ changes: deletes.map(({ change }) => ({ operation: 'remove', target: change.target, fingerprint: change.fingerprint, relPath: change.target })), fsImpl });
}

/** Every ledger row the plans give up: all of them except deferred ones. */
function retiredReleaseKeys(plans: RetiredHarnessPlan[]): Set<string> {
  return new Set(plans.flatMap((plan) => plan.changes.filter((change) => change.action !== 'defer').map((change) => change.ownershipKey)));
}

/** IC-003 output, for dry-run and apply alike: one summary line per retired harness, then one line per
 * kept or named item. No plans, no lines. */
function formatRetiredPlans(plans: RetiredHarnessPlan[]): string[] {
  return plans.flatMap((plan) => [
    `[RETIRED] ${plan.harness} → ${plan.replacement}: deleted ${plan.counts.deleted}, stripped ${plan.counts.stripped}, released ${plan.counts.released}, kept ${plan.counts.kept}`,
    ...plan.notices.map((notice) => `  ${notice}`),
  ]);
}

module.exports = { planRetiredHarnesses, applyRetiredHarnesses, retiredReleaseKeys, formatRetiredPlans, claimKey };
