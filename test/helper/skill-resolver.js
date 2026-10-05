'use strict';

// The runtime resolver block a skill carries, read back out of a SKILL.md so a test can run the exact
// text an agent would. Nothing runs at require time.

const fs = require('node:fs');
const assert = require('node:assert/strict');

/** The runtime resolver block of a skill: the fenced bash block that ends in the "no runtime found" exit. */
function resolverOf(skillFile) {
  const blocks = fs.readFileSync(skillFile, 'utf8').split('```bash\n').slice(1).map((b) => b.split('\n```')[0]);
  const block = blocks.find((b) => b.includes('no runtime found'));
  assert.ok(block, `${skillFile} carries no runtime resolver`);
  return block;
}

module.exports = { resolverOf };
