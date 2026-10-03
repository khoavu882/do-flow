'use strict';

/**
 * C7 — report assembler and the `inventory` verb (FR-005, FR-008, FR-009; IC-001, IC-002).
 *
 * The five modules beside this one each answer one question about one thing. This module is the
 * only place that puts them together: it reads both scopes once (`read-scopes`), joins the recorded
 * resources into logical assets by a derived key (`identity`), names or withholds a winner per
 * asset (`precedence`), finds the unmanaged files that share a wholesale-loaded directory
 * (`siblings`), and states how much of the result the existing repair path can act on
 * (`coverage`). Nothing here re-implements any of those judgements.
 *
 * **Read-only (NFR-001).** Nothing in this file or below it writes, moves or deletes. `readScopes`
 * reports an absent ledger rather than creating one, `inspectSiblings` only `readdir`s, and
 * `readScopeLocks` only reads. The remedy on each asset entry is text the caller may run; the verb
 * never runs it.
 *
 * Four seams are easy to get wrong here, so each is named where it is crossed:
 *
 * 1. **Two scope vocabularies.** The ledger and `coverage.js` say `global`/`project`; the registry's
 *    `scopePrecedence.order` says `user`/`project` (the same word `registryScope()` uses in
 *    `src/lifecycle/index.js`). `precedence.js` passes both `presentAt` and `winner` through in
 *    whatever vocabulary it was handed, so this module converts on the way in and back on the way
 *    out (`toRegistryScope`/`toReportScope`). Skipping either half produces a verdict naming a scope
 *    the rest of the report never mentions.
 * 2. **`reconcile` is claimed for one finding kind only.** `coverage.js` grades a finding by the
 *    `repairPath` it declares, and FR-006 forbids over-claiming a remedy. A divergence declares
 *    `reconcile`, because converging a scope onto its pin is exactly what heals one. A shadow, a
 *    withheld verdict, an unjudged copy and an unmanaged sibling declare `manual`: each has a literal
 *    remedy — stated on the asset entry — but `reconcile` cannot perform any of them, since it does
 *    not delete a rival copy at the other scope, cannot establish a harness's undocumented precedence,
 *    cannot supply the basis a copy was never judged against, and never touches a file DoFlow did not
 *    install. Declaring `manual` rather than leaving `repairPath`
 *    absent is deliberate: absence classifies as `repair-path-unstated`, whose own definition is
 *    "the finding names no remedy at all", and that would be false of all four.
 * 3. **A finding's unit is the thing the caller must act on, not the number of entries that mention
 *    it.** IC-002 makes the asset entry the place every threatened asset lists an unmanaged file, so
 *    one stray in a directory holding four managed files appears on four entries — correctly. The
 *    `findings` array is a different question, and answers FR-007's, whose unit is the file: one
 *    unmanaged file is one finding however many managed assets share its directory. Emitting one per
 *    (asset, file) pair multiplied the reported problem by the size of the directory and inflated the
 *    FR-006 denominator with it. The same rule sets a withheld verdict's `scope` to `null`: that
 *    finding spans both scopes and belongs to neither, so naming whichever copy sorted first stated
 *    something no computation had established.
 * 4. **A resource whose identity cannot be derived is never dropped.** `deriveAssetIdentity` returns
 *    `null` for a row carrying no harness or no `ownershipIdentity`. `src/lifecycle/index.js`
 *    refuses to record such a row, so no install produces one — but a ledger is a JSON file a user
 *    can hand-edit, so the branch stays reachable. `null` is not a join key — two such rows are not
 *    the same asset — so they cannot become logical-asset entries. They are reported one row each
 *    under `unidentified`,
 *    carrying the same location and currency an asset entry would, plus the reason the cross-scope
 *    question could not be asked of them. They still contribute a divergence finding when their own
 *    copy has diverged, and an unjudged-copy finding when nothing judged it, because neither
 *    judgement needs a cross-scope join.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { harnessFor, loadRegistry } = require('../../registry');
const { readScopes } = require('./read-scopes');
const { deriveAssetIdentity } = require('./identity');
const { resolveShadowVerdict } = require('./precedence');
const { inspectSiblings } = require('./siblings');
const { repairCoverage, readScopeLocks } = require('./coverage');
const { finishRuntime, usageError } = require('../cli-result');

/** The three currency values of IC-002, and never a fourth. The third is not a weaker second: a
 * copy nothing in this scope's plan spoke about has not "diverged", it cannot be judged at all.
 * IC-002 names one condition for the third value — no recorded fingerprint — and `currencyOf` holds
 * three more that are the same absence of a basis rather than a fourth meaning; see its comment. */
const CURRENCY = Object.freeze({
  MATCHES: 'matches',
  DIVERGED: 'diverged',
  INDETERMINABLE: 'indeterminable',
});

/**
 * The finding kinds the report can make. Only the first is reachable by `doflow reconcile`.
 *
 * `UNJUDGED_COPY` is the third `CURRENCY` value raised to a finding, and it is a finding for the
 * reason IC-001 already gives for a withheld verdict: the caller cannot conclude the install is
 * sound. The two statements are the same statement about different questions — a withheld verdict
 * says no scope was established as operative, an unjudged copy says no content comparison was made
 * at all — and IC-001 defines exit 0 positively, as every logical asset resolving to a copy that
 * *matches* what the current source would produce. A copy nothing compared does not satisfy that,
 * so reporting it at exit 0 asserted soundness from the one place the report holds no basis. It is
 * also the case a user most needs told: a malformed native config file makes its adapter refuse a
 * plan, and every copy of that harness silently drops out of evaluation.
 *
 * Ceiling: the grain is the copy, as it is for a divergence, not the copy precedence names the winner.
 * An asset whose global copy matches while its project copy was never judged is still a finding, even
 * where the global copy is the one the harness loads — which copy that is comes from the registry
 * block, and a copy on disk that nothing compared is actionable whether or not it wins today.
 */
const FINDING_KINDS = Object.freeze({
  DIVERGENCE: 'divergence',
  SHADOW: 'shadow',
  WITHHELD_VERDICT: 'withheld-verdict',
  UNJUDGED_COPY: 'unjudged-copy',
  UNMANAGED_SIBLING: 'unmanaged-sibling',
});

/** The one repair path `coverage.js` can measure, and the value it recognises. */
const RECONCILE = 'reconcile';
/** Everything else this report can recommend: a real, stated action no command performs. See the
 * header's note 2 for why this is declared rather than left absent. */
const MANUAL = 'manual';

/** Report vocabulary -> registry vocabulary (`scopePrecedence.order` names the global scope `user`). */
function toRegistryScope(scope) { return scope === 'global' ? 'user' : scope; }
/** Registry vocabulary -> report vocabulary. The inverse of the above, applied to every scope name
 * `precedence.js` hands back, so a verdict never names a scope the rest of the report does not. */
function toReportScope(scope) { return scope === 'user' ? 'global' : scope; }

/** The four fields that identify one recorded resource, and the same four an adapter change carries.
 * Not `ownershipKey` from src/state: that one includes the scope, and a plan change has none. */
function recordKey(record) {
  return [record?.harness, record?.assetId, record?.target, record?.ownershipIdentity].join('\u0000');
}

/**
 * What this scope's plan says about each recorded resource, and which harnesses it spoke about at
 * all — the whole basis a currency judgement has.
 *
 * `changes` keeps the change object, not just its key, because `operation` is the difference between
 * rewriting a resource and deleting it, and only the first is a divergence.
 *
 * `evaluated` exists because absence from `changes` carries two meanings that must not be conflated:
 * a copy-tree file whose destination bytes already equal what the source would produce yields no
 * change at all (`src/adapters/copy-tree.js`, the `unchanged, no-op` branch) — but so does a harness
 * whose plan was never produced. A harness the plan skipped, or whose adapter reported a conflict
 * (`codex: Malformed TOML value` is the live example), emitted a change set that is not a statement
 * of what the current source would write, so a resource missing from it was not examined.
 *
 * Ceiling: `evaluated` is per harness, because that is the grain conflicts are recorded at. One
 * malformed native file makes every resource of that harness indeterminable rather than only the
 * component that could not be planned; narrowing it would mean reproducing each adapter's internal
 * component boundaries here. A prerequisite is deliberately *not* disqualifying — it says the change
 * cannot yet be applied, not that the plan could not determine it.
 */
function planBasis(snapshot) {
  const changes = new Map();
  for (const change of snapshot?.plan?.changes ?? []) {
    if (change && typeof change === 'object') changes.set(recordKey(change), change);
  }
  const evaluated = new Set();
  for (const target of snapshot?.plan?.targets ?? []) {
    if (!target || target.skipped === true || (target.conflicts ?? []).length > 0) continue;
    evaluated.add(target.harness);
  }
  return { changes, evaluated };
}

/**
 * Whether the bytes a planned change would write are the bytes already at its destination.
 *
 * A change is not by itself a statement that the content differs. `src/adapters/copy-tree.js` treats
 * a destination as a no-op only when three things agree — same location, disk bytes equal to the
 * source fingerprint, **and** the recorded ledger row equal to it too — which is right for its own
 * purpose, planning a write that also refreshes the row. It means a change is emitted whenever the
 * row alone is stale, and that happens routinely: the shared hooks asset projects one destination for
 * claude, codex, gemini, kiro and antigravity while ownership is recorded per harness, so a sibling's
 * install legitimately refreshes bytes the other harnesses' rows still describe by their old hash.
 * Reading such a change as divergence reported one file, identical bytes, under contradictory
 * verdicts per harness, with a remedy offering to "restore" a file that was already correct.
 *
 * So the comparison is made against the destination, which is what IC-002's "the content differs"
 * is about, and not against the recorded row — a stale row and a hand edit both make
 * `change.fingerprint !== resource.fingerprint`, so that test cannot tell them apart.
 *
 * Ceiling: this compares a hash of the destination file's whole bytes with the change's fingerprint,
 * so it is decisive only where the fingerprint describes those same bytes — every `copy-tree` asset.
 * An adapter that merges into a user-owned native file fingerprints the managed subset instead
 * (`fingerprint(value)` over a projection, not over the file), so the two never compare equal and
 * such a change stays a divergence, exactly as before. That is the conservative direction: this
 * function can only ever withdraw a divergence claim about bytes it has read and found identical.
 *
 * @returns {boolean} false whenever the destination cannot be read, or the change names no
 *   fingerprint — an absent or unreadable file is no evidence that its content is current.
 */
function contentAlreadyCurrent(change, fsImpl) {
  const intended = change?.fingerprint;
  if (typeof intended !== 'string' || intended === '') return false;
  let observed;
  try { observed = crypto.createHash('sha256').update(fsImpl.readFileSync(change.target)).digest('hex'); }
  catch { return false; }
  // Both spellings are in the corpus: copy-tree records bare hex, several adapters prefix `sha256:`.
  return observed === intended.replace(/^sha256:/, '');
}

/**
 * The `CURRENCY` entity for one recorded copy.
 *
 * Order of the tests is the contract. The absence of a recorded fingerprint comes first, because
 * IC-002 names exactly that condition: a copy with no fingerprint is indeterminable whether or not
 * the plan would touch it. What the plan says comes next, so a resource the plan named explicitly is
 * always judged on that. Only a resource the plan was *silent* about reaches the last tests, and
 * silence is evidence of currency only where the plan actually ran and this row could have appeared
 * in it.
 *
 * Three of the four paths to the third value are not the fingerprint condition IC-002 names. All are
 * the same thing that condition is — no basis for a judgement — rather than a fourth value:
 *
 * - **A planned removal.** The plan would delete this copy rather than rewrite it, so it states
 *   nothing about whether the content is current. Calling that `diverged` is how a correctly
 *   installed, merely deselected resource came to be reported as broken, with a remedy promising to
 *   "restore" it and a plan behind that remedy saying *remove* — the over-claim FR-006 forbids.
 * - **A harness whose plan was not produced.** Reporting `matches` there asserts currency from a
 *   computation that never ran.
 * - **A row no change could be looked up for.** The plan is keyed by four components including the
 *   harness and the ownership identity, so a row missing either — the same absence that makes
 *   `deriveAssetIdentity` return `null` — can never match a change. Its absence from the plan
 *   compared nothing, and reading `matches` out of that absence made the report's *strongest* claim
 *   about the one row nothing had examined, up to and including rows whose file does not exist.
 *
 * A planned *rewrite* is likewise not automatically the second value: see `contentAlreadyCurrent`.
 * A change whose bytes are already on disk leaves the content current, so this returns the first
 * value — the scope holds a full basis here, an affirmative comparison against what the source would
 * produce, which is precisely what the third value is the absence of.
 *
 * @param {Object} resource a recorded resource
 * @param {{changes: Map<string, Object>, evaluated: Set<string>}} basis what the scope's plan says
 * @param {Object} [fsImpl] filesystem implementation, for reading the destination's current bytes
 * @returns {{value: string, reason: string|null, resolution: string|null}} `resolution` is what would
 *   give this scope a basis for judging the copy. It is stated here rather than composed by the remedy
 *   because each of the four paths to the third value needs a different one: a reason and the action
 *   that answers it are one thought, and separating them means matching on reason strings elsewhere.
 *   `null` for the other two values — a copy that was judged needs no basis, and a diverged one's
 *   remedy is the restore `remedyFor` already states.
 */
function currencyOf(resource, basis, fsImpl = fs) {
  const recorded = resource?.fingerprint;
  if (typeof recorded !== 'string' || recorded === '') {
    return {
      value: CURRENCY.INDETERMINABLE,
      reason: 'no fingerprint is recorded for this copy',
      resolution: 'record a fingerprint for it: re-installing this harness at this scope rewrites the copy '
        + 'and records one — or delete the row, if DoFlow no longer owns the copy',
    };
  }
  const change = basis.changes.get(recordKey(resource));
  if (change?.operation === 'remove') {
    return {
      value: CURRENCY.INDETERMINABLE,
      reason: 'this scope\'s plan would remove this copy rather than rewrite it — what the scope '
        + 'records no longer wants it here — so the plan states nothing about whether its content is current',
      resolution: 'settle what this scope records about it: re-select the resource so this scope\'s plan '
        + 'describes its content again, or let the planned removal run. Until one of those happens nothing '
        + 'states what the content should be, so nothing can say whether it is current',
    };
  }
  if (change) {
    if (contentAlreadyCurrent(change, fsImpl)) {
      return {
        value: CURRENCY.MATCHES,
        reason: 'this scope\'s plan would rewrite this copy, but the bytes it would write are already '
          + 'the bytes on disk: the change refreshes what this scope recorded about the copy, not the '
          + 'copy itself, so its content is current',
        resolution: null,
      };
    }
    return {
      value: CURRENCY.DIVERGED,
      reason: 'the current source would produce different content here',
      resolution: null,
    };
  }
  if (!basis.evaluated.has(resource?.harness)) {
    return {
      value: CURRENCY.INDETERMINABLE,
      reason: `no plan was produced for ${resource?.harness ?? 'this harness'} in this scope, so this `
        + 'copy was never compared with what the current source would produce',
      resolution: `resolve whatever stopped the plan for ${resource?.harness ?? 'this harness'} — `
        + '`doflow doctor` and `doflow status` name the adapter conflict, a native config file the adapter '
        + 'could not parse being the usual cause — then re-run `doflow inventory`. Every copy of this '
        + 'harness in this scope is unjudged until its plan runs',
    };
  }
  if (deriveAssetIdentity(resource) === null) {
    return {
      value: CURRENCY.INDETERMINABLE,
      reason: 'this row records no harness or no ownership identity, two of the four components this '
        + 'scope\'s plan is keyed by, so no planned change could ever be looked up for it and its '
        + 'absence from the plan compared nothing',
      resolution: 'repair the recorded row so a planned change can be looked up for it — re-installing '
        + 'this harness at this scope re-records it — or delete the row, if DoFlow no longer owns the '
        + 'copy. No install writes a row in this shape, so this one was hand-edited',
    };
  }
  return { value: CURRENCY.MATCHES, reason: null, resolution: null };
}

/** The literal command that would converge one scope. Text only — this verb never runs it. */
function reconcileCommand(scope, projectRoot) {
  return scope === 'global' ? 'doflow reconcile -g' : `doflow reconcile ${projectRoot}`;
}

/** One copy of a logical asset, as IC-002 requires: where it is, and how current it is — plus, where
 * it could not be judged at all, what would give a later run a basis for judging it. */
function copyEntry(resource, scope, basis, fsImpl) {
  const currency = currencyOf(resource, basis, fsImpl);
  return {
    scope,
    location: resource.target,
    currency: currency.value,
    currencyReason: currency.reason,
    currencyResolution: currency.resolution,
    assetId: resource.assetId,
    ownershipIdentity: resource.ownershipIdentity ?? null,
  };
}

/**
 * Group every recorded resource of both scopes by its derived cross-scope identity.
 *
 * @param {Array<Object>} snapshots the scope snapshots `readScopes` returned
 * @param {Object} [fsImpl] filesystem implementation, threaded to the currency judgement
 * @returns {{groups: Map<string, Object>, unidentified: Array<Object>}} `unidentified` holds one
 *   row per resource whose identity could not be derived — never grouped, since `null` is not a key.
 */
function groupByIdentity(snapshots, fsImpl) {
  const groups = new Map();
  const unidentified = [];
  for (const snapshot of snapshots) {
    const basis = planBasis(snapshot);
    for (const resource of snapshot.resources ?? []) {
      const copy = copyEntry(resource, snapshot.scope, basis, fsImpl);
      const identity = deriveAssetIdentity(resource);
      if (identity === null) {
        unidentified.push({
          ...copy,
          harness: resource.harness ?? null,
          reason: 'this resource records no harness or no ownership identity, so no cross-scope '
            + 'identity could be derived for it and it cannot be compared with a copy at the other '
            + 'scope (IC-004); its own currency is still reported',
        });
        continue;
      }
      if (!groups.has(identity)) {
        groups.set(identity, { identity, harness: resource.harness, assetId: resource.assetId, copies: [] });
      }
      groups.get(identity).copies.push(copy);
    }
  }
  return { groups, unidentified };
}

/** The harness's recorded precedence block, or `null` when it declares none — the fifth IC-003
 * state (the question has not been asked), which `precedence.js` must see as an absence rather than
 * as an empty object it could misread as a block with no mode. */
function precedenceFor(registry, harness) {
  try { return harnessFor(registry, harness).scopePrecedence ?? null; }
  catch { return null; }
}

/** Every unmanaged entry sharing a directory with one of this asset's copies, attributed to the
 * scope whose copy put it in view. Never carries a currency (data model: `UNMANAGED_CANDIDATE`). */
function unmanagedFor(copies, candidatesByTarget) {
  const found = [];
  for (const copy of copies) {
    for (const candidate of candidatesByTarget[copy.location] ?? []) {
      found.push({ ...candidate, scope: copy.scope });
    }
  }
  return found;
}

/** The literal actions that would resolve this asset's findings, in the order a reader should take
 * them. One object per asset (IC-002's "the remedy"), holding every step rather than the first, so
 * an asset that is both diverged and shadowed does not have half its remedy silently dropped. */
function remedyFor({ copies, verdict, unmanaged, projectRoot }) {
  const actions = [];
  for (const copy of copies) {
    if (copy.currency === CURRENCY.DIVERGED) {
      actions.push({
        finding: FINDING_KINDS.DIVERGENCE,
        action: `restore ${copy.location} to what the current source produces`,
        command: reconcileCommand(copy.scope, projectRoot),
      });
    } else if (copy.currency === CURRENCY.INDETERMINABLE) {
      // Never "restore it": nothing here knows what this copy should contain, which is the whole of
      // what makes it unjudged. The action is what would give the next run a basis, which differs per
      // absence — `currencyOf` states it beside the reason, so nothing here matches on reason strings.
      actions.push({
        finding: FINDING_KINDS.UNJUDGED_COPY,
        action: `establish a basis for judging ${copy.location}, which nothing in the ${copy.scope} scope `
          + `compared with what the current source would produce — ${copy.currencyResolution}`,
        command: null,
      });
    }
  }
  if (verdict?.shadowed && verdict.winner) {
    const losers = copies.filter((copy) => copy.scope !== verdict.winner).map((copy) => copy.location);
    actions.push({
      finding: FINDING_KINDS.SHADOW,
      action: `edit the copy the harness actually loads — the ${verdict.winner} one — or delete the `
        + `outranked ${losers.length === 1 ? 'copy' : 'copies'}: ${losers.join(', ')}`,
      command: null,
    });
  }
  if (verdict?.shadowed && !verdict.winner) {
    actions.push({
      finding: FINDING_KINDS.WITHHELD_VERDICT,
      action: `keep exactly one copy — ${copies.map((copy) => copy.location).join(' or ')} — because `
        + `${verdict.withheldReason}, so which one takes effect cannot be stated`,
      command: null,
    });
  }
  for (const candidate of unmanaged) {
    actions.push({
      finding: FINDING_KINDS.UNMANAGED_SIBLING,
      action: `review ${candidate.path}: ${candidate.harness} loads every entry in `
        + `${candidate.parentDir}, so this ${candidate.kind} is live context DoFlow did not install. `
        + 'Move it out of that directory if it should not be',
      command: null,
    });
  }
  if (actions.length === 0) return null;
  return { summary: `${actions.length} action(s) would resolve this entry`, actions };
}

/**
 * The findings this asset contributes, in the shape `coverage.js` grades.
 *
 * `repairPath: 'reconcile'` is set on divergence findings **only**; the other three declare
 * `manual`, which `coverage.js` counts unrepairable with the reason `outside-repair-path`. See the
 * module header's note 2 for why that is not the same as omitting the field.
 *
 * Each finding's `scope` is the scope whose copy a remedy would have to change: a divergence names
 * the diverged copy's scope, a shadow the winning scope (the copy an edit must land on), and an
 * unmanaged sibling the scope whose copy put the directory in view. An unjudged copy names the scope
 * holding it, which is determinate and is the scope the missing basis belongs to — the ledger row, the
 * selection or the refused plan is that scope's. A **withheld verdict names
 * none** — `null`. It is a statement about an asset held at both scopes with no way to say which
 * takes effect, so its remedy ("keep exactly one copy") can be performed at either; naming
 * `copies[0].scope` named the scope `readScopes` happens to read first. `coverage.js` grades a
 * scope-less finding `unknown-scope`, which is the correct verdict — no lock can repair it — reached
 * through a reason whose own definition is "the finding names a scope that is neither global nor
 * project", written for a caller bug rather than for a finding that legitimately owns no scope. A
 * reason of its own belongs to that module, whose write-set this is not; the gap is recorded as a
 * risk in design §7 rather than worked around here by naming a scope that has not been established.
 *
 * @param {Set<string>} seenUnmanaged Unmanaged files already reported by an earlier asset in this
 *   run, keyed harness-and-path. FR-007's unit is the file: the second managed asset sharing a
 *   directory with a stray still **lists** it (IC-002, the asset entry) but no longer emits a second
 *   finding about it. The harness is in the key because a directory two harnesses both load
 *   wholesale makes the same file operative twice, which is two facts.
 */
function findingsFor({ identity, harness, copies, verdict, unmanaged }, seenUnmanaged) {
  const findings = [];
  for (const copy of copies) {
    if (copy.currency === CURRENCY.DIVERGED) {
      findings.push({ id: identity, kind: FINDING_KINDS.DIVERGENCE, harness, scope: copy.scope, repairPath: RECONCILE });
    } else if (copy.currency === CURRENCY.INDETERMINABLE) {
      findings.push({ id: identity, kind: FINDING_KINDS.UNJUDGED_COPY, harness, scope: copy.scope, repairPath: MANUAL });
    }
  }
  if (verdict?.shadowed && verdict.winner) {
    findings.push({ id: identity, kind: FINDING_KINDS.SHADOW, harness, scope: verdict.winner, repairPath: MANUAL });
  }
  if (verdict?.shadowed && !verdict.winner) {
    findings.push({ id: identity, kind: FINDING_KINDS.WITHHELD_VERDICT, harness, scope: null, repairPath: MANUAL });
  }
  for (const candidate of unmanaged) {
    const key = `${candidate.harness} ${candidate.path}`;
    if (seenUnmanaged.has(key)) continue;
    seenUnmanaged.add(key);
    // `path` names the finding's actual subject, because `id` cannot: the stray threatens every
    // managed asset in its directory, and the one named here is simply the first in identity order —
    // the entry whose `remedy` states the action.
    findings.push({
      id: identity, kind: FINDING_KINDS.UNMANAGED_SIBLING, harness, scope: candidate.scope,
      path: candidate.path, repairPath: MANUAL,
    });
  }
  return findings;
}

/** One legible sentence a reader meets before the detail, so the verdict cannot be missed.
 *
 * A restriction to named harnesses is named in the sentence, because the sentence is where a reader
 * decides whether to act. "nothing requires attention" read off a run restricted to one harness — or
 * to a harness that is not installed — would otherwise be taken for a statement about the install. */
function summarize({ findings, assets, unidentified, targets }) {
  const counts = new Map();
  for (const finding of findings) counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  const subject = `${assets.length} logical asset(s)${targets ? ` recorded for ${targets.join(', ')}` : ''}`;
  const trailer = unidentified.length > 0
    ? ` ${unidentified.length} recorded resource(s) carry no derivable cross-scope identity and were `
      + 'reported individually instead of joined.'
    : '';
  if (findings.length === 0) {
    return `${subject} across both scopes; nothing requires attention.${trailer}`;
  }
  const parts = [...counts.entries()].map(([kind, count]) => `${count} ${kind}`).join(', ');
  return `${findings.length} finding(s) across ${subject}: ${parts}.${trailer}`;
}

/**
 * Compose the cross-scope report (IC-002).
 *
 * Field order is the contract's: the verdict first, then the two scope roots each marked present or
 * absent, then one entry per logical asset, then the resources that could not be joined, then the
 * findings, then the repair-coverage statement.
 *
 * **IC-002's last field, the count of unmanaged entries inspected but not individually reported, is
 * deliberately absent.** `inspectSiblings` reads an inspected directory in full and reports every
 * entry in it that DoFlow does not manage, and never reads a directory it does not inspect, so no
 * input can put a number other than 0 in that field. Emitting it anyway stated nothing and read as
 * a reassurance — `0` beside eight reported siblings invites the reading that eight more were held
 * back. IC-002 is amended to drop the field rather than the report satisfying it vacuously (F.3).
 *
 * @param {Object} options
 * @param {string} options.repoRoot Root of the DoFlow source the lifecycle view reads from.
 * @param {string} options.projectRoot Root of the project scope. The global scope's root is derived
 *   from the process home directory and is not a parameter (design R7).
 * @param {string[]} [options.targets] Harnesses to inventory; defaults to every lifecycle harness.
 *   IC-001 makes this a restriction, so it bounds the reported resources as well as the plan: a
 *   harness outside it appears nowhere, rather than appearing with a currency nothing evaluated.
 * @param {Object} [options.registry] A loaded registry, for a caller that already has one.
 * @param {Object} [options.locks] Lock documents per scope, as `readScopeLocks` returns them. Used
 *   twice: to bound the remedy (`coverage.js`) and to supply each scope's recorded MCP selections to
 *   its plan (`read-scopes.js`).
 * @param {Object} [options.fsImpl] Filesystem implementation, threaded to sibling inspection.
 * @returns {Object} the report object
 * @throws when the registry is unreadable, a ledger or a lock is unparseable, or a named harness the
 *   registry does not declare was requested. IC-001 assigns all of these to exit 2 — a lock that
 *   exists but cannot be read is the same class as a ledger that cannot: the report would have to
 *   invent the selection the plan is computed from.
 */
function buildInventoryReport({ repoRoot, projectRoot, targets, registry, locks, fsImpl } = {}) {
  const loaded = registry ?? loadRegistry({ repoRoot });
  const requested = Array.isArray(targets) && targets.length > 0 ? targets : undefined;
  // Validated before anything is read, so an unknown harness fails as the argument error it is
  // rather than as an empty report. harnessFor throws naming the id it did not find.
  for (const harness of requested ?? []) harnessFor(loaded, harness);

  const resolvedProjectRoot = path.resolve(projectRoot ?? '.');
  // One read of the locks, two consumers. `coverage.js` needs them to bound the remedy; `readScopes`
  // needs their MCP selections to compute a plan that describes what is installed rather than one
  // proposing to remove every server the scope chose.
  const resolvedLocks = locks ?? readScopeLocks({ projectRoot: resolvedProjectRoot }, fsImpl ? { fsImpl } : {});
  const { scopes } = readScopes({
    registry: loaded, repoRoot, projectRoot: resolvedProjectRoot, locks: resolvedLocks,
    ...(requested ? { targets: requested } : {}),
  });

  const { groups, unidentified } = groupByIdentity(scopes, fsImpl ?? fs);
  const siblings = inspectSiblings({
    resources: scopes.flatMap((snapshot) => snapshot.resources ?? []),
    ...(fsImpl ? { fsImpl } : {}),
  });

  const assets = [];
  const findings = [];
  // One finding per unmanaged file across the whole report, not per asset that lists it (FR-007;
  // see the header's note 3). Assets are walked in identity order, so which entry carries the
  // finding is deterministic.
  const seenUnmanaged = new Set();
  for (const identity of [...groups.keys()].sort()) {
    const { harness, assetId, copies } = groups.get(identity);
    // Both crossings of the vocabulary seam, in one place: in, then straight back out.
    const raw = resolveShadowVerdict(copies.map((copy) => toRegistryScope(copy.scope)), precedenceFor(loaded, harness));
    const verdict = raw && {
      presentAt: raw.presentAt.map(toReportScope),
      shadowed: raw.shadowed,
      winner: raw.winner === null ? null : toReportScope(raw.winner),
      withheldReason: raw.withheldReason,
    };
    const unmanaged = unmanagedFor(copies, siblings.candidatesByTarget);
    assets.push({
      identity,
      harness,
      assetId,
      copies,
      verdict,
      unmanaged,
      remedy: remedyFor({ copies, verdict, unmanaged, projectRoot: resolvedProjectRoot }),
    });
    findings.push(...findingsFor({ identity, harness, copies, verdict, unmanaged }, seenUnmanaged));
  }

  // An unidentifiable row cannot be joined, so it can never be a shadow or a withheld verdict — but
  // its own copy can still have diverged, and that judgement needs no join. Dropping it would hide
  // a real, repairable finding behind a limitation of the join key. The same holds of the copy nothing
  // judged: a row missing the components the plan is keyed by is the one reaching that state most
  // often, so exempting the unidentified list would exempt the commonest unjudged copy there is. Its
  // remedy is on the row — `currencyResolution` — rather than on an asset entry it has none of.
  for (const row of unidentified) {
    if (row.currency === CURRENCY.DIVERGED) {
      findings.push({ id: null, kind: FINDING_KINDS.DIVERGENCE, harness: row.harness, scope: row.scope, repairPath: RECONCILE });
    } else if (row.currency === CURRENCY.INDETERMINABLE) {
      findings.push({ id: null, kind: FINDING_KINDS.UNJUDGED_COPY, harness: row.harness, scope: row.scope, repairPath: MANUAL });
    }
  }

  const coverage = repairCoverage({ findings, locks: resolvedLocks });

  return {
    status: findings.length === 0 ? 'CLEAN' : 'FINDINGS',
    exitCode: findings.length === 0 ? 0 : 1,
    summary: summarize({ findings, assets, unidentified, targets: requested }),
    scopes: scopes.map((snapshot) => ({
      scope: snapshot.scope,
      root: snapshot.scopeRoot,
      present: snapshot.recorded,
      resources: (snapshot.resources ?? []).length,
    })),
    assets,
    unidentified,
    findings,
    repairCoverage: coverage,
  };
}

/** Human rendering. The same facts as `--json`, in the same order, so neither shape is the one that
 * tells the truth. */
function printReport(report) {
  console.log('\nDoFlow cross-scope inventory:');
  console.log('═'.repeat(78));
  console.log(report.summary);
  for (const scope of report.scopes) {
    console.log(`  ${scope.scope.padEnd(8)} ${scope.present ? 'present' : 'absent '}  ${scope.root} (${scope.resources} resource(s))`);
  }
  for (const asset of report.assets) {
    // An asset with no remedy has no finding, so it is left out for brevity; every asset a reader must
    // act on has one, including an unjudged copy since `remedyFor` states what would let it be judged.
    // A `matches` copy carrying a reason is the one thing this skip still hides — see `currencyOf`'s
    // rewrite-already-on-disk branch — and it is genuinely nothing to act on.
    if (!asset.remedy) continue;
    console.log(`\n  ${asset.identity}`);
    for (const copy of asset.copies) {
      // The reason, not only the value: `indeterminable` alone does not say which of the four absences
      // this is, and the four call for different actions.
      console.log(`    ${copy.scope}: ${copy.location} — ${copy.currency}`
        + `${copy.currencyReason ? ` (${copy.currencyReason})` : ''}`);
    }
    if (asset.verdict?.shadowed) {
      console.log(`    verdict: ${asset.verdict.winner ? `${asset.verdict.winner} wins` : `withheld — ${asset.verdict.withheldReason}`}`);
    }
    for (const action of asset.remedy.actions) {
      console.log(`    remedy: ${action.action}${action.command ? ` (${action.command})` : ''}`);
    }
  }
  if (report.unidentified.length > 0) {
    console.log(`\n  ${report.unidentified.length} resource(s) with no derivable cross-scope identity:`);
    for (const row of report.unidentified) {
      console.log(`    ${row.scope}: ${row.location} — ${row.currency}`
        + `${row.currencyReason ? ` (${row.currencyReason})` : ''}`);
      // These rows carry no asset entry, so the row is the only place their remedy can be stated.
      if (row.currencyResolution) console.log(`      remedy: ${row.currencyResolution}`);
    }
  }
  console.log(`\n  ${report.repairCoverage.summary}`);
  console.log('═'.repeat(78) + '\n');
}

/**
 * The `inventory` verb (IC-001). Reads both scopes and reports; writes nothing.
 *
 * Exit statuses are the seam's existing three, with no fourth meaning: 0 answered and nothing to act
 * on; 1 answered and there is a finding — a shadow, a divergence, an unmanaged contender, a withheld
 * verdict or a copy nothing judged, since the caller cannot conclude the install is sound from any of
 * them; 2 the verb could not do what was asked. Exit 0 is the positive statement IC-001 makes it: every
 * asset resolved to a copy that matches what the current source would produce. A scope with nothing
 * recorded is not an error and never produces 2.
 *
 * @param {Object} options
 * @param {string} options.repoRoot Root of the DoFlow source.
 * @param {string} options.projectRoot Root of the project scope (the optional positional, or cwd).
 * @param {string[]} [options.targets] The optional restriction to named harnesses.
 * @param {boolean} [options.json] The seam's standard machine-readable output flag.
 * @param {boolean} [options.global] The scope selector, accepted by the shared parser and refused
 *   here: reading both scopes is this verb's entire purpose, so honouring a scope flag would make
 *   its one distinguishing behaviour optional, and ignoring one silently would answer a different
 *   question from the one the caller asked.
 * @returns {number} the exit status, already set on the process
 */
function handleInventoryCommand({ repoRoot, projectRoot, targets, json = false, global: globalScope = false } = {}) {
  if (globalScope) {
    return usageError('inventory', '-g/--global is not accepted: this verb reads both scopes in one '
      + 'invocation, which is its entire purpose. Re-run without the flag.', json);
  }

  let report;
  try {
    report = buildInventoryReport({ repoRoot, projectRoot, targets });
  } catch (error) {
    // IC-001 assigns an unreadable registry, an unparseable ledger and an undeclared harness alike
    // to exit 2. A scope with nothing recorded never reaches here — `readScopes` returns it empty.
    return usageError('inventory', error.message, json, error);
  }

  if (json) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  return finishRuntime(report.exitCode);
}

module.exports = {
  buildInventoryReport, handleInventoryCommand, printReport,
  CURRENCY, FINDING_KINDS, RECONCILE, MANUAL,
};
