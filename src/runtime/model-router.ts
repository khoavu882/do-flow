'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Model role router. DoFlow binds no model for the harness's own work; the runtime calls a
// configured local decision model only for advisory picks. This resolves an abstract role from
// core/registry/models.json into availability-annotated provider candidates that skills,
// orchestration snapshots, or operators act on through each harness's native model selection.
// Policy strings (prefer/fallback/require) pass through verbatim — the registry owns them; this
// module owns matching them against providers' declared tiers and what is installed right now.

const fs = require('node:fs');
const path = require('node:path');
const { loadRegistry } = require('../registry/index.ts');
const { finishRuntime, usageError, captureCaught } = require('./cli-result.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');

/** The machine-level command each provider's backend answers to. A provider without a local CLI
 * (hosted-only access through another harness) reports backendCli null and is never "available". */
const BACKEND_CLI: Readonly<Record<string, string>> = Object.freeze({ claude: 'claude', codex: 'codex', copilot: 'copilot', ollama: 'ollama' });

function whichLike(command: string | undefined, { fsImpl = fs, pathEnv = process.env.PATH }: { fsImpl?: any; pathEnv?: string } = {}): boolean {
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
function availableProviderIds({ fsImpl = fs }: { fsImpl?: any } = {}): string[] {
  return Object.entries(BACKEND_CLI)
    .filter(([, cli]) => whichLike(cli, { fsImpl }))
    .map(([id]) => id);
}

function normalizeFamilyList(value: any): string[] {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.flatMap((entry) => String(entry ?? '').split(',').map((family) => family.trim().toLowerCase()).filter(Boolean)))];
}

// families is a hand-kept stopgap; the model-facts registry (roadmap row 105) supersedes it and this field is removed then.
/** An unknown family is not evidence that a provider can review outside the author's family. */
function familyInfo(families: any, excludedFamilies: Set<string>): { families: string[], familyVerified: boolean, familyRelation: string, sameFamily: boolean } {
  const declared = Array.isArray(families) ? families : [];
  const hasUnknown = declared.length === 0
    || declared.some((family) => typeof family !== 'string' || !/^[a-z][a-z0-9-]*$/.test(family) || family === 'unknown');
  const overlapsAuthor = declared.some((family) => typeof family === 'string'
    && family !== 'unknown' && /^[a-z][a-z0-9-]*$/.test(family) && excludedFamilies.has(family));
  const familyRelation = overlapsAuthor ? 'overlaps-author' : hasUnknown ? 'unverified' : 'cross-family';
  const sameFamily = declared.length > 0 && declared.every((family) => typeof family === 'string' && excludedFamilies.has(family));
  return {
    families: [...declared],
    familyVerified: familyRelation === 'cross-family',
    familyRelation,
    sameFamily,
  };
}

/**
 * Resolve one role to ranked candidates.
 * Ordering: available first, then preferred-tier match, then fallback-tier match, registry order
 * breaking ties. `exclude` drops provider ids entirely; `excludeFamilies` drops providers whose
 * complete, known catalogue is within the excluded model families. Unknown catalogues are kept
 * unverified rather than being presented as cross-family.
 * Availability unknown stays null — absence of evidence is not reported as absent.
 */
function resolveModelRole({ registry, roleId, isAvailable = null, exclude = [], excludeFamilies }: any = {}): any {
  const role = (registry.modelRoles || []).find((entry: any) => entry.id === roleId);
  if (!role) {
    throw new Error(`Unknown model role '${roleId}'; valid: ${(registry.modelRoles || []).map((r: any) => r.id).join(', ')}`);
  }
  const excluded = new Set(exclude);
  const familyMode = excludeFamilies !== undefined && excludeFamilies !== null;
  const normalizedFamilies = familyMode ? normalizeFamilyList(excludeFamilies) : [];
  if (familyMode && normalizedFamilies.length === 0) {
    throw new Error('--exclude-family requires at least one family name');
  }
  const excludedFamilies = new Set(normalizedFamilies);
  const candidates: any[] = [];
  const familyExcluded: string[] = [];
  for (const [index, provider] of (registry.modelProviders || []).entries()) {
    if (excluded.has(provider.id)) continue;
    const family = familyInfo(provider.families, excludedFamilies);
    if (familyMode && family.sameFamily) {
      familyExcluded.push(provider.id);
      continue;
    }
    const tiers = provider.tiers ?? [];
    candidates.push({
      id: provider.id,
      kind: provider.kind,
      displayName: provider.displayName,
      backendCli: BACKEND_CLI[provider.id] ?? null,
      available: isAvailable ? Boolean(isAvailable(provider.id)) : null,
      servesPreferredTier: role.prefer ? tiers.includes(role.prefer) : null,
      servesFallbackTier: role.fallback ? tiers.includes(role.fallback) : null,
      ...(familyMode ? { families: family.families, familyRelation: family.familyRelation, familyVerified: family.familyVerified } : {}),
      _index: index,
    });
  }
  const rank = (candidate: any): number[] => [
    candidate.available === true ? 0 : candidate.available === false ? 1 : 2,
    candidate.servesPreferredTier ? 0 : 1,
    candidate.servesFallbackTier ? 0 : 1,
    candidate._index,
  ];
  candidates.sort((a: any, b: any) => {
    const ra = rank(a); const rb = rank(b);
    for (let i = 0; i < ra.length; i += 1) if (ra[i] !== rb[i]) return ra[i] - rb[i];
    return 0;
  });
  for (const candidate of candidates) delete candidate._index;
  const result: any = {
    roleId,
    policy: { prefer: role.prefer ?? null, fallback: role.fallback ?? null, require: role.require ?? null },
    candidates,
    excluded: [...excluded],
  };
  // Keep the established result shape byte-for-byte for callers that do not request family
  // filtering. Family metadata is included whenever that comparison is requested.
  if (familyMode) {
    result.excludedFamilies = [...excludedFamilies];
    result.familyExcluded = familyExcluded;
  }
  return result;
}

/**
 * Resolve one optional dense/rerank retrieval slot from core/registry/models.json. A slot binds a
 * retrieval stage (`dense` embedding lookup, `rerank` cross-encoder pass) to one declared provider
 * and the concrete model that provider serves; it takes effect only while `enabled`. Absent or
 * disabled slots resolve to `{active:false}` and every caller stays on its existing lexical/graph
 * path unchanged — this function never routes anywhere on its own. An enabled slot resolves to the
 * bound provider with availability probed through the same injected seam resolveModelRole uses
 * (PATH scan for the provider's backend CLI); `available:false` or `null` tells the caller to stay
 * lexical rather than guess. Unknown slot ids also resolve to `{active:false}` rather than
 * throwing: absence of a slot is every install's normal state, unlike an unknown role.
 */
function resolveRetrievalSlot({ registry, slotId, isAvailable = null }: any = {}): any {
  const slot = (registry.retrievalSlots || []).find((entry: any) => entry.id === slotId);
  if (!slot || !slot.enabled) return { slotId, active: false, reason: slot ? 'disabled' : 'undeclared' };
  const provider = (registry.modelProviders || []).find((entry: any) => entry.id === slot.provider);
  if (!provider) return { slotId, active: false, reason: 'provider-missing' };
  return {
    slotId,
    active: true,
    reason: null,
    provider: provider.id,
    displayName: provider.displayName,
    kind: provider.kind,
    backendCli: BACKEND_CLI[provider.id] ?? null,
    model: slot.model,
    available: isAvailable ? Boolean(isAvailable(provider.id)) : null,
  };
}

/** CLI handler for `doflow model-role`. Read-only advisory routing; exits 1 on an unknown role
 * because a silently-empty candidate list would read as "no providers" rather than "bad input". */
function handleModelRoleCommand({ role, exclude, excludeFamilies, json = false, repoRoot }: any = {}): number | undefined {
  if (!role) return usageError('model-role', '--role is required (one of the roles in core/registry/models.json)', json);
  const registry = (() => {
    try { return loadRegistry({ repoRoot: repoRoot || REPO_ROOT }); }
    catch (error: any) { captureCaught(error, 'model-role', 1); console.error(`[ERROR] model-role: ${error.message}`); return finishRuntime(1); }
  })();
  if (!registry) return undefined;
  const available = new Set(availableProviderIds());
  try {
    const excludedProviderIds = Array.isArray(exclude) ? exclude : String(exclude ?? '').split(',').map((s: string) => s.trim()).filter(Boolean);
    const requestedFamilies = excludeFamilies === undefined || excludeFamilies === null ? null : normalizeFamilyList(excludeFamilies);
    if (requestedFamilies !== null) {
      const knownFamilies = [...new Set((registry.modelProviders || []).flatMap((provider: any) => provider.families || []))]
        .filter((family): family is string => typeof family === 'string' && family !== 'unknown').sort();
      const knownSet = new Set(knownFamilies);
      const unknownFamilies = requestedFamilies.filter((family) => !knownSet.has(family));
      if (requestedFamilies.length === 0) {
        return usageError('model-role', `--exclude-family requires at least one family name; known families: ${knownFamilies.join(', ') || '(none)'}`, json);
      }
      if (requestedFamilies.includes('unknown')) {
        return usageError('model-role', `unknown cannot be excluded because it names missing knowledge; known families: ${knownFamilies.join(', ') || '(none)'}`, json);
      }
      if (unknownFamilies.length) {
        return usageError('model-role', `unknown family name${unknownFamilies.length === 1 ? '' : 's'}: ${unknownFamilies.join(', ')}; known families: ${knownFamilies.join(', ') || '(none)'}`, json);
      }
    }
    const resolution = resolveModelRole({
      registry,
      roleId: role,
      isAvailable: (providerId: string) => available.has(providerId),
      exclude: excludedProviderIds,
      ...(requestedFamilies === null ? {} : { excludeFamilies: requestedFamilies }),
    });
    if (json) console.log(JSON.stringify(resolution, null, 2));
    else {
      console.log(`Role '${resolution.roleId}' — prefer:${resolution.policy.prefer ?? '—'} fallback:${resolution.policy.fallback ?? '—'} require:${resolution.policy.require ?? '—'}`);
      for (const candidate of resolution.candidates) {
        const availability = candidate.available === null ? '?' : candidate.available ? 'yes' : 'no';
        const familyStatus = requestedFamilies === null ? ''
          : ` ${candidate.familyRelation}`;
        console.log(`  ${candidate.available ? '*' : ' '} ${candidate.id} (${candidate.kind}, via ${candidate.backendCli ?? 'hosted'}) available=${availability}${resolution.policy.prefer && candidate.servesPreferredTier ? ` serves ${resolution.policy.prefer}` : ''}${familyStatus}`);
      }
      if (resolution.excluded.length) console.log(`Excluded: ${resolution.excluded.join(', ')}`);
      if (requestedFamilies !== null) {
        const familySet = new Set(requestedFamilies);
        const providerExcluded = new Set(excludedProviderIds);
        const sameFamily = (registry.modelProviders || []).filter((provider: any) => !providerExcluded.has(provider.id)
          && familyInfo(provider.families, familySet).sameFamily);
        for (const provider of sameFamily) console.log(`  ${provider.id} same-family (excluded)`);
        if (resolution.excludedFamilies.length) console.log(`Excluded families: ${resolution.excludedFamilies.join(', ')}`);
      }
    }
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'model-role', 1);
    console.error(`[ERROR] model-role: ${error.message}`);
    return finishRuntime(1);
  }
}

module.exports = { resolveModelRole, resolveRetrievalSlot, handleModelRoleCommand, availableProviderIds, BACKEND_CLI };
