'use strict';
// lifecycle-view.js — CLI-facing view over the registry/lifecycle path: computes a plan across
// every requested harness (claude/codex/gemini) from a loaded registry, a neutral ledger, and the
// Codex-native source locations under `repoRoot`, then renders/gates it for bin/doflow.js's
// install/update/remove/status commands.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseToml } = require('../helper/toml');
const { createAdapterRegistry } = require('../adapters');
const { declaredHarnessPaths } = require('../helper/harness-paths');
const claudeAdapter = require('../adapters/claude');
const codexAdapter = require('../adapters/codex');
const { createGeminiAdapter } = require('../adapters/gemini');
const { createOpenCodeAdapter } = require('../adapters/opencode');
const { createPiAdapter } = require('../adapters/pi');
const { createCopilotAdapter } = require('../adapters/copilot');
const { createKiroAdapter } = require('../adapters/kiro');
const { createAntigravityAdapter } = require('../adapters/antigravity');
const { planLifecycle } = require('./index');
const { stateRoot, readLedger, defaultLedger } = require('../state');
const { selectAssets } = require('../registry');
const { defaultLock, readLock, writeLock, diffLocks, removeLock } = require('../state/lockfile');
// Tolerant because the projected runtime under `.doflow/runtime/` ships bin/, src/ and
// core/registry/ but no package.json — see the `runtime.*` assets in core/registry/assets.json.
// A hard require here would make every Node-backed verb fail in an install, which is the exact
// defect that projection exists to fix. Only version reporting depends on this.
function loadPkg() {
  try { return require('../../package.json'); } catch { return { version: '0.0.0-installed', name: '@khoavu882/doflow' }; }
}
const pkg = loadPkg();

function codexScope(scope) { return scope.global ? 'global' : 'project'; }

function codexConfigResources(repoRoot, fsImpl) {
  const configSrc = path.join(repoRoot, 'core', 'harnesses', 'codex', 'config', 'config.toml');
  const parsed = parseToml(fsImpl.readFileSync(configSrc, 'utf8'));
  return [...parsed.entries.entries()].map(([identity, entry]) => ({
    target: 'codex', kind: 'configuration-entry', identity, value: entry.value,
    sourceVersion: pkg.version, selection: true,
  }));
}

/** Registry/lifecycle is introduced as a read-only companion to the legacy installer.  It makes
 * the capability and neutral-ledger view observable without changing the proven copy/backup
 * mutation path until every native adapter has CLI-level parity.
 * `registry` is loaded once per command (by the caller) and threaded through here rather than
 * reloaded — the same registry also resolves every harness's MCP selection for that command. */
function registryLifecycleView({ registry, scope, targets, mcpSelections = {}, mcpAdoptable = {}, retainedMcpIds = [], operation, repoRoot, force = false, adopt = false, permissions = false, statusline = false, fsImpl = fs }) {
  const lifecycleScope = codexScope(scope);
  const scopeRoot = scope.global ? os.homedir() : path.resolve(scope.projectRoot);
  const neutralStateRoot = stateRoot({ scope: lifecycleScope, projectRoot: scopeRoot, homeDir: scopeRoot });
  const ledger = readLedger(neutralStateRoot) ?? defaultLedger({ scope: lifecycleScope, scopeRoot });
  // Mirrors buildAdapterRegistry() in src/cli/shared.js — including the declared-paths wiring —
  // and is kept as a literal construction here because the registry guard pins every declared
  // harness into each adapter-registry call site by parsing it.
  const declared = declaredHarnessPaths();
  const adapters = createAdapterRegistry({ claude: claudeAdapter.createClaudeAdapter({ declaredPaths: declared.claude }),
    codex: codexAdapter.createCodexAdapter({ declaredPaths: declared.codex }), gemini: createGeminiAdapter({ declaredPaths: declared.gemini }),
    opencode: createOpenCodeAdapter({ declaredPaths: declared.opencode }), pi: createPiAdapter({ declaredPaths: declared.pi }),
    copilot: createCopilotAdapter({ declaredPaths: declared.copilot }), kiro: createKiroAdapter({ declaredPaths: declared.kiro }),
    antigravity: createAntigravityAdapter({ declaredPaths: declared.antigravity }) });
  const plan = planLifecycle({ registry, adapters, scope: lifecycleScope, scopeRoot, targets, mcpSelections, mcpAdoptable, retainedMcpIds, ledger, context: {
    repoRoot, projectRoot: scopeRoot, homeDir: os.homedir(), sourceVersion: pkg.version,
    codexConfigResources: codexConfigResources(repoRoot, fsImpl),
    codexAgentsSourceDir: path.join(repoRoot, 'core', 'harnesses', 'codex', 'agents'),
    codexHooksSourceFile: path.join(repoRoot, 'core', 'harnesses', 'codex', 'hooks', 'hooks.json'),
    codexHooksSourceDir: path.join(repoRoot, 'core', 'harnesses', 'codex', 'hooks'),
    geminiHooksSourceFile: path.join(repoRoot, 'core', 'harnesses', 'gemini', 'hooks', 'hooks.json'),
    geminiHooksSourceDir: path.join(repoRoot, 'core', 'harnesses', 'gemini', 'hooks'),
    operation,
    force,
    adopt,
    permissions,
    statusline,
  } });
  return { registry, stateRoot: neutralStateRoot, ledger, plan, adapters };
}

function printRegistryLifecycle(view, prefix = '[PLAN]') {
  console.log(`${prefix} Registry lifecycle: ${view.plan.changes.length} native change(s), ${view.plan.conflicts.length} conflict(s), ${view.plan.prerequisites.length} prerequisite(s)`);
  for (const target of view.plan.targets) {
    console.log(`${prefix}   ${target.harness}: ${target.changes.length} change(s)${target.conflicts.length ? `; conflicts: ${target.conflicts.join('; ')}` : ''}`);
    const hookChange = target.changes.find((change) => change.nativeComponent === 'hooks');
    if (hookChange?.nativePlan?.trust?.required) {
      console.log(`${prefix}   ${target.harness} hooks trust: ${hookChange.nativePlan.trust.status} (review required in ${target.harness})`);
    }
    for (const notice of target.notices ?? []) console.log(`${prefix}   ${target.harness}: ${notice}`);
  }
  console.log(`${prefix} Neutral state: ${view.stateRoot}${readLedger(view.stateRoot) ? ' (existing ledger)' : ' (not yet created)'}`);
}

/** Prints the plan's notices after a real run. Independent of whether anything changed: a no-op
 * reinstall of a harness that has a gap must still say so. */
function printPlanNotices(view) {
  for (const { harness, notice } of view.plan.notices) console.log(`[INFO] ${harness}: ${notice}`);
}

/** Harnesses whose native resources are reconciled through the registry/lifecycle path (all of
 * them, as of this wiring). Kept as an explicit list — rather than reusing VALID from
 * src/targets.js — so a future non-lifecycle target doesn't silently gain lifecycle behavior. */
const LIFECYCLE_HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];

function assertSafeRegistryPlan(view) {
  if (view.plan.safe) return;
  for (const conflict of view.plan.conflicts) console.error(`[ERROR] ${conflict.harness} lifecycle refused: ${conflict.reason}`);
  for (const prerequisite of view.plan.prerequisites) console.error(`[ERROR] ${prerequisite.harness} lifecycle prerequisite: ${prerequisite.prerequisite}`);
  process.exitCode = 1;
}

/** Build the doflow.lock document describing an invocation's resolved selections. Pure — no I/O —
 * so tests can pin exactly what gets pinned without running an install. Assets are enumerated per
 * targeted harness from the same registry selection the adapters consume; MCP selections arrive
 * pre-resolved from the caller because their prompting lives in the CLI layer. */
function lockDocument({ registry, scope, scopeRoot, targets, mcpSelections = {}, sourceVersion = pkg.version, now = new Date() }) {
  const assets = [];
  for (const harness of targets) {
    for (const asset of selectAssets(registry, { harness })) {
      const nativeDir = asset.nativeDir?.[harness];
      assets.push({ id: asset.id, kind: asset.kind, ...(nativeDir ? { nativeDir } : {}) });
    }
  }
  const selections = Object.fromEntries(
    Object.entries(mcpSelections)
      .filter(([harness, ids]) => targets.includes(harness) && Array.isArray(ids) && ids.length > 0),
  );
  return {
    ...defaultLock({ scope, scopeRoot }),
    generatedAt: now.toISOString(),
    sourceVersion,
    targets: [...targets].sort().map((harness) => ({ harness })),
    assets,
    mcpSelections: selections,
  };
}

/** Describe the reviewable delta between the pinned lock and the next one: "created" for a first
 * pin, "unchanged" when nothing pinned differs, "cleared" when nothing remains pinned, else a count
 * of the changed rows. */
function lockDelta(previous, next) {
  if (!next) return previous ? { changed: true, summary: 'cleared' } : { changed: false, summary: 'unchanged' };
  if (!previous) return { changed: true, summary: 'created' };
  const diff = diffLocks(previous, next);
  if (diff.clean) return { changed: false, summary: 'unchanged' };
  const count = ['targets', 'assets']
    .flatMap((section) => Object.values(diff[section]).map((list) => list.length))
    .reduce((sum, n) => sum + n, 0)
    + diff.mcpSelections.changed.length + (diff.meta.sourceVersion ? 1 : 0);
  return { changed: true, summary: `${count} change(s)` };
}

/** Persist the lock for a completed command and return its delta against what was pinned before.
 * An unchanged lock is left byte for byte, so routine re-runs neither rewrite the file nor
 * manufacture noise; a `null` lock removes the file. */
function recordLock(scopeArgs, next, { fsImpl = fs } = {}) {
  const delta = lockDelta(readLock(scopeArgs, { fsImpl }), next);
  if (delta.changed) {
    if (next) writeLock(scopeArgs, next, { fsImpl });
    else removeLock(scopeArgs, { fsImpl });
  }
  return delta;
}

module.exports = {
  codexScope, registryLifecycleView, printRegistryLifecycle, printPlanNotices, LIFECYCLE_HARNESSES, assertSafeRegistryPlan,
  lockDocument, lockDelta, recordLock,
};
