'use strict';

// `doflow advise --action replay --kind <k> [--limit <n>] [--json] [--write] [-g]` (175 IC-005, IC-008). Measures the
// configured decision model on the kind's own recorded decisions: the kind's case source builds the cases from local
// stores, each case is asked once, in case-id order, one at a time, with no pick or miss line written, and the replay
// scorer and judge turn the answers into the figures of design section 5 and a standing against the effective bars.
//
// Nothing is written unless `--write` is given; then one entry goes to the user-level result store. A refused `--write`
// (design section 10) stops the command before any case is asked. Case text (state, claim, passage) and model replies
// stay in memory: stdout, stderr and the store hold numbers, digests, ids from data and at most MAX_WORSE_IDS case ids. Exit 0 when figures were produced, whatever the
// standing; 1 for a setup refusal or a refused or failed write; 2 for a usage fault.

const fs = require('node:fs');
const path = require('node:path');
const { finishRuntime, usageError } = require('../../cli-result.ts');
const { REPO_ROOT } = require('../../../helper/repo-root.ts');
const { resolveSetting } = require('../config.ts');
const { resolveShadowConfig } = require('../shadow-config.ts');
const { createAdviceClient } = require('../client.ts');
const { materializeKind } = require('../kinds.ts');
const { inWorkerSession } = require('../../context/identity.ts');
const { readSeedSwitch } = require('../../settings/autopilot.ts');
const { listCheckouts } = require('../../checkouts.ts');
const { score, judge } = require('./score.ts');
const { effectiveBars, OVERRIDE_FILE } = require('./bars.ts');
const { getSource } = require('./sources/index.ts');
const { readResults, writeResult, resultsFile } = require('./results.ts');
const { questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey } = require('./trust.ts');

const DEFAULT_LIMIT = 200;
const MAX_WORSE_IDS = 20;
const PERSON_ONLY = 'a person runs --write from their own session, outside a worker or an autopilot run; nothing was written';

/** Reasons the client gives that the scorer counts as a failed call; any other unavailable reply is `unreachable`. */
const FAILURE_OF: Record<string, string> = { timeout: 'timeout', 'malformed-reply': 'malformed-reply' };

const STANDING_TEXT: Record<string, string> = {
  'measure-only': "the label is the rule's answer by construction, so nothing certifies from this source",
  'below-minimum': 'too few cases, or too few in the smaller class',
  'below-show': 'the show bar is not met',
  show: 'the show bar holds; the act bar does not',
  act: 'the show and act bars hold',
};

/** The main checkout of `root` (a linked worktree's runs live in the main one), else `root` itself. */
function mainRootOf(root: string): string {
  try {
    const info = listCheckouts({ cwd: root });
    if (info && info.ok && info.main) return info.main;
  } catch { /* the root as given */ }
  return path.resolve(root);
}

/**
 * Why `--write` must not store a result here, or null (design section 10, O-2). First match wins. Fail closed: a runs
 * folder that cannot be listed, or a run record that cannot be parsed, is `attendance-unclear`, and an open run counts as
 * unattended unless the autopilot switch is verifiably off. A non-terminal stdin alone is not a refusal.
 */
function writeRefusal({ env, root, modelDigest, fsImpl = fs }: { env: any; root: string; modelDigest: string | null; fsImpl?: any }): string | null {
  if (inWorkerSession(env)) return 'worker-session';
  if (typeof env.CI === 'string' && env.CI !== '') return 'ci';
  const runs = path.join(mainRootOf(root), '.doflow', 'state', 'roadmap', 'runs');
  let open = false;
  try {
    let names: string[] = [];
    try { names = fsImpl.readdirSync(runs); } catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
    for (const name of names.filter((entry) => /^rl-.*\.json$/.test(entry))) {
      const record = JSON.parse(fsImpl.readFileSync(path.join(runs, name), 'utf8'));
      if (!record || typeof record !== 'object' || record.schema !== 1) throw new Error(`${name} is not a run record`);
      if (!record.closedAt) open = true;
    }
  } catch {
    return 'attendance-unclear';
  }
  if (open && readSeedSwitch(env, fsImpl).enabled) return 'unattended-run';
  if (!modelDigest) return 'model-digest-unknown';
  return null;
}

function doflowVersion(): string {
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
}

const two = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : 'n/a');
const pct = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : 'n/a');
const ms = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? String(Math.round(x)) : 'n/a');
const counts = (record: Record<string, number>) => Object.entries(record).map(([key, n]) => `${key} ${n}`).join(', ');

/** The text form: fixed lines, numbers and ids from data only (at most about 15 lines for any kind). */
function renderText(r: any): string {
  const m = r.metrics;
  const digest = r.modelDigest ? `${r.modelDigest.slice(0, 15)}…` : 'unknown';
  const origin = r.origin === 'project' ? 'this project' : 'the installed package';
  const lines = [
    `Replay ${r.kind} · model ${r.model} (provider ${r.provider}, digest ${digest}) · ${r.caseSet.replayed} of ${r.caseSet.eligible} cases · source ${r.source} (${origin})`,
  ];
  if (Object.keys(r.caseSet.skipped).length) lines.push(`Skipped while building: ${counts(r.caseSet.skipped)}`);
  const smaller = r.yesno ? 'smaller class' : 'outside the largest class';
  lines.push(`Labels: ${counts(m.labelCounts)} (${smaller} ${m.minority})`);
  const reasons = counts(m.noAnswer.byReason);
  lines.push(`Valid ${m.valid}/${m.n} (${pct(m.validShare)}) · no answer ${m.noAnswer.count} (${pct(m.noAnswer.share)}${reasons ? `: ${reasons}` : ''})`);
  const row = (name: string, accuracy: any, kappa: any, low: string) => `  ${name.padEnd(11)}${two(accuracy).padEnd(10)}${two(kappa).padEnd(9)}${low}`.trimEnd();
  lines.push(`${' '.repeat(13)}${'accuracy'.padEnd(10)}${'kappa'.padEnd(9)}kappa low`);
  lines.push(row('model', m.accuracy.model, m.kappa.model, two(m.kappa.lower)));
  lines.push(row('rule', m.accuracy.rule, m.kappa.rule, '-'));
  const perClass = Object.entries(m.perClass).map(([name, figures]: [string, any]) =>
    `${name} ${two(figures.model.precision)}/${two(figures.model.recall)} | ${two(figures.rule.precision)}/${two(figures.rule.recall)}`);
  lines.push(`Per class, precision/recall (model | rule): ${perClass.join(' · ')}`);
  lines.push(`Gain over the rule: kappa ${two(m.kappa.gain)} (low ${two(m.kappa.gainLower)}) · worse ${m.worse} (${pct(m.worseShare)}), better ${m.better}`);
  if (m.worse === 0) lines.push('Worse ids: none');
  else if (m.worse > r.worseIds.length) lines.push(`Worse ids (first ${r.worseIds.length} of ${m.worse}): ${r.worseIds.join(', ')}`);
  else lines.push(`Worse ids (${m.worse}): ${r.worseIds.join(', ')}`);
  lines.push(`Latency ms: first ${ms(m.latencyMs.first)} · p50 ${ms(m.latencyMs.p50)} · p95 ${ms(m.latencyMs.p95)} · max ${ms(m.latencyMs.max)} (budget ${r.budgetMs})`);
  const failed = r.failedChecks.length ? ` (${r.failedChecks.join(', ')})` : '';
  lines.push(`Standing: ${r.standing}: ${STANDING_TEXT[r.standing] || r.standing}${failed}.`);
  let write = 'not written (a person adds --write from their own session to store these figures)';
  if (r.written) write = `written to ${r.resultsFile}`;
  else if (r.refused) write = `not written (refused: ${r.refused})`;
  lines.push(`Stored: ${r.stored} · ${write}.`);
  return lines.join('\n');
}

/**
 * The replay verb. `inspectFailure` is the advise verb's own reader of `client.inspect` (cli.ts), so replay and configure
 * refuse an endpoint or model in the same words.
 */
async function handleReplay(options: any, runtime: any, { inspectFailure, createClient = createAdviceClient }: any): Promise<number> {
  const { json } = options;
  const env = options.env || process.env;
  const fail = (error: string, message: string, extra: Record<string, unknown> = {}) => {
    if (json) console.log(JSON.stringify({ ok: false, error, message, ...extra }, null, 2));
    else console.error(message.startsWith('advise:') ? message : `advise: ${message}`);
    return finishRuntime(1);
  };

  // Usage.
  const { adviceRegistry, adviceError, roots, sources } = runtime;
  if (typeof options.kind !== 'string' || !options.kind) return usageError('advise', '--kind is required for --action replay', json);
  let limit = DEFAULT_LIMIT;
  if (options.limit !== undefined && options.limit !== null) {
    const text = String(options.limit);
    limit = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || !Number.isSafeInteger(limit)) return usageError('advise', `--limit must be a whole number from 1; got '${text}'`, json);
  }
  if (adviceError || !adviceRegistry) return fail('registry-invalid', `advice registry cannot be read: ${adviceError || 'missing'}`);
  const kind = options.kind;
  const registryKind = (adviceRegistry.kinds || []).find((entry: any) => entry?.id === kind);
  if (!registryKind) {
    return usageError('advise', `unknown --kind '${kind}'; known kinds: ${adviceRegistry.kinds.map((entry: any) => entry.id).join(', ')}`, json);
  }

  // 1. The decision model and the kind's model.
  const projectRoot = options.projectRoot || null;
  const setting = resolveSetting({ adviceRegistry, roots, env });
  if (setting.state !== 'on') return fail('off', `decision model is off (${setting.reason}); nothing was asked`);
  const model = resolveShadowConfig(kind, { projectRoot: projectRoot || undefined, env, roots, global: options.global }).model || setting.model;
  if (typeof model !== 'string' || !model) return fail('no-model', `no model is named for kind ${kind}; nothing was asked`);
  const provider = (adviceRegistry.providers || []).find((entry: any) => entry.id === setting.provider);
  if (!provider) return fail('provider-unknown', `provider '${setting.provider}' is not in core/registry/advice.json; nothing was asked`);

  // 2. The kind's case source, the question it is asked and the bars it is judged by.
  const source = getSource(registryKind.replay?.source);
  if (!source) return fail('no-source', `no local case source: this kind's records hold only digests (kind ${kind}); nothing was asked`);
  const built = materializeKind(kind, { adviceRegistry, sources });
  if (!built.ok) return fail('question-invalid', `${built.detail}; nothing was asked`);
  const question = built.question;
  const bars = effectiveBars({ registry: adviceRegistry, kind, roots });
  if (!bars.ok) return fail('bars-override-invalid', `the bars override ${OVERRIDE_FILE} is invalid: ${bars.errors.join('; ')}; nothing was asked`);
  const budgetMs = registryKind.budgetMs;

  // 3. Endpoint and model, then the model build's digest.
  const client = createClient({ adviceRegistry, roots, sources });
  const endpoint = setting.endpoint;
  const inspected = await client.inspect({ endpoint, model, provider: provider.id, minVersion: provider.minVersion, file: setting.decidedBy?.user || 'provider default' });
  const failure = inspectFailure(inspected, { endpoint, model, provider });
  if (failure) return fail('inspect-failed', failure.replace(/ Nothing was written\.$/, ' Nothing was asked.'));
  const digestRead = await client.modelDigest({ endpoint, model, provider: provider.id });
  const modelDigest: string | null = digestRead?.digest ?? null;

  // A refused --write stops here, before any case is asked: the figures could not be stored, and a replay costs up to
  // DEFAULT_LIMIT model calls. The model digest is known now, so every reason of `writeRefusal` can be checked.
  if (options.write === true) {
    const refusedUpFront = writeRefusal({ env, root: projectRoot, modelDigest });
    if (refusedUpFront) return fail('write-refused', `--write refused (${refusedUpFront}): ${PERSON_ONLY}; nothing was asked`, { refused: refusedUpFront });
  }

  // 4. The cases.
  const eligible = projectRoot ? source.build({ projectRoot, roots, kind: registryKind }) : { cases: [], skipped: {} };
  if (eligible.cases.length === 0) {
    const skipped = counts(eligible.skipped);
    return fail('no-cases', `no cases for ${kind}: ${skipped ? `skipped ${skipped}` : 'nothing recorded to replay'}; nothing was asked`);
  }
  const cases = eligible.cases.slice(0, limit);

  // 5. One case at a time, in case-id order; no pick or miss line.
  const answered: any[] = [];
  for (const c of cases) {
    const startedAt = Date.now();
    const reply = await client.ask({
      questionSet: { state: c.state, questions: [question] }, kind, model, caller: 'advise', record: false, timeoutMs: adviceRegistry.timeoutMs,
    });
    const latencyMs = Number.isFinite(reply?.durationMs) ? reply.durationMs : Date.now() - startedAt;
    const answer = reply?.status === 'answered' ? reply.answers?.[0] : null;
    answered.push(answer
      ? { id: c.id, label: c.label, rule: c.rule, model: answer.pick, strength: answer.strength?.word, latencyMs }
      : { id: c.id, label: c.label, rule: c.rule, model: null, failure: FAILURE_OF[reply?.reason] || 'unreachable', latencyMs });
  }

  // 6. Figures, standing, and the stored entry for this project, kind and model build.
  const optionNames = question.type === 'yesno' ? ['yes', 'no'] : Object.keys(question.options || {});
  const metrics = score(answered, { options: optionNames, bars: bars.bars, budgetMs });
  const judged = judge(metrics, bars.bars, budgetMs, source);
  const setDigest = caseSetDigest(eligible.cases);
  const key = projectKey(projectRoot);
  const entry = modelDigest
    ? readResults({ roots }).find((item: any) => item.kind === kind && item.modelDigest === modelDigest && item.caseSet.projectKey === key)
    : null;
  const stored = !entry ? 'none' : entry.caseSet.digest === setDigest ? 'same case set' : 'case set changed';

  // 7. The write, when asked and not refused.
  let written = false;
  let refused: string | null = null;
  let writeMessage: string | null = null;
  if (options.write === true) {
    const { worseIds, perClass, labelCounts, ...figures } = metrics;
    try {
      writeResult({
        roots,
        entry: {
          kind, provider: provider.id, model, modelDigest,
          questionDigest: questionDigest(question), builderDigest: builderDigest(source, registryKind), barsDigest: barsDigest(bars.bars, budgetMs),
          caseSet: { source: source.id, origin: source.origin, projectKey: key, digest: setDigest, eligible: eligible.cases.length, replayed: cases.length },
          metrics: figures, runAt: new Date().toISOString(), doflowVersion: doflowVersion(),
        },
      });
      written = true;
    } catch (error: any) {
      refused = error?.code === 'results-locked' || error?.code === 'results-lock-lost' ? error.code : 'store-invalid';
      writeMessage = error?.message || 'result not stored';
    }
  }

  const { worseIds, ...shown } = metrics;
  const result = {
    schema: 1, kind, provider: provider.id, model, modelDigest, source: source.id,
    caseSet: { eligible: eligible.cases.length, replayed: cases.length, digest: setDigest, skipped: eligible.skipped },
    metrics: shown, standing: judged.standing, failedChecks: judged.failedChecks, worseIds: worseIds.slice(0, MAX_WORSE_IDS),
    stored, written, refused,
  };
  if (json) {
    console.log(JSON.stringify(options.warnings?.length ? { ...result, warnings: options.warnings } : result, null, 2));
  } else {
    console.log(renderText({ ...result, origin: source.origin, yesno: question.type === 'yesno', budgetMs, resultsFile: resultsFile(roots) }));
    if (writeMessage) console.error(`advise: ${writeMessage}`);
  }
  return finishRuntime(options.write === true && !written ? 1 : 0);
}

module.exports = { handleReplay, writeRefusal };
