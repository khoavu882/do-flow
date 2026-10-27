'use strict';

// G22 — skill size caps. Three limits the host applies to skill text, enforced here so a skill
// cannot grow past them unnoticed:
//   1. A skill's `description` plus `when_to_use` is truncated at 1,536 characters in the skill
//      listing (Claude Code `skills.md`).
//   2. After compaction only the first 5,000 tokens of each invoked skill are re-attached
//      (Claude Code `skills.md` and `context-window.md`), so text past that point is dropped;
//      the guardrails in `## Boundaries` must start inside the window.
//   3. Re-attached skills share a 25,000-token budget (`context-window.md`), so the SKILL.md
//      files a task class's workflow invokes must fit it together.
//   4. The skill listing as a whole is capped at 2% of the model's context window, or 8,000
//      characters when the window is unknown (Codex, https://learn.chatgpt.com/docs/build-skills,
//      accessed 2026-10-05); over it the host shortens descriptions or drops skills from the listing.
//   5. (row 131) Every top-level SKILL.md frontmatter key is an Agent Skills spec key or a harness's
//      skillFields in core/registry/contracts.json; each list names its vendor page and the date it was
//      read, and a harness that does not read a key gets it under `metadata` through its
//      `skill-frontmatter-<harness>` transform.
// Tokens are estimated at 4 bytes per token: 5,000 tokens = 20,000 B, 25,000 tokens = 100,000 B.
// The whole file is counted against the per-skill cap, the conservative reading.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, skillFiles, SKILLS, frontmatterKeys, frontmatterKeysOf } = require('./_shared.ts');

const MAX_LISTING_CHARS = 1536;
// "at most 2% of the model's context window, or 8,000 characters when the context window is unknown"
// (https://learn.chatgpt.com/docs/build-skills, accessed 2026-10-05). The only vendor figure held here.
const MAX_LISTING_TOTAL_CHARS = 8000;
const MAX_SKILL_BYTES = 20000;
// Tighter than the size cap: the guardrails must sit well inside the window, not on its edge, so a
// skill that grows toward the cap trips this before its Boundaries are at risk.
const MAX_BOUNDARIES_OFFSET = 19000;
const MAX_CLASS_BYTES = 100000;

/** Top-level frontmatter value for `key`: one line, or that line plus indented continuations. */
function frontmatterValue(text: any, key: any) {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return '';
  let value = null;
  for (const line of lines.slice(1)) {
    if (line.trim() === '---') break;
    if (value !== null) {
      if (/^\s+\S/.test(line)) { value += ` ${line.trim()}`; continue; }
      break;
    }
    const match = line.match(new RegExp(`^${key}\\s*:\\s*(.*)$`));
    if (match) value = match[1].trim();
  }
  if (value === null) return '';
  return /^".*"$/.test(value) ? value.slice(1, -1).replace(/\\(["\\])/g, '$1') : value;
}

/** Characters the skill listing carries for this skill: `description` plus `when_to_use`. */
function listingChars(text: any) {
  return frontmatterValue(text, 'description').length + frontmatterValue(text, 'when_to_use').length;
}

/** Whole-file size, and the byte offset at which `## Boundaries` starts (null when absent). */
function sizeAndBoundaries(text: any) {
  const at = text.search(/^## Boundaries\b/m);
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    boundaries: at < 0 ? null : Buffer.byteLength(text.slice(0, at), 'utf8'),
  };
}

/** Listing characters summed over `entries` ({ name, text }); `names` is reported, never compared. */
function listingTotals(entries: any) {
  const perSkill = entries.map(({ name, text }: any) => ({ name, chars: listingChars(text) }));
  const description = entries.reduce((n: any, { text }: any) => n + frontmatterValue(text, 'description').length, 0);
  const whenToUse = entries.reduce((n: any, { text }: any) => n + frontmatterValue(text, 'when_to_use').length, 0);
  return {
    description,
    whenToUse,
    names: entries.reduce((n: any, { name }: any) => n + name.length, 0),
    total: description + whenToUse,
    perSkill,
  };
}

/** The failure message for a listing past the total budget, or '' when it fits. */
function listingOverBudget({ description, whenToUse, total, perSkill }: any) {
  if (total <= MAX_LISTING_TOTAL_CHARS) return '';
  const largest = perSkill.slice().sort((a: any, b: any) => b.chars - a.chars).slice(0, 5)
    .map(({ name, chars }: any) => `${name}=${chars}`).join(', ');
  return `skill listing total ${total} characters (description ${description} + when_to_use ${whenToUse}) is over the `
    + `${MAX_LISTING_TOTAL_CHARS}-character fallback budget; per-skill cap ${MAX_LISTING_CHARS} (G22). Largest: ${largest}`;
}

const sum = (sizes: any) => sizes.reduce((total: any, bytes: any) => total + bytes, 0);

test('G22: every skill listing (description + when_to_use) fits 1,536 characters', () => {
  const over: any = [];
  for (const { name, file } of skillFiles()) {
    const chars = listingChars(fs.readFileSync(file, 'utf8'));
    if (chars === 0 || chars > MAX_LISTING_CHARS) {
      over.push(`${name}: ${chars} characters (cap ${MAX_LISTING_CHARS}; 0 means the frontmatter did not parse)`);
    }
  }
  assert.deepEqual(over, [], `skill listings past the cap:\n  ${over.join('\n  ')}`);
});

test('G22: the skill listing as a whole fits the 8,000-character fallback budget', (t) => {
  const entries = skillFiles().map(({ name, file }: any) => ({ name, text: fs.readFileSync(file, 'utf8') }));
  assert.ok(entries.length > 0, 'no skills parsed; the total below would measure nothing');
  const totals = listingTotals(entries);
  const empty = totals.perSkill.filter(({ chars }: any) => chars === 0)
    .map(({ name }: any) => `${name}: 0 characters (cap ${MAX_LISTING_CHARS}; 0 means the frontmatter did not parse)`);
  assert.deepEqual(empty, [], `skill listings past the cap:\n  ${empty.join('\n  ')}`);
  const { description, whenToUse, total, names } = totals;
  t.diagnostic(`skill listing: ${description} description + ${whenToUse} when_to_use = ${total} of ${MAX_LISTING_TOTAL_CHARS} `
    + `characters; per-skill cap ${MAX_LISTING_CHARS}; names ${names}`);
  assert.equal(listingOverBudget(totals), '');
});

test('G22: every SKILL.md is within 20,000 bytes and starts ## Boundaries by byte 19,000', () => {
  const over: any = [];
  for (const { name, file } of skillFiles()) {
    const { bytes, boundaries } = sizeAndBoundaries(fs.readFileSync(file, 'utf8'));
    if (bytes > MAX_SKILL_BYTES) over.push(`${name}: ${bytes} bytes (cap ${MAX_SKILL_BYTES})`);
    if (boundaries === null) over.push(`${name}: no "## Boundaries" heading`);
    else if (boundaries > MAX_BOUNDARIES_OFFSET) {
      over.push(`${name}: ## Boundaries starts at byte ${boundaries} (cap ${MAX_BOUNDARIES_OFFSET})`);
    }
  }
  assert.deepEqual(over, [],
    'skills past the post-compaction window; move maintainer-only or duplicated text out of SKILL.md:'
    + `\n  ${over.join('\n  ')}`);
});

test('G22: the SKILL.md files of each task class workflow fit 100,000 bytes together', () => {
  const { WorkflowEngine } = require('../../src/runtime/workflow-engine.ts');
  const workflows = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8'));
  const engine: any = new WorkflowEngine({ workflows, readinessTemplates: false });
  const classes = engine.listClasses();
  assert.ok(classes.length > 0, 'no task classes resolved; the cap below would measure nothing');

  const over: any = [];
  for (const cls of classes) {
    const skills: any = [...new Set(engine.resolveWorkflow(cls).stages.map((stage: any) => stage.skill).filter(Boolean))];
    const parts = skills.map((skill: any) => ({
      skill, bytes: Buffer.byteLength(fs.readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf8'), 'utf8'),
    }));
    if (cls === 'feature') {
      assert.ok(skills.includes('do-code-review') && skills.includes('do-brainstorm'),
        `the feature class resolved [${skills.join(', ')}]; stage.skill no longer names its skills, so the sums measure nothing`);
    }
    const total = sum(parts.map((part: any) => part.bytes));
    if (total > MAX_CLASS_BYTES) {
      over.push(`${cls}: ${total} bytes (cap ${MAX_CLASS_BYTES}): ${parts.map((p: any) => `${p.skill}=${p.bytes}`).join(', ')}`);
    }
  }
  assert.deepEqual(over, [], `task classes past the shared skill budget:\n  ${over.join('\n  ')}`);
});

// Positive controls: each measuring function must report a violation on a fixture built to have one,
// so the three tests above cannot pass by measuring nothing.
test('G22: positive controls — the measures see an oversized fixture', () => {
  const longListing = `---\nname: x\ndescription: "${'a'.repeat(1000)}"\nwhen_to_use: ${'b'.repeat(537)}\n---\n`;
  assert.equal(listingChars(longListing), 1537);
  assert.ok(listingChars(longListing) > MAX_LISTING_CHARS);

  const bulky = `# x\n${'é'.repeat(10001)}\n## Boundaries\n`;
  const { bytes, boundaries }: any = sizeAndBoundaries(bulky);
  assert.ok(bytes > MAX_SKILL_BYTES, `fixture is ${bytes} bytes`);
  assert.ok(boundaries > MAX_SKILL_BYTES, `fixture Boundaries at ${boundaries}`);
  assert.equal(sizeAndBoundaries('# x\nno guardrails\n').boundaries, null);

  const lateHeading = `# x\n${'a'.repeat(19500)}\n## Boundaries\n`;
  const late: any = sizeAndBoundaries(lateHeading);
  assert.ok(late.bytes <= MAX_SKILL_BYTES && late.boundaries > MAX_BOUNDARIES_OFFSET,
    `fixture is ${late.bytes} bytes with Boundaries at ${late.boundaries}`);

  assert.ok(sum([60000, 40001]) > MAX_CLASS_BYTES);
});

test('G22: controls — the listing total sees an over-budget fixture', () => {
  const six = Array.from({ length: 6 }, (_, i) => ({
    name: `skill-${i}`, text: `---\nname: x\ndescription: ${'a'.repeat(1400)}\n---\n`,
  }));
  const totals = listingTotals(six);
  assert.equal(totals.total, 8400);
  assert.ok(totals.total > MAX_LISTING_TOTAL_CHARS);
  assert.match(listingOverBudget(totals), /^skill listing total 8400 characters \(description 8400 \+ when_to_use 0\) is over the 8000-character/);
  assert.equal(listingOverBudget(listingTotals(six.slice(0, 5))), '');

  const whenOnly = listingTotals([{ name: 'w', text: `---\nname: w\ndescription: d\nwhen_to_use: ${'b'.repeat(8001)}\n---\n` }]);
  assert.equal(whenOnly.whenToUse, 8001);
  assert.equal(whenOnly.total, 8002);
  assert.ok(listingOverBudget(whenOnly) !== '');
});

// Row 131: the frontmatter key whitelist and its projection. core/registry/contracts.json is the one
// list (agentSkillsSpec plus each contract's skillFields); the transforms in src/adapters/copy-tree.ts
// read the same file.
const CONTRACTS = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'contracts.json'), 'utf8'));

/** Keys a source SKILL.md may carry: the spec's plus every harness's declared skillFields. */
function allowedSkillKeys(table: any) {
  return new Set<string>([...table.agentSkillsSpec.skillFields, ...table.contracts.flatMap((row: any) => row.skillFields || [])]);
}

/** `name: [keys]` for each skill carrying a key outside `allowed`. */
function unknownSkillKeys(entries: any, allowed: Set<string>) {
  return entries.map(({ name, keys }: any) => ({ name, bad: keys.filter((key: string) => !allowed.has(key)) }))
    .filter(({ bad }: any) => bad.length).map(({ name, bad }: any) => `${name}: ${bad.join(', ')}`);
}

/** Record-shape problems: no spec source, or a harness the skills project to without skillFields,
 * a vendor page or the date it was read. */
function skillFieldProblems(table: any, harnessIds: string[]) {
  const problems: string[] = [];
  const spec = table.agentSkillsSpec;
  if (!/^https:\/\//.test(spec?.source || '') || !/^\d{4}-\d{2}-\d{2}$/.test(spec?.verifiedOn || '')) problems.push('agentSkillsSpec: source or verifiedOn missing');
  for (const id of harnessIds) {
    const row = table.contracts.find((entry: any) => entry.harness === id);
    if (!Array.isArray(row?.skillFields)) { problems.push(`${id}: no skillFields`); continue; }
    if (!/^https:\/\//.test(row.skillFieldsSource || '')) problems.push(`${id}: no skillFieldsSource`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.skillFieldsVerifiedOn || '')) problems.push(`${id}: no skillFieldsVerifiedOn date`);
  }
  return problems;
}

/** The keys of `used` a harness keeps at the top level. */
const keptKeys = (table: any, id: string, used: Set<string>) => {
  const row = table.contracts.find((entry: any) => entry.harness === id);
  const readable = new Set<string>([...table.agentSkillsSpec.skillFields, ...row.skillFields]);
  return [...used].filter((key) => readable.has(key)).sort();
};

const skillsAsset = () => JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'assets.json'), 'utf8'))
  .assets.find((asset: any) => asset.id === 'skills.doflow');

test('G22: every SKILL.md frontmatter key is an Agent Skills spec key or a harness skillField', () => {
  const entries = skillFiles().map(({ name, file }: any) => ({ name, keys: frontmatterKeys(file) }));
  assert.ok(entries.every(({ keys }: any) => keys.includes('name')), 'a SKILL.md frontmatter did not parse');
  assert.deepEqual(unknownSkillKeys(entries, allowedSkillKeys(CONTRACTS)), [],
    'add the key to a harness contract\'s skillFields in core/registry/contracts.json (with its vendor page), or remove it');
});

test('G22: every harness the skills project to has dated skillFields and a transform for keys it does not read', () => {
  const asset = skillsAsset();
  assert.deepEqual(skillFieldProblems(CONTRACTS, asset.appliesTo), []);
  const used = new Set<string>(skillFiles().flatMap(({ file }: any) => frontmatterKeys(file)));
  const missing: string[] = [];
  for (const id of asset.appliesTo) {
    const foreign = [...used].filter((key) => !keptKeys(CONTRACTS, id, used).includes(key));
    if (foreign.length && asset.projection[id]?.transform !== `skill-frontmatter-${id}`) {
      missing.push(`${id}: projects [${foreign.join(', ')}] without transform skill-frontmatter-${id}`);
    }
  }
  assert.deepEqual(missing, []);
  // Codex and Copilot write the same files under .agents/skills, so they must keep the same keys.
  assert.deepEqual(keptKeys(CONTRACTS, 'codex', used), keptKeys(CONTRACTS, 'copilot', used));
});

test('G22: controls — an unknown key, a contract without a source, and the metadata move', () => {
  const allowed = allowedSkillKeys(CONTRACTS);
  assert.deepEqual(unknownSkillKeys([{ name: 'x', keys: ['name', 'description', 'bogus'] }], allowed), ['x: bogus']);
  assert.deepEqual(unknownSkillKeys([{ name: 'x', keys: ['name', 'description', 'effort'] }], allowed), []);
  const bad = { agentSkillsSpec: CONTRACTS.agentSkillsSpec, contracts: [{ harness: 'codex', skillFields: ['name'], skillFieldsVerifiedOn: '2026-10-27' }] };
  assert.deepEqual(skillFieldProblems(bad, ['codex', 'pi']), ['codex: no skillFieldsSource', 'pi: no skillFields']);

  const { TRANSFORMS, portableSkillFrontmatter } = require('../../src/adapters/copy-tree.ts');
  const source = '---\nname: x\ndescription: "d"\nargument-hint: "[a] [--b c|d]"\neffort: high\n---\n\n# x\n';
  const moved = TRANSFORMS['skill-frontmatter-codex']('x/SKILL.md', Buffer.from(source)).toString('utf8');
  assert.equal(moved, '---\nname: x\ndescription: "d"\nmetadata:\n  argument-hint: "[a] [--b c|d]"\n  effort: "high"\n---\n\n# x\n');
  assert.equal(TRANSFORMS['skill-frontmatter-claude']('x/SKILL.md', Buffer.from(source)).toString('utf8'), source);
  assert.equal(TRANSFORMS['skill-frontmatter-codex']('x/references/a.md', Buffer.from(source)).toString('utf8'), source);
  const withMetadata = portableSkillFrontmatter('---\nname: x\nmetadata:\n  author: me\neffort: low\n---\n', new Set(['name', 'metadata']));
  assert.equal(withMetadata, '---\nname: x\nmetadata:\n  author: me\n  effort: "low"\n---\n');
  assert.throws(() => portableSkillFrontmatter('---\nname: x\nhooks:\n  a: b\n---\n', new Set(['name'])), /no scalar value/);
  // A quoted key is still a key: the whitelist sees it and the projection moves it.
  const quoted = '---\n"name": x\n"bogus": value\n\'odd\': v\n---\n';
  assert.deepEqual(frontmatterKeysOf(quoted), ['name', 'bogus', 'odd']);
  assert.deepEqual(unknownSkillKeys([{ name: 'x', keys: frontmatterKeysOf(quoted) }], allowed), ['x: bogus, odd']);
  assert.equal(portableSkillFrontmatter(quoted, new Set(['name'])), '---\n"name": x\nmetadata:\n  bogus: "value"\n  odd: "v"\n---\n');
  // Quoted values decode as YAML does before they are re-quoted: '' in single quotes, \" and \\ in double.
  const value = (line: string) => portableSkillFrontmatter(`---\nname: x\n${line}\n---\n`, new Set(['name'])).split('\n')[3];
  assert.equal(value("argument-hint: 'it''s here'"), '  argument-hint: "it\'s here"');
  assert.equal(value('argument-hint: "say \\"hi\\" \\\\ back"'), '  argument-hint: "say \\"hi\\" \\\\ back"');
  assert.equal(value("effort: high"), '  effort: "high"');
  assert.throws(() => value('effort: "bad \\q escape"'), /SKILL\.md: 'effort' has a double-quoted value with an escape this projector does not decode/);
});

/** `name: metadata is flow-style` for each SKILL.md whose metadata is written inline (`{...}`, `[...]`
 * or any value on the key's own line): the projector appends block entries and refuses that shape. */
function flowMetadataFindings(entries: any[]) {
  return entries.filter(({ text }: any) => /^metadata:[ \t]*[^\s#]/m.test(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''))
    .map(({ name }: any) => `${name}: metadata is flow-style; write it as a block map`);
}

test('G22: no SKILL.md writes metadata flow-style, and the projector refuses one that does', () => {
  assert.deepEqual(flowMetadataFindings(skillFiles().map(({ name, file }: any) => ({ name, text: fs.readFileSync(file, 'utf8') }))), []);
  const flow = '---\nname: x\nmetadata: {author: me}\neffort: high\n---\n';
  assert.deepEqual(flowMetadataFindings([{ name: 'x', text: flow }]), ['x: metadata is flow-style; write it as a block map']);
  assert.deepEqual(flowMetadataFindings([{ name: 'x', text: '---\nname: x\nmetadata:\n  author: me\n---\n' }]), []);
  const { TRANSFORMS } = require('../../src/adapters/copy-tree.ts');
  assert.throws(() => TRANSFORMS['skill-frontmatter-codex']('do-x/SKILL.md', Buffer.from(flow)), /do-x\/SKILL\.md: .*flow-style metadata/);
});
