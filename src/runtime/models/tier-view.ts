'use strict';

// The one read of "which model does each tier, and the orchestrator, get on each harness": shared by
// `doflow models --action list` and `doflow rules`. Reads settings, the registry and, for the main
// session's model, `resolvePrimary` (settings and observation files). Starts no process.

const { readBindings, resolveBinding, resolveOrchestratorModel } = require('../worker/models.ts');

/** The tier slots shown per harness, then the orchestrator role. */
function slotsOf(registry: any): string[] {
  return registry.dispatchTiers?.tiers ?? ['light', 'standard', 'frontier'];
}

/** True when the harness's binary is on PATH (no process started). */
function onPath(worker: any, env: any): boolean {
  const binary = worker?.cli?.binary;
  if (typeof binary !== 'string') return false;
  try { return require('../worker/readiness.ts').findOnPath(binary, env) !== null; } catch { return false; }
}

/** `{ primary, bindings, harnesses }`: each installed built-in harness (and any with a binding, installed or not) as
 * `{ harness, <tier>: id|null ..., orchestrator: id|null, orchestratorSource }` (`null` is the harness default;
 * `unresolved:<reason>` when `workers.models` cannot be read).
 * `catalogue` marks installed from a sync too. */
function tierView({ registry, env = process.env, projectRoot = null, primary: given, catalogue = null, view = undefined }: any): any {
  const bindings = readBindings({ env, projectRoot: null });
  let primary = given;
  if (primary === undefined) {
    try { primary = require('../context/primary.ts').resolvePrimary({ env, projectRoot: projectRoot ?? process.cwd(), registry }); }
    catch { primary = null; }
  }
  const tiers = slotsOf(registry);
  // `null` means the harness default, so an unreadable binding setting must not read as one.
  const unresolved = `unresolved:${bindings.reason ?? 'invalid'}`;
  const { workerEntries } = require('./catalogue.ts');
  const harnesses = workerEntries({ registry, env, projectRoot, view }).flatMap((entry: any) => {
    const descriptor = entry.worker;
    const installed = catalogue?.harnesses?.[entry.id]?.installed === true || onPath(descriptor, env);
    const bound = bindings.state === 'set' && Object.hasOwn(bindings.map ?? {}, entry.id);
    if (!installed && !bound) return [];
    const row: any = { harness: entry.id };
    for (const tier of tiers) {
      const resolved = resolveBinding({ worker: entry.id, tier, bindings, descriptor });
      row[tier] = resolved.source === 'invalid' ? unresolved : resolved.source === 'binding' ? resolved.model : null;
    }
    const orchestrator = resolveOrchestratorModel({ harness: entry.id, bindings, primary, descriptor });
    return [{ ...row, orchestrator: orchestrator.source === 'invalid' ? unresolved : orchestrator.model, orchestratorSource: orchestrator.source }];
  });
  return {
    bindings: { state: bindings.state, reason: bindings.reason },
    primary: primary ? { harness: primary.harness ?? null, model: primary.model ?? null, state: primary.state ?? 'unknown' } : null,
    harnesses,
  };
}

/** A model id or `harness default`; `unresolved` when the binding setting cannot be read. */
const shown = (model: string | null, source = 'binding') => (source === 'invalid' ? 'unresolved' : model ?? 'harness default');

module.exports = { tierView, shown, slotsOf };
