'use strict';

// Emission authority (078 IC-001 decision half, IC-002). Run directly by Node native type-stripping.
//
// The IC-002 rule table is data (DEC-005): `arbitrate()` reads it and nothing else, with no I/O, no
// clock and no environment, so two callers holding the same request reach the same decision
// (NFR-003). The compiled hook table (IC-003) is generated from EMISSION_RULES, and the hook's
// `emission.jq` must reproduce renderEmission() byte for byte over
// test/fixtures/emission/render-corpus.json (IC-022). Characters are counted as code points with
// Array.from(), never UTF-16 units (design R1); budgets are UTF-8 bytes.

// The IC-007 reader whose SessionIdentity a request carries. In-process callers (emitContext(),
// the launcher) resolve identity with it before they arbitrate; arbitrate() itself only reads the
// resolved `role` and `lineageKind`.
const { resolveIdentity } = require('./identity.ts');

type EmissionEvent = 'launch' | 'prompt' | 'delta' | 'legacy-adopt' | 'compact-store' | 'compact-meta' | 'compact-instructions';
type Segment = 'slot' | 'git' | 'summary' | 'warning' | 'grant' | 'nudge' | 'legacy' | 'pack' | 'meta' | 'instructions';
type Action = 'skip' | 'include' | 'truncate' | 'whole' | 'pointer' | 'claim' | 'adopt' | 'write';
type SegmentClass = 'n/a' | 'optional' | 'mandatory' | 'per-item';
type Claim = 'slot' | 'summary' | 'grant' | 'warning' | 'legacy';
type InputName = 'role' | 'lineageKind' | 'bootstrapped' | 'subagent' | 'ownSummary' | 'legacy' | 'grant' | 'refusedSeen' | 'warning' | 'nudge';

/** The fields of an IC-007 SessionIdentity (resolveIdentity()) that the rules read. */
interface ArbitrationIdentity {
  role: 'main' | 'worker';
  lineageKind: 'default-main' | 'launched' | 'solo';
  [field: string]: unknown;
}

interface EmissionState {
  bootstrapped: boolean;
  subagent: boolean;
  ownSummary: 'none' | 'pending' | 'own-write';
  legacy: boolean;
  grant: 'none' | 'fits' | 'over';
  refusedSeen: boolean;
  warning: boolean;
  nudge: 'nudge' | 'suppress' | 'none';
}

interface EmissionRequest {
  event: EmissionEvent;
  identity: ArbitrationIdentity;
  state: EmissionState;
  budget: { maxBytes: number; source: 'env' | 'default' | 'flag' };
}

interface LedgerHint { kind: string; key: string; outcome: string }

interface EmissionDecision {
  emit: boolean;
  reason: string;
  actions: Partial<Record<Segment, Action>>;
  claims: Claim[];
  ledger: LedgerHint | null;
}

/** One arm: per input (vector order) the values it matches, or '*' for every value of the domain. */
interface RuleArm { when: Array<readonly string[] | '*'>; action: Action }
interface EmissionRule { event: EmissionEvent; segment: Segment; inputs: InputName[]; arms: RuleArm[]; class: SegmentClass }

/** Every input's finite domain, as the strings a vector carries. Booleans are 'false' and 'true'. */
const INPUT_DOMAINS: Readonly<Record<InputName, readonly string[]>> = Object.freeze({
  role: Object.freeze(['main', 'worker']),
  lineageKind: Object.freeze(['default-main', 'launched', 'solo']),
  bootstrapped: Object.freeze(['false', 'true']),
  subagent: Object.freeze(['false', 'true']),
  ownSummary: Object.freeze(['none', 'pending', 'own-write']),
  legacy: Object.freeze(['false', 'true']),
  grant: Object.freeze(['none', 'fits', 'over']),
  refusedSeen: Object.freeze(['false', 'true']),
  warning: Object.freeze(['false', 'true']),
  nudge: Object.freeze(['nudge', 'suppress', 'none']),
});

const EVENTS: readonly EmissionEvent[] = ['launch', 'prompt', 'delta', 'legacy-adopt', 'compact-store', 'compact-meta', 'compact-instructions'];

function rule(event: EmissionEvent, segment: Segment, inputs: InputName[], cls: SegmentClass, arms: RuleArm[]): EmissionRule {
  return { event, segment, inputs, arms, class: cls };
}

/** IC-002, row for row. Any combination no arm matches is `skip`. */
const EMISSION_RULES: readonly EmissionRule[] = deepFreeze([
  rule('prompt', 'slot', ['bootstrapped'], 'n/a', [
    { when: [['false']], action: 'claim' },
  ]),
  rule('prompt', 'git', ['role', 'bootstrapped'], 'optional', [
    { when: [['main'], ['false']], action: 'include' },
  ]),
  rule('prompt', 'summary', ['role', 'lineageKind', 'subagent', 'bootstrapped', 'ownSummary'], 'optional', [
    { when: [['main'], ['default-main', 'launched'], ['false'], ['false'], ['pending']], action: 'truncate' },
    { when: [['worker'], ['launched'], ['false'], ['false'], ['pending']], action: 'truncate' },
  ]),
  rule('prompt', 'warning', ['role', 'subagent', 'bootstrapped', 'warning'], 'optional', [
    { when: [['main'], ['false'], ['false'], ['true']], action: 'include' },
  ]),
  rule('prompt', 'grant', ['subagent', 'grant', 'refusedSeen'], 'mandatory', [
    { when: [['false'], ['fits'], '*'], action: 'whole' },
    { when: [['false'], ['over'], ['false']], action: 'pointer' },
  ]),
  rule('prompt', 'nudge', ['role', 'nudge'], 'optional', [
    { when: [['main'], ['nudge']], action: 'include' },
  ]),
  rule('legacy-adopt', 'legacy', ['role', 'lineageKind', 'subagent', 'bootstrapped', 'legacy'], 'n/a', [
    { when: [['main'], ['default-main'], ['false'], ['false'], ['true']], action: 'adopt' },
  ]),
  rule('launch', 'slot', ['bootstrapped'], 'n/a', [
    { when: [['false']], action: 'claim' },
  ]),
  rule('launch', 'pack', ['bootstrapped'], 'per-item', [
    { when: [['false']], action: 'include' },
  ]),
  rule('launch', 'summary', ['role', 'bootstrapped', 'ownSummary'], 'optional', [
    { when: [['main', 'worker'], ['false'], ['pending']], action: 'truncate' },
  ]),
  rule('launch', 'grant', ['grant', 'refusedSeen'], 'mandatory', [
    { when: [['fits'], '*'], action: 'whole' },
    { when: [['over'], ['false']], action: 'pointer' },
  ]),
  rule('delta', 'pack', ['bootstrapped'], 'per-item', [
    { when: [['true']], action: 'include' },
  ]),
  rule('compact-store', 'summary', ['role', 'lineageKind'], 'n/a', [
    { when: [['main'], ['default-main']], action: 'write' },
    { when: [['main', 'worker'], ['launched']], action: 'write' },
  ]),
  rule('compact-meta', 'meta', ['role', 'lineageKind'], 'n/a', [
    { when: [['main'], ['default-main']], action: 'write' },
  ]),
  rule('compact-instructions', 'instructions', ['role'], 'optional', [
    { when: [['main', 'worker']], action: 'include' },
  ]),
]);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as object)) deepFreeze(child);
  }
  return value;
}

/** The action a rule gives one vector (input values in the rule's own order). */
function ruleAction(r: EmissionRule, values: readonly string[]): Action {
  if (values.length !== r.inputs.length) throw new TypeError(`${r.event}.${r.segment}: expected ${r.inputs.length} input values`);
  for (const arm of r.arms) {
    if (arm.when.every((allowed, i) => allowed === '*' || allowed.includes(values[i]))) return arm.action;
  }
  return 'skip';
}

function inputValue(request: EmissionRequest, name: InputName): string {
  const raw = name === 'role' || name === 'lineageKind' ? request.identity[name] : request.state[name];
  const value = typeof raw === 'boolean' ? String(raw) : raw;
  if (typeof value !== 'string' || !INPUT_DOMAINS[name].includes(value)) {
    throw new TypeError(`arbitrate: ${name} must be one of ${INPUT_DOMAINS[name].join(', ')}`);
  }
  return value;
}

/** A rule's vector for a request: its input values in IC-002 vector order (IC-003 joins them with ':'). */
function ruleVector(r: EmissionRule, request: EmissionRequest): string[] {
  return r.inputs.map((name) => inputValue(request, name));
}

const TEXT_ACTIONS: readonly Action[] = ['include', 'truncate', 'whole', 'pointer'];
/** IC-004 claim order, with the legacy adoption (IC-004 step 4) ahead of the prompt claims. */
const CLAIM_ORDER: ReadonlyArray<[Claim, Action]> = [
  ['legacy', 'adopt'], ['slot', 'claim'], ['summary', 'truncate'], ['grant', 'whole'], ['warning', 'include'],
];
const REFUSED = 'refused:mandatory-over-budget';

/** IC-001: the decision for one request. Pure and total over the IC-002 domain; outside it, a TypeError. */
function arbitrate(request: EmissionRequest): EmissionDecision {
  if (!request || !EVENTS.includes(request.event)) throw new TypeError(`arbitrate: event must be one of ${EVENTS.join(', ')}`);
  if (!request.identity || !request.state) throw new TypeError('arbitrate: identity and state are required');

  const actions: Partial<Record<Segment, Action>> = {};
  const classes: Partial<Record<Segment, SegmentClass>> = {};
  for (const r of EMISSION_RULES) {
    if (r.event !== request.event) continue;
    actions[r.segment] = ruleAction(r, ruleVector(r, request));
    classes[r.segment] = r.class;
  }
  const claims = CLAIM_ORDER.filter(([segment, action]) => actions[segment] === action).map(([segment]) => segment);
  const pointed = Object.keys(actions).some((s) => actions[s as Segment] === 'pointer' && classes[s as Segment] === 'mandatory');
  const emit = Object.values(actions).some((a) => TEXT_ACTIONS.includes(a as Action));
  const acts = Object.values(actions).some((a) => a !== 'skip');
  const hasSlot = actions.slot !== undefined;

  let reason: string;
  if (pointed) reason = REFUSED;
  else if (emit) reason = 'emit';
  else if (acts) reason = 'act';
  else if (hasSlot && request.state.bootstrapped) reason = 'silent:already-bootstrapped';
  else reason = 'silent:unchanged';

  // The grant's summary id is not part of the finite vector; '@grant' names the grant the caller
  // measured, and the caller writes its summary_id as the ledger key (IC-015).
  const ledger = pointed ? { kind: 'grant', key: '@grant', outcome: REFUSED } : null;
  return { emit, reason, actions, claims, ledger };
}

// ── Renderer (IC-002 templates, join order and budget fill) ──────────────────────────────────

const SUMMARY_CAP = 4000;
const SUMMARY_READ = 65536;
const COMMIT_SEPARATOR = ' · ';
const JOIN_ORDER = ['git', 'summary', 'warning', 'grant', 'nudge'] as const;
const OPTIONAL_PRIORITY = ['git', 'summary', 'warning', 'nudge'] as const;
type RenderSegment = typeof JOIN_ORDER[number];

/**
 * Raw renderer inputs, the bytes the hook hands `emission.jq` through `--rawfile` and `--arg`.
 * `null` or absent means the file does not exist. `summaryBytes` is the claimed file's full size,
 * which says whether the bounded read saw all of it; it defaults to the UTF-8 size of `summary`.
 */
interface RenderInputs {
  git?: string | null;
  summary?: string | null;
  summaryBytes?: number;
  grant?: string | null;
  warning?: string | null;
  nudge?: string | null;
}

interface RenderRequest {
  actions: Partial<Record<Segment, Action>>;
  maxBytes: number;
  inputs: RenderInputs;
}

interface RenderResult {
  text: string | null;
  bytes: number;
  refused: boolean;
  dropped: RenderSegment[];
  segments: RenderSegment[];
}

/** UTF-8 bytes of a string, counted per code point. */
function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) as number;
    bytes += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
  }
  return bytes;
}

interface ParsedRecord { fields: Record<string, string>; body: string }

/**
 * A summary or grant record as today's prompt policy reads it: `\r` removed, trailing newlines
 * dropped, frontmatter keys from the lines between the first two `---` lines (first match wins,
 * `key:` then spaces stripped), body the lines after the second `---` from the first non-empty
 * line, trailing newlines dropped. A record with fewer than two `---` lines has an empty body.
 */
function parseRecord(raw: string): ParsedRecord {
  const lines = raw.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  const fields: Record<string, string> = Object.create(null);
  const body: string[] = [];
  let fences = 0;
  let started = false;
  for (const line of lines) {
    if (fences < 2 && line === '---') { fences += 1; continue; }
    if (fences === 1) {
      const colon = line.indexOf(':');
      if (colon > 0) {
        const key = line.slice(0, colon);
        if (!(key in fields)) fields[key] = line.slice(colon + 1).replace(/^ */, '');
      }
    } else if (fences >= 2 && (started || line !== '')) {
      started = true;
      body.push(line);
    }
  }
  return { fields, body: body.join('\n').replace(/\n+$/, '') };
}

/** A bracketed header value: `]` removed, then absent when empty or `unknown`. */
function known(value: string | undefined): string {
  const v = (value ?? '').replace(/\]/g, '');
  return v === 'unknown' ? '' : v;
}

function headerTail(fields: Record<string, string>): string {
  const at = known(fields.compacted_at);
  const branch = known(fields.branch);
  return `${at ? `, compacted ${at}` : ''}${branch ? ` on branch ${branch}` : ''}`;
}

/** `jq -r '<field> // empty'` in a `$(...)`: null and false are empty, strings lose trailing newlines. */
function jqField(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  return (typeof value === 'string' ? value : JSON.stringify(value)).replace(/\n+$/, '');
}

function renderGit(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return 'Git context unavailable for this session.';
  let capture: any;
  try { capture = JSON.parse(raw); } catch { capture = null; }
  if (!capture || typeof capture !== 'object' || Array.isArray(capture)) capture = {};
  if (jqField(capture.is_git_repo) !== 'true') return 'Not a git repository.';
  const commits = (Array.isArray(capture.commits) ? capture.commits : [])
    .map(jqField).filter((c: string) => c !== '').slice(0, 5).join(COMMIT_SEPARATOR);
  const stash = jqField(capture.stash_count);
  let text = `Git context — branch: ${jqField(capture.branch) || 'unknown'} | ${jqField(capture.sha) || 'unknown'}\n`
    + `Last commits: ${commits || 'none'}\n`
    + `Uncommitted files: ${jqField(capture.uncommitted_count) || '0'}`;
  if (/^[0-9]+$/.test(stash) && Number(stash) > 0) text += ` | Stashed: ${stash}`;
  return text;
}

function renderSummary(raw: string, size: number): string | null {
  const { fields, body } = parseRecord(raw);
  if (body === '') return null;
  const points = Array.from(body);
  let shown = body;
  if (points.length > SUMMARY_CAP) {
    const more = size > SUMMARY_READ ? 'at least ' : '';
    shown = `${points.slice(0, SUMMARY_CAP).join('')}\n[summary truncated: first ${SUMMARY_CAP} of ${more}${points.length} characters]`;
  }
  return `\n\n[Prior session summary${headerTail(fields)}]\n${shown}`;
}

function renderGrant(record: ParsedRecord): string {
  return `[Granted summary from lineage ${record.fields.from_lineage ?? ''}${headerTail(record.fields)}]\n${record.body}`;
}

function renderPointer(record: ParsedRecord, maxBytes: number): string {
  return `[Granted summary ${record.fields.summary_id ?? ''} withheld: ${utf8Bytes(record.body)} bytes exceed the ${maxBytes}-byte context budget]`;
}

/** IC-002 join: summary drops its leading blank line when nothing precedes it; grant and nudge gain one when something does. */
function joinSegments(pieces: Partial<Record<RenderSegment, string>>): string {
  let out = '';
  for (const segment of JOIN_ORDER) {
    const piece = pieces[segment];
    if (piece === undefined) continue;
    if (segment === 'summary') out += out === '' ? piece.slice(2) : piece;
    else if (segment === 'grant' || segment === 'nudge') out += (out === '' ? '' : '\n\n') + piece;
    else out += piece;
  }
  return out;
}

/**
 * IC-002: render the text segments a decision names, then fill the budget. Mandatory content (the
 * grant) is measured first and is never cut: when it alone exceeds `maxBytes` it becomes its
 * pointer and the render is refused. Optional segments are then added in priority order git,
 * summary, warning, nudge while the joined text stays within `maxBytes`; one that does not fit is
 * dropped whole and named. Only the prompt segments render here; `pack` is the context pack's own.
 */
function renderEmission(request: RenderRequest): RenderResult {
  const { actions, maxBytes, inputs } = request;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw new TypeError('renderEmission: maxBytes must be a positive integer');
  const optional: Partial<Record<RenderSegment, string>> = {};
  if (actions.git === 'include') optional.git = renderGit(inputs.git);
  if (actions.summary === 'truncate' && typeof inputs.summary === 'string') {
    const piece = renderSummary(inputs.summary, inputs.summaryBytes ?? utf8Bytes(inputs.summary));
    if (piece !== null) optional.summary = piece;
  }
  if (actions.warning === 'include' && typeof inputs.warning === 'string') {
    optional.warning = `\n[Prior session warning: ${inputs.warning.replace(/\n+$/, '')}]`;
  }
  if (actions.nudge === 'include' && typeof inputs.nudge === 'string' && inputs.nudge !== '') optional.nudge = inputs.nudge;

  const selected: Partial<Record<RenderSegment, string>> = {};
  let refused = false;
  if ((actions.grant === 'whole' || actions.grant === 'pointer') && typeof inputs.grant === 'string') {
    const record = parseRecord(inputs.grant);
    const whole = renderGrant(record);
    if (actions.grant === 'whole' && utf8Bytes(whole) <= maxBytes) {
      selected.grant = whole;
    } else {
      selected.grant = renderPointer(record, maxBytes);
      refused = true;
    }
  }

  const dropped: RenderSegment[] = [];
  for (const segment of OPTIONAL_PRIORITY) {
    const piece = optional[segment];
    if (piece === undefined) continue;
    if (utf8Bytes(joinSegments({ ...selected, [segment]: piece })) <= maxBytes) selected[segment] = piece;
    else dropped.push(segment);
  }

  const text = joinSegments(selected);
  return {
    text: text === '' ? null : text,
    bytes: utf8Bytes(text),
    refused,
    dropped,
    segments: JOIN_ORDER.filter((segment) => selected[segment] !== undefined),
  };
}

module.exports = {
  EMISSION_RULES,
  INPUT_DOMAINS,
  arbitrate,
  renderEmission,
  resolveIdentity,
  ruleAction,
  ruleVector,
  utf8Bytes,
};
