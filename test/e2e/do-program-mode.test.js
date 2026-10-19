'use strict';
// IC-006 (114): the /do program mode pointer chain. SKILL.md points at the reference, the reference
// keeps its load-bearing elements and no harness-only or vendor wording, and pm_routing.md no longer
// describes the old Epic hierarchy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SKILL_DIR = path.resolve(__dirname, '../../core/shared/skills/do');
const read = (rel) => fs.readFileSync(path.join(SKILL_DIR, rel), 'utf8');

test('do/SKILL.md points at references/program_mode.md', () => {
  assert.ok(read('SKILL.md').includes('references/program_mode.md'));
});

test('program_mode.md keeps its load-bearing elements', () => {
  const text = read('references/program_mode.md');
  for (const needle of ['roadmap seed --action check', 'MODEL_SELECTION.md', 'deep_research.md', 'EVIDENCE_LEDGER.md', '`land`']) {
    assert.ok(text.includes(needle), `program_mode.md lacks ${needle}`);
  }
});

test('program_mode.md names no vendor model and no harness-only tool', () => {
  const text = read('references/program_mode.md');
  assert.doesNotMatch(text, /haiku|sonnet|opus/i);
  assert.ok(!text.includes('AskUserQuestion'));
});

test('pm_routing.md no longer carries the Epic hierarchy', () => {
  assert.ok(!read('references/pm_routing.md').includes('Epic'));
});
