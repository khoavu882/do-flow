'use strict';

// The closed set of parsers for `worker.modelList.parse` (core/registry/harnesses.json): pure functions
// from a harness CLI's listing output to `[{ id, displayName? }]`. A parse id outside this set is
// refused by `parserFor`, and test/runtime/models/list-models.test.ts holds every registry `parse` to it.

export interface ListedModel { id: string; displayName?: string }

const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

function rows(text: string): string[] {
  return String(text ?? '').replace(ANSI, '').split(/\r?\n/).map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim() !== '');
}

function unique(models: ListedModel[]): ListedModel[] {
  const seen = new Set<string>();
  return models.filter((model) => (seen.has(model.id) ? false : (seen.add(model.id), true)));
}

/** One id per non-empty line (the whole trimmed line). */
function parseLines(text: string): ListedModel[] {
  return unique(rows(text).map((line) => ({ id: line.trim() })));
}

/** `<id>\t<display name>` per line; a line with no tab is progress text, not a model, and is skipped. */
function parseTsvFirstColumn(text: string): ListedModel[] {
  const found: ListedModel[] = [];
  for (const line of rows(text)) {
    if (!line.includes('\t')) continue;
    const [id, ...rest] = line.split('\t');
    const name = rest.join('\t').trim();
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

module.exports = { parseLines, parseTsvFirstColumn, parseTableColumn, parserFor };
