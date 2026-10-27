'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Row 134: what a plan says, checked deterministically, beside the task-graph verdict
 * `planVerdict` makes. Each finding carries a `path:line` locator and a severity:
 * - `fix`: the plan has a hole the self-review must close (an untraced requirement id, a placeholder);
 * - `refuses-exit`: the planning stage cannot complete while it stands;
 * - `advisory`: recorded and reported, never blocking.
 * Read-only: nothing here writes.
 */

const fs = require('node:fs');
const path = require('node:path');

type Finding = { rule: string; severity: 'fix' | 'refuses-exit' | 'advisory'; path: string; line: number; message: string; id?: string };

/** The plan's lines with fenced code blanked and HTML comments and inline code spans removed, so
 * a placeholder quoted as an example or left in template guidance is not a finding. Line numbers
 * are kept: index i is line i + 1. */
function proseLines(text: string): string[] {
  const out: string[] = [];
  let fenced = false;
  let comment = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(raw)) { fenced = !fenced; out.push(''); continue; }
    if (fenced) { out.push(''); continue; }
    let line = raw;
    let kept = '';
    while (line.length) {
      if (comment) {
        const end = line.indexOf('-->');
        if (end === -1) { line = ''; break; }
        comment = false;
        line = line.slice(end + 3);
      } else {
        const start = line.indexOf('<!--');
        if (start === -1) { kept += line; break; }
        kept += line.slice(0, start);
        comment = true;
        line = line.slice(start + 4);
      }
    }
    out.push(kept.replace(/`[^`]*`/g, ''));
  }
  return out;
}

const PLACEHOLDERS = [
  /\b(?:TBD|TODO|FIXME)\b/,
  /\bto be (?:decided|determined|defined)\b/i,
  // A deferral verb followed within two words by "later": "implement it later", "fill in later".
  /\b(?:fill in|decide|determine|define|implement|handle|add|sort out|figure out)(?:\s+\S+){0,2}?\s+later\b/i,
];

function placeholderFindings(text: string, displayPath: string): Finding[] {
  const findings: Finding[] = [];
  proseLines(text).forEach((line, index) => {
    const hit = PLACEHOLDERS.map((re) => line.match(re)).find(Boolean);
    if (!hit) return;
    findings.push({
      rule: 'placeholder', severity: 'fix', path: displayPath, line: index + 1,
      message: `'${hit[0]}' is a placeholder: state the decision or the task, or record it as a gap in §3`,
    });
  });
  return findings;
}

const REQUIREMENT_ID = /\b(?:US\d+|FR-\d+|NFR-\d+)\b/;

/** The ids requirement.md defines and still holds live: a user story bullet (`**US1`) or an index
 * row (`| FR-001 |`) whose row is not `Superseded`, read up to the History section. The first
 * defining line of each id is its locator. */
function requirementIds(text: string): Array<{ id: string; line: number }> {
  const ids = new Map<string, number>();
  const lines = proseLines(text);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^##\s+(?:\d+\.\s*)?History\b/i.test(line)) break;
    const story = line.match(/^\s*[-*]\s+\*\*(US\d+)\b/);
    const row = line.match(/^\s*\|\s*((?:FR|NFR)-\d+)\s*\|/);
    const id = story?.[1] || (row && !/\bSuperseded\b/i.test(line) ? row[1] : null);
    if (id && !ids.has(id)) ids.set(id, i + 1);
  }
  return [...ids].map(([id, line]) => ({ id, line }));
}

function coverageFindings(planText: string, planPath: string, requirementText: string, requirementPath: string): Finding[] {
  return requirementIds(requirementText)
    .filter(({ id }) => !new RegExp(`\\b${id}\\b`).test(planText))
    .map(({ id, line }) => ({
      rule: 'coverage', severity: 'fix' as const, path: requirementPath, line, id,
      message: `${id} is not traced anywhere in ${planPath}: name it on the task that delivers it, or on the §7 row that verifies it`,
    }));
}

/** The requirement next to a plan, found the way the path resolver finds it: `intention/`
 * under the structured layout, beside the plan otherwise. */
function requirementBeside(planAbs: string): string | null {
  const dir = path.dirname(planAbs);
  return [path.join(dir, 'intention', 'requirement.md'), path.join(dir, 'requirement.md')].find((f) => fs.existsSync(f)) || null;
}

/** Every content finding for one plan file. Paths are shown relative to `cwd`. */
function planFindings({ planAbs, text, displayPath, cwd }: { planAbs: string; text: string; displayPath: string; cwd: string }): Finding[] {
  const findings = placeholderFindings(text, displayPath);
  const requirement = requirementBeside(planAbs);
  if (requirement) {
    let requirementText = null;
    try { requirementText = fs.readFileSync(requirement, 'utf8'); } catch { /* unreadable: no coverage claim either way */ }
    if (requirementText !== null) findings.push(...coverageFindings(text, displayPath, requirementText, path.relative(cwd, requirement)));
  }
  return findings;
}

module.exports = { placeholderFindings, coverageFindings, requirementIds, planFindings, proseLines };
