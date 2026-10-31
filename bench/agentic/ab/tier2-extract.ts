'use strict';

/**
 * Process evidence of one tier-2 run, from its stream-json transcripts (never scored, reported beside the outcome):
 * the hook denies by hook id, the skills invoked, the task class DoFlow chose, and the tokens and cost by model.
 *
 * Input: `sessions[s][g]` = the text of segment g (a first run or a `--resume`) of session s. Per session the last
 * segment's `modelUsage` is the whole session when the figures are cumulative (the default, SOURCE: the result event
 * of a resumed run reports running totals), else the segments are summed; sessions are always summed.
 *
 * - SOURCE for a deny: a `system/hook_response` event of a Stop or PreToolUse hook with exit code 2, or whose output
 *   carries `permissionDecision: deny` or `decision: block`. The hook id is read from the `[stop-check]`-style
 *   prefix of its message when there is one, else from the hook event (Stop = stop-check, PreToolUse:Bash =
 *   unknown, other PreToolUse = pre-implementation-gate). The fallback is INFERRED, so such a deny is marked.
 *   A transcript recorded before `pre-bash-guard` was removed keeps that id (HISTORIC_HOOK_IDS): it is counted
 *   under its own name and never attributed to a hook that still exists.
 * - SOURCE for the class: the `--task-class <x>` argument of a Bash command that runs `classify`.
 * No I/O.
 */

const claudeStream = require('./claude-stream.ts');

const HOOK_IDS = Object.freeze(['pre-implementation-gate', 'stop-check']);
/** Hooks DoFlow no longer ships; an old transcript can still carry their denies. */
const HISTORIC_HOOK_IDS = Object.freeze(['pre-bash-guard']);
const CLASSIFY = /\bclassify\b[^\n]*?--task-class[ =]+["']?([A-Za-z][A-Za-z0-9-]*)/;
const REASON_CHARS = 200;
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheCreationInputTokens', 'cacheReadInputTokens'] as const;

type Deny = { id: string; inferred: boolean; hookEvent: string; hookName: string; exitCode: number | null; reason: string };

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The hook denies of one transcript, in stream order. */
function hookDenies(transcript: string): Deny[] {
  const out: Deny[] = [];
  for (const line of String(transcript).split('\n')) {
    if (!line.includes('hook_response')) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev?.type !== 'system' || ev.subtype !== 'hook_response') continue;
    const hookEvent = text(ev.hook_event);
    if (hookEvent !== 'Stop' && hookEvent !== 'PreToolUse') continue;
    const body = [text(ev.stderr), text(ev.stdout), text(ev.output)].join('\n');
    const exitCode = Number.isInteger(ev.exit_code) ? ev.exit_code : null;
    const denied = exitCode === 2 || /"permissionDecision"\s*:\s*"deny"/.test(body) || /"decision"\s*:\s*"block"/.test(body);
    if (!denied) continue;
    const named = [...HOOK_IDS, ...HISTORIC_HOOK_IDS].find((id) => body.includes(`[${id}]`) || body.includes(`${id}:`));
    const hookName = text(ev.hook_name);
    const byEvent = hookEvent === 'Stop' ? 'stop-check' : (/:Bash$/.test(hookName) ? 'unknown' : 'pre-implementation-gate');
    out.push({ id: named ?? byEvent, inferred: named === undefined, hookEvent, hookName, exitCode, reason: body.trim().replace(/\s+/g, ' ').slice(0, REASON_CHARS) });
  }
  return out;
}

const zeroRow = () => ({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, totalTokens: 0, costUSD: 0 });

function addRow(into: any, row: any): void {
  for (const k of TOKEN_KEYS) into[k] += row[k] ?? 0;
  into.costUSD += row.costUSD ?? 0;
  into.totalTokens = TOKEN_KEYS.reduce((n, k) => n + into[k], 0);
}

/**
 * @param sessions segment texts per session
 * @param opts `cumulative` (default true): whether a later segment of a session repeats the earlier ones' totals
 */
function extractProcess(sessions: string[][], opts: { cumulative?: boolean } = {}) {
  const cumulative = opts.cumulative !== false;
  const denies: Deny[] = [];
  const skills: { skill: string; via: string }[] = [];
  const classCalls: string[] = [];
  const byModel: Record<string, ReturnType<typeof zeroRow>> = {};
  let subagentCalls = 0;
  const sessionRows: Record<string, unknown>[] = [];
  sessions.forEach((segments, i) => {
    const reports = segments.map((t) => claudeStream.parseTranscript(t));
    for (const t of segments) denies.push(...hookDenies(t));
    for (const r of reports) {
      for (const e of r.skillEvents) skills.push({ skill: e.skill, via: e.via });
      for (const c of r.toolCalls) {
        if (c.name !== 'Bash') continue;
        const m = CLASSIFY.exec(String(c.rawTarget ?? c.target ?? ''));
        if (m) classCalls.push(m[1]);
      }
      subagentCalls += r.subagentCalls.length;
    }
    const counted = cumulative ? reports.slice(-1) : reports;
    const perSession: Record<string, ReturnType<typeof zeroRow>> = {};
    for (const r of counted) {
      for (const [model, row] of Object.entries<any>(r.modelUsage)) {
        addRow(byModel[model] ??= zeroRow(), row);
        addRow(perSession[model] ??= zeroRow(), row);
      }
    }
    sessionRows.push({ n: i + 1, byModel: perSession });
  });
  const counts: Record<string, number> = Object.fromEntries(HOOK_IDS.map((id) => [id, 0]));
  for (const d of denies) counts[d.id] = (counts[d.id] ?? 0) + 1;
  const skillNames = [...new Set(skills.map((s) => s.skill))];
  const totalCostUsd = Object.values(byModel).reduce((n, r) => n + r.costUSD, 0);
  return {
    hookDenies: counts,
    hookDenyEvents: denies,
    skills: skillNames,
    skillEvents: skills,
    class: classCalls.length ? classCalls[classCalls.length - 1] : null,
    classCalls,
    subagentCalls,
    byModel,
    totalTokens: Object.values(byModel).reduce((n, r) => n + r.totalTokens, 0),
    totalCostUsd: Object.keys(byModel).length ? totalCostUsd : null,
    sessions: sessionRows,
  };
}

module.exports = { HOOK_IDS, HISTORIC_HOOK_IDS, hookDenies, extractProcess };
