'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
const { EXIT } = require('../../src/runtime/cli-result.ts');
const { formatMarkdown, formatJson } = require('../../src/runtime/context/compose.ts');

test('context-pack-freshness: stale-only evidence exits 0 with its omissions listed, never with the empty notice (IC-008, FR-018)', () => {
  const compiler: any = new ContextPackCompiler();

  // Task has only STALE and UNKNOWN evidence, no other claims or decisions
  const pack = compiler.compileContextPack({
    taskId: 't-stale-only',
    taskClass: 'feature',
    objective: 'Test that stale-only evidence is counted and exits 0',
    evidence: [
      { id: 'ev-stale-1', kind: 'exact-search', content: 'Old cached search', freshness: { status: 'STALE' } },
      { id: 'ev-stale-2', kind: 'exact-search', content: 'Another old search', freshness: { status: 'STALE' } },
      { id: 'ev-unknown-1', kind: 'exact-search', content: 'Missing freshness record' },
    ],
  });

  // 1. Exit code and status: must be OK (0), never EMPTY (1)
  assert.equal(pack.empty, false, 'Stale or unknown evidence counts as recorded; pack must not be empty');
  assert.equal(pack.status, 'OK');
  assert.equal(pack.exitCode, EXIT.OK); // 0

  // 2. Markdown rendering: must list omissions, never the empty notice
  const md = formatMarkdown(pack);
  assert.equal(
    md.includes('_No evidence or claims are recorded for task'),
    false,
    'Empty notice must not print when stale evidence exists'
  );
  assert.match(md, /### Omitted/);
  assert.match(md, /- not-fresh STALE \(2\): ev-stale-1, ev-stale-2/);
  assert.match(md, /- not-fresh UNKNOWN \(1\): ev-unknown-1/);

  // 3. JSON rendering: omissions groups present
  const jsonStr = formatJson(pack);
  const data = JSON.parse(jsonStr);
  assert.equal(data.empty, false);
  assert.equal(data.status, 'OK');
  assert.equal(data.exitCode, 0);
  assert.equal(data.omissions.total, 3);

  const staleGroup = data.omissions.groups.find((g: any) => g.reason === 'not-fresh' && g.freshness === 'STALE');
  assert.ok(staleGroup);
  assert.deepEqual(staleGroup.ids, ['ev-stale-1', 'ev-stale-2']);

  const unknownGroup = data.omissions.groups.find((g: any) => g.reason === 'not-fresh' && g.freshness === 'UNKNOWN');
  assert.ok(unknownGroup);
  assert.deepEqual(unknownGroup.ids, ['ev-unknown-1']);
});

test('context-pack-freshness: FRESH superseded evidence is omitted while the recorded pack exits 0', () => {
  const compiler: any = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-superseded',
    taskClass: 'feature',
    objective: 'Test superseded evidence omission',
    evidence: [{
      id: 'ev-superseded',
      kind: 'exact-search',
      status: 'superseded',
      content: 'Replaced evidence',
      locator: { file: 'src/replaced.ts' },
      freshness: { status: 'FRESH' },
    }],
  });

  assert.equal(pack.empty, false);
  assert.equal(pack.status, 'OK');
  assert.equal(pack.exitCode, EXIT.OK);
  assert.deepEqual(pack.evidenceSummary, []);
  assert.deepEqual(pack.relevantFiles, []);
  assert.equal(pack.evidenceCount, 0);
  const supersededGroup = pack.omissions.groups.find((g: any) => g.reason === 'superseded');
  assert.ok(supersededGroup);
  assert.deepEqual(supersededGroup.ids, ['ev-superseded']);
  assert.match(formatMarkdown(pack), /- superseded \(1\): ev-superseded/);
  assert.deepEqual(
    pack.omissions.groups.map((g: any) => g.reason),
    ['superseded']
  );
});

test('context-pack-freshness: negative control — restoring the silent FRESH filter fails', () => {
  const compiler: any = new ContextPackCompiler();

  const pack = compiler.compileContextPack({
    taskId: 't-ctrl-fresh-filter',
    taskClass: 'feature',
    objective: 'Test that restoring the old FRESH filter fails',
    evidence: [
      { id: 'ev-stale-only', kind: 'exact-search', content: 'Stale content', freshness: { status: 'STALE' } },
    ],
  });

  // Production behavior: exits 0, empty is false
  assert.equal(pack.empty, false);
  assert.equal(pack.exitCode, EXIT.OK);

  // Negative control assertion: if someone restored the old line 141 FRESH filter where
  // non-FRESH evidence was dropped, pack.empty would be true and exitCode would be 1
  function assertFreshnessAccounting(compiledPack: any) {
    if (compiledPack.empty === true || compiledPack.exitCode === EXIT.EMPTY) {
      throw new Error('FRESH-filter-restored: non-FRESH evidence was dropped as absent');
    }
    const hasStaleOmission = compiledPack.omissions.groups.some(
      (g: any) => g.reason === 'not-fresh' && g.freshness === 'STALE' && g.ids.includes('ev-stale-only')
    );
    if (!hasStaleOmission) {
      throw new Error('FRESH-filter-restored: stale evidence omitted without not-fresh omission record');
    }
    return true;
  }

  // Production passes
  assert.equal(assertFreshnessAccounting(pack), true);

  // Reverted simulation (silent drop): fails
  const revertedPack: any = {
    empty: true,
    exitCode: EXIT.EMPTY,
    omissions: { total: 0, groups: [] },
  };

  assert.throws(() => {
    assertFreshnessAccounting(revertedPack);
  }, /FRESH-filter-restored: non-FRESH evidence was dropped as absent/);
});
