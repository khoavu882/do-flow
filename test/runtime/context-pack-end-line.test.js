'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ContextPackCompiler } = require('../../src/runtime/context-pack.ts');
const {
  formatMarkdown,
  formatJson,
  parsePackEndLine,
  verifyPackEndLine,
} = require('../../src/runtime/context/compose.ts');

test('context-pack-end-line: counts and bytes match output in markdown and JSON (IC-009)', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-counts',
    taskClass: 'feature',
    objective: 'Complete end-of-pack testing objective',
    acceptanceCriteria: [
      { id: 'ac:1', text: 'Criteria 1', requirements: ['FR-001'], stories: ['US1'] },
      { id: 'ac:2', text: 'Criteria 2', requirements: ['FR-002'], stories: ['US2'] },
    ],
    constraints: [
      { id: 'nfr:1', text: 'Constraint 1', kind: 'performance' },
    ],
    verificationRequirements: [
      { id: 'vr:1', text: 'Verification requirement 1' },
    ],
    scopeExcluded: [
      { id: 'scope:1', text: 'Out of scope 1' },
    ],
    blockingGaps: [
      { id: 'gap:1', text: 'Blocking gap 1', source: 'requirement' },
    ],
    claims: {
      conflicts: [
        { id: 'claim-c1', statement: 'Conflicted statement', status: 'conflicted', supportingEvidence: ['ev-1'], contradictingEvidence: ['ev-2'] },
      ],
      supported: [
        { id: 'claim-s1', statement: 'Supported statement', status: 'supported' },
      ],
      hypotheses: [
        { id: 'claim-h1', statement: 'Hypothesis statement', status: 'hypothesis' },
      ],
    },
  });

  // 1. Markdown form
  const md = formatMarkdown(pack);
  const verifyRes = verifyPackEndLine(md);
  assert.equal(verifyRes.ok, true, `Expected valid end line, got: ${verifyRes.reason}`);

  const parsed = verifyRes.parsed;
  assert.equal(parsed.bytes, Buffer.byteLength(md, 'utf8'));
  assert.equal(parsed.isPadded, true);
  assert.equal(parsed.rawBytes.length, 9);
  assert.equal(parsed.mode, 'full');
  assert.equal(parsed.objective, 1);
  assert.equal(parsed.acceptanceCriteria, pack.acceptanceCriteria.length);
  assert.equal(parsed.constraints, pack.constraints.length);
  assert.equal(parsed.verificationRequirements, pack.verificationRequirements.length);
  assert.equal(parsed.scopeExcluded, pack.scopeExcluded.length);
  assert.equal(parsed.conflicts, pack.claims.conflicts.length);
  assert.equal(parsed.blockingGaps, pack.blockingGaps.length);
  assert.equal(parsed.omitted, pack.omissions.total);
  assert.equal(parsed.digest, pack.packEnd.digest);

  // Assert [end of pack] is the very last line
  const lines = md.trimEnd().split('\n');
  assert.match(lines[lines.length - 1], /^\[end of pack\] /);

  // 2. JSON form
  const jsonStr = formatJson(pack);
  const data = JSON.parse(jsonStr);

  const jsonKeys = Object.keys(data);
  assert.equal(jsonKeys[jsonKeys.length - 1], 'packEnd', 'packEnd must be the last key in JSON');
  assert.equal(data.packEnd.bytes, Buffer.byteLength(jsonStr, 'utf8'));
  assert.equal(data.size.totalBytes, data.packEnd.bytes);
  assert.equal(data.packEnd.mode, 'full');
  assert.equal(data.packEnd.objective, 1);
  assert.equal(data.packEnd.acceptanceCriteria, data.acceptanceCriteria.length);
  assert.equal(data.packEnd.constraints, data.constraints.length);
  assert.equal(data.packEnd.verificationRequirements, data.verificationRequirements.length);
  assert.equal(data.packEnd.scopeExcluded, data.scopeExcluded.length);
  assert.equal(data.packEnd.conflicts, data.claims.conflicts.length);
  assert.equal(data.packEnd.blockingGaps, data.blockingGaps.length);
  assert.equal(data.packEnd.omitted, data.omissions.total);
  assert.equal(data.packEnd.digest, pack.packEnd.digest);
});

test('context-pack-end-line: cuts at 2 KB and head-plus-tail are detected as missing/mismatched line', () => {
  const compiler = new ContextPackCompiler();
  // Build a large pack (> 10 KB) using multiple ACs, constraints and evidence
  const acceptanceCriteria = [];
  for (let i = 1; i <= 60; i++) {
    acceptanceCriteria.push({
      id: `ac:${i}`,
      text: `Detailed acceptance criterion item ${i} with long descriptive text to test large context payload formatting`,
      requirements: [`FR-${String(i).padStart(3, '0')}`],
      stories: [`US${i}`],
    });
  }
  const constraints = [];
  for (let i = 1; i <= 40; i++) {
    constraints.push({
      id: `nfr:${i}`,
      text: `Non-functional constraint ${i} specifying system boundary and performance requirements across modules`,
      kind: 'performance',
    });
  }
  const evidence = [];
  for (let i = 1; i <= 25; i++) {
    evidence.push({
      id: `ev-${i}`,
      kind: 'exact-search',
      content: 'Large detailed code analysis line with content to simulate realistic evidence item. '.repeat(5),
      locator: { file: `src/module_${i}.ts` },
      freshness: { status: 'FRESH' },
    });
  }

  const pack = compiler.compileContextPack({
    taskId: 't-large',
    taskClass: 'feature',
    objective: 'Large pack testing truncation detection',
    acceptanceCriteria,
    constraints,
    evidence,
  });

  const md = formatMarkdown(pack);
  const fullBytes = Buffer.byteLength(md, 'utf8');
  assert.ok(fullBytes > 8192, `Expected large pack > 8 KB, got ${fullBytes} B`);

  // Verify full pack passes
  const fullRes = verifyPackEndLine(md);
  assert.equal(fullRes.ok, true);

  // 1. Cut at 2 KB (head only): missing [end of pack] line
  const cut2k = md.slice(0, 2048);
  const res2k = verifyPackEndLine(cut2k);
  assert.equal(res2k.ok, false);
  assert.equal(res2k.reason, 'missing-end-of-pack-line');

  // 2. Head-plus-tail cut keeping first 4 KB and last 4 KB: byte count mismatch
  const head4k = md.slice(0, 4096);
  const tail4k = md.slice(-4096);
  const cutHeadTail = head4k + '\n...[intermediate content truncated by transport proxy]...\n' + tail4k;
  const resHeadTail = verifyPackEndLine(cutHeadTail);
  assert.equal(resHeadTail.ok, false);
  assert.match(resHeadTail.reason, /byte-count-mismatch/);
});

test('context-pack-end-line: injected declared limit below pack size makes TOOL LIMIT notice appear', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-notice',
    taskClass: 'feature',
    objective: 'Test objective for tool limit notice',
  });

  // Inject a declared toolResultLimitBytes below pack totalBytes (e.g. 100 B)
  pack.budget.toolResultLimitBytes = 100;
  pack.budget.harness = { id: 'test-harness', source: 'flag' };

  // Markdown check
  const md = formatMarkdown(pack);
  assert.match(
    md,
    /> TOOL LIMIT: this pack is \d+ B and test-harness delivers tool output up to 100 B, so it may arrive cut\. If the last line is not "\[end of pack\] \.\.\.", it was cut\./
  );

  const lines = md.split('\n');
  assert.match(lines[0], /^## ContextPack:/);
  assert.match(lines[1], /^> TOOL LIMIT:/);

  // JSON check
  const jsonStr = formatJson(pack);
  const data = JSON.parse(jsonStr);
  assert.ok(data.toolLimitNotice);
  assert.equal(
    data.toolLimitNotice.message,
    `TOOL LIMIT: this pack is ${data.size.totalBytes} B and test-harness delivers tool output up to 100 B, so it may arrive cut. If the last line is not "[end of pack] ...", it was cut.`
  );

  // When limit is null (default 075 profile values), notice never appears
  pack.budget.toolResultLimitBytes = null;
  const mdNoNotice = formatMarkdown(pack);
  assert.equal(mdNoNotice.includes('> TOOL LIMIT:'), false);

  const jsonNoNotice = JSON.parse(formatJson(pack));
  assert.equal(jsonNoNotice.toolLimitNotice, null);
});

test('context-pack-end-line: negative control — omitting end-of-pack line fails verification', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-ctrl-omit',
    taskClass: 'feature',
    objective: 'Test objective for omitting end-of-pack line',
  });

  const md = formatMarkdown(pack);
  const strippedMd = md.replace(/\[end of pack\][^\n]*\n?$/, '');

  const res = verifyPackEndLine(strippedMd);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'missing-end-of-pack-line');

  assert.throws(() => {
    if (!verifyPackEndLine(strippedMd).ok) {
      throw new Error('missing-end-of-pack-line');
    }
  }, /missing-end-of-pack-line/);
});

test('context-pack-end-line: negative control — unpadded bytes field fails verification on reverted code (CX.6)', () => {
  const compiler = new ContextPackCompiler();
  const pack = compiler.compileContextPack({
    taskId: 't-ctrl-pad',
    taskClass: 'feature',
    objective: 'Test objective for unpadded bytes negative control',
  });

  const md = formatMarkdown(pack);

  // Directly check production output: must have 9-digit padded bytes and pass verifyPackEndLine
  const parsed = parsePackEndLine(md);
  assert.ok(parsed, 'must parse end line');
  assert.equal(parsed.rawBytes.length, 9, 'production formatMarkdown must emit 9-digit zero-padded bytes');
  assert.equal(parsed.isPadded, true);
  assert.equal(verifyPackEndLine(md).ok, true);

  // Negative control: unpadded bytes field fails verifyPackEndLine with unpadded-bytes-field.
  // Using regex /bytes=\d+/ ensures matching even if md itself had unpadded bytes on reverted code.
  const unpaddedMd = md.replace(/bytes=\d+/, 'bytes=1234');
  const res = verifyPackEndLine(unpaddedMd);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'unpadded-bytes-field');

  assert.throws(() => {
    const v = verifyPackEndLine(unpaddedMd);
    if (!v.ok) {
      throw new Error(`rejected: ${v.reason}`);
    }
  }, /rejected: unpadded-bytes-field/);
});
