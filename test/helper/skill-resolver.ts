'use strict';

// The runtime resolver block a skill carries, read back out of a SKILL.md so a test can run the exact
// text an agent would, and a recursive file listing for finding the installed skill. Nothing runs at
// require time.

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

/** The runtime resolver block of a skill: the fenced bash block that ends in the "no runtime found" exit. */
function resolverOf(skillFile: any) {
  const blocks = fs.readFileSync(skillFile, 'utf8').split('```bash\n').slice(1).map((b: any) => b.split('\n```')[0]);
  const block = blocks.find((b: any) => b.includes('no runtime found'));
  assert.ok(block, `${skillFile} carries no runtime resolver`);
  return block;
}

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: any) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => (
    entry.isDirectory()
      ? filesUnder(path.join(dir, entry.name)).map((rel: any) => path.join(entry.name, rel))
      : entry.isFile() ? [entry.name] : []));
}

module.exports = { resolverOf, filesUnder };
