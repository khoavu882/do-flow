'use strict';

// The one read of "which model does each tier, and the orchestrator, get on each harness": shared by
// `doflow models --action list` and `doflow rules`. Reads settings, the registry and, for the main
// session's model, `resolvePrimary` (settings and observation files). Starts no process.

const { readBindings, resolveBinding, resolveOrchestratorModel } = require('../worker/models.ts');
const { modelCheck, effortCheck } = require('../worker/model-choice.ts');
const { bindingCell } = require('./binding-text.ts');

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

/** 169 IC-005: the display cell of a bound choice on one harness: its model and effort checks, computed now (D10) from
 * the harness's catalogue entry (null for none), and `effortMayLower` from the descriptor's `effort.mayLower` (L-3). */
function cellFor(choice: any, descriptor: any, entry: any): any {
  const checks = { model: modelCheck(entry, choice, descriptor), effort: effortCheck(entry, choice, descriptor) };
  const effortMayLower = descriptor?.effort?.status === 'supported' && descriptor.effort.mayLower === true;
  return bindingCell(choice, checks, { effortMayLower });
}

/** `{ primary, bindings, harnesses }`: each installed built-in harness (and any with a binding, installed or not) as
 * `{ harness, <tier>: cell ..., orchestrator: cell, orchestratorSource }` where a cell is null (the harness default),
 * `unresolved:<reason>` (`workers.models` cannot be read) or the IC-005 object `{model, provider, effort, check}`.
 * `catalogue` marks installed from a sync too and supplies the checks; left out, it is read for `projectRoot`. */
function tierView({ registry, env = process.env, projectRoot = null, primary: given, catalogue, view = undefined }: any): any {
  const bindings = readBindings({ env, projectRoot: null });
  let primary = given;
  if (primary === undefined) {
    try { primary = require('../context/primary.ts').resolvePrimary({ env, projectRoot: projectRoot ?? process.cwd(), registry }); }
    catch { primary = null; }
  }
  const tiers = slotsOf(registry);
  const observed = catalogue === undefined ? require('./catalogue.ts').readCatalogue(projectRoot ?? undefined, { env }) : catalogue;
  // `null` means the harness default, so an unreadable binding setting must not read as one.
  const unresolved = `unresolved:${bindings.reason ?? 'invalid'}`;
  const { workerEntries } = require('./catalogue.ts');
  const harnesses = workerEntries({ registry, env, projectRoot, view }).flatMap((entry: any) => {
    const descriptor = entry.worker;
    const installed = catalogue?.harnesses?.[entry.id]?.installed === true || onPath(descriptor, env);
    const bound = bindings.state === 'set' && Object.hasOwn(bindings.map ?? {}, entry.id);
    if (!installed && !bound) return [];
    const listed = observed?.harnesses?.[entry.id] ?? null;
    const cellOf = (resolved: any) => (resolved.source === 'invalid' ? unresolved : resolved.choice ? cellFor(resolved.choice, descriptor, listed) : null);
    const row: any = { harness: entry.id };
    for (const tier of tiers) row[tier] = cellOf(resolveBinding({ worker: entry.id, tier, bindings, descriptor }));
    const orchestrator = resolveOrchestratorModel({ harness: entry.id, bindings, primary, descriptor });
    return [{ ...row, orchestrator: cellOf(orchestrator), orchestratorSource: orchestrator.source }];
  });
  return {
    bindings: { state: bindings.state, reason: bindings.reason },
    primary: primary ? { harness: primary.harness ?? null, model: primary.model ?? null, state: primary.state ?? 'unknown' } : null,
    harnesses,
  };
}

module.exports = { tierView, cellFor, slotsOf };
