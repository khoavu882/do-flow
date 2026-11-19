'use strict';

// Row 176 (design §9 steps 2-3, §10 model check, §12): the one call site of every same-issue decision, shared by
// `review --action similar` and `followup --action list --similar`. It batches the rule stage's candidate pairs by the
// kind's `params.questionsPerCall`, asks every batch at once through the dispatcher with a show surface, and returns the
// model's answer per pair only when every batch was shown. The decision's project is the lifecycle root, the main checkout
// also from a linked worktree (owner ruling O-3 (a)). It only asks and returns: it writes, merges, settles and reorders nothing.

const { REPO_ROOT } = require('../../../helper/repo-root.ts');
const { projectRoot } = require('../../lifecycle/root.ts');
const { loadAdviceRegistry } = require('../registry.ts');
const { materializeKind } = require('../kinds.ts');
const { buildBatch, splitBatch } = require('../batch.ts');
const { interceptDecisionPoint } = require('../shadow-dispatcher.ts');
const { withAdviceServices } = require('../services.ts');
const { itemText, pairState } = require('./rule.ts');

interface Pair { a: string; b: string; score: number; rule: 'yes' | 'no'; key: string }
interface CheckedPair { a: string; b: string; score: number; rule: 'yes' | 'no'; model: 'yes' | 'no' | null; noAnswer: string | null }
interface CheckResult { shown: boolean; mode: string; reason: string | null; batches: number; pairs: CheckedPair[] }

/** The same-issue kind's registry entry and question, or why there is none. */
function sameIssueKind(adviceRegistry: any): { ok: true; registry: any; params: any; question: any } | { ok: false; reason: string } {
  let registry = adviceRegistry;
  if (!registry) {
    const loaded = loadAdviceRegistry({ repoRoot: REPO_ROOT });
    if (!loaded.ok) return { ok: false, reason: 'core/registry/advice.json could not be loaded' };
    registry = loaded.registry;
  }
  const built = materializeKind('same-issue', { adviceRegistry: registry });
  if (!built.ok) return { ok: false, reason: built.detail };
  return { ok: true, registry, params: registry.kinds.find((kind: any) => kind.id === 'same-issue').params, question: built.question };
}

/**
 * Asks the model about `pairs` (candidatePairs output, in its order) over `items` (id -> text and locator). Batches of 1 to
 * questionsPerCall pairs, one decision each, all started together, so a shown command waits at most one budgetMs. `shown`
 * only when every batch resolved `show`; then each pair carries the model's yes or no, or the reason it gave none. Otherwise
 * every `model` is null and `reason` is the first batch not shown's warning or its mode. No pairs: no call.
 */
async function checkPairs({ kind: kindAsked, pairs, items, caller, cwd, env, adviceRegistry, services }: {
  kind: 'same-issue'; pairs: Pair[]; items: Map<string, { text: string; locator?: string | null }>; caller: 'review' | 'followup'; cwd: string;
  env?: Record<string, string | undefined>; adviceRegistry?: any; services?: any;
}): Promise<CheckResult> {
  // Each caller names the kind at its call (`kind: 'same-issue', caller: '<caller>'`), so the call site shows what it dispatches.
  if (kindAsked !== 'same-issue') throw new TypeError(`checkPairs asks the same-issue kind only (got '${kindAsked}')`);
  const unasked = pairs.map(({ a, b, score, rule }) => ({ a, b, score, rule, model: null, noAnswer: null }));
  if (pairs.length === 0) return { shown: false, mode: 'off', reason: 'no candidate pairs', batches: 0, pairs: [] };
  const kind = sameIssueKind(adviceRegistry);
  if (!kind.ok) return { shown: false, mode: 'off', reason: kind.reason, batches: 0, pairs: unasked };

  const { registry, params, question } = kind;
  const root = projectRoot(cwd);
  // The client and store roots of the decision's project and env; an injected `services` field wins (a test seam).
  const dispatcherServices = withAdviceServices({ svc: services ?? {}, adviceRegistry: registry, projectRoot: root, env });
  const item = (id: string) => ({ id, text: itemText(items.get(id)!.text, params.itemBytes), locator: items.get(id)!.locator ?? null });
  const groups: Pair[][] = [];
  for (let start = 0; start < pairs.length; start += params.questionsPerCall) groups.push(pairs.slice(start, start + params.questionsPerCall));

  const asked = await Promise.all(groups.map(async (group) => {
    const questionSet = buildBatch({ question, states: group.map((pair) => pairState(item(pair.a), item(pair.b))), questionsPerCall: params.questionsPerCall });
    const staticPicks = group.map((pair) => pair.rule);
    const resolution = await interceptDecisionPoint({
      kind: 'same-issue', caller, state: questionSet.state, staticPick: staticPicks[0], staticPicks, taskId: null,
      projectRoot: root, env, questionSet, adviceRegistry: registry, surface: 'show',
    }, dispatcherServices);
    return { questionSet, resolution };
  }));

  const unshown = asked.find(({ resolution }) => resolution.mode !== 'show');
  if (unshown) {
    const { mode, warning } = unshown.resolution;
    return { shown: false, mode, reason: warning ?? mode, batches: groups.length, pairs: unasked };
  }
  // The dispatcher gives each question's pick and strength word; splitBatch reads them back by question name. A call that
  // answered nothing gave no reason with it, so its pairs carry splitBatch's `unavailable`.
  const answers = asked.flatMap(({ questionSet, resolution }) => splitBatch({
    status: resolution.advisorAnswers.some(Boolean) ? 'answered' : 'unavailable',
    answers: resolution.advisorAnswers.map((answer: any, index: number) => answer && {
      name: questionSet.questions[index].name, pick: answer.pick, strength: { word: answer.strength },
    }),
  }, questionSet.questions.length));
  return {
    shown: true, mode: 'show', reason: asked[0].resolution.warning ?? null, batches: groups.length,
    pairs: unasked.map((pair, index) => ({ ...pair, model: answers[index].pick as 'yes' | 'no' | null, noAnswer: answers[index].noAnswer })),
  };
}

module.exports = { checkPairs };
