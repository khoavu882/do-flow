'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { evaluateToolCall, evaluatePayload, resolveProjectRoot } = require('../../core/harnesses/shared/hooks/stream-hook-runner');

test('stream-hook-runner: resolveProjectRoot resolves valid workspace paths', () => {
  const root = resolveProjectRoot([__dirname]);
  assert.ok(typeof root === 'string');
  assert.ok(root.length > 0);
});

test('stream-hook-runner: evaluateToolCall allows benign tool calls', () => {
  const result = evaluateToolCall({
    name: 'view_file',
    args: { AbsolutePath: '/some/path/file.txt' },
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluateToolCall blocks destructive commands', () => {
  const result = evaluateToolCall({
    name: 'run_command',
    args: { CommandLine: 'rm -rf /' },
  }, process.cwd());

  assert.equal(result.decision, 'deny');
  assert.ok(result.reason.includes('SAFETY INVARIANT BLOCKED'));
});

test('stream-hook-runner: evaluateToolCall allows safe run_command', () => {
  const result = evaluateToolCall({
    name: 'run_command',
    args: { CommandLine: 'npm test' },
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluatePayload handles PreInvocation hook payloads', () => {
  const result = evaluatePayload({
    invocationNum: 1,
    initialNumSteps: 5,
  }, process.cwd());

  assert.deepEqual(result, { injectSteps: [] });
});

test('stream-hook-runner: evaluatePayload handles Stop hook payloads', () => {
  const result = evaluatePayload({
    executionNum: 1,
    terminationReason: 'model_stop',
    fullyIdle: true,
  }, process.cwd());

  assert.equal(result.decision, 'allow');
});

test('stream-hook-runner: evaluatePayload handles PostToolUse hook payloads', () => {
  const result = evaluatePayload({
    stepIdx: 3,
    error: '',
  }, process.cwd());

  assert.deepEqual(result, {});
});
