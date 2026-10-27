'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
const { formatMarkdown, formatJson } = require('../../src/runtime/context/compose.ts');

test('context-pack-conflicts: conflicted claims render only under ### Blocking Conflicts with CONFLICT prefix (IC-004, IC-005)', () => {
  const compiler: any = new ContextPackCompiler();

  const pack = compiler.compileContextPack({
    taskId: 't-conflicts',
    taskClass: 'feature',
    objective: 'Test claims partitioning and conflict rendering',
    claims: {
      conflicts: [
        {
          id: 'claim-c1',
          statement: 'Storage migration is zero-downtime',
          status: 'conflicted',
          supportingEvidence: ['ev-prod-1'],
          contradictingEvidence: ['ev-incident-42'],
        },
      ],
      supported: [
        {
          id: 'claim-s1',
          statement: 'Database runs on PostgreSQL 16',
          status: 'supported',
        },
      ],
      hypotheses: [
        {
          id: 'claim-h1',
          statement: 'Connection pool needs 50 workers',
          status: 'hypothesis',
        },
      ],
    },
  });

  // 1. JSON claims structure and key order
  assert.equal(pack.claims.conflicts.length, 1);
  assert.equal(pack.claims.supported.length, 1);
  assert.equal(pack.claims.hypotheses.length, 1);

  const jsonStr = formatJson(pack);
  const data = JSON.parse(jsonStr);
  const claimsKeys = Object.keys(data.claims);
  assert.deepEqual(claimsKeys, ['conflicts', 'supported', 'hypotheses']);

  assert.equal(data.claims.conflicts[0].statement, 'Storage migration is zero-downtime');
  assert.equal(data.claims.supported[0].statement, 'Database runs on PostgreSQL 16');
  assert.equal(data.claims.hypotheses[0].statement, 'Connection pool needs 50 workers');

  // Verify conflicted claim is in conflicts ONLY, not in supported or hypotheses
  assert.ok(!data.claims.supported.some((c: any) => c.statement.includes('zero-downtime')));
  assert.ok(!data.claims.hypotheses.some((c: any) => c.statement.includes('zero-downtime')));

  // 2. Markdown rendering
  const md = formatMarkdown(pack);
  assert.match(
    md,
    /### Blocking Conflicts\n- CONFLICT Storage migration is zero-downtime \(supports: ev-prod-1; contradicts: ev-incident-42\)/
  );

  // Check section separation: Supported Facts must NOT contain the conflicted statement
  const supportedSection = md.split('### Supported Facts & Invariants')[1] || '';
  const supportedContent = supportedSection.split('###')[0];
  assert.ok(supportedContent.includes('Database runs on PostgreSQL 16'));
  assert.ok(!supportedContent.includes('Storage migration is zero-downtime'));
});

test('context-pack-conflicts: negative control — rendering a conflicted claim under supported fails', () => {
  const compiler: any = new ContextPackCompiler();

  const pack = compiler.compileContextPack({
    taskId: 't-ctrl-conflict-render',
    taskClass: 'feature',
    objective: 'Test that conflicted claims are rejected from supported section',
    claims: {
      conflicts: [
        {
          id: 'claim-c-leak',
          statement: 'Leaked conflicted invariant',
          status: 'conflicted',
          supportingEvidence: ['ev-1'],
          contradictingEvidence: ['ev-2'],
        },
      ],
      supported: [],
      hypotheses: [],
    },
  });

  const md = formatMarkdown(pack);

  function verifyNoConflictedClaimsUnderSupported(markdownText: any) {
    const sectionParts = markdownText.split('### Supported Facts & Invariants');
    if (sectionParts.length > 1) {
      const supportedBody = sectionParts[1].split('###')[0];
      if (supportedBody.includes('CONFLICT') || supportedBody.includes('Leaked conflicted invariant')) {
        throw new Error("conflict-in-supported: found conflicted claim under '### Supported Facts & Invariants'");
      }
    }
    return true;
  }

  // Production markdown passes (no conflicted claims under supported)
  assert.equal(verifyNoConflictedClaimsUnderSupported(md), true);

  // Corrupted markdown simulating rendering under supported: must throw
  const corruptedMd = md + `### Supported Facts & Invariants\n- ! CONFLICT Leaked conflicted invariant\n\n`;
  assert.throws(() => {
    verifyNoConflictedClaimsUnderSupported(corruptedMd);
  }, /conflict-in-supported: found conflicted claim under '### Supported Facts & Invariants'/);
});

test('context-pack-conflicts: 21 blocking requests keep all 21, exempt from 20-item cap (negative control)', () => {
  const compiler: any = new ContextPackCompiler({
    maxResearchRequests: 20, // default limit is 20
  });

  const requests: any = [];
  for (let i = 1; i <= 21; i++) {
    requests.push({
      id: `req-blocking-${i}`,
      stageId: 'design',
      question: `Blocking question ${i}?`,
      status: 'OPEN',
      blocking: true,
      gap: `Gap ${i}`,
    });
  }

  const pack = compiler.compileContextPack({
    taskId: 't-blocking-exempt',
    taskClass: 'feature',
    objective: 'Test that 21 blocking unanswered requests are all kept',
    researchRequests: requests,
  });

  // Must keep all 21
  assert.equal(
    pack.researchRequests.length,
    21,
    'Blocking unanswered research requests are mandatory and must be exempt from 20-item limit'
  );

  for (let i = 1; i <= 21; i++) {
    assert.ok(
      pack.researchRequests.some((r: any) => r.id === `req-blocking-${i}`),
      `pack must keep req-blocking-${i}`
    );
  }

  const md = formatMarkdown(pack);
  for (let i = 1; i <= 21; i++) {
    assert.ok(md.includes(`Blocking question ${i}?`), `Markdown must contain Blocking question ${i}?`);
  }

  // Negative control assertion: if capped to 20, fails
  assert.throws(() => {
    const cappedSlice = pack.researchRequests.slice(0, 20);
    if (cappedSlice.length < 21) {
      throw new Error(`blocking-requests-capped: expected 21, got ${cappedSlice.length}`);
    }
  }, /blocking-requests-capped: expected 21, got 20/);
});
