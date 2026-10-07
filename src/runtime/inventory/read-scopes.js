'use strict';

/**
 * C2 — dual-scope reader (FR-002, NFR-002).
 *
 * The rest of the CLI resolves scope once per invocation, as a boolean, and derives every root
 * from it; a cross-scope report cannot be assembled that way. This module calls the existing
 * scope-resolved lifecycle view twice — once per scope descriptor it constructs — and returns one
 * snapshot per scope. It changes no other caller's scope handling and it reads only: nothing here
 * writes, moves, or creates recorded state (NFR-001).
 *
 * Two constraints shape the interface:
 *
 * - **The global scope root is not an argument (design R7).** `registryLifecycleView` derives it
 *   from `os.homedir()` whenever the scope descriptor carries `global: true`, and silently ignores
 *   a `projectRoot` on that same descriptor. So this reader supplies only the project root; the
 *   global root is inherited from the environment, which is correct at runtime. A test that needs
 *   a synthetic global root must relocate `os.homedir` around the (synchronous) call.
 * - **A scope with nothing recorded is a value, not a failure (NFR-002).** A repository never
 *   installed into is the ordinary state, so its snapshot is returned empty and `recorded: false`
 *   rather than raising, and reporting that absence creates no ledger on disk.
 *
 * Two further properties are load-bearing for the currency judgement downstream, because that
 * judgement is read from the plan this module returns beside the resources:
 *
 * - **The restriction restricts the resources, not only the plan.** `targets` bounds the plan the
 *   view computes, so a resource of an unrequested harness has no plan to be judged against. It is
 *   therefore left out of the snapshot rather than returned beside a plan that never looked at it —
 *   IC-001 makes `targets` a restriction to named harnesses, so a harness outside it is not part of
 *   what was asked. Returning the whole ledger here made every unrequested harness's copy read as
 *   current, which is the one thing this reader must not let a consumer conclude.
 * - **The plan is computed with the selections the scope recorded.** `planLifecycle` gives each
 *   harness the MCP servers handed to it for that harness, so an empty list is not a neutral
 *   default: it is a positive statement that no server was chosen, and the plan then proposes to
 *   remove every one the harness owns. `doflow reconcile` and `doflow status` derive each
 *   harness's selection from the scope's own `doflow.lock` and ledger through
 *   `recordedMcpSelections` (`src/install/mcp.js`); this reader calls the same function per scope,
 *   so the plan a currency judgement is derived from is the plan the repair command would produce.
 */

const os = require('node:os');
const { registryLifecycleView, LIFECYCLE_HARNESSES } = require('../../lifecycle/view');
const { readLock } = require('../../state/lockfile');
const { stateRoot, readLedger } = require('../../state');
const { recordedMcpSelections } = require('../../install/mcp');
const { readInstallManifest } = require('../../install/manifest');

/**
 * @typedef {Object} ScopeSnapshot The `SCOPE_SNAPSHOT` entity of the feature's data model.
 * @property {'global'|'project'} scope Which scope was read.
 * @property {string} scopeRoot The root that scope resolved to — home directory, or project root.
 * @property {string} stateRoot The neutral state root beneath `scopeRoot`; may not exist on disk.
 * @property {boolean} recorded Whether anything is recorded at this scope. Derived from the
 *   ledger's contents rather than from the ledger file's existence, so a scope holding an empty
 *   ledger and a scope holding no ledger at all report alike — both have nothing recorded. It
 *   describes the **scope**, not the restriction: a scope holding a full install reports `true`
 *   under a restriction that matches none of it, because "nothing is recorded here" would be false.
 * @property {string[]} targets The harnesses this snapshot was read for — what `resources` is
 *   restricted to, stated rather than left for a consumer to infer from the rows present.
 * @property {Array<Object>} resources The `MANAGED_RESOURCE` records of the requested harnesses,
 *   exactly as stored. Read only.
 * @property {Object} ledger The whole neutral ledger, unrestricted, for consumers needing more than
 *   the requested harnesses' resources.
 * @property {Object} plan The lifecycle plan for this scope and these harnesses, already computed by
 *   the view; it is what a currency judgement is derived from downstream.
 */

/** @returns {ScopeSnapshot} */
function snapshot(scope, view, targets) {
  const { ledger } = view;
  const wanted = new Set(targets);
  return {
    scope,
    scopeRoot: ledger.scopeRoot,
    stateRoot: view.stateRoot,
    recorded: ledger.resources.length > 0 || Object.keys(ledger.targets).length > 0,
    targets,
    resources: ledger.resources.filter((resource) => wanted.has(resource?.harness)),
    ledger,
    plan: view.plan,
  };
}

/**
 * Read the recorded state of both scopes within one invocation.
 *
 * @param {Object} options
 * @param {Object} options.registry Registry loaded once by the caller and threaded through, as
 *   every other lifecycle-view call site does.
 * @param {string} options.repoRoot Root of the DoFlow source the view reads native sources from.
 * @param {string} options.projectRoot Root of the project scope. The global scope's root is not a
 *   parameter — see R7 above.
 * @param {string[]} [options.targets] Harnesses to read. Defaults to every lifecycle harness,
 *   which is what an inventory of the whole install wants. Both the plan and the returned resources
 *   are restricted to these.
 * @param {{global: Object|null, project: Object|null}} [options.locks] Lock documents per scope, for
 *   a caller that already read them (the report reads them anyway, for repair coverage). Omitted,
 *   each scope's lock is read from disk — `readLock` returns `null` for a scope with none, and a
 *   scope with no lock is a normal value here, not a failure (NFR-002).
 * @returns {{global: ScopeSnapshot, project: ScopeSnapshot, scopes: ScopeSnapshot[]}}
 * @throws when a lock file exists but cannot be parsed. Propagated deliberately: the plan would be
 *   computed from a selection nobody can read, so a currency judgement derived from it would be
 *   fiction. `reconcile` fails on the same document.
 */
function readScopes({ registry, repoRoot, projectRoot, targets = LIFECYCLE_HARNESSES, locks }) {
  const wanted = [...new Set(targets)];
  const resolved = locks ?? {
    // The global lock root is the home directory, the same root design R7 keeps out of this
    // signature; `readLock` defaults to `os.homedir()`, so both halves agree without a parameter.
    global: readLock({ scope: 'global' }),
    project: readLock({ scope: 'project', projectRoot }),
  };
  const read = (scope) => {
    // Each scope's own ledger, at the root the view itself reads it from.
    const ledger = readLedger(scope === 'global'
      ? stateRoot({ scope: 'global', homeDir: os.homedir() }) : stateRoot({ scope: 'project', projectRoot }));
    const manifestServers = readInstallManifest({ scopeRoot: scope === 'global' ? os.homedir() : projectRoot })?.mcpServers ?? null;
    const recorded = recordedMcpSelections({ registry, lock: resolved?.[scope] ?? null, ledger, targets: wanted, manifestServers });
    return registryLifecycleView({
      registry, repoRoot, targets: wanted, mcpSelections: recorded.selections, mcpAdoptable: recorded.adoptable,
      scope: scope === 'global' ? { global: true } : { global: false, projectRoot },
    });
  };
  const global = snapshot('global', read('global'), wanted);
  const project = snapshot('project', read('project'), wanted);
  return { global, project, scopes: [global, project] };
}

module.exports = { readScopes };
