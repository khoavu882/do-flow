'use strict';

/**
 * C6 — repair-coverage annotator (FR-006, design §3 C6, entity `REPAIR_COVERAGE`).
 *
 * States which of the report's findings the existing repair path can actually act on. That set is
 * narrower than the set of findings, and the difference is not self-evident:
 *
 *   $ doflow status -g          → 321 pending changes across 8 harnesses
 *   $ doflow reconcile -g --dry-run → 10 drifts for 1 harness
 *
 * Both numbers are internally consistent. `status` reads the ledger, which records what DoFlow
 * owns; `reconcile` (`src/cli/commands/reconcile.js`) derives its target set from `doflow.lock`,
 * which records what an install *chose*. The lock accumulates: each run keeps every pin whose
 * harness the ledger still holds (`src/lifecycle/view.js#lockDocument`). A harness the ledger holds
 * and the lock lacks — one installed before any lock recorded it — is still outside the repair
 * path, and `reconcile` names it rather than converging it. A user must not be able to read the
 * report and reasonably conclude a remedy exists where none does — that is the whole of FR-006.
 *
 * Three rules this module holds to:
 *
 * 1. **Coverage is computed against the lock's targets, never the ledger's.** The ledger is what
 *    produced the findings; the lock is what bounds the remedy. Measuring against the ledger would
 *    reproduce the over-claim this component exists to prevent.
 * 2. **A scope with no lock has zero repair coverage, not full coverage.** `reconcile` short-
 *    circuits on `!lock || !lock.targets.length` and does nothing at all in that scope. An absent
 *    pin is the weakest possible coverage, not an unrestricted one; getting this backwards would
 *    be the worst failure this module could have.
 * 3. **This module states the gap. It never repairs, and it never recommends widening the lock** —
 *    `reconcile` names a harness the ledger holds and the lock lacks, and a later `doflow install`
 *    or `doflow update -t <harness>` is what pins it.
 *
 * Granularity and its ceiling: `reconcile` filters by harness (`lock.targets.map(e => e.harness)`)
 * and then re-plans that harness in full with `force: true`; it does not consult `lock.assets`. So
 * harness-plus-scope is exactly the grain at which the repair path's reach is decidable, and this
 * module uses no finer one. Within that grain the result is an **upper bound**: a finding on a
 * pinned harness is one `reconcile` will look at, not one it is guaranteed to heal — a plan
 * conflict or an unmet prerequisite is reported by `reconcile` rather than converged. Narrowing
 * that would require running the lifecycle plan, which is not a read this component owns.
 *
 * Read-only and synchronous throughout (NFR-001). `repairCoverage` is pure; `readScopeLocks` is the
 * one function that touches disk, kept separate so a caller can supply lock documents from anywhere.
 */

const os = require('node:os');
const { readLock } = require('../../state/lockfile');

/** The scopes a report is assembled from. Mirrors `readScopes`'s pair; a finding naming anything
 * else is a caller bug and is reported as such rather than silently counted either way. */
const SCOPES = ['global', 'project'];

/** The only repair path this component knows how to measure. A finding whose `repairPath` is not
 * this value is out of reach whatever the lock says — `reconcile` converges a scope onto its own
 * pin and nothing else: it does not delete a rival copy at the other scope, does not remove an
 * unmanaged file, and cannot establish a harness's undocumented precedence. */
const RECONCILE = 'reconcile';

/** Why a finding is not repairable. Exported so a renderer can be exhaustive over the set rather
 * than matching string literals that drift. */
const REPAIR_REASONS = Object.freeze({
  /** The finding's scope has no lock, or a lock pinning no targets — `reconcile` does nothing there. */
  SCOPE_NOT_PINNED: 'scope-not-pinned',
  /** The scope is pinned, but not for this harness. The 321-versus-10 case. */
  HARNESS_NOT_PINNED: 'harness-not-pinned',
  /** The finding names a remedy that is not the repair path — manual action, research, an install. */
  OUTSIDE_REPAIR_PATH: 'outside-repair-path',
  /** The finding names no remedy at all. Counted unrepairable, because FR-006 forbids over-claiming
   * and an unstated path is not evidence of a reachable one. */
  REPAIR_PATH_UNSTATED: 'repair-path-unstated',
  /** The finding names a scope that is neither global nor project. */
  UNKNOWN_SCOPE: 'unknown-scope',
});

/**
 * @typedef {Object} Finding One entry of the set whose repairability is being measured.
 * @property {string} [id] The logical-asset identity the finding attaches to, echoed back.
 * @property {string} harness The harness the finding belongs to.
 * @property {'global'|'project'} scope The scope whose copy the remedy would have to change.
 * @property {string} [repairPath] The remedy's path. `'reconcile'` means the existing repair
 *   command; anything else, including absence, means this component cannot claim a remedy for it.
 */

/**
 * @typedef {Object} ScopeCoverage Per-scope pin state and its share of the counts.
 * @property {'global'|'project'} scope
 * @property {'absent'|'empty'|'present'} lock Whether a lock exists, exists but pins no target, or
 *   pins at least one. `reconcile` treats the first two identically; they are kept distinct here
 *   because they mean different things to a reader — never installed in this scope versus pinned
 *   down to nothing.
 * @property {boolean} pinned True only for `lock: 'present'`. Rule 2 above.
 * @property {string[]} targets The harnesses the lock pins, in the lock's own order.
 * @property {number} findings How many of the findings named this scope.
 * @property {number} repairable How many of those the repair path can act on.
 */

/**
 * @typedef {Object} RepairCoverage The `REPAIR_COVERAGE` entity.
 * @property {number} findings Total findings considered.
 * @property {number} repairable How many the existing repair path can act on.
 * @property {number} unrepairable The remainder — the number FR-006 exists to surface.
 * @property {boolean} complete Whether every finding is repairable. Vacuously true for no findings.
 * @property {{global: ScopeCoverage, project: ScopeCoverage}} scopes
 * @property {Object<string, number>} reasons Count per `REPAIR_REASONS` value; absent reasons are
 *   omitted rather than reported as zero.
 * @property {Array<{id: string|null, harness: string|null, scope: string|null, repairable: boolean,
 *   reason: string|null}>} details One row per finding, input order preserved.
 * @property {string} summary One legible sentence stating the gap.
 */

/** The harnesses a lock document pins, and how it pins them. Mirrors `reconcile`'s own reading:
 * a missing lock and a lock with an empty `targets` array are equally unable to repair anything. */
function scopePin(scope, lock) {
  const targets = Array.isArray(lock?.targets)
    ? lock.targets.map((entry) => entry?.harness).filter((harness) => typeof harness === 'string' && harness !== '')
    : [];
  const state = !lock ? 'absent' : (targets.length === 0 ? 'empty' : 'present');
  return { scope, lock: state, pinned: state === 'present', targets, findings: 0, repairable: 0 };
}

/** Decide one finding against the pins. Repair-path reach is tested before lock reach: a finding
 * no command performs is unreachable for a more fundamental reason than a narrow pin, and naming
 * the pin would imply widening it is the fix. */
function classify(finding, pins) {
  const pin = pins[finding?.scope];
  if (!pin) return { repairable: false, reason: REPAIR_REASONS.UNKNOWN_SCOPE };
  const declared = finding.repairPath;
  if (typeof declared !== 'string' || declared === '') {
    return { repairable: false, reason: REPAIR_REASONS.REPAIR_PATH_UNSTATED };
  }
  if (declared !== RECONCILE) return { repairable: false, reason: REPAIR_REASONS.OUTSIDE_REPAIR_PATH };
  if (!pin.pinned) return { repairable: false, reason: REPAIR_REASONS.SCOPE_NOT_PINNED };
  if (!pin.targets.includes(finding.harness)) {
    return { repairable: false, reason: REPAIR_REASONS.HARNESS_NOT_PINNED };
  }
  return { repairable: true, reason: null };
}

/** One sentence a reader meets before the detail, so the gap cannot be missed by someone who does
 * not read the counts. States what is repairable and by what; never suggests a way to widen it. */
function summarize(total, repairable) {
  if (total === 0) return 'No findings — repair coverage does not arise.';
  if (repairable === total) {
    return `All ${total} finding(s) are repairable by \`doflow reconcile\`.`;
  }
  return `${repairable} of ${total} finding(s) are repairable by \`doflow reconcile\`; `
    + `${total - repairable} have no available remedy from it.`;
}

/**
 * Read both scopes' lock documents. The one impure function here, separated so `repairCoverage`
 * stays pure and testable without a filesystem.
 *
 * @param {Object} options
 * @param {string} options.projectRoot Root of the project scope.
 * @param {string} [options.homeDir] Root of the global scope. Unlike the lifecycle view (design
 *   R7), the lockfile reader takes this as a parameter, so a hermetic test needs no home-directory
 *   relocation here.
 * @param {Object} [io]
 * @param {Object} [io.fsImpl] Filesystem implementation, threaded to `readLock`.
 * @returns {{global: Object|null, project: Object|null}} A lock document per scope, or `null` where
 *   no lock exists — which is the state rule 2 turns into zero coverage, not full coverage.
 * @throws when a lock file exists but cannot be parsed or validated. Propagated deliberately:
 *   `reconcile` would fail on the same document, so guessing its reach would be fiction.
 */
function readScopeLocks({ projectRoot, homeDir = os.homedir() }, { fsImpl } = {}) {
  return {
    global: readLock({ scope: 'global', homeDir }, { fsImpl }),
    project: readLock({ scope: 'project', projectRoot }, { fsImpl }),
  };
}

/**
 * Compare the report's findings against what the locks pin.
 *
 * @param {Object} options
 * @param {Finding[]} [options.findings] The findings the report makes.
 * @param {{global?: Object|null, project?: Object|null}} [options.locks] Lock documents per scope,
 *   as `readScopeLocks` returns them. A missing or `null` entry is an unpinned scope.
 * @returns {RepairCoverage}
 */
function repairCoverage({ findings = [], locks = {} } = {}) {
  const rows = Array.isArray(findings) ? findings : [];
  const pins = Object.fromEntries(SCOPES.map((scope) => [scope, scopePin(scope, locks?.[scope] ?? null)]));

  const reasons = {};
  const details = rows.map((finding) => {
    const { repairable, reason } = classify(finding, pins);
    const pin = pins[finding?.scope];
    if (pin) {
      pin.findings += 1;
      if (repairable) pin.repairable += 1;
    }
    if (reason) reasons[reason] = (reasons[reason] ?? 0) + 1;
    return {
      id: finding?.id ?? null,
      harness: finding?.harness ?? null,
      scope: finding?.scope ?? null,
      repairable,
      reason,
    };
  });

  const repairable = details.filter((row) => row.repairable).length;
  return {
    findings: details.length,
    repairable,
    unrepairable: details.length - repairable,
    complete: repairable === details.length,
    scopes: pins,
    reasons,
    details,
    summary: summarize(details.length, repairable),
  };
}

module.exports = { repairCoverage, readScopeLocks, REPAIR_REASONS, SCOPES };
