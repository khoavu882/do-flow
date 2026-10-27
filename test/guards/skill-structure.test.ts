'use strict';

// G75 — skill structure lint (row 131). Offline ports of four agnix rules, each with a planted-bad
// control:
//   1. AS-013: a skill reference sends the reader to no other reference. SKILL.md names every file the
//      skill needs, one hop deep; a reference that names another reference makes a two-hop chain a
//      harness loading one skill folder may not follow. A pointer back to SKILL.md is the fix.
//   2. CC-SK-034: a reference over 300 lines opens with a `## Contents` list naming each `## ` section.
//   3. CC-AG-022: every shared agent spec declares its `tool-scope`. `all` (the session's tools, limited
//      by `access`) is the only scope today; harnesses express it by omitting their own tools key, so
//      the adapters strip it like `access`. Row 135 adds named scopes to TOOL_SCOPES.
//   4. CC-AG-021: the agent specs' combined name and description text stays inside each vendor cap of
//      `agent_description_caps` in core/registry/guidance-caps.json, and inside the labelled growth
//      ratchet there for the harnesses whose vendor documents none.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, SKILLS, GUIDANCE, agentSpecFiles } = require('./_shared.ts');

const MAX_LINES_WITHOUT_TOC = 300;
const TOOL_SCOPES = new Set(['all']);
const CAPS = () => JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'guidance-caps.json'), 'utf8'));

/** Every `references/*.md` file of every skill, as { rel, name, text }. */
function skillReferences() {
  const out: any[] = [];
  for (const skill of fs.readdirSync(SKILLS)) {
    const dir = path.join(SKILLS, skill, 'references');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((file: string) => file.endsWith('.md'))) {
      out.push({ rel: `${skill}/references/${name}`, name, text: fs.readFileSync(path.join(dir, name), 'utf8') });
    }
  }
  return out;
}

/** File names a reference could send the reader to: every skill reference and guidance reference. */
function referenceNames(entries: any[]) {
  const guidance = fs.readdirSync(path.join(GUIDANCE, 'references')).filter((file: string) => file.endsWith('.md'));
  return new Set<string>([...entries.map((entry) => entry.name), ...guidance]);
}

/** `rel:line: target` for each other reference a reference names, by path or by bare file name. */
function chainFindings(entries: any[], names: Set<string>) {
  const findings: string[] = [];
  for (const { rel, name, text } of entries) {
    text.split('\n').forEach((line: string, i: number) => {
      const hits = new Set<string>();
      for (const m of line.matchAll(/(?:\.\.\/[\w-]+\/)?references\/[\w./-]+\.md/g)) hits.add(m[0]);
      for (const m of line.matchAll(/[\w.-]+\.md\b/g)) {
        if (names.has(m[0]) && m[0] !== name && ![...hits].some((hit) => hit.endsWith(`/${m[0]}`))) hits.add(m[0]);
      }
      for (const hit of hits) if (!hit.endsWith(`references/${name}`) || hit.startsWith('..')) findings.push(`${rel}:${i + 1}: ${hit}`);
    });
  }
  return findings;
}

/** `## ` headings outside code fences, as text. */
function sectionHeadings(text: string) {
  let fenced = false;
  const out: string[] = [];
  for (const line of text.split('\n')) {
    if (/^\s*```/.test(line)) { fenced = !fenced; continue; }
    if (!fenced && /^## /.test(line)) out.push(line.slice(3).trim());
  }
  return out;
}

/** Findings for references over the line limit: no `## Contents` in the first 40 lines, or a
 * section the contents list does not name. */
function tocFindings(entries: any[]) {
  const findings: string[] = [];
  for (const { rel, text } of entries) {
    const lines = text.split('\n');
    if (lines.length <= MAX_LINES_WITHOUT_TOC) continue;
    const at = lines.slice(0, 40).findIndex((line: string) => /^## (Contents|Table of contents)\s*$/i.test(line));
    if (at < 0) { findings.push(`${rel}: ${lines.length} lines and no "## Contents" in its first 40 lines`); continue; }
    const end = lines.findIndex((line: string, i: number) => i > at && /^#{1,6} /.test(line));
    const list = lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
    for (const heading of sectionHeadings(text).filter((h) => !/^(Contents|Table of contents)$/i.test(h))) {
      if (!list.includes(heading)) findings.push(`${rel}: contents does not name "## ${heading}"`);
    }
  }
  return findings;
}

/** A top-level frontmatter value, unquoted. */
function frontmatterValue(text: string, key: string) {
  const block = text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
  const raw = block.match(new RegExp(`^${key}:[ \\t]*(.*)$`, 'm'))?.[1]?.trim() ?? null;
  return raw === null ? null : raw.replace(/^"(.*)"$/, '$1');
}

/** `name: problem` for each spec without a known tool-scope. */
function toolScopeFindings(specs: any[]) {
  return specs.map(({ name, text }: any) => ({ name, scope: frontmatterValue(text, 'tool-scope') }))
    .filter(({ scope }: any) => !TOOL_SCOPES.has(scope))
    .map(({ name, scope }: any) => `${name}: tool-scope ${scope === null ? 'missing' : `'${scope}' is not one of ${[...TOOL_SCOPES].join(', ')}`}`);
}

/** Characters every harness's agent listing carries: each spec's name plus its description. */
function descriptionChars(specs: any[]) {
  return specs.reduce((n: number, { text }: any) => n + (frontmatterValue(text, 'name') ?? '').length + (frontmatterValue(text, 'description') ?? '').length, 0);
}

/** Findings for the cap table, and for `chars` against each vendor cap (tokens at 4 characters) and the ratchet. */
function descriptionCapFindings(table: any, harnessIds: string[], chars: number) {
  const findings: string[] = [];
  const rows = table.agent_description_caps;
  if (!Array.isArray(rows)) return ['guidance-caps.json: agent_description_caps array is required'];
  for (const id of harnessIds) if (!rows.some((row: any) => row.harness === id)) findings.push(`${id}: no agent_description_caps row`);
  for (const row of rows) {
    if (!/^https:\/\/\S+$/.test(row.source_url || '') || !/^\d{4}-\d{2}-\d{2}$/.test(row.verified_on || '')) findings.push(`${row.harness}: source_url or verified_on missing`);
    if (!(row.cap_tokens === null || (Number.isInteger(row.cap_tokens) && row.cap_tokens > 0))) findings.push(`${row.harness}: cap_tokens must be a positive integer or null`);
    else if (row.cap_tokens !== null && Math.ceil(chars / 4) > row.cap_tokens) findings.push(`${row.harness}: ${Math.ceil(chars / 4)} estimated tokens over its ${row.cap_tokens}-token cap`);
  }
  const ratchet = table.agent_description_ratchet;
  if (!Number.isInteger(ratchet?.chars) || !/^RATCHET, NOT A VENDOR CAP/.test(ratchet?.note || '')) findings.push('agent_description_ratchet: chars and a note labelled "RATCHET, NOT A VENDOR CAP" are required');
  else if (chars > ratchet.chars) findings.push(`agent descriptions: ${chars} characters over the ${ratchet.chars}-character ratchet (not a vendor cap; raise it in its own commit with the measurement)`);
  return findings;
}

const harnessIds = () => JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses.map((h: any) => h.id);
const specs = () => agentSpecFiles().map(({ name, file }: any) => ({ name, text: fs.readFileSync(file, 'utf8') }));

test('G75: no skill reference sends the reader to another reference', () => {
  const entries = skillReferences();
  assert.ok(entries.length > 10, 'no skill references found; the check would measure nothing');
  assert.deepEqual(chainFindings(entries, referenceNames(entries)), [],
    'name the second file in SKILL.md beside the pointer to the first, or state the fact in the reference itself');
});

test(`G75: every skill reference over ${MAX_LINES_WITHOUT_TOC} lines opens with a contents list`, () => {
  assert.deepEqual(tocFindings(skillReferences()), []);
});

test('G75: every agent spec declares a known tool-scope', () => {
  const all = specs();
  assert.ok(all.length > 0, 'no agent specs found');
  assert.deepEqual(toolScopeFindings(all), []);
});

test('G75: the agent specs\' combined descriptions fit every vendor cap and the growth ratchet', (t) => {
  const chars = descriptionChars(specs());
  t.diagnostic(`agent descriptions: ${chars} characters (about ${Math.ceil(chars / 4)} tokens)`);
  assert.ok(chars > 0, 'no descriptions parsed');
  assert.deepEqual(descriptionCapFindings(CAPS(), harnessIds(), chars), []);
});

test('G75: controls — a chain, a long reference without contents, a spec without a scope, an oversized listing', () => {
  const names = new Set(['a.md', 'b.md', 'EVIDENCE_LEDGER.md']);
  const chained = [{ rel: 'x/references/a.md', name: 'a.md', text: 'see `b.md`\nand `references/EVIDENCE_LEDGER.md`\nand ../do-document/references/a.md\nthis file, a.md\nSKILL.md step 4' }];
  assert.deepEqual(chainFindings(chained, names), ['x/references/a.md:1: b.md', 'x/references/a.md:2: references/EVIDENCE_LEDGER.md', 'x/references/a.md:3: ../do-document/references/a.md']);

  const body = Array.from({ length: 301 }, (_, i) => `line ${i}`).join('\n');
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# t\n## One\n${body}` }]), ['x/references/long.md: 303 lines and no "## Contents" in its first 40 lines']);
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# t\n## Contents\n- One\n\n## One\n${body}\n## Two\n` }]), ['x/references/long.md: contents does not name "## Two"']);
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# t\n## Contents\n- One\n\n## One\n\`\`\`\n## not a heading\n\`\`\`\n${body}` }]), []);

  assert.deepEqual(toolScopeFindings([{ name: 'x', text: '---\nname: x\naccess: write\n---\n' }, { name: 'y', text: '---\nname: y\ntool-scope: some\n---\n' }]),
    ['x: tool-scope missing', "y: tool-scope 'some' is not one of all"]);

  const table = CAPS();
  const ids = harnessIds();
  assert.deepEqual(descriptionCapFindings(table, ids, table.agent_description_ratchet.chars), []);
  assert.match(descriptionCapFindings(table, ids, table.agent_description_ratchet.chars + 1).join('\n'), /over the \d+-character ratchet/);
  assert.match(descriptionCapFindings(table, ids, 15000 * 4 + 1).join('\n'), /claude: 15001 estimated tokens over its 15000-token cap/);
  assert.deepEqual(descriptionCapFindings({ ...table, agent_description_caps: table.agent_description_caps.filter((row: any) => row.harness !== 'pi') }, ids, 1), ['pi: no agent_description_caps row']);
});
