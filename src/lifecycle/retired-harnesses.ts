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
 *  3a. a `removal.handover` entry (renderer + scope) at the replacement's own declared path: replacement
 *     planned in this run -> handover (it rewrites the span itself); installed but not planned -> defer
 *     (row and file stay, notice); otherwise on to rule 4. Decided by planHandovers before any live plan.
 *  4. renderer in `markerSectionRenderers` -> strip-section (either start marker, see START_MARKERS); no
 *     markers -> drop-row; malformed -> keep
 *  5. renderer = `hookCommands.renderer` -> strip-hooks (exact frozen commands only); unparseable -> keep;
 *     no matching command -> drop-row
 *  6. anything else -> keep, `unknown row shape <kind>/<renderer>`
 * Every action except `defer` gives the row up (retiredReleaseKeys). Actions that touch no file carry
 * `release: true`, which keeps them out of the backup set like any other release; a handed-over file
 * is backed up through the replacement's own change, which is the one write it gets.
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { isRetired } = require('../registry/index.ts');
const { resolveHarnessPaths } = require('../helper/harness-paths.ts');
const { ownershipKey, atomicJsonWrite } = require('../state/index.ts');
const { removeTree, readJson } = require('../adapters/copy-tree.ts');
const { removeMarkedSection, markedSpan, MARKER_START } = require('../helper/marker-merge.ts');

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
  counts: { deleted: number; stripped: number; released: number; dropped: number; deferred: number; kept: number };
  notices: string[];
}

interface Classification { action: RetiredAction; reason?: string; fingerprint?: string }

const WHOLE_FILE_KINDS = new Set(['copy-tree-file', 'hooks-script']);
/** Actions with no filesystem effect: the row is given up and nothing is written or deleted. */
const NO_FS_EFFECT = new Set<RetiredAction>(['release', 'handover', 'defer', 'drop-row', 'keep']);
/** The count each action adds to; every action has one, so the counts sum to the rows swept. */
const COUNTED: Record<RetiredAction, keyof RetiredHarnessPlan['counts']> = {
  delete: 'deleted', 'strip-section': 'stripped', 'strip-hooks': 'stripped', release: 'released', handover: 'released',
  'drop-row': 'dropped', defer: 'deferred', keep: 'kept',
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

/** The start markers a retired section may open with: marker-merge's, and the short one the retired
 * gemini adapter wrote (src/adapters/gemini/index.ts @ c35f681b), which its real sections carry. Both
 * close with MARKER_END. Only this sweep reads the short one; live harnesses never see it. */
const START_MARKERS = [MARKER_START, '<!-- doflow:start -->'];

/** Marker state of a file, by the rules removeMarkedSection applies with START_MARKERS. */
function markerState(text: string): 'none' | 'ok' | 'malformed' { return markedSpan(text, START_MARKERS).state; }

/** Rule 3a's verdict for one retired row (IC-003, IC-007, design D7). */
interface HandoverDecision { action: 'handover' | 'defer'; to: string; target: string; fromKey: string; edited: boolean }

/**
 * Rule 3a, decided before the live harnesses plan, because the replacement needs the verdict to plan
 * its own change: `context.handovers` for each `to`. A retired row qualifies when a `removal.handover`
 * entry names its renderer and this scope, its file is still there in place, and the file is the one
 * the replacement itself declares for that surface here. Then: `to` planned in this run -> handover,
 * `edited` when the whole file no longer has the bytes the row recorded; `to` installed in the scope
 * (a ledger row of it, or its `targets` entry; a lock pins only harnesses the ledger holds, IC-004)
 * -> defer. Rules 2 and 3 come first, as in classify. Returns the decisions by ownership key.
 */
function planHandovers({ registry, ledger, scope, scopeRoot, planned = [], fsImpl = fs }: any): Map<string, HandoverDecision> {
  const decisions = new Map<string, HandoverDecision>();
  const retiredRecords = Array.isArray(registry?.retired) ? registry.retired : [];
  if (!retiredRecords.length) return decisions;
  const rows = (ledger?.resources ?? []).filter((row: any) => typeof row?.target === 'string' && typeof row?.harness === 'string');
  const liveClaims = new Set<string>(rows.filter((row: any) => !isRetired(registry, row.harness)).map(claimKey));
  const plannedIds = new Set<string>(planned);
  for (const retired of retiredRecords) {
    const entries = (retired.removal?.handover ?? []).filter((entry: any) => entry?.scope === scope);
    if (!entries.length) continue;
    for (const row of rows.filter((item: any) => item.harness === retired.id)) {
      const entry = entries.find((item: any) => item.renderer === row.projection?.renderer);
      if (!entry || liveClaims.has(claimKey(row)) || WHOLE_FILE_KINDS.has(row.kind)) continue;
      const to = registry.harnesses?.find((harness: any) => harness.id === entry.to);
      if (!to?.paths?.[entry.surface]) continue;
      let declared: string | null = null;
      try { declared = resolveHarnessPaths({ [entry.surface]: to.paths[entry.surface] }, { scope, scopeRoot, homeDir: scopeRoot })[entry.surface]; } catch { continue; }
      if (declared !== row.target || !fsImpl.existsSync(row.target) || !resolvesInPlace(row.target, scopeRoot, fsImpl)) continue;
      const base = { to: to.id, target: row.target, fromKey: ownershipKey(row) };
      if (plannedIds.has(to.id)) {
        decisions.set(base.fromKey, { action: 'handover', ...base, edited: sha256(fsImpl.readFileSync(row.target)) !== row.fingerprint });
      } else if (rows.some((item: any) => item.harness === to.id) || ledger?.targets?.[to.id]) {
        decisions.set(base.fromKey, { action: 'defer', ...base, edited: false });
      }
    }
  }
  return decisions;
}

/** What the replacement is told about each handover in this run: `context.handovers` per harness id. */
function handoversFor(decisions: Map<string, HandoverDecision>): Map<string, Array<{ target: string; fromKey: string; edited: boolean }>> {
  const byHarness = new Map<string, Array<{ target: string; fromKey: string; edited: boolean }>>();
  for (const { action, to, target, fromKey, edited } of decisions.values()) {
    if (action !== 'handover') continue;
    if (!byHarness.has(to)) byHarness.set(to, []);
    byHarness.get(to)!.push({ target, fromKey, edited });
  }
  return byHarness;
}

/** Rule 3a in classify: the verdict planHandovers reached for this row before the live plans. */
function handoverAction(row: any, _retired: any, context: any): Classification | null {
  const decided = context.handovers?.get(ownershipKey(row));
  return decided ? { action: decided.action } : null;
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
 * with no retired rows yields []. `livePlanChanges` are the live harnesses' planned changes, and
 * `handovers` planHandovers' decisions for this same run. */
function planRetiredHarnesses({ registry, ledger, scope, scopeRoot, livePlanChanges = [], handovers = new Map(), fsImpl = fs }: any): RetiredHarnessPlan[] {
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
  const context = { registry, scope, scopeRoot, livePlanChanges, liveRemoved, superseded, liveClaims, handovers, fsImpl };

  const plans: RetiredHarnessPlan[] = [];
  for (const retired of retiredRecords) {
    const own = rows.filter((row: any) => row.harness === retired.id);
    if (!own.length) continue;
    const plan: RetiredHarnessPlan = {
      harness: retired.id, replacement: retired.replacement, scopeRoot, changes: [],
      counts: { deleted: 0, stripped: 0, released: 0, dropped: 0, deferred: 0, kept: 0 }, notices: [],
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
      plan.counts[COUNTED[action]] += 1;
      if (action === 'keep') plan.notices.push(`kept ${path.relative(scopeRoot, row.target)}: ${reason}`);
      if (action === 'defer') plan.notices.push(`${path.relative(scopeRoot, row.target)}: handed over on the next run that targets ${handovers.get(change.ownershipKey).to}`);
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
    removeMarkedSection(change.target, { startMarkers: START_MARKERS });
  }
  const deletes = all.filter(({ change }) => change.action === 'delete');
  for (const { change, scopeRoot } of deletes) guard(change, scopeRoot);
  removeTree({ changes: deletes.map(({ change }) => ({ operation: 'remove', target: change.target, fingerprint: change.fingerprint, relPath: change.target })), fsImpl });
}

/** Every ledger row the plans give up: all of them except deferred ones. */
function retiredReleaseKeys(plans: RetiredHarnessPlan[]): Set<string> {
  return new Set(plans.flatMap((plan) => plan.changes.filter((change) => change.action !== 'defer').map((change) => change.ownershipKey)));
}

/** IC-003 output, for dry-run and apply alike: one summary line per retired harness, whose six counts
 * sum to the rows it swept, then one line per kept or named item. No plans, no lines. */
function formatRetiredPlans(plans: RetiredHarnessPlan[]): string[] {
  return plans.flatMap((plan) => [
    `[RETIRED] ${plan.harness} → ${plan.replacement}: deleted ${plan.counts.deleted}, stripped ${plan.counts.stripped}, released ${plan.counts.released}, dropped ${plan.counts.dropped}, deferred ${plan.counts.deferred}, kept ${plan.counts.kept}`,
    ...plan.notices.map((notice) => `  ${notice}`),
  ]);
}

module.exports = { planRetiredHarnesses, planHandovers, handoversFor, applyRetiredHarnesses, retiredReleaseKeys, formatRetiredPlans, claimKey };
