'use strict';

/**
 * 181 C14 (IC-024): `verify --action inner-loop --task-id <id>`. The verdict a skill asks before it
 * starts an auto-fix or fuzz loop: READY only when the task's latest verify run record is on the
 * current head, was and is a clean tree, and its `build`, `static-analysis` and `targeted-tests`
 * tiers are each `PASS`, `SUBSUMED` or `NOT_APPLICABLE`; otherwise REFUSED with every reason that
 * applies. It reads the record and the git state and runs nothing, so the same files give the same
 * answer. It is a verdict, never a hook that denies a tool call (NFR-001).
 *
 * A tier that listed no check is in the record as one entry with the tier's own status (see
 * `recordChecks` in engine.ts); a tier with no entry at all, as in a schema 1 line, is not shown as run.
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const { finishRuntime } = require('../cli-result.ts');
const { loadVerificationRegistry } = require('./registry.ts');
const { INNER_LOOP_TIERS, verificationGitState, verificationRunsRoot, verificationRunRecordFile } = require('./engine.ts');

const GREEN = new Set(['PASS', 'SUBSUMED', 'NOT_APPLICABLE']);

/** The latest line of the task's verify run records (schema 1 or 2), or `null`. */
function latestRecord({ root, taskId, fsImpl }: any): any {
  let text: string;
  try { text = fsImpl.readFileSync(verificationRunRecordFile(root, taskId), 'utf8'); } catch { return null; }
  let record: any = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (parsed.schema === 1 || parsed.schema === 2) && parsed.taskId === taskId) record = parsed;
    } catch { /* an unreadable line is not a record */ }
  }
  return record;
}

/** `{ verdict, head, reasons }` for `taskId`; `state` is `verificationGitState`'s answer or `null`. */
function innerLoopVerdict({ taskId, record, state }: any): any {
  const verifyCommand = `doflow-run verify --task-id ${taskId} --action report`;
  const head = state ? state.head : null;
  if (!state || !record || record.head !== state.head || record.clean !== true || state.clean !== true) {
    return { verdict: 'REFUSED', head, reasons: [{ code: 'not-run', tiers: [], commands: [verifyCommand] }] };
  }
  const checks: any[] = Array.isArray(record.checks) ? record.checks : [];
  const missing: string[] = [];
  const failing: string[] = [];
  const failingCommands: string[] = [];
  const notRun: string[] = [];
  for (const tier of INNER_LOOP_TIERS) {
    const entries = checks.filter((c: any) => c && c.tier === tier);
    if (entries.length === 0) { notRun.push(tier); continue; }
    for (const c of entries) {
      if (GREEN.has(c.status)) continue;
      if (c.status === 'FAIL') { if (!failing.includes(tier)) failing.push(tier); failingCommands.push(c.command ?? tier); }
      else if (c.status === 'UNRESOLVED') { if (!missing.includes(tier)) missing.push(tier); }
      else if (!notRun.includes(tier)) notRun.push(tier);
    }
  }
  const reasons: any[] = [];
  if (notRun.length) reasons.push({ code: 'not-run', tiers: notRun, commands: [verifyCommand] });
  if (missing.length) {
    const roles: string[] = [];
    for (const tier of loadVerificationRegistry().tiers) {
      if (missing.includes(tier.id)) for (const role of tier.commandRoles || []) if (!roles.includes(role)) roles.push(role);
    }
    reasons.push({ code: 'missing', tiers: missing, commands: roles });
  }
  if (failing.length) reasons.push({ code: 'failing', tiers: failing, commands: failingCommands });
  return { verdict: reasons.length ? 'REFUSED' : 'READY', head, reasons };
}

const REASON_TEXT: any = {
  'not-run': (r: any) => `${r.tiers.length ? `no passing run shows ${r.tiers.join(', ')}` : 'no verify run of this task on the current head from a clean tree'}; run: ${r.commands[0]}`,
  missing: (r: any) => `no command for ${r.tiers.join(', ')} (roles: ${r.commands.join(', ')}); detect it or declare it in plan.md's doflow-verification block`,
  failing: (r: any) => `${r.tiers.join(', ')} failed: ${r.commands.join('; ')}`,
};

function handleInnerLoopCommand({ taskId, json = false, projectRoot, env = process.env, fsImpl = nodeFs }: any): number {
  const cwd = path.resolve(projectRoot || process.cwd());
  const record = latestRecord({ root: verificationRunsRoot(cwd), taskId, fsImpl });
  const answer = innerLoopVerdict({ taskId, record, state: verificationGitState(cwd, env) });
  const ready = answer.verdict === 'READY';
  if (json) console.log(JSON.stringify({ ok: ready, action: 'inner-loop', ...answer }, null, 2));
  else {
    console.log(ready ? `inner-loop: READY for ${taskId} (build, static-analysis and targeted-tests green on ${String(answer.head).slice(0, 12)})` : `inner-loop: REFUSED for ${taskId}`);
    for (const reason of answer.reasons) console.log(`  ${reason.code}: ${REASON_TEXT[reason.code](reason)}`);
  }
  return finishRuntime(ready ? 0 : 1);
}

module.exports = { handleInnerLoopCommand, innerLoopVerdict };
