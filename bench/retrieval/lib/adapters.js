'use strict';

/**
 * Adapter dispatcher (074 IC-008): the one entry the run verb calls. It applies a task's `setup`
 * patch to a per-task copy of the export, routes to configuration A or B, and returns an
 * AdapterAnswer. The provider logic lives in adapters-a.js and adapters-b.js.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { childEnv } = require('../runner.js');
const adaptersA = require('./adapters-a.js');
const adaptersB = require('./adapters-b.js');
const adaptersC = require('./adapters-c.js');
const snapshotLib = require('./snapshot.js');

const B_PROVIDER = { code: 'native.rg', guidance: 'guidance.bm25' };

/** Applies `setup.patch` (dev, a repo path) or `setup.patchText` (holdout, inline) to `copy`. Throws on failure. */
function applyPatch(task, copy, repoRoot) {
  const setup = task.setup || {};
  let patchFile;
  let cleanup = () => {};
  if (setup.patch) {
    patchFile = path.resolve(repoRoot, setup.patch);
  } else if (setup.patchText) {
    patchFile = path.join(path.dirname(copy), `${path.basename(copy)}.patch`);
    fs.writeFileSync(patchFile, setup.patchText);
    cleanup = () => fs.rmSync(patchFile, { force: true });
  } else {
    return;
  }
  try {
    const run = spawnSync('git', ['apply', '--unsafe-paths', `--directory=${fs.realpathSync(copy)}`, patchFile], { cwd: copy, env: childEnv(), encoding: 'utf8' });
    if (run.status !== 0) {
      if (task.split === 'holdout' || (task.id && /^H[CG]-/.test(task.id))) {
        throw new Error('setup patch failed for a holdout task');
      }
      throw new Error(`setup patch for ${task.id || 'task'} does not apply: ${String(run.stderr).trim().split('\n')[0]}`);
    }
  } finally {
    cleanup();
  }
}

/** A copy of the export without index output, so live providers see the patched tree. */
function copyExport(exportRoot, copy) {
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(exportRoot, copy, { recursive: true, filter: (src) => path.basename(src) !== 'graphify-out' });
}

function unreachedB(corpus, cause) {
  return {
    result: 'UNREACHED', freshness: corpus === 'guidance' ? 'UNKNOWN' : 'NOT_APPLICABLE', candidates: [],
    providers: [{ id: B_PROVIDER[corpus], state: 'unreached', cause }], payloadBytes: 0, wallMs: 0,
  };
}

/** Deduplicates, cuts to the corpus k_max and recomputes the payload from what is left. */
function normalize(answer, kMax) {
  if (!answer.candidates || answer.output !== undefined) return answer; // a command answer's payload is its output
  const candidates = adaptersB.finalize(answer.candidates, kMax);
  const out = { ...answer, candidates, payloadBytes: adaptersB.payloadOf(candidates) };
  if (answer.graphCandidates) out.graphCandidates = adaptersB.finalize(answer.graphCandidates, kMax);
  return out;
}

/**
 * Runs one configuration on one task. `exportRoot` is the pinned export, `workDir` where per-task
 * copies live. Guidance configuration A is configuration B, so it returns `{sameAs: 'B'}` and the
 * caller reuses B's answer. For configuration A the index root stays the unpatched export, which is
 * what makes a stale-index task query an index built before the patch.
 */
function runConfig({
  config, corpus, task, exportRoot, snapshot, workDir, indexDir, bins, capabilities, semble, scratchDir,
  admittedPaths, protocol,
  repoRoot = snapshotLib.REPO_ROOT, impl = { runA: adaptersA.runA, runB: adaptersB.runB, runC: adaptersC.runC, runVerification: adaptersA.runVerification },
}) {
  if (!['A', 'B'].includes(config) && !(config === 'C' && protocol === 'hybrid-c-v1')) throw new Error(`unknown configuration "${config}"`);
  if (corpus === 'guidance' && config === 'A') return { sameAs: 'B' };

  const kMax = snapshot && snapshot.corpora ? snapshot.corpora[corpus].kMax : adaptersB.K_MAX[corpus];
  const patched = Boolean(task.setup && (task.setup.patch || task.setup.patchText));
  let root = exportRoot;
  let index = indexDir;
  if (patched) {
    const copiesDir = workDir || path.join(path.dirname(exportRoot), 'copies');
    root = path.join(copiesDir, `task-${task.id}`);
    fs.mkdirSync(copiesDir, { recursive: true });
    copyExport(exportRoot, root);
    applyPatch(task, root, repoRoot);
    index = path.join(copiesDir, `task-${task.id}-index`);
  }

  try {
    if (config === 'B') {
      const disabled = (task.setup && task.setup.disable) || [];
      if (disabled.includes(B_PROVIDER[corpus])) return normalize(unreachedB(corpus, 'disabled by setup.disable'), kMax);
      if (task.class === 'verification-failure') return impl.runVerification({ task, root, config: 'B', bins, scratchDir });
      return normalize(impl.runB({ corpus, task, exportRoot: root, indexDir: index, bins, admittedPaths }), kMax);
    }
    if (config === 'C') return normalize(impl.runC({ corpus, task, exportRoot: root, indexRoot: exportRoot, capabilities, bins,
      semble, scratchDir, admittedPaths }), kMax);
    return normalize(impl.runA({ task, exportRoot: root, indexRoot: exportRoot, capabilities, bins, semble, scratchDir, admittedPaths }), kMax);
  } finally {
    if (patched) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(index, { recursive: true, force: true });
    }
  }
}

module.exports = { runConfig, applyPatch, copyExport, normalize };
