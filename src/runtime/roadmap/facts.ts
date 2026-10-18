'use strict';

/**
 * Git facts gathering for roadmap loop (feature 108, IC-003, IC-004; FR-002).
 * Reads only — executes allowed git read verbs via execFileSync, without side effects.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');

interface GitMergeInfo {
  sha: string;
  parents: string[];
  rowTrailer: string | null;
}

interface GatheredGitFacts {
  developHead: string;
  merges: GitMergeInfo[];
  branches: string[];
  claims: string[];
  unreadable: string[];
}

function sha256Digest(content: string | Buffer): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/**
 * Gathers git facts for roadmap status derivation and checking.
 * Uses only allowed read verbs: rev-list, rev-parse, for-each-ref.
 */
function gatherGitFacts({
  root,
  developBranch = 'develop',
}: {
  root: string;
  developBranch?: string;
}): GatheredGitFacts {
  const execOptions = {
    cwd: root,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  };

  const unreadable: string[] = [];
  let developHead = '';
  let developBranchReadable = false;

  try {
    developHead = execFileSync('git', ['-C', root, 'rev-parse', developBranch], execOptions).trim();
    developBranchReadable = true;
  } catch {
    unreadable.push('develop-branch');
  }

  // 1. Read first-parent merges on developBranch
  const merges: GitMergeInfo[] = [];
  if (developBranchReadable) {
    try {
      const revListOut = execFileSync('git', [
        '-C',
        root,
        'rev-list',
        '--no-commit-header',
        '--first-parent',
        '--merges',
        '--format=%H %P%x00%(trailers:key=DoFlow-Row,valueonly)',
        developBranch,
      ], execOptions);

      const lines = revListOut.split('\n');
      let currentRecord: GitMergeInfo | null = null;

      for (const rawLine of lines) {
        if (/^[0-9a-f]{40}( |\0|$)/.test(rawLine)) {
          const nulIdx = rawLine.indexOf('\0');
          let commitPart = rawLine;
          let trailerPart = '';
          if (nulIdx !== -1) {
            commitPart = rawLine.slice(0, nulIdx);
            trailerPart = rawLine.slice(nulIdx + 1);
          }
          const parts = commitPart.trim().split(/\s+/);
          const sha = parts[0];
          const parents = parts.slice(1);
          currentRecord = {
            sha,
            parents,
            rowTrailer: trailerPart.trim() || null,
          };
          merges.push(currentRecord);
        } else if (currentRecord) {
          const continuation = rawLine.trim();
          if (continuation) {
            if (currentRecord.rowTrailer) {
              currentRecord.rowTrailer = `${currentRecord.rowTrailer}\n${continuation}`;
            } else {
              currentRecord.rowTrailer = continuation;
            }
          }
        }
      }
    } catch {
      unreadable.push('merges');
    }
  }

  // 2. Read local branch names
  const branches: string[] = [];
  try {
    const branchesOut = execFileSync('git', [
      '-C',
      root,
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads/',
    ], execOptions);
    for (const rawBranch of branchesOut.split('\n')) {
      const b = rawBranch.trim();
      if (b) branches.push(b);
    }
  } catch {
    unreadable.push('branches');
  }

  // 3. Collect claims from state directory if present
  const claims: string[] = [];
  const claimsDir = path.join(root, '.doflow', 'state', 'claims');
  try {
    const entries = fs.readdirSync(claimsDir);
    for (const ent of entries) {
      if (ent.endsWith('_claims.json')) {
        const taskId = ent.slice(0, -'_claims.json'.length);
        claims.push(taskId);
      }
    }
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') {
      unreadable.push('claims');
    }
  }

  return {
    developHead,
    merges,
    branches,
    claims,
    unreadable,
  };
}

module.exports = {
  gatherGitFacts,
  sha256Digest,
};
