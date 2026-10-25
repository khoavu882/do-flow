'use strict';

const { readCatalogue, writeCatalogue, syncHarness, syncAllHarnesses } = require('./catalogue.ts');
const { readAllowedModels } = require('../worker/models.ts');
const { finishRuntime, usageError } = require('../cli-result.ts');
const { HARNESS_IDS } = require('../worker/probes/index.ts');

async function handleModelsCommand({
  action,
  actionGiven,
  positional,
  harness,
  model,
  json = false,
  projectRoot = process.cwd(),
  env = process.env,
}: any): Promise<number> {
  const act = actionGiven ? action : (action || (positional && positional[0]) || 'list');

  if (act === 'sync') {
    if (harness) {
      if (!HARNESS_IDS.includes(harness)) {
        return usageError('models', `unknown harness '${harness}'; expected one of: ${HARNESS_IDS.join(', ')}`, json);
      }
      const res = await syncHarness(harness, { projectRoot });
      const catalogue = readCatalogue(projectRoot) || {
        version: 1,
        syncedAt: new Date().toISOString(),
        harnesses: {},
      };
      catalogue.harnesses[harness] = res;
      catalogue.syncedAt = new Date().toISOString();
      writeCatalogue(catalogue, projectRoot);

      if (json) {
        console.log(JSON.stringify(res, null, 2));
      } else {
        const hint = res.loginState === 'logged-out' && res.reloginHint ? ` (re-login: ${res.reloginHint})` : '';
        console.log(`Synced harness '${harness}': ${res.loginState}${hint}, mode: ${res.detectedMode}, billing: ${res.derivedBilling}, models: ${res.offeredModels.length}`);
      }
      return finishRuntime(0);
    }

    const catalogue = await syncAllHarnesses({ projectRoot });
    if (json) {
      console.log(JSON.stringify(catalogue, null, 2));
    } else {
      console.log(`Synced ${Object.keys(catalogue.harnesses).length} harness(es) at ${catalogue.syncedAt}`);
      for (const [id, h] of Object.entries(catalogue.harnesses)) {
        const hint = h.loginState === 'logged-out' && h.reloginHint ? ` (re-login: ${h.reloginHint})` : '';
        console.log(`  ${id.padEnd(14)} ${h.loginState.padEnd(12)} mode: ${h.detectedMode.padEnd(14)} billing: ${h.derivedBilling.padEnd(9)} models: ${h.offeredModels.length}${hint}`);
      }
    }
    return finishRuntime(0);
  }

  if (act === 'list') {
    const catalogue = readCatalogue(projectRoot);
    const allowed = readAllowedModels({ env, projectRoot }) || [];
    const rows: any[] = [];

    if (catalogue && catalogue.harnesses) {
      for (const [harnessId, h] of Object.entries(catalogue.harnesses)) {
        for (const m of h.offeredModels || []) {
          rows.push({
            harness: harnessId,
            model: m.id,
            displayName: m.displayName || m.id,
            loginState: h.loginState,
            status: allowed.includes(m.id) ? 'enabled' : 'listed',
          });
        }
      }
    }

    if (rows.length === 0) {
      if (json) console.log(JSON.stringify({ models: [] }, null, 2));
      else console.log('No observed models. Run `doflow models --action sync` to probe worker pool.');
      return finishRuntime(0);
    }

    if (json) {
      console.log(JSON.stringify(rows, null, 2));
    } else {
      console.log(`Observed Models (${rows.length}):`);
      console.log(`  ${'HARNESS'.padEnd(14)} ${'MODEL'.padEnd(28)} ${'LOGIN'.padEnd(12)} ${'STATUS'}`);
      for (const row of rows) {
        console.log(`  ${row.harness.padEnd(14)} ${row.model.padEnd(28)} ${row.loginState.padEnd(12)} ${row.status}`);
      }
    }
    return finishRuntime(0);
  }

  if (act === 'describe') {
    if (!model || typeof model !== 'string') {
      return usageError('models', '--model <id> is required for describe action', json);
    }

    const catalogue = readCatalogue(projectRoot);
    const allowed = readAllowedModels({ env, projectRoot }) || [];
    const matchingHarnesses: any[] = [];
    let modelMeta: any = null;

    if (catalogue && catalogue.harnesses) {
      for (const [harnessId, h] of Object.entries(catalogue.harnesses)) {
        const found = (h.offeredModels || []).find((m: any) => m.id === model);
        if (found) {
          if (!modelMeta) modelMeta = found;
          matchingHarnesses.push({
            harnessId,
            loginState: h.loginState,
            detectedMode: h.detectedMode,
            derivedBilling: h.derivedBilling,
          });
        }
      }
    }

    if (matchingHarnesses.length === 0) {
      if (json) {
        console.log(JSON.stringify({ error: 'not-found', model }, null, 2));
      } else {
        console.error(`doflow models: model '${model}' not found in observed catalogue. Run 'doflow models --action sync' to refresh.`);
      }
      return finishRuntime(1);
    }

    const detail = {
      model,
      displayName: modelMeta?.displayName || model,
      family: modelMeta?.family || 'unknown',
      status: allowed.includes(model) ? 'enabled' : 'listed',
      harnesses: matchingHarnesses,
    };

    if (json) {
      console.log(JSON.stringify(detail, null, 2));
    } else {
      console.log(`Model: ${detail.model} (${detail.displayName})`);
      console.log(`  Family: ${detail.family}`);
      console.log(`  Status: ${detail.status}`);
      console.log('  Offering Harnesses:');
      for (const h of detail.harnesses) {
        console.log(`    - ${h.harnessId}: ${h.loginState} (mode: ${h.detectedMode}, billing: ${h.derivedBilling})`);
      }
    }
    return finishRuntime(0);
  }

  return usageError('models', `unknown action '${act}'; expected sync, list, or describe`, json);
}

module.exports = { handleModelsCommand };
