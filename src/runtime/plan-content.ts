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
const { REPO_ROOT } = require('../helper/repo-root.ts');

type Finding = { rule: string; severity: 'fix' | 'refuses-exit' | 'advisory'; path: string; line: number; message: string; id?: string };

/** The visible Markdown of a file: fenced code blanked and HTML comments removed, and inline code
 * spans too unless `keepCode` is set, so a placeholder quoted as an example, a table left in a
 * comment or a template's guidance is not read. A fence closes only on its own character, a run at
 * least as long as its opener and nothing after it (CommonMark; doc_quality_checker.py since row
 * 132). Line numbers are kept: index i is line i + 1. */
function proseLines(text: string, { keepCode = false }: { keepCode?: boolean } = {}): string[] {
  const out: string[] = [];
  let fence: string | null = null;
  let comment = false;
  for (const raw of text.split(/\r?\n/)) {
    const run = raw.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence === null && run && !(run[1][0] === '`' && run[2].includes('`'))) { fence = run[1]; out.push(''); continue; }
    if (fence !== null) {
      if (run && run[1][0] === fence[0] && run[1].length >= fence.length && run[2].trim() === '') fence = null;
      out.push('');
      continue;
    }
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
    out.push(keepCode ? kept : kept.replace(/`[^`]*`/g, ''));
  }
  return out;
}

const PLACEHOLDERS = [
  /\b(?:TBD|TODO|FIXME)\b/,
  /\bto be (?:decided|determined|defined)\b/i,
  // "later" only as a placeholder phrasing: "fill in later", or alone as a table cell. Prose such
  // as "later phases" or "add filters later" is a plan, not a hole.
  /\bfill(?: it)? in later\b/i,
  /\|\s*later\s*(?=\|)/i,
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
  const visible = proseLines(planText, { keepCode: true });
  return requirementIds(requirementText)
    .filter(({ id }) => !visible.some((line) => new RegExp(`\\b${id}\\b`).test(line)))
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

// ── constitution (row 134 item 4: a MUST conflict refuses the planning stage's exit) ──────────────

/** Where the base tier is, beside a runtime root: the checkout's `core/shared` copy, else the
 * install's guidance tree, a sibling of `<install>/.doflow/runtime` (which carries no core/shared),
 * resolved the way `resolveBashHelper` finds the bash helpers. */
function constitutionBaseCandidates(runtimeRoot: string = REPO_ROOT): string[] {
  return [
    path.join(runtimeRoot, 'core', 'shared', 'guidance', 'references', 'CONSTITUTION_BASE.md'),
    path.resolve(runtimeRoot, '..', 'guidance', 'references', 'CONSTITUTION_BASE.md'),
  ];
}
function constitutionBaseFile(runtimeRoot: string = REPO_ROOT): string | null {
  return constitutionBaseCandidates(runtimeRoot).find((file) => fs.existsSync(file)) || null;
}
const CONSTITUTION_BASE = constitutionBaseFile() || constitutionBaseCandidates()[0];
const CONSTITUTION_LOCAL = 'agent-docs/constitution.md';
const UNBLOCK = 'revise the plan until it passes and record its row, or have a person amend the constitution with /do-constitution; there is no waiver';

type Principle = { id: string; tier: 'MUST' | 'SHOULD'; source: string; line: number };

/** A heading's principle id: the text before ` — `, else its first word. */
function principleId(cell: string): string {
  const plain = cell.replace(/[*`]/g, '').trim();
  return (plain.split(/\s+[—–-]\s+/)[0].split(/\s+/)[0] || '').trim();
}

/** The principles a constitution file declares: each `### ` heading under `## Principles`, MUST
 * unless its body carries `**Tier:** SHOULD`. */
function parsePrinciples(text: string, source: string): Principle[] {
  const principles: Principle[] = [];
  const lines = proseLines(text, { keepCode: true });
  let inside = false;
  let current: Principle | null = null;
  lines.forEach((line, index) => {
    if (/^##\s/.test(line)) { inside = /^##\s+Principles\b/i.test(line); current = null; return; }
    if (!inside) return;
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      current = { id: principleId(heading[1]), tier: 'MUST', source, line: index + 1 };
      if (current.id) principles.push(current);
      return;
    }
    const tier = line.match(/^\s*\*\*Tier:\*\*\s*(MUST|SHOULD)\b/i);
    if (tier && current) current.tier = tier[1].toUpperCase() as Principle['tier'];
  });
  return principles;
}

/** A principle id declared twice in one file, named with both lines; null when every id is unique. */
function duplicateId(principles: Principle[], file: string): string | null {
  const seen = new Map<string, number>();
  for (const p of principles) {
    if (seen.has(p.id)) return `${file} declares ${p.id} twice (lines ${seen.get(p.id)} and ${p.line})`;
    seen.set(p.id, p.line);
  }
  return null;
}

/** Both tiers, tier-2 taking precedence: a tier-2 principle with a base id replaces it in place,
 * a new id is appended. `error` is set when either file cannot be read, has no `## Principles`
 * section with a principle in it, or declares an id twice; the gate then refuses rather than
 * check the plan against fewer principles than the constitution holds. A base MUST the overlay
 * makes SHOULD is allowed (the designed tier-2 path) and listed in `downgrades`, never silent. */
function loadConstitution({ checkoutRoot, runtimeRoot = REPO_ROOT }: { checkoutRoot: string; runtimeRoot?: string }) {
  const none = { principles: [] as Principle[], downgrades: [] as Array<Principle & { version: string | null }> };
  const baseFile = constitutionBaseFile(runtimeRoot);
  if (!baseFile) return { ...none, error: `the base constitution cannot be found (searched ${constitutionBaseCandidates(runtimeRoot).join(', ')})` };
  let base: string;
  try { base = fs.readFileSync(baseFile, 'utf8'); } catch (error: any) {
    return { ...none, error: `the base constitution ${baseFile} cannot be read (${error.code || error.message})` };
  }
  const principles = parsePrinciples(base, 'CONSTITUTION_BASE.md');
  if (!principles.length) return { ...none, error: `the base constitution ${baseFile} declares no principle` };
  const baseDuplicate = duplicateId(principles, baseFile);
  if (baseDuplicate) return { ...none, error: baseDuplicate };
  const localFile = path.join(checkoutRoot, CONSTITUTION_LOCAL);
  let local: string | null = null;
  try { local = fs.readFileSync(localFile, 'utf8'); } catch (error: any) {
    if (error.code !== 'ENOENT') return { ...none, error: `the repo constitution ${CONSTITUTION_LOCAL} cannot be read (${error.code || error.message})` };
  }
  if (local === null) return { principles, downgrades: none.downgrades, error: null as string | null };
  const overlay = parsePrinciples(local, CONSTITUTION_LOCAL);
  if (!overlay.length) {
    return { ...none, error: `the repo constitution ${CONSTITUTION_LOCAL} has no \`## Principles\` section with a \`### <ID> — <name>\` principle, so its principles cannot be read` };
  }
  const overlayDuplicate = duplicateId(overlay, CONSTITUTION_LOCAL);
  if (overlayDuplicate) return { ...none, error: overlayDuplicate };
  const version = (proseLines(local).join('\n').match(/\*\*Version:\*\*\s*([^\s·]+)/) || [])[1] || null;
  const downgrades: Array<Principle & { version: string | null }> = [];
  for (const principle of overlay) {
    const at = principles.findIndex((p) => p.id === principle.id);
    if (at === -1) { principles.push(principle); continue; }
    if (principles[at].tier === 'MUST' && principle.tier === 'SHOULD') downgrades.push({ ...principle, version });
    principles[at] = principle;
  }
  return { principles, downgrades, error: null as string | null };
}

/** The §2 "Constitution Check" record in the plan's visible Markdown: one table row per
 * principle, read by its `Principle` and `Result` columns. A header row with no `|---|` separator
 * under it is no table; `unparseable` is then that header's line. */
function constitutionRecord(planText: string) {
  const lines = proseLines(planText, { keepCode: true });
  const start = lines.findIndex((line) => /^##\s+(?:\d+\.\s*)?Constitution Check\b/i.test(line));
  const rows: Array<{ id: string; result: string; line: number }> = [];
  if (start === -1) return { heading: null, rows, unparseable: null as number | null };
  const cellsOf = (line: string) => line.trim().replace(/^\||\|$/g, '').split('|').map((cell) => cell.trim());
  let columns: { principle: number; result: number } | null = null;
  for (let i = start + 1; i < lines.length && !/^##\s/.test(lines[i]); i += 1) {
    if (!/^\s*\|/.test(lines[i])) { if (columns) break; continue; }
    const cells = cellsOf(lines[i]);
    if (!columns) {
      const names = cells.map((cell) => cell.replace(/[*`]/g, '').toLowerCase());
      if (!(names.includes('principle') && names.includes('result'))) continue;
      if (!(lines[i + 1] && cellsOf(lines[i + 1]).every((cell) => /^:?-+:?$/.test(cell)))) return { heading: start + 1, rows, unparseable: i + 1 };
      columns = { principle: names.indexOf('principle'), result: names.indexOf('result') };
      i += 1;
      continue;
    }
    rows.push({ id: principleId(cells[columns.principle] || ''), result: (cells[columns.result] || '').replace(/[*`]/g, '').trim().toUpperCase(), line: i + 1 });
  }
  return { heading: start + 1, rows, unparseable: null as number | null };
}

/** One finding per principle that is not recorded as passing: a MUST marked FAIL or without a
 * PASS/FAIL row refuses exit; a SHOULD marked FAIL is advisory. The tier is the constitution's,
 * whatever the row says, so a plan cannot downgrade a MUST. */
function constitutionFindings({ planText, planPath, principles }: { planText: string; planPath: string; principles: Principle[] }): Finding[] {
  const { heading, rows, unparseable } = constitutionRecord(planText);
  if (unparseable) {
    return [{ rule: 'constitution-unparseable', severity: 'refuses-exit', path: planPath, line: unparseable,
      message: `no parseable Constitution Check: the table header has no |---| separator row under it, so no principle is recorded; ${UNBLOCK}` }];
  }
  const findings: Finding[] = [];
  for (const principle of principles) {
    const recorded = rows.filter((r) => r.id === principle.id && (r.result === 'PASS' || r.result === 'FAIL'));
    const failed = recorded.find((r) => r.result === 'FAIL');
    const tier = `${principle.id} (${principle.tier})`;
    if (principle.tier === 'MUST' && failed) {
      findings.push({ rule: 'constitution-must-fail', severity: 'refuses-exit', path: planPath, line: failed.line, id: principle.id,
        message: `${tier} is marked FAIL in the Constitution Check: ${UNBLOCK}` });
    } else if (principle.tier === 'MUST' && !recorded.length) {
      findings.push({ rule: 'constitution-must-missing', severity: 'refuses-exit', path: planPath, line: heading || 1, id: principle.id,
        message: `${tier} has no PASS/FAIL row in the Constitution Check (${principle.source}): add \`| ${principle.id} | MUST | PASS | <how> |\` once the plan complies, or ${UNBLOCK}` });
    } else if (failed) {
      findings.push({ rule: 'constitution-should-fail', severity: 'advisory', path: planPath, line: failed.line, id: principle.id,
        message: `${tier} is marked FAIL in the Constitution Check: advisory, recorded and not blocking` });
    }
  }
  return findings;
}

/** The checkout a plan belongs to: the nearest directory above it holding `.git`, else `fallback`. */
function checkoutOf(file: string, fallback: string): string {
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return fallback;
  }
}

/** The constitution findings, or one refusal when the constitution itself cannot be read. */
function constitutionCheck({ planText, planPath, checkoutRoot }: { planText: string; planPath: string; checkoutRoot: string }): Finding[] {
  const { principles, downgrades, error } = loadConstitution({ checkoutRoot });
  if (error) return [{ rule: 'constitution-unreadable', severity: 'refuses-exit', path: planPath, line: 1, message: `${error}: nothing can be checked, so the plan is refused` }];
  const notes: Finding[] = downgrades.map((d) => ({ rule: 'constitution-downgrade', severity: 'advisory' as const, path: d.source, line: d.line, id: d.id,
    message: `${d.id} is MUST in the base constitution and SHOULD in ${d.source}${d.version ? ` ${d.version}` : ''}: the overlay downgrades it, recorded and not blocking` }));
  return [...notes, ...constitutionFindings({ planText, planPath, principles })];
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
  findings.push(...constitutionCheck({ planText: text, planPath: displayPath, checkoutRoot: checkoutOf(planAbs, cwd) }));
  return findings;
}

/** The planning stage's exit (row 134): the feature's plan.md, found under the first root that has
 * it, checked against both constitution tiers of that checkout. `refusals` refuse the exit;
 * `advisories` are printed and recorded nowhere else. A run with no feature, or a feature with no
 * plan, is refused: the planning stage exists to produce that plan. */
function planStageExit({ roots, slug }: { roots: string[]; slug: string | null }) {
  // plan.md, else planning/plan.md under the structured layout (the roadmap facts read the same two).
  const feature = slug ? path.join('agent-docs', 'doflow', slug) : null;
  const found = feature ? roots.flatMap((r) => ['plan.md', path.join('planning', 'plan.md')].map((rel) => ({ r, rel: path.join(feature, rel) })))
    .find(({ r, rel }) => fs.existsSync(path.join(r, rel))) : undefined;
  const relative = found ? found.rel : feature ? path.join(feature, 'plan.md') : null;
  const root = found?.r;
  if (!relative || !root) {
    const where = relative ? `${relative} (or planning/plan.md) under ${roots.join(', ')}` : 'a plan: the run names no feature';
    return { refusals: [{ rule: 'plan-missing', severity: 'refuses-exit', path: relative || 'plan.md', line: 1, message: `no plan to check (looked for ${where}); write plan.md before completing the planning stage` }] as Finding[], advisories: [] as Finding[] };
  }
  let planText: string;
  try { planText = fs.readFileSync(path.join(root, relative), 'utf8'); } catch (error: any) {
    return { refusals: [{ rule: 'plan-missing', severity: 'refuses-exit', path: relative, line: 1, message: `${relative} cannot be read (${error.code || error.message})` }] as Finding[], advisories: [] as Finding[] };
  }
  const findings = constitutionCheck({ planText, planPath: relative.split(path.sep).join('/'), checkoutRoot: root });
  return { refusals: findings.filter((f) => f.severity === 'refuses-exit'), advisories: findings.filter((f) => f.severity === 'advisory') };
}

module.exports = {
  placeholderFindings, coverageFindings, requirementIds, planFindings, proseLines,
  parsePrinciples, loadConstitution, constitutionFindings, planStageExit, CONSTITUTION_BASE, constitutionBaseFile,
};
