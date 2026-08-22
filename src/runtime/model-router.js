'use strict';

// Model role router. DoFlow never invokes a model itself; this resolves an abstract
// role from core/registry/models.yaml into availability-annotated provider candidates that skills,
// orchestration snapshots, or operators act on through each harness's native model selection.
// Policy strings (prefer/fallback/require) pass through verbatim — the registry owns them; this
// module owns matching them against providers' declared tiers and what is installed right now.

const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('../registry');
const { finishRuntime, usageError } = require('./cli-result');
const { REPO_ROOT } = require('../helper/repo-root');

/** The machine-level command each provider's backend answers to. A provider without a local CLI
 * (hosted-only access through another harness) reports backendCli null and is never "available". */
const BACKEND_CLI = Object.freeze({ claude: 'claude', codex: 'codex', copilot: 'copilot', ollama: 'ollama' });

function whichLike(command, { fsImpl = fs, pathEnv = process.env.PATH } = {}) {
  if (!command) return false;
  for (const dir of String(pathEnv ?? '').split(path.delimiter)) {
    if (!dir) continue;
    try {
      const candidate = path.join(dir, command);
      fsImpl.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch { /* keep scanning */ }
  }
  return false;
}

/** Providers whose backend CLI resolves on PATH. Injectable in tests; never guessed otherwise. */
function availableProviderIds({ fsImpl = fs } = {}) {
  return Object.entries(BACKEND_CLI)
    .filter(([, cli]) => whichLike(cli, { fsImpl }))
    .map(([id]) => id);
}

/**
 * Resolve one role to ranked candidates.
 * Ordering: available first, then preferred-tier match, then fallback-tier match, registry order
 * breaking ties. `exclude` drops provider ids entirely (e.g. the implementer when the role is
 * review with require:different-family) and is reported back rather than hidden.
 * Availability unknown stays null — absence of evidence is not reported as absent.
 */
function resolveModelRole({ registry, roleId, isAvailable = null, exclude = [] } = {}) {
  const role = (registry.modelRoles || []).find((entry) => entry.id === roleId);
  if (!role) {
    throw new Error(`Unknown model role '${roleId}'; valid: ${(registry.modelRoles || []).map((r) => r.id).join(', ')}`);
  }
  const excluded = new Set(exclude);
  const candidates = [];
  for (const [index, provider] of (registry.modelProviders || []).entries()) {
    if (excluded.has(provider.id)) continue;
    const tiers = provider.tiers ?? [];
    candidates.push({
      id: provider.id,
      kind: provider.kind,
      displayName: provider.displayName,
      backendCli: BACKEND_CLI[provider.id] ?? null,
      available: isAvailable ? Boolean(isAvailable(provider.id)) : null,
      servesPreferredTier: role.prefer ? tiers.includes(role.prefer) : null,
      servesFallbackTier: role.fallback ? tiers.includes(role.fallback) : null,
      _index: index,
    });
  }
  const rank = (candidate) => [
    candidate.available === true ? 0 : candidate.available === false ? 1 : 2,
    candidate.servesPreferredTier ? 0 : 1,
    candidate.servesFallbackTier ? 0 : 1,
    candidate._index,
  ];
  candidates.sort((a, b) => {
    const ra = rank(a); const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  for (const candidate of candidates) delete candidate._index;
  return {
    roleId,
    policy: { prefer: role.prefer ?? null, fallback: role.fallback ?? null, require: role.require ?? null },
    candidates,
    excluded: [...excluded],
  };
}

/** CLI handler for `doflow model-role`. Read-only advisory routing; exits 1 on an unknown role
 * because a silently-empty candidate list would read as "no providers" rather than "bad input". */
function handleModelRoleCommand({ role, exclude, json = false, repoRoot } = {}) {
  if (!role) return usageError('model-role', '--role is required (one of the roles in core/registry/models.yaml)', json);
  const registry = (() => {
    try { return loadRegistry({ repoRoot: repoRoot || REPO_ROOT }); }
    catch (error) { console.error(`[ERROR] model-role: ${error.message}`); return finishRuntime(1); }
  })();
  if (!registry) return undefined;
  const available = new Set(availableProviderIds());
  try {
    const resolution = resolveModelRole({
      registry,
      roleId: role,
      isAvailable: (providerId) => available.has(providerId),
      exclude: Array.isArray(exclude) ? exclude : String(exclude ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    });
    if (json) console.log(JSON.stringify(resolution, null, 2));
    else {
      console.log(`Role '${resolution.roleId}' — prefer:${resolution.policy.prefer ?? '—'} fallback:${resolution.policy.fallback ?? '—'} require:${resolution.policy.require ?? '—'}`);
      for (const candidate of resolution.candidates) {
        const availability = candidate.available === null ? '?' : candidate.available ? 'yes' : 'no';
        console.log(`  ${candidate.available ? '*' : ' '} ${candidate.id} (${candidate.kind}, via ${candidate.backendCli ?? 'hosted'}) available=${availability}${resolution.policy.prefer && candidate.servesPreferredTier ? ` serves ${resolution.policy.prefer}` : ''}`);
      }
      if (resolution.excluded.length) console.log(`Excluded: ${resolution.excluded.join(', ')}`);
    }
    return finishRuntime(0);
  } catch (error) {
    console.error(`[ERROR] model-role: ${error.message}`);
    return finishRuntime(1);
  }
}

module.exports = { resolveModelRole, handleModelRoleCommand, availableProviderIds, BACKEND_CLI };
