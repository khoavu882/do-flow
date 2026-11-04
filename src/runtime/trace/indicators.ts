'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * Workflow indicators over the orchestration record (feature 033).
 *
 * Why this is not part of `stats`: a run-ledger record carries exactly `timestamp`, `verb`,
 * `exit_code`, `duration_ms` and `arg_count`. It names no task, no stage and no class, so no amount of
 * extending `stats` can answer "how long from discovery to plan" — the data is not in that file. The
 * orchestrator writes a different one, per task, and that is what this reads.
 *
 * What it deliberately does not do:
 *
 * - No score, grade, percentage or confidence. The shipped guidance forbids expressing evidence that
 *   way, and one figure over stages that do unlike work would hide exactly what the report is for.
 * - No git, pull-request or CI indicators. The record holds none of that data, and inventing a proxy
 *   would be worse than the gap.
 * - No writes. The correctness of every figure here rests on the record being untouched by reading it.
 *
 * One honest limitation, stated in the output as well as here: the record marks when a stage
 * *completed*, never when it began. A stage's figure is therefore the interval since the previous
 * recorded event, which includes whatever time passed before that stage started. Fixing that needs the
 * orchestrator to record starts, which this feature deliberately does not change.
 */

const fs = require('node:fs');
const path = require('node:path');
const { formatMs, finish } = require('./render.ts');

const ORCHESTRATION_DIRNAME = 'orchestration';

/** Mirrors resolveRunsLocation's shape, for the sibling state directory this reads. */
function orchestrationDir(root: string): string {
  return path.join(root, '.doflow', 'state', ORCHESTRATION_DIRNAME);
}

function parseAt(value: any): number | null {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Every run the `list` action shows (flat and namespaced, this checkout and the other ones, each
 * logical run once), plus the ones that could not be read, named with a fixed reason. A file that
 * cannot be read is counted and named rather than skipped: a report that quietly drops what it could
 * not read overstates its own coverage, which is the defect `malformedLines` already guards against
 * for runs. The reason is never the error's own text, which can carry a path or file bytes. */
function readRecords(root: string): any {
  const { orchestrationRuns, runEntriesAt, selectRunEntries, runStoreDir } = require('../implementation-gate.ts');
  const listed = orchestrationRuns({ stateRoot: root });
  const unreadable: any[] = [];
  let entries: any[];
  if (listed.ok) entries = selectRunEntries(listed.entries);
  else {
    entries = selectRunEntries(runEntriesAt(root, 'current'));
    unreadable.push({ file: '(other checkouts)', reason: 'could not be listed' });
  }
  const records: any[] = [];
  for (const entry of entries) {
    const name = entry.origin === 'other' ? entry.file : path.relative(runStoreDir(entry.root), entry.file);
    if (entry.error) {
      unreadable.push({ file: name, reason: entry.error === 'io' ? 'not a regular file' : 'not valid JSON' });
    } else if (!entry.record || typeof entry.record !== 'object' || !entry.record.taskId) {
      unreadable.push({ file: name, reason: 'not an orchestration record' });
    } else {
      records.push(entry.record);
    }
  }
  return { records, unreadable, exists: entries.length > 0 || fs.existsSync(orchestrationDir(root)) };
}

/** A stage row is "not work done" when the orchestrator backfilled it or imported it rather than
 * executing it. Its duration measures when the record was written, so it is listed but never averaged. */
function isSynthetic(entry: any): boolean {
  return Boolean(entry.backfilled) || (entry.executionStatus && entry.executionStatus !== 'completed');
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** One run's rows, walking history in recorded order with a cursor so no interval is counted twice. */
function runRows(record: any): any {
  const history = Array.isArray(record.history) ? record.history : [];
  let cursor = parseAt(record.startedAt);
  const stages: any[] = [];
  const gates: any[] = [];
  let reruns = 0;

  for (const entry of history) {
    const at = parseAt(entry.at);
    // A negative elapsed can only mean out-of-order history. It is reported as the negative number it
    // is rather than clamped, because hiding it would hide a corrupt record.
    const elapsedMs = at !== null && cursor !== null ? at - cursor : null;
    if (entry.action === 'complete-stage') {
      stages.push({
        stage: entry.node ?? null,
        elapsedMs,
        outcome: entry.outcome ?? null,
        synthetic: isSynthetic(entry),
      });
      cursor = at ?? cursor;
    } else if (entry.action === 'decide-gate') {
      gates.push({
        gate: entry.node ?? null,
        elapsedMs,
        decision: entry.detail ?? null,
        forced: Boolean(entry.forced),
      });
      cursor = at ?? cursor;
    } else if (entry.action === 'annotate') {
      reruns += 1;
      cursor = at ?? cursor;
    } else {
      cursor = at ?? cursor;
    }
  }

  const started = parseAt(record.startedAt);
  const updated = parseAt(record.updatedAt);
  return {
    taskId: record.taskId,
    taskClass: record.taskClass ?? null,
    state: record.state ?? null,
    startedAt: record.startedAt ?? null,
    updatedAt: record.updatedAt ?? null,
    totalMs: started !== null && updated !== null ? updated - started : null,
    reruns,
    stages,
    gates,
  };
}

/** Median elapsed per stage id across runs of one class. Synthetic rows are excluded here and still
 * listed in their run: averaging the moment a file was written into the figure most likely to be
 * quoted would corrupt it. */
function aggregateStages(runs: any[]): any[] {
  const perStage = new Map<string, number[]>();
  for (const run of runs) {
    for (const row of run.stages) {
      if (row.synthetic || row.elapsedMs === null || !row.stage) continue;
      if (!perStage.has(row.stage)) perStage.set(row.stage, []);
      perStage.get(row.stage)!.push(row.elapsedMs);
    }
  }
  return [...perStage.entries()].map(([stage, values]) => ({
    stage, runs: values.length, medianMs: median(values),
  }));
}

/** Pure. Reads nothing and writes nothing; takes already-parsed records. */
function buildIndicators({ records = [], unreadable = [], exists = true } = {}): any {
  const runs = (records as any[]).map(runRows);
  const byClass = new Map<string, any>();

  for (const run of runs) {
    const key = run.taskClass || '(unclassified)';
    if (!byClass.has(key)) byClass.set(key, { taskClass: key, runs: [], stageAggregate: [] });
    byClass.get(key)!.runs.push(run);
  }

  for (const group of byClass.values()) group.stageAggregate = aggregateStages(group.runs);

  return {
    view: 'indicators',
    source: `.doflow/state/${ORCHESTRATION_DIRNAME}`,
    exists,
    runCount: runs.length,
    unreadable,
    byClass: [...byClass.values()],
    // Printed as well as returned: a limitation a reader has to look up is one they will not read.
    limits: [
      'A stage figure is the interval since the previous recorded event, not pure execution time: the record marks completions, never starts.',
      'A gate figure is a human deciding. It is charged to no stage and never aggregated.',
      'Backfilled and imported stages are listed per run but excluded from every aggregate.',
      'No git, pull-request or continuous-integration indicator is computable here: the orchestration record holds none of that data.',
    ],
  };
}

/** One class block: its runs, each run's stage and gate rows, then the class median. */
function printClass(group: any): void {
  console.log('─'.repeat(78));
  console.log(`CLASS: ${group.taskClass}   (${group.runs.length} run(s))`);
  for (const run of group.runs) {
    console.log(`  ${run.taskId}  state=${run.state}  total ${formatMs(run.totalMs)}  reruns ${run.reruns}`);
    for (const row of run.stages) {
      console.log(`     stage ${String(row.stage).padEnd(24)} ${formatMs(row.elapsedMs).padStart(9)}  outcome=${row.outcome ?? 'not recorded'}${row.synthetic ? '  [backfilled/imported]' : ''}`);
    }
    for (const row of run.gates) {
      console.log(`     wait  ${String(row.gate).padEnd(24)} ${formatMs(row.elapsedMs).padStart(9)}  decision=${row.decision ?? 'not recorded'}${row.forced ? '  [forced]' : ''}`);
    }
  }
  if (!group.stageAggregate.length) return;
  console.log(`  median per stage (${group.taskClass}, backfilled excluded):`);
  for (const agg of group.stageAggregate) {
    console.log(`     ${agg.stage.padEnd(24)} ${formatMs(agg.medianMs).padStart(9)}  over ${agg.runs} run(s)`);
  }
}

function handleIndicatorsCommand({ json = false, projectRoot = process.cwd() } = {}): number {
  const read = readRecords(projectRoot);
  const view = buildIndicators(read);

  if (json) {
    console.log(JSON.stringify(view, null, 2));
    return finish(0);
  }

  console.log('\nDoFlow Workflow Indicators');
  console.log('═'.repeat(78));
  if (!view.runCount) {
    console.log(read.exists
      ? `No readable orchestration record under ${view.source}.`
      : `No orchestration record has been written yet at ${view.source}.`);
    if (view.unreadable.length) {
      for (const u of view.unreadable) console.log(`  unreadable: ${u.file} — ${u.reason}`);
    }
    console.log('═'.repeat(78) + '\n');
    return finish(0);
  }

  console.log(`Runs:      ${view.runCount} across ${view.byClass.length} task class(es)`);
  if (view.unreadable.length) {
    console.log(`Unreadable: ${view.unreadable.length} record(s) — ${view.unreadable.map((u: any) => u.file).join(', ')}`);
  }

  for (const group of view.byClass) printClass(group);

  console.log('─'.repeat(78));
  console.log('What this does not measure:');
  for (const limit of view.limits) console.log(`  · ${limit}`);
  console.log('═'.repeat(78) + '\n');
  return finish(0);
}

module.exports = { orchestrationDir, readRecords, buildIndicators, handleIndicatorsCommand };
