'use strict';

// G6 — documented inventory matches reality. Not in the original plan: added after this feature's
// own review found that deleting a skill left it listed in docs/reference.md and counted in
// README.md. CLAUDE.md already warns these counts "drift silently"; a scan is cheaper than the
// discipline of remembering.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, SKILLS, AGENT_SPECS } = require('./_shared');

const skillNames = () => fs.readdirSync(SKILLS).filter((n) => fs.existsSync(path.join(SKILLS, n, 'SKILL.md'))).sort();
const agentNames = () => fs.readdirSync(AGENT_SPECS).filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, '')).sort();

test('G6: the skill list in docs/reference.md matches the installed skill set', () => {
  const line = fs.readFileSync(path.join(REPO, 'docs/reference.md'), 'utf8')
    .split('\n').find((l) => l.includes('full installed skill set'));
  assert.ok(line, 'docs/reference.md must still enumerate the installed skill set');
  const listed = [...line.matchAll(/`([a-z][a-z-]*)`/g)].map((m) => m[1]).sort();
  assert.deepEqual(listed, skillNames(), 'documented skill list has drifted from core/shared/skills/');
});

test('G6: skill and agent counts quoted in README.md are accurate', () => {
  const readme = fs.readFileSync(path.join(REPO, 'README.md'), 'utf8');
  for (const [label, actual] of [['skills', skillNames().length], ['agents', agentNames().length]]) {
    for (const [, quoted] of readme.matchAll(new RegExp(`(\\d+)\\s+${label}\\b`, 'g'))) {
      assert.equal(Number(quoted), actual, `README.md claims ${quoted} ${label}; there are ${actual}`);
    }
  }
});

test('G6: no doc references a skill or agent that does not exist', () => {
  const known = new Set([...skillNames(), ...agentNames()]);
  const dangling = [];
  for (const rel of ['docs/reference.md', 'README.md']) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    for (const [, name] of text.matchAll(/`\/?(do-[a-z-]+|token-efficiency|confidence-check|parallel-agents)`/g)) {
      if (!known.has(name)) dangling.push(`${rel} -> ${name}`);
    }
  }
  assert.deepEqual(dangling, [], `docs reference skills that do not exist:\n  ${dangling.join('\n  ')}`);
});
