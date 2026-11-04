'use strict';

// Feature 139 (IC-003): pure coverage checks over a data-model.md text. Each function takes text and
// returns findings (an empty array means clean); none reads a file, so the guard test and a dry-run
// fill can both call them. HTML comments are ignored, so rules quoted in a template comment never
// count as content.
//
// State rule (stateDiagram-v2): `[*]` and any state declared `<<choice>>`, `<<fork>>` or `<<join>>`
// are pseudo-states; they are neither held to the Transitions table nor counted toward the cap. A
// composite state (`state X { ... }`) and the states nested in it are states of the same diagram,
// each counted once, whether declared or only named by a transition.

const TEMPLATE_HEADINGS = [
  'Data Model', 'Sequence / Data Flow', 'Lifecycles', 'Cross-entity coupling', 'Invariants',
  'Ownership / CRUD matrix', 'Event catalogue', 'Retention, PII and migration', 'History',
];
const TRANSITION_COLUMNS = ['From', 'Event', 'Guard', 'Actor', 'Side effect', 'To', 'Emitted event', 'Source'];
const MAX_STATES = 10;
const SOURCE_TOKEN = /^(FR-\d{3}|NFR-\d{3}|IC-\d{3}|code:\S+:\d+|proposed|UNKNOWN -> Open Point)$/;

const stripComments = (text: string): string => text.replace(/<!--[\s\S]*?-->/g, '');

/** The fenced blocks of `body` whose info string is `mermaid <type>`; returns each block's inner lines. */
function mermaidBlocks(body: string, type: string): string[][] {
  const blocks: string[][] = [];
  const fence = /```mermaid[ \t]*\n([\s\S]*?)```/g;
  for (const m of body.matchAll(fence)) {
    const lines = m[1].split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines[0] === type) blocks.push(lines.slice(1));
  }
  return blocks;
}

/** The pipe tables of `body` outside code fences: header cells and body rows, separator row dropped. */
function tablesOf(body: string): { header: string[]; rows: string[][] }[] {
  const tables: { header: string[]; rows: string[][] }[] = [];
  let inFence = false;
  let current: string[][] = [];
  const flush = () => {
    if (current.length >= 2) tables.push({ header: current[0], rows: current.slice(2) });
    current = [];
  };
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('```')) { inFence = !inFence; flush(); continue; }
    if (!inFence && line.startsWith('|')) {
      const cells = line.replace(/\\\|/g, '\u0000').replace(/^\||\|$/g, '').split('|')
        .map((c) => c.replace(/\u0000/g, '|').trim());
      current.push(cells);
    } else flush();
  }
  flush();
  return tables;
}

/** The text of the `##` section whose heading matches `pattern`, up to the next `##` heading. */
function sectionOf(body: string, pattern: RegExp): string | null {
  const parts = body.split(/^(?=## )/m);
  return parts.find((p) => pattern.test(p.split('\n')[0])) ?? null;
}

/** Each `#### <prefix>: <name>` block as [name, body], ending at the next heading of any level 1-4. */
function blocksUnder(body: string, prefix: string): [string, string][] {
  const out: [string, string][] = [];
  const lines = body.split('\n');
  const head = new RegExp(`^#### ${prefix}:\\s*(.+?)\\s*$`);
  for (let i = 0; i < lines.length; i++) {
    const m = head.exec(lines[i]);
    if (!m) continue;
    let end = i + 1;
    while (end < lines.length && !/^#{1,4}\s/.test(lines[end])) end++;
    out.push([m[1], lines.slice(i + 1, end).join('\n')]);
  }
  return out;
}

const cellText = (cell: string): string => cell.replace(/`/g, '').trim();

/** Template check: nine `##` headings in order, `#### Flow:` and no `### Flow:`, §3 callout and Transitions header. */
function templateHeadingFindings(text: string): string[] {
  const body = stripComments(text);
  const findings: string[] = [];
  const found = [...body.matchAll(/^## (\d+)\. (.+?)\s*$/gm)].map((m) => `${m[1]}|${m[2]}`);
  const expected = TEMPLATE_HEADINGS.map((title, i) => `${i + 1}|${title}`);
  if (found.length !== expected.length || expected.some((e, i) => !found[i] || !found[i].startsWith(e))) {
    findings.push(`template headings: expected "## N. <title>" for ${TEMPLATE_HEADINGS.join(' / ')} in order, found ${found.map((f) => f.replace('|', '. ')).join(' / ') || 'none'}`);
  }
  if (!/^#### Flow:/m.test(body)) findings.push('template headings: no "#### Flow:" heading');
  if (/^### Flow:/m.test(body)) findings.push('template headings: "### Flow:" is at the wrong level; use "#### Flow:"');
  const three = sectionOf(body, /^## 3\. /);
  if (!three) {
    findings.push('template headings: no "## 3." section for the callout and Transitions header');
    return findings;
  }
  if (!/^> \*\*Authoritative:\*\*/m.test(three)) findings.push('template headings: §3 Lifecycles carries no Authoritative callout');
  const header = tablesOf(three).map((t) => t.header).find((h) => h[0] === 'From');
  if (!header) findings.push('template headings: §3 carries no Transitions table');
  else if (header.join('|') !== TRANSITION_COLUMNS.join('|')) {
    findings.push(`template headings: Transitions columns are ${header.join(', ')}; expected ${TRANSITION_COLUMNS.join(', ')}`);
  }
  return findings;
}

/** Entity names drawn by the `erDiagram` blocks of `body`, in first-seen order. */
function erEntities(body: string): string[] {
  const names: string[] = [];
  const add = (n: string) => { if (!names.some((x) => x.toLowerCase() === n.toLowerCase())) names.push(n); };
  const relation = /^([A-Za-z_][\w-]*)\s+[|}o][|o](?:--|\.\.)[|o][|{o]\s+([A-Za-z_][\w-]*)/;
  for (const lines of mermaidBlocks(body, 'erDiagram')) {
    for (const line of lines) {
      const r = relation.exec(line);
      if (r) { add(r[1]); add(r[2]); continue; }
      const e = /^([A-Za-z_][\w-]*)\s*\{/.exec(line);
      if (e) add(e[1]);
    }
  }
  return names;
}

/** Every ER entity has a `#### Dictionary:` heading and a `#### Lifecycle:` heading (case-insensitive). */
function entityCoverageFindings(text: string): string[] {
  const body = stripComments(text);
  const dictionary = new Set(blocksUnder(body, 'Dictionary').map(([n]) => n.toLowerCase()));
  const lifecycle = new Set(blocksUnder(body, 'Lifecycle').map(([n]) => n.toLowerCase()));
  const findings: string[] = [];
  for (const entity of erEntities(body)) {
    if (!dictionary.has(entity.toLowerCase())) findings.push(`entity ${entity}: no "#### Dictionary: ${entity}" heading`);
    if (!lifecycle.has(entity.toLowerCase())) findings.push(`entity ${entity}: no "#### Lifecycle: ${entity}" heading`);
  }
  return findings;
}

/** The states a `stateDiagram-v2` body names, minus pseudo-states (see the state rule at the top). */
function diagramStates(lines: string[]): string[] {
  const pseudo = new Set<string>(['[*]']);
  for (const line of lines) {
    const p = /^state\s+(?:"[^"]*"\s+as\s+)?([\w-]+)\s*<<(?:choice|fork|join)>>/.exec(line);
    if (p) pseudo.add(p[1]);
  }
  const states: string[] = [];
  const add = (s: string) => { if (!pseudo.has(s) && !states.includes(s)) states.push(s); };
  for (const line of lines) {
    const t = /^(\[\*\]|[\w-]+)\s*-->\s*(\[\*\]|[\w-]+)/.exec(line);
    if (t) { add(t[1]); add(t[2]); continue; }
    const decl = /^state\s+(?:"[^"]*"\s+as\s+)?([\w-]+)\s*(?:\{\s*)?$/.exec(line);
    if (decl) add(decl[1]);
  }
  return states;
}

/** Each lifecycle diagram state is in From or To of its Transitions table; at most 10 states. */
function stateParityFindings(text: string): string[] {
  const findings: string[] = [];
  for (const [entity, block] of blocksUnder(stripComments(text), 'Lifecycle')) {
    const diagrams = mermaidBlocks(block, 'stateDiagram-v2');
    if (!diagrams.length) continue;
    const states = diagramStates(diagrams[0]);
    if (states.length > MAX_STATES) {
      findings.push(`lifecycle ${entity}: ${states.length} states exceed the ${MAX_STATES}-state cap`);
    }
    const table = tablesOf(block).find((t) => t.header[0] === 'From');
    if (!table) { findings.push(`lifecycle ${entity}: diagram has no Transitions table`); continue; }
    const from = table.header.indexOf('From');
    const to = table.header.indexOf('To');
    if (to < 0) { findings.push(`lifecycle ${entity}: Transitions table has no To column`); continue; }
    const tabled = new Set(table.rows.flatMap((r) => [cellText(r[from] ?? ''), cellText(r[to] ?? '')]));
    for (const state of states) {
      if (!tabled.has(state)) findings.push(`lifecycle ${entity}: state ${state} is in the diagram but not in the From or To column`);
    }
  }
  return findings;
}

/** The kind of Source-bearing table a header describes, or null for any other table. */
function sourceTableKind(h: string[]): string | null {
  if (h[0] === 'From' && h.includes('Event')) return 'Transitions';
  if (h[0] === 'Invariant') return 'Invariants';
  if (h[0] === 'Entity' && h.includes('Owner') && h.includes('Create')) return 'Ownership';
  if (h[0] === 'Event' && h.includes('Emitted by')) return 'Event catalogue';
  if (h[0] === 'Entity' && h.includes('Retention')) return 'Retention';
  return null;
}

/** Every row of the Transitions, Invariants, Ownership, Event and Retention tables ends in a Source token. */
function sourceCellFindings(text: string): string[] {
  const findings: string[] = [];
  for (const { header, rows } of tablesOf(stripComments(text))) {
    const kind = sourceTableKind(header);
    if (!kind) continue;
    if (header[header.length - 1] !== 'Source') findings.push(`${kind} table: last column is "${header[header.length - 1]}", expected Source`);
    for (const row of rows) {
      const cell = cellText(row[row.length - 1] ?? '');
      const tokens = cell.split(/\s*,\s*/);
      if (!cell || !tokens.every((t) => SOURCE_TOKEN.test(t))) {
        findings.push(`${kind} table: row "${cellText(row[0] ?? '')}" has Source cell "${cell}", expected FR-###, NFR-###, IC-###, code:<path>:<line>, proposed or UNKNOWN -> Open Point`);
      }
    }
  }
  return findings;
}

module.exports = {
  templateHeadingFindings, entityCoverageFindings, stateParityFindings, sourceCellFindings,
};
