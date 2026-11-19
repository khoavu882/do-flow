'use strict';

// `advice-gate` (175 D14, O-5): a maintainer's print-only scorer. It asks the configured decision model every heldout case
// of one choice or yes/no kind of the synthetic corpus, scores the answers with the replay scorer
// (src/runtime/advice/replay/score.ts) and prints the figures. It carries no bar and no standing and stores nothing: a
// local result comes from `doflow advise --action replay` over the project's own recorded decisions.
// Per-case outcomes (id, pick, latency) go to stdout under --json and are never persisted.
//
// `--kind rerank [--arm choice|ladder|both]` prints nDCG@5 of the model order against the first-stage order on the
// retrieval bench's dev split (never the sealed holdout) with no bar; the paired arm difference and the ladder's would-drop
// counts are printed too.

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../src/helper/repo-root.ts');
const { loadAdviceRegistry } = require('../src/runtime/advice/registry.ts');
const { loadStorageRegistry } = require('../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../src/runtime/storage/roots.ts');
const { resolveSetting } = require('../src/runtime/advice/config.ts');
const { createAdviceClient } = require('../src/runtime/advice/client.ts');
const { materializeKind } = require('../src/runtime/advice/kinds.ts');
const { score } = require('../src/runtime/advice/replay/score.ts');
const { resolveRerankCriteria } = require('../src/runtime/advice/criteria.ts');
const { adviceCoverage } = require('./advice.ts');
const rerankLib = require('./retrieval/lib/adapters-rerank.ts');

const RERANK_KIND = 'rerank';
const PRINT_ONLY = 'print-only: nothing is stored; a local result comes from `doflow advise --action replay`';

/** Reasons the client gives that the scorer counts as a failed call; any other unavailable reply is `unreachable`. */
const FAILURE_OF: Record<string, string> = { timeout: 'timeout', 'malformed-reply': 'malformed-reply' };

function isObject(value: any): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function loadSources(repoRoot: string) {
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(repoRoot, 'core/registry', name), 'utf8'));
  return { workflows: read('workflows.json'), verification: read('verification.json'), mcp: read('mcp.json') };
}

function heldoutCases(corpus: any): any[] {
  return (Array.isArray(corpus?.cases) ? corpus.cases : []).filter((item: any) => item?.split === 'heldout');
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

function fmtCi(ci: any): string {
  return ci ? `[${fmt(ci[0])}, ${fmt(ci[1])}]` : 'n/a';
}

function renderText({ kind, model, metrics: m, budgetMs }: any): string {
  return [
    `advice-gate ${kind} (${model})`,
    `  cases: ${m.n}, valid ${m.valid} (share ${fmt(m.validShare)}), no answer ${m.noAnswer.count}`,
    `  accuracy: model ${fmt(m.accuracy.model)}, rule ${fmt(m.accuracy.rule)}`,
    `  kappa: model ${fmt(m.kappa.model)}, rule ${fmt(m.kappa.rule)}, lower ${fmt(m.kappa.lower)}, gain ${fmt(m.kappa.gain)}, gain lower ${fmt(m.kappa.gainLower)}`,
    `  worse ${m.worse}, better ${m.better} (worse share ${fmt(m.worseShare)})`,
    `  latency ms: p50 ${fmt(m.latencyMs.p50, 0)}, p95 ${fmt(m.latencyMs.p95, 0)} (budget ${budgetMs})`,
    `  ${PRINT_ONLY}`,
  ].join('\n');
}

function renderArm(arm: any): string {
  const q = arm.quality;
  const lines = [
    `advice-gate ${arm.kind} arm ${arm.arm} (${arm.model}): figures only, no bar`,
    `  cases: ${arm.n}, valid ${arm.valid} (share ${fmt(arm.validShare)})`,
    `  ${q.metric}: model ${fmt(q.model)}, static ${fmt(q.static)}, delta ${fmt(q.delta)}, ci ${fmtCi(q.ci)}`,
    `  latency ms: p50 ${fmt(arm.latencyMs.p50, 0)}, p95 ${fmt(arm.latencyMs.p95, 0)}`,
  ];
  if (q.excluded) lines.push(`  excluded from quality (no judged positive): ${q.excluded}`);
  lines.push(`  criteria digest: ${arm.criteriaDigest}`);
  if (arm.armDelta) lines.push(`  armDelta vs ${arm.armDelta.versus}: ${fmt(arm.armDelta.delta)}, ci ${fmtCi(arm.armDelta.ci)}`);
  return lines.join('\n');
}

/** Real first-stage collection (configuration A over the pinned export); the scratch directory is removed afterwards. */
function defaultFirstStage(repoRoot: string, tmpOption?: string) {
  return () => {
    const tmp = tmpOption ?? path.join(require('node:os').tmpdir(), `doflow-rerank-${process.pid}`);
    try { return rerankLib.collectFirstStage({ repoRoot, tmp }); } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  };
}

/** The configured model for this run: the setting must be on, the endpoint reached and the model installed and decision-capable. */
async function checkModel({ model, setting, client, fail }: any): Promise<{ model: string } | { failed: any }> {
  if (!isObject(setting) || setting.state !== 'on') {
    return { failed: fail(1, `advice is off (${setting?.reason ?? 'not configured'}); configure a decision model first (doflow advise --action configure)`) };
  }
  const effectiveModel = typeof model === 'string' && model.trim() ? model.trim() : setting.model;
  if (typeof effectiveModel !== 'string' || !effectiveModel) return { failed: fail(1, 'no model: pass --model or configure a decision model') };
  const probe = await client.inspect({ endpoint: setting.endpoint, model: effectiveModel, provider: setting.provider, file: setting.decidedBy?.user ?? undefined });
  if (probe?.endpoint?.state !== 'reached') {
    return { failed: fail(1, `endpoint ${setting.endpoint} is not reachable (${probe?.endpoint?.message ?? probe?.endpoint?.state ?? 'no answer'})`) };
  }
  if (!probe.model?.installed) return { failed: fail(1, `model '${effectiveModel}' is not installed at ${setting.endpoint}`) };
  if (!probe.model?.decisionCapable) return { failed: fail(1, `model '${effectiveModel}' is not decision-capable`) };
  return { model: effectiveModel };
}

/** The rerank branch: both arms by default, over the same dev tasks, with the paired difference; no bar. */
async function rerankGate(options: any) {
  const {
    kind, model, json = false, arm, kindEntry, fail, adviceRegistry, setting, client,
    repoRoot = REPO_ROOT,
    log = (text: string) => console.log(text),
  } = options;
  if (!isObject(kindEntry.params) || !isObject(kindEntry.scoreLadder)) return fail(1, `kind '${kind}' has no params or score ladder in the advice registry`);
  const checked: any = await checkModel({ model, setting, client, fail });
  if (checked.failed) return checked.failed;
  const effectiveModel = checked.model;

  // The criteria in force come from the resolver the runtime uses; its digest names them in the output.
  const criteria = resolveRerankCriteria({ kind: kindEntry, adviceRegistry });
  let firstStage: any;
  try {
    firstStage = await (options.firstStage ?? defaultFirstStage(repoRoot, options.tmp))();
  } catch (e: any) {
    return fail(1, `cannot build the first-stage candidate lists (${e.message})`);
  }
  const items = firstStage.items;
  if (!Array.isArray(items) || items.length === 0) return fail(1, 'the dev split gave no tasks');

  const statistics = (kindEntry.bars ?? adviceRegistry.bars).statistics;
  const arms = arm === 'both' ? rerankLib.ARMS : [arm];
  const scored: Record<string, any> = {};
  for (const name of arms) {
    scored[name] = await rerankLib.scoreArm({
      arm: name, items, ask: (request: any) => client.ask(request), model: effectiveModel, criteria, kindEntry,
      limits: adviceRegistry.limits,
    });
  }
  const armDelta = scored.choice && scored.ladder ? rerankLib.armDifference(scored.choice.cases, scored.ladder.cases, statistics) : null;

  const figures = arms.map((name: string) => ({
    kind, model: effectiveModel, arm: name, criteriaDigest: criteria.digest,
    ...rerankLib.summarizeCases(scored[name].cases, statistics),
    armDelta: name === 'ladder' && armDelta ? { versus: armDelta.versus, delta: armDelta.delta, ci: armDelta.ci } : null,
  }));

  const wouldDrop = scored.ladder ? rerankLib.wouldDrop(scored.ladder.ladderRows, kindEntry.thresholds) : null;
  const skipped = (scored[arms[0]].skipped as any[]).map((item) => item.id);
  const excluded = (scored[arms[0]].outcomes as any[]).filter((o) => o.excluded).map((o) => o.id);
  if (json) {
    log(JSON.stringify({
      arms: figures, armDelta, wouldDrop, excluded, skipped,
      cases: Object.fromEntries(arms.map((name: string) => [name, scored[name].outcomes])),
    }, null, 2));
  } else {
    const lines = figures.map(renderArm);
    if (criteria.warning) lines.push(`criteria: ${criteria.warning}`);
    lines.push(`dev split: ${items.length} tasks, snapshot ${firstStage.snapshotId}; criteria ${criteria.source}, digest ${criteria.digest}`);
    if (skipped.length) lines.push(`skipped (fewer than ${kindEntry.params.minCandidates} first-stage candidates, no call): ${skipped.join(', ')}`);
    if (excluded.length) lines.push(`excluded (no judged positive): ${excluded.join(', ')}`);
    if (armDelta) lines.push(`paired nDCG@5, ladder minus choice: ${fmt(armDelta.delta)}, ci ${fmtCi(armDelta.ci)}, n ${armDelta.n}`);
    if (wouldDrop) {
      for (const row of wouldDrop) {
        lines.push(`would drop (ladder, ${row.field} < ${row.below}): ${row.dropped} of ${row.candidates} candidates, ${row.relevantDropped} of ${row.relevantTotal} judged-relevant`);
      }
    }
    lines.push(PRINT_ONLY);
    log(lines.join('\n'));
  }
  return { code: 0, arms: figures, outcomes: [] };
}

/**
 * Runs the scorer. Every collaborator is injectable so a test needs no network, no model and no repository file:
 * `client` ({ ask, inspect }), `setting`, `adviceRegistry`, `sources`, `corpusDir`, `log`, `error`.
 * Returns `{ code, kind, model, budgetMs, metrics, outcomes }` (a rerank run returns `{ code, arms, outcomes }`); `code`
 * is 0 when figures were printed, 1 for a setup failure, 2 for a usage error.
 */
async function adviceGate(options: any = {}) {
  const {
    kind, model, json = false, arm,
    adviceRegistry, setting, client,
    repoRoot = REPO_ROOT,
    corpusDir = path.join(repoRoot, 'bench/advice'),
    log = (text: string) => console.log(text),
    error = (text: string) => console.error(text),
  } = options;
  const fail = (code: number, text: string) => { error(`bench advice-gate: ${text}`); return { code, outcomes: [] }; };

  if (arm !== undefined && kind !== RERANK_KIND) return fail(2, '--arm applies to the rerank kind only');
  if (arm !== undefined && ![...rerankLib.ARMS, 'both'].includes(arm)) return fail(2, `--arm must be choice, ladder or both (got '${arm}')`);
  let sources = options.sources;
  if (sources === undefined) {
    try { sources = loadSources(repoRoot); } catch (e: any) { return fail(1, `cannot load sources (${e.message})`); }
  }

  if (typeof kind !== 'string' || !kind) return fail(2, '--kind <id> is required');
  const kindEntry = adviceRegistry.kinds.find((entry: any) => entry.id === kind);
  if (!kindEntry) return fail(2, `unknown kind '${kind}'`);
  if (kind === RERANK_KIND) return rerankGate({ ...options, kind, arm: arm ?? 'both', kindEntry, fail });
  if (isCallKind(kindEntry)) return fail(2, `kind '${kind}' is not supported by this runner: it takes its questions from the call`);

  const loaded = loadCorpusFile(corpusDir, kind);
  if (!loaded.ok) return fail(1, loaded.detail);
  const problems = corpusProblems(kind, loaded.corpus, { adviceRegistry, sources });
  if (problems.length) return fail(1, `corpus for kind '${kind}' is invalid: ${problems.join('; ')}`);

  const checked: any = await checkModel({ model, setting, client, fail });
  if (checked.failed) return checked.failed;
  const effectiveModel = checked.model;

  const cases: any[] = [];
  const outcomes: any[] = [];
  let optionNames: string[] = [];
  for (const item of heldoutCases(loaded.corpus)) {
    const built = materializeKind(kind, { adviceRegistry, sources, server: item.server });
    if (!built.ok) return fail(built.reason === 'usage-error' ? 2 : 1, `${kind}: ${built.detail}`);
    optionNames = built.question.type === 'choice' ? Object.keys(built.question.options) : ['yes', 'no'];
    const started = Date.now();
    const result = await client.ask({
      questionSet: { state: item.state, questions: [built.question] },
      kind, staticAnswer: item.staticPick, caller: 'bench', record: false, model: effectiveModel,
    });
    const answer = result?.status === 'answered' ? result.answers?.[0] : null;
    const valid = typeof answer?.pick === 'string' && optionNames.includes(answer.pick);
    const latencyMs = Number.isFinite(result?.durationMs) && result.durationMs >= 0 ? result.durationMs : Date.now() - started;
    cases.push(answer
      ? { id: item.id, label: item.expected, rule: item.staticPick, model: answer.pick, strength: answer.strength?.word, latencyMs }
      : { id: item.id, label: item.expected, rule: item.staticPick, model: null, failure: FAILURE_OF[result?.reason] || 'unreachable', latencyMs });
    outcomes.push({
      id: item.id, status: result?.status ?? 'unavailable', valid, pick: valid ? answer.pick : null,
      expected: item.expected, staticPick: item.staticPick, latencyMs,
    });
  }

  // The package bars supply only the bootstrap settings (`statistics`); no bar is applied to the figures.
  const bars = kindEntry.bars ?? adviceRegistry.bars;
  const budgetMs = kindEntry.budgetMs;
  const metrics = score(cases, { options: optionNames, bars, budgetMs });
  const printed = { kind, model: effectiveModel, budgetMs, metrics };
  log(json ? JSON.stringify({ ...printed, cases: outcomes }, null, 2) : renderText(printed));
  return { code: 0, ...printed, outcomes };
}

/** Runner entry: builds the real advice environment and scores against this checkout's registry. */
async function cmdAdviceGate(opts: any = {}) {
  const advice = loadAdviceRegistry({ repoRoot: REPO_ROOT });
  if (!advice.ok) {
    console.error(`bench advice-gate: advice registry is invalid: ${advice.detail}`);
    return 1;
  }
  const storage = loadStorageRegistry({ repoRoot: REPO_ROOT });
  const roots = resolveRoots({ registry: storage, projectRoot: path.resolve(process.cwd()) });
  const adviceRegistry = advice.registry;
  const setting = resolveSetting({ adviceRegistry, roots, storageRegistry: storage });
  const client = createAdviceClient({ adviceRegistry, roots });
  const { code } = await adviceGate({
    kind: opts.kind, model: opts.model, json: opts.json, arm: opts.arm, adviceRegistry, setting, client,
  });
  return code;
}

module.exports = { adviceGate, cmdAdviceGate };
