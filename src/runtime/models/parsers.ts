'use strict';

// The closed set of parsers for `worker.modelList.parse` (core/registry/harnesses.json): pure functions
// from a harness CLI's listing output to `[{ id, displayName? }]`. A parse id outside this set is
// refused by `parserFor`, and test/runtime/models/list-models.test.ts holds every registry `parse` to it.

const { PROVIDER_RE, EFFORT_RE, LEVELS_MAX, COLUMN_TARGETS } = require('../../registry/model-parts.ts');

export interface ListedModel {
  id: string; displayName?: string;
  provider?: string; contextTokens?: number; maxOutputTokens?: number; reasoning?: boolean; imageInput?: boolean; effortLevels?: string[];
}
/** What a parse reports beyond the models (169 §6.1): the `columns` targets whose header the listing had, and the
 * rows and cells a `columns` listing could not use. */
export interface ParseTally { columnFaults: number; columns?: string[] }
export type ListParser = (text: string, tally?: ParseTally) => ListedModel[];

/** Every terminal escape form a CLI can print: OSC (title, OSC 8 hyperlink) ended by BEL or ST, DCS/SOS/PM/APC strings (none runs past its line),
 * CSI, a two-character ESC sequence, and the 8-bit C1 forms of each (0x9b, 0x9d, 0x90, 0x98, 0x9e, 0x9f). */
const ESCAPES = new RegExp([
  '(?:\\u001b\\]|\\u009d)[^\\u0007\\u001b\\u009c\\n\\r]*(?:\\u0007|\\u001b\\\\|\\u009c)?',
  '(?:\\u001b[PX^_]|[\\u0090\\u0098\\u009e\\u009f])[^\\u001b\\u009c\\n\\r]*(?:\\u001b\\\\|\\u009c)?',
  '(?:\\u001b\\[|\\u009b)[0-?]*[ -/]*[@-~]?',
  '\\u001b[ -~]?',
].join('|'), 'g');
/** What is left of a control character after the escapes: C0 (the tab and the line ends are handled by the parsers), DEL, C1. */
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
/** Line and paragraph separators and the bidirectional controls, which change how a name reads on screen. */
const INVISIBLE = /[\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const NAME_MAX = 120;

/** A name for display: no control or invisible character, no escape sequence, at most 120 characters. */
function cleanName(text: string): string {
  return String(text ?? '').replace(ESCAPES, '').replace(CONTROLS, '').replace(/[\t\r\n]/g, ' ').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX);
}

/** The text's lines, escapes and controls removed. A bare CR also ends a line (a CR-rewritten progress line is not one id). */
function rows(text: string): string[] {
  return String(text ?? '').replace(ESCAPES, '').split(/\r\n|[\n\r\u2028\u2029]/).map((line) => line.replace(CONTROLS, '').replace(INVISIBLE, '').replace(/\s+$/, '')).filter((line) => line.trim() !== '');
}

/** One entry per (provider, id): the same id under two providers is two models. */
function unique(models: ListedModel[]): ListedModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    const key = `${model.provider ?? ''}\u0000${model.id}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

/** One id per non-empty line (the whole trimmed line). A line with whitespace in it is a log or hint line, not an id. */
function parseLines(text: string): ListedModel[] {
  return unique(rows(text).map((line) => line.trim()).filter((line) => !/\s/.test(line)).map((id) => ({ id })));
}

/** `<id>\t<display name>` per line; a line with no tab is progress text, not a model, and is skipped. */
function parseTsvFirstColumn(text: string): ListedModel[] {
  const found: ListedModel[] = [];
  for (const line of rows(text)) {
    if (!line.includes('\t')) continue;
    const [id, ...rest] = line.split('\t');
    const name = cleanName(rest.join('\t'));
    if (id.trim()) found.push(name ? { id: id.trim(), displayName: name } : { id: id.trim() });
  }
  return unique(found);
}

const SIZE_RE = /^(\d+(?:\.\d+)?)([KkMm]?)$/;
const SIZE_UNIT: Record<string, number> = { '': 1, k: 1000, m: 1000000 };
const YES_NO: Record<string, boolean> = { yes: true, true: true, no: false, false: false };

/** A cell through the fixed converter of its target (design §4.3), or undefined when it does not convert. */
function convertCell(kind: string, cell: string): string | number | boolean | string[] | undefined {
  if (kind === 'token') return PROVIDER_RE.test(cell) ? cell : undefined;
  if (kind === 'cleanName') return cleanName(cell) || undefined;
  if (kind === 'size') {
    const match = SIZE_RE.exec(cell);
    return match ? Math.round(Number(match[1]) * SIZE_UNIT[match[2].toLowerCase()]) : undefined;
  }
  if (kind === 'yes-no') return YES_NO[cell.toLowerCase()];
  if (kind === 'comma-list') {
    const levels = cell.split(',');
    return levels.length <= LEVELS_MAX && levels.every((level) => EFFORT_RE.test(level)) ? [...new Set(levels)] : undefined;
  }
  return undefined;
}

/** A header row of whitespace-separated column names, then one row per model; takes the column named
 * `name` (the id has no spaces, so a split on whitespace finds it). A text with no such header gives none.
 * With `columns` (target field -> header name) each row's other cells are converted into the model; a row whose
 * cell count differs from the header's keeps its id and no column, and a cell that does not convert is left out
 * of that model, each counted in `tally.columnFaults`. */
function parseTableColumn(text: string, name: string, columns: Record<string, string> = {}, tally?: ParseTally): ListedModel[] {
  const lines = rows(text);
  const header = lines.findIndex((line) => line.trim().split(/\s+/).includes(name));
  if (header < 0) return [];
  const names = lines[header].trim().split(/\s+/);
  const at = names.indexOf(name);
  const targets = Object.entries(columns).filter(([, headerName]) => names.includes(headerName));
  if (tally && targets.length) tally.columns = targets.map(([target]) => target);
  const found: ListedModel[] = [];
  for (const line of lines.slice(header + 1)) {
    const cells = line.trim().split(/\s+/);
    const id = cells[at];
    if (!id) continue;
    const model: any = { id };
    if (targets.length && cells.length !== names.length) { if (tally) tally.columnFaults += 1; }
    else {
      for (const [target, headerName] of targets) {
        const value = convertCell(COLUMN_TARGETS[target], cells[names.indexOf(headerName)]);
        if (value === undefined) { if (tally) tally.columnFaults += 1; } else model[target] = value;
      }
    }
    found.push(model);
  }
  return unique(found);
}

/** `providerInId`: each id is split at its first `separator`; the left part is the provider, the right the id. An id
 * without the separator, or whose left part is not a provider name or whose right part is empty, stays whole with no provider. */
function splitProviders(models: ListedModel[], separator: string | undefined): ListedModel[] {
  if (!separator) return models;
  return unique(models.map((model) => {
    const cut = model.id.indexOf(separator);
    const provider = cut > 0 ? model.id.slice(0, cut) : '';
    const id = model.id.slice(cut + separator.length);
    return provider && id && PROVIDER_RE.test(provider) ? { ...model, id, provider } : model;
  }));
}

/** The parser for a `worker.modelList` entry (its `parse`, `columns`, `providerInId`), or null when the parse id is not in
 * the closed set. `separator` is `worker.provider.separator`, used by `providerInId`. The parser takes the listing text and
 * an optional tally that it adds its faults to. */
function parserFor(recipe: any, separator?: string): ListParser | null {
  const parse = recipe?.parse;
  const column = typeof parse === 'string' ? /^table-column:([a-z][a-z0-9-]*)$/.exec(parse) : null;
  let base: ListParser;
  if (parse === 'lines') base = parseLines;
  else if (parse === 'tsv-first-column') base = parseTsvFirstColumn;
  else if (column) base = (text, tally) => parseTableColumn(text, column[1], recipe.columns ?? {}, tally);
  else return null;
  return recipe.providerInId === true ? (text, tally) => splitProviders(base(text, tally), separator) : base;
}

module.exports = { cleanName, parseLines, parseTsvFirstColumn, parseTableColumn, parserFor };
