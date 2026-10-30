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

// ---------------------------------------------------------------------------------------------
// With/without-DoFlow A/B task set (`config.mode === 'ab'`). Tasks are `edit` (a native case: seed
// files in, hidden checks run on the final files outside the model's workspace) or `review` (a
// review-miss revision exported with `git archive`, the answer a `review.json`). Nothing here changes
// the retrieval task set above.
// ---------------------------------------------------------------------------------------------

const AB_KEY_PREFIX = 'ab/';
const AB_KINDS = Object.freeze(['edit', 'review']);
const AB_TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const REV_HEX = /^[0-9a-f]{40}$/;
/** The answer the review prompt asks for; the same text for both arms, kept minimal on purpose. */
const REVIEW_FILE = 'review.json';
const REVIEW_ANSWER_RULE =
  `Write your findings to ${REVIEW_FILE} in the current directory: a JSON array of objects `
  + '{"path": "<repository-relative path>", "startLine": <number>, "endLine": <number>, '
  + '"severity": "blocker" | "should-fix" | "note", "title": "<short description>"}. '
  + 'Report only real defects; an empty array means you found none.';

const isStr = (v: any) => typeof v === 'string' && v.trim() !== '';

/** Key digest over everything that decides what the task asks and how it is graded (edit: text, seed files, checks; review: revision, scope, focus, cases). */
function abCaseKey(task: any) {
  const body = task.kind === 'edit'
    ? { text: task.text, files: task.files, checks: task.checks }
    : { rev: task.review.rev, scope: task.review.scope, focus: task.review.focus, caseIds: task.review.caseIds };
  return `${AB_KEY_PREFIX}${task.id}@${sha256Hex(JSON.stringify(body)).slice(0, 8)}`;
}

/**
 * Loads the A/B task list. `config.tasksFile` and `config.nativeCases` are repo-relative; the injectable
 * paths are for tests. Refuses (UsageError) a malformed task, an unknown native case, a duplicate id, or
 * a native case that is not one message with files and checks.
 * @returns {{mode: 'ab', tasks: object[], train: object[], heldout: object[], snapshot: {commit: null}, templateSha256: string}}
 */
function loadAbTaskSet({ repoRoot = REPO_ROOT, config, tasksPath, nativePath }: any = {}) {
  const tasksFile = tasksPath || path.join(repoRoot, config?.tasksFile || 'bench/agentic/ab/tasks.json');
  const nativeFile = nativePath || path.join(repoRoot, config?.nativeCases || 'bench/native/cases.json');
  const cfg = readJson(tasksFile, 'tasks-file', 'A/B tasks file');
  if (cfg.schemaVersion !== 1 || !Array.isArray(cfg.tasks) || cfg.tasks.length === 0) {
    throw new UsageError('tasks-file', `${tasksFile} must be schemaVersion 1 with a non-empty tasks array`);
  }
  const native = readJson(nativeFile, 'native-file', 'native cases file');
  const seen = new Set();
  const tasks = cfg.tasks.map((raw: any) => {
    if (!raw || typeof raw !== 'object' || !isStr(raw.id) || !AB_TASK_ID.test(raw.id)) throw new UsageError('tasks-file', 'every A/B task needs a safe string id');
    if (seen.has(raw.id)) throw new UsageError('duplicate-id', `task id ${raw.id} appears more than once`);
    seen.add(raw.id);
    if (!AB_KINDS.includes(raw.kind)) throw new UsageError('task-kind', `task ${raw.id} kind must be one of ${AB_KINDS.join(', ')}, got ${JSON.stringify(raw.kind)}`);
    if (!isStr(raw.name)) throw new UsageError('tasks-file', `task ${raw.id} needs a name`);
    const task: any = { id: raw.id, name: raw.name, kind: raw.kind, split: 'train', group: raw.kind === 'review' ? 'review' : 'success' };
    if (raw.kind === 'edit') {
      const item = (native.cases || []).find((c: any) => c.id === raw.nativeCase);
      if (!item) throw new UsageError('native-case-unknown', `task ${raw.id} names native case "${raw.nativeCase}", which ${nativeFile} does not define`);
      if (!Array.isArray(item.messages) || item.messages.length !== 1 || !isStr(item.messages[0])) {
        throw new UsageError('native-case-shape', `native case ${raw.nativeCase} must have exactly one message (the A/B runs one prompt)`);
      }
      if (!isStr(item.checks) || !item.files || typeof item.files !== 'object') {
        throw new UsageError('native-case-shape', `native case ${raw.nativeCase} needs files and checks`);
      }
      Object.assign(task, {
        nativeCase: raw.nativeCase, text: item.messages[0], files: item.files, checks: item.checks,
        expectedSkills: Array.isArray(item.expectedSkills) ? item.expectedSkills : [],
        maxQuestions: Number.isInteger(item.maxQuestions) ? item.maxQuestions : 0,
      });
    } else {
      const r = raw.review;
      if (!r || !REV_HEX.test(String(r.rev)) || !Array.isArray(r.scope) || r.scope.length === 0 || !r.scope.every(isStr)
        || !Array.isArray(r.focus) || r.focus.length === 0 || !r.focus.every(isStr)
        || !Array.isArray(r.caseIds) || r.caseIds.length === 0 || !r.caseIds.every(isStr)) {
        throw new UsageError('review-shape', `review task ${raw.id} needs review.rev (40 hex), scope, focus and caseIds lists`);
      }
      task.review = { rev: r.rev, scope: r.scope.slice(), focus: r.focus.slice(), caseIds: r.caseIds.slice() };
      task.expectedSkills = Array.isArray(raw.expectedSkills) ? raw.expectedSkills : [];
      task.maxQuestions = 0;
    }
    task.key = abCaseKey(task);
    return task;
  });
  return {
    mode: 'ab', tasks, train: tasks, heldout: [], snapshot: { commit: null },
    templateSha256: sha256Hex(JSON.stringify(AB_KINDS) + REVIEW_ANSWER_RULE),
  };
}

/** The text of an A/B prompt before the shared paragraph: the native message, or the review request. */
function abTaskText(task: any) {
  if (task.kind === 'edit') return task.text;
  const focus = task.review.focus.join(' and ');
  return [
    `You are working in a code repository at the current directory. Review ${focus}; the other files are context only. Do not edit any source file.`,
    REVIEW_ANSWER_RULE,
  ].join('\n\n');
}

/** The one prompt both arms get: the task text, then the shared paragraph (identical in every arm). */
function buildAbPrompt(task: any, paragraph: any) {
  if (typeof paragraph !== 'string' || paragraph.trim() === '') throw new TypeError('buildAbPrompt: paragraph must be a non-empty string');
  return [abTaskText(task), paragraph].join('\n\n');
}

module.exports = {
  KEY_PREFIX, TEMPLATE_PREAMBLE, ANSWER_RULE, PROMPT_TEMPLATE_SHA256,
  AB_KEY_PREFIX, AB_KINDS, REVIEW_FILE, REVIEW_ANSWER_RULE,
  UsageError, caseKey, loadTaskSet, buildPrompt, promptSha256, loadAbTaskSet, buildAbPrompt, abTaskText,
};
