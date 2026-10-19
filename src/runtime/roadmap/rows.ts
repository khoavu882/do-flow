'use strict';

/**
 * Roadmap rows: pure data model, seed parser, status derivation, pick table,
 * markdown table render, and integrity check (feature 108, IC-001, IC-002, IC-003; FR-001, FR-002, FR-003).
 */

const fs = require('node:fs');
const path = require('node:path');

function safeText(value: any): string {
  let text: string;
  if (typeof value === 'string') {
    try {
      text = JSON.stringify(value).slice(1, -1)
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
    } catch {
      text = '';
    }
  } else {
    try {
      const encoded = JSON.stringify(value);
      text = encoded === undefined ? 'undefined' : encoded;
    } catch {
      text = '[unserializable]';
    }
  }
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

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
  intent?: string;
  acceptance?: string[];
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
    | 'seed-typed-status'
    | 'seed-invalid-json'
    | 'seed-invalid'
    | 'seed-unknown-key'
    | 'class-unknown'
    | 'needs-cycle'
    | 'id-exists'
    | 'row-not-found'
    | 'row-started';
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

const SEED_RULES = [
  'seed-invalid-json',
  'seed-invalid',
  'seed-unknown-key',
  'seed-typed-status',
  'slug-id-mismatch',
  'duplicate-id',
  'class-unknown',
  'needs-unresolved',
  'needs-cycle',
  'id-exists',
  'row-not-found',
  'row-started',
] as const;

const TOP_KEYS: readonly string[] = ['schema', 'layout', 'rows'];
const ROW_KEYS: readonly string[] = [
  'id',
  'slug',
  'title',
  'class',
  'needs',
  'writeSet',
  'requires',
  'hold',
  'verifyArgv',
  'mergeCommit',
  'intent',
  'acceptance',
];

let _cachedRegistryClasses: string[] | null = null;

function registryClasses(): string[] {
  if (_cachedRegistryClasses === null) {
    const registryPath = path.join(__dirname, '../../../core/registry/workflows.json');
    const doc = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    _cachedRegistryClasses = Object.keys(doc.classes || {});
  }
  return _cachedRegistryClasses;
}

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

interface SeedFindingItem {
  rowPos: number;
  ruleIdx: number;
  seq: number;
  finding: CheckFinding;
}

/**
 * Validates a roadmap seed document (store or draft) without throwing.
 * Returns every finding in stable IC-006 order.
 */
function seedFindings(
  rawDoc: any,
  opts?: { classes?: string[]; draft?: boolean }
): CheckFinding[] {
  let doc: any;
  if (typeof rawDoc === 'string') {
    try {
      doc = JSON.parse(rawDoc);
    } catch (err: any) {
      return [
        {
          rule: 'seed-invalid-json',
          message: `Seed is not valid JSON: ${safeText(err.message)}`,
        },
      ];
    }
  } else {
    doc = rawDoc;
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return [
      {
        rule: 'seed-invalid',
        message: 'Seed must be an object',
      },
    ];
  }

  const isDraft = Boolean(opts?.draft);
  const items: SeedFindingItem[] = [];
  let seq = 0;

  const add = (
    rowPos: number,
    rule: (typeof SEED_RULES)[number],
    message: string,
    rowId?: string,
    rowIds?: string[]
  ) => {
    const finding: CheckFinding = { rule, message };
    if (rowId !== undefined) finding.rowId = rowId;
    if (rowIds !== undefined) finding.rowIds = rowIds;
    items.push({
      rowPos,
      ruleIdx: SEED_RULES.indexOf(rule),
      seq: ++seq,
      finding,
    });
  };

  // Document level checks (rowPos = -1)
  // Top-level key status/phase/evidence -> seed-typed-status
  for (const k of Object.keys(doc)) {
    if (FORBIDDEN_KEYS.has(k)) {
      add(-1, 'seed-typed-status', `Top-level seed declares forbidden key '${safeText(k)}'`);
    }
  }

  // Any other key not in TOP_KEYS -> seed-unknown-key
  // In draft mode TOP_KEYS is only schema and rows, so layout is seed-unknown-key
  const allowedTop = isDraft ? new Set(['schema', 'rows']) : new Set(TOP_KEYS);
  for (const k of Object.keys(doc)) {
    if (!FORBIDDEN_KEYS.has(k) && !allowedTop.has(k)) {
      add(-1, 'seed-unknown-key', `Top-level seed declares unknown key '${safeText(k)}'`);
    }
  }

  // In draft mode additionally schema must be exactly 1
  if (isDraft && doc.schema !== 1) {
    add(-1, 'seed-invalid', `Draft 'schema' must be 1, got ${safeText(doc.schema)}`);
  } else if (!isDraft && doc.schema !== 1) {
    add(-1, 'seed-invalid', "Seed 'schema' must be 1");
  }

  // rows not an array -> seed-invalid ("rows must be an array")
  if (!Array.isArray(doc.rows)) {
    add(-1, 'seed-invalid', "Seed 'rows' must be an array");
    items.sort((a, b) => a.rowPos - b.rowPos || a.ruleIdx - b.ruleIdx || a.seq - b.seq);
    return items.map((x) => x.finding);
  }

  // In draft mode additionally rows non-empty
  if (isDraft && doc.rows.length === 0) {
    add(-1, 'seed-invalid', "Draft 'rows' must not be empty");
  }

  // Row level checks
  const rowKeySet = new Set(ROW_KEYS);
  const validClasses = opts?.classes ?? registryClasses();
  const validClassSet = new Set(validClasses);

  const seenIds = new Set<string>();
  const allRowIds = new Set<string>();
  for (const r of doc.rows) {
    if (r && typeof r === 'object' && typeof r.id === 'string') {
      allRowIds.add(r.id);
    }
  }

  for (let idx = 0; idx < doc.rows.length; idx++) {
    const row = doc.rows[idx];
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      add(idx, 'seed-invalid', 'Each row must be an object');
      continue;
    }

    const rowId = typeof row.id === 'string' ? row.id : undefined;

    // 1. seed-invalid:
    // title: must be a non-empty single-line string (no \r \n U+2028 U+2029) of at most 120 characters (count with Array.from)
    if (
      typeof row.title !== 'string' ||
      row.title.trim().length === 0 ||
      Array.from(row.title).length > 120 ||
      /[\r\n\u2028\u2029]/.test(row.title)
    ) {
      add(
        idx,
        'seed-invalid',
        `Row '${safeText(rowId ?? 'unknown')}' title must be a non-empty single-line string of at most 120 characters`,
        rowId
      );
    }

    // needs: if present must be an array of strings (the key may be absent)
    if (
      row.needs !== undefined &&
      (!Array.isArray(row.needs) || !row.needs.every((n: any) => typeof n === 'string'))
    ) {
      add(
        idx,
        'seed-invalid',
        `Row '${safeText(rowId ?? 'unknown')}' needs must be an array of strings`,
        rowId
      );
    }

    // writeSet: if present, an array of 1 to 32 canonical repo-relative paths.
    if (row.writeSet !== undefined && validWriteSet(row.writeSet) === null) {
      add(
        idx,
        'seed-invalid',
        `Row '${safeText(rowId ?? 'unknown')}' writeSet must be 1 to 32 repo-relative paths with no leading slash, drive letter, backslash, empty, '.' or '..' segment`,
        rowId
      );
    }

    // requires: if present an array of non-empty strings
    if (
      row.requires !== undefined &&
      (!Array.isArray(row.requires) ||
        !row.requires.every((s: any) => typeof s === 'string' && s.trim().length > 0))
    ) {
      add(
        idx,
        'seed-invalid',
        `Row '${safeText(rowId ?? 'unknown')}' requires must be an array of non-empty strings`,
        rowId
      );
    }

    // hold: as today (non-empty single-line string at most 120 chars)
    if (
      row.hold !== undefined &&
      (typeof row.hold !== 'string' ||
        row.hold.trim().length === 0 ||
        Array.from(row.hold).length > 120 ||
        /[\r\n\u2028\u2029]/.test(row.hold))
    ) {
      add(
        idx,
        'seed-invalid',
        `Row '${safeText(rowId ?? 'unknown')}' hold must be a non-empty single-line string of at most 120 characters`,
        rowId
      );
    }

    // verifyArgv: as today (1 to 8 non-empty strings)
    if (
      row.verifyArgv !== undefined &&
      (!Array.isArray(row.verifyArgv) ||
        row.verifyArgv.length === 0 ||
        row.verifyArgv.length > 8 ||
        !row.verifyArgv.every((arg: any) => typeof arg === 'string' && arg.trim().length > 0))
    ) {
      add(
        idx,
        'seed-invalid',
        `Row '${safeText(rowId ?? 'unknown')}' verifyArgv must be 1 to 8 non-empty strings`,
        rowId
      );
    }

    // mergeCommit: if present a 40-hex lowercase string (store mode only)
    if (!isDraft && row.mergeCommit !== undefined) {
      if (typeof row.mergeCommit !== 'string' || !/^[0-9a-f]{40}$/.test(row.mergeCommit)) {
        add(
          idx,
          'seed-invalid',
          `Row '${safeText(rowId ?? 'unknown')}' mergeCommit must be a 40-hex lowercase string`,
          rowId
        );
      }
    }

    // intent: if present a non-empty single-line string at most 200 characters
    if (
      row.intent !== undefined &&
      (typeof row.intent !== 'string' ||
        row.intent.trim().length === 0 ||
        Array.from(row.intent).length > 200 ||
        /[\r\n\u2028\u2029]/.test(row.intent))
    ) {
      add(
        idx,
        'seed-invalid',
        `Row '${safeText(rowId ?? 'unknown')}' intent must be a non-empty single-line string of at most 200 characters`,
        rowId
      );
    }

    // acceptance: if present an array of 1 to 8 non-empty single-line strings, each at most 200 characters
    if (
      row.acceptance !== undefined &&
      (!Array.isArray(row.acceptance) ||
        row.acceptance.length < 1 ||
        row.acceptance.length > 8 ||
        !row.acceptance.every(
          (s: any) =>
            typeof s === 'string' &&
            s.trim().length > 0 &&
            Array.from(s).length <= 200 &&
            !/[\r\n\u2028\u2029]/.test(s)
        ))
    ) {
      add(
        idx,
        'seed-invalid',
        `Row '${safeText(rowId ?? 'unknown')}' acceptance must be an array of 1 to 8 non-empty single-line strings of at most 200 characters`,
        rowId
      );
    }

    // 2. seed-unknown-key: a key not in ROW_KEYS (excluding forbidden keys and draft mergeCommit)
    for (const k of Object.keys(row)) {
      if (!FORBIDDEN_KEYS.has(k) && !(isDraft && k === 'mergeCommit') && !rowKeySet.has(k)) {
        add(idx, 'seed-unknown-key', `Row '${safeText(rowId ?? 'unknown')}' declares unknown key '${safeText(k)}'`, rowId);
      }
    }

    // 3. seed-typed-status: key status/phase/evidence; in draft mode also a mergeCommit key
    for (const k of Object.keys(row)) {
      if (FORBIDDEN_KEYS.has(k)) {
        add(idx, 'seed-typed-status', `Row '${safeText(rowId ?? 'unknown')}' declares forbidden key '${safeText(k)}'`, rowId);
      }
    }
    if (isDraft && 'mergeCommit' in row) {
      add(idx, 'seed-typed-status', `Draft row '${safeText(rowId ?? 'unknown')}' declares forbidden key 'mergeCommit'`, rowId);
    }

    // 4. slug-id-mismatch: id not matching pattern or slug not starting with id-
    if (typeof row.id !== 'string' || !ID_PATTERN.test(row.id)) {
      add(
        idx,
        'slug-id-mismatch',
        `Row id '${safeText(row.id)}' does not match pattern ^[0-9]{3}([a-z]|-[A-Z])?$`,
        rowId
      );
    } else if (typeof row.slug !== 'string' || !row.slug.startsWith(`${row.id}-`)) {
      add(
        idx,
        'slug-id-mismatch',
        `Row slug '${safeText(row.slug)}' must start with '${safeText(row.id)}-'`,
        rowId
      );
    }

    // 5. duplicate-id: reported on each repeated occurrence of an already-seen id (the later row)
    if (typeof row.id === 'string' && ID_PATTERN.test(row.id)) {
      if (seenIds.has(row.id)) {
        add(idx, 'duplicate-id', `Duplicate row id: ${safeText(row.id)}`, rowId);
      } else {
        seenIds.add(row.id);
      }
    }

    // 6. class-unknown: class not a string in opts.classes ?? registryClasses(); message lists the valid set
    if (typeof row.class !== 'string' || !validClassSet.has(row.class)) {
      add(
        idx,
        'class-unknown',
        `Row '${safeText(rowId ?? 'unknown')}' class '${safeText(row.class)}' is unknown; valid classes: ${validClasses.join(', ')}`,
        rowId
      );
    }

    // 7. needs-unresolved (skipped in draft mode)
    if (!isDraft && Array.isArray(row.needs)) {
      for (const need of row.needs) {
        if (typeof need === 'string' && !allRowIds.has(need)) {
          add(
            idx,
            'needs-unresolved',
            `Row '${safeText(rowId ?? 'unknown')}' declares unresolved need '${safeText(need)}'`,
            rowId
          );
        }
      }
    }
  }

  // 8. needs-cycle (skipped in draft mode)
  if (!isDraft) {
    const firstRowById = new Map<string, { row: any; docPos: number }>();
    const firstRowList: Array<{ row: any; docPos: number }> = [];

    for (let idx = 0; idx < doc.rows.length; idx++) {
      const r = doc.rows[idx];
      if (r && typeof r === 'object' && typeof r.id === 'string') {
        if (!firstRowById.has(r.id)) {
          const entry = { row: r, docPos: idx };
          firstRowById.set(r.id, entry);
          firstRowList.push(entry);
        }
      }
    }

    const WHITE = 0;
    const GRAY = 1;
    const BLACK = 2;
    const color = new Map<string, number>();
    const callStack: string[] = [];
    const seenCycleKeys = new Set<string>();

    const dfs = (u: string) => {
      color.set(u, GRAY);
      callStack.push(u);

      const entry = firstRowById.get(u);
      const uNeeds = entry && Array.isArray(entry.row.needs) ? entry.row.needs : [];

      for (const v of uNeeds) {
        if (typeof v !== 'string' || !firstRowById.has(v)) continue;
        const vColor = color.get(v) ?? WHITE;
        if (vColor === GRAY) {
          // Cycle found
          const cycleStartIdx = callStack.indexOf(v);
          const cyclePath = callStack.slice(cycleStartIdx);

          let minPos = Infinity;
          let minIdx = 0;
          for (let i = 0; i < cyclePath.length; i++) {
            const pos = firstRowById.get(cyclePath[i])!.docPos;
            if (pos < minPos) {
              minPos = pos;
              minIdx = i;
            }
          }
          const canonicalPath = cyclePath.slice(minIdx).concat(cyclePath.slice(0, minIdx));
          const cycleKey = canonicalPath.join('->');
          if (!seenCycleKeys.has(cycleKey)) {
            seenCycleKeys.add(cycleKey);
            const msg = `needs cycle ${canonicalPath.map(safeText).join(' -> ')} -> ${safeText(canonicalPath[0])}`;
            add(minPos, 'needs-cycle', msg, undefined, canonicalPath);
          }
        } else if (vColor === WHITE) {
          dfs(v);
        }
      }

      callStack.pop();
      color.set(u, BLACK);
    };

    for (const entry of firstRowList) {
      if ((color.get(entry.row.id) ?? WHITE) === WHITE) {
        dfs(entry.row.id);
      }
    }
  }

  // Sort findings: document-level (-1) first, then by rowPos, then by ruleIdx, then seq
  items.sort((a, b) => a.rowPos - b.rowPos || a.ruleIdx - b.ruleIdx || a.seq - b.seq);
  return items.map((x) => x.finding);
}

/**
 * Validates and parses rows.json seed data.
 * Throws SeedParseError for the first finding if any finding exists.
 */
function parseSeed(raw: string | any): RoadmapSeed {
  const findings = seedFindings(raw, {});
  if (findings.length > 0) {
    const first = findings[0];
    throw new SeedParseError(first.rule, first.message, first.rowId ?? first.rowIds?.[0]);
  }
  const doc = typeof raw === 'string' ? JSON.parse(raw) : raw;
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

function validWriteSet(value: any): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 32) return null;
  const canonical = (entry: any): entry is string => {
    if (typeof entry !== 'string' || entry.trim().length === 0 || entry.startsWith('/') || /^[A-Za-z]:/.test(entry) || entry.includes('\\')) {
      return false;
    }
    const withoutDirectoryMarker = entry.endsWith('/') ? entry.slice(0, -1) : entry;
    return withoutDirectoryMarker.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  };
  return value.every(canonical) ? value : null;
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
  try {
    fsImpl.writeFileSync(tmpPath, content, 'utf8');
    fsImpl.renameSync(tmpPath, roadmapPath);
  } catch (error) {
    try { fsImpl.unlinkSync(tmpPath); } catch { /* ignore temp cleanup failure */ }
    throw error;
  }
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

  // 1. Validate seed with seedFindings
  const seedInput =
    seedRaw !== undefined && seedRaw !== null
      ? seedRaw
      : {
          schema: 1,
          rows: rows.map((r) =>
            r && typeof r === 'object'
              ? { ...r, title: r.title ?? r.slug ?? r.id ?? 'row' }
              : r
          ),
        };
  const seedFindingList = seedFindings(seedInput, {});
  for (const f of seedFindingList) {
    addFinding(f);
  }

  // 2. Compute effectiveRows and rowIdSet for git checks
  let rawObj: any = null;
  if (seedRaw !== undefined && seedRaw !== null) {
    if (typeof seedRaw === 'string') {
      try {
        rawObj = JSON.parse(seedRaw);
      } catch {
        rawObj = null;
      }
    } else {
      rawObj = seedRaw;
    }
  }

  const fallbackRawRows = (rawObj && Array.isArray(rawObj.rows)) ? rawObj.rows : [];
  const effectiveRows = rows.length > 0 ? rows : fallbackRawRows.filter((r: any) => r && typeof r === 'object' && r.id);
  const rowIdSet = new Set<string>(effectiveRows.map((r: any) => r.id));

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
  const storeSeedRules = new Set(SEED_RULES.slice(0, 9));
  const hasSeedErrors = findings.some((f) => storeSeedRules.has(f.rule as any));
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
  safeText,
  validWriteSet,
  pathsOverlap,
  writeSetsOverlap,
  deriveStatus,
  pick,
  render,
  renderRoadmapFile,
  check,
  seedFindings,
  registryClasses,
  SEED_RULES,
  ROW_KEYS,
  TOP_KEYS,
};
