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
// Tokens are estimated at 4 bytes per token: 5,000 tokens = 20,000 B, 25,000 tokens = 100,000 B.
// The whole file is counted against the per-skill cap, the conservative reading.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, skillFiles, SKILLS } = require('./_shared');

const MAX_LISTING_CHARS = 1536;
const MAX_SKILL_BYTES = 20000;
const MAX_CLASS_BYTES = 100000;

/** Top-level frontmatter value for `key`: one line, or that line plus indented continuations. */
function frontmatterValue(text, key) {
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
function listingChars(text) {
  return frontmatterValue(text, 'description').length + frontmatterValue(text, 'when_to_use').length;
}

/** Whole-file size, and the byte offset at which `## Boundaries` starts (null when absent). */
function sizeAndBoundaries(text) {
  const at = text.search(/^## Boundaries\b/m);
  return {
    bytes: Buffer.byteLength(text, 'utf8'),
    boundaries: at < 0 ? null : Buffer.byteLength(text.slice(0, at), 'utf8'),
  };
}

const sum = (sizes) => sizes.reduce((total, bytes) => total + bytes, 0);

test('G22: every skill listing (description + when_to_use) fits 1,536 characters', () => {
  const over = [];
  for (const { name, file } of skillFiles()) {
    const chars = listingChars(fs.readFileSync(file, 'utf8'));
    if (chars === 0 || chars > MAX_LISTING_CHARS) {
      over.push(`${name}: ${chars} characters (cap ${MAX_LISTING_CHARS}; 0 means the frontmatter did not parse)`);
    }
  }
  assert.deepEqual(over, [], `skill listings past the cap:\n  ${over.join('\n  ')}`);
});

test('G22: every SKILL.md is within 20,000 bytes and keeps ## Boundaries inside them', () => {
  const over = [];
  for (const { name, file } of skillFiles()) {
    const { bytes, boundaries } = sizeAndBoundaries(fs.readFileSync(file, 'utf8'));
    if (bytes > MAX_SKILL_BYTES) over.push(`${name}: ${bytes} bytes (cap ${MAX_SKILL_BYTES})`);
    if (boundaries === null) over.push(`${name}: no "## Boundaries" heading`);
    else if (boundaries > MAX_SKILL_BYTES) {
      over.push(`${name}: ## Boundaries starts at byte ${boundaries} (cap ${MAX_SKILL_BYTES})`);
    }
  }
  assert.deepEqual(over, [],
    'skills past the post-compaction window; move maintainer-only or duplicated text out of SKILL.md:'
    + `\n  ${over.join('\n  ')}`);
});

test('G22: the SKILL.md files of each task class workflow fit 100,000 bytes together', () => {
  const { WorkflowEngine } = require('../../src/runtime/workflow-engine');
  const workflows = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8'));
  const engine = new WorkflowEngine({ workflows, readinessTemplates: false });
  const classes = engine.listClasses();
  assert.ok(classes.length > 0, 'no task classes resolved; the cap below would measure nothing');

  const over = [];
  for (const cls of classes) {
    const skills = [...new Set(engine.resolveWorkflow(cls).stages.map((stage) => stage.skill).filter(Boolean))];
    const parts = skills.map((skill) => ({
      skill, bytes: Buffer.byteLength(fs.readFileSync(path.join(SKILLS, skill, 'SKILL.md'), 'utf8'), 'utf8'),
    }));
    const total = sum(parts.map((part) => part.bytes));
    if (total > MAX_CLASS_BYTES) {
      over.push(`${cls}: ${total} bytes (cap ${MAX_CLASS_BYTES}): ${parts.map((p) => `${p.skill}=${p.bytes}`).join(', ')}`);
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
  const { bytes, boundaries } = sizeAndBoundaries(bulky);
  assert.ok(bytes > MAX_SKILL_BYTES, `fixture is ${bytes} bytes`);
  assert.ok(boundaries > MAX_SKILL_BYTES, `fixture Boundaries at ${boundaries}`);
  assert.equal(sizeAndBoundaries('# x\nno guardrails\n').boundaries, null);

  assert.ok(sum([60000, 40001]) > MAX_CLASS_BYTES);
});
