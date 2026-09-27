'use strict';

/**
 * The precedence resolver (design C4, contract IC-003 consumer, FR-004).
 *
 * Given a logical asset present at one or more scopes and the harness's recorded
 * `scopePrecedence` block (`core/registry/harnesses.json`), names the copy the harness will load —
 * or withholds that verdict and states why. This module is pure and synchronous: it looks at
 * nothing on disk and reads no registry itself: the caller passes the one harness's precedence
 * block, already loaded.
 *
 * **The winner is derived from `order` and `mode` together, never from either alone** (IC-003).
 * An order alone is ambiguous between naming the winner first and naming it last, and the
 * recorded corpus contains both conventions for the same field: `claude` records
 * `["user","project"]` with `mode: "first-wins"` (the first entry, `user`, wins); `copilot`
 * records `["project","user"]` with `mode: "last-wins"` (the *last* entry, `user`, wins — the same
 * winner as `claude`, reached from the opposite order convention); `codex` records
 * `["user","project"]` with `mode: "last-wins"` (the last entry, `project`, wins — a naive
 * first-match reading of that same order would get it backwards).
 *
 * A `merged` mode means the copies are combined rather than chosen between, so no single copy
 * "wins". An `unestablished` mode means the order may be documented (`gemini` documents one) or
 * may not (`pi`, `antigravity` document neither), but either way the rule for choosing between
 * copies is not — so no winner is named. Those two cases are separate states under IC-003 and the
 * withheld reason says which: a documented order with an undocumented winner names the order it
 * knows, an undocumented order says the order itself is unestablished. Neither may report as the
 * other. All are withheld verdicts, never a guessed default
 * (design A3: "if a default is later wanted, it becomes a recorded order with its basis stated,
 * not an implicit fallback").
 *
 * An asset present at only one scope has no verdict to withhold and is not "shadowed" at all: it
 * is reported plainly, with that one scope named as trivially where the harness's copy comes from,
 * regardless of whether the harness has any precedence block, or what it says.
 */

/**
 * @typedef {Object} ShadowVerdict The `SHADOW_VERDICT` entity of the feature's data model.
 * @property {string[]} presentAt The scopes at which this logical asset has a recorded copy, in
 *   the order given by the caller. Always at least one entry.
 * @property {boolean} shadowed Whether more than one scope holds a copy of this asset. `false`
 *   means there is exactly one copy and nothing to resolve between.
 * @property {string|null} winner The scope whose copy the harness will load. Set to the sole
 *   present scope when `shadowed` is `false`; set to the resolved scope when `shadowed` is `true`
 *   and the precedence block names an unambiguous winner (`first-wins`/`last-wins`); `null` exactly
 *   when `shadowed` is `true` and the verdict is withheld.
 * @property {string|null} withheldReason Populated exactly when `winner` is `null`; states why no
 *   winner is named. `null` in every other case, including the un-shadowed case, which never
 *   withholds anything.
 */

/**
 * Resolves the shadow verdict for one logical asset at one harness.
 *
 * @param {string[]} presentScopes The scopes at which a copy of this logical asset is recorded.
 *   Order is not significant here — it is not read as a precedence order, only as "where does a
 *   copy exist". Deduplicated internally; malformed entries (non-string, empty) are dropped.
 * @param {Object|null|undefined} precedence The harness's recorded `scopePrecedence` block
 *   (`core/registry/harnesses.json`), exactly as stored — at minimum `{ mode, order? }` — or
 *   `null`/`undefined` when the harness has none recorded yet (IC-003's fifth state: the question
 *   has not been asked). Never defaulted by this function.
 * @returns {ShadowVerdict|null} `null` when `presentScopes` carries no usable scope name — there is
 *   no asset to resolve a verdict for. Otherwise a `ShadowVerdict`.
 */
function resolveShadowVerdict(presentScopes, precedence) {
  const scopes = Array.isArray(presentScopes)
    ? [...new Set(presentScopes.filter((scope) => typeof scope === 'string' && scope !== ''))]
    : [];
  if (scopes.length === 0) return null;

  if (scopes.length === 1) {
    return { presentAt: scopes, shadowed: false, winner: scopes[0], withheldReason: null };
  }

  // More than one scope holds a copy: a verdict is either named or withheld, never defaulted.
  if (!precedence || typeof precedence !== 'object') {
    return {
      presentAt: scopes,
      shadowed: true,
      winner: null,
      withheldReason: 'no scope-precedence is recorded for this harness',
    };
  }

  const { mode, order } = precedence;

  if (mode === 'merged') {
    return {
      presentAt: scopes,
      shadowed: true,
      winner: null,
      withheldReason: 'the harness merges copies from every scope rather than choosing between them',
    };
  }

  if (mode === 'unestablished') {
    // IC-003 keeps these two states distinct: an order established with the mode explicitly
    // unestablished (`gemini`) is not the same finding as an order sought and found undocumented
    // (`pi`, `antigravity`). Both withhold the verdict; only one of them knows the reading order.
    const orderIsEstablished = Array.isArray(order) && order.length > 0;
    return {
      presentAt: scopes,
      shadowed: true,
      winner: null,
      withheldReason: orderIsEstablished
        ? `the harness's consultation order is established (${order.join(' then ')}) but its rule for choosing between copies is not`
        : "the harness's scope-resolution order is unestablished",
    };
  }

  if (mode === 'first-wins' || mode === 'last-wins') {
    if (!Array.isArray(order) || order.length === 0) {
      return {
        presentAt: scopes,
        shadowed: true,
        winner: null,
        withheldReason: `the harness's precedence block records mode "${mode}" but no consultation order`,
      };
    }
    const winner = mode === 'first-wins' ? order[0] : order[order.length - 1];
    return { presentAt: scopes, shadowed: true, winner, withheldReason: null };
  }

  // An absent or unrecognized mode is never guessed at (IC-003: order alone is ambiguous).
  return {
    presentAt: scopes,
    shadowed: true,
    winner: null,
    withheldReason: `the harness's precedence block records no usable resolution mode (got ${JSON.stringify(mode ?? null)})`,
  };
}

module.exports = { resolveShadowVerdict };
