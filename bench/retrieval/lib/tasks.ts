#!/usr/bin/env node
'use strict';

/**
 * Task file validator and authoring CLI (074 IC-013, PD-4).
 *
 *   node bench/retrieval/lib/tasks.js --fill <file>
 *   node bench/retrieval/lib/tasks.js --check <file> --split <dev|holdout>
 *   node bench/retrieval/lib/tasks.js --merge <out> <in...> [--keep-parts]
 *
 * `--check` prints counts and finding codes with task ids, never task text: a holdout plaintext may
 * be checked in a shared terminal. Every blob is read through one `git cat-file --batch` process.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { sha256Hex, toFileText } = require('./seal.ts');
const { applicability, CLASSES } = require('./metrics.ts');
const snapshotLib = require('./snapshot.ts');

const RESULTS = ['RETRIEVED', 'EMPTY', 'UNREACHED', 'UNVERIFIED'];
const FIXTURES_PREFIX = 'bench/retrieval/fixtures/';
const MAX_CONCEPTUAL_OVERLAP = 0.3;
const TASK_KEYS = ['id', 'split', 'corpus', 'class', 'query', 'literal', 'capability', 'qrels', 'dependencies', 'expect', 'setup', 'queryOverlap', 'truthSource', 'author'];
const QREL_KEYS = ['id', 'path', 'startLine', 'endLine', 'heading', 'rel', 'anchorSha'];
const FILE_KEYS = ['schemaVersion', 'snapshotId', 'split', 'canary', 'tasks'];

const isObject = (v: any) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isPosInt = (v: any) => Number.isInteger(v) && v >= 1;
const isNonEmptyString = (v: any) => typeof v === 'string' && v.trim() !== '';

/** One `git cat-file --batch` process for every blob id; returns Map(blobId -> Buffer). */
function readBlobs(repoRoot: any, blobIds: any) {
  const ids = [...new Set(blobIds)];
  const blobs = new Map();
  if (ids.length === 0) return blobs;
  const run = spawnSync('git', ['-C', repoRoot, 'cat-file', '--batch'], {
    input: `${ids.join('\n')}\n`, maxBuffer: 1024 * 1024 * 1024,
  });
  if (run.status !== 0) throw new Error(`git cat-file --batch failed: ${String(run.stderr).trim()}`);
  const out = run.stdout;
  let pos = 0;
  for (const id of ids) {
    const eol = out.indexOf(0x0a, pos);
    const header = out.subarray(pos, eol).toString('utf8').split(' ');
    pos = eol + 1;
    if (header[1] === 'missing') continue;
    const size = Number(header[2]);
    blobs.set(id, out.subarray(pos, pos + size));
    pos += size + 1;
  }
  return blobs;
}

/** Lines of a blob as an author counts them: a trailing newline does not add an empty last line. */
function splitLines(buffer: any) {
  const text = buffer.toString('utf8');
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines;
}

/** SHA-256 of lines startLine..endLine, joined by "\n", with no trailing newline. */
function anchorOf(lines: any, startLine: any, endLine: any) {
  return sha256Hex(lines.slice(startLine - 1, endLine).join('\n'));
}

function allQrels(task: any) {
  return [...(Array.isArray(task.qrels) ? task.qrels : []), ...(Array.isArray(task.dependencies) ? task.dependencies : [])];
}

/** Resolves manifest entries and loads every blob the tasks' qrels point at, in one batch. */
function loadBlobs({ repoRoot, manifest, tasks }: any) {
  const index = new Map(manifest.entries.map((e: any) => [`${e.corpus}\0${e.path}`, e]));
  const wanted = [];
  for (const task of tasks) {
    for (const qrel of allQrels(task)) {
      const entry: any = isObject(qrel) ? index.get(`${task.corpus}\0${qrel.path}`) : undefined;
      if (entry) wanted.push(entry.blob);
    }
  }
  return { index, blobs: readBlobs(repoRoot, wanted) };
}

function literalPresent(repoRoot: any, snapshot: any, literal: any) {
  const run = spawnSync('git', ['-C', repoRoot, 'grep', '-F', '-l', '-e', literal, snapshot.commit], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (run.status === 1) return false;
  if (run.status !== 0) throw new Error(`git grep failed: ${String(run.stderr).trim()}`);
  return run.stdout.split('\n').filter(Boolean).some((line: any) => {
    const file = line.slice(snapshot.commit.length + 1);
    return snapshotLib.corporaOf(file, snapshot).length > 0;
  });
}

function checkClassFields(task: any, split: any, add: any) {
  const expect = isObject(task.expect) ? task.expect : {};
  const setup = isObject(task.setup) ? task.setup : {};
  const need = (cond: any, field: any) => { if (!cond) add('E_FIELD', `${task.class} needs ${field}`); };
  switch (task.class) {
    case 'exact-lookup':
      need(isNonEmptyString(task.literal), 'literal');
      break;
    case 'impact-refactor':
      need(Array.isArray(task.dependencies) && task.dependencies.length > 0, 'dependencies');
      break;
    case 'stale-index':
    case 'dirty-tree':
      need(split === 'dev' ? isNonEmptyString(setup.patch) : isNonEmptyString(setup.patchText), split === 'dev' ? 'setup.patch' : 'setup.patchText');
      break;
    case 'unavailable-provider':
      need(Array.isArray(setup.disable) && setup.disable.length > 0, 'setup.disable');
      break;
    case 'oversized-context':
      need(isPosInt(expect.budgetBytes), 'expect.budgetBytes');
      need(Array.isArray(expect.mustInclude) && expect.mustInclude.length > 0, 'expect.mustInclude');
      if (Array.isArray(expect.mustInclude)) {
        const ids = new Set((task.qrels || []).map((q: any) => q && q.id));
        if (!expect.mustInclude.every((id: any) => ids.has(id))) add('E_FIELD', 'expect.mustInclude names an id that is not a qrel');
      }
      break;
    case 'verification-failure':
      need(isObject(expect.mustSurvive) && Number.isInteger(expect.mustSurvive.exitCode)
        && Array.isArray(expect.mustSurvive.lines) && expect.mustSurvive.lines.length > 0, 'expect.mustSurvive');
      need(Array.isArray(setup.command) && setup.command.length > 0 && setup.command.every(isNonEmptyString), 'setup.command');
      break;
    default:
  }
}

/**
 * Validates a TaskFile (IC-013). Returns findings `{code, taskId, message}`; messages name fields and
 * never carry task text. `split` is the split the file must declare. `devIds` (optional) are ids that
 * must not appear in this file (a holdout may not reuse a dev id).
 */
function validateTaskFile(taskFile: any, {
  split, snapshot, manifest, repoRoot = snapshotLib.REPO_ROOT, corpus, devIds, loaded, checkTrueNegatives = true,
}: any) {
  const findings: any = [];
  const file = (code: any, message: any) => findings.push({ code, taskId: null, message });
  if (!isObject(taskFile) || !Array.isArray(taskFile.tasks)) { file('E_SCHEMA', 'task file needs a tasks array'); return findings; }
  if (taskFile.schemaVersion !== 1) file('E_SCHEMA', 'schemaVersion must be 1');
  if (taskFile.snapshotId !== snapshot.snapshotId) file('E_SCHEMA', `snapshotId must be ${snapshot.snapshotId}`);
  if (taskFile.split !== split) file('E_SCHEMA', `split must be ${split}`);

  const { index, blobs } = loaded || loadBlobs({ repoRoot, manifest, tasks: taskFile.tasks });
  const lineCache = new Map();
  const linesOf = (entry: any) => {
    if (!lineCache.has(entry.blob)) lineCache.set(entry.blob, blobs.has(entry.blob) ? splitLines(blobs.get(entry.blob)) : null);
    return lineCache.get(entry.blob);
  };
  const seen = new Set();

  for (const task of taskFile.tasks) {
    const id = isObject(task) && typeof task.id === 'string' ? task.id : null;
    const add = (code: any, message: any) => findings.push({ code, taskId: id, message });
    if (!isObject(task)) { file('E_SCHEMA', 'a task is not an object'); continue; }

    const idRe = split === 'dev' ? /^D[CG]-\d{3}$/ : /^H[CG]-\d{3}$/;
    if (!id || !idRe.test(id)) add('E_ID_FORMAT', `id must match ${idRe}`);
    else if (id[1] !== (task.corpus === 'code' ? 'C' : 'G')) add('E_ID_FORMAT', 'id letter does not match the corpus');
    if (id) { if (seen.has(id)) add('E_ID_DUP', 'duplicate id'); seen.add(id); }
    if (devIds && id && devIds.has(id)) add('E_ID_DUP', 'id is also a dev task id');
    if (task.split !== split) add('E_SPLIT', `task split must be ${split}`);
    if (task.corpus !== 'code' && task.corpus !== 'guidance') { add('E_CORPUS', 'corpus must be code or guidance'); continue; }
    if (corpus && task.corpus !== corpus) add('E_CORPUS', `task corpus is not ${corpus}`);
    if (!CLASSES.includes(task.class)) { add('E_CLASS', 'unknown class'); continue; }
    if (!applicability(task.class, task.corpus).applicable) add('E_CLASS_NA', 'class does not apply to the corpus');
    if (!isNonEmptyString(task.query)) add('E_FIELD', 'query must be non-empty');
    if (!isObject(task.expect) || !Array.isArray(task.expect.result) || task.expect.result.length === 0
      || !task.expect.result.every((r: any) => RESULTS.includes(r))) add('E_EXPECT', 'expect.result must list result values');
    checkClassFields(task, split, add);

    const setup = isObject(task.setup) ? task.setup : {};
    if (split === 'holdout' && setup.patch !== undefined) add('E_PATCH_SPLIT', 'patch is dev only');
    if (split === 'dev' && setup.patchText !== undefined) add('E_PATCH_SPLIT', 'patchText is holdout only');
    if (split === 'dev' && setup.patch !== undefined) {
      if (typeof setup.patch !== 'string' || !setup.patch.startsWith(FIXTURES_PREFIX)) add('E_PATCH_PATH', `patch must be under ${FIXTURES_PREFIX}`);
      else if (!fs.existsSync(path.join(repoRoot, setup.patch))) add('E_PATCH_PATH', 'patch file does not exist');
    }

    if (!Array.isArray(task.truthSource) || task.truthSource.length === 0 || !task.truthSource.every(isNonEmptyString)) add('E_TRUTH_SOURCE', 'truthSource must be non-empty');
    if (!isNonEmptyString(task.author)) add('E_FIELD', 'author must be non-empty');
    if (typeof task.queryOverlap !== 'number' || !(task.queryOverlap >= 0 && task.queryOverlap <= 1)) add('E_FIELD', 'queryOverlap must be a number in 0..1');
    else if (task.class === 'conceptual-discovery' && task.queryOverlap > MAX_CONCEPTUAL_OVERLAP) add('E_OVERLAP', `queryOverlap exceeds ${MAX_CONCEPTUAL_OVERLAP}`);

    if (!Array.isArray(task.qrels)) { add('E_QREL', 'qrels must be an array'); continue; }
    const trueNegative = task.class === 'exact-lookup' && task.qrels.length === 0
      && Array.isArray(task.expect && task.expect.result) && task.expect.result.length === 1 && task.expect.result[0] === 'EMPTY';
    if (task.qrels.length === 0 && !trueNegative) add('E_QREL', 'qrels is empty and the task is not a true negative');
    if (trueNegative && checkTrueNegatives && isNonEmptyString(task.literal) && literalPresent(repoRoot, snapshot, task.literal)) {
      add('E_TRUE_NEGATIVE', 'literal occurs in the corpus');
    }

    const qrelIds = new Set();
    for (const qrel of allQrels(task)) {
      if (!isObject(qrel)) { add('E_QREL', 'a qrel is not an object'); continue; }
      if (typeof qrel.id !== 'string' || !/^q\d+$/.test(qrel.id)) add('E_QREL_ID', 'qrel id must match q<digits>');
      else if (qrelIds.has(qrel.id)) add('E_QREL_ID', 'duplicate qrel id');
      qrelIds.add(qrel.id);
      if (![0, 1, 2].includes(qrel.rel)) add('E_QREL', `qrel ${qrel.id} rel must be 0, 1 or 2`);
      if (task.corpus === 'guidance' && !isNonEmptyString(qrel.heading)) add('E_QREL_HEADING', `qrel ${qrel.id} needs a heading`);
      const entry = index.get(`${task.corpus}\0${qrel.path}`);
      if (!entry) { add('E_QREL_PATH', `qrel ${qrel.id} path is not in the ${task.corpus} manifest`); continue; }
      const lines = linesOf(entry);
      if (!lines) { add('E_QREL_PATH', `qrel ${qrel.id} blob is unreadable`); continue; }
      if (!isPosInt(qrel.startLine) || !isPosInt(qrel.endLine) || qrel.startLine > qrel.endLine || qrel.endLine > lines.length) {
        add('E_QREL_RANGE', `qrel ${qrel.id} lines are out of range (file has ${lines.length})`);
        continue;
      }
      if (qrel.anchorSha !== anchorOf(lines, qrel.startLine, qrel.endLine)) add('E_QREL_ANCHOR', `qrel ${qrel.id} anchorSha does not match`);
    }
  }
  return findings;
}

function orderKeys(obj: any, keys: any) {
  const out: any = {};
  for (const key of keys) if (obj[key] !== undefined) out[key] = obj[key];
  for (const key of Object.keys(obj)) if (!(key in out)) out[key] = obj[key];
  return out;
}

/**
 * Computes `anchorSha` for every qrel and dependency and `queryOverlap` for every task, in place of
 * whatever the author wrote. `tokenize` is the snapshot's own. Returns a new TaskFile (keys in schema
 * order) and the findings that stopped a value being computed.
 */
function fillTaskFile(taskFile: any, { snapshot, manifest, repoRoot = snapshotLib.REPO_ROOT, tokenize, loaded }: any) {
  const { index, blobs } = loaded || loadBlobs({ repoRoot, manifest, tasks: taskFile.tasks });
  const problems: any = [];
  const tasks = taskFile.tasks.map((task: any) => {
    const spanTokens = new Set();
    const fillQrel = (qrel: any) => {
      const entry = index.get(`${task.corpus}\0${qrel.path}`);
      const lines = entry && blobs.has(entry.blob) ? splitLines(blobs.get(entry.blob)) : null;
      if (!lines || !isPosInt(qrel.startLine) || !isPosInt(qrel.endLine) || qrel.startLine > qrel.endLine || qrel.endLine > lines.length) {
        problems.push({ code: 'E_QREL_RANGE', taskId: task.id, message: `qrel ${qrel.id} cannot be anchored` });
        return orderKeys(qrel, QREL_KEYS);
      }
      return orderKeys({ ...qrel, anchorSha: anchorOf(lines, qrel.startLine, qrel.endLine) }, QREL_KEYS);
    };
    const qrels = (task.qrels || []).map(fillQrel);
    for (const qrel of task.qrels || []) {
      const entry = index.get(`${task.corpus}\0${qrel.path}`);
      if (!entry || !blobs.has(entry.blob)) continue;
      const lines = splitLines(blobs.get(entry.blob));
      if (isPosInt(qrel.startLine) && isPosInt(qrel.endLine) && qrel.endLine <= lines.length) {
        for (const tok of tokenize(lines.slice(qrel.startLine - 1, qrel.endLine).join('\n'))) spanTokens.add(tok);
      }
    }
    const queryTokens = [...new Set(tokenize(task.query))];
    const overlap = queryTokens.length === 0 ? 0 : queryTokens.filter((t) => spanTokens.has(t)).length / queryTokens.length;
    const filled = { ...task, qrels, queryOverlap: Math.round(overlap * 1000) / 1000 };
    if (task.dependencies) filled.dependencies = task.dependencies.map(fillQrel);
    return orderKeys(filled, TASK_KEYS);
  });
  return { taskFile: orderKeys({ ...taskFile, tasks }, FILE_KEYS), problems };
}

/** Joins part files (each a TaskFile) into one, sorted by id; duplicate ids are rejected. */
function mergeParts(parts: any) {
  if (parts.length === 0) throw new Error('no parts to merge');
  const head = parts[0];
  const tasks = [];
  const seen = new Set();
  for (const part of parts) {
    for (const key of ['schemaVersion', 'snapshotId', 'split']) {
      if (part[key] !== head[key]) throw new Error(`parts disagree on ${key}`);
    }
    for (const task of part.tasks) {
      if (seen.has(task.id)) throw new Error(`duplicate task id ${task.id}`);
      seen.add(task.id);
      tasks.push(task);
    }
  }
  tasks.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return orderKeys({ ...head, tasks }, FILE_KEYS);
}

/** The snapshot's own `tokenize`, from a temporary export of the pinned commit. */
function loadSnapshotTokenize({ snapshot, repoRoot }: any) {
  const environment = require('./environment.ts');
  const tmp = environment.defaultTmpDir();
  const exported = environment.materialiseExport(snapshot.commit, tmp, snapshot, { repoRoot });
  try {
    const mod = require(path.join(exported.treeRoot, 'src', 'runtime', 'knowledge', 'retrieval.ts'));
    return mod.tokenize;
  } finally {
    exported.cleanup();
  }
}

function summarise(taskFile: any) {
  const counts: any = {};
  for (const task of taskFile.tasks) {
    const key = `${task.corpus}/${task.class}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function main(argv: any, { out = (m: any) => process.stdout.write(`${m}\n`), err = (m: any) => process.stderr.write(`${m}\n`) } = {}) {
  const usage = () => { err('usage: tasks.js --fill <file> | --check <file> --split <dev|holdout> | --merge <out> <in...> [--keep-parts]'); return 2; };
  const mode = argv[0];
  const readJson = (f: any) => JSON.parse(fs.readFileSync(f, 'utf8'));
  try {
    if (mode === '--merge') {
      const keep = argv.includes('--keep-parts');
      const [outFile, ...inputs] = argv.slice(1).filter((a: any) => a !== '--keep-parts');
      if (!outFile || inputs.length === 0) return usage();
      const merged: any = mergeParts(inputs.map(readJson));
      fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
      fs.writeFileSync(outFile, toFileText(merged));
      if (!keep) for (const f of inputs) if (path.resolve(f) !== path.resolve(outFile)) fs.rmSync(f);
      out(`merged ${merged.tasks.length} tasks into ${outFile}`);
      return 0;
    }
    if (mode !== '--fill' && mode !== '--check') return usage();
    const file = argv[1];
    if (!file) return usage();
    const snapshot = snapshotLib.loadSnapshot();
    const manifest = snapshotLib.loadManifest();
    const repoRoot = snapshotLib.REPO_ROOT;
    const taskFile = readJson(file);
    if (mode === '--fill') {
      const { taskFile: filled, problems }: any = fillTaskFile(taskFile, { snapshot, manifest, repoRoot, tokenize: loadSnapshotTokenize({ snapshot, repoRoot }) });
      for (const p of problems) err(`${p.code} ${p.taskId} ${p.message}`);
      if (problems.length === 0) fs.writeFileSync(file, toFileText(filled));
      out(problems.length === 0 ? `filled ${filled.tasks.length} tasks in ${file}` : `not written: ${problems.length} unresolved qrel(s)`);
      return problems.length === 0 ? 0 : 1;
    }
    const splitIdx = argv.indexOf('--split');
    const split = splitIdx > 0 ? argv[splitIdx + 1] : undefined;
    if (split !== 'dev' && split !== 'holdout') return usage();
    const findings = validateTaskFile(taskFile, { split, snapshot, manifest, repoRoot });
    out(`tasks: ${taskFile.tasks.length}`);
    for (const [key, n] of Object.entries(summarise(taskFile)).sort()) out(`  ${key}: ${n}`);
    out(`findings: ${findings.length}`);
    for (const f of findings) out(`  ${f.code} ${f.taskId || '-'} ${f.message}`);
    return findings.length === 0 ? 0 : 1;
  } catch (error: any) {
    err(`tasks.js: ${error.message}`);
    return 2;
  }
}

module.exports = {
  RESULTS, FIXTURES_PREFIX, MAX_CONCEPTUAL_OVERLAP,
  readBlobs, splitLines, anchorOf, loadBlobs, validateTaskFile, fillTaskFile, mergeParts, loadSnapshotTokenize, main,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));
