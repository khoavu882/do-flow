'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { collectPointers } = require('../../src/runtime/context/pointer.ts');
const { handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
const { createDeliveryEntry, recordDelivery } = require('../../src/runtime/context/delivery-store.ts');

function capture(options: any): any {
  const output: any = [];
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = (value) => output.push(value);
  try { return { code: handleContextPackCommand({ json: true, ...options }), output }; }
  finally { console.log = original; process.exitCode = originalExitCode; }
}

test('D.4 only points to allowed project-local detail and document ranges', (t) => {
  const root = tempDir(t, 'doflow-pointer-ranges-');
  const featureDir = path.join(root, 'agent-docs', 'doflow', '075-context-delivery');
  fs.mkdirSync(path.join(featureDir, 'intention'), { recursive: true });
  fs.mkdirSync(path.join(featureDir, 'design'), { recursive: true });
  fs.mkdirSync(path.join(root, '.doflow', 'guidance'), { recursive: true });
  fs.mkdirSync(path.join(root, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'intention', 'requirement.md'), [
    '## 3. User Stories', '**Detail:** story detail text', 'continues here', '**Priority:** P1',
    '## 6. Acceptance Criteria', '**Detail**', '- AC-1: this mandatory criterion must stay inline',
    '## 4. Requirements', '**Detail**', 'requirement detail text',
  ].join('\n'));
  fs.writeFileSync(path.join(featureDir, 'design', 'specs.md'), '## IC-016: Pointers\nPointer contract.\n## IC-017: Telemetry\nTelemetry contract.\n');
  fs.writeFileSync(path.join(root, '.doflow', 'guidance', 'usage.md'), '## Loading\nRead this section.\n');
  fs.writeFileSync(path.join(root, '.doflow', 'state', 'private.md'), '## Secret\nDo not point here.\n');
  const outside = tempDir(t, 'doflow-pointer-outside-');
  fs.writeFileSync(path.join(outside, 'outside.md'), '## External\nOutside project root.\n');
  fs.symlinkSync(path.join(outside, 'outside.md'), path.join(root, '.doflow', 'guidance', 'external.md'));
  const feature: any = { featureDir, repoRoot: root, paths: { requirement: path.join(featureDir, 'intention', 'requirement.md') } };
  const pointers = collectPointers({ projectRoot: root, feature });
  const requirementPointers = pointers.filter((pointer: any) => pointer.path.endsWith('requirement.md'));
  assert.ok(requirementPointers.every((pointer: any) => pointer.range.endLine < 5 || pointer.range.startLine > 6), 'mandatory acceptanceCriteria ac:1 must not become a pointer');
  assert.equal(pointers.length, 4);
  assert.ok(pointers.every((pointer: any) => pointer.id.startsWith(`ptr:`) && pointer.digest.startsWith('sha256:')));
  assert.ok(pointers.some((pointer: any) => pointer.heading === 'IC-016: Pointers'));
  assert.ok(pointers.every((pointer: any) => !pointer.path.includes('.doflow/state')));
  assert.ok(pointers.every((pointer: any) => !pointer.path.startsWith('.doflow/guidance/')));
  assert.ok(pointers.every((pointer: any) => !pointer.id.includes('AC-1')));
  assert.ok(pointers.every((pointer: any) => !pointer.path.endsWith('external.md')));
  assert.ok(pointers.every((pointer: any) => pointer.bytes > 0 && pointer.inlineBytes > 0 && pointer.tokensEst.value > 0));
});

test('template-shaped Detail blocks without colons produce requirement pointers', (t) => {
  const root = tempDir(t, 'doflow-pointer-template-detail-');
  const featureDir = path.join(root, 'agent-docs', 'doflow', 'fixture-feature');
  const requirement = path.join(featureDir, 'intention', 'requirement.md');
  fs.mkdirSync(path.dirname(requirement), { recursive: true });
  fs.writeFileSync(requirement, [
    '## 3. Functional Requirements', '| ID | Requirement |', '|---|---|', '| FR-001 | Example |',
    '**Detail**', '- **FR-001:** Required behavior.',
    '## 4. Non-Functional Requirements', '| ID | Constraint |', '|---|---|', '| NFR-001 | Example |',
    '**Detail**', '- **NFR-001:** Required quality.',
  ].join('\n'));
  const pointers = collectPointers({ projectRoot: root, feature: { featureDir, repoRoot: root } });
  assert.equal(pointers.length, 2);
  assert.ok(pointers.every((pointer: any) => pointer.path.endsWith('requirement.md')));
});

test('real-feature requirement produces at least one requirement pointer', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const requirement = path.join(repoRoot, 'test/fixtures/context-pack/real-feature-requirement.md');
  const pointers = collectPointers({
    projectRoot: repoRoot,
    feature: { featureDir: path.dirname(path.dirname(requirement)), repoRoot, paths: { requirement } },
  });
  assert.ok(pointers.some((pointer: any) => pointer.path.endsWith('real-feature-requirement.md')));
});

test('D.4 expands a stored pointer, reports target changes, and appends pointer-followed telemetry', (t) => {
  const root = tempDir(t, 'doflow-pointer-expand-');
  const target = path.join(root, 'design.md');
  fs.writeFileSync(target, '## Plan\nUpdated contents.\n');
  const pointer: any = {
    id: 'ptr:design.md:1-2', path: 'design.md', heading: 'Plan', range: { startLine: 1, endLine: 2 },
    digest: 'sha256:' + '0'.repeat(64), bytes: 24, tokensEst: { value: 6, basis: 'estimated:bytes/4' },
    inlineBytes: 24, load: 'read design.md lines 1-2',
  };
  const priorPack: any = {
    mode: 'full', size: { totalBytes: 10 }, budget: { maxBytes: 225000, source: 'task-class' },
    delivery: { packDigest: 'sha256:' + '1'.repeat(64) }, pointers: [pointer],
    deliveryItems: [], deliveryAllItems: [], deliveryOmissions: [],
  };
  const entry = createDeliveryEntry({ pack: priorPack, form: 'json', harness: 'claude', sources: {} });
  recordDelivery({ projectRoot: root, taskId: 'D.4', entry });

  const missingReason = capture({ taskId: 'D.4', stateRoot: root, since: entry.packDigest, expand: pointer.id });
  assert.equal(missingReason.code, 2);
  assert.match(missingReason.output.at(-1), /--expand requires both --since and --reason/);
  const unknownPointer = capture({ taskId: 'D.4', stateRoot: root, since: entry.packDigest, expand: 'ptr:missing.md:1-1', reason: 'Follow it' });
  assert.equal(unknownPointer.code, 2);
  assert.match(unknownPointer.output.at(-1), /ptr:missing\.md:1-1/);

  const result = capture({ taskId: 'D.4', stateRoot: root, since: entry.packDigest, expand: pointer.id, reason: 'Need the plan details' });
  assert.equal(result.code, 0);
  const pack = JSON.parse(result.output.at(-1));
  assert.equal(pack.mode, 'expand');
  assert.equal(pack.expansion.path, 'design.md');
  assert.match(pack.expansion.content, /Updated contents/);
  assert.equal(pack.expansion.targetChanged, true);
  assert.equal(pack.expansionRecorded, true);
  const disk = JSON.parse(fs.readFileSync(path.join(root, '.doflow', 'state', 'delivery', 'D.4.json'), 'utf8'));
  assert.equal(disk.deliveries[0].expansions.at(-1).kind, 'pointer-followed');
  assert.equal(disk.deliveries[0].expansions.at(-1).targetChanged, true);
});

test('D.4 rejects unknown digests and pointers and requires --reason', (t) => {
  const root = tempDir(t, 'doflow-pointer-errors-');
  const unknownDigest = capture({ taskId: 'D.4', stateRoot: root, expand: 'ptr:x:1-1', since: 'sha256:' + '0'.repeat(64), reason: 'follow' });
  assert.equal(unknownDigest.code, 2);
  assert.match(unknownDigest.output.at(-1), /Unknown digest 'sha256:/);
  const missingSince = capture({ taskId: 'D.4', stateRoot: root, expand: 'ptr:x:1-1', reason: 'follow' });
  assert.equal(missingSince.code, 2);
  assert.match(missingSince.output.at(-1), /--expand requires both --since and --reason/);
});

test('D.4 records cap-raised with the caller reason', (t) => {
  const root = tempDir(t, 'doflow-pointer-cap-');
  const result = capture({ taskId: 'D.4', stateRoot: root, objective: 'Work', maxBytes: 225001, reason: 'Caller raised the cap' });
  assert.equal(result.code, 1);
  const disk = JSON.parse(fs.readFileSync(path.join(root, '.doflow', 'state', 'delivery', 'D.4.json'), 'utf8'));
  assert.equal(disk.deliveries[0].expansions[0].kind, 'cap-raised');
  assert.equal(disk.deliveries[0].expansions[0].reason, 'Caller raised the cap');
});
