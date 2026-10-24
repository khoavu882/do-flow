'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalizeLocator, fuseHybridResults } = require('../../src/runtime/knowledge/hybrid.ts');

test('knowledge-hybrid: normalizeLocator handles various string and object formats', () => {
  const root = '/workspace/project';

  // Plain string
  assert.deepEqual(normalizeLocator('src/index.js', root), { file: 'src/index.js' });

  // String with line number
  assert.deepEqual(normalizeLocator('src/index.js:42', root), { file: 'src/index.js', line: 42 });

  // String with line and column
  assert.deepEqual(normalizeLocator('src/index.js:42:10', root), { file: 'src/index.js', line: 42 });

  // Absolute path converted to project-relative
  assert.deepEqual(normalizeLocator('/workspace/project/src/index.js:15', root), { file: 'src/index.js', line: 15 });

  // Object with file, line, endLine
  assert.deepEqual(normalizeLocator({ file: 'src/app.js', line: 10, endLine: 20 }, root), {
    file: 'src/app.js',
    line: 10,
    endLine: 20,
  });

  // Empty or invalid input
  assert.deepEqual(normalizeLocator(null, root), { file: '' });
  assert.deepEqual(normalizeLocator('', root), { file: '' });
});

test('knowledge-hybrid: fuseHybridResults fuses ranks with RRF and deduplicates locators', () => {
  const lexical: any = [
    { locator: 'src/auth/jwt.js:10', term: 'verifyToken', match: 'function verifyToken()' },
    { locator: 'src/auth/session.js:25', term: 'verifyToken', match: 'session.verifyToken()' },
  ];

  const semantic: any = [
    { locator: 'src/auth/jwt.js:10', concept: 'authentication token validation' },
    { locator: 'src/routes/login.js:50', concept: 'login endpoint handler' },
  ];

  const fused = fuseHybridResults({
    lexicalResults: lexical,
    semanticResults: semantic,
    topN: 5,
  });

  // src/auth/jwt.js:10 is in both lists at top ranks, so it must be rank 0
  assert.equal(fused[0].locator.file, 'src/auth/jwt.js');
  assert.equal(fused[0].locator.line, 10);
  assert.ok(fused[0].rrfScore > 0);

  // Deduplication: 3 unique locators
  assert.equal(fused.length, 3);
  const files = fused.map((f: any) => f.locator.file);
  assert.ok(files.includes('src/auth/session.js'));
  assert.ok(files.includes('src/routes/login.js'));
});

test('knowledge-hybrid: bounded live source reading populates snippets within line limits', () => {
  const fakeFs: any = {
    existsSync: (p: any) => p.endsWith('src/service.js'),
    readFileSync: () => 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8\nline 9\nline 10',
  };

  const fused = fuseHybridResults({
    lexicalResults: [{ locator: 'src/service.js:5' }],
    semanticResults: [],
    projectRoot: '/mock',
    maxSnippetLines: 4,
    fsImpl: fakeFs,
  });

  assert.equal(fused.length, 1);
  assert.ok(fused[0].snippet);
  assert.ok(fused[0].liveRead);
  assert.equal(fused[0].liveRead.startLine, 3);
  assert.equal(fused[0].liveRead.endLine, 6);
  assert.ok(fused[0].snippet.includes('line 4'));
});
