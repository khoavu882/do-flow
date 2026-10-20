'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Review findings record (`review/findings.json` schema 1): the one validator, shared by roadmap
 * gate-b (`src/runtime/roadmap/gates.ts`) and the review check verb. Pure: no filesystem, no git,
 * no clock.
 */

const HEX_HEAD = /^[0-9a-f]{40}$/;
const SEVERITIES = new Set(['blocker', 'should-fix', 'note']);
const DISPOSITIONS = new Set(['open', 'fixed', 'refuted', 'user-accepted']);
const object = (x: any): boolean => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = (x: any): boolean => typeof x === 'string' && x.trim().length > 0;
const strings = (x: any): boolean => Array.isArray(x) && x.every(nonempty) && new Set(x).size === x.length;

/** Repo-relative literal path; traversal, globs, absolute paths and alternate separators fail closed. */
function validPath(value: any): boolean {
  return nonempty(value) && !/^[\/~]|[\\\x00-\x1f:*?\[\]{}]/.test(value)
    && !value.split('/').some((part: string, i: number, all: string[]) => part === '..' || part === '.' || (part === '' && i !== all.length - 1));
}

/** IC-006 refutation evidence is a locator: `path:line[-line]`, or a test or reproducer file path.
 * Shape only: any repo-relative file path with an extension passes; existence is not checked. */
function evidenceLocator(value: any): boolean {
  if (!nonempty(value) || /\s/.test(value)) return false;
  const at = /^(.+):[1-9][0-9]*(?:-[1-9][0-9]*)?$/.exec(value);
  return at ? validPath(at[1]) && !at[1].endsWith('/') : validPath(value) && /[^/]\.[A-Za-z0-9]+$/.test(value);
}

/** Schema checks only. Git ancestry and register-channel backing are separate facts. */
function validateFindings(json: any): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  let data = json;
  if (typeof json === 'string' || Buffer.isBuffer(json)) {
    try { data = JSON.parse(String(json)); } catch { return { ok: false, errors: ['json'] }; }
  }
  if (!object(data)) return { ok: false, errors: ['object'] };
  if (Object.keys(data).some((key) => !['schema', 'row', 'slug', 'reviewedHead', 'seats', 'converged'].includes(key))) errors.push('keys');
  if (data.schema !== 1) errors.push('schema');
  if (typeof data.row !== 'string' || !/^[0-9]{3}([a-z]|-[A-Z])?$/.test(data.row)) errors.push('row');
  if (typeof data.slug !== 'string' || !data.slug.startsWith(`${data.row}-`) || !/^[a-zA-Z0-9-]+$/.test(data.slug)) errors.push('slug');
  if (typeof data.reviewedHead !== 'string' || !HEX_HEAD.test(data.reviewedHead)) errors.push('reviewedHead');
  const seats = Array.isArray(data.seats) ? data.seats : [];
  const converged = Array.isArray(data.converged) ? data.converged : [];
  if (!Array.isArray(data.seats)) errors.push('seats');
  if (!Array.isArray(data.converged)) errors.push('converged');
  const seatIds = new Set<string>();
  const findingIds = new Set<string>();
  for (const seat of seats) {
    if (!object(seat) || !nonempty(seat.id) || seatIds.has(seat.id) || !Array.isArray(seat.findings)) { errors.push('seat'); continue; }
    seatIds.add(seat.id);
    for (const finding of seat.findings) {
      if (!object(finding) || !nonempty(finding.id) || findingIds.has(finding.id) || !SEVERITIES.has(finding.severity)
        || !nonempty(finding.locator) || !nonempty(finding.summary)) { errors.push('seat-finding'); continue; }
      findingIds.add(finding.id);
    }
  }
  const convergedIds = new Set<string>();
  for (const finding of converged) {
    if (!object(finding) || !nonempty(finding.id) || convergedIds.has(finding.id) || !strings(finding.from)
      || !SEVERITIES.has(finding.severity) || !DISPOSITIONS.has(finding.status) || !nonempty(finding.locator)) { errors.push('converged'); continue; }
    convergedIds.add(finding.id);
    if (!finding.from.every((id: string) => findingIds.has(id))) errors.push(`from:${finding.id}`);
    if (finding.status === 'fixed' && (typeof finding.fixedIn !== 'string' || !HEX_HEAD.test(finding.fixedIn))) errors.push(`fixedIn:${finding.id}`);
    if (finding.status === 'refuted' && !evidenceLocator(finding.evidence)) errors.push(`evidence:${finding.id}`);
    if (finding.status === 'user-accepted' && (typeof finding.decision !== 'string' || !/^DEC-[0-9]{3,}$/.test(finding.decision))) errors.push(`decision:${finding.id}`);
  }
  return { ok: errors.length === 0, errors };
}

module.exports = { HEX_HEAD, SEVERITIES, DISPOSITIONS, object, nonempty, strings, validPath, evidenceLocator, validateFindings };
