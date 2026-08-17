'use strict';
// lifecycle-view.js — CLI-facing view over the registry/lifecycle path: computes a plan across
// every requested harness (claude/codex/gemini) from a loaded registry, a neutral ledger, and the
// Codex-native source locations under `repoRoot`, then renders/gates it for bin/doflow.js's
// install/update/remove/status commands.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseToml } = require('./codex-config');
const { createAdapterRegistry } = require('./adapters');
const claudeAdapter = require('./adapters/claude');
const codexAdapter = require('./adapters/codex');
const { createGeminiAdapter } = require('./adapters/gemini');
const { createOpenCodeAdapter } = require('./adapters/opencode');
const { createPiAdapter } = require('./adapters/pi');
const { createCopilotAdapter } = require('./adapters/copilot');
const { createKiroAdapter } = require('./adapters/kiro');
const { planLifecycle } = require('./lifecycle');
const { stateRoot, readLedger, defaultLedger } = require('./state');
const pkg = require('../package.json');

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
 * reloaded — the same registry also resolves the Claude/Codex MCP catalog for that command. */
function registryLifecycleView({ registry, scope, targets, mcpIds, operation, repoRoot, fsImpl = fs }) {
  const lifecycleScope = codexScope(scope);
  const scopeRoot = scope.global ? os.homedir() : path.resolve(scope.projectRoot);
  const neutralStateRoot = stateRoot({ scope: lifecycleScope, projectRoot: scopeRoot, homeDir: scopeRoot });
  const ledger = readLedger(neutralStateRoot) ?? defaultLedger({ scope: lifecycleScope, scopeRoot });
  const adapters = createAdapterRegistry({ claude: claudeAdapter, codex: codexAdapter, gemini: createGeminiAdapter(),
    opencode: createOpenCodeAdapter(), pi: createPiAdapter(), copilot: createCopilotAdapter(), kiro: createKiroAdapter() });
  const plan = planLifecycle({ registry, adapters, scope: lifecycleScope, scopeRoot, targets, mcpIds, ledger, context: {
    repoRoot, projectRoot: scopeRoot, homeDir: os.homedir(), sourceVersion: pkg.version,
    codexConfigResources: codexConfigResources(repoRoot, fsImpl),
    codexAgentsSourceDir: path.join(repoRoot, 'core', 'harnesses', 'codex', 'agents'),
    codexHooksSourceFile: path.join(repoRoot, 'core', 'harnesses', 'codex', 'hooks', 'hooks.json'),
    codexHooksSourceDir: path.join(repoRoot, 'core', 'harnesses', 'codex', 'hooks'),
    geminiHooksSourceFile: path.join(repoRoot, 'core', 'harnesses', 'gemini', 'hooks', 'hooks.json'),
    geminiHooksSourceDir: path.join(repoRoot, 'core', 'harnesses', 'gemini', 'hooks'),
    operation,
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
  }
  console.log(`${prefix} Neutral state: ${view.stateRoot}${readLedger(view.stateRoot) ? ' (existing ledger)' : ' (not yet created)'}`);
}

/** Harnesses whose native resources are reconciled through the registry/lifecycle path (all of
 * them, as of this wiring). Kept as an explicit list — rather than reusing VALID from
 * src/targets.js — so a future non-lifecycle target doesn't silently gain lifecycle behavior. */
const LIFECYCLE_HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro'];

function assertSafeRegistryPlan(view) {
  if (view.plan.safe) return;
  for (const conflict of view.plan.conflicts) console.error(`[ERROR] ${conflict.harness} lifecycle refused: ${conflict.reason}`);
  for (const prerequisite of view.plan.prerequisites) console.error(`[ERROR] ${prerequisite.harness} lifecycle prerequisite: ${prerequisite.prerequisite}`);
  process.exitCode = 1;
}

module.exports = {
  codexScope, registryLifecycleView, printRegistryLifecycle, LIFECYCLE_HARNESSES, assertSafeRegistryPlan,
};
