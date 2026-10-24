'use strict';

/**
 * Agentic baseline task set (feature 097, IC-001, IC-002, IC-011): turns `tasks.json` (the train
 * selection) plus the sealed heldout file into resolved tasks, derives each task's case key from its
 * question AND its truth, and builds the one prompt every arm gets.
 *
 * Why the key digests the truth: a noise artifact is bound to its case keys (096
 * `noise-case-set-mismatch`), so editing a question or a qrel must change the key and invalidate the
 * old artifact instead of silently scoring a different task under the same name.
 *
 * Why the loader refuses instead of defaulting: a dev id that vanished, changed class or moved corpus
 * would shrink or skew the train set without anyone noticing. Every refusal is a `UsageError` (exit 2
 * semantics, `usage = true`) carrying a stable `reason` code.
 *
 * Arm paragraphs live in `config.json` (written elsewhere); this module only receives one as an
 * argument and so knows no arm name.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REPO_ROOT = path.join(__dirname, '..', '..');
const TASKS_PATH = path.join(__dirname, 'tasks.json');
const DEV_PATH = path.join(REPO_ROOT, 'bench', 'retrieval', 'tasks', 'dev.json');
const SNAPSHOT_PATH = path.join(REPO_ROOT, 'bench', 'retrieval', 'snapshot.json');

const KEY_PREFIX = 'agentic/';
const TRAIN_CLASSES = Object.freeze(['conceptual-discovery', 'impact-refactor']);

/** The three fixed parts of the prompt (IC-011). The arm paragraph sits between the question and the rule. */
const TEMPLATE_PREAMBLE = 'You are working in a code repository at the current directory. Do not edit any file.';
const ANSWER_RULE =
  'Reply with only a JSON object {"files": [...]} listing up to 10 repository-relative file paths that answer the question, most relevant first.';
/** The template with fixed placeholders; its hash identifies the template text independent of any task. */
const PROMPT_TEMPLATE_TEXT = [TEMPLATE_PREAMBLE, 'Question: {query}', '{paragraph}', ANSWER_RULE].join('\n\n');

const sha256Hex = (text: string) => crypto.createHash('sha256').update(text).digest('hex');
const PROMPT_TEMPLATE_SHA256 = sha256Hex(PROMPT_TEMPLATE_TEXT);

/** A refusal the CLI maps to exit 2. `reason` is one of a closed set the tests pin. */
class UsageError extends Error {
  reason: any;
  usage: boolean;
  constructor(reason: any, message: string) {
    super(message);
    this.name = 'UsageError';
    this.reason = reason;
    this.usage = true;
  }
}

/** IC-002. Digests the question and the truth fields only: anchorSha and qrel ids do not move a key. */
function caseKey(task: any) {
  const body = {
    query: task.query,
    qrels: task.qrels.map(({ path: p, startLine, endLine, rel }: any) => ({ path: p, startLine, endLine, rel })),
    dependencies: task.dependencies ?? [],
  };
  return `${KEY_PREFIX}${task.id}@${sha256Hex(JSON.stringify(body)).slice(0, 8)}`;
}

function readJson(file: string, reason: any, what: string) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e: any) {
    throw new UsageError(reason, `${what} is missing or unreadable: ${file} (${e.message})`);
  }
}

/** A query must not hand over the answer: refuse any qrel path or basename appearing in it. */
function assertNoLeak(task: any) {
  const query = String(task.query).toLowerCase();
  for (const q of task.qrels) {
    for (const needle of [q.path, path.posix.basename(q.path)]) {
      if (needle && query.includes(needle.toLowerCase())) {
        throw new UsageError('truth-leak', `task ${task.id} query contains qrel path or basename "${needle}"`);
      }
    }
  }
}

function resolve(raw: any, split: any) {
  const task: any = {
    id: raw.id,
    split,
    kind: raw.class,
    query: raw.query,
    qrels: raw.qrels,
    ...(raw.dependencies === undefined ? {} : { dependencies: raw.dependencies }),
    corpus: 'code',
    expect: raw.expect,
  };
  assertNoLeak(task);
  task.key = caseKey(task);
  return task;
}

/**
 * Loads and validates the whole task set. Options are injectable for tests; defaults are the real files.
 * Order: train in `tasks.json` order, then heldout in file order. The heldout file is required.
 * @returns {{tasks: object[], train: object[], heldout: object[], snapshot: object, templateSha256: string}}
 */
function loadTaskSet({
  repoRoot = REPO_ROOT, tasksPath = TASKS_PATH, devPath = DEV_PATH, heldoutPath, snapshotPath = SNAPSHOT_PATH,
}: any = {}) {
  const cfg = readJson(tasksPath, 'tasks-file', 'tasks.json');
  if (cfg.schemaVersion !== 1) {
    throw new UsageError('schema-version', `tasks.json schemaVersion ${cfg.schemaVersion} is not supported (expected 1)`);
  }
  if (!Array.isArray(cfg.train)) throw new UsageError('tasks-file', 'tasks.json "train" must be an array of dev task ids');
  const dev = readJson(devPath, 'dev-file', 'dev task file');
  const snapshot = readJson(snapshotPath, 'snapshot', 'retrieval snapshot');

  const trainTasks = cfg.train.map((id: any) => {
    const raw = (dev.tasks || []).find((t: any) => t.id === id);
    if (!raw) throw new UsageError('train-id-missing', `train id ${id} is not in the dev task file`);
    if (raw.corpus !== 'code' || !TRAIN_CLASSES.includes(raw.class)) {
      throw new UsageError('train-id-class', `train id ${id} is ${raw.corpus}/${raw.class}, expected code and one of ${TRAIN_CLASSES.join(', ')}`);
    }
    return resolve(raw, 'train');
  });

  const heldoutFile = heldoutPath || path.join(repoRoot, cfg.heldoutFile || '');
  const held = readJson(heldoutFile, 'heldout-file', 'heldout task file');
  if (held.schemaVersion !== 1 || held.split !== 'holdout' || !Array.isArray(held.tasks)) {
    throw new UsageError('heldout-file', `heldout task file ${heldoutFile} must be schemaVersion 1 with split "holdout" and a tasks array`);
  }
  if (held.snapshotId !== snapshot.snapshotId) {
    throw new UsageError('snapshot-mismatch', `heldout snapshotId ${held.snapshotId} differs from snapshot.json ${snapshot.snapshotId}`);
  }
  const heldoutTasks = held.tasks.map((raw: any) => {
    if (raw.corpus !== 'code') throw new UsageError('heldout-file', `heldout task ${raw.id} is corpus ${raw.corpus}, expected code`);
    return resolve(raw, 'heldout');
  });

  const tasks = [...trainTasks, ...heldoutTasks];
  const seen = new Set();
  for (const t of tasks) {
    if (seen.has(t.id)) throw new UsageError('duplicate-id', `task id ${t.id} appears more than once`);
    seen.add(t.id);
  }
  return { tasks, train: trainTasks, heldout: heldoutTasks, snapshot, templateSha256: PROMPT_TEMPLATE_SHA256 };
}

/**
 * IC-011: preamble, question, arm paragraph, answer rule, blank-line separated. The paragraph is the
 * only arm-specific text and is required. Refuses a prompt that would contain a qrel path.
 */
function buildPrompt(task: any, paragraph: any) {
  if (typeof paragraph !== 'string' || paragraph.trim() === '') {
    throw new TypeError('buildPrompt: paragraph must be a non-empty string');
  }
  const prompt = [TEMPLATE_PREAMBLE, `Question: ${task.query}`, paragraph, ANSWER_RULE].join('\n\n');
  for (const q of task.qrels || []) {
    if (prompt.includes(q.path)) throw new UsageError('truth-leak', `prompt for ${task.id} contains qrel path "${q.path}"`);
  }
  return prompt;
}

const promptSha256 = (prompt: any) => sha256Hex(prompt);

module.exports = {
  KEY_PREFIX, TEMPLATE_PREAMBLE, ANSWER_RULE, PROMPT_TEMPLATE_SHA256,
  UsageError, caseKey, loadTaskSet, buildPrompt, promptSha256,
};
