'use strict';

/**
 * The cross-scope logical-asset identity (design C3, contract IC-004).
 *
 * Two recorded resources describe the same logical asset when two parts agree: the harness, and the
 * ownership identity the adapter recorded for that resource. That pair is not a new key — it is the
 * stored ownership key (`src/state/index.js#ownershipKey`, five components) with its two
 * scope-bearing components dropped: the `scope`, which names itself, and the absolute `target`,
 * which differs between a global and a project copy of the same asset by construction. So this is a
 * projection of a key the ledger already holds, not a value reconstructed from a path; nothing is
 * resolved, matched or inferred, and the stored key itself is untouched.
 *
 * Three properties make the ownership identity sufficient, and each is enforced rather than
 * observed:
 *   - **Mandatory** — `src/lifecycle/index.js` throws on an adapter change carrying no
 *     `ownershipIdentity`, so every recorded resource has one.
 *   - **Scope-free** — every adapter composes it from the harness id, a role, and a discriminator
 *     drawn from the source tree; never from a destination path or a scope name. An adapter whose
 *     destination root varies by scope therefore still records the same identity at both scopes.
 *   - **Discriminating within a single file** — the several managed entries inside one Codex
 *     `config.toml` carry different ownership identities, so they stay several logical assets
 *     instead of collapsing into one.
 *
 * The registry asset id is deliberately *not* part of the key: an ownership identity naming a
 * copy-tree entry already embeds the asset id, and one naming an in-place edit is already unique to
 * its harness role, so including it would make identity depend on a registry lookup that can fail
 * for no gain in discrimination. It stays a reported field on every entry.
 *
 * Two alternatives were available and are not sufficient (IC-004):
 *   - The recorded `identity` field (source-relative) is absent on a small number of resources, so
 *     it cannot key every row. It is a different field from `ownershipIdentity`, and unrelated here.
 *   - The destination path taken relative to the harness's registry-declared native directory — the
 *     basis this contract carried until it was revised — is total only over assets copied into a
 *     native directory. The three assets that edit a region of a user-owned file or write at the
 *     harness config root (`guidance.core`, `guidance.codex-pointer`, `claude.settings`) declare no
 *     native directory at all, so that derivation returned nothing for exactly the instruction files
 *     most likely to differ between scopes.
 */

/**
 * Derives the IC-004 cross-scope logical-asset identity for one recorded resource.
 *
 * @param {Object} resource a recorded resource, as read from a neutral ledger: at minimum
 *   `{ harness, ownershipIdentity }`. `scope` and `target` are deliberately not read — they are the
 *   two components the projection drops. `assetId` is not read either (see the header).
 * @returns {string|null} a stable key equal for two resources with the same harness and ownership
 *   identity; `null` when either component is missing or empty. A harness id never contains a space,
 *   so joining on one is injective over the pair. The fail-closed branch is reachable despite the
 *   lifecycle boundary enforcing `ownershipIdentity` on write, because a ledger is a JSON file a
 *   user can hand-edit. `null` is a signal to the caller to report the row as unresolved, never a
 *   value to join or compare against another `null`.
 */
function deriveAssetIdentity(resource) {
  if (!resource || typeof resource !== 'object') return null;
  const { harness, ownershipIdentity } = resource;
  if (typeof harness !== 'string' || harness === '') return null;
  if (typeof ownershipIdentity !== 'string' || ownershipIdentity === '') return null;

  return [harness, ownershipIdentity].join(' ');
}

module.exports = { deriveAssetIdentity };
