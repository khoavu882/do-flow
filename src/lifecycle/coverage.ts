'use strict';

const crypto = require('node:crypto');
const CLASS_ORDER = Object.freeze(['unknown', 'unsupported', 'observation', 'advisory', 'blocking']);
const POLICY_ORDER = Object.freeze(['pre-implementation-gate', 'pre-bash-guard', 'session-context', 'mcp-tool-guard', 'stop-check']);
const HARNESS_ORDER = Object.freeze(['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']);
const BEHAVIOUR_ORDER = Object.freeze(['context-authority', 'default-silence', 'summary-scope', 'summary-grant', 'identity', 'check-freshness']);
const NEVER_BLOCKING_EVENTS = new Set([
  'pi\u0000tool_execution_start', 'antigravity\u0000PostToolUse', 'antigravity\u0000PreInvocation',
  'antigravity\u0000PostInvocation', 'gemini\u0000AfterTool', 'claude\u0000PostToolUse', 'codex\u0000PostToolUse',
]);
function stable(value: any): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function rowsDigest(rows: any[]): string { return `sha256:${crypto.createHash('sha256').update(stable(rows)).digest('hex')}`; }
class UnknownEnforcementTarget extends Error {
  code: string;
  constructor(code: string, detail: string) { super(detail); this.name = 'UnknownEnforcementTarget'; this.code = code; }
}
function enforcementFor(coverage: any, query: { harness: string; policy: string; profile?: string }): any {
  const rows = coverage?.rows || [];
  const profiles = coverage?.profiles || {};
  if (query.policy === '*') throw new UnknownEnforcementTarget('unknown-policy', "Unknown policy '*'");
  if (!rows.some((row: any) => row.harness === query.harness)) throw new UnknownEnforcementTarget('unknown-harness', `Unknown harness '${query.harness}'`);
  if (!rows.some((row: any) => row.policy === query.policy)) throw new UnknownEnforcementTarget('unknown-policy', `Unknown policy '${query.policy}'`);
  if (query.profile !== undefined && !Object.hasOwn(profiles, query.profile)) throw new UnknownEnforcementTarget('unknown-profile', `Unknown profile '${query.profile}'`);
  const pairRows = rows.filter((row: any) => row.harness === query.harness && (row.policy === query.policy || row.policy === '*'));
  const timing = query.policy === 'stop-check' ? 'stop' : 'pre-tool';
  const applicable = pairRows.filter((row: any) => row.timing === timing && (query.profile === undefined || row.profile === query.profile || row.profile === 'any'));
  const enforced = applicable.length > 0 && applicable.every((row: any) => row.wired && row.class === 'blocking' && row.verification === 'verified');
  const rank = (row: any) => CLASS_ORDER.indexOf(row.class);
  const weakest = [...applicable].sort((a: any, b: any) => rank(a) - rank(b))[0];
  const intersection = (field: string) => applicable.length ? [...new Set<string>(applicable[0][field] || [])].filter((item) => applicable.every((row: any) => (row[field] || []).includes(item))) : [];
  const union = (field: string) => [...new Set(applicable.flatMap((row: any) => row[field] || []))];
  const parity = enforced && pairRows.length > 0 && pairRows.every((row: any) => row.class === 'blocking');
  return {
    harness: query.harness, policy: query.policy, profile: query.profile ?? null, enforced, parity,
    class: weakest?.class || 'unknown', verification: weakest?.verification || 'unverified',
    prerequisites: union('prerequisites'), covers: intersection('covers'), doesNotCover: union('doesNotCover'), caveats: union('caveats'),
    rows: applicable, matrix: { schemaVersion: coverage.schemaVersion, revision: coverage.revision, rowsDigest: coverage.rowsDigest },
    reason: weakest ? `${weakest.class} at (${weakest.policy}, ${weakest.harness}, ${weakest.event}, ${weakest.profile})` : `unknown at (${query.policy}, ${query.harness}, *, ${query.profile ?? '*'})`,
  };
}
function renderEnforcementMatrix(coverage: any): string {
  const order = (items: readonly string[], value: string) => {
    const index = items.indexOf(value);
    return index < 0 ? items.length : index;
  };
  const rows = [...coverage.rows].sort((a: any, b: any) => order(POLICY_ORDER, a.policy) - order(POLICY_ORDER, b.policy)
    || order(HARNESS_ORDER, a.harness) - order(HARNESS_ORDER, b.harness)
    || a.event.localeCompare(b.event) || a.profile.localeCompare(b.profile));
  const lines = [`Schema ${coverage.schemaVersion}; revision ${coverage.revision}; ${coverage.rowsDigest}`, '| Policy | Harness | Native event | Profile | Class | Verification | Prerequisites | Does not cover |', '|---|---|---|---|---|---|---|---|'];
  for (const row of rows) lines.push(`| ${row.policy} | ${row.harness} | ${row.event} | ${row.profile} | ${row.class} | ${row.verification} | ${(row.prerequisites || []).join(', ')} | ${(row.doesNotCover || []).join(', ')} |`);
  return lines.join('\n');
}
// IC-019: one row per behaviour x harness, ordered by IC-018's behaviour list, then HARNESS_ORDER.
function renderBehaviourMatrix(coverage: any): string {
  const order = (items: readonly string[], value: string) => {
    const index = items.indexOf(value);
    return index < 0 ? items.length : index;
  };
  const entries = [...(coverage.behaviours || [])].sort((a: any, b: any) => order(BEHAVIOUR_ORDER, a.behaviour) - order(BEHAVIOUR_ORDER, b.behaviour)
    || order(HARNESS_ORDER, a.harness) - order(HARNESS_ORDER, b.harness)
    || a.behaviour.localeCompare(b.behaviour) || a.harness.localeCompare(b.harness));
  const lines = [`Schema ${coverage.schemaVersion}; revision ${coverage.revision}`, '| Behaviour | Harness | Status | Limitation or tests |', '|---|---|---|---|'];
  for (const entry of entries) {
    const detail = entry.status === 'enforced' ? (entry.tests || []).join(', ') : (entry.limitation || '');
    lines.push(`| ${entry.behaviour} | ${entry.harness} | ${entry.status} | ${detail} |`);
  }
  return lines.join('\n');
}
module.exports = { enforcementFor, renderEnforcementMatrix, renderBehaviourMatrix, BEHAVIOUR_ORDER, HARNESS_ORDER, rowsDigest, UnknownEnforcementTarget, NEVER_BLOCKING_EVENTS };
