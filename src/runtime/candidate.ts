'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const { measureFreshness } = require('./freshness.ts');
const { measureTreeState, sourceVersionFor } = require('./source-version.ts');
const { VALID_EVIDENCE_KINDS, VALID_PROVENANCE } = require('./evidence-ledger.ts');
const { resolveLocator, describeResolution } = require('./locator-resolve.ts');
const { assertNoScoreFields } = require('./evidence-fields.ts');

interface Candidate {
  locator?: any;
  provider?: string;
  capability?: string;
  need?: string;
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
const EVIDENCE_ITEM_FIELDS = ['kind', 'provenance', 'source', 'locator', 'content', 'taskId', 'establishes', 'observation', 'need'];
const EVIDENCE_SOURCE_FIELDS = ['provider', 'capability'];
const EVIDENCE_LOCATOR_FIELDS = ['file', 'line', 'symbol', 'uri'];
const EVIDENCE_OBSERVATION_FIELDS = ['command', 'exitCode'];

/** Kinds that record an execution and may carry a typed observation. */
const OBSERVATION_KINDS = new Set(['test-result', 'runtime-observation']);

/** Kinds that are by definition not a direct read of the repository. FR-007's second sentence. */
const NON_REPOSITORY_KINDS = new Set(['generated-analysis', 'user-statement']);

/** Fields a caller might plausibly send that this boundary refuses by name, with the reason.
 *  A named refusal beats the generic unknown-field error: each of these would otherwise be
 *  silently discarded by `addEvidence`, and a silent discard reads as a successful write. */
const EVIDENCE_REFUSED_FIELDS = new Map([
  ['id', 'evidence ids are minted by the ledger — a caller-chosen id can overwrite an unrelated record'],
  ['freshness', 'freshness is measured here from the working tree at write time, never asserted by the writer'],
  ['supports', 'link evidence to a claim with `claim --action link`, which updates both sides; a list written here would leave the claim unaware of it'],
  ['contradicts', 'link evidence to a claim with `claim --action link`, which updates both sides; a list written here would leave the claim unaware of it'],
  ['stage', 'the evidence record has no stage field — the batch *is* the stage boundary, so a stage name recorded here would be dropped'],
  ['status', "lifecycle status starts 'active' and changes only through `evidence --action supersede` — asserting it here would let a caller declare an item superseded without naming what replaces it"],
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
 * @param {string} [repoRoot] root a relative locator resolves against; defaults to cwd
 * @returns {{kind:string, provenance:string, source:Object, locator:Object, content:(string|null)}}
 */
function validateEvidenceItem(raw: any, taskId: any, repoRoot: any) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('an evidence item must be a JSON object');
  assertNoScoreFields(raw, '');

  for (const key of Object.keys(raw)) {
    if (EVIDENCE_REFUSED_FIELDS.has(key)) throw new Error(`'${key}' is not accepted here: ${EVIDENCE_REFUSED_FIELDS.get(key)}`);
    if (!EVIDENCE_ITEM_FIELDS.includes(key)) {
      throw new Error(`unknown evidence field '${key}'. Accepted: ${EVIDENCE_ITEM_FIELDS.join(', ')}`);
    }
  }

  if (raw.taskId !== undefined && raw.taskId !== taskId) {
    throw new Error(`item names task '${raw.taskId}' but this write targets '${taskId}' — one write, one task`);
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
  for (const key of Object.keys(raw.source)) {
    if (!EVIDENCE_SOURCE_FIELDS.includes(key)) {
      throw new Error(`unknown source field '${key}'. Accepted: ${EVIDENCE_SOURCE_FIELDS.join(', ')}`);
    }
  }
  for (const key of EVIDENCE_SOURCE_FIELDS) {
    if (typeof raw.source[key] !== 'string' || raw.source[key].trim() === '') {
      throw new Error(`source.${key} is required and must be a non-empty string`);
    }
  }

  const locator = raw.locator === undefined ? null : parseLocator(raw.locator);
  // An item carrying an observation is anchored by the command it records — that command is what
  // the next worker re-runs to check it — so the locator becomes optional there and only there.
  if (raw.provenance === 'extracted' && !locator && raw.observation === undefined) {
    throw new Error("provenance 'extracted' requires a locator — a fact read from the repository "
      + 'must name where it was read, or the next worker cannot check it and cannot tell when it goes stale');
  }

  // A locator that parses is not a locator that resolves (FR-004). Shape validation alone let an
  // item naming line 799 of a 28-line file be recorded as support and counted by the readiness
  // gate. The refusal names what the file actually offers, so the writer can correct it here rather
  // than discover it at the gate.
  if (raw.provenance === 'extracted' && locator) {
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

  return {
    kind: raw.kind,
    provenance: raw.provenance,
    source: { provider: raw.source.provider, capability: raw.source.capability },
    locator: locator || {},
    content,
    establishes,
    observation,
    ...(raw.need !== undefined ? { need: raw.need } : {}),
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

  const validated = validateEvidenceItem(rawItem, taskId, root);
  const sv = sourceVersionFor(root, validated.locator, treeState);

  const source: Record<string, any> = { ...validated.source };
  if (ctx.attemptRef) {
    source.attemptRef = ctx.attemptRef;
  }

  return {
    ...validated,
    taskId,
    source,
    freshness: {
      ...measureFreshness(root, validated.locator, sv.gitCommit),
      isDirty: sv.isDirty,
    },
  };
}

module.exports = {
  CANDIDATE_FIELDS,
  toEvidence,
  parseLocator,
  validateEvidenceItem,
  EVIDENCE_REFUSED_FIELDS,
};
