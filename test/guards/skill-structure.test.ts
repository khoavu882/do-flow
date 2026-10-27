'use strict';

// G75 — skill structure lint (row 131). Offline ports of four agnix rules, each with a planted-bad
// control:
//   1. AS-013: a skill reference sends the reader to no reference its own SKILL.md does not name.
//      SKILL.md names every file the skill needs, one hop deep; a reference pointer that resolves to a
//      file SKILL.md also names (same resolved path, not just the same file name) keeps it one hop, while one naming any other reference makes a two-hop chain a harness
//      loading one skill folder may not follow. Naming it in SKILL.md, or pointing back, is the fix.
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
const { tempDir } = require('../helper/tmp.ts');

const MAX_LINES_WITHOUT_TOC = 300;
const TOOL_SCOPES = new Set(['all']);
const CAPS = () => JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'guidance-caps.json'), 'utf8'));

/** Every `references/*.md` file of every skill, as { rel, skill, name, file, text }. */
function skillReferences(skillsDir = SKILLS) {
  const out: any[] = [];
  for (const skill of fs.readdirSync(skillsDir)) {
    const dir = path.join(skillsDir, skill, 'references');
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter((file: string) => file.endsWith('.md'))) {
      const file = path.join(dir, name);
      out.push({ rel: `${skill}/references/${name}`, skill, name, file, text: fs.readFileSync(file, 'utf8') });
    }
  }
  return out;
}

/** The reference mentions on one line: `references/X.md` and `../<skill>/references/X.md` paths, and
 * bare file names of any skill or guidance reference (`names`) a path on the line does not already carry. */
function mentions(line: string, names: Set<string>) {
  const hits = new Set<string>();
  for (const m of line.matchAll(/(?:\.\.\/[\w-]+\/)?references\/[\w./-]+\.md/g)) hits.add(m[0]);
  for (const m of line.matchAll(/[\w.-]+\.md\b/g)) {
    if (names.has(m[0]) && ![...hits].some((hit) => hit.endsWith(`/${m[0]}`))) hits.add(m[0]);
  }
  return [...hits];
}

/** The file a mention in `from` (a SKILL.md or one of its references) resolves to, or null. A bare
 * name resolves beside `from`, then in the skill's references/, then in the guidance tree's; a
 * `references/X.md` path resolves under the skill root (SKILL.md's directory, the root every skill file
 * writes such paths from), then the guidance tree; `../<skill>/references/X.md` from the skill root. */
function resolveMention(hit: string, from: string, skillRoot: string, guidanceDir: string) {
  const candidates = hit.startsWith('../') ? [path.resolve(skillRoot, hit)]
    : hit.startsWith('references/') ? [path.join(skillRoot, hit), path.join(guidanceDir, hit)]
      : [path.join(path.dirname(from), hit), path.join(skillRoot, 'references', hit), path.join(guidanceDir, 'references', hit)];
  return candidates.find((file) => fs.existsSync(file)) ?? null;
}

/** `rel:line: target` for each reference a skill reference names that is not the same file, by
 * resolved path, as one its own SKILL.md names: a second hop. A pointer that resolves nowhere (a
 * bare name of another skill's reference) is a finding too. */
function chainFindings(skillsDir = SKILLS, guidanceDir = GUIDANCE) {
  const entries = skillReferences(skillsDir);
  const guidance = path.join(guidanceDir, 'references');
  const names = new Set<string>([...entries.map((entry) => entry.name),
    ...(fs.existsSync(guidance) ? fs.readdirSync(guidance).filter((file: string) => file.endsWith('.md')) : [])]);
  const named = new Map<string, Set<string>>();
  for (const skill of fs.readdirSync(skillsDir)) {
    const file = path.join(skillsDir, skill, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const root = path.dirname(file);
    named.set(skill, new Set(fs.readFileSync(file, 'utf8').split('\n')
      .flatMap((line: string) => mentions(line, names).map((hit) => resolveMention(hit, file, root, guidanceDir)))
      .filter(Boolean) as string[]));
  }
  const findings: string[] = [];
  for (const { rel, skill, file, text } of entries) {
    const root = path.join(skillsDir, skill);
    text.split('\n').forEach((line: string, i: number) => {
      for (const hit of mentions(line, names)) {
        const target = resolveMention(hit, file, root, guidanceDir);
        if (target === file) continue;   // itself
        if (!target || !named.get(skill)?.has(target)) findings.push(`${rel}:${i + 1}: ${hit}`);
      }
    });
  }
  return { entries, findings };
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

/** A heading or contents entry as plain text: link targets, backticks and emphasis dropped. */
const plain = (text: string) => text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').trim();

/** Findings for references over the line limit: no `## Contents` in the first 40 lines; a contents
 * list (the list items right under it) of fewer than 2 entries; an entry that is not a `## `
 * heading of the file; or a section the list does not name. */
function tocFindings(entries: any[]) {
  const findings: string[] = [];
  for (const { rel, text } of entries) {
    const lines = text.split('\n');
    if (lines.length <= MAX_LINES_WITHOUT_TOC) continue;
    const at = lines.slice(0, 40).findIndex((line: string) => /^## (Contents|Table of contents)\s*$/i.test(line));
    if (at < 0) { findings.push(`${rel}: ${lines.length} lines and no "## Contents" in its first 40 lines`); continue; }
    const items: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!line.trim()) { if (items.length) break; continue; }
      const item = line.match(/^(?:[-*+]|\d+\.)\s+(.*)$/);
      if (item) items.push(plain(item[1]));
      else if (!/^\s+(?:[-*+]|\d+\.)\s/.test(line)) break;   // an indented sub-item stays in the list
    }
    const headings = sectionHeadings(text).map(plain).filter((h) => !/^(Contents|Table of contents)$/i.test(h));
    if (items.length < 2) findings.push(`${rel}: contents lists ${items.length} entries; it needs at least 2`);
    for (const item of items) if (!headings.includes(item)) findings.push(`${rel}: contents entry "${item}" is not a ## heading of this file`);
    for (const heading of headings) if (items.length >= 2 && !items.includes(heading)) findings.push(`${rel}: contents does not name "## ${heading}"`);
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
  const { findings } = chainFindings();
  assert.deepEqual(findings, [],
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

test('G75: controls — a chain, a long reference without contents, a spec without a scope, an oversized listing', (t) => {
  // A pointer passes only when it resolves to the very file its own SKILL.md names: skill a's
  // references/x.md does not clear skill b's bare `x.md`, and a's SKILL.md naming it clears nothing in b.
  const root = tempDir(t, 'doflow-g75-');
  const put = (rel: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  put('guidance/references/EVIDENCE_LEDGER.md', '# ledger\n');
  put('skills/a/SKILL.md', 'Read `references/x.md`.\n');
  put('skills/a/references/x.md', '# x\n');
  put('skills/b/SKILL.md', 'Read `references/b.md` and the guidance tree\'s `references/EVIDENCE_LEDGER.md`.\n');
  put('skills/b/references/c.md', '# c\n');
  put('skills/b/references/b.md', 'see `x.md`\nand the guidance tree\'s `references/EVIDENCE_LEDGER.md`\nand ../a/references/x.md\nthis file, b.md\nand `references/c.md`\nSKILL.md step 4\n');
  const run = () => chainFindings(path.join(root, 'skills'), path.join(root, 'guidance')).findings.sort();
  assert.deepEqual(run(), ['b/references/b.md:1: x.md', 'b/references/b.md:3: ../a/references/x.md', 'b/references/b.md:5: references/c.md']);
  put('skills/b/SKILL.md', 'Read `references/b.md`, `references/c.md`, `../a/references/x.md` and the guidance tree\'s `references/EVIDENCE_LEDGER.md`.\n');
  assert.deepEqual(run(), ['b/references/b.md:1: x.md'], 'a bare x.md in b resolves to no file b\'s SKILL.md names, even once it names a\'s x.md by path');

  const body = Array.from({ length: 301 }, (_, i) => `line ${i}`).join('\n');
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# t\n## One\n${body}` }]), ['x/references/long.md: 303 lines and no "## Contents" in its first 40 lines']);
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# t\n## Contents\n- One\n- Three\n\n## One\n## Three\n${body}\n## Two\n` }]), ['x/references/long.md: contents does not name "## Two"']);
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# t\n## Contents\n- One\n- [\`Two\`](#two)\n\n## One\n\`\`\`\n## not a heading\n\`\`\`\n## \`Two\`\n${body}` }]), []);
  // An empty, one-entry or made-up contents list is no contents list.
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# x\n## Contents\n${body}` }]), ['x/references/long.md: contents lists 0 entries; it needs at least 2']);
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# x\n## Contents\n- One\n\n## One\n${body}` }]), ['x/references/long.md: contents lists 1 entries; it needs at least 2']);
  assert.deepEqual(tocFindings([{ rel: 'x/references/long.md', text: `# x\n## Contents\n- One\n- Ghost\n\n## One\n${body}` }]), ['x/references/long.md: contents entry "Ghost" is not a ## heading of this file']);

  assert.deepEqual(toolScopeFindings([{ name: 'x', text: '---\nname: x\naccess: write\n---\n' }, { name: 'y', text: '---\nname: y\ntool-scope: some\n---\n' }]),
    ['x: tool-scope missing', "y: tool-scope 'some' is not one of all"]);

  const table = CAPS();
  const ids = harnessIds();
  assert.deepEqual(descriptionCapFindings(table, ids, table.agent_description_ratchet.chars), []);
  assert.match(descriptionCapFindings(table, ids, table.agent_description_ratchet.chars + 1).join('\n'), /over the \d+-character ratchet/);
  assert.match(descriptionCapFindings(table, ids, 15000 * 4 + 1).join('\n'), /claude: 15001 estimated tokens over its 15000-token cap/);
  assert.deepEqual(descriptionCapFindings({ ...table, agent_description_caps: table.agent_description_caps.filter((row: any) => row.harness !== 'pi') }, ids, 1), ['pi: no agent_description_caps row']);
});
