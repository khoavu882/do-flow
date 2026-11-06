'use strict';

// Rerank question builders and answer interpreters (141 IC-009). Pure: no file, network or clock access, so the
// retrieval hooks, the bench runner and the tests build and read the same questions from the same inputs.
//
// The `choice` arm is one choice question whose options are the candidates (labels A to P); the state is the query
// alone, as the named field `query:`. The `ladder` arm (one score question per candidate) is added to this file by
// plan task B.10: it needs a new branch in `buildRerankQuestionSet` and `interpretRerankAnswers`, and `rerankPayload`
// already carries its `expected` and `confidence` arrays, so no export here changes shape.
//
// A model order is advice only. Any answer that cannot be read returns the first-stage order unchanged, so the
// effective order is never worse than "no model" (FR-013). Nothing returned by `rerankPayload` is text a user wrote:
// ids, numbers and the arm only (NFR-003, DEC-028).

const LABELS = 'ABCDEFGHIJKLMNOP';
const REF_BYTES = 256;
const DIGEST_PATTERN = /^[0-9a-f]{12}$/;
const CHOICE_ARM = 'choice';
const KNOWN_ARMS = [CHOICE_ARM, 'ladder'];

function isFiniteNumber(value: any): boolean {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCount(value: any): boolean {
  return Number.isInteger(value) && value >= 0;
}

/** Runs of whitespace become one space and the ends are trimmed, so a value fits on one state line. */
function collapseWhitespace(value: any): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

function codePointBytes(codePoint: number): number {
  if (codePoint <= 0x7f) return 1;
  if (codePoint <= 0x7ff) return 2;
  // A lone surrogate encodes as the 3-byte replacement character, as Buffer.from does.
  if (codePoint <= 0xffff) return 3;
  return 4;
}

/** Cuts `text` to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function cutBytes(text: string, maxBytes: number): { text: string; cut: boolean } {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, cut: false };
  let bytes = 0;
  let end = 0;
  for (const char of text) {
    const size = codePointBytes(char.codePointAt(0) as number);
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += char.length;
  }
  return { text: text.slice(0, end), cut: true };
}

function paramsUsable(params: any): boolean {
  return !!params && typeof params === 'object'
    && Number.isInteger(params.minCandidates) && params.minCandidates >= 1
    && Number.isInteger(params.maxCandidates) && params.maxCandidates >= params.minCandidates
    && Number.isInteger(params.candidateBytes) && params.candidateBytes >= 1
    && Number.isInteger(params.queryBytes) && params.queryBytes >= 1;
}

/**
 * Builds the question set for one rerank call.
 *
 * `candidates` is `[{ ref, title, text }]` in first-stage order; only the first `params.maxCandidates` (and never more
 * than the 16 labels) are used. Returns `{ ok: true, arm, questionSet, labels, refs, truncated }` or `{ ok: false, reason }`.
 */
function buildRerankQuestionSet({ query, candidates, params, arm, criteria, limits }: any = {}): any {
  if (!KNOWN_ARMS.includes(arm)) return { ok: false, reason: 'unknown-arm' };
  if (arm !== CHOICE_ARM) return { ok: false, reason: 'arm-not-built' };
  if (!paramsUsable(params)) return { ok: false, reason: 'bad-params' };
  const instruction = criteria && criteria.choiceInstruction;
  if (typeof instruction !== 'string' || !instruction.trim()) return { ok: false, reason: 'bad-criteria' };

  const queryText = collapseWhitespace(query);
  if (!queryText) return { ok: false, reason: 'empty-query' };

  const pool = Array.isArray(candidates) ? candidates : [];
  const used = pool.slice(0, Math.min(params.maxCandidates, LABELS.length));
  if (used.length < params.minCandidates) return { ok: false, reason: 'too-few-candidates' };

  const labels: string[] = [];
  const refs: string[] = [];
  const options: Record<string, string> = {};
  let truncated = 0;
  used.forEach((candidate: any, index: number) => {
    const label = LABELS[index];
    const ref = typeof candidate?.ref === 'string' ? candidate.ref : '';
    const body = collapseWhitespace(candidate?.text) || `(no text) ${ref}`;
    const cut = cutBytes(collapseWhitespace(`${collapseWhitespace(candidate?.title)}\n${body}`), params.candidateBytes);
    if (cut.cut) truncated += 1;
    labels.push(label);
    refs.push(ref);
    options[label] = cut.text;
  });

  const state = `query: ${cutBytes(queryText, params.queryBytes).text}`;
  const maxStateBytes = limits && limits.maxStateBytes;
  if (isCount(maxStateBytes) && Buffer.byteLength(state, 'utf8') > maxStateBytes) {
    return { ok: false, reason: 'state-too-large' };
  }

  return {
    ok: true,
    arm: CHOICE_ARM,
    questionSet: {
      state,
      questions: [{ name: 'rerank', type: 'choice', instructions: instruction, options }],
    },
    labels,
    refs,
    truncated,
  };
}

/** The probability for one label from a choice answer: an object keyed by label (the provider's shape) or an array. */
function choiceProbability(probabilities: any, label: string, index: number): any {
  if (Array.isArray(probabilities)) return probabilities[index];
  if (probabilities && typeof probabilities === 'object' && Object.hasOwn(probabilities, label)) return probabilities[label];
  return undefined;
}

function interpretChoice(answers: any, labels: string[]): any {
  const answer = Array.isArray(answers) ? answers[0] : null;
  if (!answer || typeof answer !== 'object') return null;
  const values = labels.map((label, index) => choiceProbability(answer.probabilities, label, index));
  if (values.some((value) => !isFiniteNumber(value) || value < 0 || value > 1)) return null;
  // Probabilities order the labels and nothing else: they need not sum to 1 (the 2026-11-06 probe summed to
  // 1.0000000000000002). Ties keep first-stage rank, which is the index.
  const order = labels
    .map((label, index) => ({ label, index, value: values[index] }))
    .sort((a, b) => (b.value - a.value) || (a.index - b.index))
    .map((entry) => entry.label);
  return { valid: true, order, top1Changed: order[0] !== labels[0], expected: null, confidence: null };
}

/**
 * Reads the model's answers into an order of `labels`. Anything unreadable returns the first-stage order unchanged with
 * `valid: false`, so the effective order is always usable.
 */
function interpretRerankAnswers(answers: any, labels: any, arm: any): any {
  const first = Array.isArray(labels) ? labels.slice() : [];
  const fallback = { valid: false, order: first, top1Changed: false, expected: null, confidence: null };
  if (first.length === 0) return fallback;
  const read = arm === CHOICE_ARM ? interpretChoice(answers, first) : null;
  return read || fallback;
}

function isPermutation(order: any, labels: string[]): boolean {
  return Array.isArray(order) && order.length === labels.length
    && new Set(order).size === labels.length && order.every((label: any) => labels.includes(label));
}

function numbersOrNull(values: any, n: number): number[] | null {
  return Array.isArray(values) && values.length === n && values.every(isFiniteNumber) ? values.slice() : null;
}

/**
 * The `rerank` object of the pick line (IC-007). Ids, numbers and the arm only: a ref is cut to 256 bytes, the criteria
 * digest is kept only when it is 12 hex characters, and no query, candidate or criteria text is accepted as input.
 */
function rerankPayload({ arm, labels, refs, order, truncated, params, firstStageMs, expected, confidence, criteriaDigest }: any = {}): any {
  const first: string[] = Array.isArray(labels) ? labels.slice() : [];
  const effective = isPermutation(order, first) ? order.slice() : first;
  const payload: any = {
    arm: KNOWN_ARMS.includes(arm) ? arm : CHOICE_ARM,
    n: first.length,
    refs: (Array.isArray(refs) ? refs : []).map((ref: any) => cutBytes(typeof ref === 'string' ? ref : '', REF_BYTES).text),
    order: effective,
    truncated: isCount(truncated) ? truncated : 0,
    candidateBytes: params && isCount(params.candidateBytes) ? params.candidateBytes : null,
    top1Changed: effective.length > 0 && effective[0] !== first[0],
    firstStageMs: isFiniteNumber(firstStageMs) && firstStageMs >= 0 ? Math.round(firstStageMs) : null,
    criteriaDigest: typeof criteriaDigest === 'string' && DIGEST_PATTERN.test(criteriaDigest) ? criteriaDigest : null,
  };
  if (arm !== CHOICE_ARM) {
    payload.expected = numbersOrNull(expected, first.length);
    payload.confidence = numbersOrNull(confidence, first.length);
  }
  return payload;
}

module.exports = {
  LABELS,
  buildRerankQuestionSet,
  interpretRerankAnswers,
  rerankPayload,
  collapseWhitespace,
  cutBytes,
};
