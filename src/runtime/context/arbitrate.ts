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
const fs = require('node:fs');
const path = require('node:path');
const { cwdHash, resolveIdentity, stateDir } = require('./identity.ts');

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

// ── emitContext() (IC-001 emit half, IC-012 TypeScript claim, IC-015) ─────────────────────────
//
// The launcher-side caller of arbitrate(). It gathers the state bits from the store exactly as
// policies/emission.sh does, decides, takes the one-shot tokens (the `injected` slot with an
// exclusive create, then the summary and grant renames through summary-store.ts), renders, and
// appends the IC-015 ledger line with caller `launcher`. The store modules and the context pack
// are required inside the function: arbitrate.ts is also loaded alone by the rule compiler.

type Env = Record<string, string | undefined>;

interface EmitOptions {
  event: 'launch' | 'prompt' | 'delta';
  /** Default: resolveIdentity(env, { cwd, sessionId }). */
  identity?: any;
  cwd: string;
  sessionId?: string;
  harness?: string;
  /** Default 'none': a launcher never sees prompt text. */
  nudge?: 'nudge' | 'suppress' | 'none';
  maxBytes?: number;
  taskId?: string;
  slug?: string;
  /** Where the pack's task records live (115 IC-004: the main checkout from a linked worktree);
   * default `cwd`, which is always where the feature folder and source files are read. */
  stateRoot?: string;
  /** Decide and render; take no claim and write no ledger line. */
  peek?: boolean;
  /** Default process.env: identity, budget and the store root are read from it. */
  env?: Env;
}

interface EmitResult {
  decision: EmissionDecision;
  /** null when silent. */
  text: string | null;
  /** launch and delta only. */
  pack: { packDigest: string; form: string; deltaRefused: string | null } | null;
  /** True when this call took a token or wrote a ledger line. */
  committed: boolean;
}

const UNIT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_BYTES_PATTERN = /^[1-9][0-9]{0,9}$/;
const PACK_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
/** emission-rules.sh DF_RULES_MAX_BYTES_DEFAULT. */
const DEFAULT_MAX_BYTES = 16384;
const EMIT_EVENTS = ['launch', 'prompt', 'delta'];

function usageError(message: string): Error {
  const error: any = new Error(message);
  error.code = 'USAGE_ERROR';
  return error;
}

/** IC-001 budget: the flag, else DOFLOW_CONTEXT_MAX_BYTES, else the hook's default, as emission.sh. */
function emitBudget(maxBytes: number | undefined, env: Env): EmissionRequest['budget'] {
  if (maxBytes !== undefined) {
    if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw usageError('emitContext: maxBytes must be a positive integer');
    return { maxBytes, source: 'flag' };
  }
  const raw = env.DOFLOW_CONTEXT_MAX_BYTES || '';
  if (MAX_BYTES_PATTERN.test(raw)) return { maxBytes: Number(raw), source: 'env' };
  return { maxBytes: DEFAULT_MAX_BYTES, source: 'default' };
}

function present(file: string): boolean {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

/** `[ -f file ]`: a regular file, following a symlink. */
function isFile(file: string): boolean {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function readText(file: string | null): string | null {
  if (file === null) return null;
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The IC-015 ledger as [ts, kind, key, outcome, caller] rows; an absent file is empty. */
function readLedger(file: string): string[][] {
  const raw = readText(file);
  if (raw === null) return [];
  return raw.split('\n').filter((line: string) => line !== '').map((line: string) => line.split('\t'));
}

function ledgerSeen(rows: string[][], kind: string, key: string, outcome: string): boolean {
  return rows.some((row) => row[1] === kind && row[2] === key && row[3] === outcome);
}

/** The unit's last delivered pack digest, from a line either caller wrote. */
function lastPackKey(rows: string[][]): string | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i][1] === 'pack' && rows[i][3] === 'emitted' && PACK_DIGEST_PATTERN.test(rows[i][2] ?? '')) return rows[i][2];
  }
  return null;
}

/** `_doflow_em_ledger_add` with caller `launcher`: one line per (kind, key, outcome). True when written. */
function ledgerAdd(dir: string, kind: string, key: string, outcome: string): boolean {
  const file = path.join(dir, 'emitted');
  if (ledgerSeen(readLedger(file), kind, key, outcome)) return false;
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date().toISOString().replace(/\.[0-9]{3}Z$/, 'Z');
  fs.appendFileSync(file, `${at}\t${kind}\t${key}\t${outcome}\tlauncher\n`);
  return true;
}

/**
 * IC-001: one emission for a launch, a prompt or a delta. Throws a USAGE_ERROR for an unknown
 * event, a missing cwd, a unit with no id, or a `launch` without a launched identity (IC-007).
 */
function emitContext(options: EmitOptions): EmitResult {
  const store = require('./summary-store.ts');
  const env = options.env ?? process.env;
  const { event, cwd } = options;
  if (!EMIT_EVENTS.includes(event)) throw usageError(`emitContext: event must be one of ${EMIT_EVENTS.join(', ')}`);
  if (typeof cwd !== 'string' || cwd === '') throw usageError('emitContext: cwd is required');
  const sessionId = options.sessionId ?? '';
  // DEC-032, DEC-042: a session id names store paths (the unit, the git capture), so one that is not
  // a single safe path segment gets the silent answer for every lineage kind, before any read.
  if (sessionId !== '' && !UNIT_PATTERN.test(sessionId)) {
    return { decision: { emit: false, reason: 'fault:unit', actions: {}, claims: [], ledger: null }, text: null, pack: null, committed: false };
  }
  const identity = options.identity ?? resolveIdentity(env, { cwd, sessionId });
  if (event === 'launch' && identity.lineageKind !== 'launched') {
    throw usageError('emitContext: launch requires a launched identity (DOFLOW_RUN_ID, DOFLOW_LINEAGE_ID and DOFLOW_ATTEMPT)');
  }
  const unit: string = identity.unitId;
  if (typeof unit !== 'string' || !UNIT_PATTERN.test(unit)) throw usageError('emitContext: the unit has no id (no launched identity and no session id)');
  const peek = options.peek === true;
  const budget = emitBudget(options.maxBytes, env);
  const max = budget.maxBytes;
  const root = stateDir(env);
  // IC-010: with no config home there is no session store, so no bootstrap slot, ledger or claim to keep.
  if (root === null) return { decision: { emit: false, reason: 'silent:no-home', actions: {}, claims: [], ledger: null }, text: null, pack: null, committed: false };
  const dir = path.join(root, 'sessions', unit);
  const slot = path.join(dir, 'injected');
  const ledger = readLedger(path.join(dir, 'emitted'));
  const { run, lineage, worktree } = identity;

  // emission.sh step 3. The warning, the legacy file and the owner summary only matter before the
  // bootstrap. Grants are read only by launched identities (DEC-039).
  let bootstrapped = present(slot);
  const warnFile = path.join(root, 'projects', cwdHash(cwd), 'uncommitted-warning.txt');
  let warning = false;
  let legacy = false;
  let own: EmissionState['ownSummary'] = 'none';
  if (!bootstrapped) {
    warning = isFile(warnFile);
    legacy = store.legacySummary(cwd, env) !== null;
    own = store.peekSummary(worktree, run, lineage, sessionId, env).own;
  }
  const grant = identity.lineageKind === 'launched'
    ? store.peekGrant(run, lineage, max, env)
    : { grant: 'none', file: null, id: null, bytes: null };
  const refusedSeen = grant.grant === 'over' && grant.id !== null && ledgerSeen(ledger, 'grant', grant.id, REFUSED);
  const state = (b: boolean): EmissionState => ({ bootstrapped: b, subagent: false, ownSummary: own, legacy, grant: grant.grant, refusedSeen, warning, nudge: options.nudge ?? 'none' });

  // Step 4 (IC-014, DEC-043): the legacy adoption, then the owner summary bit again. A peek takes
  // nothing, so it reads the legacy file where it lies as the summary the prompt would adopt.
  let legacyFile: string | null = null;
  if (event === 'prompt' && arbitrate({ event: 'legacy-adopt', identity, budget, state: state(bootstrapped) }).actions.legacy === 'adopt') {
    if (peek) {
      if (own === 'none') {
        legacyFile = store.legacySummary(cwd, env);
        if (legacyFile !== null) own = 'pending';
      }
    } else {
      store.adoptLegacy(cwd, worktree, env);
      own = store.peekSummary(worktree, run, lineage, sessionId, env).own;
    }
  }
  const decide = (b: boolean): EmissionDecision => arbitrate({ event, identity, budget, state: state(b) });
  let decision = decide(bootstrapped);

  // Step 6, the slot first: EEXIST means another caller bootstrapped this unit.
  let tookSlot = false;
  if (decision.actions.slot === 'claim' && !peek) {
    fs.mkdirSync(dir, { recursive: true });
    try {
      fs.closeSync(fs.openSync(slot, 'wx'));
      tookSlot = true;
    } catch (error: any) {
      if (error?.code !== 'EEXIST') throw error;
      bootstrapped = true;
      decision = decide(true);
    }
  }
  const releaseSlot = (): void => {
    if (tookSlot) fs.rmSync(slot, { force: true });
  };

  // Every claimed summary or grant, with the name it came from: removed only once the text is
  // returned, and given back (with the slot) when anything after the claim throws (DEC-038).
  const claimed: Array<{ file: string; origin: string }> = [];
  try {
    // The pack, before any other claim: a mandatory overflow refuses the whole event and gives back
    // the slot this call took, so the next caller can still bootstrap the unit.
    let pack: EmitResult['pack'] = null;
    let packText: string | null = null;
    if (decision.actions.pack === 'include') {
      const { packForEmission } = require('../context-pack.ts');
      const since = lastPackKey(ledger);
      const compiled = packForEmission({ root: cwd, stateRoot: options.stateRoot ?? cwd, taskId: options.taskId, slug: options.slug, harness: options.harness ?? null, maxBytes: max, since, noRecord: peek, env });
      const digest: string = compiled.pack.delivery.packDigest;
      pack = { packDigest: digest, form: 'markdown', deltaRefused: compiled.pack.delivery.deltaRefused ?? null };
      if (compiled.pack.status === 'OVERFLOW') {
        releaseSlot();
        return {
          decision: { ...decision, emit: false, reason: REFUSED },
          text: compiled.pack.overflowAction?.message ?? null,
          pack,
          committed: false,
        };
      }
      const delta = compiled.pack.delta;
      const unchanged = since !== null && (digest === since
        || (delta !== null && delta !== undefined && delta.added.length === 0 && delta.changed.length === 0 && delta.removed.length === 0));
      if (!unchanged) packText = compiled.output;
    }

    // DEC-034: one byte budget per emission. The pack is measured first; the prompt segments get
    // what is left after it and the blank line that joins them. The grant is fitted to that
    // remainder before it is claimed, so a grant that no longer fits becomes its pointer and is
    // never consumed; the claim then takes exactly the grant that was fitted (L1-05).
    const room = packText === null ? max : max - utf8Bytes(packText) - 2;
    if ((decision.actions.grant === 'whole' || decision.actions.grant === 'pointer') && grant.file !== null) {
      const raw = readText(grant.file);
      if (raw !== null) {
        const record = parseRecord(raw);
        if (decision.actions.grant === 'whole' && utf8Bytes(renderGrant(record)) > room) {
          decision = { ...decision, actions: { ...decision.actions, grant: 'pointer' }, ledger: { kind: 'grant', key: '@grant', outcome: REFUSED } };
        }
        if (decision.actions.grant === 'pointer' && (room < 1 || utf8Bytes(renderPointer(record, room)) > room)) {
          // Not even the pointer fits: the event is refused, as a pack overflow is, and the slot goes back.
          releaseSlot();
          return {
            decision: { ...decision, emit: false, reason: REFUSED },
            text: renderPointer(record, max),
            pack,
            committed: false,
          };
        }
      }
    }

    // The remaining claims in IC-004 order (summary, grant, warning); peek reads in place.
    const inputs: RenderInputs = {};
    let tookClaim = false;
    let grantKey: string | null = grant.id;
    let summaryKey: string | null = null;
    let removeWarning = false;
    if (decision.actions.summary === 'truncate') {
      if (peek) {
        const file = legacyFile ?? store.peekSummary(worktree, run, lineage, sessionId, env).file;
        if (file !== null) {
          const raw = fs.readFileSync(file);
          inputs.summary = raw.subarray(0, SUMMARY_READ).toString('utf8');
          inputs.summaryBytes = raw.length;
        }
      } else {
        const c = store.claimSummary(worktree, run, lineage, unit, sessionId, env);
        if (c.claimed !== null) {
          tookClaim = true;
          claimed.push({ file: c.claimed, origin: c.origin });
          inputs.summary = readText(c.claimed);
          inputs.summaryBytes = c.bytes;
        }
      }
      if (typeof inputs.summary === 'string') {
        const id = parseRecord(inputs.summary).fields.summary_id;
        if (id !== undefined && store.SUMMARY_ID_PATTERN.test(id)) summaryKey = id;
      }
    }
    if (decision.actions.grant === 'whole') {
      if (peek) inputs.grant = readText(grant.file);
      else if (grant.id !== null) {
        const c = store.claimGrant(run, lineage, unit, grant.id, env);
        if (c.claimed !== null) {
          tookClaim = true;
          claimed.push({ file: c.claimed, origin: c.origin });
          grantKey = c.id;
          inputs.grant = readText(c.claimed);
        }
      }
    } else if (decision.actions.grant === 'pointer') {
      // An over-budget grant is never claimed: it renders as its pointer from where it lies.
      inputs.grant = readText(grant.file);
    }
    if (decision.actions.warning === 'include') {
      inputs.warning = readText(warnFile);
      removeWarning = !peek && inputs.warning !== null;
    }
    if (decision.actions.git === 'include' && sessionId !== '') inputs.git = readText(path.join(root, 'sessions', sessionId, 'git-context.json'));

    const rendered: RenderResult = room >= 1
      ? renderEmission({ actions: decision.actions, maxBytes: room, inputs })
      : { text: null, bytes: 0, refused: false, dropped: [], segments: [] };
    const text = [packText, rendered.text].filter((piece) => piece !== null && piece !== '').join('\n\n') || null;

    // Step 8: the ledger lines (pack delivered; grant refused, keyed by its summary id; each optional
    // segment the budget dropped, keyed by its summary or grant id, else its name; DEC-041).
    let wrote = false;
    if (!peek) {
      if (packText !== null && pack !== null) wrote = ledgerAdd(dir, 'pack', pack.packDigest, 'emitted') || wrote;
      if (decision.actions.grant === 'pointer' && grant.id !== null) wrote = ledgerAdd(dir, 'grant', grant.id, REFUSED) || wrote;
      for (const segment of rendered.dropped) {
        const key = (segment === 'summary' ? summaryKey : segment === 'grant' ? grantKey : null) ?? segment;
        wrote = ledgerAdd(dir, 'optional-dropped', key, 'over-budget') || wrote;
      }
    }

    let reason: string;
    if (rendered.refused || decision.reason === REFUSED) reason = REFUSED;
    else if (text !== null) reason = 'emit';
    else if (bootstrapped && event !== 'delta') reason = 'silent:already-bootstrapped';
    else reason = 'silent:unchanged';
    const hint = decision.ledger && decision.ledger.key === '@grant' && grant.id !== null ? { ...decision.ledger, key: grant.id } : decision.ledger;
    const result: EmitResult = {
      decision: { ...decision, emit: text !== null, reason, ledger: hint },
      text,
      pack,
      committed: !peek && (tookSlot || tookClaim || removeWarning || wrote),
    };

    // The text is ready: only now are the claimed files and the delivered warning consumed.
    for (const c of claimed.splice(0)) fs.rmSync(c.file, { force: true });
    if (removeWarning) fs.rmSync(warnFile, { force: true });
    return result;
  } catch (error) {
    for (const c of claimed) store.releaseClaim(c.file, c.origin);
    try {
      releaseSlot();
    } catch {
      // The original error is the one to report.
    }
    throw error;
  }
}

module.exports = {
  EMISSION_RULES,
  INPUT_DOMAINS,
  arbitrate,
  emitContext,
  renderEmission,
  resolveIdentity,
  ruleAction,
  ruleVector,
  utf8Bytes,
};
