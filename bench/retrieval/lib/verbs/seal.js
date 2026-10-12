'use strict';

/**
 * `retrieval seal` (074 IC-006): validates a holdout plaintext against the pinned snapshot and writes
 * the sealed envelope and seal digest. The output carries counts and digests, never task text.
 */

const fs = require('node:fs');
const path = require('node:path');
const sealLib = require('../seal.js');
const snapshotLib = require('../snapshot.js');
const tasksLib = require('../tasks.js');
const metricsLib = require('../metrics.js');

const flags = { corpus: 'value', in: 'value', 'key-file': 'value', 'delete-plaintext': 'bool' };

class Refusal extends sealLib.SealError {}

function realOrResolved(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function devIdsOf(repoRoot, snapshot) {
  const file = path.join(repoRoot, snapshot.taskFiles.dev.path);
  if (!fs.existsSync(file)) return new Set();
  const dev = JSON.parse(fs.readFileSync(file, 'utf8'));
  return new Set((dev.tasks || []).map((t) => t.id));
}

/**
 * Steps 1 to 9 of IC-006. Returns `{exitCode, findings, ...summary}`; validation findings return
 * exit 1 and write nothing. Throws a SealError (exit 2) for a refused precondition.
 */
function sealCorpus({ corpus, inFile, keyFile, deletePlaintext, snapshotPath, repoRoot, env = process.env, home, now }) {
  if (corpus !== 'code' && corpus !== 'guidance') throw new Refusal('--corpus must be code or guidance');
  if (!inFile) throw new Refusal('--in <plaintext.json> is required');
  const input = realOrResolved(inFile);
  if (isInside(realOrResolved(repoRoot), input)) throw new Refusal('refusing --in inside the repository: holdout plaintext must stay outside it');
  const key = sealLib.resolveKey({ keyFile, env, home, repoRoot });

  let taskFile;
  try { taskFile = JSON.parse(fs.readFileSync(input, 'utf8')); } catch (error) { throw new Refusal(`cannot read --in as JSON: ${error.message}`); }

  const snapshot = snapshotLib.loadSnapshot(snapshotPath);
  const manifest = snapshotLib.loadManifest(path.resolve(repoRoot, snapshot.manifestPath));
  const findings = tasksLib.validateTaskFile(taskFile, {
    split: 'holdout', snapshot, manifest, repoRoot, corpus, devIds: devIdsOf(repoRoot, snapshot),
  });
  const present = new Set((taskFile.tasks || []).filter((t) => t && t.corpus === corpus).map((t) => t.class));
  for (const cls of metricsLib.classesFor(corpus)) {
    if (!present.has(cls)) findings.push({ code: 'E_CLASS_MISSING', taskId: null, message: `no ${cls} task` });
  }
  if (findings.length > 0) return { exitCode: 1, findings };

  const holdoutDir = path.join(repoRoot, 'bench', 'retrieval', 'holdout');
  const generation = sealLib.nextGeneration(holdoutDir, corpus);
  const authors = [...new Set(taskFile.tasks.map((t) => t.author))].sort();
  const sealed = sealLib.sealTasks({
    taskFile, passphrase: key.passphrase, corpus, snapshotId: snapshot.snapshotId, generation,
    sealedBy: authors.join(','), classes: metricsLib.CLASSES, now,
  });
  sealLib.writeSealed({ dir: holdoutDir, corpus, generation, envelopeText: sealed.envelopeText, sealText: sealed.sealText });
  if (deletePlaintext) fs.rmSync(input);
  return {
    exitCode: 0, findings: [], corpus, generation, taskCount: sealed.seal.taskCount,
    classCounts: sealed.seal.classCounts, plaintextSha256: sealed.seal.plaintextSha256,
  };
}

function run(ctx) {
  const out = sealCorpus({
    corpus: ctx.args.corpus, inFile: ctx.args.in, keyFile: ctx.args['key-file'], deletePlaintext: Boolean(ctx.args['delete-plaintext']),
    snapshotPath: ctx.snapshotPath, repoRoot: ctx.repoRoot,
  });
  const lines = out.findings.map((f) => `${f.code} ${f.taskId || '-'} ${f.message}`);
  if (out.exitCode === 0) lines.push(`sealed ${out.taskCount} ${out.corpus} tasks as generation ${out.generation}`);
  else lines.push(`seal: ${out.findings.length} finding(s); nothing was written`);
  const { exitCode, findings, ...summary } = out;
  return { exitCode, lines, ...summary, ...(findings.length ? { findings } : {}) };
}

module.exports = { flags, sealCorpus, run };
