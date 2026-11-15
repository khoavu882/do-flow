'use strict';

const { readCatalogue, writeCatalogue, syncHarness, syncAllHarnesses, workerIds } = require('./catalogue.ts');
const { readAllowedModels, ORCHESTRATOR_KEY } = require('../worker/models.ts');
const { finishRuntime, usageError } = require('../cli-result.ts');
const { validateValue } = require('../settings/files.ts');
const { tierView, shown, slotsOf } = require('./tier-view.ts');
const { changeBinding, closestIds } = require('./bind.ts');
const { LIST_MAX_MODELS } = require('./list-models.ts');
const { inWorkerSession } = require('../context/identity.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const BIND_USAGE = 'models --action bind --harness <id> --tier <light|standard|frontier|orchestrator> [--model <id>] [--allow-unlisted]';
const UNBIND_USAGE = 'models --action unbind --harness <id> --tier <light|standard|frontier|orchestrator>';

/** The one-line source note shown beside a resolved model. */
const SOURCE_NOTE: Record<string, string> = {
  binding: 'bound', 'main-session': 'main session', 'frontier-binding': 'frontier binding', 'harness-default': 'harness default', invalid: 'binding unreadable',
};

/** A suffix for a sync line saying how the harness's model list was read, when it was not simply listed. */
function listNote(h: any): string {
  if (h.modelList?.status === 'failed') return ` [model list not refreshed: ${h.modelList.reason}${h.modelList.stale ? '; the last list is kept and stale' : ''}]`;
  if (h.modelList?.status === 'none-recorded') return ' [no model listing command is recorded; type the id when binding]';
  const cut = [h.modelList?.dropped ? `${h.modelList.dropped} ids that are not usable model ids left out` : '', h.modelList?.capped ? `the list was cut at its first ${LIST_MAX_MODELS} ids` : ''].filter(Boolean);
  return cut.length ? ` [${cut.join('; ')}]` : '';
}

/** A numbered pick from the harness's own list, on a terminal. Returns the id, or null when nothing valid was chosen. */
function pickFrom(models: any[], ask: (message: string) => string): string | null {
  models.forEach((m, i) => console.log(`  ${String(i + 1).padStart(3)}  ${m.id}${m.displayName && m.displayName !== m.id ? `  (${m.displayName})` : ''}`));
  const answer = ask(`Choose 1-${models.length}: `).trim();
  const index = Number(answer);
  return Number.isInteger(index) && index >= 1 && index <= models.length ? models[index - 1].id : null;
}

/** bind and unbind change the user's own model choices: a worker session does not run them. */
function refuseWorkerSession(act: string, json: any): number {
  const message = `${act} changes the user's model settings and is not run from a worker session; a person runs it from their own terminal`;
  if (json) console.log(JSON.stringify({ ok: false, error: 'worker-session', message }, null, 2));
  else console.error(`doflow models: ${message}`);
  return finishRuntime(1);
}

async function handleBind({ act, harness, tier, model, allowUnlisted, json, projectRoot, env, interactive, ask, syncOptions }: any): Promise<number> {
  const usage = act === 'bind' ? BIND_USAGE : UNBIND_USAGE;
  if (inWorkerSession(env)) return refuseWorkerSession(act, json);
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const slots = [...slotsOf(registry), ORCHESTRATOR_KEY];
  if (!harness || !tier) return usageError('models', `--harness and --tier are required; usage: ${usage}`, json);
  const known = workerIds({ registry, env, projectRoot, view: syncOptions.view });
  if (!known.includes(harness)) return usageError('models', `unknown harness '${harness}'; expected one of: ${known.join(', ')}`, json);
  if (!slots.includes(tier)) return usageError('models', `unknown tier '${tier}'; expected one of: ${slots.join(', ')}`, json);

  let chosen: string | null = null;
  let checked = 'unchecked';
  if (act === 'bind') {
    chosen = typeof model === 'string' && model !== '' ? model : null;
    if (chosen === null) {
      if (!interactive) return usageError('models', `--model is required without a terminal; usage: ${usage}`, json);
      const res = await syncHarness(harness, { ...syncOptions, projectRoot, env, previous: readCatalogue(projectRoot)?.harnesses?.[harness] ?? null });
      const catalogue = readCatalogue(projectRoot) || { version: 1, syncedAt: new Date().toISOString(), harnesses: {} };
      catalogue.harnesses[harness] = res;
      catalogue.syncedAt = new Date().toISOString();
      writeCatalogue(catalogue, projectRoot);
      if (res.offeredModels.length === 0) {
        const why = res.modelList?.reason ? ` (${res.modelList.reason})` : '';
        return usageError('models', `${harness} gave no model list${why}; pass --model <id> to type the id yourself`, json);
      }
      if (res.modelList?.status === 'failed') console.error(`note: the list could not be refreshed (${res.modelList.reason}); showing the last list`);
      chosen = pickFrom(res.offeredModels, ask);
      if (chosen === null) return usageError('models', 'no valid choice made; nothing was written', json);
      checked = 'listed';
    } else {
      const fault = validateValue({ type: 'model-id' }, chosen);
      if (fault) return usageError('models', `--model ${fault.reason}`, json);
      const entry = readCatalogue(projectRoot)?.harnesses?.[harness];
      const ids = (entry?.offeredModels || []).map((m: any) => m.id);
      if (ids.length > 0) {
        if (ids.includes(chosen)) checked = 'listed';
        else if (allowUnlisted) checked = 'unlisted-allowed';
        else {
          const near = closestIds(chosen, ids);
          const message = `'${chosen}' is not in ${harness}'s model list${entry?.modelList?.stale ? ' (the last list; it could not be refreshed)' : ''}; closest: ${near.join(', ')}; pass --allow-unlisted to bind it anyway`;
          if (json) console.log(JSON.stringify({ ok: false, error: 'unlisted-model', message, closest: near }, null, 2));
          else console.error(`doflow models: ${message}`);
          return finishRuntime(1);
        }
      }
    }
  }

  const done = changeBinding({ harness, slot: tier, model: chosen, env });
  if (!done.ok) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'write-failed', message: done.detail }, null, 2));
    else console.error(`doflow models: ${done.detail}`);
    return finishRuntime(1);
  }
  if (json) {
    console.log(JSON.stringify({ ok: true, action: act, harness, tier, model: chosen, checked, changed: done.changed, file: done.file }, null, 2));
  } else if (act === 'bind') {
    const note = checked === 'unchecked' ? ' (not checked: no synced model list for this harness)'
      : checked === 'unlisted-allowed' ? ' (not in the list; --allow-unlisted)' : '';
    console.log(`Bound ${harness} ${tier} = ${chosen}${note} (wrote ${done.file}).`);
  } else {
    console.log(done.changed ? `Unbound ${harness} ${tier}: it now uses ${tier === ORCHESTRATOR_KEY ? 'the main session or frontier binding' : 'the harness default'} (wrote ${done.file}).` : `${harness} ${tier} was not bound; nothing written.`);
  }
  return finishRuntime(0);
}

/** `models --action list`: the model each tier and the orchestrator get on every installed harness, then the observed models. */
function handleList({ json, projectRoot, env, syncOptions = {} }: any): number {
  const catalogue = readCatalogue(projectRoot);
  const registry = loadRegistry({ repoRoot: REPO_ROOT });
  const view = tierView({ registry, env, projectRoot, catalogue, view: syncOptions.view });
  const allowed = readAllowedModels({ env, projectRoot }) || [];
  const models: any[] = [];
  for (const [harnessId, h] of Object.entries<any>(catalogue?.harnesses || {})) {
    for (const m of h.offeredModels || []) {
      models.push({ harness: harnessId, model: m.id, displayName: m.displayName || m.id, loginState: h.loginState, status: allowed.includes(m.id) ? 'enabled' : 'listed' });
    }
  }
  const harnesses = view.harnesses;
  if (json) {
    console.log(JSON.stringify({ primary: view.primary, bindings: view.bindings, harnesses, models }, null, 2));
    return finishRuntime(0);
  }
  const primary = view.primary && view.primary.harness ? `${view.primary.harness}${view.primary.model ? ` running ${view.primary.model}` : ''} (${view.primary.state})` : 'unknown';
  console.log(`Model per tier on each installed or bound harness (bind with \`doflow models --action bind\`; "harness default" means nothing is forced). Main session: ${primary}.`);
  if (view.bindings.state === 'invalid') console.log(`  workers.models is unreadable (${view.bindings.reason}); every tier reads as the harness default.`);
  if (harnesses.length === 0) console.log('  No installed harness found.');
  for (const h of harnesses) {
    const tiers = slotsOf(registry).map((tier: string) => `${tier}=${shown(h[tier], view.bindings.state)}`).join('  ');
    console.log(`  ${h.harness.padEnd(12)} ${tiers}  orchestrator=${shown(h.orchestrator, h.orchestratorSource)} (${SOURCE_NOTE[h.orchestratorSource] ?? h.orchestratorSource})`);
  }
  if (models.length > 0) {
    console.log(`Observed Models (${models.length}):`);
    console.log(`  ${'HARNESS'.padEnd(14)} ${'MODEL'.padEnd(28)} ${'LOGIN'.padEnd(12)} ${'STATUS'}`);
    for (const row of models) console.log(`  ${row.harness.padEnd(14)} ${row.model.padEnd(28)} ${row.loginState.padEnd(12)} ${row.status}`);
  } else {
    console.log('No observed models. Run `doflow models --action sync` to read each harness\'s own model list.');
  }
  return finishRuntime(0);
}

async function handleModelsCommand({
  action,
  actionGiven,
  positional,
  harness,
  model,
  tier,
  allowUnlisted = false,
  json = false,
  projectRoot = process.cwd(),
  env = process.env,
  interactive = Boolean(process.stdin.isTTY) && Boolean(process.stdout.isTTY),
  ask = (message: string) => require('../../helper/prompt.ts').promptLine(message),
  syncOptions = {}, // test seam: execFileImpl / listExecImpl for the probes and the listing command, view (package view) for the worker list
}: any): Promise<number> {
  const act = actionGiven ? action : (action || (positional && positional[0]) || 'list');

  if (act === 'sync') {
    if (harness) {
      const known = workerIds({ env, projectRoot, view: syncOptions.view });
      if (!known.includes(harness)) {
        return usageError('models', `unknown harness '${harness}'; expected one of: ${known.join(', ')}`, json);
      }
      const before = readCatalogue(projectRoot);
      const res = await syncHarness(harness, { ...syncOptions, projectRoot, env, previous: before?.harnesses?.[harness] ?? null });
      const catalogue = before || {
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
        console.log(`Synced harness '${harness}': ${res.loginState}${hint}, mode: ${res.detectedMode}, billing: ${res.derivedBilling}, models: ${res.offeredModels.length}${listNote(res)}`);
      }
      return finishRuntime(0);
    }

    const catalogue = await syncAllHarnesses({ ...syncOptions, projectRoot, env });
    if (json) {
      console.log(JSON.stringify(catalogue, null, 2));
    } else {
      console.log(`Synced ${Object.keys(catalogue.harnesses).length} harness(es) at ${catalogue.syncedAt}`);
      for (const [id, h] of Object.entries(catalogue.harnesses)) {
        const hint = h.loginState === 'logged-out' && h.reloginHint ? ` (re-login: ${h.reloginHint})` : '';
        console.log(`  ${id.padEnd(14)} ${h.loginState.padEnd(12)} mode: ${h.detectedMode.padEnd(14)} billing: ${h.derivedBilling.padEnd(9)} models: ${h.offeredModels.length}${hint}${listNote(h)}`);
      }
    }
    return finishRuntime(0);
  }

  if (act === 'list') return handleList({ json, projectRoot, env, syncOptions });

  if (act === 'bind' || act === 'unbind') {
    return handleBind({ act, harness, tier, model, allowUnlisted, json, projectRoot, env, interactive, ask, syncOptions });
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

  return usageError('models', `unknown action '${act}'; expected sync, list, describe, bind, or unbind`, json);
}

module.exports = { handleModelsCommand };
