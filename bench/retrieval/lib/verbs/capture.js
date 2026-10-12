'use strict';

/**
 * `retrieval capture` (074 IC-004): runs the dev split for both configurations on both corpora and
 * freezes the result as `bench/retrieval/baseline.json`, with the `capture` block that says when, on
 * what machine and with which runner it was taken. It refuses an unverified snapshot or a dev task
 * file that is not committed, because the baseline must describe tasks anyone can check out.
 */

const fs = require('node:fs');
const path = require('node:path');
const sealLib = require('../seal.js');
const snapshotLib = require('../snapshot.js');
const report = require('../report.js');
const metricsLib = require('../metrics.js');
const runVerb = require('./run.js');
const verifyVerb = require('./verify.js');

const flags = { from: 'value' };
const BASELINE_PATH = 'bench/retrieval/baseline.json';
const RUNNER_FILE = path.resolve(__dirname, '..', '..', 'runner.js');

class Refusal extends sealLib.SealError {}

function gitOk(repoRoot, args) {
  try { snapshotLib.git(repoRoot, args); return true; } catch { return false; }
}

/** Git blob id of the runner file this process is executing. */
function runnerBlob() {
  return snapshotLib.git(path.dirname(RUNNER_FILE), ['hash-object', RUNNER_FILE]).toString('utf8').trim();
}

function capture({ args, snapshotPath, repoRoot, tmp, keepTmp, env, home, deps, now = new Date() }) {
  const snapshot = snapshotLib.loadSnapshot(snapshotPath);
  const devPath = snapshot.taskFiles.dev.path;
  if (!fs.existsSync(path.join(repoRoot, devPath)) || !gitOk(repoRoot, ['ls-files', '--error-unmatch', devPath])
    || !gitOk(repoRoot, ['diff', '--quiet', 'HEAD', '--', devPath])) {
    throw new Refusal(`${devPath} is missing or not committed; commit the dev tasks before capture`);
  }
  const verifier = (deps && deps.verifySnapshot) || verifyVerb.verifySnapshot;
  const verified = verifier({ snapshotPath, repoRoot });
  if (verified.exitCode !== 0) throw new Refusal(`verify failed (exit ${verified.exitCode}): ${verified.message}`);

  let source;
  if (args.from) {
    source = JSON.parse(fs.readFileSync(args.from, 'utf8'));
    const currentSha = sealLib.sha256Hex(fs.readFileSync(path.join(repoRoot, devPath)));
    if (source.snapshotId !== snapshot.snapshotId) throw new Refusal(`--from run is for snapshot ${source.snapshotId}, current is ${snapshot.snapshotId}`);
    if (source.tasksSha256 !== currentSha) throw new Refusal('--from run was taken on different dev tasks than the committed file');
  } else {
    const out = runVerb.execute({ args: { config: 'A,B', corpus: 'all', split: 'dev' }, snapshotPath, repoRoot, tmp, keepTmp, env, home, deps });
    if (out.exitCode !== 0) {
      const error = new Refusal(`the dev run failed: ${(out.lines || []).join('; ')}`);
      error.exitCode = out.exitCode;
      throw error;
    }
    source = out.report;
  }

  const baseline = report.buildBaseline({
    snapshot, tasksSha256: source.tasksSha256,
    capture: { capturedAt: now.toISOString(), machineId: report.machineId(), runnerBlob: runnerBlob(), node: process.version, os: process.platform, arch: process.arch },
    corpora: source.corpora, perTask: source.perTask,
  });
  fs.writeFileSync(path.join(repoRoot, BASELINE_PATH), sealLib.toFileText(baseline));
  const classes = Object.keys(source.corpora).reduce((n, corpus) => n + metricsLib.classesFor(corpus).length, 0);
  return { path: BASELINE_PATH, classes };
}

function run(ctx) {
  const out = capture({
    args: ctx.args, snapshotPath: ctx.snapshotPath, repoRoot: ctx.repoRoot, tmp: ctx.tmp, keepTmp: ctx.keepTmp,
  });
  return { exitCode: 0, lines: [`wrote ${out.path} (${out.classes} classes)`], ...out };
}

module.exports = { flags, BASELINE_PATH, capture, runnerBlob, run };
