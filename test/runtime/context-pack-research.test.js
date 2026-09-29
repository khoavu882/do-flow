'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ContextPackCompiler, handleContextPackCommand } = require('../../src/runtime/context-pack');
const { updateTaskState } = require('../../src/runtime/task-state');
const { ResearchRequestStore } = require('../../src/runtime/research-request');

test('context pack includes bounded research state without treating open questions as facts', () => {
  const compiler = new ContextPackCompiler({ maxResearchRequests: 1 });
  const pack = compiler.compileContextPack({ taskId: 'x', researchRequests: [
    { id: 'a', stageId: 'design', question: 'Current API?', status: 'OPEN', blocking: true, claimId: null, evidenceIds: [], gap: null },
    { id: 'b', stageId: 'design', question: 'Next?', status: 'UNRESOLVED', blocking: false, gap: 'No source' },
  ] });
  assert.equal(pack.researchRequests.length, 1);
  assert.equal(pack.researchRequests[0].status, 'OPEN');
  assert.equal(pack.claims.supported.length, 0);
  assert.match(compiler.formatMarkdown(pack), /OPEN \(blocking\) design: Current API/);
});

test('CLI context pack reads a persisted research request on restart', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  updateTaskState({ fsImpl: fs, file: path.join(root, '.doflow/state/orchestration/f.json'),
    build: () => ({ taskId: 'f', taskClass: 'feature', state: 'RUNNING', cursor: 0,
      program: [{ type: 'stage', id: 'design' }] }) });
  new ResearchRequestStore({ projectRoot: root }).open({ taskId: 'f', stageId: 'design', question: 'Library version?', reason: 'detected-gap' });
  let output = '';
  const original = console.log;
  console.log = text => { output += text; };
  try { assert.equal(handleContextPackCommand({ taskId: 'f', stateRoot: root, json: true }), 0); }
  finally { console.log = original; }
  const pack = JSON.parse(output);
  assert.equal(pack.empty, false);
  assert.equal(pack.researchRequests[0].question, 'Library version?');
  assert.equal(pack.claims.supported.length, 0);
});

test('bounded context keeps a live blocking gap ahead of old answered requests', () => {
  const pack = new ContextPackCompiler({ maxResearchRequests: 1 }).compileContextPack({ taskId: 'f', researchRequests: [
    { id: 'old', status: 'ANSWERED', blocking: true, question: 'Previously answered' },
    { id: 'live', status: 'UNRESOLVED', blocking: true, question: 'Still needed', gap: 'No provider' },
  ] });
  assert.equal(pack.researchRequests[0].id, 'live');
});
