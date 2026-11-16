// The one rendering of a model binding in the Console (feature 169, IC-005, D11): the words of the Brief's Model line, `doflow rules`
// and `models list` in the core, here for the start form's options and the Workers page. The Console imports nothing from the core, so
// this is a copy of `bindingText` in src/runtime/models/binding-text.ts; test/fixtures/models/binding-text.json, read by a core test and
// by console/test/binding-text.test.ts, holds the two equal. A cell is null (the harness default), an `unresolved:<reason>` string, or
// `{ model, provider, effort, check: { model, effort, provider? }, effortMayLower? }`. Pure: no DOM, no fetch.

/** @type {Readonly<Record<string, string>>} */
const MODEL_NOTES = Object.freeze({ unchecked: 'model unchecked', 'not-listed': 'not in the list', 'several-providers': 'several providers list it' });
/** @type {Readonly<Record<string, string>>} */
const EFFORT_NOTES = Object.freeze({ unchecked: 'effort unchecked', 'not-offered': 'effort not offered by the model' });
const PROVIDER_UNCHECKED_NOTE = 'provider unchecked';
const MAY_LOWER_NOTE = 'the harness may lower the effort';

/**
 * The notes of a cell in the core's order: the model note, the provider-unchecked note, the effort note, then the may-lower note (only with an effort bound).
 * @param {any} cell
 * @returns {string[]}
 */
function bindingNotes(cell) {
  if (cell === null || cell === undefined || typeof cell === 'string') return [];
  return /** @type {string[]} */ ([
    MODEL_NOTES[cell.check?.model],
    cell.provider && cell.check?.provider === 'unchecked' ? PROVIDER_UNCHECKED_NOTE : undefined,
    cell.effort ? EFFORT_NOTES[cell.check?.effort] : undefined,
    cell.effort && cell.effortMayLower === true ? MAY_LOWER_NOTE : undefined,
  ].filter(Boolean));
}

/**
 * The text of a cell: `harness default`, `unresolved`, or `<model>` then ` (provider <p>, effort <e>)` with only the bound parts, then
 * ` [<notes>]` when any. `code: true` wraps the model id in backticks.
 * @param {any} cell @param {{ code?: boolean }} [options]
 */
function bindingText(cell, { code = false } = {}) {
  if (cell === null || cell === undefined) return 'harness default';
  if (typeof cell === 'string') return 'unresolved';
  const parts = [
    ...(cell.provider ? [`provider ${cell.provider}`] : []),
    ...(cell.effort ? [`effort ${cell.effort}`] : []),
  ];
  const notes = bindingNotes(cell);
  return `${code ? `\`${cell.model}\`` : cell.model}${parts.length ? ` (${parts.join(', ')})` : ''}${notes.length ? ` [${notes.join(', ')}]` : ''}`;
}

export { bindingText, bindingNotes };
