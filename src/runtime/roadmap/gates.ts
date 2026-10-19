'use strict';

// IC-004 / IC-006: byte-bound policy and pure, ordered gate evaluation. No filesystem or git I/O.
const { createHash } = require('node:crypto');
const PREDICATES = new Set(['markers-zero:requirement', 'markers-zero:design', 'markers-zero:plan',
  'protected-paths', 'plan-verification-absent', 'plan-parses', 'needs-merged', 'requires-reachable', 'plan-within-write-set',
  'verify-pass-on-head', 'findings-valid', 'no-dropped-findings', 'dispositions-backed', 'blockers-zero']);
const HEX_HEAD = /^[0-9a-f]{40}$/;
const SEVERITIES = new Set(['blocker', 'should-fix', 'note']);
const DISPOSITIONS = new Set(['open', 'fixed', 'refuted', 'user-accepted']);
const USER_CHANNELS = new Set(['question', 'gate', 'prompt']);
const object = (x: any): boolean => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = (x: any): boolean => typeof x === 'string' && x.trim().length > 0;
const strings = (x: any): boolean => Array.isArray(x) && x.every(nonempty) && new Set(x).size === x.length;
const positive = (x: any): boolean => Number.isSafeInteger(x) && x > 0;
const digest = (bytes: string | Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

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

function covers(parent: string, child: string): boolean {
  return parent === child || (parent.endsWith('/') && child.startsWith(parent));
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

function policyValid(policy: any): boolean {
  if (!object(policy) || policy.schema !== 1 || !object(policy.classes) || !object(policy.protected)
    || !object(policy.loop) || !object(policy.merge) || !strings(policy.denyReasons)) return false;
  if (!strings(policy.protected.paths) || !policy.protected.paths.every(validPath) || !validPath(policy.protected.guardDir)
    || !policy.protected.guardDir.endsWith('/') || !strings(policy.protected.packageJsonKeys)
    || !positive(policy.loop.maxSteps) || !positive(policy.loop.wip) || !positive(policy.merge.staleLockSeconds)
    || !Array.isArray(policy.merge.extraTrailers) || !policy.merge.extraTrailers.every(nonempty)) return false;
  const maps = Object.values(policy.classes);
  return maps.length > 0 && maps.every((gates: any) => object(gates) && Object.values(gates).every((gate: any) =>
    object(gate) && ['approve', 'never'].includes(gate.autopilot) && strings(gate.predicates) && gate.predicates.length > 0
    && gate.predicates.every((predicate: string) => PREDICATES.has(predicate))
    && (gate.minSeats === undefined || positive(gate.minSeats))));
}

/** Only the five explicitly permitted override operations are accepted, atomically. */
function narrow(base: any, override: any): { policy: any; key: string | null } {
  const policy = JSON.parse(JSON.stringify(base));
  const reject = (key: string) => ({ policy: null, key });
  for (const key of Object.keys(override)) {
    const value = override[key];
    if (key === 'loop' && object(value)) {
      for (const limit of Object.keys(value)) {
        if (!['maxSteps', 'wip'].includes(limit) || !positive(value[limit]) || value[limit] > base.loop[limit]) return reject(`loop.${limit}`);
        policy.loop[limit] = value[limit];
      }
    } else if (key === 'protected' && object(value)) {
      for (const protectedKey of Object.keys(value)) {
        if (protectedKey !== 'paths' || !strings(value.paths) || !value.paths.every(validPath)
          || !base.protected.paths.every((entry: string) => value.paths.includes(entry))) return reject(`protected.${protectedKey}`);
        policy.protected.paths = [...value.paths];
      }
    } else if (key === 'classes' && object(value)) {
      for (const cls of Object.keys(value)) {
        if (!Object.hasOwn(base.classes, cls) || !object(value[cls])) return reject(`classes.${cls}`);
        for (const gateId of Object.keys(value[cls])) {
          const gate = Object.hasOwn(base.classes[cls], gateId) ? base.classes[cls][gateId] : null;
          const change = value[cls][gateId];
          if (!gate || !object(change)) return reject(`classes.${cls}.${gateId}`);
          for (const field of Object.keys(change)) {
            const at = `classes.${cls}.${gateId}.${field}`;
            if (field === 'autopilot') {
              if (change[field] !== gate.autopilot && !(gate.autopilot === 'approve' && change[field] === 'never')) return reject(at);
            } else if (field === 'minSeats') {
              if (!positive(change[field]) || change[field] < (gate.minSeats || 0)) return reject(at);
            } else return reject(at);
            policy.classes[cls][gateId][field] = change[field];
          }
        }
      }
    } else return reject(key);
  }
  return { policy, key: null };
}

/** Base bytes must come from develop. This pure function never selects or reads a branch. */
function loadPolicy(baseBytes: string | Buffer | null | undefined, overrideBytes?: string | Buffer | null): any {
  const denied = (reason: string) => ({ ok: false, policy: null, digest: null, reason, reasons: [reason] });
  if (baseBytes === null || baseBytes === undefined) return denied('no-policy');
  let base: any;
  try { base = JSON.parse(String(baseBytes)); } catch { return denied('policy-invalid'); }
  if (!policyValid(base)) return denied('policy-invalid');
  let policy = base;
  let policyDigest = digest(baseBytes);
  if (overrideBytes !== null && overrideBytes !== undefined) {
    let override: any;
    try { override = JSON.parse(String(overrideBytes)); } catch { override = undefined; }
    // Unreadable bytes (the caller passes '') or anything but a JSON object is not a widening.
    if (!object(override)) return denied('policy-override-invalid');
    const narrowed = narrow(base, override);
    if (narrowed.key) return denied(`policy-override-widens:${narrowed.key}`);
    policy = narrowed.policy;
    policyDigest += `+${digest(overrideBytes)}`;
  }
  return { ok: true, policy, digest: policyDigest, reason: null, reasons: [] };
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

/**
 * C20: the one verify-record rule (IC-007, D12), shared by gate-b's verify-pass-on-head and the loop's
 * post-merge check. Only lines for `taskId` on `head` from a clean tree count: none is verify-missing;
 * the last must be a PASS and every one schema 1 (else verify-not-pass); a FAIL that a later PASS
 * would hide is verify-flaky. An empty list passes.
 */
function verifyRecordReasons(records: any, head: any, taskId: any): string[] {
  const runs = Array.isArray(records) && HEX_HEAD.test(head) && nonempty(taskId)
    ? records.filter((run: any) => object(run) && run.head === head && run.taskId === taskId && run.clean === true) : [];
  if (runs.length === 0) return ['verify-missing'];
  const found: string[] = [];
  if (runs[runs.length - 1].verdict !== 'PASS' || runs.some((run: any) => run.schema !== 1)) found.push('verify-not-pass');
  if (runs.some((run: any, i: number) => run.verdict === 'FAIL' && runs.slice(i + 1).some((later: any) => later.verdict === 'PASS'))) found.push('verify-flaky');
  return found;
}

/** All predicates run; the first failing predicate owns rule. Facts are data, never executable. */
function evaluate(policy: any, cls: string, gateId: string, facts: any[]): any {
  const reasons: string[] = [];
  let rule = `${gateId}/policy`;
  const inputs = (Array.isArray(facts) ? facts : []).map((f) => ({ locator: f.locator, sha256: f.sha256 }))
    .sort((a, b) => a.locator < b.locator ? -1 : a.locator > b.locator ? 1 : a.sha256 < b.sha256 ? -1 : a.sha256 > b.sha256 ? 1 : 0);
  const result = () => ({ decision: reasons.length ? 'deny' : 'pass', reason: reasons[0] || null, reasons, rule, inputs, inputsDigest: digest(JSON.stringify(inputs)) });
  if (!policy) { reasons.push('no-policy'); return result(); }
  if (!policyValid(policy)) { reasons.push('policy-invalid'); return result(); }
  const gate = Object.hasOwn(policy.classes, cls) && Object.hasOwn(policy.classes[cls], gateId) ? policy.classes[cls][gateId] : null;
  if (!gate) { reasons.push('class-unsupported'); return result(); }
  if (gate.autopilot === 'never') { reasons.push('policy-never'); return result(); }
  const byName = new Map<string, any>();
  for (const fact of facts || []) {
    // Duplicate or unbound facts cannot silently overwrite an earlier source.
    if (byName.has(fact.name) || !nonempty(fact.locator) || !/^sha256:[0-9a-f]{64}$/.test(fact.sha256)) byName.set(fact.name, { ...fact, unreadable: 'invalid-fact' });
    else byName.set(fact.name, fact);
  }
  const get = (name: string): any => byName.get(name)?.value;
  const unavailable = (name: string): boolean => !byName.has(name) || Boolean(byName.get(name).unreadable);
  const source = (name: string): string => byName.get(name)?.locator || name;
  const row = get('row');
  if (unavailable('row') || !object(row) || !nonempty(row.id) || !nonempty(row.slug)) { reasons.push('row-unknown'); return result(); }
  const findings = get('findings');
  const converged = Array.isArray(findings?.converged) ? findings.converged.filter(object) : [];
  const seats = Array.isArray(findings?.seats) ? findings.seats.filter(object) : [];
  const head = get('heads')?.featureHead;
  for (const predicate of gate.predicates) {
    const start = reasons.length;
    const requireFact = (name: string, failure: string): boolean => {
      if (unavailable(name)) { reasons.push(`${failure}:${source(name)}`); return false; }
      return true;
    };
    if (predicate.startsWith('markers-zero:')) {
      const artifact = predicate.slice('markers-zero:'.length);
      const name = `markers:${artifact}`;
      const failure = gateId === 'gate-0' ? 'unresolved-clarifications' : 'markers-open';
      if (requireFact(name, failure)) {
        if (!Number.isSafeInteger(get(name)) || get(name) < 0) reasons.push(`${failure}:${source(name)}`);
        else if (get(name) !== 0) reasons.push(gateId === 'gate-0' ? failure : `${failure}:${artifact === 'design' ? 'design/design.md' : `${artifact}.md`}`);
      }
    } else if (predicate === 'protected-paths') {
      if (requireFact(predicate, 'protected-path')) {
        const data = get(predicate);
        if (!object(data) || !Array.isArray(data.changes) || !object(data.packages?.base) || !object(data.packages?.head)) reasons.push(`protected-path:${source(predicate)}`);
        else {
          const denied = new Set<string>();
          const protectedCovers = (parent: string, child: string) => covers(parent.toLowerCase(), child.toLowerCase());
          const checkPath = (file: string, status: string, declaration = false) => {
            if (!validPath(file) || policy.protected.paths.some((p: string) => protectedCovers(p, file) || (declaration && protectedCovers(file, p)))
              || ((covers(policy.protected.guardDir, file) || (declaration && covers(file, policy.protected.guardDir))) && status !== 'A')) denied.add(file);
          };
          for (const change of data.changes) {
            checkPath(change.path, change.status);
            if (change.oldPath) checkPath(change.oldPath, 'D');
          }
          if (gateId === 'gate-a') for (const file of [...(data.writeSet || []), ...(data.planFiles || [])]) {
            const addition = data.changes.some((c: any) => c.path === file && c.status === 'A') || (data.addedGuards || []).includes(file);
            checkPath(file, addition ? 'A' : 'M', true);
          }
          if (policy.protected.packageJsonKeys.some((key: string) => {
            const before = Object.hasOwn(data.packages.base, key) ? data.packages.base[key] : {};
            const after = Object.hasOwn(data.packages.head, key) ? data.packages.head[key] : {};
            return !object(before) || !object(after) || canonical(before) !== canonical(after);
          })) denied.add('package.json');
          reasons.push(...[...denied].map((file) => `protected-path:${file}`));
        }
      }
    } else if (predicate === 'plan-verification-absent') {
      // C6: a plan.md `doflow-verification` block replaces the post-merge verify commands, so the judged
      // session would write its own check. An absent, unreadable or malformed fact denies.
      if (requireFact('plan-verification-block', 'protected-path')) {
        const present = get('plan-verification-block')?.present;
        if (typeof present !== 'boolean') reasons.push(`protected-path:${source('plan-verification-block')}`);
        else if (present) reasons.push('protected-path:plan-verification');
      }
    } else if (predicate === 'plan-parses') {
      if (requireFact('plan', 'plan-unparsable') && get('plan')?.ok !== true) reasons.push('plan-unparsable');
    } else if (predicate === 'needs-merged' || predicate === 'requires-reachable') {
      const name = predicate === 'needs-merged' ? 'needs' : 'requires';
      const failure = name === 'needs' ? 'need-unmerged' : 'capability-unreachable';
      if (requireFact(name, failure)) {
        if (!Array.isArray(get(name))) reasons.push(`${failure}:${source(name)}`);
        else for (const item of get(name)) {
          if (name === 'needs' && item.status !== 'merged') reasons.push(`need-unmerged:${item.id}`);
          if (name === 'requires' && item.declared !== true) reasons.push(`prerequisite-no-source:${item.id}`);
          else if (name === 'requires' && item.reachable !== true) reasons.push(`capability-unreachable:${item.id}`);
        }
      }
    } else if (predicate === 'plan-within-write-set') {
      if (requireFact('plan', 'write-set-exceeded')) {
        const files = get('plan')?.files;
        if (!Array.isArray(files)) reasons.push(`write-set-exceeded:${source('plan')}`);
        else for (const file of files) if (!validPath(file) || (row.writeSet?.length && !row.writeSet.some((p: string) => validPath(p) && covers(p, file)))) reasons.push(`write-set-exceeded:${file}`);
      }
    } else if (predicate === 'verify-pass-on-head') {
      if (requireFact('verification', 'verify-missing') && requireFact('heads', 'verify-missing')) reasons.push(...verifyRecordReasons(get('verification'), head, row.slug));
    } else if (predicate === 'findings-valid') {
      if (requireFact('findings', 'findings-invalid')) {
        if (findings === null || findings === undefined) reasons.push('findings-missing');
        else if (!validateFindings(findings).ok || findings.row !== row.id || findings.slug !== row.slug) reasons.push('findings-invalid');
        else {
          if (unavailable('heads') || !HEX_HEAD.test(head) || findings.reviewedHead !== head) reasons.push('review-stale-head');
          if (seats.length < (gate.minSeats || 0)) reasons.push('seats-too-few');
        }
      }
    } else if (predicate === 'no-dropped-findings') {
      if (requireFact('findings', 'findings-invalid')) {
        const covered = new Set(converged.flatMap((f: any) => Array.isArray(f?.from) ? f.from : []));
        for (const seat of seats) for (const finding of Array.isArray(seat.findings) ? seat.findings.filter(object) : []) if (finding.severity === 'blocker' && !covered.has(finding.id)) reasons.push(`finding-dropped:${finding.id}`);
      }
    } else if (predicate === 'dispositions-backed') {
      if (requireFact('findings', 'findings-invalid') && requireFact('dispositions', 'findings-invalid')) {
        const backing = get('dispositions');
        const decisions = Array.isArray(backing?.decisions) ? backing.decisions.filter(object) : [];
        for (const finding of converged) {
          if (finding.status === 'refuted' && !evidenceLocator(finding.evidence)) reasons.push(`refuted-without-evidence:${finding.id}`);
          if (finding.status === 'user-accepted' && !decisions.some((d: any) => d.id === finding.decision && USER_CHANNELS.has(d.channel))) reasons.push(`accepted-without-user-decision:${finding.id}`);
          // C5: any session can add a question-channel register entry, so channel membership is not a
          // person. Policy evaluation never accepts a user-accepted disposition; a person decides that gate.
          if (finding.status === 'user-accepted') reasons.push(`user-accepted-needs-person:${finding.id}`);
          if (finding.status === 'fixed' && backing?.ancestors?.[finding.fixedIn] !== true) reasons.push(`fixed-not-ancestor:${finding.id}`);
        }
      }
    } else if (predicate === 'blockers-zero') {
      if (requireFact('findings', 'findings-invalid') && converged.some((f: any) => f.severity === 'blocker' && f.status === 'open')) reasons.push('blockers-open');
    }
    if (start === 0 && reasons.length > start) rule = `${gateId}/${predicate}`;
  }
  if (reasons.length === 0) rule = `${gateId}/pass`;
  return result();
}

module.exports = { loadPolicy, evaluate, validateFindings, verifyRecordReasons };
