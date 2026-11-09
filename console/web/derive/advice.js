// The Advice view's derivations (feature 151, plan task C.2; IC-018, FR-015, FR-017, FR-026): the gate sentences over
// the `advise-report` verdict rows and the picks-per-day rows over the `advice-picks` days (console/src/project.ts,
// IC-008). No DOM and no fetch, so console/test/derive-manage.test.ts runs them as plain functions. A day the core could
// not read fully is never counted as 0: its count is null, which the view shows as unknown.

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

/**
 * The sentence of one verdict row: a pass that is not stale names its model; a stale row reads the core's reason; any
 * other row says no passing verdict ships, with the result the core recorded.
 * @param {string} kind
 * @param {any} row
 */
function verdictText(kind, row) {
  const model = typeof row.model === 'string' ? row.model : 'unknown';
  if (row.stale === true) return typeof row.reason === 'string' && row.reason !== '' ? row.reason : `The bench verdict for ${kind} with ${model} is stale.`;
  if (row.result === 'pass') return `A passing verdict ships for ${kind} with ${model}.`;
  return `No passing bench verdict ships for ${kind}: ${model} reads ${typeof row.result === 'string' ? row.result : 'unknown'}.`;
}

/**
 * The gate sentences (FR-017): per kind of `kinds` (then any other kind a row names), one sentence per verdict row, or
 * "No bench verdict ships for <kind>." when no row names it. With no verdict row at all, the one sentence "No bench
 * verdict ships for any kind." with kind null.
 * @param {any} kinds the kind ids, or the `advise-report` `kinds[]` rows
 * @param {any} verdicts the `advise-report` `verdicts[]` rows
 * @returns {Array<{ kind: string | null, text: string }>}
 */
function gateSentences(kinds, verdicts) {
  const rows = (Array.isArray(verdicts) ? verdicts : []).filter((row) => isObject(row) && kindOf(row) !== null);
  if (rows.length === 0) return [{ kind: null, text: 'No bench verdict ships for any kind.' }];
  const ids = kindIds([...(Array.isArray(kinds) ? kinds : []), ...rows]);
  /** @type {Array<{ kind: string | null, text: string }>} */
  const sentences = [];
  for (const kind of ids) {
    const mine = rows.filter((row) => row.kind === kind);
    if (mine.length === 0) sentences.push({ kind, text: `No bench verdict ships for ${kind}.` });
    for (const row of mine) sentences.push({ kind, text: verdictText(kind, row) });
  }
  return sentences;
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

export { gateSentences, dayRows };
