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
  for (const needle of [
    'roadmap seed --action check', 'MODEL_SELECTION.md', 'deep_research.md', 'EVIDENCE_LEDGER.md', '`land`',
    'never run it', 'a subagent, a policy or autopilot', 'at most 6', 'at most 3',
    'SKILL.md step 5', 'no report file',
  ]) {
    assert.ok(text.includes(needle), `program_mode.md lacks ${needle}`);
  }
  // sub-questions and sources are both capped at 6
  assert.ok(text.split('at most 6').length - 1 >= 2, 'program_mode.md caps both sub-questions and sources at 6');
});

test('program_mode.md names no vendor model and no harness-only tool', () => {
  const text = read('references/program_mode.md');
  assert.doesNotMatch(text, /haiku|sonnet|opus/i);
  assert.ok(!text.includes('AskUserQuestion'));
  assert.ok(!text.includes('TodoWrite'));
});

test('pm_routing.md no longer carries the Epic hierarchy', () => {
  assert.ok(!read('references/pm_routing.md').includes('Epic'));
});

test('pm_routing.md sends --depth deep to program_mode.md', () => {
  const line = read('references/pm_routing.md').split('\n').find((l) => l.includes('--depth deep'));
  assert.ok(line, 'pm_routing.md has a --depth deep line');
  assert.ok(line.includes('program_mode.md'), '--depth deep line does not name program_mode.md');
});
