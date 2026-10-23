'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Review findings record (`review/findings.json` schema 1): the one validator, shared by roadmap
 * gate-b (`src/runtime/roadmap/gates.ts`) and the review check verb. Pure: no filesystem, no git,
 * no clock.
 */

const HEX_HEAD = /^[0-9a-f]{40}$/;
const ROW_ID = /^[0-9]{3}([a-z]|-[A-Z])?$/;
const SEVERITIES = Object.freeze(['blocker', 'should-fix', 'note']);
const DISPOSITIONS = Object.freeze(['open', 'fixed', 'refuted', 'user-accepted']);
const ORIGINS = Object.freeze(['introduced', 'pre-existing']);
const VERIFICATIONS = Object.freeze(['confirmed', 'plausible']);
const ACCEPTED_AS = Object.freeze(['intentional', 'not-worth-fixing']);
const ROUND_CAP = 3;
// Invisible and format characters (zero-width, word joiner, soft hyphen, bidi and tag marks) are
// stripped and dash variants unified before a verifier id is compared with a seat id (095 C-7, R-1).
const IGNORABLE = /[\p{Default_Ignorable_Code_Point}\p{Cf}]/gu;
const DASH = /\p{Pd}/gu;
const PROTOCOL_DIGEST = /^[0-9a-f]{64}$/;
/** The closed top-level key set (IC-001). */
const RECORD_KEYS = Object.freeze(['schema', 'row', 'slug', 'reviewedHead', 'depth', 'risk', 'protocol', 'rounds', 'author', 'seats', 'converged']);
/** The optional convergence keys of a converged finding (IC-001); other finding keys stay open. */
const FINDING_FIELDS = Object.freeze(['origin', 'preExistingAt', 'escapedFrom', 'verification', 'verifiedBy', 'bugClass', 'sweep', 'acceptedAs']);
/** `family` of an author or a seat: a lower-case family id; `unknown` means not verifiable (119 IC-002). */
const FAMILY_ID = /^[a-z][a-z0-9-]*$/;
const object = (x: any): boolean => x !== null && typeof x === 'object' && !Array.isArray(x);
const nonempty = (x: any): boolean => typeof x === 'string' && x.trim().length > 0;
const strings = (x: any): boolean => Array.isArray(x) && x.every(nonempty) && new Set(x).size === x.length;

/** The risk vocabulary (095b IC-005), read from the verification registry on first use only, so a record without
 * `risk` (and a bench `require` of this file) never loads it. `null` fails closed. */
let riskVocabulary: string[] | null | undefined;
function riskLevels(): string[] | null {
  if (riskVocabulary === undefined) {
    try {
      const { loadVerificationRegistry } = require('../verification/registry.ts');
      riskVocabulary = Object.keys(loadVerificationRegistry().riskLevels);
    } catch { riskVocabulary = null; }
  }
  return riskVocabulary;
}

/** The protocol registry (119 IC-001), read on first use only, so a record with neither `depth` nor `protocol`
 * never loads it. `null` (a load failure) fails closed. One read serves the preset ids and the depth vocabulary. */
let protocolRegistry: any | null | undefined;
function protocols(): any | null {
  if (protocolRegistry === undefined) {
    try {
      const loaded = require('./protocols.ts').loadProtocols();
      protocolRegistry = loaded.ok ? loaded.registry : null;
    } catch { protocolRegistry = null; }
  }
  return protocolRegistry;
}

/** The `kind: review` preset ids of the protocol registry (119 IC-002). */
function reviewPresets(): string[] | null {
  const registry = protocols();
  return registry ? require('./protocols.ts').presetIds(registry, 'review') : null;
}

/** The depth vocabulary (L-1, D-4): each review preset's `depth` label with that preset's seat count. */
function depthSeats(): Record<string, number> | null {
  const registry = protocols();
  if (!registry) return null;
  return Object.fromEntries(require('./protocols.ts').presetIds(registry, 'review')
    .map((id: string) => [registry.presets[id].depth, registry.presets[id].seats.length]));
}

/** `protocol` is exactly `{ id, digest }`: a review preset id of the shipped registry and a sha256 hex digest. */
function validProtocol(value: any): boolean {
  if (!object(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('id') || !keys.includes('digest')) return false;
  if (typeof value.digest !== 'string' || !PROTOCOL_DIGEST.test(value.digest)) return false;
  const ids = reviewPresets();
  return typeof value.id === 'string' && ids !== null && ids.includes(value.id);
}

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

function normalizedSeatId(value: string): string {
  return value.normalize('NFKC').replace(IGNORABLE, '').replace(DASH, '-').trim().toUpperCase().toLowerCase();
}

const identityPart = (key: string, value: any): boolean => key === 'agent' ? nonempty(value)
  : key === 'session' ? value === null || nonempty(value)
  : typeof value === 'string' && FAMILY_ID.test(value);

/** `author` is exactly `{ agent, session, family }` (119 IC-002, L-C1). */
function validAuthor(value: any): boolean {
  const keys = object(value) ? Object.keys(value) : [];
  return keys.length === 3 && ['agent', 'session', 'family'].every((key) => keys.includes(key) && identityPart(key, value[key]));
}

/** A seat's optional `agent`/`session`/`family`: any may be present, each with the author's shape. */
const validSeatIdentity = (seat: any): boolean =>
  ['agent', 'session', 'family'].every((key) => !Object.hasOwn(seat, key) || identityPart(key, seat[key]));

type Sameness = 'warn' | 'refuse';

/**
 * The reviewer-independence facts of a record whose shape is already checked (119 L-C2). Only a record holding
 * `author` has any: INV-1 `independence:<seat>` always an error; `same-family:<seat>` an error under `refuse`,
 * an advisory under `warn`; `family-unverified:<seat>` an advisory.
 */
function identityFacts(data: any, sameFamily: Sameness): { errors: string[]; advisories: string[] } {
  const facts = { errors: [] as string[], advisories: [] as string[] };
  if (!Object.hasOwn(data, 'author') || !validAuthor(data.author) || !Array.isArray(data.seats)) return facts;
  const { author } = data;
  for (const seat of data.seats) {
    if (!object(seat) || !nonempty(seat.id) || !validSeatIdentity(seat)) continue;
    if (seat.agent === author.agent && seat.session != null && author.session != null && seat.session === author.session) {
      facts.errors.push(`independence:${seat.id}`);
    }
    if (seat.family === undefined || seat.family === 'unknown' || author.family === 'unknown') facts.advisories.push(`family-unverified:${seat.id}`);
    else if (seat.family === author.family) (sameFamily === 'refuse' ? facts.errors : facts.advisories).push(`same-family:${seat.id}`);
  }
  return facts;
}

/** Schema checks only. Git ancestry and register-channel backing are separate facts.
 * `sameFamily` (`warn` by default) is the project's `review.sameFamily`: under `refuse` a same-family seat is an error. */
function validateFindings(json: any, { sameFamily = 'warn' }: { sameFamily?: Sameness } = {}): { ok: boolean; errors: string[] } {
  const errors: string[] = [];
  let data = json;
  if (typeof json === 'string' || Buffer.isBuffer(json)) {
    try { data = JSON.parse(String(json)); } catch { return { ok: false, errors: ['json'] }; }
  }
  if (!object(data)) return { ok: false, errors: ['object'] };
  if (Object.keys(data).some((key) => !RECORD_KEYS.includes(key))) errors.push('keys');
  if (data.schema !== 1) errors.push('schema');
  if (typeof data.row !== 'string' || !ROW_ID.test(data.row)) errors.push('row');
  if (typeof data.slug !== 'string' || !data.slug.startsWith(`${data.row}-`) || !/^[a-zA-Z0-9-]+$/.test(data.slug)) errors.push('slug');
  if (typeof data.reviewedHead !== 'string' || !HEX_HEAD.test(data.reviewedHead)) errors.push('reviewedHead');
  const depths = Object.hasOwn(data, 'depth') ? depthSeats() : null;
  const risks = Object.hasOwn(data, 'risk') ? riskLevels() : null;
  if (Object.hasOwn(data, 'depth') && !(typeof data.depth === 'string' && depths && Object.hasOwn(depths, data.depth))) errors.push('depth');
  if (Object.hasOwn(data, 'risk') && !(typeof data.risk === 'string' && risks && risks.includes(data.risk))) errors.push('risk');
  if (Object.hasOwn(data, 'protocol') && !validProtocol(data.protocol)) errors.push('protocol');
  if (Object.hasOwn(data, 'rounds') && !(Number.isSafeInteger(data.rounds) && data.rounds >= 1)) errors.push('rounds');
  if (Object.hasOwn(data, 'author') && !validAuthor(data.author)) errors.push('author');
  const seats = Array.isArray(data.seats) ? data.seats : [];
  const converged = Array.isArray(data.converged) ? data.converged : [];
  if (!Array.isArray(data.seats)) errors.push('seats');
  if (!Array.isArray(data.converged)) errors.push('converged');
  const seatIds = new Set<string>();
  const findingIds = new Set<string>();
  const seatOf = new Map<string, string>();
  for (const seat of seats) {
    if (!object(seat) || !nonempty(seat.id) || seatIds.has(seat.id) || !Array.isArray(seat.findings)) { errors.push('seat'); continue; }
    seatIds.add(seat.id);
    if (!validSeatIdentity(seat)) errors.push(`seat-identity:${seat.id}`);
    for (const finding of seat.findings) {
      if (!object(finding) || !nonempty(finding.id) || findingIds.has(finding.id) || !SEVERITIES.includes(finding.severity)
        || !nonempty(finding.locator) || !nonempty(finding.summary)) { errors.push('seat-finding'); continue; }
      findingIds.add(finding.id);
      seatOf.set(finding.id, seat.id);
    }
  }
  for (const error of identityFacts(data, sameFamily === 'refuse' ? 'refuse' : 'warn').errors) errors.push(error);
  const convergedIds = new Set<string>();
  for (const finding of converged) {
    if (!object(finding) || !nonempty(finding.id) || convergedIds.has(finding.id) || !strings(finding.from)
      || !SEVERITIES.includes(finding.severity) || !DISPOSITIONS.includes(finding.status) || !nonempty(finding.locator)) { errors.push('converged'); continue; }
    convergedIds.add(finding.id);
    if (!finding.from.every((id: string) => findingIds.has(id))) errors.push(`from:${finding.id}`);
    if (finding.status === 'fixed' && (typeof finding.fixedIn !== 'string' || !HEX_HEAD.test(finding.fixedIn))) errors.push(`fixedIn:${finding.id}`);
    if (finding.status === 'refuted' && !evidenceLocator(finding.evidence)) errors.push(`evidence:${finding.id}`);
    if (finding.status === 'user-accepted' && (typeof finding.decision !== 'string' || !/^DEC-[0-9]{3,}$/.test(finding.decision))) errors.push(`decision:${finding.id}`);
    for (const error of convergenceErrors(finding, data.row, seatOf)) errors.push(error);
  }
  return { ok: errors.length === 0, errors };
}

/** IC-001's optional convergence fields of one well-formed converged finding, in FINDING_FIELDS order.
 * Presence is `Object.hasOwn`, so a reserved key holding null or '' is outside its vocabulary.
 * `verifiedBy` without `verification` is allowed: IC-001 requires it only when `confirmed`. */
function convergenceErrors(finding: any, row: any, seatOf: Map<string, string>): string[] {
  const has = (key: string): boolean => Object.hasOwn(finding, key);
  const preExisting = finding.origin === 'pre-existing';
  const bad: string[] = [];
  if (has('origin') && !ORIGINS.includes(finding.origin)) bad.push('origin');
  if (preExisting ? typeof finding.preExistingAt !== 'string' || !HEX_HEAD.test(finding.preExistingAt) : has('preExistingAt')) bad.push('preExistingAt');
  if (has('escapedFrom') && (!preExisting || typeof finding.escapedFrom !== 'string' || !ROW_ID.test(finding.escapedFrom) || finding.escapedFrom === row)) bad.push('escapedFrom');
  if (has('verification') && !VERIFICATIONS.includes(finding.verification)) bad.push('verification');
  if (has('verifiedBy') || finding.verification === 'confirmed') {
    const verifiedBy = typeof finding.verifiedBy === 'string' ? normalizedSeatId(finding.verifiedBy) : '';
    if (typeof finding.verifiedBy !== 'string' || !nonempty(finding.verifiedBy)
      || verifiedBy === '' || /[\u0000-\u001f\u007f-\u009f]/u.test(finding.verifiedBy) || /\s/u.test(verifiedBy)
      || finding.from.some((id: string) => seatOf.has(id)
        && normalizedSeatId(seatOf.get(id) as string) === verifiedBy)) bad.push('verifiedBy');
  }
  if (has('bugClass') && (!nonempty(finding.bugClass) || !has('sweep'))) bad.push('bugClass');
  if (has('sweep') && (!nonempty(finding.sweep) || !has('bugClass'))) bad.push('sweep');
  if (has('acceptedAs') && (finding.status !== 'user-accepted' || !ACCEPTED_AS.includes(finding.acceptedAs))) bad.push('acceptedAs');
  return bad.map((key) => `${key}:${finding.id}`);
}

/** A record that already passed validateFindings, parsed when it came as a string or Buffer. */
const parsed = (json: any): any => (typeof json === 'string' || Buffer.isBuffer(json) ? JSON.parse(String(json)) : json);

/** IC-004's counts of a valid record; `null` for an invalid one. */
function countFindings(json: any): Record<string, string | number | null> | null {
  if (!validateFindings(json).ok) return null;
  const data = parsed(json);
  const converged: any[] = data.converged;
  const count = (test: (finding: any) => boolean): number => converged.filter(test).length;
  return {
    task: data.slug,
    rounds: data.rounds ?? null,
    seats: data.seats.length,
    seat_findings: data.seats.reduce((sum: number, seat: any) => sum + seat.findings.length, 0),
    converged: converged.length,
    blocker: count((f) => f.severity === 'blocker'),
    should_fix: count((f) => f.severity === 'should-fix'),
    note: count((f) => f.severity === 'note'),
    open: count((f) => f.status === 'open'),
    fixed: count((f) => f.status === 'fixed'),
    refuted: count((f) => f.status === 'refuted'),
    user_accepted: count((f) => f.status === 'user-accepted'),
    pre_existing: count((f) => f.origin === 'pre-existing'),
    escaped: count((f) => Object.hasOwn(f, 'escapedFrom')),
    confirmed: count((f) => f.verification === 'confirmed'),
    plausible: count((f) => f.verification === 'plausible'),
    unverified_blockers: count((f) => f.severity === 'blocker' && f.verification !== 'confirmed'),
    bug_classes: new Set(converged.filter((f) => Object.hasOwn(f, 'bugClass')).map((f) => f.bugClass)).size,
  };
}

/** IC-002's advisories of a valid record, sorted; `[]` for an invalid one (its errors say why). */
function reviewAdvisories(json: any, { sameFamily = 'warn' }: { sameFamily?: Sameness } = {}): string[] {
  const option = { sameFamily: sameFamily === 'refuse' ? 'refuse' : 'warn' } as { sameFamily: Sameness };
  if (!validateFindings(json, option).ok) return [];
  const data = parsed(json);
  const advisories: string[] = identityFacts(data, option.sameFamily).advisories;
  for (const finding of data.converged) {
    if (finding.severity === 'blocker' && finding.verification !== 'confirmed') advisories.push(`unverified-blocker:${finding.id}`);
    if (Object.hasOwn(finding, 'bugClass') && finding.status === 'open') advisories.push(`bug-class-open:${finding.id}`);
  }
  if (Object.hasOwn(data, 'rounds') && data.rounds >= ROUND_CAP) advisories.push(`round-cap:${data.rounds}`);
  if (Object.hasOwn(data, 'depth') && data.seats.length < (depthSeats() as Record<string, number>)[data.depth]) advisories.push(`depth-unmet:${data.depth}`);
  return advisories.sort();
}

module.exports = {
  HEX_HEAD, SEVERITIES, DISPOSITIONS, ORIGINS, VERIFICATIONS, ACCEPTED_AS, ROUND_CAP, RECORD_KEYS, FINDING_FIELDS,
  object, nonempty, strings, validPath, evidenceLocator, validateFindings, countFindings, reviewAdvisories,
};
