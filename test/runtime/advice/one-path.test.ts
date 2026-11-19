'use strict';

// Row 174 O-1 and O-6: there is one dispatcher path. The three callers that had a second, unset-kind path (classify,
// brief-tools, review start) no longer branch on whether a kind is set, never ask the client directly, and classify writes
// no outcome of its own. Behaviour is covered per caller (advice-classify, advice-brief-tools, review-start,
// advice-ask-modes); this file pins the removal of the code itself.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../../src/helper/repo-root.ts');

const read = (file: string) => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const CALLERS = ['src/runtime/task-classifier.ts', 'src/runtime/brief-tools.ts', 'src/runtime/review/start.ts'];

for (const file of CALLERS) {
  test(`${file} has no second path: no kindSet, no unsetKindPath, no direct client.ask`, () => {
    const source = read(file);
    assert.doesNotMatch(source, /kindSet|unsetKindPath/);
    assert.doesNotMatch(source, /\.ask\(/, 'every decision call goes through interceptDecisionPoint');
    assert.match(source, /interceptDecisionPoint/);
  });
}

test('the one-path helpers are gone from the advice modules', () => {
  assert.doesNotMatch(read('src/runtime/advice/mode.ts'), /unsetKindPath/);
  assert.doesNotMatch(read('src/runtime/advice/shadow-config.ts'), /kindSet/);
});

test('classify records no outcome: no appendOutcome, and classify-verdict appears in src only as a retired outcome source', () => {
  assert.doesNotMatch(read('src/runtime/task-classifier.ts'), /appendOutcome|findPick|classify-verdict/);
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
      const relative = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(relative);
      else if (/\.(ts|js)$/.test(entry.name) && /classify-verdict/.test(read(relative))) found.push(relative);
    }
  };
  walk('src');
  assert.deepEqual(found, [path.join('src', 'runtime', 'advice', 'retired.ts')]);
  assert.deepEqual(require('../../../src/runtime/advice/retired.ts').RETIRED_OUTCOME_SOURCES, ['classify-verdict']);
});
