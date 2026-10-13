'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const { measureFreshness } = require('./freshness.ts');
const { measureTreeState, sourceVersionFor } = require('./source-version.ts');

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
  root: string;
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

  const root = ctx.root || process.cwd();
  const taskId = ctx.taskId || 'default';
  const treeState = ctx.treeState || measureTreeState(root);

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

    let locator = candidate.locator;
    if (typeof locator === 'string') {
      const cli = require('./cli.ts');
      locator = cli.parseLocator ? cli.parseLocator(locator) : { file: locator };
    } else if (locator && typeof locator === 'object' && !Array.isArray(locator)) {
      locator = { ...locator };
    } else {
      locator = {};
    }

    const sv = sourceVersionFor(root, locator, treeState);
    const measuredHash = sv.fileHash;

    if (
      candidate.sourceVersion &&
      candidate.sourceVersion.fileHash !== null &&
      candidate.sourceVersion.fileHash !== undefined
    ) {
      const searchedHash = candidate.sourceVersion.fileHash;
      if (searchedHash !== measuredHash) {
        const file = locator?.file || 'unknown';
        throw new Error(
          `the file changed between the search and this record (${file}: searched ${shortHash(searchedHash)}, now ${shortHash(measuredHash)}). Re-run the search and record the new result.`
        );
      }
    }

    const source: Record<string, any> = {};
    if (candidate.provider !== undefined) source.provider = candidate.provider;
    if (candidate.capability !== undefined) source.capability = candidate.capability;

    if (candidate.need) {
      if (ctx.plan && typeof ctx.plan.resolveNeed === 'function') {
        const res = ctx.plan.resolveNeed(candidate.need);
        if (res && res.queryRef) {
          source.queryRef = res.queryRef;
        }
      } else if (ctx.plan && ctx.plan.planId) {
        source.queryRef = `${ctx.plan.planId}#${candidate.need}`;
      } else {
        source.queryRef = candidate.need;
      }
    }

    if (ctx.attemptRef) {
      source.attemptRef = ctx.attemptRef;
    }

    let establishes: string[] = [];
    if (Array.isArray(ctx.establishes)) {
      establishes = [...ctx.establishes];
    } else if (typeof ctx.establishes === 'string') {
      establishes = ctx.establishes.split(',').map((s) => s.trim());
    }

    return {
      taskId,
      kind: ctx.kind || 'exact-search',
      provenance: ctx.provenance || 'extracted',
      source,
      locator,
      content: ctx.content !== undefined ? ctx.content : null,
      establishes,
      observation: (ctx as any).observation || null,
      freshness: {
        gitCommit: sv.gitCommit,
        fileHash: sv.fileHash,
        observedAt: new Date().toISOString(),
        status: 'FRESH',
        isDirty: sv.isDirty,
      },
    };
  }

  if ('item' in input && input.item !== undefined) {
    const raw = input.item;
    const { validateEvidenceItem } = require('./cli.ts');
    const validated = validateEvidenceItem(raw, taskId, root);
    const sv = sourceVersionFor(root, validated.locator, treeState);

    const source = { ...validated.source };
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

  throw new Error("toEvidence requires either 'candidate' or 'item'");
}

module.exports = {
  CANDIDATE_FIELDS,
  toEvidence,
};
