'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const { measureFreshness } = require('./freshness.ts');
const { measureTreeState, sourceVersionFor } = require('./source-version.ts');
const { VALID_EVIDENCE_KINDS, VALID_PROVENANCE } = require('./evidence-ledger.ts');
const { resolveLocator, describeResolution } = require('./locator-resolve.ts');
const { assertNoScoreFields } = require('./evidence-fields.ts');
const { readPlan, resolveNeed, activeAttemptRef, declaredIntentList } = require('./retrieval-record.ts');
const { freshnessEntry, sourceModeLookup } = require('./retrieval-plan.ts');
const { CapabilityRouter } = require('./capability-router.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');

function getSourceModeOf(ctx?: any): (providerId: string) => string | null {
  if (ctx?.sourceModeOf) return ctx.sourceModeOf;
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT });
  return sourceModeLookup(router.capabilities);
}

function getProviderFreshness(provider: string, root: string, ctx?: any): any {
  const cache = ctx?.providerFreshness;
  if (cache && cache.has(provider)) {
    return cache.get(provider);
  }
  const sourceModeOf = getSourceModeOf(ctx);
  const entry = freshnessEntry(provider, root, sourceModeOf);
  if (cache) {
    cache.set(provider, entry);
  }
  return entry;
}

interface Candidate {
  locator?: any;
  provider?: string;
  capability?: string;
  need?: string;
  absence?: boolean;
  sourceVersion?: {
    gitCommit?: string | null;
    fileHash?: string | null;
    isDirty?: boolean | null;
  } | null;
  rank?: number;
  score?: number;
}

interface BuildContext {
  taskId: string;
  root?: string;
  kind?: string;
  provenance?: string;
  content?: string | null;
  establishes?: string[] | string;
  absence?: boolean;
  plan?: any;
  treeState?: any;
  attemptRef?: string;
  slug?: string | null;
  providerFreshness?: Map<string, any>;
  sourceModeOf?: (providerId: string) => string | null;
}

const CANDIDATE_FIELDS: readonly string[] = [
  'locator',
  'provider',
  'capability',
  'need',
  'sourceVersion',
  'rank',
  'score',
];

/** Every field an evidence item may carry here. Anything else is refused, never dropped. */
const EVIDENCE_ITEM_FIELDS = ['kind', 'provenance', 'source', 'locator', 'content', 'taskId', 'establishes', 'observation', 'need', 'absence'];
const EVIDENCE_SOURCE_FIELDS = ['provider', 'capability'];
const EVIDENCE_LOCATOR_FIELDS = ['file', 'line', 'symbol', 'uri'];
const EVIDENCE_OBSERVATION_FIELDS = ['command', 'exitCode'];

/** Kinds that record an execution and may carry a typed observation. */
const OBSERVATION_KINDS = new Set(['test-result', 'runtime-observation']);

/** Kinds that are by definition not a direct read of the repository. FR-007's second sentence. */
const NON_REPOSITORY_KINDS = new Set(['generated-analysis', 'user-statement']);

function queryRefRefusal(taskId: string, repoRoot: string, slug: string | null = null): string {
  const plan = readPlan(repoRoot, taskId, slug);
  const list = declaredIntentList(plan);
  return `the runtime stamps it from the need. Re-run with --need <intent> (in a batch, "need": "<intent>"). Declared intents for task '${taskId}': ${list}.`;
}

/** Fields a caller might plausibly send that this boundary refuses by name, with the reason.
 *  A named refusal beats the generic unknown-field error: each of these would otherwise be
 *  silently discarded by `addEvidence`, and a silent discard reads as a successful write. */
const EVIDENCE_REFUSED_FIELDS = new Map<string, string | ((taskId: string, repoRoot: string, slug?: string | null) => string)>([
  ['id', 'evidence ids are minted by the ledger — a caller-chosen id can overwrite an unrelated record'],
  ['freshness', 'freshness is measured here from the working tree at write time, never asserted by the writer'],
  ['supports', 'link evidence to a claim with `claim --action link`, which updates both sides; a list written here would leave the claim unaware of it'],
  ['contradicts', 'link evidence to a claim with `claim --action link`, which updates both sides; a list written here would leave the claim unaware of it'],
  ['stage', 'the evidence record has no stage field — the batch *is* the stage boundary, so a stage name recorded here would be dropped'],
  ['status', "lifecycle status starts 'active' and changes only through `evidence --action supersede` — asserting it here would let a caller declare an item superseded without naming what replaces it"],
  ['queryRef', queryRefRefusal],
  ['attemptRef', (taskId: string) => `it is read from the active task attempt. Claim the task with doflow task-attempt --action claim --task ${taskId}, then re-run without attemptRef.`],
  ['result', 'an empty answer is recorded with --absence --need <intent> (in a batch, "absence": true), which also measures the index freshness.'],
]);

const EVIDENCE_REFUSED_SOURCE_FIELDS = new Map<string, string | ((taskId: string, repoRoot: string, slug?: string | null) => string)>([
  ['queryRef', queryRefRefusal],
  ['attemptRef', (taskId: string) => `it is read from the active task attempt. Claim the task with doflow task-attempt --action claim --task ${taskId}, then re-run without attemptRef.`],
]);

/**
 * Normalises a locator given either as an object or as a `file[:line]` / URI string.
 * @param {Object|string} raw
 * @returns {Object}
 */
function parseLocator(raw: any) {
  if (typeof raw === 'string') {
    const text = raw.trim();
    if (text === '') throw new Error('locator is empty');
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { uri: text };
    const withLine = text.match(/^(.+):(\d+)$/);
    if (withLine) return { file: withLine[1], line: Number(withLine[2]) };
    return { file: text };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error("locator must be an object, or a 'path/to/file[:line]' or URI string");
  }
  const locator: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!EVIDENCE_LOCATOR_FIELDS.includes(key)) {
      throw new Error(`unknown locator field '${key}'. Accepted: ${EVIDENCE_LOCATOR_FIELDS.join(', ')}`);
    }
    locator[key] = value;
  }
  if (locator.line !== undefined && (!Number.isInteger(locator.line) || locator.line < 1)) {
    throw new Error(`locator.line must be a positive integer, got '${locator.line}'`);
  }
  for (const key of ['file', 'symbol', 'uri']) {
    if (locator[key] !== undefined && (typeof locator[key] !== 'string' || locator[key].trim() === '')) {
      throw new Error(`locator.${key} must be a non-empty string`);
    }
  }
  if (!locator.file && !locator.uri) throw new Error('a locator needs at least a file or a uri');
  return locator;
}

/**
 * Validates one raw evidence item and returns the record fields the ledger will store.
 *
 * Throws on anything it cannot account for. Every rule here traces to FR-007 or to the
 * vacuous-record family: a record with no statement and no locator asserts nothing, and storing it
 * inflates the evidence count that the readiness gate then reads.
 *
 * @param {Object} raw
 * @param {string} taskId the task the batch is being written to
 * @param {string} taskId the task the batch is being written to
 * @param {string} repoRoot root a relative locator resolves against
 * @param {string|null} [slug] feature slug
 * @returns {{kind:string, provenance:string, source:Object, locator:Object, content:(string|null)}}
 */
function validateEvidenceItem(raw: any, taskId: any, repoRoot: any, slug: any = null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('an evidence item must be a JSON object');
  assertNoScoreFields(raw, '');

  for (const key of Object.keys(raw)) {
    if (EVIDENCE_REFUSED_FIELDS.has(key)) {
      const val = EVIDENCE_REFUSED_FIELDS.get(key);
      const reason = typeof val === 'function' ? val(taskId, repoRoot, slug) : val;
      throw new Error(`'${key}' is not accepted here: ${reason}`);
    }
    if (!EVIDENCE_ITEM_FIELDS.includes(key)) {
      throw new Error(`unknown evidence field '${key}'. Accepted: ${EVIDENCE_ITEM_FIELDS.join(', ')}`);
    }
  }

  if (raw.taskId !== undefined && raw.taskId !== taskId) {
    throw new Error(`item names task '${raw.taskId}' but this write targets '${taskId}' — one write, one task`);
  }

  const isAbsence = Boolean(raw.absence);
  if (isAbsence) {
    if (raw.need === undefined || raw.need === null || raw.need === '') {
      const plan = readPlan(repoRoot, taskId, slug);
      const list = declaredIntentList(plan);
      throw new Error(`--absence needs --need <intent>: an empty answer means nothing without the query it answered. Declared intents for task '${taskId}': ${list}.`);
    }
    if (raw.locator !== undefined && raw.locator !== null) {
      throw new Error('an absence record carries no locator: it states that the provider found nothing. Drop --locator, or record what was found as an ordinary item with --need <intent>.');
    }
    if (raw.provenance !== 'extracted') {
      throw new Error("an absence record must be 'extracted': it is the provider's answer as you read it. Re-run with --provenance extracted.");
    }
    if (raw.observation !== undefined && raw.observation !== null) {
      throw new Error('an absence record carries no observation: it records a lookup, not an execution. Drop the observation.');
    }
  }

  const kinds = [...VALID_EVIDENCE_KINDS].sort().join(', ');
  if (typeof raw.kind !== 'string' || raw.kind.trim() === '') throw new Error(`kind is required. Valid: ${kinds}`);
  if (!VALID_EVIDENCE_KINDS.has(raw.kind)) throw new Error(`unknown evidence kind '${raw.kind}'. Valid: ${kinds}`);

  const provenances = [...VALID_PROVENANCE].sort().join(', ');
  if (typeof raw.provenance !== 'string' || raw.provenance.trim() === '') {
    throw new Error('provenance is required and has no default here — defaulting it would file model '
      + `analysis as repository fact, the one distinction FR-007 makes binding. Valid: ${provenances}`);
  }
  if (!VALID_PROVENANCE.has(raw.provenance)) throw new Error(`unknown provenance '${raw.provenance}'. Valid: ${provenances}`);
  if (NON_REPOSITORY_KINDS.has(raw.kind) && raw.provenance === 'extracted') {
    throw new Error(`kind '${raw.kind}' cannot carry provenance 'extracted': it is not a read of the `
      + "repository, and labelling it as one is exactly how model analysis stops being distinguishable "
      + "from fact. Use 'inferred' (derived by analysis) or 'asserted' (stated by a person).");
  }

  if (raw.source === undefined) {
    throw new Error('source is required: which provider answered, under which capability. '
      + "It has no default — 'unknown/general' is a plausible-looking answer to a question nobody asked.");
  }
  if (!raw.source || typeof raw.source !== 'object' || Array.isArray(raw.source)) {
    throw new Error('source must be an object with provider and capability');
  }
  assertNoScoreFields(raw.source, 'source');
  for (const key of Object.keys(raw.source)) {
    if (EVIDENCE_REFUSED_SOURCE_FIELDS.has(key)) {
      const val = EVIDENCE_REFUSED_SOURCE_FIELDS.get(key);
      const reason = typeof val === 'function' ? val(taskId, repoRoot, slug) : val;
      throw new Error(`'${key}' is not accepted here: ${reason}`);
    }
    if (!EVIDENCE_SOURCE_FIELDS.includes(key)) {
      throw new Error(`unknown source field '${key}'. Accepted: ${EVIDENCE_SOURCE_FIELDS.join(', ')}`);
    }
  }
  for (const key of EVIDENCE_SOURCE_FIELDS) {
    if (typeof raw.source[key] !== 'string' || raw.source[key].trim() === '') {
      throw new Error(`source.${key} is required and must be a non-empty string`);
    }
  }

  const locator = (isAbsence || raw.locator === undefined) ? null : parseLocator(raw.locator);
  // An item carrying an observation is anchored by the command it records — that command is what
  // the next worker re-runs to check it — so the locator becomes optional there and only there.
  if (!isAbsence && raw.provenance === 'extracted' && !locator && raw.observation === undefined) {
    throw new Error("provenance 'extracted' requires a locator — a fact read from the repository "
      + 'must name where it was read, or the next worker cannot check it and cannot tell when it goes stale');
  }

  // A locator that parses is not a locator that resolves (FR-004). Shape validation alone let an
  // item naming line 799 of a 28-line file be recorded as support and counted by the readiness
  // gate. The refusal names what the file actually offers, so the writer can correct it here rather
  // than discover it at the gate.
  if (!isAbsence && raw.provenance === 'extracted' && locator) {
    const resolution = resolveLocator({ locator, repoRoot });
    if (!resolution.resolved) {
      throw new Error(`the locator does not resolve: ${describeResolution(locator, resolution)}. `
        + "An 'extracted' item asserts a read of the repository, so a locator that points at nothing "
        + 'records a fact nobody can check');
    }
  }

  if (raw.content !== undefined && typeof raw.content !== 'string') throw new Error('content must be a string');
  const content = typeof raw.content === 'string' && raw.content.trim() !== '' ? raw.content : null;
  if (raw.provenance !== 'extracted' && !content) {
    throw new Error(`provenance '${raw.provenance}' requires content — an inferred or asserted item `
      + 'is the statement itself, so a record without one records nothing while still counting as evidence');
  }

  // Requirement bindings: which readiness-template requirements this item claims to establish.
  // Declared by the writer, judged by the gate — the gate counts an item toward a requirement only
  // when it is named here, so a structural item can no longer satisfy `architecture_mapped` and
  // `blast_radius` at once by category alone (review R1).
  let establishes = [];
  if (raw.establishes !== undefined) {
    const list = typeof raw.establishes === 'string' ? raw.establishes.split(',').map((s: any) => s.trim()) : raw.establishes;
    if (!Array.isArray(list) || list.length === 0 || list.some((r) => typeof r !== 'string' || r.trim() === '')) {
      throw new Error("'establishes' must be a requirement id, a comma-separated list of them, or a non-empty array of non-empty strings");
    }
    establishes = list.map((s) => s.trim());
  }

  // Typed observation: the execution behind a test-result or runtime-observation. Command and exit
  // status are the two facts the gate can actually grade; tree identity and observation time are
  // measured into freshness at this same write. Only an 'extracted' item may carry one — an
  // observation asserts an execution happened, and an inferred item is by definition not one.
  let observation = null;
  if (raw.observation !== undefined) {
    if (!raw.observation || typeof raw.observation !== 'object' || Array.isArray(raw.observation)) {
      throw new Error('observation must be an object with command and exitCode');
    }
    for (const key of Object.keys(raw.observation)) {
      if (!EVIDENCE_OBSERVATION_FIELDS.includes(key)) {
        throw new Error(`unknown observation field '${key}'. Accepted: ${EVIDENCE_OBSERVATION_FIELDS.join(', ')}`);
      }
    }
    if (typeof raw.observation.command !== 'string' || raw.observation.command.trim() === '') {
      throw new Error('observation.command is required: the exact command whose exit status is being recorded');
    }
    if (!Number.isInteger(raw.observation.exitCode) || raw.observation.exitCode < 0) {
      throw new Error(`observation.exitCode must be a non-negative integer, got '${raw.observation.exitCode}'`);
    }
    if (!OBSERVATION_KINDS.has(raw.kind)) {
      throw new Error(`kind '${raw.kind}' cannot carry an observation — only ${[...OBSERVATION_KINDS].join(', ')} record an execution`);
    }
    if (raw.provenance !== 'extracted') {
      throw new Error(`provenance '${raw.provenance}' cannot carry an observation: an observation asserts a command `
        + 'was actually run, which is a read of the world, not an inference or an assertion. '
        + "Either record the execution as 'extracted', or drop the observation.");
    }
    observation = { command: raw.observation.command.trim(), exitCode: raw.observation.exitCode };
  }
  if (raw.kind === 'test-result' && raw.provenance === 'extracted' && !observation) {
    throw new Error("an 'extracted' test-result requires an observation ({command, exitCode}) — a test result "
      + 'without the command and exit status behind it is a claim about an execution nobody can check, '
      + 'and it is exactly how a failed baseline was once accepted as a passing one');
  }

  let needIntent: string | null = null;
  if (raw.need !== undefined) {
    const list = Array.isArray(raw.need) ? raw.need : [raw.need];
    const intents: string[] = [];
    for (const entry of list) {
      if (typeof entry !== 'string') {
        throw new Error('need must be an intent string');
      }
      for (const token of entry.split(',')) {
        const trimmed = token.trim();
        if (trimmed !== '') intents.push(trimmed);
      }
    }
    if (intents.length !== 1) {
      throw new Error(`--need takes one intent on evidence --action add, got ${intents.length}. Record one write per need.`);
    }
    needIntent = intents[0];
  }

  return {
    kind: raw.kind,
    provenance: raw.provenance,
    source: { provider: raw.source.provider, capability: raw.source.capability },
    locator: isAbsence ? {} : (locator || {}),
    content,
    establishes,
    observation,
    ...(needIntent !== null ? { need: needIntent } : {}),
    ...(isAbsence ? { absence: true, result: 'EMPTY' } : {}),
  };
}

function shortHash(hash: string | null | undefined): string {
  if (!hash) return 'absent';
  const clean = hash.startsWith('sha256:') ? hash.slice('sha256:'.length) : hash;
  return clean.slice(0, 7);
}

function toEvidence(
  input: { candidate?: Candidate; item?: any },
  ctx: BuildContext
): any {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error("input must be an object with 'candidate' or 'item'");
  }
  if (!ctx || typeof ctx !== 'object') {
    throw new Error('ctx must be an object');
  }
  if (!ctx.taskId || typeof ctx.taskId !== 'string' || ctx.taskId.trim() === '') {
    throw new Error('taskId is required');
  }

  const taskId = ctx.taskId;
  const root = ctx.root || process.cwd();
  const treeState = ctx.treeState || measureTreeState(root);

  let rawItem: any;

  if ('candidate' in input && input.candidate !== undefined) {
    const candidate = input.candidate;
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('candidate must be an object');
    }

    for (const key of Object.keys(candidate)) {
      if (!CANDIDATE_FIELDS.includes(key)) {
        throw new Error(
          `unknown candidate field '${key}'. Accepted: ${CANDIDATE_FIELDS.join(', ')}`
        );
      }
    }

    if (
      candidate.sourceVersion &&
      candidate.sourceVersion.fileHash !== null &&
      candidate.sourceVersion.fileHash !== undefined
    ) {
      let loc = candidate.locator;
      if (typeof loc === 'string') {
        loc = parseLocator(loc);
      }
      const sv = sourceVersionFor(root, loc, treeState);
      const measuredHash = sv.fileHash;
      const searchedHash = candidate.sourceVersion.fileHash;
      if (searchedHash !== measuredHash) {
        const file = loc?.file || 'unknown';
        throw new Error(
          `the file changed between the search and this record (${file}: searched ${shortHash(searchedHash)}, now ${shortHash(measuredHash)}). Re-run the search and record the new result.`
        );
      }
    }

    const source: Record<string, any> = {};
    if (candidate.provider !== undefined) source.provider = candidate.provider;
    if (candidate.capability !== undefined) source.capability = candidate.capability;

    rawItem = {
      kind: ctx.kind,
      provenance: ctx.provenance,
      source,
      locator: candidate.locator,
      content: ctx.content,
      establishes: ctx.establishes,
    };
    if (candidate.need !== undefined) {
      rawItem.need = candidate.need;
    }
  } else if ('item' in input && input.item !== undefined) {
    rawItem = input.item;
  } else {
    throw new Error("toEvidence requires either 'candidate' or 'item'");
  }

  const validated = validateEvidenceItem(rawItem, taskId, root, ctx.slug);
  const sv = sourceVersionFor(root, validated.locator, treeState);

  const source: Record<string, any> = { ...validated.source };

  if (validated.need) {
    const plan = ctx.plan !== undefined ? ctx.plan : readPlan(root, taskId, ctx.slug);
    const resolved = resolveNeed(plan, validated.need, taskId);
    if (!resolved.ok) {
      throw new Error(resolved.message);
    }
    source.queryRef = resolved.queryRef;
    delete validated.need;
  }

  const attemptRef = ctx.attemptRef !== undefined
    ? ctx.attemptRef
    : activeAttemptRef(root, taskId, ctx.slug);
  if (attemptRef) {
    source.attemptRef = attemptRef;
  }

  let freshness: any;
  if (validated.absence) {
    delete validated.absence;
    const probe = getProviderFreshness(source.provider, root, ctx);
    let status = 'UNKNOWN';
    if (probe?.state === 'FRESH' || probe?.state === 'NOT_APPLICABLE') {
      status = 'FRESH';
    } else if (probe?.state === 'STALE') {
      status = 'STALE';
    }

    if (!treeState || treeState.gitCommit === null) {
      status = 'UNKNOWN';
    }

    freshness = {
      gitCommit: treeState ? treeState.gitCommit : null,
      fileHash: null,
      isDirty: null,
      observedAt: new Date().toISOString(),
      status,
    };
    if (treeState && treeState.gitCommit !== null && treeState.fingerprint) {
      freshness.treeFingerprint = treeState.fingerprint;
    }
  } else {
    freshness = {
      ...measureFreshness(root, validated.locator, sv.gitCommit),
      isDirty: sv.isDirty,
    };
  }

  return {
    ...validated,
    taskId,
    source,
    freshness,
  };
}

module.exports = {
  CANDIDATE_FIELDS,
  toEvidence,
  parseLocator,
  validateEvidenceItem,
  EVIDENCE_REFUSED_FIELDS,
  EVIDENCE_REFUSED_SOURCE_FIELDS,
};
