'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `plan-check <plan path> [--json]` (feature 115, IC-001): the plan judgement `planVerdict` makes,
 * printed. Read-only: it reads the one file and writes nothing. Exit 0 ok, 1 problems, 2 usage or
 * an unreadable file.
 */

const fs = require('node:fs');
const path = require('node:path');
const { planVerdict } = require('./task-graph.ts');
const { finishRuntime } = require('./cli-result.ts');

const TEXT_MAX = 200;
const ALLOWED_FLAGS = new Set(['--json']);

function refuse(error: string, message: string, json: boolean): number {
  if (json) console.log(JSON.stringify({ ok: false, error, message }));
  else console.error(`doflow plan-check: ${error}: ${message}`);
  return finishRuntime(2);
}

function describe(file: string, verdict: any): string {
  if (verdict.ok) return `plan-check: ${file}: ok, ${verdict.tasks} tasks`;
  const parts = verdict.problems.map((problem: any) => (problem.ids.length ? `${problem.kind} ${problem.ids.join(',')}` : problem.kind));
  const line = `plan-check: ${file}: ${verdict.problems.length} problem(s): ${parts.join('; ')}`;
  return line.length > TEXT_MAX ? `${line.slice(0, TEXT_MAX - 3)}...` : line;
}

function handlePlanCheckCommand({ positional = [], extraFlags = [], flagsGiven, json = false, cwd = process.cwd() }: any = {}): number {
  const flags = flagsGiven || extraFlags;
  const badFlag = flags.find((f: string) => !ALLOWED_FLAGS.has(f.split('=')[0]));
  if (badFlag) return refuse('usage', `unknown flag '${badFlag}'; usage: plan-check <plan path> [--json]`, json);
  if (positional.length === 0) return refuse('usage', 'a plan path is required; usage: plan-check <plan path> [--json]', json);
  if (positional.length > 1) return refuse('usage', `exactly one plan path is accepted, got ${positional.length}; usage: plan-check <plan path> [--json]`, json);
  const file = positional[0];
  let text: string;
  try {
    text = fs.readFileSync(path.resolve(cwd, file), 'utf8');
  } catch (error: any) {
    return refuse('plan-unreadable', `cannot read '${file}': ${error.code || error.message}`, json);
  }
  const verdict = planVerdict(text);
  if (json) console.log(JSON.stringify({ ...verdict, file }));
  else console.log(describe(file, verdict));
  return finishRuntime(verdict.ok ? 0 : 1);
}

module.exports = { handlePlanCheckCommand };
