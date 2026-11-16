'use strict';

const { readCatalogue, mergeCatalogueEntries, syncHarness, syncAllHarnesses, workerDescriptor, workerIds, workerEntries } = require('./catalogue.ts');
const { loginAnswers, loginCell } = require('../worker/login.ts');
const { readAllowedModels, ORCHESTRATOR_KEY } = require('../worker/models.ts');
const { finishRuntime, usageError } = require('../cli-result.ts');
const { validateValue } = require('../settings/files.ts');
const { tierView, cellFor, slotsOf } = require('./tier-view.ts');
const { bindingText } = require('./binding-text.ts');
const { changeBinding, closestIds } = require('./bind.ts');
const { matchListed, modelCheck, effortCheck } = require('../worker/model-choice.ts');
const { PROVIDER_RE, EFFORT_RE } = require('../../registry/model-parts.ts');
const { LIST_MAX_MODELS } = require('./list-models.ts');
const { inWorkerSession } = require('../context/identity.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const BIND_USAGE = 'models --action bind --harness <id> --tier <light|standard|frontier|orchestrator> [--model <id>] [--provider <p>] [--effort <level>] [--allow-unlisted]';
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

/** Each worker's login answer by id, read from the `harness-login` store (172 IC-001; starts no process). The JSON key
 * `loginState` carries the answer's state. */
function loginById({ env, projectRoot, view }: any): Map<string, any> {
  return new Map(loginAnswers({ env, workers: workerEntries({ env, projectRoot, view }) }).map((answer: any) => [answer.harness, answer]));
}
const stateOf = (logins: Map<string, any>, id: string): string => logins.get(id)?.state ?? 'unknown';
const cellOf = (logins: Map<string, any>, id: string): string => (logins.has(id) ? loginCell(logins.get(id)) : 'unknown');

/** A numbered pick from the harness's own list, on a terminal. Returns the picked entry, or null when nothing valid was chosen. */
function pickFrom(models: any[], ask: (message: string) => string): any {
  models.forEach((m, i) => console.log(`  ${String(i + 1).padStart(3)}  ${m.id}${m.provider ? ` (provider ${m.provider})` : ''}${m.displayName && m.displayName !== m.id ? `  (${m.displayName})` : ''}`));
  const answer = ask(`Choose 1-${models.length}: `).trim();
  const index = Number(answer);
  return Number.isInteger(index) && index >= 1 && index <= models.length ? models[index - 1] : null;
}

/** The refusal of a bind: exit 1 with `{ok:false, error, message, ...extra}` (JSON) or the message on stderr. */
function refuseBind(json: any, error: string, message: string, extra: any = {}): number {
  if (json) console.log(JSON.stringify({ ok: false, error, message, ...extra }, null, 2));
  else console.error(`doflow models: ${message}`);
  return finishRuntime(1);
}

/** The refusal of a provider or effort the descriptor entry does not take (`unknown`, `unsupported` and an absent entry alike). */
function partRefusal(part: 'provider' | 'effort', entry: any, harness: string): { error: string; message: string } | null {
  if (entry?.status === 'supported') return null;
  const why = typeof entry?.reason === 'string' && entry.reason !== '' ? `: ${entry.reason}` : ' (no evidence is recorded for it)';
  return { error: `${part}-unsupported`, message: `${part} is not supported on ${harness}${why}` };
}

/** Numbers and flags of one catalogue entry as the PROVIDER, CONTEXT, MAX OUT, REASONING and IMAGES columns; `-` is not listed. */
const yesNo = (value: unknown): string => (value === undefined ? '-' : value ? 'yes' : 'no');
const columnsOf = (m: any): string[] => [m.provider ?? '-', m.contextTokens === undefined ? '-' : String(m.contextTokens), m.maxOutputTokens === undefined ? '-' : String(m.maxOutputTokens), yesNo(m.reasoning), yesNo(m.imageInput)];
const COLUMN_WIDTHS = [14, 8, 8, 10, 7];
const NOT_LISTED_FOOTER = '  - = not listed by the harness';
/** The listed fields of an entry beyond its id and name, and only those it has. */
const listedFields = (m: any): any => Object.fromEntries(['provider', 'contextTokens', 'maxOutputTokens', 'reasoning', 'imageInput', 'effortLevels'].filter((key) => m[key] !== undefined).map((key) => [key, m[key]]));

/** bind and unbind change the user's own model choices: a worker session does not run them. */
function refuseWorkerSession(act: string, json: any): number {
  const message = `${act} changes the user's model settings and is not run from a worker session; a person runs it from their own terminal`;
  if (json) console.log(JSON.stringify({ ok: false, error: 'worker-session', message }, null, 2));
  else console.error(`doflow models: ${message}`);
  return finishRuntime(1);
}

async function handleBind({ act, harness, tier, model, provider: givenProvider, effort: givenEffort, allowUnlisted, json, projectRoot, env, interactive, ask, syncOptions }: any): Promise<number> {
  const usage = act === 'bind' ? BIND_USAGE : UNBIND_USAGE;
  if (inWorkerSession(env)) return refuseWorkerSession(act, json);
  const registry = syncOptions.registry ?? loadRegistry({ repoRoot: REPO_ROOT });
  const slots = [...slotsOf(registry), ORCHESTRATOR_KEY];
  if (!harness || !tier) return usageError('models', `--harness and --tier are required; usage: ${usage}`, json);
  const known = workerIds({ registry, env, projectRoot, view: syncOptions.view });
  if (!known.includes(harness)) return usageError('models', `unknown harness '${harness}'; expected one of: ${known.join(', ')}`, json);
  if (!slots.includes(tier)) return usageError('models', `unknown tier '${tier}'; expected one of: ${slots.join(', ')}`, json);

  let value: any = null;
  let choice: any = null;
  let checked = 'unchecked';
  let cell: any = null;
  if (act === 'bind') {
    const provider = givenProvider === undefined ? null : givenProvider;
    const effort = givenEffort === undefined ? null : givenEffort;
    if (provider !== null && !PROVIDER_RE.test(provider)) return usageError('models', '--provider must start with a letter or digit and use only letters, digits, . _ - (at most 64 characters)', json);
    if (effort !== null && !EFFORT_RE.test(effort)) return usageError('models', '--effort must start with a letter or digit and use only letters, digits, . _ - (at most 32 characters)', json);
    const descriptor = workerDescriptor(harness, { registry, env, projectRoot, view: syncOptions.view });
    // The descriptor decides what a part may be before any model question (design 6.4 steps 2 and 3).
    for (const [part, given] of [['provider', provider], ['effort', effort]] as const) {
      const refusal = given === null ? null : partRefusal(part, descriptor?.[part], harness);
      if (refusal) return refuseBind(json, refusal.error, refusal.message);
    }
    const levels = descriptor?.effort?.levels;
    if (effort !== null && Array.isArray(levels) && !levels.includes(effort)) {
      return refuseBind(json, 'effort-unknown-level', `effort '${effort}' is not one of ${harness}'s levels: ${levels.join(', ')}`, { levels });
    }

    let entry = readCatalogue(projectRoot)?.harnesses?.[harness] ?? null;
    let chosen: string | null = typeof model === 'string' && model !== '' ? model : null;
    let chosenProvider: string | null = provider;
    if (chosen === null) {
      if (!interactive) return usageError('models', `--model is required without a terminal; usage: ${usage}`, json);
      const res = await syncHarness(harness, { ...syncOptions, projectRoot, env, previous: entry });
      mergeCatalogueEntries({ [harness]: res }, projectRoot);
      entry = res;
      if (res.offeredModels.length === 0) {
        const why = res.modelList?.reason ? ` (${res.modelList.reason})` : '';
        return usageError('models', `${harness} gave no model list${why}; pass --model <id> to type the id yourself`, json);
      }
      if (res.modelList?.status === 'failed') console.error(`note: the list could not be refreshed (${res.modelList.reason}); showing the last list`);
      const rows = provider === null ? res.offeredModels : res.offeredModels.filter((m: any) => m.provider === provider);
      if (rows.length === 0) return usageError('models', `${harness} lists no model under provider '${provider}'; nothing was written`, json);
      const picked = pickFrom(rows, ask);
      if (picked === null) return usageError('models', 'no valid choice made; nothing was written', json);
      chosen = picked.id;
      // A picked row's provider is written only where the harness takes one; otherwise the harness chooses.
      if (chosenProvider === null && typeof picked.provider === 'string' && descriptor?.provider?.status === 'supported') chosenProvider = picked.provider;
    } else {
      const fault = validateValue({ type: 'model-id' }, chosen);
      if (fault) return usageError('models', `--model ${fault.reason}`, json);
    }
    choice = { model: chosen, provider: chosenProvider, effort };
    const modelState = modelCheck(entry, choice, descriptor);
    if (modelState === 'several-providers') {
      const providers = [...new Set(matchListed(entry.offeredModels, choice, descriptor).map((m: any) => m.provider))];
      return refuseBind(json, 'ambiguous-model', `'${chosen}' is listed by several providers on ${harness} (${providers.join(', ')}); pass --provider <p> to choose one`, { providers });
    }
    if (modelState === 'not-listed') {
      if (!allowUnlisted) {
        const near = closestIds(chosen as string, [...new Set<string>(entry.offeredModels.map((m: any) => m.id))]);
        return refuseBind(json, 'unlisted-model', `'${chosen}' is not in ${harness}'s model list${entry?.modelList?.stale ? ' (the last list; it could not be refreshed)' : ''}; closest: ${near.join(', ')}; pass --allow-unlisted to bind it anyway`, { closest: near });
      }
      checked = 'unlisted-allowed';
    } else if (modelState === 'listed') checked = 'listed';
    cell = cellFor(choice, descriptor, entry);
    if (cell.check.effort === 'not-offered') {
      return refuseBind(json, 'effort-not-offered', `effort '${effort}' is not offered by '${chosen}' on ${harness} according to its model list; run \`doflow models --action sync\` to refresh the list`);
    }
    value = chosenProvider === null && effort === null ? chosen : { model: chosen, ...(chosenProvider !== null ? { provider: chosenProvider } : {}), ...(effort !== null ? { effort } : {}) };
  }

  const done = changeBinding({ harness, slot: tier, value, env });
  if (!done.ok) {
    if (json) console.log(JSON.stringify({ ok: false, error: 'write-failed', message: done.detail }, null, 2));
    else console.error(`doflow models: ${done.detail}`);
    return finishRuntime(1);
  }
  if (act === 'bind') {
    if (json) console.log(JSON.stringify({ ok: true, action: act, harness, tier, model: choice.model, provider: choice.provider, effort: choice.effort, checked, check: cell.check, changed: done.changed, file: done.file }, null, 2));
    else console.log(`Bound ${harness} ${tier} = ${bindingText(cell)} (wrote ${done.file}).`);
  } else if (json) {
    console.log(JSON.stringify({ ok: true, action: act, harness, tier, model: null, checked, changed: done.changed, file: done.file }, null, 2));
  } else {
    console.log(done.changed ? `Unbound ${harness} ${tier}: it now uses ${tier === ORCHESTRATOR_KEY ? 'the main session or frontier binding' : 'the harness default'} (wrote ${done.file}).` : `${harness} ${tier} was not bound; nothing written.`);
  }
  return finishRuntime(0);
}

/** `models --action list`: the model each tier and the orchestrator get on every installed harness, then the observed models. */
function handleList({ json, projectRoot, env, syncOptions = {} }: any): number {
  const catalogue = readCatalogue(projectRoot);
  const registry = syncOptions.registry ?? loadRegistry({ repoRoot: REPO_ROOT });
  const view = tierView({ registry, env, projectRoot, catalogue, view: syncOptions.view });
  const allowed = readAllowedModels({ env, projectRoot }) || [];
  const models: any[] = [];
  const logins = loginById({ env, projectRoot, view: syncOptions.view });
  for (const [harnessId, h] of Object.entries<any>(catalogue?.harnesses || {})) {
    for (const m of h.offeredModels || []) {
      models.push({ harness: harnessId, model: m.id, displayName: m.displayName || m.id, ...listedFields(m), loginState: stateOf(logins, harnessId), status: allowed.includes(m.id) ? 'enabled' : 'listed' });
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
    const tiers = slotsOf(registry).map((tier: string) => `${tier}=${bindingText(h[tier])}`).join('  ');
    console.log(`  ${h.harness.padEnd(12)} ${tiers}  orchestrator=${bindingText(h.orchestrator)} (${SOURCE_NOTE[h.orchestratorSource] ?? h.orchestratorSource})`);
  }
  if (models.length > 0) {
    console.log(`Observed Models (${models.length}):`);
    const head = ['PROVIDER', 'CONTEXT', 'MAX OUT', 'REASONING', 'IMAGES'].map((name, i) => name.padEnd(COLUMN_WIDTHS[i])).join(' ');
    console.log(`  ${'HARNESS'.padEnd(14)} ${'MODEL'.padEnd(28)} ${head} ${'LOGIN'.padEnd(12)} ${'STATUS'}`);
    for (const row of models) console.log(`  ${row.harness.padEnd(14)} ${row.model.padEnd(28)} ${columnsOf(row).map((cell, i) => cell.padEnd(COLUMN_WIDTHS[i])).join(' ')} ${row.loginState.padEnd(12)} ${row.status}`);
    console.log(NOT_LISTED_FOOTER);
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
  provider,
  effort,
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
      mergeCatalogueEntries({ [harness]: res }, projectRoot);
      const logins = loginById({ env, projectRoot, view: syncOptions.view });

      if (json) {
        console.log(JSON.stringify({ ...res, loginState: stateOf(logins, harness) }, null, 2));
      } else {
        console.log(`Synced harness '${harness}': ${cellOf(logins, harness)}, mode: ${res.detectedMode}, billing: ${res.derivedBilling}, models: ${res.offeredModels.length}${listNote(res)}`);
      }
      return finishRuntime(0);
    }

    const catalogue = await syncAllHarnesses({ ...syncOptions, projectRoot, env });
    const logins = loginById({ env, projectRoot, view: syncOptions.view });
    if (json) {
      const harnesses = Object.fromEntries(Object.entries<any>(catalogue.harnesses).map(([id, h]) => [id, { ...h, loginState: stateOf(logins, id) }]));
      console.log(JSON.stringify({ ...catalogue, harnesses }, null, 2));
    } else {
      console.log(`Synced ${Object.keys(catalogue.harnesses).length} harness(es) at ${catalogue.syncedAt}`);
      for (const [id, h] of Object.entries<any>(catalogue.harnesses)) {
        console.log(`  ${id.padEnd(14)} mode: ${h.detectedMode.padEnd(14)} billing: ${h.derivedBilling.padEnd(9)} models: ${h.offeredModels.length} login: ${cellOf(logins, id)}${listNote(h)}`);
      }
    }
    return finishRuntime(0);
  }

  if (act === 'list') return handleList({ json, projectRoot, env, syncOptions });

  if (act === 'bind' || act === 'unbind') {
    return handleBind({ act, harness, tier, model, provider, effort, allowUnlisted, json, projectRoot, env, interactive, ask, syncOptions });
  }

  if (act === 'describe') {
    if (!model || typeof model !== 'string') {
      return usageError('models', '--model <id> is required for describe action', json);
    }

    const catalogue = readCatalogue(projectRoot);
    const allowed = readAllowedModels({ env, projectRoot }) || [];
    const matchingHarnesses: any[] = [];
    let modelMeta: any = null;
    const logins = loginById({ env, projectRoot });
    const wanted = { model, provider: typeof provider === 'string' && provider !== '' ? provider : null, effort: null };

    if (catalogue && catalogue.harnesses) {
      for (const [harnessId, h] of Object.entries<any>(catalogue.harnesses)) {
        const found = matchListed(h.offeredModels || [], wanted, workerDescriptor(harnessId, { registry: syncOptions.registry, env, projectRoot, view: syncOptions.view }));
        if (found.length > 0) {
          if (!modelMeta) modelMeta = found[0];
          matchingHarnesses.push({
            harnessId,
            loginState: stateOf(logins, harnessId),
            detectedMode: h.detectedMode,
            derivedBilling: h.derivedBilling,
            offerings: found.map(listedFields),
          });
        }
      }
    }

    if (matchingHarnesses.length === 0) {
      if (json) {
        console.log(JSON.stringify({ error: 'not-found', model }, null, 2));
      } else {
        console.error(`doflow models: model '${model}'${wanted.provider ? ` under provider '${wanted.provider}'` : ''} not found in observed catalogue. Run 'doflow models --action sync' to refresh.`);
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
        console.log(`        ${['PROVIDER', 'CONTEXT', 'MAX OUT', 'REASONING', 'IMAGES'].map((name, i) => name.padEnd(COLUMN_WIDTHS[i])).join(' ')}`);
        for (const offering of h.offerings) console.log(`        ${columnsOf(offering).map((cell, i) => cell.padEnd(COLUMN_WIDTHS[i])).join(' ')}`);
      }
      console.log(NOT_LISTED_FOOTER);
    }
    return finishRuntime(0);
  }

  return usageError('models', `unknown action '${act}'; expected sync, list, describe, bind, or unbind`, json);
}

module.exports = { handleModelsCommand };
