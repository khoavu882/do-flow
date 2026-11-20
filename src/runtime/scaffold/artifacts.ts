'use strict';

/**
 * Artifact parsing — turns the text of `requirement.md`, `design.md` and `plan.md` into the
 * structures `scaffold.js`'s generator reads: a requirement index and acceptance criteria, a
 * component index and whatever interface contracts declare as an interface (`specs.md` §1, or an older design.md's
 * API / Interface Contracts section), and the task list that is where the intended file layout actually comes from.
 *
 * Pure text-in, structure-out: nothing here touches the filesystem or knows about the scaffold
 * output tree, so it is exercised directly in tests without an `fsImpl` seam.
 */

/** Returns the body of the first `## …<title>…` section, or null when there is none. */
function section(text: string, titlePattern: RegExp): string | null {
  const lines = text.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i]) && titlePattern.test(lines[i])) { start = i + 1; break; }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start; i < lines.length; i += 1) {
    if (/^##\s/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join('\n');
}

/** Splits a markdown table row into trimmed cells, or null when the line is not a row. */
function row(line: string): string[] | null {
  if (!/^\s*\|/.test(line)) return null;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (cells.every((c) => /^:?-{3,}:?$/.test(c))) return null;   // the header separator
  return cells;
}

/** Markdown wraps long list items; a criterion or task split over three lines is still one item. */
function joinWrapped(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split('\n')) {
    if (/^\s+\S/.test(line) && out.length && out[out.length - 1].trim() !== '') {
      out[out.length - 1] += ` ${line.trim()}`;
    } else {
      out.push(line);
    }
  }
  return out;
}

/**
 * `requirement.md` → requirement summaries (for traceability headers) and acceptance criteria
 * (for test stubs).
 */
function parseRequirement(text: string): any {
  const gaps: any[] = [];
  const requirements = new Map<string, any>();

  const frBody = section(text, /Functional Requirements/i) ?? '';
  const nfrBody = section(text, /Non-Functional Requirements/i) ?? '';
  for (const body of [frBody, nfrBody]) {
    for (const line of body.split('\n')) {
      const cells = row(line);
      if (!cells || cells.length < 2) continue;
      const id = cells[0].replace(/`/g, '').trim();
      if (!/^N?FR-\d+$/.test(id)) continue;
      const stories = (cells[2] || '').match(/US\d+/g) || [];
      requirements.set(id, { id, summary: cells[1], stories });
    }
  }
  if (requirements.size === 0) {
    gaps.push({ artifact: 'requirement.md', what: 'requirement index', why: 'no `| FR-nnn | … |` table row found under a Functional Requirements heading' });
  }

  const criteria: any[] = [];
  const acceptanceBody = section(text, /Acceptance Criteria/i);
  if (acceptanceBody === null) {
    gaps.push({ artifact: 'requirement.md', what: 'acceptance criteria', why: 'no "Acceptance Criteria" section — no test stubs can be derived' });
  } else {
    for (const line of joinWrapped(acceptanceBody)) {
      const match = line.match(/^-\s*\[[ xX]\]\s*(.+?)\s*$/);
      if (!match) continue;
      const statement = match[1];
      const ids = [...new Set(statement.match(/N?FR-\d+/g) || [])].sort();
      criteria.push({ statement, requirements: ids });
    }
    if (criteria.length === 0) {
      gaps.push({ artifact: 'requirement.md', what: 'acceptance criteria', why: 'the Acceptance Criteria section holds no `- [ ]` items — no test stubs can be derived' });
    }
  }

  return { requirements, criteria, gaps };
}

/**
 * The `- **Contracts:** …` line of each `- **C#:** …` entry in design §5 names the `IC-###` ids that component serves
 * (the design template's own attribution). A run `IC-003 to IC-006` stands for every id between, and a list names each.
 * A wrapped line is read to its end; ids of a component the index does not list are ignored.
 */
function collectContractLines(body: string, components: Map<string, any>): void {
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const entry = lines[i].match(/^\s*-\s+\*\*(C\d+):\*\*/);
    if (!entry) continue;
    for (let j = i + 1; j < lines.length && !/^\s*-\s+\*\*C\d+:\*\*/.test(lines[j]) && !/^#{1,6}\s/.test(lines[j]); j += 1) {
      if (!/^\s*-\s+\*\*Contracts:\*\*/.test(lines[j])) continue;
      let text = lines[j];
      while (j + 1 < lines.length && /^\s+[^\s-]/.test(lines[j + 1])) { j += 1; text += ` ${lines[j].trim()}`; }
      const target = components.get(entry[1]);
      if (!target) break;
      for (const [, from, to] of text.matchAll(/IC-(\d+)(?:\s*(?:to|through|–|—|\.\.)\s*IC-(\d+))?/g)) {
        const low = Number(from);
        const high = to === undefined ? low : Number(to);
        for (let n = low; n <= high && n - low < 1000; n += 1) target.contracts.add(`IC-${String(n).padStart(from.length, '0')}`);
      }
      break;
    }
  }
}

/**
 * `design.md` → the component index (traceability) and whatever an API / Interface Contracts section declares as an
 * interface (carried through verbatim rather than paraphrased). A design written after the interface contracts moved to
 * `specs.md` §1 has no such section; `hasContracts` says whether this one did, and `parseSpecs` reads the other source.
 */
function parseDesign(text: string): any {
  const gaps: any[] = [];
  const components = new Map<string, any>();

  const body = section(text, /Components\s*(&|and)\s*Boundaries/i) ?? '';
  for (const line of body.split('\n')) {
    const cells = row(line);
    if (!cells || cells.length < 4) continue;
    const id = cells[0].replace(/`/g, '').trim();
    if (!/^C\d+$/.test(id)) continue;
    const serves = [...new Set(cells[3].match(/N?FR-\d+/g) || [])].sort();
    components.set(id, { id, name: cells[1].replace(/`/g, ''), kind: cells[2], serves, declared: [], contracts: new Set<string>() });
  }
  collectContractLines(body, components);
  if (components.size === 0) {
    gaps.push({ artifact: 'design.md', what: 'component index', why: 'no `| Cn | … |` table row found under a "Components & Boundaries" heading' });
  }

  // the Interface Contracts subsections name their component in the heading — "### 4.5 Scaffold output contract (C16)".
  // That attribution is what lets a declared interface reach the file that implements it, instead
  // of being restated from memory somewhere downstream.
  const contractBody = section(text, /API\s*\/?\s*Interface Contracts|Interface Contracts/i);
  if (contractBody !== null) {
    const lines = contractBody.split('\n');
    let heading: string | null = null;
    let fence: string | null = null;
    let buffer: string[] = [];
    for (const line of lines) {
      const headingMatch = line.match(/^###\s+(.*)$/);
      if (headingMatch && fence === null) { heading = headingMatch[1].trim(); continue; }
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fenceMatch && fence === null) { fence = fenceMatch[1]; buffer = []; continue; }
      if (fence !== null && line.trim().startsWith(fence)) {
        const owners = [...new Set(heading?.match(/C\d+/g) || [])];
        for (const owner of owners) {
          if (components.has(owner)) components.get(owner).declared.push({ heading, block: buffer.join('\n'), source: 'design.md' });
        }
        fence = null;
        buffer = [];
        continue;
      }
      if (fence !== null) buffer.push(line);
    }
  }

  return { components, gaps, hasContracts: contractBody !== null };
}

/**
 * `specs.md` §1 → the interface contracts, attributed to components. An `#### IC-###: <summary>` detail heading counts
 * only when the same id is in the first column of the index (the template's rule), and it names its component the way
 * design.md's subsections did: `(C16)` in the heading, or a `C16` in the index row's other cells, or the id in a
 * component's design §5 `Contracts:` line (the template's own attribution). The contract text is
 * the whole detail entry, carried through verbatim. Returns whether §1 exists, so "N/A: no interface" is a declaration
 * and only a missing section is a gap.
 */
function parseSpecs(text: string, components: Map<string, any>): boolean {
  const body = section(text, /Interface Contracts/i);
  if (body === null) return false;
  const indexRows = new Map<string, string>();
  const entries: { id: string; heading: string; lines: string[] }[] = [];
  let current: { id: string; heading: string; lines: string[] } | null = null;
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence === null) {
      const cells = row(line);
      const id = cells ? cells[0].replace(/`/g, '').trim() : '';
      if (cells && /^IC-\d+$/.test(id)) indexRows.set(id, cells.slice(1).join(' '));
      if (/^#{3,4}\s/.test(line)) {
        const idMatch = line.match(/^#{3,4}\s+(IC-\d+)\b/);
        current = idMatch ? { id: idMatch[1], heading: line.replace(/^#+\s+/, '').trim(), lines: [] } : null;
        if (current) entries.push(current);
        continue;
      }
      if (fenceMatch) fence = fenceMatch[1];
    } else if (line.trim().startsWith(fence)) {
      fence = null;
    }
    if (current) current.lines.push(line);
  }
  for (const entry of entries) {
    if (!indexRows.has(entry.id)) continue;
    const owners = [...new Set([
      ...(`${entry.heading} ${indexRows.get(entry.id)}`.match(/\bC\d+\b/g) || []),
      ...[...components.values()].filter((c: any) => c.contracts?.has(entry.id)).map((c: any) => c.id),
    ])];
    const block = entry.lines.join('\n').trim();
    for (const owner of owners) {
      if (components.has(owner)) components.get(owner).declared.push({ heading: entry.heading, block, source: 'specs.md' });
    }
  }
  return true;
}

/**
 * Metadata keys a task line may carry after its description, per `plan-template.md`.
 *
 * `external-contract:` names the case this generator cannot help with: a dependency with no local
 * repo to scan — a vendor API, a SaaS integration, a service in another org — whose contract exists
 * only as a document. The doc is an *input* to the scaffold, never part of it.
 *
 * `tier:` (106 review R-1) is the task line's dispatch tier, read by dispatch the way brief-tools
 * reads it. It never opens the metadata, and the parsed task carries `tier` only when the line has
 * one, so a line without it parses exactly as before; the line hash and the graph tuples list their
 * fields and do not read it.
 */
const TASK_KEYS = ['owner', 'files', 'depends-on', 'external-contract', 'acceptance', 'budget', 'tier'];

/** DEC-021: the keys that open the metadata wherever they follow whitespace or a dash (8ce5ad7). */
const LEGACY_KEY_PATTERN = /(?:^|[\s—-])(owner|files|depends-on|external-contract):\s/;
/** DEC-021: the 080 keys open the metadata only after the em-dash separator. */
const NEW_KEY_PATTERN = /—\s*(acceptance|budget):\s/;

/** A `depends-on:` value naming another task of the same plan (IC-001). */
const TASK_ID = /^[A-Za-z]+\.\d+$/;

/**
 * The `**Task graph:**` header before the first `## ` section (IC-001, DEC-008): `'v1'` opts the
 * plan into the graph rules, absence is `null`, and any other value is kept as `{ invalid }` for
 * IC-003's `bad-header`.
 */
function parseGraphHeader(text: string): 'v1' | null | { invalid: string } {
  for (const line of text.split(/\r?\n/)) {
    if (/^##\s/.test(line)) break;
    const match = line.match(/^\*\*Task graph:\*\*\s*(.*)$/);
    if (match) return match[1].trim() === 'v1' ? 'v1' : { invalid: match[1].trim() };
  }
  return null;
}

/** `budget: attempts=<n>`, n in 1..999; anything else is kept verbatim as `{ invalid }`. */
function parseBudget(value: string | undefined): { attempts: number } | null | { invalid: string } {
  if (value === undefined) return null;
  const raw = value.replace(/`/g, '').trim();
  const match = raw.match(/^attempts=([0-9]+)$/);
  const attempts = match ? Number(match[1]) : NaN;
  return attempts >= 1 && attempts <= 999 ? { attempts } : { invalid: raw };
}

/** `plan.md` → the task list, which is where the intended file layout actually comes from. */
function parsePlan(text: string): any {
  const gaps: any[] = [];
  const tasks: any[] = [];
  const graphHeader = parseGraphHeader(text);

  // Anchored on the whole heading: `### Task Summary` is orientation, not the task list, and a
  // loose match would read the summary table's rows as tasks.
  const body = section(text, /^##\s+(?:\d+\.\s*)?Tasks\s*$/i);
  if (body === null) {
    gaps.push({ artifact: 'plan.md', what: 'task list', why: 'no "Tasks" section' });
    return { tasks, gaps, graphHeader };
  }

  for (const line of joinWrapped(body)) {
    // The Constitution Check and Completion Criteria sections also use `- [ ]`, so the phase-task
    // id is required rather than optional: a checklist item with no id is not a task.
    const match = line.match(/^-\s*\[([ xX])\]\s+([A-Za-z]+\.\d+)\s+(.*)$/);
    if (!match) continue;
    const [, mark, id, rest] = match;

    // DEC-021 new-keys-open-after-separator: the four pre-080 keys open the metadata as on 8ce5ad7;
    // `acceptance:` and `budget:` open it only after the ` — ` separator, so prose such as
    // "Record the acceptance: criteria" in a description keeps its 8ce5ad7 parse and line hash.
    // Once the metadata has started, every `;` chunk parses all six keys.
    const legacyAt = rest.search(LEGACY_KEY_PATTERN);
    const newAt = rest.search(NEW_KEY_PATTERN);
    const keyAt = legacyAt === -1 ? newAt : newAt === -1 ? legacyAt : Math.min(legacyAt, newAt);
    const head = (keyAt === -1 ? rest : rest.slice(0, keyAt)).replace(/[\s—-]+$/, '').trim();
    const meta = keyAt === -1 ? '' : rest.slice(keyAt).replace(/^[\s—-]+/, '');

    const stories = [...new Set(head.match(/US\d+/g) || [])].sort();
    const description = head.replace(/\[P\]/g, '').replace(/\[US\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();

    const fields: Record<string, string> = {};
    for (const chunk of meta.split(';')) {
      const fieldMatch = chunk.match(/^\s*([a-z-]+):\s*(.*)$/);
      if (!fieldMatch || !TASK_KEYS.includes(fieldMatch[1])) continue;
      fields[fieldMatch[1]] = fieldMatch[2].trim();
    }

    const list = (value: string | undefined) => (value ? value.split(',').map((v) => v.replace(/`/g, '').trim()).filter(Boolean) : []);
    const dependsOn = list(fields['depends-on']);
    // A near-miss starts with a task id but carries more text (`A.1 (after review)`).
    const nearMiss = (value: string) => !TASK_ID.test(value) && TASK_ID.test(value.split(/[\s(]/)[0]);

    tasks.push({
      id,
      done: mark.toLowerCase() === 'x',
      phase: id.split('.')[0],
      description,
      stories,
      owner: fields.owner || null,
      files: list(fields.files),
      dependsOn,
      externalContract: fields['external-contract'] || null,
      parallel: /\[P\]/.test(head),
      taskDeps: dependsOn.filter((value) => TASK_ID.test(value)),
      nearMissDeps: dependsOn.filter(nearMiss),
      acceptance: list(fields.acceptance),
      budget: parseBudget(fields.budget),
      ...(fields.tier === undefined ? {} : { tier: fields.tier.replace(/`/g, '').trim() }),
    });
  }

  if (tasks.length === 0) {
    gaps.push({ artifact: 'plan.md', what: 'task list', why: 'the Tasks section holds no `- [ ] <phase>.<n> …` items — there is no intended file layout to mirror' });
  }
  return { tasks, gaps, graphHeader };
}

module.exports = {
  section,
  row,
  joinWrapped,
  parseRequirement,
  parseDesign,
  parseSpecs,
  parsePlan,
};
