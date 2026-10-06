'use strict';

/**
 * Static reach: for each harness the ledger says is installed, can the skills it received find a
 * dispatcher and a runtime? The answer mirrors the lookup order of the skill resolver and of
 * `doflow-run` using stats only — no process is spawned and nothing touches the network — so
 * `doctor` can say "installed, but a skill's first runtime call would stop" before a skill runs.
 *
 * Reach belongs to the `.doflow` root that holds the dispatcher, not to a harness: a harness is
 * reached through a tree another harness installed in the same root.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readLedger, stateRoot } = require('../state');

/** Where the dispatcher sits under a `.doflow` root; the skill resolver and the locator shim spell the same path. */
const REACH_DISPATCHER_REL = 'scripts/doflow/bin/doflow-run';
/** Where the Node runtime sits under a `.doflow` root; `doflow-run` execs it from there. */
const REACH_RUNTIME_REL = 'runtime/bin/doflow.js';

/** `dir`, then each parent, ending when the parent is the directory itself (`/`, `C:\`). */
function* ancestors(dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    yield current;
    if (path.dirname(current) === current) return;
  }
}

function statIs(fsImpl, target, kind) {
  try { return fsImpl.statSync(target)[kind](); } catch { return false; }
}

function isExecutableFile(fsImpl, target) {
  if (!statIs(fsImpl, target, 'isFile')) return false;
  try { fsImpl.accessSync(target, fs.constants.X_OK); return true; } catch { return false; }
}

/**
 * @param {Object} options
 * @param {Object} options.registry loaded registry; its harness order orders the rows
 * @param {string} options.projectRoot directory the project walk starts from
 * @param {string} [options.homeDir]
 * @param {Object} [options.fsImpl]
 * @returns {{rows: Array<{harness: string, scope: 'project'|'global', installRoot: string, state: 'REACHED'|'NO-REACH'|'N/A', root?: string, reason?: string, fix?: string}>, unreadable: Array<{scope: string, ledger: string, detail: string}>}}
 */
function evaluateReach({ registry, projectRoot, homeDir = os.homedir(), fsImpl = fs }) {
  const real = (target) => { try { return fsImpl.realpathSync(target); } catch { return path.resolve(target); } };
  const start = real(projectRoot);
  const home = real(homeDir);
  const homeDoflow = path.join(home, '.doflow');
  const homeDispatcher = path.join(homeDoflow, REACH_DISPATCHER_REL);

  // Every ledger on the walk is read, not only the nearest: a removed harness's residue in a
  // subdirectory must not hide the install that encloses it. The walk stops at the home directory,
  // whose own ledger is the global scope; nothing above it is read.
  const scopes = [];
  if (start !== home) {
    const walk = [];
    for (const dir of ancestors(start)) {
      if (dir === home) break;
      walk.push(dir);
    }
    for (const installRoot of walk.filter((dir) => statIs(fsImpl, path.join(dir, '.doflow', 'state'), 'isDirectory'))) {
      scopes.push({
        scope: 'project',
        installRoot,
        stateDir: path.join(installRoot, '.doflow', 'state'),
        from: start,
        searched: `${path.join(start, '.doflow', REACH_DISPATCHER_REL)} and each directory above it, then ${homeDispatcher}`,
        doflowDirs: [...ancestors(start)].map((dir) => path.join(dir, '.doflow')).concat(homeDoflow),
        fix: (harness) => `npx @khoavu882/doflow install ${installRoot} -t ${harness}`,
      });
    }
  }
  scopes.push({
    scope: 'global',
    installRoot: home,
    stateDir: stateRoot({ scope: 'global', homeDir: home }),
    from: home,
    searched: homeDispatcher,
    doflowDirs: [homeDoflow],
    fix: (harness) => `npx @khoavu882/doflow install -g -t ${harness}`,
  });

  const harnessIds = registry.harnesses.map((harness) => harness.id);
  const rows = [];
  const unreadable = [];
  const seen = new Set();
  const addRow = (row) => {
    // A stale outer ledger that says what a nearer one already said adds nothing.
    const key = JSON.stringify([row.harness, row.scope, row.state, row.root, row.reason]);
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(row);
  };

  for (const { scope, installRoot, stateDir, from, searched, doflowDirs, fix } of scopes) {
    let ledger;
    try {
      ledger = readLedger(stateDir, { fsImpl });
    } catch (error) {
      unreadable.push({ scope, ledger: stateDir, detail: error.message });
      continue;
    }
    if (!ledger) continue;

    const resources = ledger.resources || [];
    const installed = harnessIds.filter((id) => resources.some((resource) => resource.harness === id));
    if (!installed.length) continue;

    const root = doflowDirs.find((dir) => isExecutableFile(fsImpl, path.join(dir, REACH_DISPATCHER_REL)));
    const dispatcher = root && path.join(root, REACH_DISPATCHER_REL);
    const configDir = [...ancestors(from)].map((dir) => path.join(dir, '.doflow')).find((dir) => statIs(fsImpl, dir, 'isDirectory'));
    const runtime = [configDir, homeDoflow].filter(Boolean).some((dir) => statIs(fsImpl, path.join(dir, REACH_RUNTIME_REL), 'isFile'));
    // The runtime is looked up in the nearest `.doflow` only, so a nearer one than this ledger's
    // install hides that install, and installing there would not change what the skills find.
    const hiddenBy = scope === 'project' && configDir && configDir !== path.join(installRoot, '.doflow') ? configDir : null;

    for (const harness of installed) {
      if (!resources.some((resource) => resource.harness === harness && resource.assetId === 'skills.doflow')) {
        addRow({ harness, scope, installRoot, state: 'N/A', reason: `no skills at ${scope} scope` });
      } else if (dispatcher && runtime) {
        addRow({ harness, scope, installRoot, state: 'REACHED', root });
      } else {
        addRow({
          harness,
          scope,
          installRoot,
          state: 'NO-REACH',
          reason: dispatcher
            ? `dispatcher at ${dispatcher} but no ${REACH_RUNTIME_REL}`
            : `no executable dispatcher at ${searched}`,
          fix: hiddenBy
            ? `${hiddenBy} hides the install at ${installRoot}; remove it if it is stale, or run: npx @khoavu882/doflow install ${path.dirname(hiddenBy)} -t ${harness}`
            : fix(harness),
        });
      }
    }
  }

  return { rows, unreadable };
}

module.exports = { REACH_DISPATCHER_REL, REACH_RUNTIME_REL, evaluateReach };
