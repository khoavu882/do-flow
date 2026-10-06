'use strict';
// mcp.js — MCP server selection: which of the registry's servers each harness gets, from --mcp,
// the interactive checkbox, doflow.lock, the ledger or a 1.18.0 manifest. Writing a harness's MCP
// file is that harness's adapter's job (src/adapters/<id>/), never this module's.
const { readSyncBlocking } = require('../helper/prompt');
const { selectMcpServers, nativeMcpCatalog, mcpCapable } = require('../registry');
const { pinnedSelections } = require('../state/lockfile');

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

/** @param {object} registry a loaded registry (src/registry#loadRegistry)
 *  @returns {string[]} server names in registry declaration order */
function readAllServers(registry) {
  return nativeMcpCatalog(selectMcpServers(registry)).allServers;
}

/**
  * Decide which MCP servers to install, in precedence order:
  *   1. --mcp <list>|all|none — explicit, always wins, always persisted ('all'/'none' are
  *                              keywords and cannot be mixed with server names)
  *   2. interactive checkbox  — install only, real TTY, no --force/--dry-run
  *   3. remembered manifest   — update (or a forced/non-interactive install) reuses the last pick
  *   4. none                  — first-ever install without a TTY defaults to an EMPTY selection
  *                              (safe by default: third-party servers are opt-in). Interactive
  *                              installs still get the checkbox pre-seeded with the catalog.
 * `promptFn` is injected so this stays unit-testable without a real TTY.
 * @param {{cmd:string, requested:string[]|null, allServers:string[], manifestServers:string[]|null,
 *           interactive:boolean, promptFn:(servers:string[], seed:string[])=>string[]|null}} p
 * @returns {string[]}
 */
function resolveMcpSelection({ cmd, requested, allServers, manifestServers, interactive, promptFn, onStale }) {
  if (requested) return parseMcpFlag(requested, allServers);

  // `requested` is user intent, so an unknown name above is a typo and must be fatal. The manifest
  // selection is *persisted resolved state* (see src/manifest.js), so an id the registry no longer
  // declares means the project retired that server between installs — a normal upgrade, not user
  // error. Passing it through unfiltered reached selectMcpServers() in src/registry/index.js,
  // which throws, so removing chrome-devtools and playwright from core/registry/mcp.json (d1bf9e8)
  // made `install` and `update` fatally fail for every install predating that commit, with no hint
  // that `--mcp <survivors>` was the way out. cmdStatus already tolerated the same state because
  // it happens to wrap the call in try/catch; reconcile here so every caller behaves that way.
  const remembered = manifestServers ?? null;
  const known = remembered?.filter((s) => allServers.includes(s)) ?? null;
  const retired = remembered?.filter((s) => !allServers.includes(s)) ?? [];
  if (retired.length && onStale) onStale(retired);

  if (cmd === 'install' && interactive) {
    // Seed the checkbox from reconciled state too — pre-ticking a server that no longer exists
    // would offer the user a choice the registry cannot honor.
    const seed = known ?? allServers;
    const picked = promptFn(allServers, seed);
    if (picked !== null) return picked; // [] is a deliberate "no servers" choice, honored as-is
  }

  // An explicitly empty remembered selection stays empty: the user chose "no servers", and a
  // catalog reshuffle must not resurrect third-party processes behind their back. Likewise the
  // first-ever non-interactive default is now NONE — third-party servers are opt-in
  // (--mcp all|<names>); interactive installs remain the discovery path via the pre-seeded
  // checkbox above.
  if (known && known.length === 0) return [];
  return known ?? [];
}

/** Parse `--mcp`: `all` and `none` are keywords that cannot be mixed with names or each other, an
 * empty list and an unknown name are errors, names are deduplicated. `null` when the flag is absent. */
function parseMcpFlag(requested, catalogIds) {
  if (!requested) return null;
  const keywords = requested.filter((s) => s === 'all' || s === 'none');
  if (keywords.length) {
    if (keywords.length !== requested.length) {
      throw new Error(`--mcp keyword '${keywords[0]}' cannot be combined with server names`);
    }
    if (new Set(requested).size > 1) {
      throw new Error("Choose either '--mcp all' or '--mcp none', not both");
    }
    return keywords[0] === 'all' ? [...catalogIds] : [];
  }
  if (requested.length === 0) {
    throw new Error("--mcp requires at least one server; use '--mcp none' for an explicit empty selection");
  }
  const invalid = requested.filter((s) => !catalogIds.includes(s));
  if (invalid.length) {
    throw new Error(`Unknown MCP server(s): ${invalid.join(', ')} (valid: ${catalogIds.join(', ')})`);
  }
  return [...new Set(requested)];
}

const holdsRows = (ledger, harness) => (ledger?.resources ?? []).some((row) => row.harness === harness);

/** Ids of `lists` that the catalog still declares, as one union in registry order. */
const catalogUnion = (catalogIds, lists) => catalogIds.filter((id) => lists.some((ids) => ids.includes(id)));

/** Per MCP-capable harness, the servers DoFlow may adopt when their entries already equal its own:
 * none for a harness the ledger does not hold, else its lock row, or the whole catalog when the lock
 * has no row for it. Retired ids are dropped. */
function adoptableMcpIds({ registry, lock, ledger, harnesses }) {
  const catalogIds = readAllServers(registry);
  const rows = pinnedSelections(lock);
  return Object.fromEntries(harnesses.filter((harness) => mcpCapable(registry, harness)).map((harness) => {
    if (!holdsRows(ledger, harness)) return [harness, []];
    return [harness, harness in rows ? catalogUnion(catalogIds, [rows[harness]]) : [...catalogIds]];
  }));
}

/** Servers another harness of this scope still has recorded: the union of the lock rows of the lock's
 * harnesses that are not targeted, registry order. */
function retainedMcpIds(catalogIds, rows, targets) {
  return catalogUnion(catalogIds, Object.entries(rows).filter(([harness]) => !targets.includes(harness)).map(([, ids]) => ids));
}

/**
 * Decide each targeted MCP-capable harness's servers. Per harness, the first step that applies:
 *   1. --mcp <list>|all|none  -> the parsed ids                                        (flag)
 *   2. install on a real TTY  -> one checkbox for every harness; a null answer falls through (prompt)
 *   3. a lock row             -> that row                                              (recorded)
 *   4. ledger rows            -> 'keep': the servers the harness owns now               (kept)
 *   5. a 1.18.0 manifest list -> that list                                             (manifest)
 *   6. otherwise              -> none                                                  (default)
 * Lock and manifest ids the registry retired are dropped and reported once through `onStale`; an
 * explicit --mcp naming one stays an error. Pure apart from `promptFn` and `onStale`.
 */
function resolveMcpSelections({
  cmd, requested, targets, registry, lock, ledger, manifestServers = null, interactive = false, promptFn, onStale,
}) {
  const catalogIds = readAllServers(registry);
  const flagged = parseMcpFlag(requested, catalogIds);
  const rows = pinnedSelections(lock);
  const capable = targets.filter((harness) => mcpCapable(registry, harness));
  const retired = new Set();
  const known = (ids) => {
    for (const id of ids) if (!catalogIds.includes(id)) retired.add(id);
    return catalogUnion(catalogIds, [ids]);
  };

  let prompted = null;
  if (!flagged && cmd === 'install' && interactive && capable.length) {
    const recorded = capable.filter((harness) => harness in rows).map((harness) => rows[harness]);
    const seed = recorded.length ? catalogUnion(catalogIds, recorded.map(known))
      : manifestServers ? known(manifestServers) : [...catalogIds];
    prompted = promptFn(catalogIds, seed);
  }

  const pick = (harness) => {
    if (flagged) return [flagged, 'flag'];
    if (prompted !== null) return [prompted, 'prompt'];
    if (harness in rows) return [known(rows[harness]), 'recorded'];
    if (holdsRows(ledger, harness)) return ['keep', 'kept'];
    if (manifestServers) return [known(manifestServers), 'manifest'];
    return [[], 'default'];
  };
  const selections = {};
  const sources = {};
  for (const harness of capable) [selections[harness], sources[harness]] = pick(harness);
  for (const [harness, ids] of Object.entries(rows)) if (!targets.includes(harness)) known(ids);
  if (retired.size && onStale) onStale([...retired].sort());

  return {
    selections,
    sources,
    adoptable: adoptableMcpIds({ registry, lock, ledger, harnesses: capable }),
    retainedMcpIds: retainedMcpIds(catalogIds, rows, targets),
  };
}

/** The selections a scope has recorded, for readers that never prompt (reconcile, status, inventory):
 * each targeted MCP-capable harness's lock row, or 'keep' when the lock has none. Retired ids are
 * dropped silently. */
function recordedMcpSelections({ registry, lock, ledger, targets }) {
  const catalogIds = readAllServers(registry);
  const rows = pinnedSelections(lock);
  const capable = targets.filter((harness) => mcpCapable(registry, harness));
  return {
    selections: Object.fromEntries(capable.map((harness) => [harness,
      harness in rows ? catalogUnion(catalogIds, [rows[harness]]) : 'keep'])),
    adoptable: adoptableMcpIds({ registry, lock, ledger, harnesses: capable }),
    retainedMcpIds: retainedMcpIds(catalogIds, rows, targets),
  };
}

const KEY = {
  UP: `${ESC}[A`,
  DOWN: `${ESC}[B`,
  SPACE: ' ',
  ENTER_CR: '\r',
  ENTER_LF: '\n',
  CTRL_C,
  ALL: 'a',
};

/**
 * Block for one raw-mode keypress, via prompt.js's readSyncBlocking (retries the EAGAIN-while-TTY
 * case, bounded by a deadline for a genuinely unusable fd).
 * @returns {string|null} the decoded chunk, or null if the fd is unusable
 */
function readKeypress(buf) {
  try {
    const n = readSyncBlocking(0, buf);
    return buf.toString('utf8', 0, n);
  } catch {
    return null;
  }
}

/**
 * Synchronous raw-mode checkbox prompt (arrow keys / j-k to move, space to toggle, 'a' to
 * toggle-all, enter to confirm). Matches src/prompt.js's synchronous-read style — this CLI has no
 * async control flow to hang off, so a real TTY read loop is built directly on fs.readSync(0, ...),
 * the same primitive confirm()/promptLine() already use.
 * @returns {string[]|null} selected server names, or null if no usable TTY (caller falls back)
 */
function promptMcpCheckbox(servers, initialSelected, message = 'Select MCP servers to install:') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  if (servers.length === 0) return [];

  const selected = new Set(initialSelected);
  let cursor = 0;
  const help = '  (up/down or j/k move, space toggle, a toggle-all, enter confirm)';

  const render = (first) => {
    if (!first) process.stdout.write(`${ESC}[${servers.length + 2}A`);
    console.log(message);
    console.log(help);
    for (let i = 0; i < servers.length; i++) {
      const mark = selected.has(servers[i]) ? '[x]' : '[ ]';
      const pointer = i === cursor ? '>' : ' ';
      console.log(`${pointer} ${mark} ${servers[i]}`);
    }
  };

  let wasRaw = false;
  let aborted = false;
  try {
    wasRaw = Boolean(process.stdin.isRaw);
    process.stdin.setRawMode(true);
    render(true);
    const buf = Buffer.alloc(16);
    for (;;) {
      const chunk = readKeypress(buf);
      if (chunk === null) {
        aborted = true;
        break;
      }
      if (chunk === KEY.ENTER_CR || chunk === KEY.ENTER_LF) break;
      if (chunk === KEY.CTRL_C) {
        console.log('\n[INFO]  Aborted.');
        process.exit(130);
      }
      if (chunk === KEY.UP || chunk === 'k') cursor = (cursor - 1 + servers.length) % servers.length;
      else if (chunk === KEY.DOWN || chunk === 'j') cursor = (cursor + 1) % servers.length;
      else if (chunk === KEY.SPACE) {
        const s = servers[cursor];
        if (selected.has(s)) selected.delete(s);
        else selected.add(s);
      } else if (chunk === KEY.ALL) {
        if (selected.size === servers.length) selected.clear();
        else for (const s of servers) selected.add(s);
      }
      render(false);
    }
  } finally {
    process.stdin.setRawMode(wasRaw);
  }
  console.log('');
  if (aborted) return null; // fd went unusable mid-prompt — caller falls back to manifest/all
  return servers.filter((s) => selected.has(s));
}

module.exports = {
  readAllServers,
  resolveMcpSelection,
  parseMcpFlag,
  resolveMcpSelections,
  recordedMcpSelections,
  adoptableMcpIds,
  promptMcpCheckbox,
};
