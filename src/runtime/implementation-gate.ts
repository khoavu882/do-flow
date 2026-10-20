'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { readReadinessRecord, newerVersionOf, RECORD_VERSION } = require('./readiness-record.ts');
const { listCheckouts } = require('./checkouts.ts');
const { readTaskState } = require('./task-state.ts');
const { resolveActiveFeature } = require('./feature-resolve.ts');
const { isSafeSlug, flatRecordIsOurs } = require('./task-scope.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');

// The implementation gate: which stage of a workflow needs a READY readiness record before it is
// handed off, whether a task has one, and the words every refusal uses.
//
// The held set is read from the workflow registry, never written here: the gated stage is the
// first one that mutates source and carries a readiness template. The texts live here once, so the
// orchestrator, `verify` and the edit hook (which prints the same bytes) say the same thing.

const GATE = 'doflow gate readiness-before-implementation';
const RUN_RECORD_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/;
const RUN_NAMESPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What clears a record a newer DoFlow wrote; `readiness` here refuses to overwrite it. */
const NEWER_NEXT = 'run this command with the DoFlow that wrote the record, or upgrade DoFlow here.';

/**
 * The first stage that mutates source and carries a readiness template; with `editTime`, the first
 * such stage that has not opted out of the edit-time check.
 * @param {Array<Object>} stages a resolved workflow's stages, or a run's stage nodes
 * @param {{editTime?: boolean}} [options]
 * @returns {{id: string, readinessTemplate: string, editTimeGate: boolean}|null}
 */
function gatedStage(stages: any, { editTime = false }: any = {}) {
  const stage = (stages || []).find((s: any) => s && s.mutatesSource === true
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
function heldClasses(engine: any, { editTime = false }: any = {}) {
  return engine.listClasses().filter((cls: any) => gatedStage(engine.resolveWorkflow(cls).stages, { editTime }) !== null);
}

/** The command that clears every readiness refusal. */
function nextCommand({ taskId, slug, template }: any) {
  const withSlug = slug && slug !== taskId ? ` --slug=${slug}` : '';
  return `doflow-run readiness --task-class ${template} --task-id ${taskId}${withSlug}`;
}

/**
 * The refusal for one check code.
 * @param {'missing'|'not-ready'|'wrong-template'|'unusable'|'ambiguous'|'store-conflict'|'ambiguous-run'} code
 * @param {Object} options
 * @param {string} options.taskId
 * @param {string|null} [options.slug]
 * @param {string} options.template the template the gated stage needs
 * @param {Object|null} [options.record] the record read, for `not-ready` and `wrong-template`
 * @param {Array<string>} [options.candidates] the files found, for `ambiguous`; the worktree's then the
 *   main checkout's, for `store-conflict`
 * @param {string|null} [options.detail] why the record cannot be used, for `unusable`
 * @param {string|null} [options.file] the record's file, for `unusable` when a newer DoFlow wrote it
 * @param {number|null} [options.newerVersion] that newer record version; `readiness` would refuse to
 *   replace such a record, so the text does not send the caller there
 * @returns {string}
 */
function refusalText(code: any, { taskId, slug = null, template, record = null, candidates = [], detail = null, file = null, newerVersion = null }: any): string {
  const next = nextCommand({ taskId, slug, template });
  const tail = `Next: ${next}, then gather what it lists until it reports READY. Nothing was changed.`;
  if (code === 'unusable' && newerVersion !== null) {
    return `${GATE}: task '${taskId}' has a readiness record ${file} written by a newer DoFlow (record version ${newerVersion}; this runtime reads ${RECORD_VERSION}), `
      + `so this runtime cannot read it and readiness cannot replace it. Next: ${NEWER_NEXT} Nothing was changed.`;
  }
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
    case 'store-conflict':
      return `${GATE}: task '${taskId}' has a readiness record in this worktree (${candidates[0]}) that differs from the main checkout's (${candidates[1]}). Next: keep one of the two and remove the other, then re-run. Nothing was changed.`;
    case 'ambiguous-run':
      // A readiness record written here cannot say which run is meant, so it is not offered.
      return `${GATE}: task '${taskId}' has runs in more than one other checkout (${candidates.join(', ')}). Next: run verify from the checkout that holds the run you mean. Nothing was changed.`;
    default:
      throw new Error(`no readiness refusal text for code '${code}'`);
  }
}

/**
 * Which harnesses run this gate before each source edit and which meet it first at handoff, from the
 * gate's own mapping in lifecycle.json (`pre-implementation-gate`): `supported`, or `different`
 * with no prerequisite, runs it; a prerequisite (such as Codex's hook review) is named, since until
 * it is met nothing was checked; `unavailable` has no hook layer for it. Empty when the registry
 * cannot be read.
 * @param {{repoRoot?: string}} [options]
 * @returns {string}
 */
function harnessHookNote({ repoRoot = REPO_ROOT }: any = {}): string {
  try {
    const { policies } = JSON.parse(fs.readFileSync(path.join(repoRoot, 'core', 'registry', 'lifecycle.json'), 'utf8'));
    const { mappings } = policies.find((p: any) => p.id === 'pre-implementation-gate');
    const runs = [];
    const gated = new Map();
    const none = [];
    for (const [id, m] of (Object.entries(mappings) as [string, any][])) {
      const prerequisites = Array.isArray(m.prerequisites) ? m.prerequisites : [];
      if (m.status === 'unavailable' || (m.status !== 'supported' && m.status !== 'different')) none.push(id);
      else if (prerequisites.length === 0) runs.push(id);
      else {
        const key = prerequisites.join(' and ');
        gated.set(key, [...(gated.get(key) || []), id]);
      }
    }
    const parts = [];
    if (runs.length) parts.push(`${runs.join(', ')} ${runs.length === 1 ? 'runs' : 'run'} this check before each source edit`);
    for (const [key, ids] of gated) parts.push(`${ids.join(', ')} ${ids.length === 1 ? 'runs' : 'run'} it only after ${key}`);
    if (none.length) parts.push(`${none.join(', ')} ${none.length === 1 ? 'has' : 'have'} no hook layer, so this refusal is ${none.length === 1 ? 'its' : 'their'} first check`);
    return `Edit-time check: ${parts.join('; ')}.`;
  } catch {
    return '';
  }
}

const isDir = (dir: any) => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
const folderOf = (root: any, slug: any) => path.join(root, 'agent-docs', 'doflow', slug);

/** The branch's feature slug as the resolver names it, or null. */
function branchFeatureSlug(cwd: any) {
  try {
    const found = resolveActiveFeature({ projectRoot: cwd });
    const s = !found.error && found.paths ? found.paths.feature_slug : null;
    return isSafeSlug(s) ? s : null;
  } catch {
    return null;
  }
}

/**
 * The feature a task belongs to, as seen from `projectRoot`: `--slug`, else the task id when it
 * names a feature folder there, else the branch's feature.
 * @param {{projectRoot: string, taskId?: string|null, slug?: string|null}} options
 * @returns {string|null}
 */
function featureSlugFor({ projectRoot, taskId = null, slug = null }: any) {
  if (slug) return slug;
  if (isSafeSlug(taskId) && isDir(folderOf(projectRoot, taskId))) return taskId;
  return branchFeatureSlug(projectRoot);
}

/** The feature a run belongs to: the slug recorded when it started, else its task id when that names
 * a feature folder in the checkout holding the run. */
function runSlugOf(run: any, root: any) {
  if (run && typeof run.featureSlug === 'string' && run.featureSlug !== '') return run.featureSlug;
  return run && isSafeSlug(run.taskId) && isDir(folderOf(root, run.taskId)) ? run.taskId : null;
}

/** Whether a store directory can be a run namespace rather than a lock directory. */
function isRunNamespaceDir(name: string): boolean {
  return RUN_NAMESPACE_PATTERN.test(name) && !name.includes('..') && !name.endsWith('.lock');
}

/** The run record files under one checkout's store: flat `<id>.json` and `<slug>/<id>.json`, by
 * path, without reading them. The one listing `findRunFile` and `orchestrationRuns` share.
 * With `listing` (IC-001, the list action), a symbolic link is never followed: a linked run file is
 * kept with `linked: true` so it can be reported as unreadable, and a linked namespace directory is
 * not entered, so nothing outside the store root is read or named. */
function runFilesAt(root: string, { listing = false }: { listing?: boolean } = {}): Array<{ file: string; namespace: string|null; linked: boolean }> {
  const store = path.join(root, '.doflow', 'state', 'orchestration');
  const files: Array<{ file: string; namespace: string|null; linked: boolean }> = [];
  const take = (entry: any) => entry.isFile() || entry.isSymbolicLink();
  let entries: any[];
  try { entries = fs.readdirSync(store, { withFileTypes: true }); } catch { return []; }
  for (const entry of entries) {
    if (take(entry) && RUN_RECORD_PATTERN.test(entry.name)) {
      files.push({ file: path.join(store, entry.name), namespace: null, linked: entry.isSymbolicLink() });
    } else if ((entry.isDirectory() || (!listing && entry.isSymbolicLink())) && isRunNamespaceDir(entry.name)) {
      let nested: any[];
      try { nested = fs.readdirSync(path.join(store, entry.name), { withFileTypes: true }); } catch { continue; }
      for (const item of nested) {
        if (take(item) && RUN_RECORD_PATTERN.test(item.name)) {
          files.push({ file: path.join(store, entry.name, item.name), namespace: entry.name, linked: entry.isSymbolicLink() || item.isSymbolicLink() });
        }
      }
    }
  }
  return files.sort((a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : 0);
}

/** A run file's text, or null when it must not be read: not a regular file (a link, a FIFO, a
 * device, a folder) or any read error. The lifecycle reader's pattern (event-store.ts
 * `readEventFile`): `lstat`, then `O_NOFOLLOW|O_NONBLOCK` so neither a link nor a FIFO swapped in
 * after the `lstat` is followed or blocks, then `fstat` on the descriptor before reading. */
function readRunFileText(file: string): string|null {
  const flags = fs.constants;
  let fd: number|undefined;
  try {
    if (!fs.lstatSync(file).isFile()) return null;
    fd = fs.openSync(file, flags.O_RDONLY | (flags.O_NOFOLLOW || 0) | (flags.O_NONBLOCK || 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* the read is done */ } }
  }
}

/** The run files under one checkout's store, read, with each malformed or unreadable file isolated. */
function runEntriesAt(root: string, origin: 'current'|'other'): any[] {
  return runFilesAt(root, { listing: true }).map(({ file, namespace, linked }) => {
    let record: any = null;
    let error: string|null = null;
    const bytes = linked ? null : readRunFileText(file);
    if (bytes === null) error = 'io';
    else {
      try { record = JSON.parse(bytes); } catch { error = 'unparseable'; }
    }
    return {
      file,
      root,
      origin,
      slug: namespace || runSlugOf(record, root),
      record,
      error,
    };
  });
}

/**
 * All orchestration journals in the current store and the other checkouts, when Git can list them.
 * @param {{stateRoot: string, exec?: Function}} options
 * @returns {{ok: true, entries: Array<Object>}|{ok: false, error: 'cannot-list-checkouts'}}
 */
function orchestrationRuns({ stateRoot, exec }: any): any {
  const current = runEntriesAt(stateRoot, 'current');
  const checkouts = listCheckouts({ cwd: stateRoot, ...(exec ? { exec } : {}) });
  if (!checkouts.ok && checkouts.reason !== 'not-a-git-repository') {
    return { ok: false, error: 'cannot-list-checkouts' };
  }
  if (!checkouts.ok || checkouts.sandbox) return { ok: true, entries: current };

  const entries = [...current];
  for (const root of checkouts.others) entries.push(...runEntriesAt(root, 'other'));
  return { ok: true, entries };
}

/** Whether a flat record names no feature (no `featureSlug`, no `slug`): such a run is any feature's
 * (`flatRecordIsOurs`), so a namespaced copy of the same id in the same store shadows it. */
function namesNoFeature(record: any): boolean {
  return Boolean(record) && typeof record === 'object'
    && ![record.featureSlug, record.slug].some((value) => typeof value === 'string' && value !== '');
}

/**
 * IC-001/IC-003: one entry per logical run, the copy `status` reads, with `findRunFile`'s
 * precedence. In one store, the namespaced `<slug>/<id>.json` wins over a flat `<id>.json` of that
 * feature or of none (when the slug is the id, the flat file is the run's only path and wins).
 * Across stores, the current store's copy wins over every other checkout's; with no current copy,
 * each other checkout that holds one keeps its entry (more than one is the case `status` refuses as
 * ambiguous). A losing copy is dropped: `status` never reads it for this run.
 * @param {Array<Object>} entries `orchestrationRuns(...).entries`
 * @returns {Array<Object>} the winning entries, in input order
 */
function selectRunEntries(entries: any[]): any[] {
  const stem = (entry: any) => path.basename(entry.file, '.json');
  const namespaceOf = (entry: any) => {
    const parts = path.relative(path.join(entry.root, '.doflow', 'state', 'orchestration'), entry.file).split(path.sep);
    return parts.length > 1 ? parts[0] : null;
  };
  const rank = (entry: any) => namespaceOf(entry) === null ? (entry.slug === stem(entry) ? 0 : 1)
    : namespaceOf(entry) === stem(entry) ? 2 : 0;
  // A flat run that names no feature joins the key of the one namespaced copy of its id in its store.
  const keyOf = (entry: any) => {
    if (namespaceOf(entry) === null && namesNoFeature(entry.record)) {
      const owners = entries.filter((other) => other.root === entry.root && namespaceOf(other) !== null
        && namespaceOf(other) !== stem(entry) && stem(other) === stem(entry));
      if (owners.length > 0) return `${namespaceOf(owners[0])}\0${stem(entry)}`;
    }
    return entry.slug === null || entry.slug === undefined ? null : `${entry.slug}\0${stem(entry)}`;
  };
  const best = new Map<string, any[]>();
  const perRoot = new Map<string, any>();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (key === null) continue;
    const local = `${entry.root}\0${key}`;
    const held = perRoot.get(local);
    if (!held || rank(entry) < rank(held)) perRoot.set(local, entry);
  }
  for (const entry of perRoot.values()) {
    const key = keyOf(entry) as string; // only keyed entries were kept above
    const held = best.get(key);
    if (!held) best.set(key, [entry]);
    else if (held[0].origin === 'current') continue;
    else if (entry.origin === 'current') best.set(key, [entry]);
    else held.push(entry);
  }
  const winners = new Set<any>();
  for (const list of best.values()) for (const entry of list) winners.add(entry);
  // An entry whose feature cannot be named has no key: it is its own run.
  return entries.filter((entry) => keyOf(entry) === null || winners.has(entry));
}

/**
 * A task's run file: in this checkout, else in exactly one other checkout whose run belongs to the
 * same feature. The run of a task id other than its feature's slug is `orchestration/<slug>/<id>.json`
 * (115 C-1); a flat run of that id is read in its place only when it is this feature's or names none
 * (D-3). Task ids repeat across features, so another checkout's run with the same id but another
 * feature (or none) is not this task's and is never read or updated from here.
 * @param {{stateRoot: string, taskId: string, slug: string|null, exec?: Function}} options
 * @returns {{status: 'found'|'missing'|'ambiguous', file: string|null, root: string|null,
 *   origin: 'current'|'other'|null, candidates: Array<string>}}
 */
function findRunFile({ stateRoot, taskId, slug, exec }: any) {
  const store = path.join('.doflow', 'state', 'orchestration');
  const flat = path.join(store, `${taskId}.json`);
  const namespaced = slug && slug !== taskId ? path.join(store, slug, `${taskId}.json`) : null;
  const missing = { status: 'missing', file: null, root: null, origin: null, candidates: [] };
  const here = runFilesAt(stateRoot);
  const localNamespaced = namespaced && here.find((entry) => path.relative(stateRoot, entry.file) === namespaced);
  const localFlat = here.find((entry) => path.relative(stateRoot, entry.file) === flat);
  if (localNamespaced) return { status: 'found', file: localNamespaced.file, root: stateRoot, origin: 'current', candidates: [] };
  if (localFlat && (!namespaced || flatRecordIsOurs(localFlat.file, slug))) {
    return { status: 'found', file: localFlat.file, root: stateRoot, origin: 'current', candidates: [] };
  }
  if (!slug) return missing;
  const checkouts = listCheckouts({ cwd: stateRoot, ...(exec ? { exec } : {}) });
  if (!checkouts.ok || checkouts.sandbox) return missing;
  const matches: Array<{ file: string; root: string }> = [];
  for (const root of checkouts.others) {
    const files = runFilesAt(root);
    const found = [namespaced, flat].filter(Boolean).map((rel: any) => files.find((entry) => path.relative(root, entry.file) === rel)).find((entry: any) => {
      if (!entry) return false;
      try { return runSlugOf(JSON.parse(fs.readFileSync(entry.file, 'utf8')), root) === slug; } catch { return false; }
    });
    if (found) matches.push({ file: found.file, root });
  }
  if (matches.length === 0) return missing;
  if (matches.length > 1) return { ...missing, status: 'ambiguous', candidates: matches.map((m) => m.file) };
  return { status: 'found', file: matches[0].file, root: matches[0].root, origin: 'other', candidates: [] };
}

/** The slug a refusal's next command names: one whose feature folder exists in this checkout or in
 * the main checkout, which is when `readiness --slug` resolves it the same way the edit hook does. */
function nextSlugFor({ stateRoot, taskId, slug, exec }: any) {
  if (!slug || slug === taskId) return null;
  if (isDir(folderOf(stateRoot, slug))) return slug;
  const checkouts = listCheckouts({ cwd: stateRoot, ...(exec ? { exec } : {}) });
  return checkouts.main && isDir(folderOf(checkouts.main, slug)) ? slug : null;
}

/** Why a record cannot be read as an evaluation, or null when it can. */
function unusableDetail(record: any, now: any) {
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
 * @param {string|null} [options.slug] the task's feature slug: the record's namespace, and named in
 *   the next command when its folder exists here or in the main checkout
 * @param {string} options.template
 * @param {Date} [options.now]
 * @param {Function} [options.exec]
 * @returns {{ok: boolean, code: 'ready'|'missing'|'not-ready'|'wrong-template'|'unusable'|'ambiguous'|'store-conflict',
 *   record: Object|null, file: string|null, origin: string|null, candidates: Array<string>,
 *   detail: string|null, nextSlug: string|null, message: string|null}}
 */
function checkReadiness({ stateRoot, taskId, slug = null, template, now = new Date(), exec }: any) {
  const read = readReadinessRecord({ stateRoot, taskId, slug, exec });
  const newerVersion = read.status === 'found' ? newerVersionOf(read.record) : null;
  const nextSlug = nextSlugFor({ stateRoot, taskId, slug, exec });
  const result = (code: any, detail: any = null) => ({
    ok: code === 'ready',
    code,
    record: read.record,
    file: read.file,
    origin: read.origin,
    candidates: read.candidates,
    detail,
    newerVersion,
    nextSlug,
    message: code === 'ready' ? null : refusalText(code, {
      taskId, slug: nextSlug, template, record: read.record, candidates: read.candidates, detail, file: read.file, newerVersion,
    }),
  });
  if (read.status === 'ambiguous') return result('ambiguous');
  if (read.status === 'conflict') return result('store-conflict');
  if (read.status === 'missing') return result('missing');
  const detail = read.status === 'unreadable' ? read.detail : unusableDetail(read.record, now);
  if (detail) return result('unusable', detail);
  if (read.record.state !== 'READY') return result('not-ready');
  if (read.record.taskClass !== template) return result('wrong-template');
  return result('ready');
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
 *   record, message}`
 */
function verifyReadinessCheck({ stateRoot, taskId, slug = null, now = new Date(), exec }: any) {
  let found = findRunFile({ stateRoot, taskId, slug, exec });
  if (found.status === 'missing' && slug && slug !== taskId) found = findRunFile({ stateRoot, taskId: slug, slug, exec });
  if (found.status === 'ambiguous') {
    return {
      applies: true, runTaskId: null, stage: null, template: null, ok: false, code: 'ambiguous', record: null,
      message: refusalText('ambiguous-run', { taskId, candidates: found.candidates }),
    };
  }
  if (found.status === 'missing') return { applies: false, reason: 'no-run' };
  const run = readTaskState(fs, found.file);
  if (run.state === 'COMPLETED' || run.state === 'REJECTED') return { applies: false, reason: 'run-finished' };
  const stageNodes = (run.program || []).filter((n: any) => n.type === 'stage');
  const stage = gatedStage(stageNodes);
  if (!stage) return { applies: false, reason: 'no-gated-stage' };
  const node = stageNodes.find((n: any) => n.id === stage.id);
  if (node.status === 'completed' || node.status === 'skipped') return { applies: false, reason: 'gated-stage-done' };

  const template = stage.readinessTemplate;
  const check = checkReadiness({ stateRoot, taskId: run.taskId, slug, template, now, exec });
  return {
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
}

module.exports = {
  gatedStage,
  heldClasses,
  refusalText,
  harnessHookNote,
  checkReadiness,
  verifyReadinessCheck,
  featureSlugFor,
  runSlugOf,
  orchestrationRuns,
  selectRunEntries,
  findRunFile,
};
