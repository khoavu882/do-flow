'use strict';

/**
 * Roadmap loop verb and CLI handler (feature 108, IC-001; FR-001, FR-002, FR-003, FR-014, FR-024).
 * Actions supported in C.1: render [--check] and status.
 */

const fs = require('node:fs');
const path = require('node:path');
const { listCheckouts } = require('../checkouts.ts');
const {
  parseSeed,
  deriveStatus,
  render,
  renderRoadmapFile,
  check,
} = require('./rows.ts');
const { gatherGitFacts } = require('./facts.ts');
const { readOpenIntents } = require('./merge.ts');

interface RoadmapCommandOptions {
  action?: string;
  check?: boolean;
  json?: boolean;
  run?: string;
  row?: string;
  cwd?: string;
  root?: string;
  seedPath?: string;
  roadmapPath?: string;
  fsImpl?: any;
  gitFacts?: any;
}

function resolveMainRoot(cwd: string = process.cwd()): string {
  try {
    const info = listCheckouts({ cwd });
    if (info && info.ok && info.main) return info.main;
  } catch {
    // fallback
  }
  return path.resolve(cwd);
}

function usageError(message: string, json: boolean = false): number {
  if (json) {
    console.log(JSON.stringify({ error: 'usage', detail: message }));
  } else {
    console.error(`doflow roadmap: error: ${message}`);
  }
  process.exitCode = 2;
  return 2;
}

/**
 * Dispatches roadmap CLI actions: render [--check] and status.
 */
function handleRoadmapCommand(options: RoadmapCommandOptions = {}): number {
  const {
    action,
    check: isCheck = false,
    json = false,
    row: filterRow,
    cwd = process.cwd(),
    fsImpl = fs,
  } = options;

  if (!action || (action !== 'render' && action !== 'status')) {
    return usageError("--action must be 'render' or 'status'", json);
  }

  const root = options.root || resolveMainRoot(cwd);
  const seedFile = options.seedPath || path.join(root, 'agent-docs', 'roadmap', 'rows.json');
  const roadmapFile = options.roadmapPath || path.join(root, 'agent-docs', 'roadmap', 'ROADMAP.md');

  let seedRaw: string | null = null;
  let parsedSeed: any = null;

  try {
    seedRaw = fsImpl.readFileSync(seedFile, 'utf8');
  } catch (err: any) {
    return usageError(`failed to read seed file at ${seedFile}: ${err.message}`, json);
  }

  let seedParseError: any = null;
  try {
    parsedSeed = parseSeed(seedRaw);
  } catch (err: any) {
    seedParseError = err;
    // In render --check, a seed parse error (e.g. typed-status, duplicate-id, needs-unresolved)
    // is recorded as a check finding rather than crashing usage.
    if (!isCheck) {
      return usageError(`invalid seed: ${err.message}`, json);
    }
  }

  const rows = parsedSeed?.rows || [];
  const factsSnapshot = options.gitFacts || gatherGitFacts({ root });

  if (factsSnapshot.unreadable && factsSnapshot.unreadable.length > 0) {
    const detail = factsSnapshot.unreadable.join(', ');
    if (json) {
      console.log(
        JSON.stringify({
          schema: 1,
          action,
          error: 'cannot-read-facts',
          sources: factsSnapshot.unreadable,
          message: `doflow roadmap: cannot read facts: ${detail}`,
        })
      );
    } else {
      console.error(`doflow roadmap: cannot read facts: ${detail}`);
    }
    process.exitCode = 1;
    return 1;
  }

  const { statuses, rowStatus } = deriveStatus(rows, factsSnapshot);

  if (action === 'status') {
    let openIntents: any[];
    try { openIntents = readOpenIntents({ root, fsImpl }); }
    catch (error: any) {
      if (json) console.log(JSON.stringify({ schema: 1, action, error: 'cannot-read-facts', sources: ['merge-intents'], message: error.message }));
      else console.error(`doflow roadmap: cannot read merge-intents: ${error.message}`);
      process.exitCode = 1;
      return 1;
    }
    const displayStatus = (info: any) => openIntents.some((intent) => intent.row === info.rowId && intent.status === 'merged-unverified')
      ? 'merged-unverified' : info.status;
    const displayRows = Array.from(statuses.values() as Iterable<any>).map((info) => ({ ...info, status: displayStatus(info) }));
    const displayRowStatus = { ...rowStatus };
    for (const info of displayRows) displayRowStatus[info.rowId] = info.status;
    if (filterRow) {
      const singleStatus = statuses.get(filterRow);
      if (!singleStatus) {
        if (json) {
          console.log(
            JSON.stringify({
              schema: 1,
              action: 'status',
              error: 'row-not-found',
              row: filterRow,
            })
          );
        } else {
          console.error(`doflow roadmap: row '${filterRow}' not found`);
        }
        process.exitCode = 1;
        return 1;
      }

      if (json) {
        console.log(
          JSON.stringify({
            schema: 1,
            action: 'status',
            row: filterRow,
            status: displayStatus(singleStatus),
            info: singleStatus,
            intent: openIntents.find((intent) => intent.row === filterRow) || null,
          })
        );
      } else {
        console.log(
          `Row ${filterRow}: ${displayStatus(singleStatus)} (evidence: ${
            singleStatus.evidence ? singleStatus.evidence.shortSha : 'none'
          })`
        );
        const intent = openIntents.find((entry) => entry.row === filterRow);
        if (intent) console.log(`  Open merge intent: ${intent.phase}${intent.status ? ` (${intent.status})` : ''}`);
      }
      return 0;
    }

    if (json) {
      console.log(
        JSON.stringify({
          schema: 1,
          action: 'status',
          rowStatus: displayRowStatus,
          rows: displayRows,
          openIntents,
        })
      );
    } else {
      console.log(`Roadmap status (${rows.length} rows):`);
      for (const [id, info] of statuses.entries()) {
        const ev = info.evidence ? `${info.evidence.shortSha} (${info.evidence.kind})` : '-';
        console.log(`  ${id.padEnd(6)} ${displayStatus(info).padEnd(12)} evidence: ${ev}`);
      }
      for (const intent of openIntents) console.log(`  Open merge intent ${intent.row}: ${intent.phase}${intent.status ? ` (${intent.status})` : ''}`);
    }
    return 0;
  }

  if (action === 'render') {
    if (isCheck) {
      let existingContent: string | null = null;
      try {
        existingContent = fsImpl.readFileSync(roadmapFile, 'utf8');
      } catch {
        existingContent = null;
      }

      const checkResult = check({
        rows,
        gitFacts: factsSnapshot,
        rendered: existingContent,
        seedRaw,
      });

      // If parseSeed threw a specific validation error, ensure it is represented
      if (seedParseError && seedParseError.code) {
        if (!checkResult.findings.some((f: any) => f.rule === seedParseError.code)) {
          checkResult.findings.push({
            rule: seedParseError.code as any,
            message: seedParseError.message,
            rowId: seedParseError.rowId,
          });
          if (seedParseError.rowId && !checkResult.offendingRowIds.includes(seedParseError.rowId)) {
            checkResult.offendingRowIds.push(seedParseError.rowId);
          }
          checkResult.ok = false;
        }
      }

      if (checkResult.ok) {
        if (json) {
          console.log(
            JSON.stringify({
              schema: 1,
              action: 'render',
              check: true,
              exit: 0,
              findings: [],
              offendingRowIds: [],
            })
          );
        } else {
          console.log('doflow roadmap: render --check passed (0 findings)');
        }
        return 0;
      }

      if (json) {
        console.log(
          JSON.stringify({
            schema: 1,
            action: 'render',
            check: true,
            exit: 1,
            findings: checkResult.findings,
            offendingRowIds: checkResult.offendingRowIds,
          })
        );
      } else {
        console.error(`doflow roadmap: render --check found ${checkResult.findings.length} issue(s):`);
        for (const f of checkResult.findings) {
          console.error(`  [${f.rule}] ${f.message}`);
        }
      }
      process.exitCode = 1;
      return 1;
    }

    // Normal render: write ROADMAP.md if bytes differ
    const renderedText = render(rows, statuses);
    const { written } = renderRoadmapFile({
      roadmapPath: roadmapFile,
      content: renderedText,
      fsImpl,
    });

    if (json) {
      console.log(
        JSON.stringify({
          schema: 1,
          action: 'render',
          fileWrites: written ? 1 : 0,
          path: path.relative(root, roadmapFile) || roadmapFile,
        })
      );
    } else {
      console.log(
        `doflow roadmap: rendered ${path.relative(root, roadmapFile) || roadmapFile} (${
          written ? '1 file written' : '0 file writes, up to date'
        })`
      );
    }
    return 0;
  }

  return usageError(`unhandled action '${action}'`, json);
}

module.exports = {
  handleRoadmapCommand,
  resolveMainRoot,
};
