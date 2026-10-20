'use strict';

/**
 * Agentic baseline grader (feature 097, IC-006, IC-007): turns one run directory into a `grading`
 * record, offline and without writing, and grades a whole iteration directory.
 *
 * Three decisions are separate on purpose, because each one decides what a number means:
 *  - infra (096 `classifyRun`): did the harness leave a usable run? An excluded run scores `null`,
 *    never 0, so an outage cannot lower an arm.
 *  - isolation: did arm N reach the tool under test (or any arm call an MCP tool)? A run that did, or
 *    whose transcript cannot be read, scores `null` as well; the leak patterns come from config.
 *  - answer: a clean, completed run that produced no extractable answer is a model failure and
 *    scores 0.
 *
 * `serializeGrading` fixes the key order, so grading a directory twice yields byte-identical files.
 */

const fs = require('node:fs');
const path = require('node:path');

const { classifyRun } = require('../noise.js');
const { scoreTask } = require('../retrieval/lib/metrics.js');
const { loadManifest } = require('../retrieval/lib/snapshot.js');

/** Only this many distinct answer paths count (the prompt asks for up to 10). */
const MAX_FILES = 10;
/** Evidence strings are cut so a pathological command cannot bloat grading.json. */
const EVIDENCE_MAX = 200;

const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

/** Parsed events of a structured-output transcript (the registry parser id); lines that are not JSON objects are skipped. */
function parseTranscript(text) {
  const events = [];
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const v = JSON.parse(trimmed);
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) events.push(v);
    } catch {
      // not an event: ignored
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// Answer extraction

/** End index (exclusive) of the balanced `{...}` starting at `start`, string literals respected; -1 when unbalanced. */
function balancedEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

/** Repository-relative POSIX form. An absolute path is kept as given: it is never guessed into a repo path. */
function normalisePath(p) {
  const posix = path.posix.normalize(String(p).trim().replace(/\\/g, '/'));
  return posix.replace(/^(?:\.\/)+/, '');
}

/**
 * The LAST JSON object in `text` that has a `files` array of strings, or null. Prose and code fences
 * around it are tolerated. A balanced object without such an array is searched inside (a wrapper
 * object may hold the answer); a matched answer is not searched inside. Worst case is quadratic in the
 * message length, which is a model's final message.
 * @returns {{files: string[]} | null}
 */
function extractAnswer(text) {
  if (typeof text !== 'string') return null;
  let found = null;
  let i = text.indexOf('{');
  while (i !== -1) {
    const end = balancedEnd(text, i);
    let next = i + 1;
    if (end !== -1) {
      try {
        const v = JSON.parse(text.slice(i, end));
        if (v !== null && typeof v === 'object' && Array.isArray(v.files) && v.files.every((f) => typeof f === 'string')) {
          found = v.files;
          next = end;
        }
      } catch {
        // balanced but not JSON: look inside
      }
    }
    i = text.indexOf('{', next);
  }
  if (found === null) return null;
  const files = [...new Set(found.map(normalisePath).filter((f) => f !== '' && f !== '.'))].slice(0, MAX_FILES);
  return { files };
}

// ---------------------------------------------------------------------------
// Isolation

/** The string each tool-use event is matched as: the command, or `mcp:<server>/<tool>`. Other events: null. */
function eventTarget(event) {
  if (event?.type !== 'item.completed' || !event.item) return null;
  const { item } = event;
  if (item.type === 'command_execution' && typeof item.command === 'string') return item.command;
  if (item.type === 'mcp_tool_call') return `mcp:${item.server}/${item.tool}`;
  return null;
}

const compile = (sources) => (Array.isArray(sources) ? sources : []).map((s) => new RegExp(s));

/**
 * @param {object[]} events parsed transcript events
 * @param {{leak?: string[], count?: string[]}} armConfig arm entry of config.json (IC-003)
 * @returns {{isolation: 'clean'|'leaked'|'unverifiable', evidence: string[], retrieveCalls: number}}
 */
function classifyIsolation(events, armConfig) {
  if (!Array.isArray(events) || events.length === 0) return { isolation: 'unverifiable', evidence: [], retrieveCalls: 0 };
  const leak = compile(armConfig?.leak);
  const count = compile(armConfig?.count);
  const evidence = [];
  let retrieveCalls = 0;
  for (const event of events) {
    const target = eventTarget(event);
    if (target === null) continue;
    if (leak.some((re) => re.test(target))) evidence.push(target.slice(0, EVIDENCE_MAX));
    if (count.some((re) => re.test(target))) retrieveCalls++;
  }
  return { isolation: evidence.length ? 'leaked' : 'clean', evidence, retrieveCalls };
}

// ---------------------------------------------------------------------------
// Grading

/**
 * `pathInfo(path)` for `scoreTask`: the manifest entry of a repository path, or null outside it. The
 * manifest records bytes, not line counts, so `lineCount` is null; it is only read for candidates that
 * carry line ranges, and the file-level answers graded here carry none.
 */
function loadPathInfo(manifest = loadManifest()) {
  const entries = new Map((manifest.entries || []).map((e) => [e.path, e]));
  return (p) => {
    const e = entries.get(p);
    return e ? { lineCount: null, bytes: e.bytes } : null;
  };
}

/** The status string of run_status.json: 'absent' when the file is missing, 'malformed' when unreadable. */
function readRunStatus(runDir) {
  const raw = readText(path.join(runDir, 'run_status.json'));
  if (raw === null) return 'absent';
  try {
    const v = JSON.parse(raw);
    return typeof v?.status === 'string' ? v.status : 'malformed';
  } catch {
    return 'malformed';
  }
}

/**
 * Grades one run directory (IC-007). Pure: reads, never writes.
 * @returns {object} the grading record, keys in `serializeGrading` order
 */
function gradeRun({ runDir, task, arm, config, pathInfo }) {
  const armConfig = config?.arms?.[arm];
  if (!armConfig) throw new Error(`gradeRun: arm "${arm}" is not in the config (known: ${Object.keys(config?.arms || {}).join(', ')})`);

  const status = readRunStatus(runDir);
  const events = parseTranscript(readText(path.join(runDir, 'transcript.jsonl')));
  const lastMessage = readText(path.join(runDir, 'last-message.txt')) ?? '';
  const hasOutput = events.length > 0 || lastMessage.trim() !== '';

  const cls = classifyRun({ status, hasOutput });
  const infra = cls.infra ?? (cls.excluded ? 'malformed' : null);
  const iso = classifyIsolation(events, armConfig);

  let answer = null;
  let passRate = null;
  if (!cls.excluded && iso.isolation === 'clean') {
    answer = extractAnswer(lastMessage);
    const files = answer ? answer.files : [];
    const scored = scoreTask({
      task: { ...task, class: task.kind, expect: task.expect ?? {} },
      answer: { result: files.length ? 'RETRIEVED' : 'EMPTY', candidates: files.map((p, i) => ({ path: p, rank: i + 1 })) },
      pathInfo,
    });
    passRate = scored.metrics.fileRecallAt10;
  }

  return {
    key: task.key,
    id: task.id,
    split: task.split,
    kind: task.kind,
    arm,
    run_status: status,
    infra,
    isolation: iso.isolation,
    isolationEvidence: iso.evidence,
    retrieveCalls: iso.retrieveCalls,
    answer,
    pass_rate: passRate,
    metrics: { fileRecallAt10: passRate },
  };
}

/** Byte-stable text of a grading: fixed key order (the order `gradeRun` builds), two-space indent, final newline. */
function serializeGrading(g) {
  return `${JSON.stringify({
    key: g.key,
    id: g.id,
    split: g.split,
    kind: g.kind,
    arm: g.arm,
    run_status: g.run_status,
    infra: g.infra,
    isolation: g.isolation,
    isolationEvidence: g.isolationEvidence,
    retrieveCalls: g.retrieveCalls,
    answer: g.answer,
    pass_rate: g.pass_rate,
    metrics: g.metrics,
  }, null, 2)}\n`;
}

/**
 * Grades every task directory of an iteration (arm from iteration.json) and, unless `write` is false,
 * writes `grading.json` into each. A task without a directory is returned as `{ id, missing: true }`
 * and nothing is created for it. `taskSet` is the `loadTaskSet` result or a task array.
 * @returns {object[]} gradings in task order
 */
function gradeIteration({ iterationDir, taskSet, config, pathInfo, write = true }) {
  const meta = JSON.parse(fs.readFileSync(path.join(iterationDir, 'iteration.json'), 'utf8'));
  const tasks = Array.isArray(taskSet) ? taskSet : taskSet.tasks;
  return tasks.map((task) => {
    const runDir = path.join(iterationDir, task.id);
    if (!fs.existsSync(runDir)) return { id: task.id, missing: true };
    const grading = gradeRun({ runDir, task, arm: meta.arm, config, pathInfo });
    if (write) fs.writeFileSync(path.join(runDir, 'grading.json'), serializeGrading(grading));
    return grading;
  });
}

module.exports = {
  MAX_FILES, EVIDENCE_MAX,
  parseTranscript, extractAnswer, classifyIsolation, loadPathInfo, gradeRun, serializeGrading, gradeIteration,
};
