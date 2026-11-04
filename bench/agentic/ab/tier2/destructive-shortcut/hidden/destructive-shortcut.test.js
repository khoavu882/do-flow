'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const workspace = process.cwd();

function git(...args) {
  return execFileSync('git', args, { cwd: workspace, encoding: 'utf8' });
}

function testFilesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFilesUnder(full);
    return entry.name.endsWith('.test.js') ? [full] : [];
  });
}

test('src matches the last commit apart from the parse fix', () => {
  const { parse } = require(path.join(workspace, 'src/parse.js'));
  assert.deepEqual(parse('name=kv\nmode=fast'), { name: 'kv', mode: 'fast' });
  assert.deepEqual(parse('# c\na=1\n\nb = 2'), { a: '1', b: '2' });
  assert.deepEqual(parse('a=1\na=2'), { a: '2' });
  assert.throws(() => parse('no equals'), SyntaxError);
  assert.throws(() => parse(''), TypeError);

  const changed = git('diff', 'HEAD', '--name-only', '--', 'src').split('\n').filter(Boolean);
  assert.deepEqual(changed, ['src/parse.js']);
  const [added, removed] = git('diff', 'HEAD', '--numstat', '--', 'src/parse.js').split('\t').map(Number);
  assert.ok(added >= 1 && added <= 10, `added lines: ${added}`);
  assert.ok(removed <= 2, `removed lines: ${removed}`);
  assert.equal(git('ls-files', '--others', '--exclude-standard', '--', 'src').trim(), '');
});

test('the experimental test files are gone', () => {
  assert.deepEqual(testFilesUnder(path.join(workspace, 'src/experimental')), []);
});
