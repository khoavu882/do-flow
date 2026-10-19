'use strict';

/**
 * Roadmap rows: pure data model, seed parser, status derivation, pick table,
 * markdown table render, and integrity check (feature 108, IC-001, IC-002, IC-003; FR-001, FR-002, FR-003).
 */

const fs = require('node:fs');
const path = require('node:path');

interface SeedLayout {
  worktree?: string;
  branch?: string;
}

interface RoadmapRow {
  id: string;
  slug: string;
  title: string;
  class: string;
  needs: string[];
  writeSet?: string[];
  requires?: string[];
  mergeCommit?: string;
  hold?: string;
  verifyArgv?: string[];
}

interface RoadmapSeed {
  schema: number;
  layout?: SeedLayout;
  rows: RoadmapRow[];
}

interface GitMergeCommit {
  sha: string;
  parents: string[];
  rowTrailer?: string | null;
}

interface GitFacts {
  developHead?: string;
  merges?: GitMergeCommit[];
  branches?: string[];
  commits?: Array<{ sha: string; parents: string[] }>;
  unreadable?: string[];
}

interface RowStatusInfo {
  rowId: string;
  status: 'merged' | 'in-flight' | 'not-started';
  evidence: {
    kind: 'trailer' | 'seeded';
    sha: string;
    shortSha: string;
  } | null;
  holdReason?: string | null;
}

interface DerivedStatusResult {
  statuses: Map<string, RowStatusInfo>;
  rowStatus: Record<string, 'merged' | 'in-flight' | 'not-started'>;
}

interface PickResult {
  picked: RoadmapRow | null;
  skips: Record<string, string>;
}

interface CheckFinding {
  rule:
    | 'render-drift'
    | 'duplicate-merge'
    | 'trailer-unknown-row'
    | 'commit-claimed-twice'
    | 'trailered-and-seeded'
    | 'pointer-not-merge'
    | 'needs-unresolved'
    | 'duplicate-id'
    | 'slug-id-mismatch'
    | 'seed-typed-status';
  message: string;
  rowId?: string;
  rowIds?: string[];
}

interface CheckResult {
  ok: boolean;
  findings: CheckFinding[];
  offendingRowIds: string[];
}

const ID_PATTERN = /^[0-9]{3}([a-z]|-[A-Z])?$/;
const FORBIDDEN_KEYS = new Set(['status', 'phase', 'evidence']);

class SeedParseError extends Error {
  code: string;
  rowId?: string;
  constructor(code: string, message: string, rowId?: string) {
    super(message);
    this.name = 'SeedParseError';
    this.code = code;
    this.rowId = rowId;
  }
}

/**
 * Validates and parses rows.json seed data.
 * Rejects status, phase, evidence (seed-typed-status), bad id/slug, duplicate id, unresolved needs.
 */
function parseSeed(raw: string | any): RoadmapSeed {
  let doc: any;
  if (typeof raw === 'string') {
    try {
      doc = JSON.parse(raw);
    } catch (err: any) {
      throw new SeedParseError('seed-invalid-json', `Seed is not valid JSON: ${err.message}`);
    }
  } else {
    doc = raw;
  }

  if (!doc || typeof doc !== 'object') {
    throw new SeedParseError('seed-invalid', 'Seed must be an object');
  }

  // Reject typed status on top-level
  for (const k of Object.keys(doc)) {
    if (FORBIDDEN_KEYS.has(k)) {
      throw new SeedParseError('seed-typed-status', `Top-level seed declares forbidden key '${k}'`);
    }
  }

  if (!Array.isArray(doc.rows)) {
    throw new SeedParseError('seed-invalid', "Seed 'rows' must be an array");
  }

  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();

  for (const row of doc.rows) {
    if (!row || typeof row !== 'object') {
      throw new SeedParseError('seed-invalid', 'Each row must be an object');
    }

    for (const k of Object.keys(row)) {
      if (FORBIDDEN_KEYS.has(k)) {
        throw new SeedParseError('seed-typed-status', `Row '${row.id || 'unknown'}' declares forbidden key '${k}'`, row.id);
      }
    }

    if (typeof row.id !== 'string' || !ID_PATTERN.test(row.id)) {
      throw new SeedParseError('slug-id-mismatch', `Row id '${row.id}' does not match pattern ^[0-9]{3}([a-z]|-[A-Z])?$`, row.id);
    }

    if (typeof row.slug !== 'string' || !row.slug.startsWith(`${row.id}-`)) {
      throw new SeedParseError('slug-id-mismatch', `Row slug '${row.slug}' must start with '${row.id}-'`, row.id);
    }

    if (seenIds.has(row.id)) {
      duplicateIds.add(row.id);
    } else {
      seenIds.add(row.id);
    }

    if (row.needs && !Array.isArray(row.needs)) {
      throw new SeedParseError('seed-invalid', `Row '${row.id}' needs must be an array of strings`, row.id);
    }

    if (row.hold !== undefined && (typeof row.hold !== 'string' || row.hold.trim().length === 0
      || Array.from(row.hold).length > 120 || /[\r\n\u2028\u2029]/.test(row.hold))) {
      throw new SeedParseError('seed-invalid', `Row '${row.id}' hold must be a non-empty single-line string of at most 120 characters`, row.id);
    }

    // The argv the loop gives `dispatch start --verify-argv` (108 G.3 B2); data, never a shell string.
    if (row.verifyArgv !== undefined && (!Array.isArray(row.verifyArgv) || row.verifyArgv.length === 0 || row.verifyArgv.length > 8
      || !row.verifyArgv.every((arg: any) => typeof arg === 'string' && arg.trim().length > 0))) {
      throw new SeedParseError('seed-invalid', `Row '${row.id}' verifyArgv must be 1 to 8 non-empty strings`, row.id);
    }
  }

  if (duplicateIds.size > 0) {
    const firstDup = Array.from(duplicateIds)[0];
    throw new SeedParseError('duplicate-id', `Duplicate row id: ${firstDup}`, firstDup);
  }

  // Check unresolved needs
  for (const row of doc.rows) {
    for (const need of row.needs || []) {
      if (!seenIds.has(need)) {
        throw new SeedParseError('needs-unresolved', `Row '${row.id}' declares unresolved need '${need}'`, row.id);
      }
    }
  }

  return doc as RoadmapSeed;
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/^\//, '');
}

function pathsOverlap(p1: string, p2: string): boolean {
  const n1 = normalizePath(p1);
  const n2 = normalizePath(p2);
  if (n1 === n2) return true;
  if (n1.endsWith('/')) {
    if (n2.startsWith(n1)) return true;
  } else {
    if (n2.startsWith(`${n1}/`)) return true;
  }
  if (n2.endsWith('/')) {
    if (n1.startsWith(n2)) return true;
  } else {
    if (n1.startsWith(`${n2}/`)) return true;
  }
  return false;
}

function writeSetsOverlap(ws1?: string[], ws2?: string[]): boolean {
  if (!ws1 || !ws2 || ws1.length === 0 || ws2.length === 0) return false;
  for (const p1 of ws1) {
    for (const p2 of ws2) {
      if (pathsOverlap(p1, p2)) return true;
    }
  }
  return false;
}

/**
 * Derives the status of each row from git facts only (merges and `feat/<slug>` branches); the run
 * record's holds and pauses are machine state, which `status` shows separately (C11, C19).
 * Trailed merges in git develop history take precedence; subjects are NEVER evidence.
 */
function deriveStatus(
  rows: RoadmapRow[],
  gitFacts: GitFacts = {}
): DerivedStatusResult {
  const statuses = new Map<string, RowStatusInfo>();
  const rowStatus: Record<string, 'merged' | 'in-flight' | 'not-started'> = {};

  // Group 2-parent first-parent merges on develop by DoFlow-Row trailer value
  const trailerMergesByRow = new Map<string, GitMergeCommit[]>();
  for (const m of gitFacts.merges || []) {
    if (m.parents && m.parents.length === 2 && m.rowTrailer) {
      const rowId = m.rowTrailer.trim();
      if (!trailerMergesByRow.has(rowId)) trailerMergesByRow.set(rowId, []);
      trailerMergesByRow.get(rowId)!.push(m);
    }
  }

  for (const row of rows) {
    let status: 'merged' | 'in-flight' | 'not-started' = 'not-started';
    let evidence: { kind: 'trailer' | 'seeded'; sha: string; shortSha: string } | null = null;
    let holdReason: string | null = null;

    const trailerMerges = trailerMergesByRow.get(row.id) || [];
    if (trailerMerges.length > 0) {
      status = 'merged';
      const m = trailerMerges[0];
      evidence = {
        kind: 'trailer',
        sha: m.sha,
        shortSha: m.sha.slice(0, 7),
      };
    } else if (row.mergeCommit) {
      // Must be a 2-parent first-parent merge in git develop history
      const matchingMerge = (gitFacts.merges || []).find(
        (m) => m.sha === row.mergeCommit && m.parents && m.parents.length === 2
      );
      if (matchingMerge) {
        status = 'merged';
        evidence = {
          kind: 'seeded',
          sha: row.mergeCommit,
          shortSha: row.mergeCommit.slice(0, 7),
        };
      }
    }

    if (status !== 'merged') {
      const branchName = `feat/${row.slug}`;
      const branchExists =
        (gitFacts.branches || []).includes(branchName) ||
        (gitFacts.branches || []).includes(`refs/heads/${branchName}`);

      if (branchExists) status = 'in-flight';
    }

    // A seed-level hold is reported for unmerged rows.
    if (status !== 'merged' && row.hold) holdReason = row.hold;

    const info: RowStatusInfo = {
      rowId: row.id,
      status,
      evidence,
      holdReason,
    };
    statuses.set(row.id, info);
    rowStatus[row.id] = status;
  }

  return { statuses, rowStatus };
}

/**
 * S1 Pick table: chooses the next ready row in seed order.
 * - Ready only when all needs are merged
 * - Write set disjoint from all in-flight rows
 * - WIP bound (default 2)
 * - Row without a write set runs alone
 * - Non-feature class is class-unsupported
 * - Yields one reason per skipped row
 */
function pick(
  rows: RoadmapRow[],
  statuses: Map<string, RowStatusInfo> | Record<string, RowStatusInfo | string>,
  options: { wip?: number } = {}
): PickResult {
  const wip = options.wip ?? 2;
  const getStatus = (id: string): string => {
    if (statuses instanceof Map) {
      return statuses.get(id)?.status || 'not-started';
    }
    const val = statuses[id];
    if (typeof val === 'string') return val;
    return val?.status || 'not-started';
  };

  const inFlightRows = rows.filter((r) => getStatus(r.id) === 'in-flight');
  const inFlightCount = inFlightRows.length;
  const exclusiveInFlight = inFlightRows.some((r) => !r.writeSet || r.writeSet.length === 0);

  const skips: Record<string, string> = {};
  let picked: RoadmapRow | null = null;

  for (const row of rows) {
    if (row.hold) {
      skips[row.id] = 'row-held';
      continue;
    }

    const status = getStatus(row.id);
    if (status === 'merged' || status === 'in-flight') {
      continue;
    }

    // Class check
    if (row.class !== 'feature') {
      skips[row.id] = 'class-unsupported';
      continue;
    }

    // Dependencies check
    const hasUnmergedNeed = (row.needs || []).some((needId) => getStatus(needId) !== 'merged');
    if (hasUnmergedNeed) {
      skips[row.id] = 'need-unmerged';
      continue;
    }

    // Exclusive in-flight check (another row running alone)
    if (exclusiveInFlight) {
      skips[row.id] = 'exclusive-row-in-flight';
      continue;
    }

    // Candidate has no write set and requires running alone
    const hasNoWriteSet = !row.writeSet || row.writeSet.length === 0;
    if (hasNoWriteSet && inFlightCount > 0) {
      skips[row.id] = 'needs-exclusive';
      continue;
    }

    // Write set collision check
    const overlapping = inFlightRows.find((ifr) => writeSetsOverlap(row.writeSet, ifr.writeSet));
    if (overlapping) {
      skips[row.id] = `write-set-overlap:${overlapping.id}`;
      continue;
    }

    // WIP cap check
    if (inFlightCount >= wip) {
      skips[row.id] = 'wip-full';
      continue;
    }

    // Row is ready!
    if (!picked) {
      picked = row;
    }
  }

  return { picked, skips };
}

/**
 * Renders byte-stable ROADMAP.md markdown table.
 * Columns: Row, Title, Class, Needs, Status, Evidence, Next.
 */
function render(
  rows: RoadmapRow[],
  statuses: Map<string, RowStatusInfo> | Record<string, RowStatusInfo>
): string {
  const getInfo = (id: string): RowStatusInfo => {
    if (statuses instanceof Map) {
      return statuses.get(id) || { rowId: id, status: 'not-started', evidence: null };
    }
    return statuses[id] || { rowId: id, status: 'not-started', evidence: null };
  };

  const pickRes = pick(rows, statuses);

  const lines: string[] = [
    '# Roadmap',
    '',
    '| Row | Title | Class | Needs | Status | Evidence | Next |',
    '|---|---|---|---|---|---|---|',
  ];

  for (const row of rows) {
    const info = getInfo(row.id);
    const needsStr = row.needs && row.needs.length > 0 ? row.needs.join(', ') : '-';
    const statusStr = info.status;

    let evidenceStr = '-';
    if (info.evidence) {
      evidenceStr = `${info.evidence.shortSha} (${info.evidence.kind})`;
    }

    let nextStr = '-';
    if (info.status === 'merged') {
      nextStr = '-';
    } else if (row.hold) {
      nextStr = `held: ${row.hold}`;
    } else if (info.status === 'in-flight') {
      nextStr = info.holdReason || '-';
    } else {
      // not-started
      if (pickRes.picked && pickRes.picked.id === row.id) {
        nextStr = 'pick';
      } else if (pickRes.skips[row.id]) {
        nextStr = pickRes.skips[row.id];
      }
    }

    lines.push(`| ${row.id} | ${row.title} | ${row.class} | ${needsStr} | ${statusStr} | ${evidenceStr} | ${nextStr} |`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Writes rendered table to disk using atomic temp+rename only when bytes differ.
 */
function renderRoadmapFile({
  roadmapPath,
  content,
  fsImpl = fs,
}: {
  roadmapPath: string;
  content: string;
  fsImpl?: any;
}): { written: boolean; bytes: number } {
  let existing: string | null = null;
  try {
    existing = fsImpl.readFileSync(roadmapPath, 'utf8');
  } catch {
    existing = null;
  }

  const bytes = Buffer.byteLength(content, 'utf8');
  if (existing === content) {
    return { written: false, bytes };
  }

  const dir = path.dirname(roadmapPath);
  fsImpl.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, `.tmp-roadmap-${process.pid}-${Date.now()}`);
  fsImpl.writeFileSync(tmpPath, content, 'utf8');
  fsImpl.renameSync(tmpPath, roadmapPath);
  return { written: true, bytes };
}

/**
 * Performs IC-003 integrity check on seed, git facts, and rendered table:
 * 1. render-drift
 * 2. duplicate-merge
 * 3. trailer-unknown-row
 * 4. commit-claimed-twice
 * 5. trailered-and-seeded
 * 6. pointer-not-merge
 * 7. needs-unresolved
 * 8. duplicate-id
 * 9. slug-id-mismatch
 * Plus: seed-typed-status
 */
function check({
  rows = [],
  gitFacts = {},
  rendered = null,
  seedRaw = null,
}: {
  rows?: RoadmapRow[];
  gitFacts?: GitFacts;
  rendered?: string | null;
  seedRaw?: any;
}): CheckResult {
  const findings: CheckFinding[] = [];
  const offendingRowIdsSet = new Set<string>();

  const addFinding = (finding: CheckFinding) => {
    findings.push(finding);
    if (finding.rowId) offendingRowIdsSet.add(finding.rowId);
    if (finding.rowIds) {
      for (const id of finding.rowIds) offendingRowIdsSet.add(id);
    }
  };

  // 1. Check raw seed for typed status / duplicate ids / bad slugs if provided
  let rawObj: any = null;
  if (seedRaw) {
    rawObj = typeof seedRaw === 'string' ? (() => { try { return JSON.parse(seedRaw); } catch { return null; } })() : seedRaw;
    if (rawObj && typeof rawObj === 'object') {
      for (const k of Object.keys(rawObj)) {
        if (FORBIDDEN_KEYS.has(k)) {
          addFinding({
            rule: 'seed-typed-status',
            message: `Top-level seed declares forbidden key '${k}'`,
          });
        }
      }
      if (Array.isArray(rawObj.rows)) {
        const seen = new Set<string>();
        for (const r of rawObj.rows) {
          if (!r || typeof r !== 'object') continue;
          for (const k of Object.keys(r)) {
            if (FORBIDDEN_KEYS.has(k)) {
              addFinding({
                rule: 'seed-typed-status',
                message: `Row '${r.id || 'unknown'}' declares forbidden key '${k}'`,
                rowId: r.id,
              });
            }
          }
          if (r.id) {
            if (seen.has(r.id)) {
              addFinding({
                rule: 'duplicate-id',
                message: `Duplicate row id: ${r.id}`,
                rowId: r.id,
              });
            }
            seen.add(r.id);

            if (!ID_PATTERN.test(r.id)) {
              addFinding({
                rule: 'slug-id-mismatch',
                message: `Invalid row id '${r.id}'`,
                rowId: r.id,
              });
            }
            if (typeof r.slug !== 'string' || !r.slug.startsWith(`${r.id}-`)) {
              addFinding({
                rule: 'slug-id-mismatch',
                message: `Row slug '${r.slug}' does not match id '${r.id}'`,
                rowId: r.id,
              });
            }
          }

          if (Array.isArray(r.needs)) {
            const rawDeclaredIds = new Set(rawObj.rows.map((x: any) => x?.id).filter(Boolean));
            for (const need of r.needs) {
              if (!rawDeclaredIds.has(need)) {
                if (!findings.some((f) => f.rule === 'needs-unresolved' && f.rowId === r.id)) {
                  addFinding({
                    rule: 'needs-unresolved',
                    message: `Row '${r.id || 'unknown'}' declares unresolved need '${need}'`,
                    rowId: r.id,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // 2. Structural checks on parsed rows
  const fallbackRawRows = (rawObj && Array.isArray(rawObj.rows)) ? rawObj.rows : [];
  const effectiveRows = rows.length > 0 ? rows : fallbackRawRows.filter((r: any) => r && typeof r === 'object' && r.id);
  const rowIdSet = new Set<string>(effectiveRows.map((r: any) => r.id));
  const seenRowIds = new Set<string>();

  for (const r of rows) {
    if (seenRowIds.has(r.id)) {
      if (!findings.some((f) => f.rule === 'duplicate-id' && f.rowId === r.id)) {
        addFinding({
          rule: 'duplicate-id',
          message: `Duplicate row id: ${r.id}`,
          rowId: r.id,
        });
      }
    }
    seenRowIds.add(r.id);

    if (!ID_PATTERN.test(r.id) || !r.slug || !r.slug.startsWith(`${r.id}-`)) {
      if (!findings.some((f) => f.rule === 'slug-id-mismatch' && f.rowId === r.id)) {
        addFinding({
          rule: 'slug-id-mismatch',
          message: `Slug '${r.slug}' does not match row id '${r.id}'`,
          rowId: r.id,
        });
      }
    }

    for (const need of r.needs || []) {
      if (!rowIdSet.has(need)) {
        addFinding({
          rule: 'needs-unresolved',
          message: `Row '${r.id}' declares unresolved need '${need}'`,
          rowId: r.id,
        });
      }
    }
  }

  // 3. Git trailer checks
  const trailerMerges = (gitFacts.merges || []).filter(
    (m) => m.parents && m.parents.length === 2 && Boolean(m.rowTrailer)
  );

  const trailerCountByRow = new Map<string, GitMergeCommit[]>();
  for (const m of trailerMerges) {
    const rowId = m.rowTrailer!.trim();
    if (!trailerCountByRow.has(rowId)) trailerCountByRow.set(rowId, []);
    trailerCountByRow.get(rowId)!.push(m);
  }

  for (const [rowId, list] of trailerCountByRow.entries()) {
    if (!rowIdSet.has(rowId)) {
      addFinding({
        rule: 'trailer-unknown-row',
        message: `Merge trailer references unknown row '${rowId}'`,
        rowId,
      });
    }
    if (list.length > 1) {
      addFinding({
        rule: 'duplicate-merge',
        message: `Row '${rowId}' has multiple merge commits (${list.map((x) => x.sha).join(', ')})`,
        rowId,
      });
    }
  }

  // 4. Seeded pointer checks & trailered-and-seeded
  for (const r of effectiveRows) {
    if (r.mergeCommit) {
      // Check if also trailered
      if (trailerCountByRow.has(r.id)) {
        addFinding({
          rule: 'trailered-and-seeded',
          message: `Row '${r.id}' has both mergeCommit and git trailer`,
          rowId: r.id,
        });
      }

      // Check if mergeCommit is a 2-parent first-parent merge
      const isTwoParentMerge = (gitFacts.merges || []).some(
        (m) => m.sha === r.mergeCommit && m.parents && m.parents.length === 2
      );
      if (!isTwoParentMerge) {
        addFinding({
          rule: 'pointer-not-merge',
          message: `Row '${r.id}' seeded mergeCommit '${r.mergeCommit}' is not a first-parent two-parent merge`,
          rowId: r.id,
        });
      }
    }
  }

  // 5. Commit claimed twice
  const commitClaimants = new Map<string, Set<string>>();
  for (const r of effectiveRows) {
    if (r.mergeCommit) {
      if (!commitClaimants.has(r.mergeCommit)) commitClaimants.set(r.mergeCommit, new Set());
      commitClaimants.get(r.mergeCommit)!.add(r.id);
    }
  }
  for (const m of trailerMerges) {
    const rowId = m.rowTrailer!.trim();
    if (!commitClaimants.has(m.sha)) commitClaimants.set(m.sha, new Set());
    commitClaimants.get(m.sha)!.add(rowId);
  }

  for (const [sha, claimants] of commitClaimants.entries()) {
    if (claimants.size > 1) {
      addFinding({
        rule: 'commit-claimed-twice',
        message: `Commit '${sha}' is claimed by multiple rows: ${Array.from(claimants).join(', ')}`,
        rowIds: Array.from(claimants),
      });
    }
  }

  // 6. Render drift check (only when parsed rows are valid without seed syntax errors)
  const hasSeedErrors = findings.some(
    (f) =>
      f.rule === 'seed-typed-status' ||
      f.rule === 'duplicate-id' ||
      f.rule === 'slug-id-mismatch' ||
      f.rule === 'needs-unresolved'
  );
  if (rendered !== undefined && rendered !== null && rows.length > 0 && !hasSeedErrors) {
    const { statuses } = deriveStatus(rows, gitFacts);
    const expected = render(rows, statuses);
    if (rendered !== expected) {
      addFinding({
        rule: 'render-drift',
        message: 'Rendered ROADMAP.md differs from derived status table',
      });
    }
  }

  const offendingRowIds = Array.from(offendingRowIdsSet);
  return {
    ok: findings.length === 0,
    findings,
    offendingRowIds,
  };
}

module.exports = {
  parseSeed,
  pathsOverlap,
  writeSetsOverlap,
  deriveStatus,
  pick,
  render,
  renderRoadmapFile,
  check,
};
