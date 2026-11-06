'use strict';

// `advice-gate` (141 IC-006): asks the decision model every heldout case of one choice or yes/no kind, scores the answers
// with gate-score.ts and stores one verdict (IC-004) in core/registry/advice-verdicts.json when --write is given.
// The verdict holds digests, counts and numbers only: no case text, no per-case row. Per-case outcomes (id, pick,
// latency) go to stdout under --json and are never persisted. The rerank branch and --arm belong to a later task.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../src/helper/repo-root.ts');
const { loadAdviceRegistry } = require('../src/runtime/advice/registry.ts');
const { loadStorageRegistry } = require('../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../src/runtime/storage/roots.ts');
const { resolveSetting } = require('../src/runtime/advice/config.ts');
const { createAdviceClient } = require('../src/runtime/advice/client.ts');
const { materializeKind } = require('../src/runtime/advice/kinds.ts');
const { summarizeCases, judge } = require('../src/runtime/advice/gate-score.ts');
const { gateDigest, canonicalJson } = require('../src/runtime/advice/bench-gate.ts');
const { adviceCoverage } = require('./advice.ts');

const VERDICTS_FILE = 'advice-verdicts.json';
const RERANK_KIND = 'rerank';

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadSources(repoRoot: string) {
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'core/registry', name), 'utf8'));
  return { workflows: read('workflows.json'), verification: read('verification.json'), mcp: read('mcp.json') };
}

/** `sha256:<hex>` of the heldout cases without `note`, ordered by id, as canonical JSON (IC-003). */
function corpusDigest(corpus: any): string {
  const heldout = heldoutCases(corpus)
    .map(({ note, ...rest }: any) => rest)
    .sort((a: any, b: any) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return `sha256:${crypto.createHash('sha256').update(canonicalJson(heldout), 'utf8').digest('hex')}`;
}

function heldoutCases(corpus: any): any[] {
  return (Array.isArray(corpus?.cases) ? corpus.cases : []).filter((item: any) => item?.split === 'heldout');
}

/** The `corpora` entry (IC-004) for one corpus. */
function corpusEntry(corpus: any) {
  return { corpusVersion: corpus.corpusVersion, digest: corpusDigest(corpus), heldoutCases: heldoutCases(corpus).length };
}

/** Non-null message when the corpus changed against the stored entry without a higher `corpusVersion`. */
function unversionedChange(kind: string, stored: any, entry: any): string | null {
  if (!isObject(stored) || stored.digest === entry.digest) return null;
  if (Number.isInteger(stored.corpusVersion) && entry.corpusVersion > stored.corpusVersion) return null;
  return `kind '${kind}': the heldout cases changed but corpusVersion is still ${entry.corpusVersion} (stored ${stored.corpusVersion}); `
    + `increment corpusVersion in bench/advice/${kind}.json`;
}

function readVerdictFile(file: string): { ok: true; data: any } | { ok: false; detail: string } {
  if (!fs.existsSync(file)) return { ok: true, data: { schemaVersion: 1, corpora: {}, verdicts: [] } };
  let data: any;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error: any) {
    return { ok: false, detail: `${file} is unreadable (${error.message})` };
  }
  if (!isObject(data) || data.schemaVersion !== 1 || !isObject(data.corpora) || !Array.isArray(data.verdicts)) {
    return { ok: false, detail: `${file} is not a schemaVersion 1 verdict file` };
  }
  return { ok: true, data };
}

function writeVerdictFile(file: string, data: any) {
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

/** Registry kinds this runner can score: not call-criteria kinds. */
function isCallKind(entry: any): boolean {
  return entry?.id === RERANK_KIND || entry?.criteriaFrom === 'call';
}

function loadCorpusFile(corpusDir: string, kind: string): { ok: true; corpus: any } | { ok: false; detail: string } {
  const file = path.join(corpusDir, `${kind}.json`);
  try { return { ok: true, corpus: JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch (error: any) {
    return { ok: false, detail: `cannot read corpus ${file} (${error.message})` };
  }
}

/** Structural check of one kind's corpus through the shared coverage rules; returns the missing items. */
function corpusProblems(kind: string, corpus: any, { adviceRegistry, sources }: any): string[] {
  const result = adviceCoverage({ adviceRegistry, corpus: { [kind]: corpus }, sources });
  const row = result.rows.find((entry: any) => entry.kind === kind);
  if (row) return row.missing;
  return result.gaps.filter((gap: string) => gap.startsWith(`${kind}:`) || gap.startsWith('advice registry'));
}

function fmt(value: any, digits = 3): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
}

function renderText(verdict: any, written: boolean, writeRequested: boolean): string {
  const q = verdict.quality;
  const lines = [
    `advice-gate ${verdict.kind} (${verdict.model}): ${verdict.result}`,
    `  cases: ${verdict.n}, valid ${verdict.valid} (share ${fmt(verdict.validShare)})`,
    `  ${q.metric}: model ${fmt(q.model)}, static ${fmt(q.static)}, delta ${fmt(q.delta)}, ci ${q.ci ? `[${fmt(q.ci[0])}, ${fmt(q.ci[1])}]` : 'n/a'}`,
    `  latency ms: p50 ${fmt(verdict.latencyMs.p50, 0)}, p95 ${fmt(verdict.latencyMs.p95, 0)}`,
  ];
  if (verdict.failedChecks.length) lines.push(`  failed checks: ${verdict.failedChecks.join(', ')}`);
  lines.push(written ? '  verdict written' : writeRequested ? '  verdict not written' : '  not written (pass --write to store it)');
  return lines.join('\n');
}

/**
 * Runs the gate. Every collaborator is injectable so a test needs no network, no model and no repository file:
 * `client` ({ ask, inspect }), `setting`, `adviceRegistry`, `sources`, `corpusDir`, `registryDir`, `now`, `log`, `error`.
 * Returns `{ code, verdict, outcomes }`; `code` follows IC-006 (0 verdict produced, 1 setup or write failure, 2 usage).
 */
async function adviceGate(options: any = {}) {
  const {
    kind, model, write = false, freeze = false, json = false, arm,
    adviceRegistry, setting, client,
    repoRoot = REPO_ROOT,
    corpusDir = path.join(repoRoot, 'bench/advice'),
    registryDir = path.join(repoRoot, 'core/registry'),
    now = () => new Date(),
    log = (text: string) => console.log(text),
    error = (text: string) => console.error(text),
  } = options;
  const fail = (code: number, text: string) => { error(`bench advice-gate: ${text}`); return { code, verdict: null, outcomes: [] }; };

  if (arm !== undefined) return fail(2, '--arm applies to the rerank kind only');
  if (!isObject(adviceRegistry) || !isObject(adviceRegistry.gate)) return fail(1, 'the advice registry has no gate block');
  const gate = adviceRegistry.gate;
  let sources = options.sources;
  if (sources === undefined) {
    try { sources = loadSources(repoRoot); } catch (e: any) { return fail(1, `cannot load sources (${e.message})`); }
  }
  const verdictFile = path.join(registryDir, VERDICTS_FILE);
  const scorable = adviceRegistry.kinds.filter((entry: any) => !isCallKind(entry));

  if (freeze) {
    if (kind !== undefined || model !== undefined) return fail(2, '--freeze refreshes every corpus entry; do not combine it with --kind or --model');
    const stored = readVerdictFile(verdictFile);
    if (!stored.ok) return fail(1, stored.detail);
    const entries: Record<string, any> = {};
    for (const entry of scorable) {
      const loaded = loadCorpusFile(corpusDir, entry.id);
      if (!loaded.ok) return fail(1, loaded.detail);
      const problems = corpusProblems(entry.id, loaded.corpus, { adviceRegistry, sources });
      if (problems.length) return fail(1, `corpus for kind '${entry.id}' is invalid: ${problems.join('; ')}`);
      entries[entry.id] = corpusEntry(loaded.corpus);
      const refusal = unversionedChange(entry.id, stored.data.corpora[entry.id], entries[entry.id]);
      if (refusal) return fail(1, `--freeze refused: ${refusal}`);
    }
    try { writeVerdictFile(verdictFile, { ...stored.data, corpora: { ...stored.data.corpora, ...entries } }); } catch (e: any) {
      return fail(1, `cannot write ${verdictFile} (${e.message})`);
    }
    log(`advice-gate --freeze: refreshed ${Object.keys(entries).length} corpus entries (${Object.keys(entries).join(', ')})`);
    return { code: 0, verdict: null, outcomes: [] };
  }

  if (typeof kind !== 'string' || !kind) return fail(2, '--kind <id> is required');
  const kindEntry = adviceRegistry.kinds.find((entry: any) => entry.id === kind);
  if (kind === RERANK_KIND || isCallKind(kindEntry)) return fail(2, `kind '${kind}' is not supported by this runner yet: only choice and yes/no kinds can be gated here`);
  if (!kindEntry) return fail(2, `unknown kind '${kind}'`);

  const loaded = loadCorpusFile(corpusDir, kind);
  if (!loaded.ok) return fail(1, loaded.detail);
  const problems = corpusProblems(kind, loaded.corpus, { adviceRegistry, sources });
  if (problems.length) return fail(1, `corpus for kind '${kind}' is invalid: ${problems.join('; ')}`);
  const corpus = loaded.corpus;
  const entry = corpusEntry(corpus);

  if (!isObject(setting) || setting.state !== 'on') {
    return fail(1, `advice is off (${setting?.reason ?? 'not configured'}); configure a decision model first (doflow advise --action configure)`);
  }
  const effectiveModel = typeof model === 'string' && model.trim() ? model.trim() : setting.model;
  if (typeof effectiveModel !== 'string' || !effectiveModel) return fail(1, 'no model: pass --model or configure a decision model');
  const probe = await client.inspect({ endpoint: setting.endpoint, model: effectiveModel, provider: setting.provider, file: setting.decidedBy?.user ?? undefined });
  if (probe?.endpoint?.state !== 'reached') {
    return fail(1, `endpoint ${setting.endpoint} is not reachable (${probe?.endpoint?.message ?? probe?.endpoint?.state ?? 'no answer'})`);
  }
  if (!probe.model?.installed) return fail(1, `model '${effectiveModel}' is not installed at ${setting.endpoint}`);
  if (!probe.model?.decisionCapable) return fail(1, `model '${effectiveModel}' is not decision-capable`);

  const cases: any[] = [];
  const outcomes: any[] = [];
  for (const item of heldoutCases(corpus)) {
    const built = materializeKind(kind, { adviceRegistry, sources, server: item.server });
    if (!built.ok) return fail(built.reason === 'usage-error' ? 2 : 1, `${kind}: ${built.detail}`);
    const options = built.question.type === 'choice' ? Object.keys(built.question.options) : ['yes', 'no'];
    const started = Date.now();
    const result = await client.ask({
      questionSet: { state: item.state, questions: [built.question] },
      kind, staticAnswer: item.staticPick, caller: 'bench', record: false, model: effectiveModel,
    });
    const answer = result?.answers?.[0];
    const valid = result?.status === 'answered' && typeof answer?.pick === 'string' && options.includes(answer.pick);
    const latencyMs = Number.isFinite(result?.durationMs) && result.durationMs >= 0 ? result.durationMs : Date.now() - started;
    cases.push({
      valid,
      correctModel: valid && answer.pick === item.expected ? 1 : 0,
      correctStatic: item.staticPick === item.expected ? 1 : 0,
      latencyMs,
    });
    outcomes.push({
      id: item.id, status: result?.status ?? 'unavailable', valid, pick: valid ? answer.pick : null,
      expected: item.expected, staticPick: item.staticPick, latencyMs,
    });
  }

  const metrics = summarizeCases(cases, gate, kind);
  const judged = judge(metrics, gate, kind);
  const verdict = {
    kind, model: effectiveModel, arm: null, criteriaDigest: null,
    gateVersion: gate.version, gateDigest: gateDigest(gate),
    corpusVersion: entry.corpusVersion, corpusDigest: entry.digest,
    runAt: now().toISOString(),
    host: { platform: process.platform, arch: process.arch },
    n: metrics.n, valid: metrics.valid, validShare: metrics.validShare,
    quality: metrics.quality, latencyMs: metrics.latencyMs,
    result: judged.result, failedChecks: judged.failedChecks,
  };

  let written = false;
  if (write) {
    const stored = readVerdictFile(verdictFile);
    if (!stored.ok) return { ...fail(1, stored.detail), verdict, outcomes };
    const refusal = unversionedChange(kind, stored.data.corpora[kind], entry);
    if (refusal) return { ...fail(1, `--write refused: ${refusal}`), verdict, outcomes };
    const same = (v: any) => isObject(v) && v.kind === kind && v.model === effectiveModel && (v.arm ?? null) === null;
    // Replace the first entry for (kind, model, arm null) in place and drop any duplicate of it; every other entry is kept as is.
    const at = stored.data.verdicts.findIndex(same);
    const verdicts = stored.data.verdicts.flatMap((v: any, index: number) => (index === at ? [verdict] : same(v) ? [] : [v]));
    if (at < 0) verdicts.push(verdict);
    try {
      writeVerdictFile(verdictFile, { ...stored.data, corpora: { ...stored.data.corpora, [kind]: entry }, verdicts });
    } catch (e: any) {
      return { ...fail(1, `cannot write ${verdictFile} (${e.message})`), verdict, outcomes };
    }
    written = true;
  }

  log(json ? JSON.stringify({ verdict, written, cases: outcomes }, null, 2) : renderText(verdict, written, write));
  return { code: 0, verdict, outcomes };
}

/** Runner entry: builds the real advice environment and gates against this checkout's registry. */
async function cmdAdviceGate(opts: any = {}) {
  const advice = loadAdviceRegistry({ repoRoot: REPO_ROOT });
  if (!advice.ok) {
    console.error(`bench advice-gate: advice registry is invalid: ${advice.detail}`);
    return 1;
  }
  const storage = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const roots = resolveRoots({ registry: storage, projectRoot: path.resolve(process.cwd()) });
  const adviceRegistry = advice.registry;
  let setting = null;
  let client = null;
  if (!opts.freeze) {
    setting = resolveSetting({ adviceRegistry, roots, storageRegistry: storage });
    client = createAdviceClient({ adviceRegistry, roots });
  }
  const { code } = await adviceGate({
    kind: opts.kind, model: opts.model, write: opts.write, freeze: opts.freeze, json: opts.json, arm: opts.arm,
    adviceRegistry, setting, client,
  });
  return code;
}

module.exports = { adviceGate, cmdAdviceGate, corpusDigest, corpusEntry };
