'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const a = require('../../bench/retrieval/lib/adapters-a.js');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(REPO, 'test', 'fixtures', 'retrieval');
const CAPS = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'capabilities.json'), 'utf8')).capabilities;
const posix = process.platform !== 'win32' ? false : 'stub executables need a POSIX shebang';

function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

test('semble recorded fixture parser produces expected candidates', { skip: posix }, (t) => {
  const fixtureFile = path.join(FIXTURES_DIR, 'semble-search.json');
  assert.ok(fs.existsSync(fixtureFile), 'semble fixture must exist');
  const fixtureData = JSON.parse(fs.readFileSync(fixtureFile, 'utf8'));

  const root = tempDir(t, 'doflow-adapter-semble-');
  const binDir = tempDir(t, 'doflow-adapter-semble-bin-');
  const bins = {
    semble: stub(binDir, 'semble', `
const fs = require('fs');
process.stdout.write(fs.readFileSync(${JSON.stringify(fixtureFile)}));
`),
    rtk: stub(binDir, 'rtk', `
process.stdout.write('compressed output');
`),
  };

  const task = {
    query: 'capabilities',
    class: 'conceptual-discovery',
    expect: { result: ['RETRIEVED'] },
  };

  const ans = a.runA({
    task,
    exportRoot: root,
    capabilities: CAPS,
    bins,
    scratchDir: tempDir(t, 'doflow-scratch-'),
  });

  assert.equal(ans.result, 'RETRIEVED');
  assert.equal(ans.freshness, 'UNKNOWN');
  assert.equal(ans.candidates.length, 10);
  assert.equal(ans.candidates[0].path, 'src/runtime/capability-router.ts');
  assert.equal(ans.candidates[0].startLine, 63);
  assert.equal(ans.candidates[0].endLine, 71);
  assert.equal(ans.candidates[0].provider, 'semble.search');
  assert.equal(ans.candidates[0].rank, 1);
  assert.ok(ans.candidates[0].snippet.includes('this.capabilities = options.capabilities'));
  assert.ok(ans.candidates.every((c) => !('score' in c)), 'scores must be dropped');

  // Verify all 10 candidates correspond to the top 10 fixture results
  for (let i = 0; i < 10; i++) {
    const raw = fixtureData.results[i];
    assert.equal(ans.candidates[i].path, raw.file_path);
    assert.equal(ans.candidates[i].startLine, raw.start_line);
    assert.equal(ans.candidates[i].endLine, raw.end_line);
    assert.equal(ans.candidates[i].rank, i + 1);
  }
});

test('graphify query recorded fixture parser extracts node locs and skips empty src', { skip: posix }, (t) => {
  const fixtureFile = path.join(FIXTURES_DIR, 'graphify-query.json');
  assert.ok(fs.existsSync(fixtureFile), 'graphify fixture must exist');

  const root = tempDir(t, 'doflow-adapter-graphify-');
  const binDir = tempDir(t, 'doflow-adapter-graphify-bin-');
  const bins = {
    graphify: stub(binDir, 'graphify', `
const fs = require('fs');
process.stdout.write(fs.readFileSync(${JSON.stringify(fixtureFile)}));
`),
    rtk: stub(binDir, 'rtk', `
process.stdout.write('compressed output');
`),
  };

  const task = {
    query: '{ capabilities }',
    class: 'stale-index',
    capability: 'code.relationships',
    expect: { result: ['RETRIEVED'] },
  };

  const ans = a.runA({
    task,
    exportRoot: root,
    capabilities: CAPS,
    bins,
    scratchDir: tempDir(t, 'doflow-scratch-'),
  });

  assert.equal(ans.result, 'RETRIEVED');
  assert.equal(ans.freshness, 'UNKNOWN');
  assert.equal(ans.candidates.length, 10, 'capped at K_MAX.code (10)');

  // First candidate: NODE { capabilities } [src=test/guards/provider-source-mode.test.js loc=L21 community=]
  assert.equal(ans.candidates[0].path, 'test/guards/provider-source-mode.test.js');
  assert.equal(ans.candidates[0].startLine, 21);
  assert.equal(ans.candidates[0].endLine, 21);
  assert.equal(ans.candidates[0].provider, 'graphify.query');
  assert.equal(ans.candidates[0].rank, 1);

  // Second candidate: NODE provider-source-mode.test.js [src=test/guards/provider-source-mode.test.js loc=L1 community=]
  assert.equal(ans.candidates[1].path, 'test/guards/provider-source-mode.test.js');
  assert.equal(ans.candidates[1].startLine, 1);
  assert.equal(ans.candidates[1].endLine, 1);

  // Line 5 (NODE ref_node_path [src= loc= community=]) has empty src and must be skipped
  // Third candidate is line 8: NODE registry/index.ts [src=src/registry/index.ts loc=L1 community=]
  assert.equal(ans.candidates[2].path, 'src/registry/index.ts');
  assert.equal(ans.candidates[2].startLine, 1);
  assert.equal(ans.candidates[2].endLine, 1);

  // Fourth candidate is line 9: NODE loadRegistry() [src=src/registry/index.ts loc=L63 community=]
  assert.equal(ans.candidates[3].path, 'src/registry/index.ts');
  assert.equal(ans.candidates[3].startLine, 63);
  assert.equal(ans.candidates[3].endLine, 63);

  assert.ok(ans.candidates.every((c) => c.path.length > 0 && !c.path.startsWith('src=')));
});

test('rtk recorded fixture parser compresses output and records payload', { skip: posix }, (t) => {
  const fixtureFile = path.join(FIXTURES_DIR, 'rtk-output.txt');
  assert.ok(fs.existsSync(fixtureFile), 'rtk fixture must exist');
  const fixtureContent = fs.readFileSync(fixtureFile, 'utf8');

  const binDir = tempDir(t, 'doflow-adapter-rtk-bin-');
  const bins = {
    rtk: stub(binDir, 'rtk', `
const fs = require('fs');
process.stdout.write(fs.readFileSync(${JSON.stringify(fixtureFile)}));
`),
  };

  const scratchDir = tempDir(t, 'doflow-adapter-rtk-scratch-');
  const res = a.compressWithRtk('uncompressed text with multiple words', { bins, scratchDir });

  assert.equal(res.unreached, undefined);
  assert.equal(res.text, fixtureContent);

  // Test integration in runA
  const root = tempDir(t, 'doflow-adapter-rtk-root-');
  bins.semble = stub(binDir, 'semble', `
console.log(JSON.stringify({ query: 'q', results: [{ file_path: 'src/sample.ts', start_line: 1, end_line: 5, content: 'export const sample = 1;' }] }));
`);

  const task = {
    query: 'sample',
    class: 'conceptual-discovery',
    expect: { result: ['RETRIEVED'] },
  };

  const ans = a.runA({
    task,
    exportRoot: root,
    capabilities: CAPS,
    bins,
    scratchDir,
  });

  assert.equal(ans.result, 'RETRIEVED');
  assert.equal(ans.compressedBytes, Buffer.byteLength(fixtureContent, 'utf8'));
  assert.deepEqual(ans.providers, [
    { id: 'semble.search', state: 'reached' },
    { id: 'rtk', state: 'reached' },
  ]);
});
