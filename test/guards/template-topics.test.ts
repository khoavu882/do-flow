'use strict';

// G92 — one owner per topic across the chain templates (row 179, design §2). A topic is the question a
// reader brings to a section, not the heading's wording. TOPICS below maps every topic to the template
// that owns it and the heading titles that answer it; every `## ` heading of every file in
// core/shared/templates/doflow/ is read (outside fenced code and HTML comments, the `N. ` number
// stripped, titles compared case-insensitively, a question-log `Question N — <text>` heading read as
// `Question N`) and looked up there. A cross-reference is at most one line inside an owning section,
// never a heading of its own, so it never reaches this check. `### ` headings are read the same way
// but need no row of their own: one is a finding only when its title answers a topic another template
// owns, so a sub-heading cannot re-host an owned topic.
//   G92.1  every `## ` heading of every template has a TOPICS row; a `## ` or `### ` heading carrying a
//          row's title sits in that topic's owner; every TOPICS owner still carries one of the row's
//          titles at either level; every template file has a row.
//   G92.2  a topic with more than one owner is allowed only while PENDING names the open question that
//          would remove the overlap, and a PENDING topic that is down to one owner must leave PENDING.
//   Controls: each finding kind fails on a planted in-memory copy, never on the tree.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TEMPLATES = path.resolve(__dirname, '..', '..', 'core', 'shared', 'templates', 'doflow');

const REQ = 'requirement-template.md';
const DES = 'design-template.md';
const SPC = 'specs-template.md';
const DM = 'data-model-template.md';
const PLN = 'plan-template.md';
const STA = 'state-template.md';
const QLG = 'question-log-template.md';
const INT = 'intent-template.md';
const CON = 'constitution-template.md';
const EXT = 'external-contract-template.md';
const DIS = 'discipline-sections.md';

/** [topic, owning templates, heading titles that answer it]. The final topic → owner table of row 179. */
const TOPICS: [string, string[], string[]][] = [
  ['outcome and scope boundary', [REQ], ['Summary']],
  ['user stories', [REQ], ['User Stories']],
  ['functional requirements', [REQ], ['Functional Requirements']],
  ['non-functional requirements', [REQ], ['Non-Functional Requirements']],
  ['what is excluded', [REQ], ['Out of Scope']],
  ['acceptance criteria', [REQ], ['Acceptance Criteria']],
  ['questions still open on what to build', [REQ, INT], ['Open Questions']],
  ['assumptions, from every stage', [REQ], ['Assumptions']],
  ['change history', [REQ, DES, SPC, DM, PLN], ['History']],
  ['architecture approach, design decisions and approval blockers', [DES], ['Architecture Approach']],
  ['system overview (C4)', [DES], ['System Overview (C4)']],
  ['domain vocabulary', [DES], ['Concepts']],
  ['how the domain nouns relate', [DM], ['Conceptual domain map']],
  ['user and system journeys', [DES], ['Journeys']],
  ['components and their boundaries', [DES], ['Components & Boundaries']],
  ['design-shape risks and rejected alternatives', [DES], ['Design Risks & Alternatives Considered']],
  ['questions a design reviewer must settle', [DES], ['Open Points for Review']],
  ['interface contracts', [SPC], ['Interface Contracts']],
  ['data model', [DM], ['Data Model']],
  ['sequence / data flow', [DM], ['Sequence / Data Flow']],
  ['entity lifecycles', [DM], ['Lifecycles']],
  ['cross-entity coupling', [DM], ['Cross-entity coupling']],
  ['invariants', [DM], ['Invariants']],
  ['data ownership', [DM], ['Ownership / CRUD matrix']],
  ['domain events', [DM], ['Event catalogue']],
  ['retention, PII and migration', [DM], ['Retention, PII and migration']],
  ['how the work is built', [PLN], ['Implementation Approach']],
  ['constitution compliance of the plan', [PLN], ['Constitution Check (GATE)']],
  ['implementation decisions and their evidence', [PLN], ['Research & Decisions']],
  ['changes per component and file', [PLN], ['Components & Changes']],
  ['delivery risks', [PLN], ['Delivery Risks & Mitigations']],
  ['how each requirement is verified', [PLN], ['Validation Strategy']],
  ['task checklist', [PLN], ['Tasks']],
  ['branch state per repo', [STA], ['Repo Branch Status']],
  ['finished tasks', [STA], ['Task Ledger']],
  ['review findings left unfixed', [STA], ['Findings']],
  ['work in progress', [STA], ['In Progress']],
  ['blockers', [STA], ['Blocked']],
  ['next action', [STA], ['Next Action']],
  ['one question of a round and its answer', [QLG], ['Question N']],
  ['requirement-area coverage after a round', [QLG], ['Coverage']],
  ['the problem as raised', [INT], ['Problem']],
  ['the outcome as raised', [INT], ['Proposed outcome']],
  ['who and what is affected, as raised', [INT], ['Affected']],
  ['what bounds the ask, as raised', [INT], ['Constraints']],
  ['repository principles', [CON], ['Principles']],
  ['repository constraints', [CON], ['Repository constraints']],
  ['constitution amendment rules', [CON], ['Governance']],
  ['vendor methods', [EXT], ['Methods']],
  ['vendor types', [EXT], ['Types']],
  ['vendor callbacks', [EXT], ['Webhook']],
  ['user interface parts', [DIS], ['User interface']],
  ['language model parts', [DIS], ['Language model']],
  ['data pipeline parts', [DIS], ['Data pipeline']],
  ['infrastructure and operations parts', [DIS], ['Infrastructure and operations']],
  ['library, CLI or SDK parts', [DIS], ['Library, CLI or SDK']],
];

/** Topics still owned by more than one template, each with the open question whose answer removes the overlap. */
const PENDING: Record<string, string> = {
  'change history': 'Q1 (179 design §8): one feature-level History needs the validator and the History compactor to read it',
  'questions still open on what to build': 'the intent and requirement titles are both read by the runtime (lifecycle/intent-writer.ts, context/mandatory.ts)',
};

/** A template's `## ` and `### ` titles in order with their level: comments and fenced code blanked, the number stripped. */
function titles(text: string): [number, string][] {
  const out: [number, string][] = [];
  let fence: string | null = null;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split('\n')) {
    const open = line.match(/^\s*(`{3,}|~{3,})/);
    if (fence === null && open) { fence = open[1]; continue; }
    if (fence !== null) { if (line.trim().startsWith(fence)) fence = null; continue; }
    const heading = line.match(/^(#{2,3}) (.+?)\s*$/);
    if (heading) out.push([heading[1].length, heading[2].replace(/^\d+\.\s+/, '').replace(/^Question \d+ — .*$/, 'Question N')]);
  }
  return out;
}

const key = (title: string) => title.toLowerCase();

function findings(files: Map<string, string>, topics = TOPICS, pending = PENDING): string[] {
  const out: string[] = [];
  const byTitle = new Map<string, [string, string[], string[]]>();
  for (const row of topics) for (const title of row[2]) byTitle.set(key(title), row);
  // Per template, each distinct `<level> <title>` once; carried is every title at either level.
  const read = new Map([...files].map(([name, text]) => [name, new Set(titles(text).map(([level, title]) => `${level} ${key(title)}`))]));
  const carried = new Map([...read].map(([name, heads]) => [name, new Set([...heads].map((h) => h.slice(2)))]));

  for (const [name, heads] of read) {
    if (!topics.some(([, owners]) => owners.includes(name))) out.push(`${name}: no TOPICS row names this template as an owner`);
    for (const head of heads) {
      const sub = head.startsWith('3 ');
      const title = head.slice(2);
      const row = byTitle.get(title);
      if (!row) { if (!sub) out.push(`${name}: heading "${title}" has no TOPICS row; name the question it answers`); continue; }
      if (!row[1].includes(name)) out.push(`${name}: ${sub ? 'sub-heading' : 'heading'} "${title}" answers "${row[0]}", which ${row[1].join(', ')} owns`);
    }
  }
  for (const [topic, owners, rowTitles] of topics) {
    for (const owner of owners) {
      if (!rowTitles.some((t) => carried.get(owner)?.has(key(t)))) out.push(`TOPICS "${topic}": ${owner} carries none of ${rowTitles.join(', ')}`);
    }
    if (owners.length > 1 && !pending[topic]) out.push(`topic "${topic}" has ${owners.length} owners (${owners.join(', ')}); one template owns a topic`);
    if (owners.length < 2 && pending[topic]) out.push(`PENDING "${topic}" is down to one owner; remove it from PENDING`);
  }
  return out;
}

function shipped(): Map<string, string> {
  return new Map(fs.readdirSync(TEMPLATES).filter((n: string) => n.endsWith('.md')).sort()
    .map((n: string) => [n, fs.readFileSync(path.join(TEMPLATES, n), 'utf8')]));
}

test('G92.1/G92.2: every template heading has one owning template', () => {
  assert.deepEqual(findings(shipped()), []);
});

test('G92 control: a pointer section for a topic another template owns is caught', () => {
  const files = shipped();
  files.set(DES, `${files.get(DES)}\n## 9. Data Model\n\nSee ./data-model.md §1.\n`);
  assert.match(findings(files).join('\n'), /design-template\.md: heading "data model" answers "data model", which data-model-template\.md owns/);
});

test('G92 control: a `### ` sub-heading that re-hosts an owned topic is caught; an unrowed one is not', () => {
  // The design Concepts relationship chart under its own sub-heading: the topic data-model.md §1 owns.
  const files = shipped();
  files.set(DES, files.get(DES)!.replace('## 3. Concepts\n', '## 3. Concepts\n\n### Conceptual domain map\n\n```mermaid\nflowchart LR\n    A -->|"has"| B\n```\n'));
  files.set(PLN, files.get(PLN)!.replace('### Checkpoints', '### Data Model'));
  files.set(STA, `${files.get(STA)}\n### Notes for the next session\n`);
  const found = findings(files);
  assert.deepEqual(found, [
    'design-template.md: sub-heading "conceptual domain map" answers "how the domain nouns relate", which data-model-template.md owns',
    'plan-template.md: sub-heading "data model" answers "data model", which data-model-template.md owns',
  ]);
  const lost = shipped();
  lost.set(DM, lost.get(DM)!.replace('### Conceptual domain map', '### Domain sketch'));
  assert.match(findings(lost).join('\n'), /TOPICS "how the domain nouns relate": data-model-template\.md carries none of Conceptual domain map/);
});

test('G92 control: a heading with no TOPICS row, and a template with none, are caught', () => {
  const files = shipped();
  files.set(PLN, files.get(PLN)!.replace('## 6. Validation Strategy', '## 6. Rollout Notes'));
  files.set('ghost-template.md', '# Ghost\n\n## 1. Summary\n');
  const found = findings(files).join('\n');
  assert.match(found, /plan-template\.md: heading "rollout notes" has no TOPICS row/);
  assert.match(found, /TOPICS "how each requirement is verified": plan-template\.md carries none/);
  assert.match(found, /ghost-template\.md: no TOPICS row names this template/);
});

test('G92 control: headings in fences and comments are not read; a second owner outside PENDING is caught', () => {
  const files = shipped();
  files.set(STA, `${files.get(STA)}\n<!--\n## Unknown in a comment\n### Data Model\n-->\n\`\`\`markdown\n## Unknown in a fence\n### Data Model\n\`\`\`\n`);
  assert.deepEqual(findings(files), []);
  const twoOwners = TOPICS.map(([t, o, h]): [string, string[], string[]] => (t === 'questions a design reviewer must settle' ? [t, [DES, REQ], h] : [t, o, h]));
  assert.match(findings(shipped(), twoOwners).join('\n'), /topic "questions a design reviewer must settle" has 2 owners/);
});

test('G92 control: a PENDING topic left with one owner must leave PENDING', () => {
  const settled = TOPICS.map(([t, o, h]): [string, string[], string[]] => (t === 'change history' ? [t, [REQ], h] : [t, o, h]));
  const files = shipped();
  for (const name of [DES, SPC, DM, PLN]) files.set(name, files.get(name)!.replace(/^## \d+\. History$/m, '## Archive'));
  const found = findings(files, settled, PENDING).join('\n');
  assert.match(found, /PENDING "change history" is down to one owner/);
});
