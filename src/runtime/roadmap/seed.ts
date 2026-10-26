'use strict';

/**
 * Roadmap seed: validator, judgeDraft and handleSeedCommand (feature 113, IC-001..IC-008).
 * Pure judgement of drafts against store rows; person-only refusals; lease-held writes.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sha256Digest, gatherGitFacts } = require('./facts.ts');
const {
  seedFindings,
  safeText,
  validWriteSet,
  SEED_RULES,
  deriveStatus,
  render,
  renderRoadmapFile,
  pathsOverlap,
  writeSetsOverlap,
} = require('./rows.ts');
const {
  acquireLease,
  releaseLease,
  resolveMainRoot,
  noPsAlive,
} = require('./loop.ts');
const { readSeedSwitch } = require('../settings/autopilot.ts');

interface JudgeDraftOptions {
  draftRaw: any;
  seedRaw: any;
  gitFacts?: any;
  op?: string;
  classes?: string[];
}

interface HandleSeedCommandOptions {
  action?: string;
  draft?: string;
  json?: boolean;
  cwd?: string;
  root?: string;
  fsImpl?: any;
  gitFacts?: any;
  readSwitch?: (env?: any, fsImpl?: any) => { enabled: boolean; switch: any };
  alive?: (proc: any) => boolean | 'unknown';
  env?: any;
  pid?: number;
  host?: string;
  now?: () => Date;
  out?: (s: string) => void;
  err?: (s: string) => void;
  classes?: string[];
}

function judgeDraft({
  draftRaw,
  seedRaw,
  gitFacts = {},
  op = 'check',
  classes,
}: JudgeDraftOptions): any {
  let draftDoc: any;
  if (typeof draftRaw === 'string') {
    try {
      draftDoc = JSON.parse(draftRaw);
    } catch (err: any) {
      return {
        schema: 1,
        action: 'seed',
        op,
        ok: false,
        rows: [],
        findings: [
          {
            rule: 'seed-invalid-json',
            message: `Draft is not valid JSON: ${safeText(err.message)}`,
          },
        ],
        overlaps: [],
        alone: [],
      };
    }
  } else {
    draftDoc = draftRaw;
  }

  let seedDoc: any;
  if (typeof seedRaw === 'string') {
    try {
      seedDoc = JSON.parse(seedRaw);
    } catch {
      const storeFindings = seedFindings(seedRaw, { classes });
      return {
        schema: 1,
        action: 'seed',
        op,
        ok: false,
        rows: [],
        findings: storeFindings,
        overlaps: [],
        alone: [],
      };
    }
  } else {
    seedDoc = seedRaw;
  }

  if (!seedDoc || typeof seedDoc !== 'object' || Array.isArray(seedDoc)) {
    const storeFindings = seedFindings(seedDoc, { classes });
    return {
      schema: 1,
      action: 'seed',
      op,
      ok: false,
      rows: [],
      findings: storeFindings,
      overlaps: [],
      alone: [],
    };
  }

  // 2. Draft findings (draft mode checks shape only: keys, field shapes, slug/id, duplicate id, class)
  const draftFindings = seedFindings(draftDoc, { draft: true, classes });
  const storeDocumentFindings = seedFindings(seedDoc, { classes })
    .filter((finding: any) => finding.rowId === undefined && finding.rowIds === undefined);
  const findingKey = (finding: any) => `${finding.rule}|${finding.rowId ?? ''}|${(finding.rowIds || []).join(',')}|${finding.message}`;
  const mergeUnique = (...lists: any[][]) => {
    const seen = new Set<string>();
    return lists.flat().filter((finding) => {
      const key = findingKey(finding);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  if (!Array.isArray(seedDoc.rows)) {
    const findings = mergeUnique(draftFindings, storeDocumentFindings)
      .sort((a: any, b: any) => SEED_RULES.indexOf(a.rule) - SEED_RULES.indexOf(b.rule));
    return {
      schema: 1,
      action: 'seed',
      op,
      ok: false,
      rows: [],
      findings: findings.map((finding: any) => ({ rule: finding.rule, message: finding.message })),
      overlaps: [],
      alone: [],
    };
  }

  // 3. Candidate document = store doc with draft amends replaced in place and draft adds appended
  const storeRows = seedDoc.rows;
  const candidateRows = [...storeRows];
  const storeIndexMap = new Map<string, number>();
  for (let i = 0; i < storeRows.length; i++) {
    const r = storeRows[i];
    if (r && typeof r === 'object' && typeof r.id === 'string') {
      storeIndexMap.set(r.id, i);
    }
  }

  const draftRows = (draftDoc && typeof draftDoc === 'object' && Array.isArray(draftDoc.rows))
    ? draftDoc.rows
    : [];

  for (const dRow of draftRows) {
    if (dRow && typeof dRow === 'object' && typeof dRow.id === 'string') {
      if (storeIndexMap.has(dRow.id)) {
        candidateRows[storeIndexMap.get(dRow.id)!] = dRow;
      } else {
        candidateRows.push(dRow);
      }
    }
  }

  const candidate = {
    ...seedDoc,
    rows: candidateRows,
  };
  const candidateFindings = seedFindings(candidate, { classes });

  // Merge draft and candidate findings, dropping a candidate finding whose key equals one already present
  const mergedFindings: any[] = mergeUnique(draftFindings, storeDocumentFindings, candidateFindings);

  // 4. Per draft row (object with a string id), in draft order:
  //    change = amend when its id is a store row id, else add
  //    status for an amend row = status of STORE row from deriveStatus(storeRows, gitFacts).rowStatus[id]
  const statusSafeRow = (r: any) => r && typeof r === 'object' && !Array.isArray(r) &&
    typeof r.id === 'string' && typeof r.slug === 'string' &&
    (r.mergeCommit === undefined || typeof r.mergeCommit === 'string') &&
    (r.hold === undefined || typeof r.hold === 'string');
  const storeValidRows = storeRows.filter(statusSafeRow);
  const { rowStatus: storeRowStatus } = deriveStatus(storeValidRows, gitFacts);

  const resultRows: any[] = [];
  const opFindings: any[] = [];

  for (const dRow of draftRows) {
    if (!dRow || typeof dRow !== 'object' || typeof dRow.id !== 'string') {
      continue;
    }
    const id = dRow.id;
    const isAmend = storeIndexMap.has(id);
    const change = isAmend ? 'amend' : 'add';

    if (isAmend) {
      const status = storeRowStatus[id] || 'not-started';
      resultRows.push({ id, change, status });

      if (op === 'apply') {
        opFindings.push({
          rule: 'id-exists',
          rowId: id,
          message: `Row '${safeText(id)}' already exists in store; use --action amend to update`,
        });
      } else if (op === 'check' || op === 'amend') {
        if (status === 'merged' || status === 'in-flight') {
          opFindings.push({
            rule: 'row-started',
            rowId: id,
            message: `Row '${safeText(id)}' has status '${safeText(status)}' and cannot be amended`,
          });
        }
      }
    } else {
      resultRows.push({ id, change });

      if (op === 'amend') {
        opFindings.push({
          rule: 'row-not-found',
          rowId: id,
          message: `Row '${safeText(id)}' not found in store; use --action apply to add`,
        });
      }
    }
  }

  // 5. Sort ALL findings:
  //    document-level first; then by candidate row position of rowId (or first rowIds);
  //    then by SEED_RULES index; stable.
  const candidateIdPos = new Map<string, number>();
  for (let i = 0; i < candidateRows.length; i++) {
    const r = candidateRows[i];
    if (r && typeof r === 'object' && typeof r.id === 'string') {
      if (!candidateIdPos.has(r.id)) {
        candidateIdPos.set(r.id, i);
      }
    }
  }

  const allFindings = [...mergedFindings, ...opFindings].map((f, seq) => {
    const targetId = f.rowId ?? (Array.isArray(f.rowIds) && f.rowIds.length > 0 ? f.rowIds[0] : undefined);
    const isDocLevel = targetId === undefined;
    const pos = isDocLevel ? -1 : (candidateIdPos.has(targetId) ? candidateIdPos.get(targetId)! : Infinity);
    const ruleIdx = (SEED_RULES as readonly string[]).indexOf(f.rule);
    return { f, isDocLevel, pos, ruleIdx: ruleIdx >= 0 ? ruleIdx : Infinity, seq };
  });

  allFindings.sort((a, b) => {
    if (a.isDocLevel !== b.isDocLevel) return a.isDocLevel ? -1 : 1;
    if (a.pos !== b.pos) return a.pos - b.pos;
    if (a.ruleIdx !== b.ruleIdx) return a.ruleIdx - b.ruleIdx;
    return a.seq - b.seq;
  });

  const finalFindings = allFindings.map(({ f }) => {
    const out: any = { rule: f.rule };
    if (f.rowId !== undefined) out.rowId = f.rowId;
    if (f.rowIds !== undefined) out.rowIds = f.rowIds;
    out.message = f.message;
    return out;
  });

  // 7. Overlaps: statuses = deriveStatus(candidateValidRows, gitFacts)
  // Pairs (i<j) of rows not merged, with at least one in draft id set, whose writeSets overlap
  const candidateValidRows = candidateRows.filter(statusSafeRow);
  const { rowStatus: candRowStatus } = deriveStatus(candidateValidRows, gitFacts);

  const draftIdSet = new Set<string>();
  for (const dRow of draftRows) {
    if (dRow && typeof dRow === 'object' && typeof dRow.id === 'string') {
      draftIdSet.add(dRow.id);
    }
  }

  const overlaps: any[] = [];
  for (let i = 0; i < candidateValidRows.length; i++) {
    const rI = candidateValidRows[i];
    if (candRowStatus[rI.id] === 'merged') continue;
    for (let j = i + 1; j < candidateValidRows.length; j++) {
      const rJ = candidateValidRows[j];
      if (candRowStatus[rJ.id] === 'merged') continue;
      if (!draftIdSet.has(rI.id) && !draftIdSet.has(rJ.id)) continue;
      const writeSetI = validWriteSet(rI.writeSet);
      const writeSetJ = validWriteSet(rJ.writeSet);
      if (!writeSetI || !writeSetJ || !writeSetsOverlap(writeSetI, writeSetJ)) continue;

      const paths: Array<[string, string]> = [];
      for (const pI of writeSetI) {
        for (const pJ of writeSetJ) {
          if (pathsOverlap(pI, pJ)) {
            paths.push([pI, pJ]);
          }
        }
      }
      paths.sort(([aI, aJ], [bI, bJ]) => {
        if (aI < bI) return -1;
        if (aI > bI) return 1;
        if (aJ < bJ) return -1;
        if (aJ > bJ) return 1;
        return 0;
      });
      overlaps.push({
        rows: [rI.id, rJ.id],
        paths,
      });
    }
  }

  // 8. Alone: draft rows not merged that declare no writeSet or empty one
  const alone: string[] = [];
  const seenAlone = new Set<string>();
  for (const dRow of draftRows) {
    if (dRow && typeof dRow === 'object' && typeof dRow.id === 'string') {
      const id = dRow.id;
      if (seenAlone.has(id)) continue;
      if (candRowStatus[id] !== 'merged') {
        if (validWriteSet(dRow.writeSet) === null) {
          seenAlone.add(id);
          alone.push(id);
        }
      }
    }
  }

  return {
    schema: 1,
    action: 'seed',
    op,
    ok: finalFindings.length === 0,
    rows: resultRows,
    findings: finalFindings,
    overlaps,
    alone,
  };
}

function printTextResult(
  result: any,
  out: (s: string) => void,
  err: (s: string) => void,
  opts?: { refusalDetail?: string }
): void {
  const op = safeText(result.op);
  let statusPart: string;
  if (result.reason) {
    statusPart = `refused: ${safeText(result.reason)}`;
  } else if (result.findings.length === 0) {
    statusPart = 'ok';
  } else {
    statusPart = `${result.findings.length} findings`;
  }

  let addCount = 0;
  let amendCount = 0;
  for (const r of result.rows) {
    if (r.change === 'add') addCount += 1;
    if (r.change === 'amend') amendCount += 1;
  }
  const overlapCount = result.overlaps.length;
  const aloneCount = result.alone.length;

  let line1 = `roadmap seed ${op}: ${statusPart}, ${addCount} add, ${amendCount} amend, ${overlapCount} overlaps, ${aloneCount} alone`;
  if ((op === 'apply' || op === 'amend') && result.ok) {
    line1 += `, ${result.writes} files written`;
    if (Array.isArray(result.proposed) && result.proposed.length > 0) {
      line1 += `, ${result.proposed.length} proposed (autopilot is not verifiably off; with it off, a person runs: doflow roadmap promote ${result.proposed.map(safeText).join(' ')})`;
    }
  }
  if (result.seed && result.seed.sha256 === null) {
    line1 += ', store absent';
  }

  const detailLines: string[] = [];

  // Findings
  for (const f of result.findings) {
    let idPart = '';
    if (Array.isArray(f.rowIds) && f.rowIds.length > 0) {
      idPart = f.rowIds.map(safeText).join(' ');
    } else if (f.rowId) {
      idPart = safeText(f.rowId);
    }
    const rule = safeText(f.rule);
    // seedFindings escapes each raw value as it builds this message; this guards any other
    // finding producer while preserving the full, untruncated prose of valid messages.
    const message = typeof f.message === 'string'
      ? f.message.replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
      : safeText(f.message);
    if (idPart) {
      detailLines.push(`  [${rule}] ${idPart}: ${message}`);
    } else {
      detailLines.push(`  [${rule}] ${message}`);
    }
  }

  // Overlaps
  for (const o of result.overlaps) {
    const pair = o.paths && o.paths.length > 0 ? o.paths[0] : null;
    let pathDesc = '';
    if (pair) {
      const [pA, pB] = pair;
      pathDesc = pA === pB ? safeText(pA) : `${safeText(pA)} ~ ${safeText(pB)}`;
    }
    detailLines.push(`  overlap ${safeText(o.rows[0])} ${safeText(o.rows[1])}: ${pathDesc}`);
  }

  // Refusal single reason line
  if (result.reason && opts?.refusalDetail) {
    detailLines.push(`  ${opts.refusalDetail}`);
  }

  const lines: string[] = [line1];
  let maxDetails = 10;
  if (typeof result.land === 'string') {
    lines.push(`  land (person only): ${result.land}`);
    maxDetails = 9;
  }
  if (detailLines.length <= maxDetails) {
    lines.push(...detailLines);
  } else {
    lines.push(...detailLines.slice(0, maxDetails));
    const cut = detailLines.length - maxDetails;
    lines.push(`  ... ${cut} more (--json)`);
  }

  const printFn = result.ok ? out : err;
  for (const line of lines) {
    printFn(line);
  }
}

function quoteLandArgument(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const LAND_CONTROL_CHARS = /[\u0000-\u001f\u007f\u2028\u2029]/;

function makeLandCommand(op: string, ok: boolean, rows: any[], root: string, draftPath: string): string | null {
  if (op !== 'check' || !ok || !Array.isArray(rows) || rows.length === 0) return null;
  const change = rows[0]?.change;
  if ((change !== 'add' && change !== 'amend') || !rows.every((row) => row?.change === change)) return null;
  const resolvedRoot = path.resolve(root);
  if (LAND_CONTROL_CHARS.test(resolvedRoot) || LAND_CONTROL_CHARS.test(draftPath)) return null;
  const action = change === 'add' ? 'apply' : 'amend';
  return `doflow roadmap seed ${quoteLandArgument(resolvedRoot)} --action ${action} --draft ${quoteLandArgument(draftPath)}`;
}

function handleSeedCommand(options: HandleSeedCommandOptions = {}): number {
  const {
    action,
    draft,
    json = false,
    cwd = process.cwd(),
    root = resolveMainRoot(cwd),
    fsImpl = fs,
    gitFacts,
    readSwitch,
    alive,
    env = process.env,
    pid,
    host,
    now,
    out = (s: string) => console.log(s),
    err = (s: string) => console.error(s),
    classes,
  } = options;

  const usage = (message: string): number => {
    if (json) {
      out(JSON.stringify({ error: 'usage', detail: message }));
    } else {
      err(`doflow roadmap: error: ${message}`);
    }
    return 2;
  };

  // 1. Usage check
  if (!action || !['check', 'apply', 'amend'].includes(action)) {
    return usage('--action must be one of check, apply, amend');
  }
  if (!draft) {
    return usage('--draft <path> is required');
  }

  const absDraftPath = path.resolve(cwd, draft);
  let draftRaw: string;
  try {
    draftRaw = fsImpl.readFileSync(absDraftPath, 'utf8');
  } catch (error: any) {
    return usage(`cannot read draft file '${absDraftPath}': ${error.message}`);
  }

  const storePath = path.join(root, 'agent-docs', 'roadmap', 'rows.json');
  const tablePath = path.join(root, 'agent-docs', 'roadmap', 'ROADMAP.md');
  const emptySeedRaw = JSON.stringify({ schema: 1, rows: [] });

  let seedRaw: string;
  let storeAbsent = false;
  try {
    seedRaw = fsImpl.readFileSync(storePath, 'utf8');
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      seedRaw = emptySeedRaw;
      storeAbsent = true;
    } else {
      return usage(`cannot read store file '${storePath}': ${error.message}`);
    }
  }

  // 2. File digests
  const draftSha = sha256Digest(draftRaw);
  const seedSha = storeAbsent ? null : sha256Digest(seedRaw);

  // 3. Check action
  if (action === 'check') {
    const facts = gitFacts || gatherGitFacts({ root });
    if (facts.unreadable && facts.unreadable.length > 0) {
      if (json) {
        out(
          JSON.stringify({
            schema: 1,
            action: 'seed',
            op: action,
            error: 'cannot-read-facts',
            sources: facts.unreadable,
          })
        );
      } else {
        err(`doflow roadmap seed: cannot read facts: ${facts.unreadable.join(', ')}`);
      }
      return 1;
    }

    const judgement = judgeDraft({
      draftRaw,
      seedRaw,
      gitFacts: facts,
      op: action,
      classes,
    });

    const result = {
      schema: 1,
      action: 'seed',
      op: action,
      ok: judgement.ok,
      draft: { path: absDraftPath, sha256: draftSha },
      seed: { path: storePath, sha256: seedSha },
      rows: judgement.rows,
      findings: judgement.findings,
      overlaps: judgement.overlaps,
      alone: judgement.alone,
      reason: null,
      switch: null,
      writes: 0,
      land: makeLandCommand(action, judgement.ok, judgement.rows, root, absDraftPath),
    };

    if (json) {
      out(JSON.stringify(result));
    } else {
      printTextResult(result, out, err);
    }
    return result.ok ? 0 : 1;
  }

  // 4. Apply / Amend action
  // (a) maint-thin: a seed write is allowed whatever the switch says; while autopilot is not verifiably off (the
  // fail-closed seed reader), every row it adds or amends lands `proposed`, which autopilot never picks or advances
  // until a person runs `roadmap promote`. While it is off, rows land as drafted (ready).
  const switchReader = readSwitch || readSeedSwitch;
  const landProposed = switchReader(env, fsImpl).enabled !== false;

  // (b) Acquire lease
  const leaseDir = path.join(root, '.doflow', 'state', 'roadmap');
  const nowFn = now ? now : () => new Date();
  const nowDate = nowFn();
  const me = {
    schema: 1,
    pid: pid ?? process.pid,
    start: new Date(Date.now() - (process as any).uptime() * 1000).toISOString(),
    host: host ?? os.hostname(),
    runId: null,
    acquiredAt: nowDate.toISOString(),
  };
  const leaseAlive = alive || noPsAlive;
  const lease = acquireLease(leaseDir, me, leaseAlive, fsImpl);
  if (!lease.ok) {
    const holder = lease.holder && typeof lease.holder === 'object' ? lease.holder : null;
    const result = {
      schema: 1,
      action: 'seed',
      op: action,
      ok: false,
      draft: { path: absDraftPath, sha256: draftSha },
      seed: { path: storePath, sha256: seedSha },
      rows: [],
      findings: [],
      overlaps: [],
      alone: [],
      reason: 'lease-held',
      switch: null,
      writes: 0,
      land: null,
    };
    const holderDesc = holder
      ? `pid ${safeText(holder.pid ?? 'unknown')} on ${safeText(holder.host ?? 'unknown')}`
      : 'unknown holder';

    if (json) {
      out(JSON.stringify(result));
    } else {
      printTextResult(result, out, err, {
        refusalDetail: `lease held by ${holderDesc}`,
      });
    }
    return 1;
  }

  // (c) Under lease
  try {
    let freshSeedRaw: string;
    let freshStoreAbsent = false;
    try {
      freshSeedRaw = fsImpl.readFileSync(storePath, 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') {
        freshSeedRaw = emptySeedRaw;
        freshStoreAbsent = true;
      } else {
        return usage(`cannot read store file '${storePath}': ${error.message}`);
      }
    }
    const freshSeedSha = freshStoreAbsent ? null : sha256Digest(freshSeedRaw);

    const facts = gitFacts || gatherGitFacts({ root });
    if (facts.unreadable && facts.unreadable.length > 0) {
      if (json) {
        out(
          JSON.stringify({
            schema: 1,
            action: 'seed',
            op: action,
            error: 'cannot-read-facts',
            sources: facts.unreadable,
          })
        );
      } else {
        err(`doflow roadmap seed: cannot read facts: ${facts.unreadable.join(', ')}`);
      }
      return 1;
    }

    const judgement = judgeDraft({
      draftRaw,
      seedRaw: freshSeedRaw,
      gitFacts: facts,
      op: action,
      classes,
    });

    if (!judgement.ok) {
      const result = {
        schema: 1,
        action: 'seed',
        op: action,
        ok: false,
        draft: { path: absDraftPath, sha256: draftSha },
        seed: { path: storePath, sha256: freshSeedSha },
        rows: judgement.rows,
        findings: judgement.findings,
        overlaps: judgement.overlaps,
        alone: judgement.alone,
        reason: null,
        switch: null,
        writes: 0,
        land: null,
      };

      if (json) {
        out(JSON.stringify(result));
      } else {
        printTextResult(result, out, err);
      }
      return 1;
    }

    // (d) No finding: build new store document and write
    let parsedStore: any;
    try {
      parsedStore = JSON.parse(freshSeedRaw);
    } catch {
      throw new Error('Seed invariant failed after clean judgement: store JSON could not be parsed');
    }
    if (!parsedStore || typeof parsedStore !== 'object' || Array.isArray(parsedStore) || !Array.isArray(parsedStore.rows)) {
      throw new Error('Seed invariant failed after clean judgement: store rows must be an array');
    }
    const storeRows = parsedStore.rows;
    const proposedIds: string[] = [];
    const proposedIf = (row: any): any => {
      if (!landProposed) return row;
      proposedIds.push(row.id);
      return { ...row, proposed: true };
    };
    let newRows: any[];
    if (action === 'apply') {
      const draftAddRows: any[] = [];
      const draftDoc = JSON.parse(draftRaw);
      for (const r of draftDoc.rows || []) {
        if (r && typeof r === 'object' && typeof r.id === 'string') {
          draftAddRows.push(r);
        }
      }
      newRows = [...storeRows, ...draftAddRows.map(proposedIf)];
    } else {
      // amend
      const draftMap = new Map<string, any>();
      const draftDoc = JSON.parse(draftRaw);
      for (const r of draftDoc.rows || []) {
        if (r && typeof r === 'object' && typeof r.id === 'string') {
          draftMap.set(r.id, r);
        }
      }
      newRows = storeRows.map((r: any) => {
        if (r && typeof r === 'object' && draftMap.has(r.id)) {
          return proposedIf(draftMap.get(r.id));
        }
        return r;
      });
    }

    const newStoreDoc = { ...parsedStore, rows: newRows };
    const newStoreRaw = JSON.stringify(newStoreDoc, null, 2) + '\n';

    let writes = 0;
    if (newStoreRaw !== freshSeedRaw) {
      const storeDir = path.dirname(storePath);
      fsImpl.mkdirSync(storeDir, { recursive: true });
      const tmpStorePath = path.join(storeDir, `.tmp-rows-${pid ?? process.pid}-${Date.now()}`);
      try {
        fsImpl.writeFileSync(tmpStorePath, newStoreRaw, 'utf8');
        fsImpl.renameSync(tmpStorePath, storePath);
      } catch (error) {
        try { fsImpl.unlinkSync(tmpStorePath); } catch { /* ignore temp cleanup failure */ }
        throw error;
      }
      writes += 1;
    }

    const { statuses } = deriveStatus(newRows, facts);
    const newTableContent = render(newRows, statuses);
    const tableResult = renderRoadmapFile({
      roadmapPath: tablePath,
      content: newTableContent,
      fsImpl,
    });
    if (tableResult.written) {
      writes += 1;
    }

    const result = {
      schema: 1,
      action: 'seed',
      op: action,
      ok: true,
      draft: { path: absDraftPath, sha256: draftSha },
      seed: { path: storePath, sha256: freshSeedSha },
      rows: judgement.rows,
      findings: [],
      overlaps: judgement.overlaps,
      alone: judgement.alone,
      reason: null,
      switch: null,
      writes,
      land: null,
      proposed: proposedIds,
    };

    if (json) {
      out(JSON.stringify(result));
    } else {
      printTextResult(result, out, err);
    }
    return 0;
  } finally {
    releaseLease(leaseDir, me, fsImpl);
  }
}

interface HandlePromoteCommandOptions {
  ids?: string[];
  json?: boolean;
  root?: string;
  fsImpl?: any;
  gitFacts?: any;
  readSwitch?: (env?: any, fsImpl?: any) => { enabled: boolean; switch: any };
  alive?: (proc: any) => boolean | 'unknown';
  env?: any;
  pid?: number;
  host?: string;
  now?: () => Date;
  out?: (s: string) => void;
  err?: (s: string) => void;
  isTTY?: boolean;
}

/**
 * maint-thin: `roadmap promote <id...>`, person only. A model with a shell controls the environment, so an
 * environment check alone cannot tell a person: pointing XDG_CONFIG_HOME at an empty folder reads as "off". The verb
 * therefore first requires an interactive terminal on stdin (refused `needs-person-tty`, nothing written), then reads
 * the switch with the fail-closed seed reader as a second check: unless autopilot is verifiably off it refuses
 * `needs-person` and writes nothing. Under the roadmap lease it drops the
 * `proposed` mark of every named row, so autopilot may pick it. All or nothing: an unknown id, a row that is not
 * proposed, or a duplicate id is a finding and nothing is written. Exit 0 promoted, 1 refused or findings, 2 usage.
 */
function handlePromoteCommand(options: HandlePromoteCommandOptions = {}): number {
  const {
    ids = [],
    json = false,
    root = resolveMainRoot(process.cwd()),
    fsImpl = fs,
    gitFacts,
    readSwitch,
    alive,
    env = process.env,
    pid,
    host,
    now,
    out = (s: string) => console.log(s),
    err = (s: string) => console.error(s),
    isTTY = process.stdin.isTTY === true,
  } = options;
  const emit = (result: any, code: number, detail?: string): number => {
    if (json) out(JSON.stringify(result));
    else {
      const head = result.ok ? `roadmap promote: ok, ${result.promoted.length} promoted${result.promoted.length ? `: ${result.promoted.map(safeText).join(' ')}` : ''}`
        : result.reason ? `roadmap promote: refused: ${safeText(result.reason)}` : `roadmap promote: ${result.findings.length} findings`;
      (result.ok ? out : err)(head);
      for (const f of result.findings || []) err(`  [${safeText(f.rule)}] ${safeText(f.rowId)}: ${f.message}`);
      if (detail) err(`  ${detail}`);
    }
    return code;
  };
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === 'string' && /^[0-9]{3}([a-z]|-[A-Z])?$/.test(id))) {
    if (json) out(JSON.stringify({ error: 'usage', detail: 'roadmap promote takes one or more row ids' }));
    else err('doflow roadmap: error: roadmap promote takes one or more row ids (e.g. doflow roadmap promote 130 131)');
    return 2;
  }
  const storePath = path.join(root, 'agent-docs', 'roadmap', 'rows.json');
  const tablePath = path.join(root, 'agent-docs', 'roadmap', 'ROADMAP.md');
  const base = { schema: 1, action: 'promote', ok: false, ids, promoted: [] as string[], findings: [] as any[], reason: null as string | null, writes: 0 };

  if (isTTY !== true) {
    return emit({ ...base, reason: 'needs-person-tty' }, 1,
      'promote runs only from an interactive terminal: a person runs doflow roadmap promote in their own shell');
  }
  const switchReader = readSwitch || readSeedSwitch;
  if (switchReader(env, fsImpl).enabled !== false) {
    const { configHome } = require('../config-home.ts');
    const home = configHome(env).dir;
    const homeText = home ? safeText(home) : 'the config home (none resolves: set HOME or XDG_CONFIG_HOME)';
    return emit({ ...base, reason: 'needs-person' }, 1,
      `autopilot is not verifiably off for this config home; a person sets autopilot.enabled to off in ${homeText}/settings.json or creates ${homeText}/autopilot/off, then promotes`);
  }

  const leaseDir = path.join(root, '.doflow', 'state', 'roadmap');
  const nowDate = (now ? now : () => new Date())();
  const me = {
    schema: 1,
    pid: pid ?? process.pid,
    start: new Date(Date.now() - (process as any).uptime() * 1000).toISOString(),
    host: host ?? os.hostname(),
    runId: null,
    acquiredAt: nowDate.toISOString(),
  };
  const lease = acquireLease(leaseDir, me, alive || noPsAlive, fsImpl);
  if (!lease.ok) return emit({ ...base, reason: 'lease-held' }, 1);
  try {
    let raw: string;
    try { raw = fsImpl.readFileSync(storePath, 'utf8'); }
    catch (error: any) { return emit({ ...base, findings: ids.map((id) => ({ rule: 'row-not-found', rowId: id, message: `no store at ${storePath}: ${safeText(error.message)}` })) }, 1); }
    const storeFindings = seedFindings(raw);
    if (storeFindings.length > 0) return emit({ ...base, findings: storeFindings }, 1);
    const doc = JSON.parse(raw);
    const findings: any[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      const row = doc.rows.find((r: any) => r.id === id);
      if (seen.has(id)) findings.push({ rule: 'duplicate-id', rowId: id, message: `Row '${safeText(id)}' is named twice` });
      else if (!row) findings.push({ rule: 'row-not-found', rowId: id, message: `Row '${safeText(id)}' not found in store` });
      else if (row.proposed !== true) findings.push({ rule: 'row-not-proposed', rowId: id, message: `Row '${safeText(id)}' is not proposed` });
      seen.add(id);
    }
    if (findings.length > 0) return emit({ ...base, findings }, 1);
    const rows = doc.rows.map((r: any) => {
      if (!ids.includes(r.id)) return r;
      const { proposed, ...ready } = r;
      return ready;
    });
    const newRaw = JSON.stringify({ ...doc, rows }, null, 2) + '\n';
    let writes = 0;
    const tmp = path.join(path.dirname(storePath), `.tmp-rows-${pid ?? process.pid}-${Date.now()}`);
    try {
      fsImpl.writeFileSync(tmp, newRaw, 'utf8');
      fsImpl.renameSync(tmp, storePath);
    } catch (error) {
      try { fsImpl.unlinkSync(tmp); } catch { /* ignore temp cleanup failure */ }
      throw error;
    }
    writes += 1;
    const facts = gitFacts || gatherGitFacts({ root });
    if (!facts.unreadable || facts.unreadable.length === 0) {
      const { statuses } = deriveStatus(rows, facts);
      if (renderRoadmapFile({ roadmapPath: tablePath, content: render(rows, statuses), fsImpl }).written) writes += 1;
    }
    return emit({ ...base, ok: true, promoted: [...ids], writes }, 0);
  } finally {
    releaseLease(leaseDir, me, fsImpl);
  }
}

module.exports = {
  judgeDraft,
  handleSeedCommand,
  handlePromoteCommand,
};
