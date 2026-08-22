'use strict';

// Native state and formats remain adapter-owned. The lifecycle layer selects
// registry assets, validates declarative changes, journals mutations, and keeps
// the neutral ledger in sync only after successful verification.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { harnessFor, selectAssets, selectMcpServers } = require('../registry');
const { defaultLedger, ownershipKey, writeLedger, writeRecoveryRecord, upgradeLedger, LEDGER_VERSION } = require('../state');
const { resolveAdapter, projectAdapterInput } = require('../adapters');
const { pruneEmptyAncestors } = require('../adapters/copy-tree');
const { renderPolicies } = require('./policies');
const { renderMcpIndex } = require('./mcp-index');
const { hasBashCapableShell } = require('./bash-availability');
const { planGeminiHooks } = require('../adapters/gemini');

const OPERATIONS = new Set(['create', 'merge', 'update', 'remove']);

function registryScope(scope) { return scope === 'global' ? 'user' : scope; }
function assertScope(scope) {
  if (scope !== 'project' && scope !== 'global') throw new Error(`Lifecycle scope must be project or global, got '${scope}'`);
}

function normalizeTargets(registry, targets) {
  const wanted = targets && targets.length ? targets : registry.harnesses.map((harness) => harness.id);
  if (!Array.isArray(wanted)) throw new Error('Lifecycle targets must be an array');
  return [...new Set(wanted)].map((id) => harnessFor(registry, id));
}

function identityFor(change) { return change.ownershipIdentity ?? change.ownership; }

function normalizeChange(change, { harness, assets }) {
  if (!change || typeof change !== 'object') throw new Error(`Adapter '${harness.id}' returned a non-object change`);
  const ownershipIdentity = identityFor(change);
  if (change.harness !== undefined && change.harness !== harness.id) throw new Error(`Adapter '${harness.id}' returned a change for '${change.harness}'`);
  if (!assets.some((asset) => asset.id === change.assetId)) throw new Error(`Adapter '${harness.id}' returned unknown asset '${change.assetId}'`);
  if (!OPERATIONS.has(change.operation)) throw new Error(`Adapter '${harness.id}' returned unsupported operation '${change.operation}'`);
  if (typeof change.target !== 'string' || !change.target) throw new Error(`Adapter '${harness.id}' change '${change.assetId}' requires target`);
  if (typeof ownershipIdentity !== 'string' || !ownershipIdentity) throw new Error(`Adapter '${harness.id}' change '${change.assetId}' requires ownershipIdentity`);
  return Object.freeze({ ...change, harness: harness.id, ownershipIdentity });
}

function normalizeVerification(result, harness) {
  if (!result || typeof result !== 'object') throw new Error(`Adapter '${harness.id}' returned an invalid verification result`);
  const statuses = Array.isArray(result.statuses) ? result.statuses : [];
  const resources = Array.isArray(result.resources) ? result.resources : [];
  return { ...result, harness: harness.id, statuses, resources };
}

function matchesChange(resource, change) {
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
function reconcileRemovedChange(verification, statuses, change) {
  const reported = verification.resources.some((resource) => matchesChange(resource, change));
  const statusIndex = statuses.findIndex((item) => matchesChange(item, change));
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
function markUnownedAbsences(statuses, ledger, harness) {
  if (!ledger) return statuses;
  const owned = new Set((ledger.resources || [])
    .filter((resource) => resource.harness === harness)
    .map((resource) => resource.ownershipIdentity)
    .filter(Boolean));
  return statuses.map((status) => (
    status?.status === 'missing' && status.ownershipIdentity && !owned.has(status.ownershipIdentity)
      ? { ...status, status: 'absent', expectedAbsence: true }
      : status
  ));
}

function normalizeRemovalVerification(verification, changes, ledger) {
  const removals = changes.filter((change) => change.operation === 'remove' && change.harness === verification.harness);
  if (!removals.length) return verification;
  // A retained removal released this harness's ownership row without deleting the file, because
  // another harness still claims it (see markRetainedRemovals). The file is therefore *expected*
  // to still be on disk, so asking "is it gone?" of it would turn the correct outcome into a
  // verification conflict. Everything the plan actually deleted is still checked as strictly as
  // before.
  const removed = removals.filter((change) => !change.retained);
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
function removalVerificationOk(ok, statuses, conflicts) {
  const unresolvedFailure = statuses.some((status) => ['missing', 'conflict', 'error', 'invalid'].includes(status?.status));
  const onlyExpectedRemovalFailure = ok === false && statuses.some((status) => status?.expectedRemoval || status?.expectedAbsence) && !unresolvedFailure && conflicts.length === 0;
  return conflicts.length === 0 && !unresolvedFailure && (ok !== false || onlyExpectedRemovalFailure);
}

/** A `failures` entry comes in three shapes from different adapters: a [name, detail] tuple,
 * a bare string, or an object with its own conflicts/errors. */
function failureReasons(failure) {
  if (Array.isArray(failure)) {
    const [name, detail] = failure;
    const detailReasons = detail?.conflicts || detail?.errors || [];
    return detailReasons.map((reason) => `${name}: ${reason}`);
  }
  if (typeof failure === 'string') return [failure];
  if (failure?.conflicts || failure?.errors) return failure.conflicts || failure.errors;
  return [];
}

function componentReasons(name, component) {
  if (component?.ok !== false) return [];
  const details = component.conflicts || component.errors || [];
  return details.length ? details.map((reason) => `${name}: ${reason}`) : [`${name}: native plan failed`];
}

/** Promote adapter-declared failed components into the common conflict channel.
 * A false `ok` is never advisory: otherwise a native adapter can decline a
 * dangerous reconciliation while the lifecycle still journals and writes state. */
function adapterConflicts(result, harness) {
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
function releasedOwnershipKeys(harnessPlans, scope) {
  const keys = new Set();
  for (const target of harnessPlans) {
    for (const change of target.changes || []) {
      if (change.operation !== 'remove') continue;
      keys.add(ownershipKey({ harness: change.harness, scope, assetId: change.assetId, target: change.target, ownershipIdentity: change.ownershipIdentity }));
    }
  }
  return keys;
}

/** Which harnesses still hold a ledger row for each destination once this plan's releases are
 * applied. Membership is decided per ROW, not per harness: a harness that is releasing its claim
 * on this file is not a claimant even if it is releasing nothing else, and a harness in the same
 * batch that keeps its row (an install that relocates one asset while a sibling's projection is
 * unchanged) still is. */
function survivingClaimantsByTarget(ledger, releasedKeys) {
  const byTarget = new Map();
  for (const resource of ledger?.resources || []) {
    if (typeof resource?.target !== 'string' || typeof resource?.harness !== 'string') continue;
    if (releasedKeys.has(ownershipKey(resource))) continue;
    if (!byTarget.has(resource.target)) byTarget.set(resource.target, new Set());
    byTarget.get(resource.target).add(resource.harness);
  }
  return byTarget;
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
function markRetainedRemovals(harnessPlans, ledger, scope) {
  const claimants = survivingClaimantsByTarget(ledger, releasedOwnershipKeys(harnessPlans, scope));
  if (!claimants.size) return harnessPlans;
  return harnessPlans.map((target) => {
    if (target.skipped) return target;
    let retainedAny = false;
    const changes = target.changes.map((change) => {
      if (change.operation !== 'remove') return change;
      const retainedFor = [...(claimants.get(change.target) ?? [])].filter((harness) => harness !== change.harness).sort();
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
function removalIsTotal(plan) {
  const released = releasedOwnershipKeys(plan.targets || [], plan.scope);
  return (plan.ledger?.resources || []).every((resource) => released.has(ownershipKey(resource)));
}

/** What a removal kept and why, ready to print. A command that says "removed" while silently
 * leaving files behind is answering confidently about something it did not do, so the retained
 * count and the harnesses responsible for it are reported, never inferred by the caller. */
function retentionSummary(retained = []) {
  const groups = new Map();
  for (const item of retained) {
    const key = `${item.harness} | ${item.retainedFor.join(', ')}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  return [...groups.entries()].map(([key, count]) => {
    const [harness, claimants] = key.split(' | ');
    return `${harness}: retained ${count} shared resource(s) still claimed by ${claimants}`;
  });
}

function retainedChanges(changes) {
  return changes.filter((change) => change.retained)
    .map((change) => ({ harness: change.harness, assetId: change.assetId, target: change.target, retainedFor: change.retainedFor }));
}

function planLifecycle({ registry, adapters, scope, scopeRoot, targets, mcpIds, ledger, context = {} }) {
  assertScope(scope);
  if (!registry) throw new Error('registry is required');
  const selectedMcp = selectMcpServers(registry, mcpIds);
  const baseLedger = ledger ?? defaultLedger({ scope, scopeRoot });
  const harnessPlans = normalizeTargets(registry, targets).map((harness) => {
    if (!harness.scopes.includes(registryScope(scope))) {
      return { harness: harness.id, assets: [], changes: [], conflicts: [`Harness '${harness.id}' does not support ${scope} scope`], prerequisites: [], skipped: true };
    }
    const assets = selectAssets(registry, { harness: harness.id });
    const policies = renderPolicies(registry, { harness: harness.id });
    const adapterInput = projectAdapterInput({ registry, harness, scope, scopeRoot, assets, mcp: selectedMcp, policies, context });
    const adapter = resolveAdapter(adapters, harness);
    const input = { ...adapterInput, registry, ledger: baseLedger };
    const discovery = adapter.discover(input);
    const result = adapter.plan({ ...input, discovery });
    if (!result || typeof result !== 'object') throw new Error(`Adapter '${harness.id}' returned an invalid plan`);
    const changes = (result.changes || []).map((change) => normalizeChange(change, { harness, assets }));
    const conflicts = adapterConflicts(result, harness);
    const prerequisites = [...(result.prerequisites || []), ...changes.map((change) => change.prerequisite).filter(Boolean)];
    const requiredNativeResources = result.requiredNativeResources ?? changes;
    if (!Array.isArray(requiredNativeResources)) throw new Error(`Adapter '${harness.id}' returned invalid requiredNativeResources`);
    return { harness: harness.id, adapter: harness.adapter, assets, mcp: selectedMcp, policies, adapterInput, discovery, changes, requiredNativeResources, conflicts, prerequisites, skipped: false };
  });
  // Only once every harness's plan is known: whether a file may be deleted depends on the rows
  // the WHOLE plan leaves standing, which no single harness's plan can see.
  const annotated = markRetainedRemovals(harnessPlans, baseLedger, scope);
  const changes = annotated.flatMap((item) => item.changes);
  const conflicts = annotated.flatMap((item) => item.conflicts.map((reason) => ({ harness: item.harness, reason })));
  const prerequisites = annotated.flatMap((item) => item.prerequisites.map((prerequisite) => ({ harness: item.harness, prerequisite })));
  const requiredNativeResources = annotated.flatMap((item) => item.requiredNativeResources || []);
  return Object.freeze({ scope, scopeRoot, mcp: selectedMcp, ledger: baseLedger, targets: annotated, changes, requiredNativeResources, conflicts, prerequisites,
    retained: retainedChanges(changes), safe: conflicts.length === 0 && prerequisites.length === 0 });
}

function verificationResources(verification, changes, scope, recoveryRef) {
  if (verification.resources.length) return verification.resources.map((resource) => ({ ...resource, harness: verification.harness, scope, recoveryRef: resource.recoveryRef ?? recoveryRef }));
  return changes.filter((change) => change.operation !== 'remove').map((change) => ({
    harness: change.harness, scope, assetId: change.assetId, target: change.target,
    ownershipIdentity: change.ownershipIdentity, fingerprint: change.afterFingerprint ?? null,
    sourceVersion: change.sourceVersion ?? 'unknown', projection: change.projection ?? null, recoveryRef,
  }));
}

/** The guidance-content layer's own version marker (core/shared/guidance/VERSION, copy-treed
 * to <scopeRoot>/.doflow/guidance/VERSION) is independent of this package's version — read it
 * fresh on every ledger update so the ledger reflects whatever is actually on disk. */
function readGuidanceVersion(scopeRoot, fsImpl = fs) {
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
 * emits come from core/registry/mcp.yaml as `mcp/MCP_*.md`, anchored at the guidance root — the
 * same anchor DOFLOW_CORE.md's own @-imports use. Writing this file into a subdirectory would
 * silently reinterpret every one of those paths against that subdirectory and break them all,
 * with no error at install time. test/mcp-index.test.js pins the anchor from both ends. */
function mcpIndexPath(scopeRoot) {
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
function applyMcpIndex({ scopeRoot, selectedMcp, mode, retain = false, fsImpl = fs }) {
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

function updateLedger({ ledger, scope, scopeRoot, verifications, changes, recoveryRef, fsImpl = fs }) {
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
    const related = changes.filter((change) => change.harness === verification.harness);
    const removed = related.filter((change) => change.operation === 'remove');
    const removeKeys = new Set(removed.map((change) => ownershipKey({ harness: change.harness, scope, assetId: change.assetId, target: change.target, ownershipIdentity: change.ownershipIdentity })));
    next.resources = next.resources.filter((resource) => !removeKeys.has(ownershipKey(resource)));
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
        next.resources = next.resources.filter((item) => ownershipKey(item) !== supersededKey);
      }
      const index = next.resources.findIndex((item) => ownershipKey(item) === key);
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
    if (!next.tombstones.some((entry) => entry.harness === resource.harness
      && entry.fromTarget === prior.target && entry.toTarget === resource.target)) {
      next.tombstones.push({
        harness: resource.harness, assetId: resource.assetId,
        fromTarget: prior.target, toTarget: resource.target,
        fingerprint: prior.fingerprint ?? null, movedAt: new Date().toISOString(),
      });
    }
  }
  const claims = new Set(next.resources.map((resource) => resource.target));
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

function verifyLifecycle({ plan, adapters, context = {} }) {
  const verifications = [];
  for (const target of plan.targets) {
    if (target.skipped) continue;
    const harness = harnessFor(context.registry ?? plan.registry, target.harness);
    const adapter = resolveAdapter(adapters, harness);
    const operation = context.operation ?? 'verify';
    let verification = normalizeVerification(adapter.verify({ ...target.adapterInput,
      registry: context.registry ?? plan.registry, discovery: target.discovery, ledger: plan.ledger,
      operation, context: { ...target.adapterInput.context, operation } }), harness);
    if (operation === 'remove') verification = normalizeRemovalVerification(verification, target.changes, plan.ledger);
    verifications.push({ ...verification, hookWiring: hookWiringStatus(harness, target, verification) });
  }
  const conflicts = verifications.flatMap((result) => (result.conflicts || []).map((reason) => ({ harness: result.harness, reason })));
  return { verifications, conflicts, ok: conflicts.length === 0 && verifications.every((result) => result.ok !== false) };
}

function assertPlanApplicable(plan, stateRoot, acceptPrerequisites) {
  if (!plan.safe && !(acceptPrerequisites && plan.conflicts.length === 0)) throw new Error('Refusing to apply an unsafe lifecycle plan');
  if (!stateRoot) throw new Error('stateRoot is required before lifecycle mutation');
  if (!plan.requiredNativeResources?.length || !plan.changes.length) throw new Error('Refusing to apply a lifecycle plan with no required native resources');
}

/** Registry-declared hooks assets (`kind: "hooks"` in core/registry/assets.yaml) this harness's
 * plan selected — currently only claude.hooks-scripts and kiro.hooks-scripts. Codex and Gemini
 * deploy hooks via their own bespoke code paths (see targetNeedsHooks below) rather than a
 * registered asset, so they never appear here. */
function hookAssetIds(target) {
  return new Set((target.assets || []).filter((asset) => asset.kind === 'hooks').map((asset) => asset.id));
}

/** Whether this harness's plan includes at least one hooks-bearing change. Claude's hooks are a
 * registry-declared asset (`kind: "hooks"` in core/registry/assets.yaml); Codex and Gemini deploy
 * hooks via their own bespoke code paths and tag the resulting change with `nativeComponent:
 * 'hooks'` instead (see src/adapters/codex/index.js and src/adapters/gemini/index.js). Either
 * signal is sufficient — this stays harness-agnostic on purpose. */
function targetNeedsHooks(target) {
  const hookIds = hookAssetIds(target);
  return (target.changes || []).some((change) => hookIds.has(change.assetId) || change.nativeComponent === 'hooks');
}

/** Whether a verified resource is the hooks resource this harness owns. A registry-declared hooks
 * asset (Claude, Kiro) is matched by assetId; Codex's bespoke hooks-file resource is matched by
 * `kind`; Gemini's bespoke hooks resource (a key inside settings.json, not a standalone file) is
 * matched by its `projection.renderer` tag — see src/adapters/codex/index.js's
 * `lifecycleResource(..., kind: 'hooks-file', ...)` and src/adapters/gemini/index.js's verify(),
 * which tags its hooks resource `projection: { renderer: 'gemini-hooks' }`. */
function verificationOwnsHooks(verification, hookIds) {
  return (verification?.resources || []).some((resource) =>
    hookIds.has(resource.assetId) || resource.kind === 'hooks-file' || resource.projection?.renderer === 'gemini-hooks');
}

/** Gemini's hooks trust is not a static registry prerequisite the way Codex's `trusted-project`/
 * `hook-review` are (see core/registry/harnesses.yaml's gemini.capabilities.hooks, which declares
 * no `prerequisites`); Gemini fingerprints hook name/command and warns before running one that
 * changed (geminicli.com/docs/hooks/), computed live by src/adapters/gemini/hooks.js's planGeminiHooks
 * against the current hooks.json source and the harness's current settings.json. Re-deriving that
 * plan here (rather than reading it off the adapter's own verify() output, which does not surface
 * `trust` on the resources/statuses it returns) is the only way to observe it without adapter
 * changes; it is read-only and side-effect free (planGeminiHooks never writes). */
function geminiHookTrust(target) {
  const context = target.adapterInput?.context || {};
  const settingsFile = target.discovery?.paths?.settings;
  if (!context.geminiHooksSourceFile || !settingsFile || target.discovery?.settings?.error) return null;
  const plan = planGeminiHooks({
    sourceFile: context.geminiHooksSourceFile, sourceHooksDir: context.geminiHooksSourceDir,
    settingsFile, trusted: context.hooksTrusted,
  });
  return plan.ok ? (plan.trust ?? null) : null;
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
function hookWiringStatus(harness, target, verification) {
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
function assertBashAvailableForHooks(plan, mode, hasBashCapableShellFn) {
  if (mode === 'remove') return;
  const hookHarnesses = plan.targets.filter((target) => !target.skipped && targetNeedsHooks(target)).map((target) => target.harness);
  if (hookHarnesses.length === 0) return;
  if (hasBashCapableShellFn()) return;
  throw new Error(`No bash-capable shell detected (checked: bash --version). Install Git Bash for Windows, or run inside WSL, before installing hooks for ${hookHarnesses.join(', ')}.`);
}

function applyLifecycle({ plan, registry, adapters, stateRoot, ledger = plan.ledger, context = {}, mode = 'apply', acceptPrerequisites = false, writeLedgerFn = writeLedger, writeRecoveryRecordFn = writeRecoveryRecord, hasBashCapableShellFn = hasBashCapableShell }) {
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
      const applicable = target.changes.filter((change) => !change.retained);
      if (!applicable.length) continue;
      const harness = harnessFor(registry, target.harness);
      const adapter = resolveAdapter(adapters, harness);
      adapter[mode === 'remove' ? 'remove' : 'apply']({ ...target.adapterInput, registry, changes: applicable, ledger, recoveryRef: recovery.id });
      completedHarnesses.push(target.harness);
    }
  } catch (error) {
    // A mid-loop throw (fs error, TOCTOU ownership mismatch) leaves some harnesses' native writes
    // already on disk. Recording exactly which ones completed — rather than leaving the record
    // stuck at 'pending' forever — is the difference between a diagnosable partial failure and a
    // silent one a later run can't distinguish from "nothing happened yet".
    writeRecoveryRecordFn(stateRoot, { ...recovery.record, status: 'failed', completedHarnesses, error: error.message });
    throw error;
  }
  const verification = verifyLifecycle({ plan: { ...plan, registry }, adapters,
    context: { ...context, registry, operation: mode === 'remove' ? 'remove' : 'apply' } });
  if (!verification.ok) {
    writeRecoveryRecordFn(stateRoot, { ...recovery.record, status: 'verification-failed', verification });
    throw new Error('Lifecycle verification failed; ledger was not updated');
  }
  try {
    applyMcpIndex({ scopeRoot: plan.scopeRoot, selectedMcp: plan.mcp, mode, retain: !removalIsTotal(plan) });
  } catch (error) {
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

function removeLifecycle(options) {
  const plan = planLifecycle({ ...options, context: { ...(options.context || {}), operation: 'remove' } });
  return applyLifecycle({ ...options, plan, mode: 'remove', acceptPrerequisites: options.acceptPrerequisites });
}

module.exports = { OPERATIONS, registryScope, normalizeTargets, normalizeChange, matchesChange, normalizeRemovalVerification, adapterConflicts, planLifecycle, verifyLifecycle, applyLifecycle, removeLifecycle, updateLedger, mcpIndexPath, applyMcpIndex, targetNeedsHooks, assertBashAvailableForHooks, hookWiringStatus, markRetainedRemovals, retentionSummary };
