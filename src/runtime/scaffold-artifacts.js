'use strict';

/**
 * Artifact parsing — turns the text of `requirement.md`, `design.md` and `plan.md` into the
 * structures `scaffold.js`'s generator reads: a requirement index and acceptance criteria, a
 * component index and whatever §4 declares as an interface, and the task list that is where the
 * intended file layout actually comes from.
 *
 * Pure text-in, structure-out: nothing here touches the filesystem or knows about the scaffold
 * output tree, so it is exercised directly in tests without an `fsImpl` seam.
 */

/** Returns the body of the first `## …<title>…` section, or null when there is none. */
function section(text, titlePattern) {
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
function row(line) {
  if (!/^\s*\|/.test(line)) return null;
  const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  if (cells.every((c) => /^:?-{3,}:?$/.test(c))) return null;   // the header separator
  return cells;
}

/** Markdown wraps long list items; a criterion or task split over three lines is still one item. */
function joinWrapped(body) {
  const out = [];
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
function parseRequirement(text) {
  const gaps = [];
  const requirements = new Map();

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

  const criteria = [];
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
 * `design.md` → the component index (traceability) and whatever §4 declares as an interface
 * (carried through verbatim rather than paraphrased).
 */
function parseDesign(text) {
  const gaps = [];
  const components = new Map();

  const body = section(text, /Components\s*(&|and)\s*Boundaries/i) ?? '';
  for (const line of body.split('\n')) {
    const cells = row(line);
    if (!cells || cells.length < 4) continue;
    const id = cells[0].replace(/`/g, '').trim();
    if (!/^C\d+$/.test(id)) continue;
    const serves = [...new Set(cells[3].match(/N?FR-\d+/g) || [])].sort();
    components.set(id, { id, name: cells[1].replace(/`/g, ''), kind: cells[2], serves, declared: [] });
  }
  if (components.size === 0) {
    gaps.push({ artifact: 'design.md', what: 'component index', why: 'no `| Cn | … |` table row found under a "Components & Boundaries" heading' });
  }

  // §4's subsections name their component in the heading — "### 4.5 Scaffold output contract (C16)".
  // That attribution is what lets a declared interface reach the file that implements it, instead
  // of being restated from memory somewhere downstream.
  const contractBody = section(text, /API\s*\/?\s*Interface Contracts|Interface Contracts/i);
  if (contractBody === null) {
    gaps.push({ artifact: 'design.md', what: 'interface contracts', why: 'no "API / Interface Contracts" section — every emitted file falls back to a placeholder signature' });
  } else {
    const lines = contractBody.split('\n');
    let heading = null;
    let fence = null;
    let buffer = [];
    for (const line of lines) {
      const headingMatch = line.match(/^###\s+(.*)$/);
      if (headingMatch && fence === null) { heading = headingMatch[1].trim(); continue; }
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
      if (fenceMatch && fence === null) { fence = fenceMatch[1]; buffer = []; continue; }
      if (fence !== null && line.trim().startsWith(fence)) {
        const owners = [...new Set(heading?.match(/C\d+/g) || [])];
        for (const owner of owners) {
          if (components.has(owner)) components.get(owner).declared.push({ heading, block: buffer.join('\n') });
        }
        fence = null;
        buffer = [];
        continue;
      }
      if (fence !== null) buffer.push(line);
    }
  }

  return { components, gaps };
}

/**
 * Metadata keys a task line may carry after its description, per `plan-template.md`.
 *
 * `external-contract:` names the case this generator cannot help with: a dependency with no local
 * repo to scan — a vendor API, a SaaS integration, a service in another org — whose contract exists
 * only as a document. The doc is an *input* to the scaffold, never part of it.
 */
const TASK_KEYS = ['owner', 'files', 'depends-on', 'external-contract'];

/** `plan.md` → the task list, which is where the intended file layout actually comes from. */
function parsePlan(text) {
  const gaps = [];
  const tasks = [];

  // Anchored on the whole heading: `### Task Summary` is orientation, not the task list, and a
  // loose match would read the summary table's rows as tasks.
  const body = section(text, /^##\s+(?:\d+\.\s*)?Tasks\s*$/i);
  if (body === null) {
    gaps.push({ artifact: 'plan.md', what: 'task list', why: 'no "Tasks" section' });
    return { tasks, gaps };
  }

  for (const line of joinWrapped(body)) {
    // The Constitution Check and Completion Criteria sections also use `- [ ]`, so the phase-task
    // id is required rather than optional: a checklist item with no id is not a task.
    const match = line.match(/^-\s*\[([ xX])\]\s+([A-Za-z]+\.\d+)\s+(.*)$/);
    if (!match) continue;
    const [, mark, id, rest] = match;

    const keyPattern = new RegExp(`(?:^|[\\s—-])(${TASK_KEYS.join('|')}):\\s`);
    const keyAt = rest.search(keyPattern);
    const head = (keyAt === -1 ? rest : rest.slice(0, keyAt)).replace(/[\s—-]+$/, '').trim();
    const meta = keyAt === -1 ? '' : rest.slice(keyAt).replace(/^[\s—-]+/, '');

    const stories = [...new Set(head.match(/US\d+/g) || [])].sort();
    const description = head.replace(/\[P\]/g, '').replace(/\[US\d+\]/g, '').replace(/\s{2,}/g, ' ').trim();

    const fields = {};
    for (const chunk of meta.split(';')) {
      const fieldMatch = chunk.match(/^\s*([a-z-]+):\s*(.*)$/);
      if (!fieldMatch || !TASK_KEYS.includes(fieldMatch[1])) continue;
      fields[fieldMatch[1]] = fieldMatch[2].trim();
    }

    const list = (value) => (value ? value.split(',').map((v) => v.replace(/`/g, '').trim()).filter(Boolean) : []);

    tasks.push({
      id,
      done: mark.toLowerCase() === 'x',
      phase: id.split('.')[0],
      description,
      stories,
      owner: fields.owner || null,
      files: list(fields.files),
      dependsOn: list(fields['depends-on']),
      externalContract: fields['external-contract'] || null,
    });
  }

  if (tasks.length === 0) {
    gaps.push({ artifact: 'plan.md', what: 'task list', why: 'the Tasks section holds no `- [ ] <phase>.<n> …` items — there is no intended file layout to mirror' });
  }
  return { tasks, gaps };
}

module.exports = {
  parseRequirement,
  parseDesign,
  parsePlan,
};
