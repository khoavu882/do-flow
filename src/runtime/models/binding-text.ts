'use strict';

// 169 IC-005: the one rendering of a model binding, for the brief's Model line, `doflow rules`, `models list` and `bind`,
// `doctor`, and (through the shared fixture test/fixtures/models/binding-text.json) the Console. A cell is the JSON the
// surfaces print: null (the harness default), an `unresolved:<reason>` string, or
// `{model, provider, effort, check: {model, effort[, provider: 'unchecked']}[, effortMayLower: true][, refused: <reason>]}`. Pure.

const MODEL_NOTES: Record<string, string> = {
  unchecked: 'model unchecked',
  'not-listed': 'not in the list',
  'several-providers': 'several providers list it',
};
const EFFORT_NOTES: Record<string, string> = {
  unchecked: 'effort unchecked',
  'not-offered': 'effort not offered by the model',
};
const PROVIDER_UNCHECKED_NOTE = 'provider unchecked';
const MAY_LOWER_NOTE = 'the harness may lower the effort';
const refusedNote = (reason: string) => `dispatch refuses it (${reason})`;

/**
 * The text of a cell: `harness default`, `unresolved`, or `<model>` then ` (provider <p>, effort <e>)` with only the bound
 * parts, then ` [<notes>]` when any (model note, provider-unchecked note, effort note, then the may-lower note, then the refusal). `code: true` wraps the model id in backticks.
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
    cell.provider && cell.check?.provider === 'unchecked' ? PROVIDER_UNCHECKED_NOTE : undefined,
    cell.effort ? EFFORT_NOTES[cell.check?.effort] : undefined,
    cell.effort && cell.effortMayLower === true ? MAY_LOWER_NOTE : undefined,
    typeof cell.refused === 'string' ? refusedNote(cell.refused) : undefined,
  ].filter(Boolean);
  return `${code ? `\`${cell.model}\`` : cell.model}${parts.length ? ` (${parts.join(', ')})` : ''}${notes.length ? ` [${notes.join(', ')}]` : ''}`;
}

/**
 * The IC-005 cell of a ModelChoice and its checks `{model, effort, provider?}` (from `modelCheck` / `effortCheck` / `providerCheck`); null for no choice.
 * `check.provider` is `unchecked` only when a provider is bound and the listing cannot confirm it, and is left out otherwise.
 * `effortMayLower` (the descriptor's `effort.mayLower`) adds `effortMayLower: true`, only when an effort is bound.
 * `refused` (`bindingGap`'s reason) adds `refused: <reason>`, only for a binding dispatch would refuse.
 */
function bindingCell(choice: any, checks: any, { effortMayLower = false, refused = null }: { effortMayLower?: boolean; refused?: string | null } = {}): any {
  if (!choice) return null;
  return {
    model: choice.model,
    provider: choice.provider ?? null,
    effort: choice.effort ?? null,
    check: {
      model: checks?.model ?? 'unchecked',
      effort: choice.effort ? (checks?.effort ?? 'unchecked') : null,
      ...(choice.provider && checks?.provider === 'unchecked' ? { provider: 'unchecked' } : {}),
    },
    ...(effortMayLower && choice.effort ? { effortMayLower: true } : {}),
    ...(refused ? { refused } : {}),
  };
}

module.exports = { bindingText, bindingCell };
