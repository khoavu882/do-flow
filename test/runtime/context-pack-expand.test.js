'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { handleContextPackCommand } = require('../../src/runtime/context-pack.ts');
const { createDeliveryEntry, recordDelivery } = require('../../src/runtime/context/delivery-store.ts');

function capture(options) {
  let output = '';
  const original = console.log;
  const originalExitCode = process.exitCode;
  console.log = (value) => { output += value; };
  try { return { code: handleContextPackCommand({ json: true, ...options }), output: () => output }; }
  finally { console.log = original; process.exitCode = originalExitCode; }
}

function storedPointer(root, taskId, content) {
  fs.writeFileSync(path.join(root, 'design.md'), content, 'utf8');
  const digest = `sha256:${'a'.repeat(64)}`;
  const pointer = { id: 'ptr:design.md:1-2', path: 'design.md', heading: 'Plan', range: { startLine: 1, endLine: 2 },
    digest: `sha256:${'0'.repeat(64)}`, bytes: 20, tokensEst: { value: 5, basis: 'estimated:bytes/4' }, inlineBytes: 20,
    load: 'read design.md lines 1-2' };
  const priorPack = { mode: 'full', size: { totalBytes: 20 }, budget: { maxBytes: 225000, source: 'task-class' },
    delivery: { packDigest: digest }, pointers: [pointer], deliveryItems: [], deliveryOmissions: [] };
  const entry = createDeliveryEntry({ pack: priorPack, form: 'json', pointers: [pointer] });
  recordDelivery({ projectRoot: root, taskId, entry });
  return { digest, pointer, entry };
}

test('context-pack expand renders before recording, and appends only to the matching delivery key', (t) => {
  const root = tempDir(t, 'doflow-expand-match-');
  const taskId = 'T-expand';
  const { digest, pointer, entry } = storedPointer(root, taskId, '## Plan\nUpdated contents.\n');
  const secondEntry = { ...entry, key: `${digest}.markdown.unstated`, form: 'markdown', expansions: [] };
  recordDelivery({ projectRoot: root, taskId, entry: secondEntry });

  const result = capture({ taskId, stateRoot: root, since: digest, expand: pointer.id, reason: 'Review plan' });
  assert.equal(result.code, 0);
  const pack = JSON.parse(result.output());
  assert.equal(pack.expansionRecorded, true);
  assert.equal(pack.accounting.tokens.estimated.value, Math.ceil(Buffer.byteLength(result.output()) / 4));
  const disk = JSON.parse(fs.readFileSync(path.join(root, '.doflow/state/delivery', `${taskId}.json`), 'utf8'));
  assert.equal(disk.deliveries[0].expansions.at(-1).kind, 'pointer-followed');
  assert.equal(disk.deliveries[1].expansions.length, 0);
});

test('context-pack expand over the cap exits 2 and records no pointer-followed entry', (t) => {
  const root = tempDir(t, 'doflow-expand-cap-');
  const taskId = 'T-expand-cap';
  const content = `## Plan\n${'x'.repeat(5000)}\n`;
  const { digest, pointer } = storedPointer(root, taskId, content);
  const result = capture({ taskId, stateRoot: root, since: digest, expand: pointer.id, reason: 'Review large plan', maxBytes: 3000 });
  assert.equal(result.code, 2);
  const error = JSON.parse(result.output());
  assert.equal(error.exitCode, 2);
  assert.match(error.summary, /slice is .* B, over the 3000 B cap/);
  const disk = JSON.parse(fs.readFileSync(path.join(root, '.doflow/state/delivery', `${taskId}.json`), 'utf8'));
  assert.deepEqual(disk.deliveries[0].expansions, []);
});
