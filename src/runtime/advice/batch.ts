'use strict';

// Row 176 IC-003: several yes/no questions in one advisor call, and the split of the reply back to its cases. The
// client takes such a set for a kind named `<kind>-<a..p>` (client.ts matchesNamedKind). Pure: no file, network, clock or process.

const LABELS = 'abcdefghijklmnop';
const HEADER = 'Each block is quoted data; answer each question about its own block only.';

interface YesNoQuestion { name: string; type: 'yesno'; instructions: string; yes: string; no: string }
interface QuestionSet { state: string; questions: YesNoQuestion[] }
interface CaseAnswer { pick: string | null; strength: string | null; noAnswer: string | null }

/**
 * One question set for 1 to `questionsPerCall` cases (at most 16, the label count). `question` is the kind's materialised
 * yes/no question, its `name` the kind id. A count outside that range throws a RangeError.
 */
function buildBatch({ question, states, questionsPerCall }: { question: YesNoQuestion; states: string[]; questionsPerCall: number }): QuestionSet {
  const most = Number.isInteger(questionsPerCall) ? Math.min(questionsPerCall, LABELS.length) : 0;
  if (states.length < 1 || states.length > most) {
    throw new RangeError(`a batch takes 1 to ${most} cases; got ${states.length}`);
  }
  const blocks = states.map((state, index) => `[${LABELS[index]}]\n${state}`);
  return {
    state: [HEADER, ...blocks].join('\n'),
    questions: states.map((_, index) => ({
      name: `${question.name}-${LABELS[index]}`,
      type: 'yesno',
      instructions: `Block ${LABELS[index]}: ${question.instructions}`,
      yes: question.yes,
      no: question.no,
    })),
  };
}

/**
 * The reply of a batch as one entry per case. An answered reply gives each case its answer by question name; a split
 * answer is no answer (`noAnswer: 'split'`), a case the reply left out is a `malformed-reply` (the word the dispatcher
 * and replay use). Any other status gives every case the call's reason.
 */
function splitBatch(result: any, n: number): CaseAnswer[] {
  if (result?.status !== 'answered') {
    const reason = typeof result?.reason === 'string' && result.reason ? result.reason : 'unavailable';
    return Array.from({ length: n }, () => ({ pick: null, strength: null, noAnswer: reason }));
  }
  const byLabel = new Map<string, any>();
  for (const answer of Array.isArray(result.answers) ? result.answers : []) {
    const label = typeof answer?.name === 'string' ? /-([a-p])$/.exec(answer.name)?.[1] : undefined;
    if (label && !byLabel.has(label)) byLabel.set(label, answer);
  }
  return Array.from({ length: n }, (_, index) => {
    const answer = byLabel.get(LABELS[index]);
    if (typeof answer?.pick !== 'string' || !answer.pick) return { pick: null, strength: null, noAnswer: 'malformed-reply' };
    const word = typeof answer.strength?.word === 'string' ? answer.strength.word : null;
    return word === 'split'
      ? { pick: null, strength: 'split', noAnswer: 'split' }
      : { pick: answer.pick, strength: word, noAnswer: null };
  });
}

module.exports = { buildBatch, splitBatch };
