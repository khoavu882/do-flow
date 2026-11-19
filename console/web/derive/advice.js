// The Advice view's derivations (feature 151, plan task C.2; IC-018, FR-015, FR-026; row 175 IC-010): the local-result
// sentences, the followed counts and the agreement figures over the `advise-report` projection, and the picks-per-day
// rows over the `advice-picks` days (console/src/project.ts, IC-008). No DOM and no fetch, so
// console/test/derive-manage.test.ts runs them as plain functions. A day the core could not read fully is never counted
// as 0: its count is null, which the view shows as unknown.

const isObject = (/** @type {any} */ value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/** A kind id, from an id string or a report `kinds[]` row; null otherwise. @param {any} entry */
const kindOf = (entry) => (typeof entry === 'string' && entry !== '' ? entry : isObject(entry) && typeof entry.kind === 'string' && entry.kind !== '' ? entry.kind : null);

/** The kind ids of a list, in its order, each once. @param {any} kinds */
function kindIds(kinds) {
  /** @type {string[]} */
  const ids = [];
  for (const entry of Array.isArray(kinds) ? kinds : []) {
    const kind = kindOf(entry);
    if (kind !== null && !ids.includes(kind)) ids.push(kind);
  }
  return ids;
}

/** @param {number} n @param {string} one @param {string} many */
const plural = (n, one, many) => (n === 1 ? one : many);

/** @type {Record<string, string>} what a standing `judge` gives means, in the page's words */
const STANDING_TEXT = {
  act: 'passes the show and act bars',
  show: 'passes the show bar, not the act bar',
  'below-show': 'below the show bar',
  'below-minimum': 'too few cases to judge',
  'measure-only': "measures only: its cases are labelled with the rule's answer, so it never passes",
  unknown: 'cannot be judged now; doflow advise --action report says why',
};
/** @type {Record<string, string>} */
const CASE_SET_TEXT = {
  same: 'Case set unchanged.',
  changed: 'The case set changed since: replay again.',
  'other-project': 'Measured in another project.',
  'not-checked': 'Case set not checked here.',
};

/** `a`, `a and b`, `a, b and c`. @param {string[]} words */
const joined = (words) => (words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words.join(''));

/** The standing of one result, re-judged now: a stale one names the digests that moved. @param {any} row */
function standingText(row) {
  const stale = Array.isArray(row.stale) ? row.stale : [];
  if (row.standing === 'stale') return stale.length ? `stale: the ${joined(stale)} changed since the replay; replay again` : 'stale: replay again';
  const failed = Array.isArray(row.failedChecks) && row.failedChecks.length ? ` (failed: ${row.failedChecks.join(', ')})` : '';
  return `${STANDING_TEXT[row.standing] ?? `standing ${row.standing}`}${failed}`;
}

/**
 * The local-result sentences (175 IC-010): one per stored result, in the body's order, naming the kind, the model, its
 * provider and build, when and on how many cases it was replayed, its standing re-judged now and its case-set state. With
 * no result, the one sentence "No local result is stored for the kinds shown." with kind null.
 * @param {any} results the `advise-report` `localResults[]`
 * @returns {Array<{ kind: string | null, text: string }>}
 */
function localResultSentences(results) {
  const rows = (Array.isArray(results) ? results : []).filter((row) => isObject(row) && kindOf(row) !== null);
  if (rows.length === 0) return [{ kind: null, text: 'No local result is stored for the kinds shown.' }];
  return rows.map((row) => {
    const digest = String(row.modelDigest);
    const build = digest.length > 15 ? `${digest.slice(0, 15)}…` : digest;
    const head = `${row.kind} with ${row.model} (${row.provider}, ${build}), replayed ${String(row.runAt).slice(0, 10)} on ${row.replayed} of ${row.eligible} cases`;
    return { kind: row.kind, text: `${head}: ${standingText(row)}. ${CASE_SET_TEXT[row.caseSet] ?? `Case set ${row.caseSet}.`}` };
  });
}

/** What the person did with the picks they were shown; null (no shown pick) reads as n=0. @param {any} followed */
function followedText(followed) {
  if (!isObject(followed)) return 'no shown pick (n=0)';
  return `followed ${followed.followed}, partly ${followed.partly}, overruled ${followed.overruled}, n=${followed.n} shown picks`;
}

/** @param {any} x */
const two = (x) => (typeof x === 'number' && Number.isFinite(x) ? x.toFixed(2) : 'unknown');

/**
 * "Agreement with what you did" (175 IC-010): the figures over the picks whose label is known, with their n, and the
 * labelled picks only counted. A figure, never a standing. null reads as n=0.
 * @param {any} agreement
 */
function agreementText(agreement) {
  if (!isObject(agreement)) return 'no data (n=0)';
  const m = agreement.figures;
  const text = isObject(m)
    ? `accuracy model ${two(m.accuracy.model)}, rule ${two(m.accuracy.rule)}; kappa model ${two(m.kappa.model)} (lower ${two(m.kappa.lower)}), rule ${two(m.kappa.rule)}; worse ${m.worse}, better ${m.better}; n=${agreement.n}`
    : `no data (n=${agreement.n})`;
  const c = agreement.counted;
  return isObject(c) && c.partly + c.overruledWithoutActual + c.noStaticAnswer > 0
    ? `${text}; counted, not scored: partly ${c.partly}, overruled with no answer named ${c.overruledWithoutActual}, no rule answer ${c.noStaticAnswer}`
    : text;
}

/**
 * The picks-per-day rows (FR-015). Per kind: the read days with picks and their counts, the read days with none ("0 on N
 * days read") and the days not read ("unknown on M days not read"). `table` is the full row table, one row per day in
 * the body's order, with a count per kind: a number on a read day (0 when the day has no entry for the kind), null on a
 * day that is not read.
 * @param {any} days the `advice-picks` `days[]`
 * @param {any} kinds the kind ids to show, in order
 * @returns {{ kinds: Array<{ kind: string, withPicks: Array<{ day: string, n: number }>, zeroDays: number, zeroText: string, unknownDays: number, unknownText: string }>, table: Array<{ day: string, coverage: string, unreadableLines: number, counts: Record<string, number | null> }> }}
 */
function dayRows(days, kinds) {
  const ids = kindIds(kinds);
  const table = (Array.isArray(days) ? days : []).filter((day) => isObject(day) && typeof day.day === 'string').map((day) => {
    const read = day.coverage === 'read';
    const picks = isObject(day.picks) ? day.picks : {};
    /** @type {Record<string, number | null>} */
    const counts = {};
    for (const kind of ids) counts[kind] = read ? (Number.isInteger(picks[kind]) && picks[kind] > 0 ? picks[kind] : 0) : null;
    return { day: day.day, coverage: read ? 'read' : 'unknown', unreadableLines: Number.isInteger(day.unreadableLines) ? day.unreadableLines : 0, counts };
  });
  const perKind = ids.map((kind) => {
    /** @type {Array<{ day: string, n: number }>} */
    const withPicks = [];
    let zeroDays = 0;
    let unknownDays = 0;
    for (const line of table) {
      const n = line.counts[kind];
      if (n === null) unknownDays += 1;
      else if (n === 0) zeroDays += 1;
      else withPicks.push({ day: line.day, n });
    }
    return {
      kind,
      withPicks,
      zeroDays,
      zeroText: `0 on ${zeroDays} ${plural(zeroDays, 'day', 'days')} read`,
      unknownDays,
      unknownText: `unknown on ${unknownDays} ${plural(unknownDays, 'day', 'days')} not read`,
    };
  });
  return { kinds: perKind, table };
}

export { localResultSentences, followedText, agreementText, dayRows };
