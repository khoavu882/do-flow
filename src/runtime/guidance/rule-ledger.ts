'use strict';

/**
 * Row 181 (IC-019): the rule detection grammar and the cover check of the rule ledger. Pure and
 * read-only: `findRuleLines` finds the lines of visible Markdown that read as a rule, and
 * `coverRuleLines` maps each hit to the ledger rows whose statement spans it. A hit no row spans,
 * or two rows span, is a finding with a `path:line` locator.
 */

const { proseLines } = require('../plan-content.ts');

export type RuleLine = { line: number; text: string };
export type CoverFinding = { kind: 'uncovered' | 'double-covered'; path: string; line: number; text: string; rows: string[] };

/** The audit's keyword set (IC-019). */
const RULE_KEYWORDS = /\b(MUST|NEVER|Never|never|Do not|do not|Always|ALWAYS|must)\b/;

/** Every line of visible Markdown (fenced code and HTML comments blanked, as `proseLines` does;
 * inline code kept) that matches the keyword set. `line` is 1-based. */
function findRuleLines(text: string): RuleLine[] {
  const hits: RuleLine[] = [];
  proseLines(text, { keepCode: true }).forEach((line: string, index: number) => {
    if (RULE_KEYWORDS.test(line)) hits.push({ line: index + 1, text: line.trim() });
  });
  return hits;
}

/** The statement normalisation G71 applies (test/guards/guidance-rules-registry.test.ts): markup
 * characters dropped, case folded; here whitespace is dropped too instead of collapsed, so a
 * statement still matches where inline markup left a stray space ("`main`;" against "main;"). Every
 * output character keeps the 1-based source line it came from, so a match becomes a line span. */
function normalise(text: string): { s: string; lines: number[] } {
  let s = '';
  const lines: number[] = [];
  let line = 1;
  for (const ch of text) {
    if (!/[*#`_:\s]/.test(ch)) { const low = ch.toLowerCase(); s += low; for (let i = 0; i < low.length; i++) lines.push(line); }
    if (ch === '\n') line++;
  }
  return { s, lines };
}

/** The line span of a statement in a source text, or null. Tries the whole statement, then the
 * text after its first ':' (G71's "header: body" fallback). */
function spanOf(source: { s: string; lines: number[] }, statement: string): [number, number] | null {
  const whole = normalise(statement).s;
  const body = statement.includes(':') ? normalise(statement.split(':').slice(1).join(':')).s : '';
  for (const needle of [whole, body]) {
    if (!needle) continue;
    const at = source.s.indexOf(needle);
    if (at !== -1) return [source.lines[at], source.lines[at + needle.length - 1]];
  }
  return null;
}

/** Map each rule line of each file to the ledger rows whose statement spans it. `files` is
 * `[{ path, text }]` with `path` as the ledger writes `sourceFile`; `ledger` is `{ rules: [{ id,
 * statement, sourceFile }] }`. Returns the findings in file then line order. A row whose statement
 * is not in its file covers nothing; G71 reports that row. A statement found more than once in
 * its file is read at its first occurrence. */
function coverRuleLines(files: Array<{ path: string; text: string }>, ledger: { rules: Array<{ id: string; statement: string; sourceFile: string }> }): CoverFinding[] {
  const findings: CoverFinding[] = [];
  for (const file of files) {
    const source = normalise(file.text);
    const spans: Array<{ id: string; from: number; to: number }> = [];
    for (const row of ledger.rules) {
      if (row.sourceFile !== file.path) continue;
      const span = spanOf(source, row.statement);
      if (span) spans.push({ id: row.id, from: span[0], to: span[1] });
    }
    for (const hit of findRuleLines(file.text)) {
      const rows = spans.filter((s) => s.from <= hit.line && hit.line <= s.to).map((s) => s.id);
      if (rows.length === 1) continue;
      findings.push({ kind: rows.length === 0 ? 'uncovered' : 'double-covered', path: file.path, line: hit.line, text: hit.text, rows });
    }
  }
  return findings;
}

module.exports = { findRuleLines, coverRuleLines };
