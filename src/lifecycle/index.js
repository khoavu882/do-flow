'use strict';

// Native state and formats remain adapter-owned. The lifecycle layer selects
// registry assets, validates declarative changes, journals mutations, and keeps
// the neutral ledger in sync only after successful verification.
const fs = require('node:fs');
const path = require('node:path');
const { harnessFor, selectAssets, selectMcpServers } = require('../registry');
const { defaultLedger, ownershipKey, writeLedger, writeRecoveryRecord } = require('../state');
const { resolveAdapter, projectAdapterInput } = require('../adapters');
const { renderPolicies } = require('./policies');
const { renderMcpIndex } = require('./mcp-index');
const { hasBashCapableShell } = require('./bash-availability');

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
  const removed = changes.filter((change) => change.operation === 'remove' && change.harness === verification.harness);
  if (!removed.length) return verification;
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
  const changes = harnessPlans.flatMap((item) => item.changes);
  const conflicts = harnessPlans.flatMap((item) => item.conflicts.map((reason) => ({ harness: item.harness, reason })));
  const prerequisites = harnessPlans.flatMap((item) => item.prerequisites.map((prerequisite) => ({ harness: item.harness, prerequisite })));
  const requiredNativeResources = harnessPlans.flatMap((item) => item.requiredNativeResources || []);
  return Object.freeze({ scope, scopeRoot, mcp: selectedMcp, ledger: baseLedger, targets: harnessPlans, changes, requiredNativeResources, conflicts, prerequisites,
    safe: conflicts.length === 0 && prerequisites.length === 0 });
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
 * must never see a stale entry for a server that's no longer selected); remove -> always delete
 * regardless of selection, since the whole install is going away. */
function applyMcpIndex({ scopeRoot, selectedMcp, mode, fsImpl = fs }) {
  const file = mcpIndexPath(scopeRoot);
  const content = mode === 'remove' ? null : renderMcpIndex(selectedMcp);
  if (content === null) {
    if (fsImpl.existsSync(file)) fsImpl.unlinkSync(file);
    return;
  }
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  fsImpl.writeFileSync(file, content);
}

function updateLedger({ ledger, scope, scopeRoot, verifications, changes, recoveryRef, fsImpl = fs }) {
  const next = JSON.parse(JSON.stringify(ledger ?? defaultLedger({ scope, scopeRoot })));
  for (const verification of verifications) {
    const related = changes.filter((change) => change.harness === verification.harness);
    const removed = related.filter((change) => change.operation === 'remove');
    const removeKeys = new Set(removed.map((change) => ownershipKey({ harness: change.harness, scope, assetId: change.assetId, target: change.target, ownershipIdentity: change.ownershipIdentity })));
    next.resources = next.resources.filter((resource) => !removeKeys.has(ownershipKey(resource)));
    for (const resource of verificationResources(verification, related, scope, recoveryRef)) {
      const key = ownershipKey(resource);
      const index = next.resources.findIndex((item) => ownershipKey(item) === key);
      if (index >= 0) next.resources[index] = resource;
      else next.resources.push(resource);
    }
    next.targets[verification.harness] = { installed: true, lastUpdated: new Date().toISOString() };
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
    const verification = normalizeVerification(adapter.verify({ ...target.adapterInput,
      registry: context.registry ?? plan.registry, discovery: target.discovery, ledger: plan.ledger,
      operation, context: { ...target.adapterInput.context, operation } }), harness);
    verifications.push(operation === 'remove' ? normalizeRemovalVerification(verification, target.changes, plan.ledger) : verification);
  }
  const conflicts = verifications.flatMap((result) => (result.conflicts || []).map((reason) => ({ harness: result.harness, reason })));
  return { verifications, conflicts, ok: conflicts.length === 0 && verifications.every((result) => result.ok !== false) };
}

function assertPlanApplicable(plan, stateRoot, acceptPrerequisites) {
  if (!plan.safe && !(acceptPrerequisites && plan.conflicts.length === 0)) throw new Error('Refusing to apply an unsafe lifecycle plan');
  if (!stateRoot) throw new Error('stateRoot is required before lifecycle mutation');
  if (!plan.requiredNativeResources?.length || !plan.changes.length) throw new Error('Refusing to apply a lifecycle plan with no required native resources');
}

/** Whether this harness's plan includes at least one hooks-bearing change. Claude's hooks are a
 * registry-declared asset (`kind: "hooks"` in core/registry/assets.yaml); Codex and Gemini deploy
 * hooks via their own bespoke code paths and tag the resulting change with `nativeComponent:
 * 'hooks'` instead (see src/adapters/codex/index.js and src/adapters/gemini/index.js). Either
 * signal is sufficient — this stays harness-agnostic on purpose. */
function targetNeedsHooks(target) {
  const hookAssetIds = new Set((target.assets || []).filter((asset) => asset.kind === 'hooks').map((asset) => asset.id));
  return (target.changes || []).some((change) => hookAssetIds.has(change.assetId) || change.nativeComponent === 'hooks');
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
      const harness = harnessFor(registry, target.harness);
      const adapter = resolveAdapter(adapters, harness);
      adapter[mode === 'remove' ? 'remove' : 'apply']({ ...target.adapterInput, registry, changes: target.changes, ledger, recoveryRef: recovery.id });
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
    applyMcpIndex({ scopeRoot: plan.scopeRoot, selectedMcp: plan.mcp, mode });
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
  return { recovery, verification, ledger: nextLedger };
}

function removeLifecycle(options) {
  const plan = planLifecycle({ ...options, context: { ...(options.context || {}), operation: 'remove' } });
  return applyLifecycle({ ...options, plan, mode: 'remove', acceptPrerequisites: options.acceptPrerequisites });
}

module.exports = { OPERATIONS, registryScope, normalizeTargets, normalizeChange, matchesChange, normalizeRemovalVerification, adapterConflicts, planLifecycle, verifyLifecycle, applyLifecycle, removeLifecycle, updateLedger, mcpIndexPath, applyMcpIndex, targetNeedsHooks, assertBashAvailableForHooks };
