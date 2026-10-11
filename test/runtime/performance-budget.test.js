'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { ContextPackCompiler } = require('../../src/runtime/context-pack');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'doflow.js');
const HOOKS_DIR = path.join(REPO_ROOT, 'core', 'harnesses', 'shared', 'hooks', 'policies');

/**
 * Runs a command and measures wall time in milliseconds using hrtime.
 * @param {string} cmd
 * @param {string[]} args
 * @param {Object} [options]
 * @returns {{ ms: number, status: number, stdout: string, stderr: string }}
 */
function measureExecution(cmd, args, options = {}) {
  const start = process.hrtime.bigint();
  const res = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, DOFLOW_QUIET: '1' },
    ...options,
  });
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;
  return { ms, status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

test('performance-budget: in-process compileBoundedContextPack executes in under 5 ms', () => {
  const compiler = new ContextPackCompiler();
  const start = process.hrtime.bigint();
  const res = compiler.compileBoundedContextPack({
    taskId: 'perf-task',
    taskClass: 'feature',
    maxBytes: 10000,
    objective: 'Benchmark context pack compiler',
    mandatory: {
      acceptanceCriteria: ['AC-01', 'AC-02'],
      constraints: ['C-01'],
      verificationPlan: 'Run performance suite',
    },
    optional: {
      hypotheses: ['H-01'],
      narrative: ['N-01'],
    },
  });
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;

  assert.equal(res.overflow, false);
  assert.ok(ms < 5, `expected in-process compilation < 5 ms, got ${ms.toFixed(2)} ms`);
});

test('performance-budget: CLI help command executes within latency ceiling', () => {
  // Warm-up run
  measureExecution('node', [CLI_PATH, '--help']);

  // Measured run
  const { ms, status } = measureExecution('node', [CLI_PATH, '--help']);
  assert.equal(status, 0, 'command exited with status 0');
  // Generous ceiling to prevent CI flakiness while asserting no catastrophic latency
  assert.ok(ms <= 350, `CLI help took ${ms.toFixed(1)} ms (ceiling 350 ms)`);
});

test('performance-budget: goal list verb executes within latency ceiling', () => {
  // Warm-up run
  measureExecution('node', [CLI_PATH, 'goal', '--action', 'list']);

  // Measured run
  const { ms, status } = measureExecution('node', [CLI_PATH, 'goal', '--action', 'list']);
  assert.equal(status, 0, 'goal list exited with status 0');
  assert.ok(ms <= 400, `goal list took ${ms.toFixed(1)} ms (ceiling 400 ms)`);
});

test('performance-budget: pre-bash-guard hook executes within latency ceiling', () => {
  const script = path.join(HOOKS_DIR, 'pre-bash-guard.sh');
  const input = JSON.stringify({ tool: 'bash', command: 'echo test' });

  // Warm-up run
  measureExecution('bash', [script], { input });

  // Measured run
  const { ms, status } = measureExecution('bash', [script], { input });
  assert.equal(status, 0, 'hook exited with status 0');
  assert.ok(ms <= 250, `pre-bash-guard took ${ms.toFixed(1)} ms (ceiling 250 ms)`);
});

test('performance-budget: user-prompt-submit hook executes within latency ceiling', () => {
  const script = path.join(HOOKS_DIR, 'user-prompt-submit.sh');
  const input = JSON.stringify({ session_id: 'perf-test-session', cwd: REPO_ROOT });

  // Warm-up run
  measureExecution('bash', [script], { input });

  // Measured run
  const { ms, status } = measureExecution('bash', [script], { input });
  assert.equal(status, 0, 'hook exited with status 0');
  assert.ok(ms <= 250, `user-prompt-submit took ${ms.toFixed(1)} ms (ceiling 250 ms)`);
});
