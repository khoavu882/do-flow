'use strict';

/**
 * `retrieval migrate --to <commit>` (074 IC-007): proposes a re-pinned snapshot as `.next` files and
 * never overwrites a live one. A qrel moves only when its anchor block occurs exactly once at the new
 * commit, in the same path; otherwise it is marked `unresolved`.
 */

const fs = require('node:fs');
const path = require('node:path');
const sealLib = require('../seal.ts');
const snapshotLib = require('../snapshot.ts');
const tasksLib = require('../tasks.ts');
const environment = require('../environment.ts');

const flags = { to: 'value', 'key-file': 'value' };

/** Where the block whose anchor is `anchorSha` sits in `lines`: `{startLine, endLine}` when it occurs exactly once. */
function relocate(lines: any, qrel: any) {
  const length = qrel.endLine - qrel.startLine + 1;
  const found = [];
  for (let i = 0; i + length <= lines.length; i++) {
    if (tasksLib.anchorOf(lines, i + 1, i + length) === qrel.anchorSha) found.push(i + 1);
  }
  return found.length === 1 ? { startLine: found[0], endLine: found[0] + length - 1 } : null;
}

/**
 * Relocates every qrel and dependency of `tasks` against the new manifest. Returns the new tasks
 * (qrels that did not resolve carry `unresolved: true`) and the unresolved list.
 */
function relocateTasks({ tasks, index, blobs }: any) {
  const unresolved: any = [];
  const move = (task: any, qrel: any) => {
    const entry = index.get(`${task.corpus}\0${qrel.path}`);
    const lines = entry && blobs.has(entry.blob) ? tasksLib.splitLines(blobs.get(entry.blob)) : null;
    const where = lines ? relocate(lines, qrel) : null;
    if (!where) {
      unresolved.push({ taskId: task.id, qrelId: qrel.id, path: qrel.path });
      return { ...qrel, unresolved: true };
    }
    const { unresolved: _drop, ...rest } = qrel;
    return { ...rest, ...where };
  };
  const moved = tasks.map((task: any) => {
    const next = { ...task, qrels: (task.qrels || []).map((q: any) => move(task, q)) };
    if (task.dependencies) next.dependencies = task.dependencies.map((q: any) => move(task, q));
    return next;
  });
  return { tasks: moved, unresolved };
}

/** Counts qrels that do not resolve at the new commit in the newest sealed generation of each corpus; never keeps or prints them. */
function countHoldoutUnresolved({ repoRoot, passphrase, index, blobsFor }: any) {
  const dir = path.join(repoRoot, 'bench', 'retrieval', 'holdout');
  let count = 0;
  for (const corpus of ['code', 'guidance']) {
    const generations = sealLib.listGenerations(dir, corpus);
    if (generations.length === 0) continue;
    const g = generations[generations.length - 1];
    const label = `bench/retrieval/holdout/${corpus}.g${g}.sealed.json`;
    const { taskFile } = sealLib.decrypt(sealLib.readEnvelope(dir, corpus, g), passphrase, label);
    const blobs = blobsFor(taskFile.tasks);
    count += relocateTasks({ tasks: taskFile.tasks, index, blobs }).unresolved.length;
  }
  return count;
}

function migrate({ to, keyFile, snapshotPath, repoRoot, env = process.env, home }: any) {
  if (!to) throw new sealLib.SealError('--to <commit> is required');
  const snapshot = snapshotLib.loadSnapshot(snapshotPath);
  let commit;
  try {
    commit = snapshotLib.git(repoRoot, ['rev-parse', '--verify', `${to}^{commit}`]).toString('utf8').trim();
  } catch {
    throw new sealLib.SealError(`commit ${to} is not in this repository; fetch full history`);
  }

  const next = { ...snapshot, snapshotId: snapshot.snapshotId + 1, commit };
  const entries = snapshotLib.buildManifest(repoRoot, commit, next);
  const index = new Map(entries.map((e: any) => [`${e.corpus}\0${e.path}`, e]));
  const blobsFor = (tasks: any) => tasksLib.loadBlobs({ repoRoot, manifest: { entries }, tasks }).blobs;

  const devFile = path.join(repoRoot, snapshot.taskFiles.dev.path);
  const dev = fs.existsSync(devFile) ? JSON.parse(fs.readFileSync(devFile, 'utf8')) : { schemaVersion: 1, snapshotId: snapshot.snapshotId, split: 'dev', tasks: [] };
  const { tasks, unresolved } = relocateTasks({ tasks: dev.tasks, index, blobs: blobsFor(dev.tasks) });
  const devNextText = sealLib.toFileText({ ...dev, snapshotId: next.snapshotId, tasks });

  const key = sealLib.resolveKey({ keyFile, env, home, repoRoot, optional: true });
  const holdoutUnresolved = key ? countHoldoutUnresolved({ repoRoot, passphrase: key.passphrase, index, blobsFor }) : 0;

  const nextSnapshot = {
    ...next,
    manifestSha256: snapshotLib.manifestDigest(entries),
    tools: environment.captureTools(),
    node: process.version, os: process.platform, arch: process.arch,
    taskFiles: { dev: { path: snapshot.taskFiles.dev.path, sha256: sealLib.sha256Hex(devNextText) } },
  };
  const retrievalDir = path.dirname(path.resolve(repoRoot, snapshot.manifestPath));
  fs.mkdirSync(path.join(retrievalDir, 'tasks'), { recursive: true });
  snapshotLib.writeJsonFile(path.join(retrievalDir, 'snapshot.next.json'), nextSnapshot);
  snapshotLib.writeJsonFile(path.join(retrievalDir, 'manifest.next.json'), { schemaVersion: 1, commit, entries });
  fs.writeFileSync(path.join(path.dirname(devFile), 'dev.next.json'), devNextText);

  return { nextSnapshotId: nextSnapshot.snapshotId, unresolved, holdoutUnresolved, holdoutChecked: Boolean(key) };
}

function run(ctx: any) {
  const out = migrate({ to: ctx.args.to, keyFile: ctx.args['key-file'], snapshotPath: ctx.snapshotPath, repoRoot: ctx.repoRoot });
  const lines = out.unresolved.map((u: any) => `unresolved ${u.taskId} ${u.qrelId} ${u.path}`);
  lines.push(out.holdoutChecked ? `holdout qrels unresolved: ${out.holdoutUnresolved}` : 'holdout not checked: no key');
  lines.push('wrote snapshot.next.json, manifest.next.json and tasks/dev.next.json; promote them by renaming in a commit that also runs capture');
  const bad = out.unresolved.length > 0 || out.holdoutUnresolved > 0;
  return { exitCode: bad ? 1 : 0, lines, nextSnapshotId: out.nextSnapshotId, unresolved: out.unresolved, holdoutUnresolved: out.holdoutUnresolved, holdoutChecked: out.holdoutChecked };
}

module.exports = { flags, relocate, relocateTasks, migrate, run };
