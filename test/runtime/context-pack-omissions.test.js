'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
const { formatMarkdown, formatJson } = require('../../src/runtime/context/compose.ts');

function maskDynamicFields(jsonObj) {
  const clone = JSON.parse(JSON.stringify(jsonObj));
  delete clone.compiledAt;
  delete clone.delivery;
  return clone;
}

function maskMarkdown(md) {
  // Strip compiledAt/delivery if any in md (in 075 delivery digest/footer varies only if items change)
  return md;
}

test('context-pack-omissions: determinism with compiledAt and delivery masked, every omitted id in both forms (IC-008)', () => {
  const compiler = new ContextPackCompiler({
    maxFiles: 2,
    maxClaims: 2,
    maxEvidenceItems: 2,
    maxResearchRequests: 2,
  });

  const runOptions = {
    taskId: 't-omissions-det',
    taskClass: 'feature',
    objective: 'Test omission determinism across multiple runs',
    relevantFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], // 2 will be omitted by item-cap
    evidence: [
      { id: 'ev-fresh-1', kind: 'exact-search', content: 'Fresh evidence 1', freshness: { status: 'FRESH' } },
      { id: 'ev-fresh-2', kind: 'exact-search', content: 'Fresh evidence 2', freshness: { status: 'FRESH' } },
      { id: 'ev-fresh-3', kind: 'exact-search', content: 'Fresh evidence 3', freshness: { status: 'FRESH' } }, // 1 omitted by item-cap
      { id: 'ev-stale-1', kind: 'exact-search', content: 'Stale evidence 1', freshness: { status: 'STALE' } }, // not-fresh
      { id: 'ev-unknown-1', kind: 'exact-search', content: 'Unknown evidence 1' }, // not-fresh
    ],
    claims: {
      conflicts: [],
      supported: [
        { id: 'claim-s1', statement: 'Statement 1', status: 'supported' },
        { id: 'claim-s2', statement: 'Statement 2', status: 'supported' },
        { id: 'claim-s3', statement: 'Statement 3', status: 'supported' }, // 1 omitted by item-cap
      ],
      hypotheses: [],
    },
  };

  const pack1 = compiler.compileContextPack(runOptions);
  const pack2 = compiler.compileContextPack(runOptions);

  // Assert determinism in JSON
  const masked1 = maskDynamicFields(pack1);
  const masked2 = maskDynamicFields(pack2);
  assert.deepEqual(masked1, masked2, 'Two compilations must produce identical structure');

  // Verify omissions record in JSON
  assert.equal(pack1.omissions.total > 0, true);
  const allOmittedIds = new Set();
  for (const group of pack1.omissions.groups) {
    for (const id of group.ids) {
      allOmittedIds.add(id);
    }
  }

  // Check expected omissions: ev-stale-1, ev-unknown-1, ev-fresh-3, claim-s3, file:src/c.ts, file:src/d.ts
  assert.ok(allOmittedIds.has('ev-stale-1'), 'ev-stale-1 must be omitted');
  assert.ok(allOmittedIds.has('ev-unknown-1'), 'ev-unknown-1 must be omitted');
  assert.ok(allOmittedIds.has('ev-fresh-3'), 'ev-fresh-3 must be omitted');
  assert.ok(allOmittedIds.has('claim-s3'), 'claim-s3 must be omitted');
  assert.ok(allOmittedIds.has('file:src/c.ts'), 'file:src/c.ts must be omitted');
  assert.ok(allOmittedIds.has('file:src/d.ts'), 'file:src/d.ts must be omitted');

  // Verify group ordering: not-fresh STALE, not-fresh UNKNOWN, item-cap
  const groupReasons = pack1.omissions.groups.map(g => `${g.reason}:${g.freshness || ''}`);
  assert.equal(groupReasons[0], 'not-fresh:STALE');
  assert.equal(groupReasons[1], 'not-fresh:UNKNOWN');
  assert.equal(groupReasons[2], 'item-cap:');

  // Verify Markdown form contains all omitted ids under ### Omitted
  const md = formatMarkdown(pack1);
  assert.match(md, /### Omitted/);
  for (const id of allOmittedIds) {
    assert.ok(md.includes(id), `Markdown must contain omitted id ${id}`);
  }
});

test('context-pack-omissions: negative control — dropping one omission fails naming its id', () => {
  const compiler = new ContextPackCompiler({
    maxFiles: 1,
  });

  const pack = compiler.compileContextPack({
    taskId: 't-drop-omission',
    taskClass: 'feature',
    objective: 'Test dropping omission detection',
    relevantFiles: ['src/file1.ts', 'src/file2.ts'],
  });

  const allOmittedIds = new Set();
  for (const group of pack.omissions.groups) {
    for (const id of group.ids) {
      allOmittedIds.add(id);
    }
  }
  assert.ok(allOmittedIds.has('file:src/file2.ts'));

  function verifyAllExpectedOmissions(emittedOmissions, expectedIds) {
    const present = new Set();
    for (const group of emittedOmissions.groups || []) {
      for (const id of group.ids || []) {
        present.add(id);
      }
    }
    for (const expected of expectedIds) {
      if (!present.has(expected)) {
        throw new Error(`missing-omission: dropped id '${expected}'`);
      }
    }
    return true;
  }

  // Passing full omissions succeeds
  assert.equal(verifyAllExpectedOmissions(pack.omissions, ['file:src/file2.ts']), true);

  // Dropping one omission fails and names its id
  const corruptedOmissions = {
    total: 0,
    groups: [],
  };

  assert.throws(() => {
    verifyAllExpectedOmissions(corruptedOmissions, ['file:src/file2.ts']);
  }, /missing-omission: dropped id 'file:src\/file2\.ts'/);
});
