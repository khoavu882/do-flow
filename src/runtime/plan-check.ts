'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * `plan-check <plan path> [--json]` (feature 115, IC-001): the plan judgement `planVerdict` makes,
 * printed, plus row 134's content findings (`plan-content.ts`), each with a `path:line`. Read-only:
 * it reads the plan and the requirement beside it and writes nothing. Exit 0 ok, 1 problems, 2
 * usage or an unreadable file; the exit and `ok` are the task-graph verdict alone, so plan-check,
 * task-attempt and the roadmap facts still agree about a plan's task graph.
 */

const fs = require('node:fs');
const path = require('node:path');
const { planVerdict } = require('./task-graph.ts');
const { planFindings } = require('./plan-content.ts');
const { finishRuntime } = require('./cli-result.ts');

const TEXT_MAX = 200;
const ALLOWED_FLAGS = new Set(['--json']);

function refuse(error: string, message: string, json: boolean): number {
  if (json) console.log(JSON.stringify({ ok: false, error, message }));
  else console.error(`doflow plan-check: ${error}: ${message}`);
  return finishRuntime(2);
}

function describe(file: string, verdict: any, findings: any[]): string {
  const warned = verdict.warnings.length ? `; warnings: ${verdict.warnings.join('; ')}` : '';
  const found = findings.length ? `; findings: ${findings.map((f: any) => `${f.rule} ${f.path}:${f.line}`).join(', ')}` : '';
  const parts = verdict.problems.map((problem: any) => (problem.ids.length ? `${problem.kind} ${problem.ids.join(',')}` : problem.kind));
  const line = verdict.ok
    ? `plan-check: ${file}: ok, ${verdict.tasks} tasks${warned}${found}`
    : `plan-check: ${file}: ${verdict.problems.length} problem(s): ${parts.join('; ')}${warned}${found}`;
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
  const planAbs = path.resolve(cwd, file);
  try {
    text = fs.readFileSync(planAbs, 'utf8');
  } catch (error: any) {
    return refuse('plan-unreadable', `cannot read '${file}': ${error.code || error.message}`, json);
  }
  const verdict = planVerdict(text);
  const findings = planFindings({ planAbs, text, displayPath: file, cwd });
  if (json) console.log(JSON.stringify({ ...verdict, findings, file }));
  else console.log(describe(file, verdict, findings));
  return finishRuntime(verdict.ok ? 0 : 1);
}

module.exports = { handlePlanCheckCommand };
