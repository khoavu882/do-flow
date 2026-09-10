'use strict';

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
const { formatMs, finish } = require('./render');

const ORCHESTRATION_DIRNAME = 'orchestration';

/** Mirrors resolveRunsLocation's shape, for the sibling state directory this reads. */
function orchestrationDir(root) {
  return path.join(root, '.doflow', 'state', ORCHESTRATION_DIRNAME);
}

function parseAt(value) {
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/** Every record in a directory, plus the names of the ones that did not parse. A file that cannot be
 * read is counted and named rather than skipped: a report that quietly drops what it could not read
 * overstates its own coverage, which is the defect `malformedLines` already guards against for runs. */
function readRecords(dir, fsImpl = fs) {
  if (!fsImpl.existsSync(dir)) return { records: [], unreadable: [], exists: false };
  const records = [];
  const unreadable = [];
  for (const name of fsImpl.readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    try {
      const parsed = JSON.parse(fsImpl.readFileSync(path.join(dir, name), 'utf8'));
      if (!parsed || typeof parsed !== 'object' || !parsed.taskId) {
        unreadable.push({ file: name, reason: 'not an orchestration record' });
        continue;
      }
      records.push(parsed);
    } catch (err) {
      unreadable.push({ file: name, reason: err.message });
    }
  }
  return { records, unreadable, exists: true };
}

/** A stage row is "not work done" when the orchestrator backfilled it or imported it rather than
 * executing it. Its duration measures when the record was written, so it is listed but never averaged. */
function isSynthetic(entry) {
  return Boolean(entry.backfilled) || (entry.executionStatus && entry.executionStatus !== 'completed');
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/** One run's rows, walking history in recorded order with a cursor so no interval is counted twice. */
function runRows(record) {
  const history = Array.isArray(record.history) ? record.history : [];
  let cursor = parseAt(record.startedAt);
  const stages = [];
  const gates = [];
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

/** Pure. Reads nothing and writes nothing; takes already-parsed records. */
function buildIndicators({ records = [], unreadable = [], exists = true } = {}) {
  const runs = records.map(runRows);
  const byClass = new Map();

  for (const run of runs) {
    const key = run.taskClass || '(unclassified)';
    if (!byClass.has(key)) byClass.set(key, { taskClass: key, runs: [], stageAggregate: [] });
    byClass.get(key).runs.push(run);
  }

  for (const group of byClass.values()) {
    const perStage = new Map();
    for (const run of group.runs) {
      for (const row of run.stages) {
        // Synthetic rows are excluded here and still listed in their run: averaging the moment a file
        // was written into the figure most likely to be quoted would corrupt it.
        if (row.synthetic || row.elapsedMs === null || !row.stage) continue;
        if (!perStage.has(row.stage)) perStage.set(row.stage, []);
        perStage.get(row.stage).push(row.elapsedMs);
      }
    }
    group.stageAggregate = [...perStage.entries()].map(([stage, values]) => ({
      stage, runs: values.length, medianMs: median(values),
    }));
  }

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

function handleIndicatorsCommand({ json = false, projectRoot = process.cwd() } = {}) {
  const dir = orchestrationDir(projectRoot);
  const read = readRecords(dir);
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
    console.log(`Unreadable: ${view.unreadable.length} record(s) — ${view.unreadable.map((u) => u.file).join(', ')}`);
  }

  for (const group of view.byClass) {
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
    if (group.stageAggregate.length) {
      console.log(`  median per stage (${group.taskClass}, backfilled excluded):`);
      for (const agg of group.stageAggregate) {
        console.log(`     ${agg.stage.padEnd(24)} ${formatMs(agg.medianMs).padStart(9)}  over ${agg.runs} run(s)`);
      }
    }
  }

  console.log('─'.repeat(78));
  console.log('What this does not measure:');
  for (const limit of view.limits) console.log(`  · ${limit}`);
  console.log('═'.repeat(78) + '\n');
  return finish(0);
}

module.exports = { orchestrationDir, readRecords, buildIndicators, handleIndicatorsCommand };
