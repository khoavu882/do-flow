'use strict';

// Row 176 (design §10 IC-008, §12): the model check of `followup --action list --similar`. It lives outside followup.ts,
// whose require closure must reach no model (AC-5), and cli.ts requires it only on the --similar path. The rule stage's
// candidate pairs among the listed items go to checkPairs, the one same-issue call site, with the main checkout as the
// decision's project. A shown check adds a model word to each asked match, and a pair the rule did not match appears only
// on a model yes; otherwise the answer says why nothing was shown. It writes, merges and closes nothing.

const { loadFollowups, comparedItems, sameIssueParams } = require('./followup.ts');
const { itemText, candidatePairs } = require('../advice/same-issue/rule.ts');
const { checkPairs } = require('../advice/same-issue/ask.ts');

/** The model's answer per pair, as the list prints it. */
const MODEL_WORD: Record<string, string> = { yes: 'same-issue', no: 'different' };

/** `answer` (listFollowups with `similar`) plus `modelCheck: { shown, reason }`, and `model` on asked matches when shown. */
async function withModelCheck({ answer, root, cwd, env }: { answer: any; root: string; cwd: string; env?: Record<string, string | undefined> }) {
  const params = sameIssueParams();
  if (!params) return { ...answer, modelCheck: { shown: false, reason: 'core/registry/advice.json could not be read' } };
  const pool = comparedItems(loadFollowups(root).followups, params);
  const eligible = new Set(pool.map((item: any) => item.id));
  const items = new Map(pool.map((item: any) => [item.id, item]));
  for (const item of answer.items) if (!items.has(item.id)) items.set(item.id, { id: item.id, text: itemText(item.statement, params.itemBytes) });
  const listed = new Set<string>(answer.items.map((item: any) => item.id));
  // A pair is worth a question only when one listed end could show the other end as a match.
  const pairs = candidatePairs([...items.values()], params, { among: listed })
    .filter((pair: any) => (listed.has(pair.a) && eligible.has(pair.b)) || (listed.has(pair.b) && eligible.has(pair.a)));
  const check = await checkPairs({ kind: 'same-issue', caller: 'followup', pairs, items, cwd, env });
  if (!check.shown) return { ...answer, modelCheck: { shown: false, reason: check.reason } };

  const asked = new Map<string, any>();
  for (const pair of check.pairs) asked.set(`${pair.a}\n${pair.b}`, pair).set(`${pair.b}\n${pair.a}`, pair);
  const similar = answer.similar.map(({ id, matches }: any) => {
    const words = matches.map((match: any) => {
      const pair = asked.get(`${id}\n${match.id}`);
      return pair ? { ...match, model: MODEL_WORD[pair.model] ?? 'no-answer' } : match;
    });
    const shown = new Set(matches.map((match: any) => match.id));
    for (const pair of check.pairs) {
      const other = pair.a === id ? pair.b : pair.b === id ? pair.a : null;
      if (other && pair.model === 'yes' && !shown.has(other) && eligible.has(other)) words.push({ id: other, score: Math.round(pair.score * 100) / 100, model: 'same-issue' });
    }
    return { id, matches: words };
  });
  return { ...answer, similar, modelCheck: { shown: true, reason: check.reason } };
}

module.exports = { withModelCheck };
