'use strict';

/**
 * The `failure` verb (IC-019): `list`, `settle` and `capture` over the machine-wide failure store
 * (IC-011 to IC-015). The store is per machine, so the verb ignores `-g` and works from any
 * directory; only `settle --as imported` looks at the project, and only to find the DoFlow
 * repository's follow-up store (IC-001 root). `--json` prints the result object unmodified; exit 0 =
 * answered or written, 1 = a refusal, 2 = usage. A refusal is returned, never thrown, so it cannot
 * reach failure capture (NFR-005).
 */

const fs = require('node:fs');
const { finishRuntime, usageError } = require('../cli-result');
const { maskLine, printSafe } = require('../mask');
const { failureHome, captureSwitch, sentinelPath } = require('./home');
const { rotateIfDue } = require('./capture');
const store = require('./store');
const { projectRoot } = require('../lifecycle/root');
const { appendEvents, readFold, randomChars, StoreUnsafeError } = require('../lifecycle/event-store');
const { prepareStore } = require('../lifecycle/store-upkeep');

const ACTIONS = ['list', 'settle', 'capture'];
const STATEMENT_MAX = 280;
const FP = /^[0-9a-f]{16}$/;
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029\u202A-\u202E\u2066-\u2069]/g;

/** A caller mistake (exit 2). */
class FailureUsageError extends Error {}

const refusal = (action, finding, message) => ({ ok: false, action, finding, message });

/** A one-line reason, masked like any other free text, or null when none was given. */
function cleanReason(raw) {
  if (raw === undefined) return null;
  const rawLength = String(raw).length;
  if (rawLength > STATEMENT_MAX * 4) throw new FailureUsageError(`--reason is ${rawLength} characters; the limit is ${STATEMENT_MAX}`);
  const text = maskLine(raw).text.trim();
  if (text === '') throw new FailureUsageError('--reason is empty');
  if (/[\r\n\u2028\u2029\u0085]/.test(text)) throw new FailureUsageError('--reason must be one line');
  if (text.length > STATEMENT_MAX) throw new FailureUsageError(`--reason is ${text.length} characters; the limit is ${STATEMENT_MAX}`);
  return text;
}

/** `DoFlow <command> <kind>: <message>`, built only from stored fields, masked and cut to 280 characters. */
function importedStatement(entry) {
  const raw = `DoFlow ${entry.command} ${entry.kind}${entry.message ? `: ${entry.message}` : ''}`;
  return maskLine(raw.replace(CONTROL, ' ')).text.replace(/\s+/g, ' ').trim().slice(0, STATEMENT_MAX);
}

// ── list ───────────────────────────────────────────────────────────────────────────────────────

function listFailures({ all = false, env = process.env } = {}) {
  const home = failureHome(env);
  if (home) rotateIfDue(home);
  const loaded = store.loadEntries({ env });
  const shown = loaded.entries.filter((entry) => all || store.SHOWN_BY_DEFAULT.has(entry.status)).map(store.listedEntry);
  const result = { ok: true, action: 'list', capture: loaded.capture };
  if (loaded.home === null) result.home = null;
  result.entries = shown;
  result.counts = loaded.counts;
  result.skippedLines = loaded.skippedLines;
  result.unreadable = loaded.unreadable;
  result.next = shown.length
    ? ['Settle each entry: doflow-run failure --action settle --fp <fp> --as noise|fixed|imported --reason "<why>"']
    : [];
  return result;
}

// ── settle ─────────────────────────────────────────────────────────────────────────────────────

function settleFailure({ fp, as, reason, cwd, env = process.env, now = new Date() }) {
  if (typeof fp !== 'string' || !FP.test(fp)) throw new FailureUsageError('--fp is required: the 16 hex characters of an entry from `failure --action list`');
  if (!store.SETTLE_AS.includes(as)) throw new FailureUsageError(`--as must be one of ${store.SETTLE_AS.join(', ')}${as ? ` (got '${as}')` : ''}`);
  const cleaned = cleanReason(reason);
  if ((as === 'noise' || as === 'fixed') && cleaned === null) throw new FailureUsageError(`--reason is required for --as ${as}`);
  const home = failureHome(env);
  if (home === null) return { ok: true, action: 'settle', home: null, entries: [], next: [] };

  let root = null;
  if (as === 'imported') {
    root = projectRoot(cwd || process.cwd());
    if (!store.isDoflowRepo(root)) {
      return refusal('settle', 'not-doflow-repo', `${root} is not the DoFlow repository (its package.json is not named @khoavu882/doflow), so a failure cannot be imported as a follow-up here. Nothing was written.`);
    }
    const prepared = prepareStore(root);
    for (const text of prepared.lines) console.error(printSafe(`doflow failure: ${text}`));
    if (!prepared.ok) return refusal('settle', prepared.finding, prepared.message);
  }
  const entry = store.loadEntries({ env }).entries.find((e) => e.fp === fp);
  if (!entry) return refusal('settle', 'unknown-fp', `${fp} is not a failure entry on this machine; list them with doflow-run failure --action list. Nothing was written.`);

  if (as !== 'imported') {
    store.appendSettlement(home, { fp, as, reason: cleaned, now });
    return { ok: true, action: 'settle', fp, as, reason: cleaned, followup: null };
  }
  // Deduplicated on the project's own follow-ups, whatever the settlements say: a follow-up that
  // already comes from this fingerprint is never created twice, even after a noise or fixed settlement.
  const followups = readFold(root, { now }).followups;
  const existing = followups.find((f) => f.source && f.source.kind === 'failure' && f.source.ref === fp);
  if (existing) return refusal('settle', 'already-imported', `${fp} was already imported as ${existing.id}. Nothing was written.`);
  const taken = new Set(followups.map((f) => f.id));
  let id;
  do { id = `FU-${randomChars(6)}`; } while (taken.has(id));
  const statement = importedStatement(entry);
  const source = { kind: 'failure', ref: fp };
  // The settlement goes first: if the follow-up write then fails, a retry finds no follow-up in the
  // project and creates exactly one, so a failure between the two steps can never duplicate it.
  store.appendSettlement(home, { fp, as, reason: cleaned, followup: id, now });
  const out = appendEvents(root, [{ type: 'followup.added', by: 'agent', data: { id, statement, source } }], { now });
  if (!out.ok) return refusal('settle', out.finding, `${out.message} The settlement was recorded without a follow-up; run the same command again.`);
  return {
    ok: true, action: 'settle', fp, as,
    followup: { id, statement, source, state: 'open' },
    events: out.written.map((w) => w.file),
  };
}

// ── capture ────────────────────────────────────────────────────────────────────────────────────

function captureState({ set, env = process.env, now = new Date() }) {
  if (set !== undefined && set !== 'on' && set !== 'off') throw new FailureUsageError(`--set must be on or off (got '${set}')`);
  const home = failureHome(env);
  if (home !== null && set === 'off') {
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.writeFileSync(sentinelPath(home), `${now.toISOString()}\n`, { mode: 0o600 });
  } else if (home !== null && set === 'on') {
    fs.rmSync(sentinelPath(home), { force: true });
  }
  const state = captureSwitch(home, env);
  // With no failure home nothing is captured, whatever the switch says.
  const result = { ok: true, action: 'capture', effective: home === null ? 'off' : state.effective, sentinel: state.sentinel, env: state.env };
  if (home === null) result.home = null;
  return result;
}

// ── verb ───────────────────────────────────────────────────────────────────────────────────────

function lines(result) {
  if (result.home === null) return ['home: none (capture skipped)', 'capture: off'];
  if (result.action === 'list') {
    const out = [`capture ${result.capture}: ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} listed (new ${result.counts.new}, regressed ${result.counts.regressed}, noise ${result.counts.noise}, fixed ${result.counts.fixed}, imported ${result.counts.imported})`];
    for (const e of result.entries) out.push(`${e.fp}  ${e.status}  x${e.count}  ${e.command} ${e.kind}${e.message ? `: ${e.message}` : ''}  (last seen ${e.lastSeen}, ${e.lastVersion})`);
    if (result.unreadable.length) out.push(`unreadable failure files (not read): ${result.unreadable.join(', ')}`);
    if (result.skippedLines) out.push(`${result.skippedLines} unreadable line${result.skippedLines === 1 ? '' : 's'} skipped`);
    return [...out, ...result.next.map((n) => `next: ${n}`)];
  }
  if (result.action === 'settle') return [`${result.fp} settled as ${result.as}${result.followup ? `, follow-up ${result.followup.id}` : ''}`];
  return [`capture ${result.effective}${result.sentinel ? ' (switched off on this machine)' : ''}${result.env ? ` (DOFLOW_FAILURE_CAPTURE=${result.env})` : ''}`];
}

/**
 * @param {Object} options
 * @param {string} [options.action] absent when --action was not given
 * @param {string} [options.cwd] where `settle --as imported` looks for the DoFlow repository
 * @param {boolean} [options.all] `list`: every status, not just new and regressed
 * @param {Object} [options.flags] fp, as, reason, set
 */
function handleFailureCommand({ action, cwd, json = false, all = false, flags = {} } = {}) {
  let result;
  try {
    if (!ACTIONS.includes(action)) throw new FailureUsageError(`--action is required: one of ${ACTIONS.join(', ')}${action ? ` (got '${action}')` : ''}`);
    if (action === 'list') result = listFailures({ all });
    else if (action === 'settle') result = settleFailure({ fp: flags.fp, as: flags.as, reason: flags.reason, cwd });
    else result = captureState({ set: flags.set });
  } catch (error) {
    if (error instanceof FailureUsageError || error instanceof StoreUnsafeError) return usageError('failure', error.message, json);
    throw error;
  }
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok === false) console.log(printSafe(`${result.finding}: ${result.message}`));
  else for (const line of lines(result)) console.log(printSafe(line));
  return finishRuntime(result.ok === false ? 1 : 0);
}

module.exports = { handleFailureCommand, listFailures, settleFailure, captureState, importedStatement, ACTIONS };
