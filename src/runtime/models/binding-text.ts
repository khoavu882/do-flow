'use strict';

// 169 IC-005: the one rendering of a model binding, for the brief's Model line, `doflow rules`, `models list` and `bind`,
// `doctor`, and (through the shared fixture test/fixtures/models/binding-text.json) the Console. A cell is the JSON the
// surfaces print: null (the harness default), an `unresolved:<reason>` string, or
// `{model, provider, effort, check: {model, effort}[, effortMayLower: true]}`. Pure.

const MODEL_NOTES: Record<string, string> = {
  unchecked: 'model unchecked',
  'not-listed': 'not in the list',
  'several-providers': 'several providers list it',
};
const EFFORT_NOTES: Record<string, string> = {
  unchecked: 'effort unchecked',
  'not-offered': 'effort not offered by the model',
};
const MAY_LOWER_NOTE = 'the harness may lower the effort';

/**
 * The text of a cell: `harness default`, `unresolved`, or `<model>` then ` (provider <p>, effort <e>)` with only the bound
 * parts, then ` [<notes>]` when any (model note, effort note, then the may-lower note). `code: true` wraps the model id in backticks.
 */
function bindingText(cell: any, { code = false }: { code?: boolean } = {}): string {
  if (cell === null || cell === undefined) return 'harness default';
  if (typeof cell === 'string') return 'unresolved';
  const parts = [
    ...(cell.provider ? [`provider ${cell.provider}`] : []),
    ...(cell.effort ? [`effort ${cell.effort}`] : []),
  ];
  const notes = [
    MODEL_NOTES[cell.check?.model],
    cell.effort ? EFFORT_NOTES[cell.check?.effort] : undefined,
    cell.effort && cell.effortMayLower === true ? MAY_LOWER_NOTE : undefined,
  ].filter(Boolean);
  return `${code ? `\`${cell.model}\`` : cell.model}${parts.length ? ` (${parts.join(', ')})` : ''}${notes.length ? ` [${notes.join(', ')}]` : ''}`;
}

/**
 * The IC-005 cell of a ModelChoice and its checks `{model, effort}` (from `modelCheck` / `effortCheck`); null for no choice.
 * `effortMayLower` (the descriptor's `effort.mayLower`) adds `effortMayLower: true`, only when an effort is bound.
 */
function bindingCell(choice: any, checks: any, { effortMayLower = false }: { effortMayLower?: boolean } = {}): any {
  if (!choice) return null;
  return {
    model: choice.model,
    provider: choice.provider ?? null,
    effort: choice.effort ?? null,
    check: { model: checks?.model ?? 'unchecked', effort: choice.effort ? (checks?.effort ?? 'unchecked') : null },
    ...(effortMayLower && choice.effort ? { effortMayLower: true } : {}),
  };
}

module.exports = { bindingText, bindingCell };
