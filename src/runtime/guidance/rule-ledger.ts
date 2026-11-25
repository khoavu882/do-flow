'use strict';

/**
 * Row 181 (IC-019): the rule detection grammar and the cover check of the rule ledger. Pure and
 * read-only: `findRuleLines` finds the lines of visible Markdown that read as a rule, and
 * `coverRuleLines` maps each hit to the ledger rows whose statement spans it. A hit no row spans,
 * or two rows span, is a finding with a `path:line` locator.
 */

const fs = require('node:fs');
const path = require('node:path');
const { proseLines } = require('../plan-content.ts');
const { loadRuleLedger } = require('./ablation.ts');

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

export type RuleFileCounts = { path: string; check: number; judgementOnly: number; notARule: number; neither: number };
export type RuleReport = {
  total: number; check: number; judgementOnly: number; notARule: number; neither: number;
  files: RuleFileCounts[]; uncovered: Array<{ path: string; line: number }>;
};

/** Every `.md` under the 13 skill directories and `core/shared/guidance` (IC-018), as repo-relative
 * `/` paths in sorted order. Symlinks are not followed. */
function ruleSourceFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of fs.readdirSync(path.join(repoRoot, rel), { withFileTypes: true })) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(child);
    }
  };
  const skills = 'core/shared/skills';
  for (const entry of fs.readdirSync(path.join(repoRoot, skills), { withFileTypes: true })) if (entry.isDirectory()) walk(`${skills}/${entry.name}`);
  walk('core/shared/guidance');
  return out.sort();
}

/** A row has a valid enforcement when it satisfies the IC-018 pairing G71 checks: a `check` names an
 * existing file and has no reason; `judgement-only` and `not-a-rule` have no ref and a one-line reason. */
function validEnforcement(row: any, repoRoot: string): boolean {
  if (row.enforcement === 'check') return typeof row.enforcementRef === 'string' && row.enforcementRef.trim() !== '' && fs.existsSync(path.join(repoRoot, row.enforcementRef)) && row.reason === null;
  if (row.enforcement === 'judgement-only' || row.enforcement === 'not-a-rule') return row.enforcementRef === null && typeof row.reason === 'string' && row.reason.trim() !== '' && !/[\r\n]/.test(row.reason);
  return false;
}

/** The IC-020 report for the tree at `repoRoot`: the ledger rows counted by enforcement value, plus
 * every rule line that no row (or more than one row) covers. `neither` is the rows without a valid
 * enforcement plus those lines, so `check + judgementOnly + notARule + neither = total + uncovered.length`.
 * Reads only; the same tree gives the same value. */
function ruleReport(repoRoot: string): RuleReport {
  const ledger = loadRuleLedger({ repoRoot });
  const files = ruleSourceFiles(repoRoot).map((p) => ({ path: p, text: fs.readFileSync(path.join(repoRoot, p), 'utf8') }));
  const uncovered = coverRuleLines(files, ledger).map((f) => ({ path: f.path, line: f.line }));
  const per = new Map<string, RuleFileCounts>();
  const of = (p: string): RuleFileCounts => { let c = per.get(p); if (!c) per.set(p, c = { path: p, check: 0, judgementOnly: 0, notARule: 0, neither: 0 }); return c; };
  const report: RuleReport = { total: ledger.rules.length, check: 0, judgementOnly: 0, notARule: 0, neither: 0, files: [], uncovered };
  for (const row of ledger.rules) {
    const c = of(row.sourceFile);
    if (!validEnforcement(row, repoRoot)) { c.neither++; report.neither++; }
    else if (row.enforcement === 'check') { c.check++; report.check++; }
    else if (row.enforcement === 'judgement-only') { c.judgementOnly++; report.judgementOnly++; }
    else { c.notARule++; report.notARule++; }
  }
  for (const hit of uncovered) { of(hit.path).neither++; report.neither++; }
  report.files = [...per.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return report;
}

/** The text form of a report: one line per enforcement value, `neither`, then one line per file. */
function renderRuleReport(report: RuleReport): string[] {
  return [
    `check ${report.check}`, `judgement-only ${report.judgementOnly}`, `not-a-rule ${report.notARule}`, `neither ${report.neither}`,
    ...report.files.map((f) => `${f.path}: check ${f.check}, judgement-only ${f.judgementOnly}, not-a-rule ${f.notARule}, neither ${f.neither}`),
  ];
}

module.exports = { findRuleLines, coverRuleLines, ruleSourceFiles, ruleReport, renderRuleReport };
