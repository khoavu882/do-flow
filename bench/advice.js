'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../src/helper/repo-root.ts');
const { loadAdviceRegistry, validateAdviceRegistry } = require('../src/runtime/advice/registry');
const { loadStorageRegistry } = require('../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../src/runtime/storage/roots.ts');
const { resolveSetting } = require('../src/runtime/advice/config');
const { createAdviceClient } = require('../src/runtime/advice/client');
const { materializeKind } = require('../src/runtime/advice/kinds.ts');

function loadSources() {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core/registry', name), 'utf8'));
  return { workflows: read('workflows.json'), verification: read('verification.json'), mcp: read('mcp.json') };
}

function loadCorpus() {
  const directory = path.join(REPO_ROOT, 'bench/advice');
  return Object.fromEntries(fs.readdirSync(directory)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [path.basename(file, '.json'), JSON.parse(fs.readFileSync(path.join(directory, file), 'utf8'))]));
}

/** Validate corpus structure, MCP materialization and the IC-016 coverage bar. */
function adviceCoverage(options = {}) {
  const { adviceRegistry, sources } = options;
  let corpus;
  const gaps = [];
  try { corpus = options.corpus === undefined ? loadCorpus() : options.corpus; }
  catch (error) { corpus = {}; gaps.push(`corpus: could not load input (${error.message})`); }
  let resolvedSources;
  try { resolvedSources = sources === undefined ? loadSources() : sources; }
  catch (error) { resolvedSources = {}; gaps.push(`corpus: could not load sources (${error.message})`); }
  let registry = adviceRegistry;
  if (!registry) {
    const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
    if (!loaded.ok) return { rows: [], gaps: [`advice registry is invalid: ${loaded.detail}`], ok: false };
    registry = loaded.registry;
  }
  const validation = validateAdviceRegistry(registry, { repoRoot: REPO_ROOT });
  if (!validation.ok) {
    return { rows: [], gaps: [...gaps, `advice registry is invalid: ${validation.errors.join('; ')}`], ok: false };
  }
  if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) {
    return { rows: [], gaps: [...gaps, 'corpus: input must be an object keyed by kind'], ok: false };
  }
  const rows = [];
  const kinds = Array.isArray(registry.kinds) ? registry.kinds : [];
  if (!Array.isArray(registry.kinds)) gaps.push('advice registry: kinds must be an array');
  for (const kind of kinds) {
    const id = kind?.id;
    if (typeof id !== 'string' || !id) { gaps.push('advice registry: kind id is missing'); continue; }
    const data = corpus[id];
    const missing = [];
    if (!Object.hasOwn(corpus, id)) missing.push('missing corpus file');
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      missing.push('corpus file must contain an object');
    }
    if (data && data.kind !== id) missing.push(`kind must match file stem '${id}'`);
    const items = data && Array.isArray(data.cases) ? data.cases : [];
    if (data && !Array.isArray(data.cases)) missing.push('cases must be an array');
    const ids = new Set();
    const representative = id === 'mcp-need' ? null : materializeKind(id, { adviceRegistry: registry, sources: resolvedSources });
    const validExpected = id === 'mcp-need' ? ['yes', 'no']
      : representative?.ok ? representative.question.type === 'choice' ? Object.keys(representative.question.options) : ['yes', 'no'] : [];
    if (id !== 'mcp-need' && !representative?.ok) missing.push(`question could not be materialized${representative?.detail ? `: ${representative.detail}` : ''}`);
    const optionCoverage = new Set();
    let heldout = false;
    for (const [index, item] of items.entries()) {
      const label = `case ${index + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) { missing.push(`${label} must be an object`); continue; }
      if (typeof item.id !== 'string' || !new RegExp(`^${id}-[0-9]{3}$`).test(item.id)) missing.push(`${label} id must match ${id}-NNN`);
      else if (ids.has(item.id)) missing.push(`${item.id} duplicate id`);
      else ids.add(item.id);
      if (!['train', 'heldout'].includes(item.split)) missing.push(`${item.id || label} split must be train or heldout`);
      if (item.split === 'heldout') heldout = true;
      if (typeof item.state !== 'string' || !item.state.trim()) missing.push(`${item.id || label} state must be non-empty`);
      else if (Buffer.byteLength(item.state, 'utf8') > registry.limits?.maxStateBytes) missing.push(`${item.id || label} state exceeds maxStateBytes`);
      if (!validExpected.includes(item.expected)) missing.push(`${item.id || label} expected must be one of ${validExpected.join(', ') || '(no valid options)'}`);
      else optionCoverage.add(item.expected);
      if (typeof item.note !== 'string' || !item.note.trim()) missing.push(`${item.id || label} note must be non-empty`);
      if (id === 'mcp-need') {
        const servers = resolvedSources?.mcp?.servers;
        const serverValid = Array.isArray(servers) && servers.some((server) => server?.id === item.server);
        if (!serverValid) missing.push(`${item.id || label} server '${String(item.server)}' is not a valid mcp.json server id`);
        const built = serverValid ? materializeKind(id, { adviceRegistry: registry, sources: resolvedSources, server: item.server }) : null;
        if (!built?.ok) missing.push(`${item.id || label} MCP question could not be materialized${built?.detail ? `: ${built.detail}` : ''}`);
      }
    }
    for (const option of validExpected) if (!optionCoverage.has(option)) missing.push(`missing expected ${option}`);
    if (!heldout) missing.push('missing heldout case');
    for (const item of missing) gaps.push(`${id}: ${item}`);
    rows.push({ kind: id, cases: items.length, missing });
  }
  for (const key of Object.keys(corpus)) {
    if (!kinds.some((entry) => entry?.id === key)) gaps.push(`${key}: unregistered kind / corpus file`);
  }
  return { rows, gaps, ok: gaps.length === 0 };
}

function cmdAdviceCoverage({ json = false, adviceRegistry, corpus, sources } = {}) {
  let registry = adviceRegistry;
  if (!registry) {
    const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
    if (!loaded.ok) {
      console.error(`bench advice-coverage: advice registry is invalid: ${loaded.detail}`);
      return 1;
    }
    registry = loaded.registry;
  }
  const result = adviceCoverage({ adviceRegistry: registry, corpus, sources });
  if (json) console.log(JSON.stringify(result, null, 2));
  else {
    const rowPrefixes = result.rows.map(({ kind }) => `${kind}: `);
    for (const row of result.rows) {
      const mark = row.missing.length ? `GAP (${row.missing.join(', ')})` : 'ok';
      console.log(`${row.kind}: ${mark}`);
    }
    for (const gap of result.gaps) {
      if (!rowPrefixes.some((prefix) => gap.startsWith(prefix))) console.log(`GAP: ${gap}`);
    }
  }
  return result.ok ? 0 : 1;
}

function runtime() {
  const advice = loadAdviceRegistry({ repoRoot: REPO_ROOT });
  const storage = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const projectRoot = path.resolve(process.cwd());
  return {
    adviceRegistry: advice.ok ? advice.registry : null,
    adviceError: advice.ok ? null : advice.detail,
    storage,
    roots: resolveRoots({ registry: storage, projectRoot }),
    sources: loadSources(),
  };
}

function ic014OffText(setting) {
  const location = setting.decidedBy?.project || setting.decidedBy?.user || 'decision-model.json';
  const reason = setting.reason === 'not-configured' ? 'not configured'
    : setting.reason === 'user-disabled' || setting.reason === 'project-disabled' ? `switched off in ${location}`
      : `unreadable setting in ${location}`;
  return `[Decision Model] — advisory, never blocking\n  off (${reason}). To turn it on: doflow advise --action configure --model <a decision-capable model>\n  or write ~/.config/doflow/decision-model.json:\n  {"schema": 1, "enabled": true, "endpoint": "http://127.0.0.1:11434", "model": "<a decision-capable model>"}`;
}

async function cmdAdvice({ kind: selectedKind, split, json = false } = {}) {
  const env = runtime();
  if (!env.adviceRegistry) {
    console.error(`bench advice: advice registry is invalid: ${env.adviceError}`);
    return 1;
  }
  const kinds = env.adviceRegistry.kinds;
  if (selectedKind && !kinds.some((kind) => kind.id === selectedKind)) {
    console.error(`bench advice: unknown kind '${selectedKind}'`);
    return 2;
  }
  const setting = resolveSetting({ adviceRegistry: env.adviceRegistry, roots: env.roots, storageRegistry: env.storage });
  if (setting.state !== 'on') {
    console.error(ic014OffText(setting));
    return 1;
  }

  const client = createAdviceClient({ adviceRegistry: env.adviceRegistry, roots: env.roots, sources: env.sources });
  const reports = {};
  for (const kind of kinds.filter((entry) => !selectedKind || entry.id === selectedKind)) {
    const corpus = loadCorpus()[kind.id];
    const selectedCases = (corpus?.cases || []).filter((item) => !split || item.split === split);
    const report = { caseCount: selectedCases.length, answered: 0, agreed: 0, unavailable: 0, results: [] };
    for (const item of selectedCases) {
      const built = materializeKind(kind.id, {
        adviceRegistry: env.adviceRegistry, sources: env.sources, server: item.server,
      });
      if (!built.ok) {
        console.error(`bench advice: ${kind.id}: ${built.detail}`);
        return built.reason === 'usage-error' ? 2 : 1;
      }
      const questionSet = { state: item.state, questions: [built.question] };
      const result = await client.ask({ questionSet, kind: kind.id, staticAnswer: item.expected, caller: 'bench', record: false });
      const answer = result.answers[0];
      if (result.status === 'answered' && answer) {
        report.answered += 1;
        if (answer.pick === item.expected) report.agreed += 1;
      } else report.unavailable += 1;
      report.results.push({
        id: item.id, expected: item.expected, status: result.status,
        pick: answer?.pick ?? null, word: answer?.strength?.word ?? null,
        probabilities: answer?.probabilities ?? null, confidence: answer?.confidence ?? null,
      });
    }
    reports[kind.id] = report;
  }
  if (json) console.log(JSON.stringify({ kinds: reports }, null, 2));
  else for (const [kind, report] of Object.entries(reports)) {
    console.log(`${kind}: ${report.caseCount} cases, ${report.answered} answered, agreed on ${report.agreed} of ${report.answered}, ${report.unavailable} unavailable`);
  }
  return 0;
}

module.exports = { adviceCoverage, cmdAdviceCoverage, cmdAdvice };
