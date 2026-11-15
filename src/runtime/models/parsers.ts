'use strict';

// The closed set of parsers for `worker.modelList.parse` (core/registry/harnesses.json): pure functions
// from a harness CLI's listing output to `[{ id, displayName? }]`. A parse id outside this set is
// refused by `parserFor`, and test/runtime/models/list-models.test.ts holds every registry `parse` to it.

export interface ListedModel { id: string; displayName?: string }

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

function unique(models: ListedModel[]): ListedModel[] {
  const seen = new Set<string>();
  return models.filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)));
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

/** A header row of whitespace-separated column names, then one row per model; takes the column named
 * `name` (the id has no spaces, so a split on whitespace finds it). A text with no such header gives none. */
function parseTableColumn(text: string, name: string): ListedModel[] {
  const lines = rows(text);
  const header = lines.findIndex((line) => line.trim().split(/\s+/).includes(name));
  if (header < 0) return [];
  const at = lines[header].trim().split(/\s+/).indexOf(name);
  const found: ListedModel[] = [];
  for (const line of lines.slice(header + 1)) {
    const cell = line.trim().split(/\s+/)[at];
    if (cell) found.push({ id: cell });
  }
  return unique(found);
}

/** The parser for a registry `parse` id, or null when the id is not in the closed set. */
function parserFor(parse: unknown): ((text: string) => ListedModel[]) | null {
  if (parse === 'lines') return parseLines;
  if (parse === 'tsv-first-column') return parseTsvFirstColumn;
  const column = typeof parse === 'string' ? /^table-column:([a-z][a-z0-9-]*)$/.exec(parse) : null;
  return column ? (text: string) => parseTableColumn(text, column[1]) : null;
}

module.exports = { cleanName, parseLines, parseTsvFirstColumn, parseTableColumn, parserFor };
