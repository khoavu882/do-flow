'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readReadinessRecord, RECORD_VERSION } = require('./readiness-record');
const { findStateFile } = require('./checkouts');
const { readTaskState } = require('./task-state');
const { REPO_ROOT } = require('../helper/repo-root');

// The implementation gate: which stage of a workflow needs a READY readiness record before it is
// handed off, whether a task has one, and the words every refusal uses.
//
// The held set is read from the workflow registry, never written here: the gated stage is the
// first one that mutates source and carries a readiness template. The texts live here once, so the
// orchestrator, `verify` and the edit hook (which prints the same bytes) say the same thing.

const GATE = 'doflow gate readiness-before-implementation';

/** The release that started recording readiness, and the one that ends the grace for older runs. */
const READINESS_FLOOR_SINCE = '1.22.0';
const PRE_FLOOR_GRACE_ENDS = '1.23.0';

/** Check codes a run started before READINESS_FLOOR_SINCE is excused from until PRE_FLOOR_GRACE_ENDS. */
const GRACE_CODES = new Set(['missing', 'not-ready', 'wrong-template', 'unusable']);

/**
 * The first stage that mutates source and carries a readiness template; with `editTime`, the first
 * such stage that has not opted out of the edit-time check.
 * @param {Array<Object>} stages a resolved workflow's stages, or a run's stage nodes
 * @param {{editTime?: boolean}} [options]
 * @returns {{id: string, readinessTemplate: string, editTimeGate: boolean}|null}
 */
function gatedStage(stages, { editTime = false } = {}) {
  const stage = (stages || []).find((s) => s && s.mutatesSource === true
    && typeof s.readinessTemplate === 'string' && s.readinessTemplate !== ''
    && (!editTime || s.editTimeGate !== false));
  return stage ? { id: stage.id, readinessTemplate: stage.readinessTemplate, editTimeGate: stage.editTimeGate !== false } : null;
}

/**
 * The classes whose workflow has a gated stage, in registry order.
 * @param {Object} engine a WorkflowEngine
 * @param {{editTime?: boolean}} [options]
 * @returns {Array<string>}
 */
function heldClasses(engine, { editTime = false } = {}) {
  return engine.listClasses().filter((cls) => gatedStage(engine.resolveWorkflow(cls).stages, { editTime }) !== null);
}

/** The command that clears every readiness refusal. */
function nextCommand({ taskId, slug, template }) {
  const withSlug = slug && slug !== taskId ? ` --slug=${slug}` : '';
  return `doflow-run readiness --task-class ${template} --task-id ${taskId}${withSlug}`;
}

/**
 * The refusal for one check code.
 * @param {'missing'|'not-ready'|'wrong-template'|'unusable'|'ambiguous'} code
 * @param {Object} options
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @param {string} options.template the template the gated stage needs
 * @param {Object|null} [options.record] the record read, for `not-ready` and `wrong-template`
 * @param {Array<string>} [options.candidates] the files found, for `ambiguous`
 * @param {string|null} [options.detail] why the record cannot be used, for `unusable`
 * @returns {string}
 */
function refusalText(code, { taskId, slug = null, template, record = null, candidates = [], detail = null }) {
  const next = nextCommand({ taskId, slug, template });
  const tail = `Next: ${next}, then gather what it lists until it reports READY. Nothing was changed.`;
  switch (code) {
    case 'missing':
      return `${GATE}: task '${taskId}' has no readiness record for the '${template}' template. ${tail}`;
    case 'not-ready':
      return `${GATE}: task '${taskId}' was last evaluated ${record.state} at ${record.evaluatedAt} against the '${template}' template, not READY. ${tail}`;
    case 'wrong-template':
      return `${GATE}: task '${taskId}' has a READY record for the '${record.taskClass}' template, and this stage needs '${template}'. ${tail}`;
    case 'unusable':
      return `${GATE}: task '${taskId}' has a readiness record that cannot be used (${detail}). ${tail}`;
    case 'ambiguous':
      return `${GATE}: task '${taskId}' has records in more than one other checkout (${candidates.join(', ')}). Next: run the command from the checkout that holds the one you mean, or run ${next} here. Nothing was changed.`;
    default:
      throw new Error(`no readiness refusal text for code '${code}'`);
  }
}

/**
 * Which harnesses run the edit-time check and which meet the gate first at handoff, from
 * `capabilities.hooks.status` in harnesses.json. Empty when the registry cannot be read.
 * @param {{repoRoot?: string}} [options]
 * @returns {string}
 */
function harnessHookNote({ repoRoot = REPO_ROOT } = {}) {
  try {
    const { harnesses } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'core', 'registry', 'harnesses.json'), 'utf8'));
    const hooked = harnesses.filter((h) => h.capabilities?.hooks?.status === 'supported').map((h) => h.id);
    const others = harnesses.map((h) => h.id).filter((id) => !hooked.includes(id));
    return `Edit-time check: ${hooked.join(', ')} run this check before each source edit; ${others.join(', ')} have no hook layer, so this refusal is their first check.`;
  } catch {
    return '';
  }
}

/** Why a record cannot be read as an evaluation, or null when it can. */
function unusableDetail(record, now) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return 'not a JSON object';
  if (record.version !== RECORD_VERSION) return `version ${JSON.stringify(record.version)}, this runtime reads ${RECORD_VERSION}`;
  for (const key of ['state', 'taskClass', 'evaluatedAt']) {
    if (typeof record[key] !== 'string' || record[key] === '') return `no ${key}`;
  }
  const at = Date.parse(record.evaluatedAt);
  if (Number.isNaN(at)) return `evaluatedAt '${record.evaluatedAt}' is not a time`;
  if (at > now.getTime()) return `evaluated at ${record.evaluatedAt}, after this check at ${now.toISOString()}`;
  return null;
}

/**
 * Whether the task holds a READY record of `template` made no later than `now`.
 * @param {Object} options
 * @param {string} options.stateRoot
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @param {string} options.template
 * @param {Date} [options.now]
 * @param {Function} [options.exec]
 * @returns {{ok: boolean, code: 'ready'|'missing'|'not-ready'|'wrong-template'|'unusable'|'ambiguous',
 *   record: Object|null, file: string|null, origin: string|null, candidates: Array<string>,
 *   detail: string|null, message: string|null}}
 */
function checkReadiness({ stateRoot, taskId, slug = null, template, now = new Date(), exec }) {
  const read = readReadinessRecord({ stateRoot, taskId, slug, exec });
  const result = (code, detail = null) => ({
    ok: code === 'ready',
    code,
    record: read.record,
    file: read.file,
    origin: read.origin,
    candidates: read.candidates,
    detail,
    message: code === 'ready' ? null : refusalText(code, { taskId, slug, template, record: read.record, candidates: read.candidates, detail }),
  });
  if (read.status === 'ambiguous') return result('ambiguous');
  if (read.status === 'missing') return result('missing');
  const detail = read.status === 'unreadable' ? read.detail : unusableDetail(read.record, now);
  if (detail) return result('unusable', detail);
  if (read.record.state !== 'READY') return result('not-ready');
  if (read.record.taskClass !== template) return result('wrong-template');
  return result('ready');
}

/**
 * A run started before READINESS_FLOOR_SINCE: read from a file, with a `startedAt` and no
 * `readinessFloor` key, which every run started since carries. A task with no run is never one.
 * @param {Object|null} run
 * @returns {boolean}
 */
function preFloorGrace(run) {
  return Boolean(run) && typeof run.startedAt === 'string'
    && !Object.prototype.hasOwnProperty.call(run, 'readinessFloor');
}

/**
 * The warning a run in grace gets where a fresh run would be refused.
 * @param {'missing'|'not-ready'|'wrong-template'|'unusable'} code
 * @param {Object} options
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @param {string} options.template
 * @param {Object|null} [options.record]
 * @param {string|null} [options.detail]
 * @param {string} options.startedAt
 * @param {'handoff'|'complete-stage'|'verify report'} options.action
 * @returns {string}
 */
function graceWarning(code, { taskId, slug = null, template, record = null, detail = null, startedAt, action }) {
  const why = {
    missing: () => 'no record',
    'not-ready': () => `last evaluated ${record.state} at ${record.evaluatedAt}`,
    'wrong-template': () => `its READY record is for the '${record.taskClass}' template`,
    unusable: () => `its record cannot be used (${detail})`,
  }[code];
  if (!why) throw new Error(`no grace warning for code '${code}'`);
  return `${GATE}: warning: task '${taskId}' has no READY readiness record for the '${template}' template (${why()}), `
    + `but its run started at ${startedAt}, before DoFlow ${READINESS_FLOOR_SINCE} recorded readiness, so this ${action} proceeds. `
    + `From DoFlow ${PRE_FLOOR_GRACE_ENDS} it is refused. Next: ${nextCommand({ taskId, slug, template })}, then gather what it lists until it reports READY.`;
}

/** The run file for a task id in this checkout or exactly one other. */
function findRun({ stateRoot, id, exec }) {
  return findStateFile({ stateRoot, relPath: path.join('.doflow', 'state', 'orchestration', `${id}.json`), ...(exec ? { exec } : {}) });
}

/**
 * `verify`'s readiness check: whether a run for the task, or for its feature slug, is open with its
 * gated stage pending, and if so whether a READY record exists. Reads only.
 * @param {Object} options
 * @param {string} options.stateRoot
 * @param {string} options.taskId
 * @param {string|null} [options.slug] the feature slug, for a run keyed by it and for the record's namespace
 * @param {Date} [options.now]
 * @param {Function} [options.exec]
 * @returns {Object} `{applies: false, reason}` or `{applies: true, runTaskId, stage, template, ok, code,
 *   record, message}`, plus `grace: true` for a run started before readiness was recorded
 */
function verifyReadinessCheck({ stateRoot, taskId, slug = null, now = new Date(), exec }) {
  let found = findRun({ stateRoot, id: taskId, exec });
  if (found.status === 'missing' && slug && slug !== taskId) found = findRun({ stateRoot, id: slug, exec });
  if (found.status === 'ambiguous') {
    const template = templateOfAny(found.candidates);
    return {
      applies: true, runTaskId: null, stage: null, template, ok: false, code: 'ambiguous', record: null,
      message: refusalText('ambiguous', { taskId, slug, template, candidates: found.candidates }),
    };
  }
  if (found.status === 'missing') return { applies: false, reason: 'no-run' };
  const run = readTaskState(fs, found.file);
  if (run.state === 'COMPLETED' || run.state === 'REJECTED') return { applies: false, reason: 'run-finished' };
  const stageNodes = (run.program || []).filter((n) => n.type === 'stage');
  const stage = gatedStage(stageNodes);
  if (!stage) return { applies: false, reason: 'no-gated-stage' };
  const node = stageNodes.find((n) => n.id === stage.id);
  if (node.status === 'completed' || node.status === 'skipped') return { applies: false, reason: 'gated-stage-done' };

  const template = stage.readinessTemplate;
  const check = checkReadiness({ stateRoot, taskId: run.taskId, slug, template, now, exec });
  const result = {
    applies: true,
    runTaskId: run.taskId,
    stage: stage.id,
    template,
    ok: check.ok,
    code: check.code,
    record: check.record ? {
      file: check.file, origin: check.origin, state: check.record.state ?? null, taskClass: check.record.taskClass ?? null, evaluatedAt: check.record.evaluatedAt ?? null,
    } : null,
    message: check.message,
  };
  if (!check.ok && GRACE_CODES.has(check.code) && preFloorGrace(run)) {
    result.grace = true;
    result.message = graceWarning(check.code, {
      taskId: run.taskId, slug, template, record: check.record, detail: check.detail, startedAt: run.startedAt, action: 'verify report',
    });
  }
  return result;
}

/** The gated template of the first readable run among `files`, for a refusal that has to name one. */
function templateOfAny(files) {
  for (const file of files) {
    try {
      const stage = gatedStage((readTaskState(fs, file).program || []).filter((n) => n.type === 'stage'));
      if (stage) return stage.readinessTemplate;
    } catch { /* an unreadable candidate names no template */ }
  }
  return '<class>';
}

module.exports = {
  gatedStage,
  heldClasses,
  refusalText,
  harnessHookNote,
  checkReadiness,
  verifyReadinessCheck,
  preFloorGrace,
  graceWarning,
  READINESS_FLOOR_SINCE,
  PRE_FLOOR_GRACE_ENDS,
  GRACE_CODES,
};
