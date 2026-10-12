'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Native state and formats remain adapter-owned. The lifecycle layer selects
// registry assets, validates declarative changes, journals mutations, and keeps
// the neutral ledger in sync only after successful verification.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { harnessFor, selectAssets, selectMcpServers, mcpCapable } = require('../registry/index.ts');
const { defaultLedger, ownershipKey, writeLedger, writeRecoveryRecord, upgradeLedger, LEDGER_VERSION } = require('../state/index.ts');
const { resolveAdapter, projectAdapterInput } = require('../adapters/index.ts');
const { pruneEmptyAncestors, discoverTree, sameFileIndex, sharedTreeDestDir, walkRelFiles } = require('../adapters/copy-tree.ts');
const { renderPolicies } = require('./policies.ts');
const { renderMcpIndex } = require('./mcp-index.ts');
const { hasBashCapableShell } = require('./bash-availability.ts');
const { hookTrustFor: geminiHookTrustFor } = require('../adapters/gemini/index.ts');

const OPERATIONS = new Set(['create', 'merge', 'update', 'remove']);
/** A harness's MCP selection meaning "the servers it owns now", read through its adapter's
 * `discover().mcpOwned`. */
const MCP_KEEP = 'keep';

function registryScope(scope: any) { return scope === 'global' ? 'user' : scope; }
function assertScope(scope: any) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Lifecycle scope must be project or global, got '${scope}'`);
}

function normalizeTargets(registry: any, targets: any) {
  const wanted = targets && targets.length ? targets : registry.harnesses.map((harness: any) => harness.id);
  if (!Array.isArray(wanted)) throw new Error('Lifecycle targets must be an array');
  return [...new Set(wanted)].map((id) => harnessFor(registry, id));
}

function identityFor(change: any) { return change.ownershipIdentity ?? change.ownership; }

function normalizeChange(change: any, { harness, assets }: any) {
  if (!change || typeof change !== 'object') throw new Error(`Adapter '${harness.id}' returned a non-object change`);
  const ownershipIdentity = identityFor(change);
  if (change.harness !== undefined && change.harness !== harness.id) throw new Error(`Adapter '${harness.id}' returned a change for '${change.harness}'`);
  if (!assets.some((asset: any) => asset.id === change.assetId)) throw new Error(`Adapter '${harness.id}' returned unknown asset '${change.assetId}'`);
  if (!OPERATIONS.has(change.operation)) throw new Error(`Adapter '${harness.id}' returned unsupported operation '${change.operation}'`);
  if (typeof change.target !== 'string' || !change.target) throw new Error(`Adapter '${harness.id}' change '${change.assetId}' requires target`);
  if (typeof ownershipIdentity !== 'string' || !ownershipIdentity) throw new Error(`Adapter '${harness.id}' change '${change.assetId}' requires ownershipIdentity`);
  return Object.freeze({ ...change, harness: harness.id, ownershipIdentity });
}

function normalizeVerification(result: any, harness: any) {
  if (!result || typeof result !== 'object') throw new Error(`Adapter '${harness.id}' returned an invalid verification result`);
  const statuses = Array.isArray(result.statuses) ? result.statuses : [];
  const resources = Array.isArray(result.resources) ? result.resources : [];
  return { ...result, harness: harness.id, statuses, resources };
}

function matchesChange(resource: any, change: any) {
  if (resource?.assetId !== change.assetId || resource?.target !== change.target) return false;
  const resourceOwnership = resource?.ownershipIdentity ?? resource?.ownership;
  const changeOwnership = change.ownershipIdentity ?? change.ownership;
  // Multiple independently-managed records may share one native container
  // (for example Codex config entries and MCP tables in config.toml). Match an
  // exact ownership identity when available, otherwise the adapter's native
  // resource identity; never treat a shared target as the resource itself.
  if (resourceOwnership && changeOwnership && resourceOwnership === changeOwnership) return true;
  return typeof resource?.identity === 'string' && typeof change?.identity === 'string' && resource.identity === change.identity;
}

/** Whether one removed change is genuinely gone, and if so, how `statuses` should record that.
 * `statuses` is read live, not a snapshot — an earlier change in the same removal batch can add
 * or update an entry a later change's own lookup then finds. */
function reconcileRemovedChange(verification: any, statuses: any, change: any) {
  const reported = verification.resources.some((resource: any) => matchesChange(resource, change));
  const statusIndex = statuses.findIndex((item: any) => matchesChange(item, change));
  const status = statusIndex >= 0 ? statuses[statusIndex] : null;
  // 'absent' belongs here alongside 'missing': a shared file (settings.json) survives removal
  // holding the user's own content, and its adapter reports 'absent' once none of DoFlow's
  // entries remain. That is a successful strip, not a resource that refused to go away.
  if (reported || (status && !['missing', 'absent', 'removed', 'not-managed'].includes(status.status))) {
    return { conflict: `Removed resource remains present: ${change.target}` };
  }
  const removedStatus = {
    ...(status ?? { harness: change.harness, assetId: change.assetId, target: change.target, ownershipIdentity: change.ownershipIdentity }),
    status: 'removed', expectedRemoval: true,
  };
  return { statusIndex, removedStatus };
}

/** A missing resource is success only when it is exactly one that this plan
 * removed. All unrelated status rows remain untouched, and a removed resource
 * still reported as present is a verification conflict. */
/** An adapter's verifier enumerates what the *current source* declares and marks anything not on
 * disk 'missing'. That is the right question for install/update and the inverted one for removal,
 * and it misfires outright when the machine's state predates a rename: v1.0.0-beta.2 consolidated
 * 14 agent specs into 5, so `doflow remove` on an older install planned removals for the 14 names
 * the ledger owned while the codex verifier looked for the 5 the source now declares — and failed
 * on the 4 that had never been installed here. `remove` became impossible for every install
 * predating the consolidation, with no user recourse.
 *
 * You cannot fail to remove what you never installed, and the ledger is the record of what this
 * machine actually owns. So a 'missing' the ledger has no claim on is an expected absence. A
 * 'missing' the ledger *does* claim stays a hard failure — that is a removal which genuinely did
 * not happen, and the existing "unrelated missing remains false" contract depends on it. Without a
 * ledger, non-ownership cannot be proven, so the strict reading is kept. */
function markUnownedAbsences(statuses: any, ledger: any, harness: any) {
  if (!ledger) return statuses;
  const owned = new Set((ledger.resources || [])
    .filter((resource: any) => resource.harness === harness)
    .map((resource: any) => resource.ownershipIdentity)
    .filter(Boolean));
  return statuses.map((status: any) => (
    status?.status === 'missing' && status.ownershipIdentity && !owned.has(status.ownershipIdentity)
      ? { ...status, status: 'absent', expectedAbsence: true }
      : status
  ));
}

function normalizeRemovalVerification(verification: any, changes: any, ledger: any) {
  const removals = changes.filter((change: any) => change.operation === 'remove' && change.harness === verification.harness);
  if (!removals.length) return verification;
  // A retained removal released this harness's ownership row without deleting the file, because
  // another harness still claims it (see markRetainedRemovals). The file is therefore *expected*
  // to still be on disk, so asking "is it gone?" of it would turn the correct outcome into a
  // verification conflict. Everything the plan actually deleted is still checked as strictly as
  // before.
  const removed = removals.filter((change: any) => !change.retained);
  let statuses = [...verification.statuses];
  const conflicts = [...(verification.conflicts || [])];
  for (const change of removed) {
    const outcome = reconcileRemovedChange(verification, statuses, change);
    if (outcome.conflict) { conflicts.push(outcome.conflict); continue; }
    if (outcome.statusIndex >= 0) statuses[outcome.statusIndex] = outcome.removedStatus;
    else statuses.push(outcome.removedStatus);
  }
  // After reconciling the plan's own removals, so this only ever judges what the plan left over.
  statuses = markUnownedAbsences(statuses, ledger, verification.harness);
  return { ...verification, statuses, conflicts, ok: removalVerificationOk(verification.ok, statuses, conflicts) };
}

/** An adapter may initially report ok:false because a now-removed resource is missing. Once
 * that exact absence has been normalized (an `expectedRemoval` status), recompute rather than
 * carrying the stale false forward. A bare adapter failure, conflict, or any unrelated
 * missing/error status remains a hard verification failure. */
function removalVerificationOk(ok: any, statuses: any, conflicts: any) {
  const unresolvedFailure = statuses.some((status: any) => ['missing', 'conflict', 'error', 'invalid'].includes(status?.status));
  const onlyExpectedRemovalFailure = ok === false && statuses.some((status: any) => status?.expectedRemoval || status?.expectedAbsence) && !unresolvedFailure && conflicts.length === 0;
  return conflicts.length === 0 && !unresolvedFailure && (ok !== false || onlyExpectedRemovalFailure);
}

/** A `failures` entry comes in three shapes from different adapters: a [name, detail] tuple,
 * a bare string, or an object with its own conflicts/errors. */
function failureReasons(failure: any) {
  if (Array.isArray(failure)) {
    const [name, detail] = failure;
    const detailReasons = detail?.conflicts || detail?.errors || [];
    return detailReasons.map((reason: any) => `${name}: ${reason}`);
  }
  if (typeof failure === 'string') return [failure];
  if (failure?.conflicts || failure?.errors) return failure.conflicts || failure.errors;
  return [];
}

function componentReasons(name: any, component: any) {
  if (component?.ok !== false) return [];
  const details = component.conflicts || component.errors || [];
  return details.length ? details.map((reason: any) => `${name}: ${reason}`) : [`${name}: native plan failed`];
}

/** Promote adapter-declared failed components into the common conflict channel.
 * A false `ok` is never advisory: otherwise a native adapter can decline a
 * dangerous reconciliation while the lifecycle still journals and writes state. */
function adapterConflicts(result: any, harness: any) {
  const reasons = [
    ...(result.conflicts || []),
    ...(result.errors || []),
    ...(result.failures || []).flatMap(failureReasons),
    ...Object.entries(result.components || {}).flatMap(([name, component]) => componentReasons(name, component)),
  ];
  if (result.ok === false && reasons.length === 0) reasons.push(`Adapter '${harness.id}' rejected its native plan`);
  return [...new Set(reasons)];
}

/** Every ownership row this plan is about to give up, keyed exactly as the neutral ledger keys it.
 * A removal change always releases its harness's claim; whether it also deletes the file is a
 * separate question, answered by markRetainedRemovals below. */
function releasedOwnershipKeys(harnessPlans: any, scope: any) {
  const keys = new Set();
  for (const target of harnessPlans) {
    for (const change of target.changes || []) {
      if (change.operation !== 'remove') continue;
      keys.add(ownershipKey({ harness: change.harness, scope, assetId: change.assetId, target: change.target, ownershipIdentity: change.ownershipIdentity }));
      for (const key of change.supersedes ?? []) keys.add(key);
    }
  }
  return keys;
}

/** Which harnesses still hold a ledger row for each destination once this plan's releases are
 * applied. Membership is decided per ROW, not per harness: a harness that is releasing its claim
 * on this file is not a claimant even if it is releasing nothing else, and a harness in the same
 * batch that keeps its row (an install that relocates one asset while a sibling's projection is
 * unchanged) still is. */
function survivingClaimantsByTarget(ledger: any, releasedKeys: any) {
  const byTarget = new Map();
  for (const resource of ledger?.resources || []) {
    if (typeof resource?.target !== 'string' || typeof resource?.harness !== 'string') continue;
    if (releasedKeys.has(ownershipKey(resource))) continue;
    const key = claimKey(resource);
    if (!byTarget.has(key)) byTarget.set(key, new Set());
    byTarget.get(key).add(resource.harness);
  }
  return byTarget;
}

/** What one claim covers: a whole file, except an MCP entry, which is claimed on its own because
 * several harnesses keep their servers side by side in one MCP file. */
function claimKey(record: any) {
  return record.kind === 'mcp-server' ? `${record.target}\u0000${record.identity}` : record.target;
}

/** NFR-007: a removal reclaims only what no other harness still claims.
 *
 * Several assets project to ONE destination for several harnesses — `scripts.doflow` is a single
 * `<project>/.doflow/scripts` tree for claude, codex and gemini, and gemini and copilot both
 * resolve to `<root>/.agents` at project scope — while ownership is recorded per harness. A
 * removal that deleted every file its own rows named therefore took the shared runtime out from
 * under the harnesses that are still installed, leaving them with rows pointing at files that no
 * longer exist and, when a global install happens to be present, a locator that silently answers
 * from a different install's registries and state.
 *
 * So a removal change whose destination another surviving row still claims is *released* rather
 * than executed: this harness's ownership row is dropped (it really is uninstalled), the file
 * stays, and the last claimant's removal is the one that reclaims it. The neutral ledger is the
 * only thing consulted — it is already the record of who owns what, and a second ownership
 * registry would be one more thing to keep in sync. */
function markRetainedRemovals(harnessPlans: any, ledger: any, scope: any) {
  const claimants = survivingClaimantsByTarget(ledger, releasedOwnershipKeys(harnessPlans, scope));
  if (!claimants.size) return harnessPlans;
  return harnessPlans.map((target: any) => {
    if (target.skipped) return target;
    let retainedAny = false;
    const changes = target.changes.map((change: any) => {
      if (change.operation !== 'remove') return change;
      const retainedFor = [...(claimants.get(claimKey(change)) ?? [])].filter((harness) => harness !== change.harness).sort();
      if (!retainedFor.length) return change;
      retainedAny = true;
      return Object.freeze({ ...change, retained: true, retainedFor });
    });
    if (!retainedAny) return target;
    // requiredNativeResources defaults to the very array just replaced; keep the two in step so a
    // caller reading either one sees the same annotated changes.
    const requiredNativeResources = target.requiredNativeResources === target.changes ? changes : target.requiredNativeResources;
    return { ...target, changes, requiredNativeResources };
  });
}

/** Whether this plan leaves no ownership row standing anywhere — the only case in which a shared,
 * install-wide artifact that no single harness owns is genuinely unclaimed. */
function removalIsTotal(plan: any) {
  const released = releasedOwnershipKeys(plan.targets || [], plan.scope);
  return (plan.ledger?.resources || []).every((resource: any) => released.has(ownershipKey(resource)));
}

/** What a removal kept and why, ready to print. A command that says "removed" while silently
 * leaving files behind is answering confidently about something it did not do, so the retained
 * count and the harnesses responsible for it are reported, never inferred by the caller. */
function retentionSummary(retained: any = []) {
  const groups = new Map();
  for (const item of retained) {
    // No claimant: a release that is reported on its own line (a kept hand edit) or is silent
    // bookkeeping (a row whose file is gone), never "still claimed by" nobody.
    if (!item.retainedFor?.length) continue;
    const key = `${item.harness} | ${item.retainedFor.join(', ')}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].map(([key, count]) => {
    const [harness, claimants] = key.split(' | ');
    return `${harness}: retained ${count} shared resource(s) still claimed by ${claimants}`;
  });
}

function retainedChanges(changes: any) {
  return changes.filter((change: any) => change.retained)
    .map((change: any) => ({ harness: change.harness, assetId: change.assetId, target: change.target, retainedFor: change.retainedFor }));
}

/** An adapter's non-blocking notes: one line of at most 200 characters each. A malformed entry is
 * dropped rather than failing the plan, because a notice must never change whether an install runs. */
function adapterNotices(result: any) {
  return (Array.isArray(result.notices) ? result.notices : [])
    .filter((notice: any) => typeof notice === 'string' && notice.length <= 200 && !/[\u0000-\u001f\u007f]/.test(notice));
}

/** The ids of `ids` the catalog declares, in registry order. */
function catalogIds(registry: any, ids: any) {
  return registry.mcp.filter((server: any) => ids.includes(server.id)).map((server: any) => server.id);
}

/** Each harness takes its own MCP selection: an id array, or MCP_KEEP for the servers it owns now.
 * A harness that takes no MCP servers reads `keep` and an absent entry as none and refuses any id. */
function harnessMcpSelection(registry: any, harness: any, raw: any) {
  const value = raw ?? [];
  if (value !== MCP_KEEP && !(Array.isArray(value) && value.every((id) => typeof id === 'string'))) {
    throw new Error(`MCP selection for '${harness.id}' must be an array of server ids or '${MCP_KEEP}'`);
  }
  if (mcpCapable(registry, harness.id)) return value;
  if (Array.isArray(value) && value.length) throw new Error(`Harness '${harness.id}' takes no MCP servers`);
  return [];
}

/** The runtime trees: each one source directory projected to one `<scopeRoot>/.doflow/runtime/...`
 * tree for every harness, with no layout and no transform (test/guards/runtime-tree.test.js pins
 * that). Nothing but the shared scripts reaches into them, so a file the current source no longer
 * ships is dead for every harness at once. Guidance and scripts are not here: a harness this run
 * does not update names files in those trees from its own native files, so NFR-007 retention is
 * right for them. */
const RUNTIME_TREE_ASSETS = ['runtime.cli', 'runtime.lib', 'runtime.registry'];

function sha256File(file: string, fsImpl: any): string {
  return crypto.createHash('sha256').update(fsImpl.readFileSync(file)).digest('hex');
}

function isUnder(file: string, root: string): boolean {
  return file.startsWith(`${root}${path.sep}`);
}

/** Replace some of a harness plan's changes and append others, keeping `requiredNativeResources`
 * in step: the same array when it is one (as markRetainedRemovals does), else with the added
 * changes listed, so a plan holding only those is still applicable (codex lists its own). */
function withChanges(target: any, replaced: Map<any, any>, added: any[], notices: string[]) {
  if (!replaced.size && !added.length && !notices.length) return target;
  const changes = [...target.changes.map((change: any) => replaced.get(change) ?? change), ...added];
  const requiredNativeResources = target.requiredNativeResources === target.changes ? changes
    : [...target.requiredNativeResources, ...added.map((change: any) => ({ harness: change.harness, component: 'runtimePrune', target: change.target, operation: change.operation, identity: change.identity }))];
  return { ...target, changes, requiredNativeResources, notices: [...target.notices, ...notices] };
}

/**
 * Cross-version orphan prune (073 T4), run on install and update, never on remove.
 *
 * A file under a runtime tree that the current source no longer produces is deleted when its bytes
 * equal a fingerprint some DoFlow ledger row recorded at that exact path. That is DoFlow's own
 * write, unmodified. Without this pass, such a file outlives any update that leaves out one of the
 * harnesses holding a row on it, because markRetainedRemovals keeps a removal another harness still
 * claims, and a bare `update` targets claude alone. The pass:
 * - un-retains the planned removals of that file, or, when no planned harness has a row on it,
 *   adds one for the first planned harness (`kind: 'copy-tree-file'` and `projection.renderer:
 *   'copy-tree'`, the two fields every adapter's removal filter reads);
 * - names the other harnesses' rows in `supersedes`, which updateLedger and releasedOwnershipKeys
 *   drop together with the removal;
 * - releases rows whose file is already gone, since the source no longer produces it either;
 * - keeps, and names, a changed file, an unrecorded one, one whose real path leaves the tree, and
 *   one that is the same file as a path the source produces (a case-only rename).
 * removeTree re-hashes every file just before deleting it, as for any removal.
 */
function pruneRetiredRuntimeFiles(harnessPlans: any[], ledger: any, { scopeRoot, repoRoot, fsImpl = fs }: any) {
  const planned = harnessPlans.filter((target: any) => !target.skipped);
  if (!planned.length || !repoRoot) return harnessPlans;
  const replaced = new Map<string, Map<any, any>>(planned.map((target: any) => [target.harness, new Map()]));
  const added = new Map<string, any[]>(planned.map((target: any) => [target.harness, []]));
  const notices = new Map<string, string[]>(planned.map((target: any) => [target.harness, []]));
  const rows = (ledger?.resources ?? []).filter((row: any) => typeof row?.target === 'string');
  const recorded = new Set(rows.map((row: any) => row.target));
  const shown = (file: string) => path.relative(scopeRoot, file);

  for (const assetId of RUNTIME_TREE_ASSETS) {
    const executor = planned.find((target: any) => target.assets.some((asset: any) => asset.id === assetId));
    if (!executor) continue;
    const asset = executor.assets.find((item: any) => item.id === assetId);
    const nativeDir = typeof asset.nativeDir === 'string' ? asset.nativeDir : asset.nativeDir?.[executor.harness];
    const destDir = sharedTreeDestDir(scopeRoot, nativeDir);
    const sourceDir = path.resolve(repoRoot, asset.source);
    if (!destDir || !fsImpl.existsSync(sourceDir) || !fsImpl.existsSync(destDir)) continue;
    const produced = discoverTree({ sourceDir, destDir, fsImpl }).files.map((file: any) => file.destAbs);
    const producedSet = new Set(produced);
    const sameFile = sameFileIndex(produced, fsImpl);
    const realRoot = fsImpl.realpathSync(destDir);

    const rowsAt = new Map<string, any[]>();
    for (const row of rows) {
      if (!isUnder(row.target, destDir) || producedSet.has(row.target)) continue;
      if (!rowsAt.has(row.target)) rowsAt.set(row.target, []);
      rowsAt.get(row.target)!.push(row);
    }
    const removalsAt = new Map<string, any[]>();
    for (const target of planned) {
      for (const change of target.changes) {
        if (change.operation !== 'remove' || change.assetId !== assetId || !isUnder(change.target, destDir) || producedSet.has(change.target)) continue;
        if (!removalsAt.has(change.target)) removalsAt.set(change.target, []);
        removalsAt.get(change.target)!.push(change);
      }
    }
    /** Turn every planned removal of `file` into a release that deletes nothing. */
    const keepFile = (file: string) => {
      for (const change of removalsAt.get(file) ?? []) {
        if (!change.retained) replaced.get(change.harness)!.set(change, Object.freeze({ ...change, retained: true, retainedFor: [] }));
      }
    };

    for (const file of new Set([...rowsAt.keys(), ...removalsAt.keys()])) {
      const fileRows = rowsAt.get(file) ?? [];
      // Another asset's live row on this path is a claim this pass does not judge.
      if (fileRows.some((row: any) => row.assetId !== assetId)) continue;
      const removals = removalsAt.get(file) ?? [];
      const identity = path.relative(destDir, file);
      // The rows no planned removal of this file releases on its own.
      const superseded = fileRows.filter((row: any) => !removals.some((change: any) => change.harness === row.harness)).map((row: any) => ownershipKey(row));
      const synthetic = (extra: any) => Object.freeze({
        harness: executor.harness, assetId, target: file, operation: 'remove', kind: 'copy-tree-file', identity,
        ownershipIdentity: `doflow:${executor.harness}:copy-tree:${assetId}:${identity}`, projection: { renderer: 'copy-tree' }, ...extra,
      });

      if (!fsImpl.existsSync(file)) {
        // Already gone (an interrupted run, a user's delete): the rows only point at nothing.
        if (fileRows.length) added.get(executor.harness)!.push(synthetic({ fingerprint: null, retained: true, retainedFor: [], supersedes: superseded }));
        continue;
      }
      const real = fsImpl.realpathSync(file);
      if (!isUnder(real, realRoot)) {
        keepFile(file);
        notices.get(executor.harness)!.push(`kept ${shown(file)}: no longer shipped, but it resolves outside ${shown(destDir)}`);
        continue;
      }
      if (sameFile(file)) { keepFile(file); continue; }   // the produced file under an old spelling
      const current = sha256File(file, fsImpl);
      if (!fileRows.some((row: any) => row.fingerprint === current)) {
        // A planned removal here was already kept by planTree, and its adapter named it.
        if (!removals.length) notices.get(executor.harness)!.push(`kept ${shown(file)}: no longer shipped, changed since DoFlow wrote it`);
        continue;
      }
      notices.get(executor.harness)!.push(`prune ${shown(file)}: no longer shipped, unchanged since DoFlow wrote it`);
      if (!removals.length) {
        added.get(executor.harness)!.push(synthetic({ fingerprint: current, supersedes: superseded }));
        continue;
      }
      removals.forEach((change: any, index: number) => {
        const { retained, retainedFor, ...rest } = change;
        void retained; void retainedFor;
        replaced.get(change.harness)!.set(change, Object.freeze({ ...rest, fingerprint: current, ...(index === 0 ? { supersedes: superseded } : {}) }));
      });
    }

    // Files no row names and the source does not produce: never DoFlow's to delete, but named.
    for (const rel of walkRelFiles(destDir, fsImpl)) {
      const file = path.join(destDir, rel);
      if (producedSet.has(file) || recorded.has(file) || sameFile(file)) continue;
      notices.get(executor.harness)!.push(`kept ${shown(file)}: not shipped by this version and not recorded as DoFlow's`);
    }
  }
  return harnessPlans.map((target: any) => (target.skipped ? target
    : withChanges(target, replaced.get(target.harness)!, added.get(target.harness)!, notices.get(target.harness)!)));
}

function planLifecycle({ registry, adapters, scope, scopeRoot, targets, mcpSelections = {}, mcpAdoptable = {}, retainedMcpIds = [], ledger, context = {} }: any) {
  assertScope(scope);
  if (!registry) throw new Error('registry is required');
  const baseLedger = ledger ?? defaultLedger({ scope, scopeRoot });
  const harnessPlans = normalizeTargets(registry, targets).map((harness) => {
    if (!harness.scopes.includes(registryScope(scope))) {
      return { harness: harness.id, assets: [], changes: [], conflicts: [`Harness '${harness.id}' does not support ${scope} scope`], prerequisites: [], notices: [], skipped: true, mcpSelected: null };
    }
    const capable = mcpCapable(registry, harness.id);
    const selection = harnessMcpSelection(registry, harness, mcpSelections[harness.id]);
    const assets = selectAssets(registry, { harness: harness.id });
    const policies = renderPolicies(registry, { harness: harness.id });
    const adoptable = capable ? selectMcpServers(registry, catalogIds(registry, mcpAdoptable[harness.id] ?? [])) : [];
    const adapter = resolveAdapter(adapters, harness);
    const project = (mcp: any) => projectAdapterInput({ registry, harness, scope, scopeRoot, assets, mcp, mcpAdoptable: adoptable, policies, context });
    // `keep` asks the adapter what it owns before the real projection: the probe carries no
    // selection, so discovery reads the files as they are.
    const ids = selection === MCP_KEEP
      ? catalogIds(registry, adapter.discover({ ...project([]), registry, ledger: baseLedger }).mcpOwned ?? [])
      : selection;
    const mcp = selectMcpServers(registry, ids);
    const adapterInput = project(mcp);
    const input = { ...adapterInput, registry, ledger: baseLedger };
    const discovery = adapter.discover(input);
    const result = adapter.plan({ ...input, discovery });
    if (!result || typeof result !== 'object') throw new Error(`Adapter '${harness.id}' returned an invalid plan`);
    const changes = (result.changes || []).map((change: any) => normalizeChange(change, { harness, assets }));
    const conflicts = adapterConflicts(result, harness);
    const prerequisites = [...(result.prerequisites || []), ...changes.map((change: any) => change.prerequisite).filter(Boolean)];
    const requiredNativeResources = result.requiredNativeResources ?? changes;
    if (!Array.isArray(requiredNativeResources)) throw new Error(`Adapter '${harness.id}' returned invalid requiredNativeResources`);
    return { harness: harness.id, adapter: harness.adapter, assets, mcp, mcpSelected: capable ? mcp.map((server: any) => server.id) : null, policies, adapterInput, discovery, changes, requiredNativeResources, conflicts, prerequisites, notices: adapterNotices(result), skipped: false };
  });
  // The MCP index names every server a harness of this scope uses: the selections planned here and
  // the recorded selections of the harnesses this run does not touch.
  const selectedMcp = selectMcpServers(registry, catalogIds(registry,
    [...retainedMcpIds, ...harnessPlans.flatMap((item) => (item.skipped ? [] : item.mcpSelected ?? []))]));
  // Only once every harness's plan is known: whether a file may be deleted depends on the rows
  // the WHOLE plan leaves standing, which no single harness's plan can see.
  const retained = markRetainedRemovals(harnessPlans, baseLedger, scope);
  const annotated = context.operation === 'remove' ? retained
    : pruneRetiredRuntimeFiles(retained, baseLedger, { scopeRoot, repoRoot: context.repoRoot });
  const changes = annotated.flatMap((item: any) => item.changes);
  const conflicts = annotated.flatMap((item: any) => item.conflicts.map((reason: any) => ({ harness: item.harness, reason })));
  const prerequisites = annotated.flatMap((item: any) => item.prerequisites.map((prerequisite: any) => ({ harness: item.harness, prerequisite })));
  const requiredNativeResources = annotated.flatMap((item: any) => item.requiredNativeResources || []);
  const notices = annotated.flatMap((item: any) => item.notices.map((notice: any) => ({ harness: item.harness, notice })));
  return Object.freeze({ scope, scopeRoot, mcp: selectedMcp, ledger: baseLedger, targets: annotated, changes, requiredNativeResources, conflicts, prerequisites, notices,
    retained: retainedChanges(changes), safe: conflicts.length === 0 && prerequisites.length === 0 });
}

function verificationResources(verification: any, changes: any, scope: any, recoveryRef: any) {
  if (verification.resources.length) return verification.resources.map((resource: any) => ({ ...resource, harness: verification.harness, scope, recoveryRef: resource.recoveryRef ?? recoveryRef }));
  return changes.filter((change: any) => change.operation !== 'remove').map((change: any) => ({
    harness: change.harness, scope, assetId: change.assetId, target: change.target,
    ownershipIdentity: change.ownershipIdentity, fingerprint: change.afterFingerprint ?? null,
    sourceVersion: change.sourceVersion ?? 'unknown', projection: change.projection ?? null, recoveryRef,
  }));
}

/** The guidance-content layer's own version marker (core/shared/guidance/VERSION, copy-treed
 * to <scopeRoot>/.doflow/guidance/VERSION) is independent of this package's version — read it
 * fresh on every ledger update so the ledger reflects whatever is actually on disk. */
function readGuidanceVersion(scopeRoot: any, fsImpl = fs) {
  const file = path.join(scopeRoot, '.doflow', 'guidance', 'VERSION');
  if (!fsImpl.existsSync(file)) return null;
  return fsImpl.readFileSync(file, 'utf8').trim();
}

/** Path to the per-install MCP short-flag index. Generated fresh by applyLifecycle on every
 * apply, rather than copy-treed from core/shared/guidance/ — the one guidance-tree file whose
 * content varies by install, so it stays isolated from copy-tree's byte-mirror/fingerprint
 * contract for the rest of that tree.
 *
 * It sits at the guidance ROOT, next to DOFLOW_CORE.md. That is load-bearing: the `doc` paths it
 * emits come from core/registry/mcp.json as `mcp/MCP_*.md`, anchored at the guidance root — the
 * same anchor DOFLOW_CORE.md's own @-imports use. Writing this file into a subdirectory would
 * silently reinterpret every one of those paths against that subdirectory and break them all,
 * with no error at install time. test/mcp-index.test.js pins the anchor from both ends. */
function mcpIndexPath(scopeRoot: any) {
  return path.join(scopeRoot, '.doflow', 'guidance', 'MCP_INDEX.md');
}

/** apply + non-empty selection -> write; apply + empty selection -> delete if present (an agent
 * must never see a stale entry for a server that's no longer selected); remove -> delete, unless
 * `retain` says another harness is still installed.
 *
 * `retain` exists because "remove means the whole install is going away" is only true of a removal
 * that names every harness. This file sits in the shared guidance tree and is @-imported by
 * DOFLOW_CORE.md, so deleting it on a single-harness removal strips a line of always-loaded
 * context out from under every harness that is staying — the same NFR-007 mistake as deleting the
 * shared runtime, in the one asset that is generated rather than ledger-tracked and so cannot be
 * protected by ownership counting. The remaining harnesses' MCP selection has not changed, so the
 * file is left exactly as it is rather than re-rendered from this removal's empty selection. */
function applyMcpIndex({ scopeRoot, selectedMcp, mode, retain = false, fsImpl = fs }: any) {
  const file = mcpIndexPath(scopeRoot);
  const content = mode === 'remove' ? null : renderMcpIndex(selectedMcp);
  if (content === null) {
    if (mode === 'remove' && retain) return;
    if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file);
    return;
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, content);
}

function updateLedger({ ledger, scope, scopeRoot, verifications, changes, recoveryRef, fsImpl = fs }: any) {
  // upgradeLedger makes every written ledger v2-shaped (tombstone log present) while v1 inputs
  // stay readable — migration happens on write, never as a separate user-facing step.
  const next = JSON.parse(JSON.stringify(upgradeLedger(ledger ?? defaultLedger({ scope, scopeRoot }))));
  if (!Array.isArray(next.tombstones)) next.tombstones = [];
  // Snapshot pre-run claims by ownership identity (harness+asset+identity) so a re-verification
  // that relocates the same claim to a new target is detectable as a MOVE, not remove-plus-add.
  const priorByIdentity = new Map();
  for (const resource of next.resources) {
    priorByIdentity.set(`${resource.harness}\u0000${resource.assetId}\u0000${resource.identity ?? ''}`, resource);
  }
  for (const verification of verifications) {
    const related = changes.filter((change: any) => change.harness === verification.harness);
    const removed = related.filter((change: any) => change.operation === 'remove');
    const removeKeys = new Set(removed.map((change: any) => ownershipKey({ harness: change.harness, scope, assetId: change.assetId, target: change.target, ownershipIdentity: change.ownershipIdentity })));
    // A runtime prune also gives up the rows other harnesses hold on the file it deletes
    // (pruneRetiredRuntimeFiles): released here, in the same write, so no row outlives its file.
    for (const change of removed) for (const key of change.supersedes ?? []) removeKeys.add(key);
    next.resources = next.resources.filter((resource: any) => !removeKeys.has(ownershipKey(resource)));
    for (const resource of verificationResources(verification, related, scope, recoveryRef)) {
      const key = ownershipKey(resource);
      // A verifier enumerates what is on disk, and a released-but-retained file is deliberately
      // still there (markRetainedRemovals). Re-adding it would resurrect the exact claim this run
      // gave up, so a key this run removed is never written back by the same run.
      if (removeKeys.has(key)) continue;
      // A claim re-verified at a NEW target supersedes its old-location row (same harness+asset+
      // identity, different path). Without this the moved-from row would survive the merge as a
      // live claim, keeping the stale bytes owned and blocking the tombstone sweep below.
      const prior = priorByIdentity.get(`${resource.harness}\u0000${resource.assetId}\u0000${resource.identity ?? ''}`);
      if (prior && prior.target !== resource.target) {
        const supersededKey = ownershipKey(prior);
        next.resources = next.resources.filter((item: any) => ownershipKey(item) !== supersededKey);
      }
      const index = next.resources.findIndex((item: any) => ownershipKey(item) === key);
      if (index >= 0) next.resources[index] = resource;
      else next.resources.push(resource);
    }
    next.targets[verification.harness] = { installed: true, lastUpdated: new Date().toISOString() };
  }
  // Tombstones (ledger v2): a claim that moved leaves its old bytes behind at the old target.
  // Record the relocation, then sweep the stale copy — but only when its bytes still hash to the
  // fingerprint DoFlow last verified there. A mismatch means someone edited that file after us:
  // their content outranks our tidiness, so the file stays and the unswept tombstone says why.
  for (const resource of next.resources) {
    const prior = priorByIdentity.get(`${resource.harness}\u0000${resource.assetId}\u0000${resource.identity ?? ''}`);
    if (!prior || prior.target === resource.target) continue;
    if (!next.tombstones.some((entry: any) => entry.harness === resource.harness
      && entry.fromTarget === prior.target && entry.toTarget === resource.target)) {
      next.tombstones.push({
        harness: resource.harness, assetId: resource.assetId,
        fromTarget: prior.target, toTarget: resource.target,
        fingerprint: prior.fingerprint ?? null, movedAt: new Date().toISOString(),
      });
    }
  }
  const claims = new Set(next.resources.map((resource: any) => resource.target));
  for (const entry of next.tombstones) {
    if (entry.sweptAt || !fsImpl.existsSync(entry.fromTarget) || claims.has(entry.fromTarget)) continue;
    try {
      const current = crypto.createHash('sha256').update(fsImpl.readFileSync(entry.fromTarget)).digest('hex');
      if (entry.fingerprint && current === String(entry.fingerprint).replace(/^sha256:/, '')) {
        fsImpl.rmSync(entry.fromTarget);
        entry.sweptAt = new Date().toISOString();
        pruneEmptyAncestors(path.dirname(entry.fromTarget), { fsImpl });
      }
    } catch { /* unreadable or undeletable: leave it; the tombstone stays unswept and visible */ }
  }
  next.lastRecoveryId = recoveryRef;
  const guidanceVersion = readGuidanceVersion(scopeRoot, fsImpl);
  if (guidanceVersion !== null) next.guidanceVersion = guidanceVersion;
  return next;
}

function verifyLifecycle({ plan, adapters, context = {} }: any) {
  const verifications = [];
  for (const target of plan.targets) {
    if (target.skipped) continue;
    const harness = harnessFor(context.registry ?? plan.registry, target.harness);
    const adapter = resolveAdapter(adapters, harness);
    const operation = context.operation ?? 'verify';
    // After an apply, the files this harness just wrote: a copy-tree verifier reports one that is
    // missing instead of skipping it like a file the user deleted.
    const plannedWrites = context.checkPlannedWrites
      ? target.changes.filter((change: any) => !change.retained && (change.operation === 'create' || change.operation === 'update')).map((change: any) => change.target)
      : undefined;
    let verification = normalizeVerification(adapter.verify({ ...target.adapterInput,
      registry: context.registry ?? plan.registry, discovery: target.discovery, ledger: plan.ledger,
      operation, context: { ...target.adapterInput.context, operation, ...(plannedWrites ? { plannedWrites } : {}) } }), harness);
    if (operation === 'remove') verification = normalizeRemovalVerification(verification, target.changes, plan.ledger);
    verifications.push({ ...verification, hookWiring: hookWiringStatus(harness, target, verification) });
  }
  const conflicts = verifications.flatMap((result) => (result.conflicts || []).map((reason: any) => ({ harness: result.harness, reason })));
  return { verifications, conflicts, ok: conflicts.length === 0 && verifications.every((result) => result.ok !== false) };
}

function assertPlanApplicable(plan: any, stateRoot: any, acceptPrerequisites: any) {
  if (!plan.safe && !(acceptPrerequisites && plan.conflicts.length === 0)) throw new Error('Refusing to apply an unsafe lifecycle plan');
  if (!stateRoot) throw new Error('stateRoot is required before lifecycle mutation');
  if (!plan.requiredNativeResources?.length || !plan.changes.length) throw new Error('Refusing to apply a lifecycle plan with no required native resources');
}

/** Registry-declared hooks assets (`kind: "hooks"` in core/registry/assets.json) this harness's
 * plan selected — currently only claude.hooks-scripts and kiro.hooks-scripts. Codex and Gemini
 * deploy hooks via their own bespoke code paths (see targetNeedsHooks below) rather than a
 * registered asset, so they never appear here. */
function hookAssetIds(target: any) {
  return new Set((target.assets || []).filter((asset: any) => asset.kind === 'hooks').map((asset: any) => asset.id));
}

/** Whether this harness's plan includes at least one hooks-bearing change. Claude's hooks are a
 * registry-declared asset (`kind: "hooks"` in core/registry/assets.json); Codex and Gemini deploy
 * hooks via their own bespoke code paths and tag the resulting change with `nativeComponent:
 * 'hooks'` instead (see src/adapters/codex/index.ts and src/adapters/gemini/index.ts). Either
 * signal is sufficient — this stays harness-agnostic on purpose. */
function targetNeedsHooks(target: any) {
  const hookIds = hookAssetIds(target);
  return (target.changes || []).some((change: any) => hookIds.has(change.assetId) || change.nativeComponent === 'hooks');
}

/** Whether a verified resource is the hooks resource this harness owns. A registry-declared hooks
 * asset (Claude, Kiro) is matched by assetId; Codex's bespoke hooks-file resource is matched by
 * `kind`; Gemini's bespoke hooks resource (a key inside settings.json, not a standalone file) is
 * matched by its `projection.renderer` tag — see src/adapters/codex/index.ts's
 * `lifecycleResource(..., kind: 'hooks-file', ...)` and src/adapters/gemini/index.ts's verify(),
 * which tags its hooks resource `projection: { renderer: 'gemini-hooks' }`. */
function verificationOwnsHooks(verification: any, hookIds: any) {
  return (verification?.resources || []).some((resource: any) =>
    hookIds.has(resource.assetId) || resource.kind === 'hooks-file' || resource.projection?.renderer === 'gemini-hooks');
}

/** Gemini's hooks trust, observed through the adapter's own API. How trust is computed — the
 * fingerprint semantics, which context fields matter — lives in src/adapters/gemini (review A3:
 * this file used to import planGeminiHooks and re-derive the plan itself). */
function geminiHookTrust(target: any) {
  return geminiHookTrustFor(target);
}

/** General, per-harness hook-wiring status — the one place install status distinguishes an
 * installed-but-not-yet-active hooks resource from one already live, replacing the ad-hoc,
 * Codex-only hardcode bin/doflow.js's `cmdStatus` used to carry. Three outcomes:
 *  - 'absent': this harness owns no hooks resource in the current verification (nothing installed).
 *  - 'installed-pending': a hooks resource is installed, but a prerequisite is unmet — Codex's
 *    static `capabilities.hooks.prerequisites` (`trusted-project`, `hook-review`), which DoFlow has
 *    no way to confirm a human satisfied, so it is reported unmet unconditionally; or Gemini's live
 *    trust computation via geminiHookTrust above.
 *  - 'active': installed with no unmet prerequisite (Claude and Kiro today, since neither declares
 *    any `capabilities.hooks.prerequisites` and Kiro hooks activate automatically per kiro.dev). */
function hookWiringStatus(harness: any, target: any, verification: any) {
  if (!target || target.skipped) return { status: 'absent', prerequisites: [] };
  if (!verificationOwnsHooks(verification, hookAssetIds(target))) return { status: 'absent', prerequisites: [] };
  if (harness.id === 'gemini') {
    const trust = geminiHookTrust(target);
    if (trust?.required && !trust.trusted) return { status: 'installed-pending', prerequisites: ['hook-trust'] };
    return { status: 'active', prerequisites: [] };
  }
  const prerequisites = harness.capabilities?.hooks?.prerequisites || [];
  return prerequisites.length
    ? { status: 'installed-pending', prerequisites: [...prerequisites] }
    : { status: 'active', prerequisites: [] };
}

/** FR-003 preflight: refuse to write hook-bearing changes when no bash-capable shell (POSIX
 * bash, Git Bash/MSYS2, or WSL) is invocable, rather than installing hooks that will error
 * silently at runtime. Only harnesses whose selected changes actually include hooks trigger
 * this — a plan touching only guidance/skills assets never invokes the check. Removal is
 * exempt: deleting hook files does not require running them. */
function assertBashAvailableForHooks(plan: any, mode: any, hasBashCapableShellFn: any) {
  if (mode === 'remove') return;
  const hookHarnesses = plan.targets.filter((target: any) => !target.skipped && targetNeedsHooks(target)).map((target: any) => target.harness);
  if (hookHarnesses.length === 0) return;
  if (hasBashCapableShellFn()) return;
  throw new Error(`No bash-capable shell detected (checked: bash --version). Install Git Bash for Windows, or run inside WSL, before installing hooks for ${hookHarnesses.join(', ')}.`);
}

function applyLifecycle({ plan, registry, adapters, stateRoot, ledger = plan.ledger, context = {}, mode = 'apply', acceptPrerequisites = false, writeLedgerFn = writeLedger, writeRecoveryRecordFn = writeRecoveryRecord, hasBashCapableShellFn = hasBashCapableShell }: any) {
  assertPlanApplicable(plan, stateRoot, acceptPrerequisites);
  assertBashAvailableForHooks(plan, mode, hasBashCapableShellFn);
  const recovery = writeRecoveryRecordFn(stateRoot, { status: 'pending', changes: plan.changes });
  const completedHarnesses = [];
  try {
    for (const target of plan.targets) {
      if (target.skipped || target.changes.length === 0) continue;
      // A retained change is a ledger release, not a native mutation: the adapter must never see
      // it, because every adapter's job with a removal change is to delete the thing. Filtered
      // here rather than in planLifecycle so the change still reaches updateLedger, which is what
      // actually drops this harness's ownership row.
      const applicable = target.changes.filter((change: any) => !change.retained);
      if (!applicable.length) continue;
      const harness = harnessFor(registry, target.harness);
      const adapter = resolveAdapter(adapters, harness);
      adapter[mode === 'remove' ? 'remove' : 'apply']({ ...target.adapterInput, registry, changes: applicable, ledger, recoveryRef: recovery.id });
      completedHarnesses.push(target.harness);
    }
  } catch (error: any) {
    // A mid-loop throw (fs error, TOCTOU ownership mismatch) leaves some harnesses' native writes
    // already on disk. Recording exactly which ones completed — rather than leaving the record
    // stuck at 'pending' forever — is the difference between a diagnosable partial failure and a
    // silent one a later run can't distinguish from "nothing happened yet".
    writeRecoveryRecordFn(stateRoot, { ...recovery.record, status: 'failed', completedHarnesses, error: error.message });
    throw error;
  }
  const verification = verifyLifecycle({ plan: { ...plan, registry }, adapters,
    context: { ...context, registry, operation: mode === 'remove' ? 'remove' : 'apply', checkPlannedWrites: mode !== 'remove' } });
  if (!verification.ok) {
    writeRecoveryRecordFn(stateRoot, { ...recovery.record, status: 'verification-failed', verification });
    throw new Error('Lifecycle verification failed; ledger was not updated');
  }
  try {
    applyMcpIndex({ scopeRoot: plan.scopeRoot, selectedMcp: plan.mcp, mode, retain: !removalIsTotal(plan) });
  } catch (error: any) {
    // Same reasoning as the harness-loop catch above: every native resource already applied and
    // verified successfully by this point, so leaving the record at 'pending' on a failure here
    // would hide that success and make a retry indistinguishable from a from-scratch install.
    writeRecoveryRecordFn(stateRoot, { ...recovery.record, status: 'failed', completedHarnesses, verification, error: error.message });
    throw error;
  }
  const nextLedger = updateLedger({ ledger, scope: plan.scope, scopeRoot: plan.scopeRoot, verifications: verification.verifications, changes: plan.changes, recoveryRef: recovery.id });
  writeLedgerFn(stateRoot, nextLedger);
  writeRecoveryRecordFn(stateRoot, { ...recovery.record, status: 'verified', verification });
  return { recovery, verification, ledger: nextLedger, retained: plan.retained ?? [] };
}

/**
 * Record the MCP entries a plan finds DoFlow's without changing them: an entry co-owned beside
 * another harness's row, or one adopted from a 1.18.0 install. Their rows are written by verify,
 * which only runs after an apply, so a run with no native change would otherwise leave them out of
 * the ledger, and a later removal of the other harness would delete an entry this harness still
 * selects. Verify only reads; this writes the ledger and nothing native. `dryRun` reports without
 * writing. Returns the ledger and the server ids recorded per harness.
 */
function recordMcpOwnership({ plan, registry, adapters, stateRoot, ledger = plan.ledger, dryRun = false, writeLedgerFn = writeLedger }: any) {
  const { verifications } = verifyLifecycle({ plan: { ...plan, registry }, adapters, context: { registry, operation: 'apply' } });
  const held = new Set((ledger.resources || []).map((resource: any) => ownershipKey(resource)));
  const added = verifications.flatMap((verification) => (verification.resources || [])
    .filter((resource: any) => resource.kind === 'mcp-server')
    .map((resource: any) => ({ ...resource, harness: verification.harness, scope: plan.scope, recoveryRef: resource.recoveryRef ?? null })))
    .filter((resource) => !held.has(ownershipKey(resource)));
  const recorded: Record<string, any[]> = {};
  for (const resource of added) (recorded[resource.harness] ??= []).push(resource.identity);
  if (!added.length || dryRun) return { ledger, recorded };
  const next = upgradeLedger({ ...ledger, resources: [...(ledger.resources || []), ...added] });
  writeLedgerFn(stateRoot, next);
  return { ledger: next, recorded };
}

function removeLifecycle(options: any) {
  const plan = planLifecycle({ ...options, context: { ...(options.context || {}), operation: 'remove' } });
  return applyLifecycle({ ...options, plan, mode: 'remove', acceptPrerequisites: options.acceptPrerequisites });
}

module.exports = { OPERATIONS, MCP_KEEP, recordMcpOwnership, registryScope, normalizeTargets, normalizeChange, matchesChange, normalizeRemovalVerification, adapterConflicts, planLifecycle, verifyLifecycle, applyLifecycle, removeLifecycle, updateLedger, mcpIndexPath, applyMcpIndex, targetNeedsHooks, assertBashAvailableForHooks, hookWiringStatus, markRetainedRemovals, retentionSummary, RUNTIME_TREE_ASSETS };
