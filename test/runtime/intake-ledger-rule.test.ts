'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { EvidenceLedger } = require('../../src/runtime/evidence-ledger.ts');

const USER_SOURCE = { provider: 'doflow.intake', capability: 'user-provided' };
const FILE = 'agent-docs/doflow/136-x/additional-context/hld/design.md';

test('addEvidence refuses an additional-context locator without the user-provided source', () => {
  const ledger = new EvidenceLedger();
  assert.throws(
    () => ledger.addEvidence({ kind: 'documentation', locator: { file: FILE, line: 3 } }),
    (err: Error) => err.message.includes(FILE) && err.message.includes('user-provided'),
  );
  assert.throws(
    () => ledger.addEvidence({ kind: 'documentation', source: { provider: 'native.rg', capability: 'code.exact-search' }, locator: { file: FILE } }),
    /user-provided/,
  );
  assert.equal(ledger.queryEvidence().length, 0);
});

test('addEvidence accepts a user file cited with the user-provided source', () => {
  const ledger = new EvidenceLedger();
  const doc = ledger.addEvidence({ kind: 'documentation', provenance: 'extracted', source: USER_SOURCE, locator: { file: FILE, line: 3 } });
  const prompt = ledger.addEvidence({
    kind: 'user-statement', provenance: 'asserted', source: USER_SOURCE,
    locator: { file: 'agent-docs/doflow/136-x/additional-context/prompt/prompt-2026-11-02-01.md' }, content: 'the prompt',
  });
  assert.equal(ledger.getEvidence(doc).source.capability, 'user-provided');
  assert.equal(ledger.getEvidence(prompt).kind, 'user-statement');
});

test('the rule fires only on an additional-context path segment', () => {
  const ledger = new EvidenceLedger();
  for (const file of ['src/additional-context-helper.ts', 'docs/my-additional-context.md', 'additional-contexts/a.md', 'a.js']) {
    assert.ok(ledger.addEvidence({ kind: 'exact-search', locator: { file } }), file);
  }
  assert.ok(ledger.addEvidence({ kind: 'exact-search' }), 'no locator at all');
});

test('a locator into a linked worktree or the main checkout is held to the same rule', (t: any) => {
  const ledger = new EvidenceLedger();
  const main = tempDir(t, 'doflow-intake-main-');
  const linked = tempDir(t, 'doflow-intake-linked-');
  const inMain = path.join(main, 'agent-docs', 'doflow', '136-x', 'additional-context', 'prd', 'prd.md');
  const viaLinked = path.relative(linked, inMain);
  for (const file of [inMain, viaLinked]) {
    assert.throws(() => ledger.addEvidence({ kind: 'documentation', locator: { file } }), /user-provided/, file);
    assert.ok(ledger.addEvidence({ kind: 'documentation', source: USER_SOURCE, locator: { file } }), file);
  }
});
