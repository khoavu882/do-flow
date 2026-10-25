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
const { workerIdFault } = require('../../registry/worker-ids.ts');
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9 ._:/@()[\]#+-]*$/;
const MODEL_ID_MAX = 120;
const validModelId = (value: unknown): boolean =>
  value === 'unknown' || (typeof value === 'string' && value.length > 0 && value.length <= MODEL_ID_MAX && MODEL_ID_RE.test(value) && !value.endsWith(' '));
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
 * never loads it. `null` (a load failure) fails closed. One read serves the preset ids and the depth vocabulary.
 * It is the merged view (122 IC-014) this process resolves under its own environment and config home: gate-b and the
 * check verb never take a package set from the record or from the environment it was made in (NFR-005). A caller may
 * pass another merged registry (`protocols` / `registry` below); that is the only seam. */
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

/** The `kind: review` preset ids of a merged view's active set (119 IC-002, 122 IC-014): the effective core order,
 * then the ids active packages contribute. */
function reviewPresets(registry: any = protocols()): string[] | null {
  if (!registry) return null;
  const { presetIds, contributedPresetIds } = require('./protocols.ts');
  return [...presetIds(registry, 'review'), ...contributedPresetIds(registry, 'review')];
}

/** The depth vocabulary (L-1, D-4): each review preset's `depth` label with that preset's seat count. */
function depthSeats(): Record<string, number> | null {
  const registry = protocols();
  if (!registry) return null;
  return Object.fromEntries(require('./protocols.ts').presetIds(registry, 'review')
    .map((id: string) => [registry.presets[id].depth, registry.presets[id].seats.length]));
}

/** The error of a recorded `protocol`, or null. It is exactly `{ id, digest }`: a review preset id of the merged view and
 * a sha256 hex digest (`protocol`). A well-formed package-qualified id that the view does not hold active is
 * `protocol-unavailable` (122 IC-014): its package is not installed, enabled or trusted where the record is checked. */
function protocolError(value: any, registry: any): 'protocol' | 'protocol-unavailable' | null {
  if (!object(value)) return 'protocol';
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('id') || !keys.includes('digest')) return 'protocol';
  if (typeof value.digest !== 'string' || !PROTOCOL_DIGEST.test(value.digest)) return 'protocol';
  const ids = reviewPresets(registry);
  if (typeof value.id === 'string' && ids !== null && ids.includes(value.id)) return null;
  return ids !== null && require('../../helper/package-ids.ts').isQualifiedId(value.id) ? 'protocol-unavailable' : 'protocol';
}

/** C-6: the first project or local candidate of a resolved setting that is `invalid` (a malformed file or a bad value in it).
 * The resolver then falls back to the key's default without a word, so a `review.*` reader treats it as unreadable. */
function invalidProjectCandidate(resolution: any): { source: string; reason: string } | undefined {
  return (resolution?.candidates ?? []).find((c: any) => ['project', 'local'].includes(c.layer) && c.status === 'invalid');
}

/** The preset keys (`review.preset`, `debate.preset`) also refuse an invalid user value: the user file's preset is a
 * floor like the project's, and an unknown id dropped to `auto` or the registry default would lower it without a word. */
function invalidPresetCandidate(resolution: any): { source: string; reason: string } | undefined {
  return (resolution?.candidates ?? []).find((c: any) => ['user', 'project', 'local'].includes(c.layer) && c.status === 'invalid');
}

/** True when the record's protocol is looser than `presetId`, the project's `review.preset`: later in the strictest-first
 * core `order.review`, or, for a contributed id on either side, not dominating it (122 IC-014). `auto` needs the diff,
 * which gate-b does not read, so it never compares (C-2). Fails closed: an id outside the active set of `registry` (gate-b's
 * own merged view by default, never the record's), or no readable view, counts as looser. */
function protocolLooserThanPreset(protocol: any, presetId: any, registry: any = protocols()): boolean {
  if (!object(protocol) || typeof presetId !== 'string' || presetId === 'auto') return false;
  const ids = reviewPresets(registry);
  if (ids === null || !ids.includes(protocol.id) || !ids.includes(presetId)) return true;
  return !require('./resolve-protocol.ts').atLeastAsStrict(registry, 'review', protocol.id, presetId);
}

/** 122 IC-024: the `review.run` telemetry `protocol` of a recorded id: a core review preset id as it is, `package` for an
 * id an active package contributes (no third-party name enters telemetry), null for anything else. */
function telemetryProtocol(id: any, registry: any = protocols()): string | null {
  if (typeof id !== 'string' || !registry) return null;
  const { presetIds, contributedPresetIds } = require('./protocols.ts');
  if (presetIds(registry, 'review').includes(id)) return id;
  return contributedPresetIds(registry, 'review').includes(id) ? 'package' : null;
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

/** `author` is `{ agent, session, family }` plus optional `harness` and `model` (119 IC-002, 120 IC-015). */
function validAuthor(value: any): boolean {
  if (!object(value)) return false;
  const keys = Object.keys(value);
  if (!['agent', 'session', 'family'].every((key) => keys.includes(key) && identityPart(key, value[key]))) return false;
  for (const key of keys) {
    if (key === 'agent' || key === 'session' || key === 'family') continue;
    if (key === 'harness') {
      if (workerIdFault(value.harness) !== null) return false;
    } else if (key === 'model') {
      if (!validModelId(value.model)) return false;
    } else {
      return false;
    }
  }
  return true;
}

/** A seat's optional `agent`/`session`/`family`/`harness`/`model`: any may be present, each with the author's shape. */
const validSeatIdentity = (seat: any): boolean =>
  ['agent', 'session', 'family'].every((key) => !Object.hasOwn(seat, key) || identityPart(key, seat[key]))
  && (!Object.hasOwn(seat, 'harness') || workerIdFault(seat.harness) === null)
  && (!Object.hasOwn(seat, 'model') || validModelId(seat.model))
  && (!Object.hasOwn(seat, 'channel') || seat.channel === 'observed' || seat.channel === 'claim');

type Sameness = 'warn' | 'refuse';

function normalizeModel(m: unknown): string {
  if (typeof m !== 'string') return '';
  return m.normalize('NFKC').trim().toLowerCase();
}

function stripTrailingQualifier(s: string): string {
  return s.replace(/\s*(\([^)]*\)|\[[^\]]*\]|#[^\s]*)$/, '').trim();
}

/**
 * The reviewer-independence facts of a record whose shape is already checked (119 L-C2, 120 IC-015).
 * - Author facts: INV-1 `independence:<seat>` always an error (the seat's agent is the author's, or both sessions are non-null and equal);
 *   `same-family:<seat>` an error under `refuse`, an advisory under `warn`; `family-unverified:<seat>` an advisory.
 * - INV-8 facts: compared against `authors` whose kind matches `INV-8.authorKinds` (outcome ii: subagent, sequential).
 */
function identityFacts(data: any, sameFamily: Sameness, authors: any[] = []): { errors: string[]; advisories: string[] } {
  const facts = { errors: [] as string[], advisories: [] as string[] };
  if (!Array.isArray(data.seats)) return facts;

  // 1. Author facts (INV-1, same-family, family-unverified)
  if (Object.hasOwn(data, 'author') && validAuthor(data.author)) {
    const { author } = data;
    for (const seat of data.seats) {
      if (!object(seat) || !nonempty(seat.id) || !validSeatIdentity(seat)) continue;
      if (seat.agent === author.agent || (seat.session != null && author.session != null && seat.session === author.session)) {
        facts.errors.push(`independence:${seat.id}`);
      }
      if (seat.family === undefined || seat.family === 'unknown' || author.family === 'unknown') {
        facts.advisories.push(`family-unverified:${seat.id}`);
      } else if (seat.family === author.family) {
        (sameFamily === 'refuse' ? facts.errors : facts.advisories).push(`same-family:${seat.id}`);
      }
    }
  }

  // 2. INV-8 facts (IC-015 comparison table)
  const has120Data = (Array.isArray(authors) && authors.length > 0)
    || (Object.hasOwn(data, 'author') && (Boolean(data.author?.harness) || Boolean(data.author?.model)))
    || data.seats.some((s: any) => object(s) && (Boolean(s.harness) || Boolean(s.model)));

  const proto = protocols();
  const inv8 = proto?.invariants?.find((inv: any) => inv.id === 'INV-8');
  const authorKinds: string[] = Array.isArray(inv8?.authorKinds) ? inv8.authorKinds : ['subagent', 'sequential'];

  const relevantAuthors = (Array.isArray(authors) ? authors : []).filter(
    (a: any) => object(a) && authorKinds.includes(a.kind)
  );

  for (const seat of data.seats) {
    if (!object(seat) || !nonempty(seat.id) || !validSeatIdentity(seat)) continue;

    const seatHasHarness = typeof seat.harness === 'string' && seat.harness.length > 0;
    const seatHasModel = typeof seat.model === 'string' && seat.model.length > 0;

    if (!seatHasHarness && !seatHasModel) {
      if (has120Data) {
        facts.advisories.push(`seat-identity-missing:${seat.id}`);
      }
      continue;
    }

    if (!seatHasHarness) continue;

    for (const author of relevantAuthors) {
      if (author.harness !== seat.harness) continue;

      const normSeat = normalizeModel(seat.model);
      const normAuthor = normalizeModel(author.model);

      if (normSeat.length > 0 && normSeat !== 'unknown' && normAuthor !== 'unknown' && normSeat === normAuthor) {
        facts.errors.push(`independence-model:${seat.id}`);
      } else if (
        normSeat.length > 0 &&
        normAuthor.length > 0 &&
        normSeat !== 'unknown' &&
        normAuthor !== 'unknown' &&
        stripTrailingQualifier(normSeat).length > 0 &&
        stripTrailingQualifier(normSeat) === stripTrailingQualifier(normAuthor)
      ) {
        facts.advisories.push(`independence-unverified:${seat.id}`);
      } else {
        const seatObserved = seat.channel === 'observed';
        const authorObserved = author.channel === 'observed';
        const seatKnown = normSeat.length > 0 && normSeat !== 'unknown';
        const authorKnown = normAuthor.length > 0 && normAuthor !== 'unknown';

        if (seatObserved && authorObserved && seatKnown && authorKnown) {
          // independent, nothing reported
        } else {
          facts.advisories.push(`independence-unverified:${seat.id}`);
        }
      }
    }
  }

  facts.errors = [...new Set(facts.errors)];
  facts.advisories = [...new Set(facts.advisories)].filter(
    (adv) => !facts.errors.some((err) => err === `independence-model:${adv.split(':')[1]}`)
  );

  return facts;
}

/** Schema checks only. Git ancestry and register-channel backing are separate facts.
 * `sameFamily` (`warn` by default) is the project's `review.sameFamily`: under `refuse` a same-family seat is an error.
 * `preset` (`auto` by default) is the effective `review.preset`: when it is not `auto` a record without `protocol`
 * is an error (`protocol-missing`) and its rounds and seats are held to that preset (C-2 closure). */
function validateFindings(
  json: any,
  { sameFamily = 'warn', preset = 'auto', authors = [], protocols: registry }: { sameFamily?: Sameness; preset?: string; authors?: any[]; protocols?: any } = {}
): { ok: boolean; errors: string[] } {
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
  const view = (): any => (registry === undefined ? protocols() : registry);
  const protocolFault = Object.hasOwn(data, 'protocol') ? protocolError(data.protocol, view()) : null;
  if (protocolFault) errors.push(protocolFault);
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
  // C-2: the record is held to its own preset, not only to its shape; a record that omits `protocol` is held to the
  // project's non-auto `review.preset` instead (omitting the field must not skip the check).
  const recorded = Object.hasOwn(data, 'protocol');
  if (!recorded && preset !== 'auto') errors.push('protocol-missing');
  const held = recorded ? (protocolFault === null ? data.protocol.id : null) : (preset !== 'auto' ? preset : null);
  if (held && Array.isArray(data.seats) && reviewPresets(view())?.includes(held)) {
    const heldPreset = view().presets[held];
    if (Number.isSafeInteger(data.rounds) && data.rounds >= 1 && data.rounds < heldPreset.rounds.min) errors.push('protocol-rounds');
    if (data.seats.length < heldPreset.seats.length) errors.push('protocol-seats');
  }
  for (const error of identityFacts(data, sameFamily === 'refuse' ? 'refuse' : 'warn', authors).errors) errors.push(error);
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
function reviewAdvisories(json: any, { sameFamily = 'warn', authors = [] }: { sameFamily?: Sameness; authors?: any[] } = {}): string[] {
  const option = { sameFamily: sameFamily === 'refuse' ? 'refuse' : 'warn', authors } as { sameFamily: Sameness; authors: any[] };
  if (!validateFindings(json, option).ok) return [];
  const data = parsed(json);
  const advisories: string[] = identityFacts(data, option.sameFamily, option.authors).advisories;
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
  object, nonempty, strings, validPath, evidenceLocator, validateFindings, countFindings, reviewAdvisories, protocolLooserThanPreset, invalidProjectCandidate, invalidPresetCandidate, telemetryProtocol,
};
