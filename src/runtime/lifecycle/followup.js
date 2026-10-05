'use strict';

/**
 * The follow-up service (IC-006 without `report`, IC-003 transitions): add, list, take, settle and
 * promote, over the lifecycle event store. Every function takes the IC-001 root, writes only events
 * (and, for promote, one new intent file), and returns a result object without printing, so the verb
 * layer and other callers share it.
 *
 *   - A refusal is returned `{ok:false, action, finding, message}` and never thrown (exit 1).
 *   - A caller mistake throws `FollowupUsageError` (exit 2), before anything is written.
 *   - Every free-text field is masked (line profile) before it is checked or stored; the checks run
 *     on the masked text, because that is what is written.
 */

const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { maskLine } = require('../mask');
const { STAGES: CHAIN_STAGES } = require('../decision-register');
const { isSafeSlug, invalidSlugRefusal } = require('../task-scope');
const { resolveActiveFeature } = require('../feature-resolve');
const { SETTLE_AS, withDerivedDone } = require('./fold');
const { appendEvents, readFold, byFromChannel, randomChars } = require('./event-store');
const { deriveStatuses } = require('./status');
const { writeIntent, kebabTitle } = require('./intent-writer');
const reportStore = require('./report-store');

/** The decision register's stages plus the two lifecycle stages (IC-006). */
const STAGES = [...CHAIN_STAGES, 'release', 'maintain'];
const STATES = ['open', 'taken', 'done', 'dismissed'];
const SOURCE_KINDS = ['run', 'release', 'manual'];
const STATEMENT_MAX = 280;
const FU_ID = /^FU-[0-9a-hjkmnp-tv-z]{6}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const LINE_BREAK = /[\r\n\u2028\u2029\u0085]/;
/** DEC-046: C0 and C1 controls (tab allowed; line breaks are caught first) and the bidirectional overrides. */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/;
/** Refusal findings a fold conflict maps to; every other conflict is an `illegal-transition`. */
const CONFLICT_FINDINGS = new Set(['unknown-id', 'untracked-feature', 'intent-exists', 'reason-required', 'evidence-required']);

/** A caller mistake (exit 2). */
class FollowupUsageError extends Error {}

function refusal(action, finding, message) { return { ok: false, action, finding, message }; }

/** Maps an `appendEvents` failure to a refusal result. */
function refusalFrom(action, failed) {
  const finding = failed.conflict && CONFLICT_FINDINGS.has(failed.conflict.code) ? failed.conflict.code : failed.finding;
  return refusal(action, finding, failed.message);
}

/** Masks a free-text field and checks it is one non-empty line of at most `max` characters. */
function oneLine(raw, label, problems, { max = STATEMENT_MAX } = {}) {
  // The length is checked before masking as well, so the masking patterns never see more than a bounded input.
  const rawLength = String(raw ?? '').length;
  if (rawLength > max * 4) { problems.push(`${label} is ${rawLength} characters; the limit is ${max}`); return null; }
  const text = maskLine(raw).text.trim();
  if (text === '') { problems.push(`${label} is empty`); return null; }
  if (LINE_BREAK.test(text)) { problems.push(`${label} must be one line`); return null; }
  if (CONTROL.test(text)) { problems.push(`${label} contains a control or bidirectional-override character`); return null; }
  if (text.length > max) { problems.push(`${label} is ${text.length} characters; the limit is ${max}`); return null; }
  return text;
}

function newFollowupId(taken) {
  for (;;) {
    const id = `FU-${randomChars(6)}`;
    if (!taken.has(id)) { taken.add(id); return id; }
  }
}

function channelBy(channel) {
  const by = byFromChannel(channel || 'default');
  if (!by) throw new FollowupUsageError(`unknown --channel '${channel}'. Valid: question, gate, prompt, default`);
  return by;
}

function parseIds(raw, label = '--ids') {
  const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
  const ids = [...new Set(list.flatMap((entry) => String(entry).split(',')).map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) throw new FollowupUsageError(`${label} is required: one or more follow-up ids, comma separated`);
  const bad = ids.filter((id) => !FU_ID.test(id));
  if (bad.length) throw new FollowupUsageError(`${label} names ${bad.join(', ')}, which is not a follow-up id (FU- and six characters)`);
  return ids;
}

/** The folded store, with a taken item shown `done` while its feature derives finished (IC-003, IC-021). */
function loadFollowups(root, { hasBody, fsImpl = nodeFs, statuses, now = new Date() } = {}) {
  const fold = readFold(root, { hasBody: hasBody || reportStore.bodyChecker(root, { fsImpl }), fsImpl, now });
  const needsStatus = fold.followups.some((item) => item.state === 'taken');
  const derived = needsStatus ? (statuses || deriveStatuses({ root, fold })) : null;
  const followups = needsStatus ? withDerivedDone(fold.followups, Object.fromEntries(Object.entries(derived.statuses).map(([slug, s]) => [slug, s.status]))) : fold.followups;
  return { fold, followups };
}

// ── add ────────────────────────────────────────────────────────────────────────────────────────

/** The active feature slug: `--slug`, else the branch through the existing resolver; null when neither. */
function resolveFeatureSlug({ cwd, slug }) {
  if (slug) {
    const bad = invalidSlugRefusal(slug);
    if (bad) throw new FollowupUsageError(bad.message);
    return slug;
  }
  const found = resolveActiveFeature({ projectRoot: cwd });
  // A missing helper is an install problem, not "no feature": it must not read as a branch that names none.
  if (found.error === 'resolver-missing') throw new FollowupUsageError('the DoFlow helper scripts are missing from this install; reinstall DoFlow, or pass --slug, or --source run|release|manual');
  const resolved = found.error ? null : found.paths && found.paths.feature_slug;
  if (!resolved || !isSafeSlug(resolved)) return null;
  // A branch names a feature only when its folder exists; otherwise the item would cite a feature that does not (IC-002).
  let isFolder = false;
  try { isFolder = nodeFs.statSync(found.featureDir).isDirectory(); } catch { /* absent */ }
  if (!isFolder) {
    throw new FollowupUsageError(`branch '${found.paths.branch}' names '${resolved}', which has no feature folder (agent-docs/doflow/${resolved}); pass --slug <existing feature>, or --source run --task-class <class> --task-id <id>`);
  }
  return resolved;
}

function sourceFor(kind, fields, label, problems) {
  const word = (value, name) => {
    if (typeof value === 'string' && WORD.test(value)) return value;
    problems.push(`${label}: ${name} must be letters, digits, dot, underscore or dash`);
    return null;
  };
  if (kind === 'stage') {
    const feature = word(fields.feature, 'the feature');
    return feature && { kind, feature, stage: fields.stage };
  }
  if (kind === 'run') {
    const taskClass = word(fields.taskClass, '--task-class');
    const taskId = word(fields.taskId, '--task-id');
    return taskClass && taskId && { kind, taskClass, taskId, stage: fields.stage };
  }
  if (kind === 'release') {
    if (fields.release === undefined || fields.release === null) { problems.push(`${label}: --release <tag> is required for --source release`); return null; }
    const release = word(fields.release, '--release');
    return release && { kind, release };
  }
  return { kind: 'manual' };
}

/**
 * Validates every item and builds its `followup.added` data; nothing is written unless all pass.
 * @returns {Array<{statement:string, source:Object}>}
 */
function buildItems({ cwd, items, defaults }) {
  const problems = [];
  let featureSlug;
  const feature = () => {
    if (featureSlug === undefined) featureSlug = resolveFeatureSlug({ cwd, slug: defaults.slug });
    return featureSlug;
  };
  const built = [];
  items.forEach((raw, index) => {
    const label = items.length > 1 || defaults.batch ? `item ${index + 1}` : 'the follow-up';
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { problems.push(`${label} must be an object`); return; }
    const statement = oneLine(raw.statement, `${label}: statement`, problems);
    const stage = raw.stage ?? defaults.stage;
    const given = raw.source ?? defaults.source;
    const sourceObject = given && typeof given === 'object' ? given : null;
    const kind = sourceObject ? sourceObject.kind : (given || null);
    if (kind !== null && kind !== 'stage' && !SOURCE_KINDS.includes(kind)) {
      problems.push(`${label}: source must be one of ${['stage', ...SOURCE_KINDS].join(', ')} (got '${kind}')`);
      return;
    }
    const resolvedKind = kind || 'stage';
    if ((resolvedKind === 'stage' || resolvedKind === 'run') && !STAGES.includes(stage)) {
      problems.push(`${label}: stage must be one of ${STAGES.join(', ')}${stage ? ` (got '${stage}')` : ''}`);
      return;
    }
    let source;
    if (resolvedKind === 'stage') {
      const slug = sourceObject && sourceObject.feature ? sourceObject.feature : feature();
      if (!slug) { problems.push(`${label}: no feature resolved from the branch; pass --slug, or --source run|release|manual`); return; }
      source = sourceFor('stage', { feature: slug, stage }, label, problems);
    } else {
      source = sourceFor(resolvedKind, {
        stage,
        taskClass: sourceObject ? sourceObject.taskClass : defaults.taskClass,
        taskId: sourceObject ? sourceObject.taskId : defaults.taskId,
        release: sourceObject ? sourceObject.release : defaults.release,
      }, label, problems);
    }
    if (statement && source) built.push({ statement, source });
  });
  if (problems.length) throw new FollowupUsageError(problems.join('; '));
  return built;
}

/**
 * Reads a `--batch` file: a JSON array of `{statement, stage, source}` objects. Like `--file`, it
 * must be a regular file of at most 16 MiB, so a device or a FIFO is refused, never read.
 * @returns {Object[]}
 */
function readBatchFile(file, fsImpl = nodeFs) {
  let parsed;
  let fd;
  try {
    const target = path.resolve(file);
    if (!fsImpl.statSync(target).isFile()) throw new Error('not a regular file');
    fd = fsImpl.openSync(target, nodeFs.constants.O_RDONLY | (nodeFs.constants.O_NONBLOCK || 0));
    const st = fsImpl.fstatSync(fd);
    if (!st.isFile()) throw new Error('not a regular file');
    if (st.size > reportStore.MAX_READ_BYTES) throw new Error('larger than 16 MiB');
    parsed = JSON.parse(fsImpl.readFileSync(fd, 'utf8'));
  } catch (error) {
    throw new FollowupUsageError(`cannot read --batch ${file}: ${error.message}`);
  } finally {
    if (fd !== undefined) { try { fsImpl.closeSync(fd); } catch { /* read already done */ } }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw new FollowupUsageError(`--batch ${file} must hold a non-empty JSON array of {statement, stage, source} objects`);
  return parsed;
}

/**
 * IC-006 `add`. `items` are `{statement, stage?, source?}`; `defaults` holds the flag values
 * (`stage`, `slug`, `source`, `taskClass`, `taskId`, `release`, `batch`).
 */
function addFollowups({ root, cwd = process.cwd(), items, defaults = {}, channel, now = new Date(), fsImpl = nodeFs }) {
  const by = channelBy(channel);
  const built = buildItems({ cwd, items, defaults });
  const taken = new Set(readFold(root, { fsImpl, now }).followups.map((f) => f.id));
  const drafts = built.map(({ statement, source }) => ({ type: 'followup.added', by, data: { id: newFollowupId(taken), statement, source } }));
  const out = appendEvents(root, drafts, { now, fsImpl });
  if (!out.ok) return refusalFrom('add', out);
  return {
    ok: true,
    action: 'add',
    created: out.written.map(({ event }) => ({ id: event.data.id, statement: event.data.statement, source: event.data.source, state: 'open' })),
    events: out.written.map((w) => w.file),
    next: [],
  };
}

// ── report ─────────────────────────────────────────────────────────────────────────────────────

/** `--release` and `--feature` of a report: letters, digits, dot, underscore or dash, as for `--source release`. */
function reportSource({ release, feature }) {
  const problems = [];
  const source = { kind: 'report' };
  if (release !== undefined && release !== null) {
    if (typeof release === 'string' && WORD.test(release)) source.release = release; else problems.push('--release must be letters, digits, dot, underscore or dash');
  }
  if (feature !== undefined && feature !== null) {
    const list = Array.isArray(feature) ? feature : [feature];
    if (list.length !== 1) problems.push('--feature takes one feature slug for a report');
    else if (invalidSlugRefusal(list[0])) problems.push(invalidSlugRefusal(list[0]).message);
    else source.feature = list[0];
  }
  if (problems.length) throw new FollowupUsageError(problems.join('; '));
  return source;
}

/**
 * IC-006 `report` (IC-005): masks the statement and the body, keeps the body on this machine, then
 * writes one `followup.added` event with `source.kind: report` that carries only a reference, the
 * size and a masked 2 KB excerpt. Nothing is written when any check fails; the body file is removed
 * when its event cannot be written.
 *
 * With no resolvable home the body is not kept (IC-005): the event says `bodyRef: null` and the
 * result says so in `next`.
 *
 * @param {Object} options
 * @param {string} options.root the IC-001 root
 * @param {string} options.statement one line, at most 280 characters after masking
 * @param {{file?: string, stdin?: boolean, text?: string}} options.input exactly one source of the body
 * @param {string} [options.release]
 * @param {string|string[]} [options.feature]
 */
function reportFollowup({ root, statement, input, release, feature, channel, now = new Date(), fsImpl = nodeFs, env = process.env }) {
  const by = channelBy(channel);
  const source = reportSource({ release, feature });
  const problems = [];
  const rawStatement = String(statement ?? '');
  const statementMasked = maskLine(rawStatement).masked;
  const cleanStatement = oneLine(rawStatement, '--statement', problems);
  if (problems.length) throw new FollowupUsageError(problems.join('; '));
  let raw;
  try { raw = reportStore.readReportText(input, { fsImpl }); } catch (error) {
    if (error instanceof reportStore.ReportInputError) throw new FollowupUsageError(error.message);
    throw error;
  }
  let body;
  try { body = reportStore.prepareBody(raw, { home: env.HOME || os.homedir() }); } catch (error) {
    if (error instanceof reportStore.ReportInputError) throw new FollowupUsageError(error.message);
    throw error;
  }
  if (!/\S/.test(body.buffer.toString('utf8'))) throw new FollowupUsageError('the report body is empty');
  const excerpt = reportStore.excerptOf(body.buffer);
  // The excerpt is stored in the project event, so it gets the statement's hygiene; a line break is allowed in it.
  // ANSI colour and title sequences were removed before masking; what is left is a real control or bidirectional character.
  if (CONTROL.test(excerpt)) throw new FollowupUsageError('the first 2 KB of the report body contain a control or bidirectional-override character; remove it and file the report again');

  const taken = new Set(readFold(root, { fsImpl, now }).followups.map((f) => f.id));
  let id;
  let stored = { ok: false, reason: 'no-home' };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    id = newFollowupId(taken);
    stored = reportStore.writeBody(root, id, body.buffer, { env, fsImpl });
    if (stored.reason !== 'exists') break;
  }
  if (!stored.ok && stored.reason !== 'no-home') {
    return refusal('report', stored.reason === 'exists' ? 'id-collision' : 'body-not-written', `the report body could not be stored on this machine (${stored.message || 'name taken'}). Nothing was written.`);
  }
  const kept = stored.ok;
  const data = { id, statement: cleanStatement, source, excerpt, bodyRef: kept ? `local:${id}` : null, bodyBytes: body.buffer.length };
  let out;
  try {
    out = appendEvents(root, [{ type: 'followup.added', by, data }], { now, fsImpl });
  } catch (error) {
    if (kept) reportStore.removeBody(stored.file, fsImpl);
    throw error;
  }
  if (!out.ok) {
    if (kept) reportStore.removeBody(stored.file, fsImpl);
    return refusalFrom('report', out);
  }
  const next = ['Settle it now or at /do maintain; to start a fix, route it as a bug run'];
  if (!kept) next.push('No home folder resolves (set HOME or an absolute XDG_CONFIG_HOME), so the body was not kept; only the masked excerpt is in the event');
  return {
    ok: true,
    action: 'report',
    created: [{
      id, statement: cleanStatement, source, state: 'open',
      excerptBytes: Buffer.byteLength(excerpt, 'utf8'), bodyBytes: body.buffer.length,
      body: kept ? 'on-this-machine' : 'not-on-this-machine', masked: statementMasked + body.masked,
    }],
    events: out.written.map((w) => w.file),
    next,
  };
}

// ── list ───────────────────────────────────────────────────────────────────────────────────────

/** IC-006 `list`: `state` is open (default), taken, done, dismissed or all. */
function listFollowups({ root, state = 'open', hasBody, fsImpl = nodeFs, statuses, now = new Date() }) {
  if (state !== 'all' && !STATES.includes(state)) throw new FollowupUsageError(`--state must be one of ${[...STATES, 'all'].join(', ')} (got '${state}')`);
  const { fold, followups } = loadFollowups(root, { hasBody, fsImpl, statuses, now });
  const items = state === 'all' ? followups : followups.filter((item) => item.state === state);
  return { ok: true, action: 'list', state, count: items.length, items, conflicts: fold.conflicts, unreadable: fold.unreadable, unreadableReasons: fold.unreadableReasons, next: [] };
}

// ── take, settle, promote ──────────────────────────────────────────────────────────────────────

/** IC-006 `take`: one `followup.taken` event; every id must be open and the feature tracked. */
function takeFollowups({ root, ids, slug, channel, now = new Date(), fsImpl = nodeFs }) {
  const list = parseIds(ids);
  if (!slug) throw new FollowupUsageError('--slug is required for --action take');
  const bad = invalidSlugRefusal(slug);
  if (bad) throw new FollowupUsageError(bad.message);
  const out = appendEvents(root, [{ type: 'followup.taken', by: channelBy(channel), data: { ids: list, feature: slug } }], { now, fsImpl });
  if (!out.ok) return refusalFrom('take', out);
  return { ok: true, action: 'take', ids: list, feature: slug, events: out.written.map((w) => w.file), next: [] };
}

/** IC-006 `settle`: one `followup.settled` event per id. Each `as` value's required field is in IC-003. */
function settleFollowups({ root, ids, as, reason, evidence, channel, now = new Date(), fsImpl = nodeFs }) {
  const list = parseIds(ids);
  if (!SETTLE_AS.includes(as)) throw new FollowupUsageError(`--as must be one of ${SETTLE_AS.join(', ')}${as ? ` (got '${as}')` : ''}`);
  const problems = [];
  const cleanReason = reason === undefined ? null : oneLine(reason, '--reason', problems);
  const cleanEvidence = evidence === undefined ? null : oneLine(evidence, '--evidence', problems);
  // `kept` needs a reason only when it releases a taken item or reopens a dismissed one; the fold knows the state.
  if (!problems.length && (as === 'dismissed' || as === 'fix') && !cleanReason) problems.push(`--reason is required for --as ${as}`);
  if (!problems.length && as === 'done' && !cleanEvidence) problems.push('--evidence is required for --as done');
  if (problems.length) throw new FollowupUsageError(problems.join('; '));
  const by = channelBy(channel);
  // `list` shows a taken item whose feature finished as `done`, but the fold still holds it `taken`: say what the user was shown.
  const derivedDone = new Map(loadFollowups(root, { fsImpl, now }).followups.filter((item) => item.derived).map((item) => [item.id, item.takenBy]));
  if (as !== 'kept') {
    const shown = list.find((id) => derivedDone.has(id));
    if (shown) {
      return refusal('settle', 'illegal-transition', `${shown} is done because feature ${derivedDone.get(shown)} finished (derived from git and the release records, not recorded on the item); only an open item can be settled as ${as}. Nothing was written.`);
    }
  }
  const drafts = list.map((id) => ({ type: 'followup.settled', by, data: { id, as, reason: cleanReason, evidence: cleanEvidence } }));
  const out = appendEvents(root, drafts, { now, fsImpl });
  if (!out.ok) return refusalFrom('settle', out);
  const reopened = as === 'kept' ? list.filter((id) => derivedDone.has(id)) : [];
  return {
    ok: true,
    action: 'settle',
    ids: list,
    as,
    events: out.written.map((w) => w.file),
    next: reopened.map((id) => `${id} was shown as done because feature ${derivedDone.get(id)} finished; keeping it released it from that feature, so it is open again`),
  };
}

/**
 * IC-006 `promote` (IC-024): creates a new intent that names the items, then writes one
 * `followup.promoted` event. It never adds items to an existing intent.
 */
function promoteFollowups({ root, ids, title, channel, now = new Date(), fsImpl = nodeFs }) {
  const list = parseIds(ids);
  const problems = [];
  const cleanTitle = oneLine(title, '--title', problems, { max: 80 });
  if (problems.length) throw new FollowupUsageError(problems.join('; '));
  const by = channelBy(channel);
  // Check the items before the file exists, so a refusal leaves nothing behind; the event write checks again under the lock.
  const { followups } = loadFollowups(root, { fsImpl, now });
  const items = [];
  for (const id of list) {
    const item = followups.find((f) => f.id === id);
    if (!item) return refusal('promote', 'unknown-id', `${id} is not a follow-up. Nothing was written.`);
    if (item.state !== 'open') return refusal('promote', 'illegal-transition', `${id} is ${item.state}; only an open item can be promoted. Nothing was written.`);
    if (item.intent) return refusal('promote', 'intent-exists', `${id} was already promoted to ${item.intent}. Nothing was written.`);
    items.push(item);
  }
  // A title with no ASCII letter or digit still promotes, under a name built from the first item's id (DEC-046).
  const fallbackName = kebabTitle(cleanTitle) ? null : `followups-${list[0].toLowerCase()}`;
  const written = writeIntent(root, { title: cleanTitle, fallbackName, by, date: now.toISOString().slice(0, 10), items }, { fsImpl });
  if (!written.ok) return refusal('promote', written.finding, written.message);
  let committed = false;
  try {
    const out = appendEvents(root, [{ type: 'followup.promoted', by, data: { ids: list, intent: written.path } }], { now, fsImpl });
    if (!out.ok) return refusalFrom('promote', out);
    committed = true;
    return { ok: true, action: 'promote', intent: written.path, ids: list, events: out.written.map((w) => w.file), next: [] };
  } finally {
    // The file is the one this call just created exclusively, so removing it undoes a half-done promotion on every failure path.
    if (!committed) { try { fsImpl.rmSync(written.file, { force: true }); } catch { /* the failure being reported stands */ } }
  }
}

module.exports = {
  addFollowups, reportFollowup, listFollowups, takeFollowups, settleFollowups, promoteFollowups,
  loadFollowups, readBatchFile, resolveFeatureSlug, parseIds, oneLine, channelBy,
  FollowupUsageError, STAGES, STATES, SOURCE_KINDS, STATEMENT_MAX,
};
