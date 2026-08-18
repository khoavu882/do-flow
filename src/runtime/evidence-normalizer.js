'use strict';

/**
 * Provider-output normalizer — the delta between the Python evidence modules
 * (`core/shared/scripts/doflow/evidence/normalizer.py` and `provenance.py`) and the JavaScript
 * evidence layer that already exists (plan task B.3).
 *
 * Most of the Python evidence tree was already superseded, and porting it wholesale would have
 * duplicated working code:
 *   - `claim_builder.py` → `claims.js`, which is strictly richer (freshness-aware statuses,
 *     bidirectional evidence links, persistence). Its one genuine discrimination — a claim with
 *     only contradicting evidence is REJECTED, not CONFLICTED — was ported into `claims.js`.
 *   - `context_pack.py` → `context-pack.js`, which is richer everywhere except one field:
 *     `verificationRequirements`, carried from the task's acceptance criteria. Ported there.
 *   - `provenance.py` → a three-line factory over a parallel vocabulary
 *     (DIRECT/EXTRACTED/INFERRED/GENERATED) that `evidence-ledger.js` already covers with
 *     `kind` × `provenance` × `source`. Only the vocabulary mapping was worth keeping; it lives in
 *     this file, because this is where provider output crosses into the ledger.
 *   - `normalizer.py` → genuinely absent from JavaScript: nothing turned raw provider output into
 *     ledger-shaped records, and nothing suppressed the same snippet arriving from two providers.
 *     That is what this module is.
 *
 * One defect in `normalizer.py` is fixed rather than reproduced: it minted ids as `EV-001`,
 * `EV-002`… from the *raw* input index, so two separate `normalize()` calls both produced `EV-001`
 * and the second silently overwrote the first in any id-keyed store — while skipped items left
 * gaps that made the numbering look meaningful when it was not. Ids here are derived from the
 * content hash, which makes them stable, collision-free across batches, and idempotent: the same
 * snippet normalized twice is the same record, which is the point of deduplicating at all.
 *
 * The Python's `relevance` and `reliability` floats are not carried over, for the reason set out
 * in `retrieval-bridge.js`: they were per-code-path constants restating the provenance, and FR-008
 * forbids writing retrieval relevance into a confidence field.
 */

const crypto = require('node:crypto');

/**
 * Provider id → the registry capability it serves and the evidence kind its output is.
 * Provider ids match `core/registry/capabilities.yaml`, so a normalized record can be traced back
 * to the capability that produced it.
 */
const PROVIDER_MAP = Object.freeze({
  'semble.search': { capability: 'code.semantic-search', kind: 'semantic-retrieval' },
  'graphify.query': { capability: 'code.relationships', kind: 'structural' },
  'git.native': { capability: 'history.search', kind: 'historical' },
  'native.rg': { capability: 'code.exact-search', kind: 'exact-search' },
  'native.test': { capability: 'behavior.verify', kind: 'test-result' },
});

/** Fallback when the record names a source but no known provider. */
const SOURCE_KIND = Object.freeze({
  SEMBLE: 'semantic-retrieval',
  GRAPHIFY: 'structural',
  GIT: 'historical',
  FILESYSTEM: 'exact-search',
  TESTS: 'test-result',
});

/**
 * The Python's four-value provenance vocabulary mapped onto the ledger's three.
 * DIRECT and EXTRACTED both mean "this came out of the repository or a tool reading it", which is
 * `extracted`; INFERRED and GENERATED both mean "something derived this", which is `inferred`.
 * The finer DIRECT/EXTRACTED distinction survives untouched inside `source.provenanceKind`, so
 * nothing is lost by the narrowing.
 */
const PROVENANCE_MAP = Object.freeze({
  DIRECT: 'extracted',
  EXTRACTED: 'extracted',
  INFERRED: 'inferred',
  GENERATED: 'inferred',
});

/** Least-wrong kind for retrieved text from a provider nothing knows about: it is prose that came
 * from somewhere, which is what `documentation` means in the ledger's vocabulary. */
const FALLBACK_KIND = 'documentation';

/**
 * @param {string} content
 * @returns {string} first 16 hex characters of the content's SHA-256
 */
function contentHash(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

class EvidenceNormalizer {
  /**
   * @param {Object} [options]
   * @param {string} [options.taskId='default'] task the produced records belong to
   */
  constructor(options = {}) {
    this.taskId = options.taskId || 'default';
    // Instance state, as in the Python: dedup spans every call this normalizer makes, so a symbol
    // retrieved by Semble and then again by ripgrep is recorded once.
    this.seenHashes = new Set();
  }

  /**
   * Converts raw provider items into records `EvidenceLedger.addEvidence` accepts.
   * @param {Array<Object>} rawItems items as `retrieval-bridge.js` emits them
   * @param {Object} [options]
   * @param {string} [options.taskId] overrides the constructor's task id for this batch
   * @returns {Array<Object>} normalized, deduplicated records
   */
  normalize(rawItems, { taskId } = {}) {
    if (!Array.isArray(rawItems)) return [];
    const owner = taskId || this.taskId;
    const normalized = [];

    for (const item of rawItems) {
      if (!item || typeof item !== 'object') continue;
      const content = typeof item.content === 'string' ? item.content.trim() : '';
      if (!content) continue;

      const hash = contentHash(content);
      if (this.seenHashes.has(hash)) continue;
      this.seenHashes.add(hash);

      const rawProvenance = item.provenance || {};
      const provider = rawProvenance.provider || 'unknown';
      const mapped = PROVIDER_MAP[provider];
      const provenanceKind = rawProvenance.type || 'DIRECT';

      normalized.push({
        id: `ev_${hash}`,
        taskId: owner,
        kind: item.kind || (mapped && mapped.kind) || SOURCE_KIND[item.source] || FALLBACK_KIND,
        source: {
          provider,
          capability: (mapped && mapped.capability) || 'general',
          // The DIRECT/EXTRACTED/INFERRED/GENERATED distinction the ledger's three-value
          // `provenance` field cannot express, kept alongside it rather than thrown away.
          provenanceKind,
          method: rawProvenance.method || 'direct',
        },
        locator: item.locator || {},
        provenance: PROVENANCE_MAP[provenanceKind] || 'extracted',
        content,
        freshness: {
          observedAt: new Date().toISOString(),
          status: 'FRESH',
        },
        supports: [],
        contradicts: [],
      });
    }

    return normalized;
  }

  /** Forgets what has been seen, so the same content can be recorded again for a new task. */
  reset() {
    this.seenHashes.clear();
  }
}

module.exports = {
  EvidenceNormalizer,
  PROVIDER_MAP,
  PROVENANCE_MAP,
  contentHash,
};
