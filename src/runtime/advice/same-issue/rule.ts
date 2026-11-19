'use strict';

// Row 176 IC-002: the rule stage of the same-issue kind. It scores every pair of items by shared words and picks the
// candidate pairs the model is asked about; the model never sees the rest. Pure: no file, network, clock or process.

const crypto = require('node:crypto');

interface SameIssueItem { id: string; text: string; locator?: string | null }
interface Pair { a: string; b: string; score: number; rule: 'yes' | 'no'; key: string }
interface RuleParams {
  perItem: number;
  maxPairs: number;
  candidateAtPct: number;
  flagAtPct: number;
  locatorBonusPct: number;
  [field: string]: unknown;
}

const MARK = '[…]';
/** Words too common to say what an item is about; frozen, short on purpose. */
const STOP_WORDS: ReadonlySet<string> = Object.freeze(new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'any', 'can', 'was', 'with', 'this', 'that', 'from', 'have',
  'has', 'its', 'when', 'than', 'then', 'into', 'will', 'would', 'should', 'could',
]));

/** Whitespace runs become one space; text over `itemBytes` UTF-8 bytes is cut at a code point and ends in `[…]`, within `itemBytes`. */
function itemText(raw: string, itemBytes: number): string {
  const text = String(raw).replace(/\s+/g, ' ').trim();
  if (Buffer.byteLength(text, 'utf8') <= itemBytes) return text;
  let room = itemBytes - Buffer.byteLength(MARK, 'utf8');
  let kept = '';
  for (const point of text) {
    const size = Buffer.byteLength(point, 'utf8');
    if (size > room) break;
    kept += point;
    room -= size;
  }
  return kept + MARK;
}

/** The words of `text`: NFKC, lower case, split on non letters or digits, three code points or more, stop words out, plurals folded. */
function tokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of String(text).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if ([...word].length < 3 || STOP_WORDS.has(word)) continue;
    out.add(word.endsWith('ies') ? `${word.slice(0, -3)}y` : word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
  }
  return out;
}

function fileOf(locator: string | null | undefined): string {
  return typeof locator === 'string' ? locator.split(/[:#]/, 1)[0].trim() : '';
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function bonusOf(a: SameIssueItem, b: SameIssueItem, params: RuleParams): number {
  const file = fileOf(a.locator);
  return file !== '' && file === fileOf(b.locator) ? params.locatorBonusPct / 100 : 0;
}

/** Jaccard of the two token sets, plus the locator bonus when both name the same file; nothing is rounded. */
function score(a: SameIssueItem, b: SameIssueItem, params: RuleParams): number {
  return jaccard(tokens(a.text), tokens(b.text)) + bonusOf(a, b, params);
}

/** First 16 hex of sha256(min id, newline, max id): the same in either order. */
function pairKey(idA: string, idB: string): string {
  const [low, high] = idA < idB ? [idA, idB] : [idB, idA];
  return crypto.createHash('sha256').update(`${low}\n${high}`).digest('hex').slice(0, 16);
}

function byScoreThenKey(left: Pair, right: Pair): number {
  return right.score - left.score || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
}

/** Every unordered pair, scored; with `among`, only pairs touching one of its ids. */
function scoredPairs(items: SameIssueItem[], params: RuleParams, among?: Set<string>): Pair[] {
  const words = items.map((item) => tokens(item.text));
  const pairs: Pair[] = [];
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (among && !among.has(items[i].id) && !among.has(items[j].id)) continue;
      const [first, second] = items[i].id < items[j].id ? [items[i], items[j]] : [items[j], items[i]];
      const value = jaccard(words[i], words[j]) + bonusOf(items[i], items[j], params);
      pairs.push({ a: first.id, b: second.id, score: value, rule: value >= params.flagAtPct / 100 ? 'yes' : 'no', key: pairKey(first.id, second.id) });
    }
  }
  return pairs;
}

/** The pairs the model is asked about: each item's `perItem` best at `candidateAtPct` or more, joined, best first, `maxPairs` of them. */
function candidatePairs(items: SameIssueItem[], params: RuleParams, { among }: { among?: Set<string> } = {}): Pair[] {
  const bar = params.candidateAtPct / 100;
  const touching = new Map<string, Pair[]>();
  for (const pair of scoredPairs(items, params, among)) {
    if (pair.score < bar) continue;
    for (const id of [pair.a, pair.b]) {
      if (!touching.has(id)) touching.set(id, []);
      touching.get(id)!.push(pair);
    }
  }
  const kept = new Map<string, Pair>();
  for (const list of touching.values()) {
    for (const pair of list.sort(byScoreThenKey).slice(0, params.perItem)) kept.set(pair.key, pair);
  }
  return [...kept.values()].sort(byScoreThenKey).slice(0, params.maxPairs);
}

/** The state of one case: the two item texts as given (callers pass `itemText` output). */
function pairState(a: SameIssueItem, b: SameIssueItem): string {
  return `first: ${a.text}\nsecond: ${b.text}`;
}

module.exports = { itemText, tokens, score, candidatePairs, pairState, pairKey };
