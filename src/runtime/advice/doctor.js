'use strict';

const fs = require('node:fs');
const { resolveRoots } = require('../storage/roots.ts');
const { loadStorageRegistry } = require('../storage/registry.ts');
const { loadAdviceRegistry } = require('./registry.ts');
const { resolveSetting } = require('./config.ts');
const { createAdviceClient } = require('./client.ts');
const { readWindow } = require('./record.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const WINDOW_DAYS = 90;
const DONE_PHRASES = Object.freeze({
  'classify-verdict': 'accepted class',
  'brief-record': 'tier the brief named',
  caller: 'value the caller recorded',
});

function selectedStore(roots) {
  if (roots?.['project-state']) return { id: 'advice-picks-project', root: roots['project-state'] };
  return { id: 'advice-picks-user', root: roots?.['user-state'] || null };
}

function latestCall(records) {
  const calls = records.filter(({ record }) => record.type === 'pick' || record.type === 'miss');
  if (!calls.length) return null;
  const record = calls.reduce((latest, entry) => !latest || String(entry.record.at).localeCompare(String(latest.record.at)) >= 0
    ? entry : latest).record;
  return record.type === 'pick'
    ? { at: record.at, status: 'answered', reason: null }
    : { at: record.at, status: 'unavailable', reason: record.reason || null };
}

function agreementRows(registry, records) {
  const picks = records.filter(({ record }) => record.type === 'pick');
  const outcomes = new Map();
  for (const { record } of records) {
    if (record.type !== 'outcome' || typeof record.pickId !== 'string') continue;
    const current = outcomes.get(record.pickId);
    if (!current || String(record.at).localeCompare(String(current.at)) >= 0) outcomes.set(record.pickId, record);
  }
  const misses = records.filter(({ record }) => record.type === 'miss');
  const ids = [...(registry.kinds || []).map((kind) => kind.id)];
  if (picks.some(({ record }) => record.kind === 'adhoc')) ids.push('adhoc');
  return ids.map((kind) => {
    const kindPicks = picks.filter(({ record }) => record.kind === kind);
    const completed = kindPicks.map(({ record }) => ({ pick: record.pick, outcome: outcomes.get(record.pickId) }))
      .filter(({ outcome }) => outcome);
    const sources = [...new Set(completed.map(({ outcome }) => outcome.source).filter((source) => DONE_PHRASES[source]))];
    return {
      kind,
      picks: kindPicks.length,
      withOutcome: completed.length,
      matched: completed.filter(({ pick, outcome }) => outcome.actual === pick).length,
      unavailable: misses.filter(({ record }) => record.kind === kind).length,
      outcomeSources: sources,
    };
  });
}

function offReason(setting) {
  if (setting.reason === 'not-configured') return 'not configured';
  if (setting.reason === 'config-invalid') return `unreadable setting in ${setting.decidedBy?.user || setting.decidedBy?.project || 'decision-model.json'}`;
  if (setting.reason === 'project-disabled') return `switched off in ${setting.decidedBy?.project}`;
  return `switched off in ${setting.decidedBy?.user || 'decision-model.json'}`;
}

async function buildAdviceDoctor({ repoRoot = REPO_ROOT, projectRoot = process.cwd(), env = process.env, fsImpl = fs,
  adviceRegistry: suppliedRegistry, storageRegistry: suppliedStorage, client: suppliedClient, lookup, httpModule, httpsModule,
  probeTimeoutMs, doctorBudgetMs, now = () => new Date() } = {}) {
  try {
    const root = repoRoot;
    const loaded = suppliedRegistry ? { ok: true, registry: suppliedRegistry } : loadAdviceRegistry({ repoRoot: root, fsImpl });
    const registry = loaded.registry;
    const storage = suppliedStorage || loadStorageRegistry({ repoRoot: root, fsImpl });
    const roots = resolveRoots({ registry: storage, projectRoot, env });
    const setting = loaded.ok ? resolveSetting({ adviceRegistry: registry, roots, fsImpl }) : {
      state: 'off', reason: 'config-invalid', decidedBy: { user: null, project: null }, modelFrom: null, notes: [loaded.detail],
    };
    const store = selectedStore(roots);
    const selectedRoots = store.id === 'advice-picks-project'
      ? { 'project-state': store.root }
      : { 'user-state': store.root };
    const window = readWindow({ roots: selectedRoots, now, fsImpl, maxAgeDays: WINDOW_DAYS });
    const advice = {
      windowDays: WINDOW_DAYS,
      store: store.id,
      kinds: agreementRows(registry || { kinds: [] }, window.records),
      unreadableLines: window.unreadable,
    };
    let decisionModel;
    let inspection = null;
    if (setting.state === 'on' && loaded.ok) {
      const effectiveRegistry = { ...registry, probeTimeoutMs: probeTimeoutMs ?? registry.probeTimeoutMs,
        doctorBudgetMs: doctorBudgetMs ?? registry.doctorBudgetMs };
      const client = suppliedClient || createAdviceClient({ adviceRegistry: effectiveRegistry, roots, fsImpl, lookup, httpModule, httpsModule });
      inspection = await client.inspect({ endpoint: setting.endpoint, model: setting.model, provider: setting.provider,
        file: setting.decidedBy?.user, minVersion: registry.providers.find((p) => p.id === setting.provider)?.minVersion,
        timeoutMs: probeTimeoutMs ?? registry.probeTimeoutMs });
      const provider = registry.providers.find((p) => p.id === setting.provider) || {};
      decisionModel = {
        setting: { state: 'on', reason: null, decidedBy: setting.decidedBy, modelFrom: setting.modelFrom, notes: setting.notes || [] },
        endpoint: { url: setting.endpoint, state: inspection.endpoint.state, version: inspection.endpoint.version,
          minVersion: provider.minVersion || null, versionOk: inspection.endpoint.versionOk, message: inspection.endpoint.message },
        model: { name: setting.model, installed: inspection.model.installed, decisionCapable: inspection.model.decisionCapable },
        decisionModels: inspection.models.filter((model) => model.capabilities?.includes(provider.capability)).map((model) => model.name),
        lastCall: latestCall(window.records),
      };
    } else {
      decisionModel = {
        setting: { state: 'off', reason: setting.reason, decidedBy: setting.decidedBy || { user: null, project: null }, modelFrom: setting.modelFrom || null, notes: setting.notes || [] },
        endpoint: { url: setting.endpoint || null, state: 'not-checked', version: null, minVersion: registry?.providers?.[0]?.minVersion || null, versionOk: false, message: null },
        model: { name: setting.model || null, installed: false, decisionCapable: false },
        decisionModels: [], lastCall: latestCall(window.records),
      };
    }
    return { decisionModel, advice, _inspection: inspection, _offReason: setting.state === 'off' ? offReason(setting) : null };
  } catch (error) {
    return { decisionModel: { setting: { state: 'off', reason: 'config-invalid', decidedBy: { user: null, project: null }, modelFrom: null, notes: [error.message] },
      endpoint: { url: null, state: 'not-checked', version: null, minVersion: null, versionOk: false, message: null },
      model: { name: null, installed: false, decisionCapable: false }, decisionModels: [], lastCall: null },
      advice: { windowDays: WINDOW_DAYS, store: 'advice-picks-user', kinds: [], unreadableLines: 0 }, _inspection: null, _offReason: 'unreadable setting in decision-model.json' };
  }
}

function printAdviceDoctor(report) {
  const decision = report.decisionModel;
  const inspection = report._inspection;
  console.log('\n[Decision Model] — advisory, never blocking');
  if (decision.setting.state === 'off') {
    console.log(`  off (${report._offReason}). To turn it on: doflow advise --action configure --model <a decision-capable model>`);
    console.log('  or write ~/.config/doflow/decision-model.json:');
    console.log('  {"schema": 1, "enabled": true, "endpoint": "http://127.0.0.1:11434", "model": "<a decision-capable model>"}');
  } else {
    const setting = decision.setting;
    console.log(`  setting       on (${setting.decidedBy.user || 'user setting'}${setting.modelFrom === 'project' ? `; model from ${setting.decidedBy.project}` : ''})`);
    const endpoint = decision.endpoint;
    if (endpoint.state === 'refused') console.log(`  endpoint      ${endpoint.url}  ✗ REFUSED  ${endpoint.message || inspection?.endpoint.message || 'endpoint refused'}`);
    else if (endpoint.state === 'unreachable') console.log(`  endpoint      ${endpoint.url}  ○ UNREACHABLE  start Ollama yourself; DoFlow does not start it`);
    else if (endpoint.version && !endpoint.versionOk) console.log(`  endpoint      ${endpoint.url}  ▲ Ollama ${endpoint.version} is older than ${endpoint.minVersion}`);
    else if (endpoint.state === 'reached') console.log(`  endpoint      ${endpoint.url}  ✓ REACHED  Ollama ${endpoint.version || 'version unknown'}`);
    else console.log(`  endpoint      ${endpoint.url}  ○ UNREACHABLE  start Ollama yourself; DoFlow does not start it`);
    const model = decision.model;
    if (!model.installed) console.log(`  model         ${model.name}  ✗ not installed; run 'ollama pull ${model.name}' yourself; DoFlow does not download models`);
    else if (!model.decisionCapable) console.log(`  model         ${model.name}  ✗ installed, not decision-capable`);
    else console.log(`  model         ${model.name}  ✓ installed, decision-capable`);
    console.log(`  decision-capable here: ${decision.decisionModels.length ? decision.decisionModels.join(', ') : 'none'}`);
    for (const model of inspection?.models || []) {
      if (!Array.isArray(model.capabilities)) console.log(`  ${model.name}  capability unknown`);
    }
    if (!decision.lastCall) console.log('  last call     none recorded');
    else if (decision.lastCall.status === 'unavailable') console.log(`  last call     unavailable (${decision.lastCall.reason}) ${decision.lastCall.at}`);
    else console.log(`  last call     answered ${decision.lastCall.at}`);
  }

  console.log('\n[Advice Agreement] — picks kept for 90 days in this project; agreement with what was done, not correctness');
  if (!report.advice.kinds.some((row) => row.picks) && !report.advice.unreadableLines) console.log('  No picks recorded here.');
  for (const row of report.advice.kinds) {
    if (!row.picks) { console.log(`  ${row.kind.padEnd(17)}no picks recorded`); continue; }
    const phrases = row.outcomeSources.map((source) => DONE_PHRASES[source]).filter(Boolean);
    const done = phrases.length ? ` (done = ${phrases.join(' or ')})` : '';
    console.log(`  ${row.kind.padEnd(17)}${row.picks} picks, ${row.withOutcome} with a known outcome, matched ${row.matched} of ${row.withOutcome}${done}; ${row.unavailable} calls unavailable`);
  }
  if (report.advice.unreadableLines) console.log(`  ${report.advice.unreadableLines} line(s) could not be read`);
}

module.exports = { buildAdviceDoctor, printAdviceDoctor };
