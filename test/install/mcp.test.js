'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  readAllServers, resolveMcpSelection, promptMcpCheckbox, parseMcpFlag, resolveMcpSelections, recordedMcpSelections, adoptableMcpIds,
} = require('../../src/install/mcp');
const { loadRegistry } = require('../../src/registry');

const REPO = path.resolve(__dirname, "../..");
const registry = loadRegistry({ repoRoot: REPO });

test('readAllServers returns the registry MCP catalog\'s server names in declaration order', () => {
  const servers = readAllServers(registry);
  assert.deepStrictEqual(servers, ['context7', 'sequential-thinking']);
});

// Writing Claude's MCP files is the Claude adapter's job: test/adapters/claude/claude-mcp.test.js.

test('resolveMcpSelection: --mcp <list> wins outright and dedupes', () => {
  const all = ['a', 'b', 'c'];
  const selected = resolveMcpSelection({
    cmd: 'install', requested: ['a', 'a', 'b'], allServers: all, manifestServers: ['c'],
    interactive: true, promptFn: () => { throw new Error('must not prompt when --mcp is given'); },
  });
  assert.deepStrictEqual(selected, ['a', 'b']);
});

test('resolveMcpSelection: --mcp rejects unknown server names', () => {
  assert.throws(
    () => resolveMcpSelection({ cmd: 'install', requested: ['bogus'], allServers: ['a', 'b'], manifestServers: null, interactive: false, promptFn: null }),
    /Unknown MCP server\(s\): bogus/,
  );
});

test('resolveMcpSelection: --mcp with an empty list is a hard error, not "keep all"', () => {
  assert.throws(
    () => resolveMcpSelection({ cmd: 'install', requested: [], allServers: ['a', 'b'], manifestServers: null, interactive: false, promptFn: null }),
    /requires at least one server/,
  );
});

test('resolveMcpSelection: install + interactive prompts, seeded with the manifest selection', () => {
  const all = ['a', 'b', 'c'];
  let seenSeed = null;
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: all, manifestServers: ['b'], interactive: true,
    promptFn: (servers, seed) => { seenSeed = seed; return ['a']; },
  });
  assert.deepStrictEqual(seenSeed, ['b']);
  assert.deepStrictEqual(selected, ['a']);
});

test('resolveMcpSelection: install + interactive, prompt returns [] (deliberate "no servers") is honored', () => {
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: ['a', 'b'], manifestServers: null, interactive: true,
    promptFn: () => [],
  });
  assert.deepStrictEqual(selected, []);
});

test('resolveMcpSelection: install + interactive, prompt unavailable (null) selects nothing — no consent, no servers', () => {
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: ['a', 'b'], manifestServers: null, interactive: true,
    promptFn: () => null,
  });
  assert.deepStrictEqual(selected, []);
});

// Regression: removing chrome-devtools and playwright from core/registry/mcp.json (d1bf9e8) made
// `install` and `update` throw "Unknown registry MCP server(s)" for every install that had them in
// its manifest — i.e. the upgrade path was broken for all pre-existing users, on both commands.
// The asymmetry these tests pin down: `requested` is user intent (typo => fatal), the manifest is
// persisted resolved state (retired server => reconcile).
test('resolveMcpSelection: a manifest server the registry retired is dropped, not fatal', () => {
  const dropped = [];
  const selected = resolveMcpSelection({
    cmd: 'update', requested: null, allServers: ['context7', 'sequential-thinking'],
    manifestServers: ['context7', 'sequential-thinking', 'chrome-devtools', 'playwright'],
    interactive: false, promptFn: null, onStale: (r) => dropped.push(...r),
  });
  assert.deepStrictEqual(selected, ['context7', 'sequential-thinking']);
  assert.deepStrictEqual(dropped, ['chrome-devtools', 'playwright'], 'the drop must be reported, not silent');
});

test('resolveMcpSelection: reconciling a manifest works without an onStale callback', () => {
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: ['a'], manifestServers: ['a', 'gone'],
    interactive: false, promptFn: null,
  });
  assert.deepStrictEqual(selected, ['a']);
});

test('resolveMcpSelection: an explicit --mcp naming a retired server is still fatal', () => {
  assert.throws(
    () => resolveMcpSelection({
      cmd: 'update', requested: ['chrome-devtools'], allServers: ['context7'],
      manifestServers: ['context7'], interactive: false, promptFn: null,
    }),
    /Unknown MCP server\(s\): chrome-devtools/,
    'a typo in user-supplied intent must not be silently reconciled away',
  );
});

test('resolveMcpSelection: a manifest whose every server was retired stays empty — the catalog is never resurrected', () => {
  // The old behavior here re-added every catalog server behind the user's back. Servers are
  // opt-in: once the remembered selection is empty (deliberately chosen or fully retired), it
  // takes explicit intent (--mcp all|<names>) to bring any back.
  const selected = resolveMcpSelection({
    cmd: 'update', requested: null, allServers: ['a', 'b'], manifestServers: ['gone-1', 'gone-2'],
    interactive: false, promptFn: null,
  });
  assert.deepStrictEqual(selected, []);
});

test('resolveMcpSelection: the interactive seed is reconciled, never pre-ticking a retired server', () => {
  let seenSeed = null;
  resolveMcpSelection({
    cmd: 'install', requested: null, allServers: ['a', 'b'], manifestServers: ['a', 'retired'],
    interactive: true, promptFn: (servers, seed) => { seenSeed = seed; return ['a']; },
  });
  assert.deepStrictEqual(seenSeed, ['a']);
});

test('resolveMcpSelection: update never prompts, even when interactive is true', () => {
  const selected = resolveMcpSelection({
    cmd: 'update', requested: null, allServers: ['a', 'b'], manifestServers: ['a'], interactive: true,
    promptFn: () => { throw new Error('must not prompt on update'); },
  });
  assert.deepStrictEqual(selected, ['a']);
});

test('resolveMcpSelection: no flag, not interactive, no manifest yet -> defaults to none (safe by default)', () => {
  const selected = resolveMcpSelection({
    cmd: 'install', requested: null, allServers: ['a', 'b'], manifestServers: null,
    interactive: false, promptFn: null,
  });
  assert.deepStrictEqual(selected, [], 'third-party servers must be opt-in for scripted installs');
});

test('resolveMcpSelection: --mcp all adopts the full catalog explicitly', () => {
  const selected = resolveMcpSelection({
    cmd: 'install', requested: ['all'], allServers: ['a', 'b'], manifestServers: null,
    interactive: false, promptFn: null,
  });
  assert.deepStrictEqual(selected, ['a', 'b']);
});

test('resolveMcpSelection: --mcp none persists an explicit empty selection', () => {
  const selected = resolveMcpSelection({
    cmd: 'update', requested: ['none'], allServers: ['a', 'b'], manifestServers: ['a'],
    interactive: false, promptFn: null,
  });
  assert.deepStrictEqual(selected, []);
});

test('resolveMcpSelection: keywords cannot be mixed with names or with each other', () => {
  const base = { cmd: 'install', allServers: ['a', 'b'], manifestServers: null, interactive: false, promptFn: null };
  assert.throws(() => resolveModelRoleGuard(base, ['all', 'a']));
  assert.throws(() => resolveModelRoleGuard(base, ['none', 'b']));
  assert.throws(() => resolveModelRoleGuard(base, ['all', 'none']), /not both/);
});
function resolveModelRoleGuard(base, requested) {
  return resolveMcpSelection({ ...base, requested });
}

test('promptMcpCheckbox returns [] immediately for an empty server list, never entering the raw-mode read loop', () => {
  // Regression test: the cursor-movement math (`(cursor - 1 + servers.length) % servers.length`)
  // divides by servers.length — an empty list would produce NaN and hang the render loop waiting
  // on a keypress that a non-interactive caller (or a future core/.mcp.json with 0 servers) never
  // sends. Fake a TTY to get past the isTTY guard without actually blocking on stdin.
  const stdinDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
  Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
  try {
    assert.deepStrictEqual(promptMcpCheckbox([], []), []);
  } finally {
    if (stdinDescriptor) Object.defineProperty(process.stdin, 'isTTY', stdinDescriptor);
    else delete process.stdin.isTTY;
    if (stdoutDescriptor) Object.defineProperty(process.stdout, 'isTTY', stdoutDescriptor);
    else delete process.stdout.isTTY;
  }
});

// ── resolveMcpForTool's `recorded`, and the note install prints from it ────────────────────────

test('resolveMcpForTool reports the recorded selection so an unchanged one can be named', () => {
  // `changed` alone cannot carry this: it is false both when a returning install matches the
  // manifest and when a first-ever install happens to select the whole catalog, because the
  // baseline falls back to allServers when no manifest exists. Only the first is "unchanged from
  // the recorded selection", and install.js prints that note off `recorded` for exactly that reason.
  const { resolveMcpForTool } = require('../../src/cli/shared');
  const { writeManifest } = require('../../src/install/manifest');
  const registry = loadRegistry({ repoRoot: path.resolve(__dirname, '../..') });
  const all = readAllServers(registry);
  assert.ok(all.length >= 2, 'this test needs at least two servers in the catalog');

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-mcp-note-'));
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir, { recursive: true });
  const dirs = { claude: claudeDir };
  const scope = { global: false, projectRoot: home };

  // First-ever install: no manifest, so nothing is recorded even when the selection is everything.
  const first = resolveMcpForTool({ o: { mcp: all, dryRun: true, force: true }, dirs, scope, cmd: 'install', registry });
  assert.equal(first.recorded, null, 'no manifest means no recorded selection');
  assert.equal(first.changed, false, 'and changed is false against the allServers baseline');

  // Record a selection, then ask for the same one explicitly — the case a redundant --mcp produces.
  writeManifest({
    scopeRoot: home, scriptVersion: 'test', operation: 'install', repoRoot: home,
    tools: ['claude'], date: new Date(), sourceCommit: 'test', mcpServers: [all[0]],
  });
  const again = resolveMcpForTool({ o: { mcp: [all[0]], dryRun: true, force: true }, dirs, scope, cmd: 'install', registry });
  assert.deepEqual(again.recorded, [all[0]], 'the prior selection is reported');
  assert.equal(again.changed, false, 'asking for what was recorded changes nothing');

  // A different selection must not read as unchanged.
  const different = resolveMcpForTool({ o: { mcp: [all[1]], dryRun: true, force: true }, dirs, scope, cmd: 'install', registry });
  assert.equal(different.changed, true);
});

test('install names an unchanged MCP selection only when one was actually recorded', () => {
  // The note's condition, asserted against the source so the two print sites cannot drift apart or
  // start claiming a record on a first-ever install.
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/cli/commands/install.js'), 'utf8');
  assert.match(source, /const mcpNote = mcp && !mcp\.changed && mcp\.recorded \?/,
    'the note must require a recorded selection, not merely an unchanged one');
  const uses = [...source.matchAll(/\$\{mcpNote\}/g)];
  assert.equal(uses.length, 2, 'both the dry-run and the real print site must carry the note');
});

// Per-harness selection. A lock pins its rows' harnesses as targets; a ledger "holds" a harness when
// any resource row names it.
const ALL_HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity'];
const CAPABLE = ALL_HARNESSES.filter((harness) => harness !== 'gemini');
const lockWith = (rows, extraTargets = []) => ({
  targets: [...new Set([...Object.keys(rows), ...extraTargets])].map((harness) => ({ harness })),
  mcpSelections: rows,
});
const ledgerHolding = (...harnesses) => ({ resources: harnesses.map((harness) => ({ harness, kind: 'skill' })) });
const resolve = (options) => resolveMcpSelections({
  cmd: 'install', requested: null, targets: CAPABLE, registry, lock: null, ledger: null, manifestServers: null,
  interactive: false, promptFn: () => assert.fail('must not prompt'), ...options,
});

test('S1: --mcp ids reach every MCP-capable target, and gemini gets no entry', () => {
  const result = resolve({ requested: ['context7'], targets: ALL_HARNESSES });
  assert.deepEqual(Object.keys(result.selections), CAPABLE);
  for (const harness of CAPABLE) {
    assert.deepEqual(result.selections[harness], ['context7']);
    assert.equal(result.sources[harness], 'flag');
  }
  assert.ok(!('gemini' in result.sources) && !('gemini' in result.adoptable));
});

test('S2: --mcp none and all resolve per target; the flag errors stay, even with no MCP-capable target', () => {
  const all = readAllServers(registry);
  assert.deepEqual(resolve({ requested: ['none'] }).selections.kiro, []);
  assert.deepEqual(resolve({ requested: ['all'] }).selections.pi, all);
  assert.deepEqual(parseMcpFlag(['context7', 'context7'], all), ['context7']);
  assert.equal(parseMcpFlag(null, all), null);
  assert.throws(() => parseMcpFlag(['all', 'context7'], all), /--mcp keyword 'all' cannot be combined/);
  assert.throws(() => parseMcpFlag(['all', 'none'], all), /either '--mcp all' or '--mcp none'/);
  assert.throws(() => parseMcpFlag([], all), /--mcp requires at least one server/);
  assert.throws(() => resolve({ requested: ['bogus'], targets: ['gemini'] }), /Unknown MCP server\(s\): bogus \(valid: context7, sequential-thinking\)/);
});

test('S3: lock rows win per harness and stay distinct', () => {
  const result = resolve({
    targets: ['claude', 'codex'],
    lock: lockWith({ claude: ['context7'], codex: ['sequential-thinking'] }),
    manifestServers: ['context7', 'sequential-thinking'],
  });
  assert.deepEqual(result.selections, { claude: ['context7'], codex: ['sequential-thinking'] });
  assert.deepEqual(result.sources, { claude: 'recorded', codex: 'recorded' });
});

test('S4: an installed harness with no row is kept, an uninstalled one takes the manifest list, else none', () => {
  const kept = resolve({ targets: ['kiro', 'pi'], ledger: ledgerHolding('kiro'), manifestServers: ['context7'] });
  assert.deepEqual(kept.selections, { kiro: 'keep', pi: ['context7'] });
  assert.deepEqual(kept.sources, { kiro: 'kept', pi: 'manifest' });
  const none = resolve({ targets: ['pi'] });
  assert.deepEqual(none.selections, { pi: [] });
  assert.deepEqual(none.sources, { pi: 'default' });
  // A row the lock records but does not target is not a row for that harness.
  const stray = resolve({ targets: ['pi'], lock: { targets: [], mcpSelections: { pi: ['context7'] } } });
  assert.deepEqual(stray.sources, { pi: 'default' });
});

test('S5: an interactive install prompts once for every target; seed rules; null falls through; update never prompts', () => {
  const all = readAllServers(registry);
  const calls = [];
  const promptFn = (servers, seed) => { calls.push({ servers, seed }); return ['sequential-thinking']; };
  const prompted = resolve({ targets: ['kiro', 'pi'], interactive: true, promptFn });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { servers: all, seed: all }, 'with nothing recorded the seed is the catalog');
  assert.deepEqual(prompted.selections, { kiro: ['sequential-thinking'], pi: ['sequential-thinking'] });
  assert.deepEqual(prompted.sources, { kiro: 'prompt', pi: 'prompt' });

  calls.length = 0;
  resolve({ targets: ['kiro', 'pi'], interactive: true, promptFn, manifestServers: ['context7'] });
  assert.deepEqual(calls[0].seed, ['context7'], 'the manifest list seeds when no target has a row');
  calls.length = 0;
  resolve({
    targets: ['kiro', 'pi'], interactive: true, promptFn, manifestServers: ['context7'],
    lock: lockWith({ pi: ['sequential-thinking'], claude: ['context7'] }),
  });
  assert.deepEqual(calls[0].seed, ['sequential-thinking'], 'the targeted harnesses\' rows seed first');

  const fellThrough = resolve({ targets: ['kiro'], interactive: true, promptFn: () => null, manifestServers: ['context7'] });
  assert.deepEqual(fellThrough.sources, { kiro: 'manifest' });
  const update = resolve({ cmd: 'update', targets: ['kiro'], interactive: true });
  assert.deepEqual(update.sources, { kiro: 'default' });
});

test('S6: non-interactive with no flag and nothing recorded resolves every target to none', () => {
  const result = resolve({});
  for (const harness of CAPABLE) {
    assert.deepEqual(result.selections[harness], []);
    assert.equal(result.sources[harness], 'default');
  }
});

test('S7: retired ids in a lock row or the manifest are dropped and reported once', () => {
  const reports = [];
  const result = resolve({
    targets: ['claude', 'pi'],
    lock: lockWith({ claude: ['playwright', 'context7'], codex: ['chrome-devtools'] }),
    manifestServers: ['zz-retired', 'sequential-thinking'],
    onStale: (ids) => reports.push(ids),
  });
  assert.deepEqual(result.selections, { claude: ['context7'], pi: ['sequential-thinking'] });
  assert.deepEqual(result.retainedMcpIds, []);
  assert.deepEqual(reports, [['chrome-devtools', 'playwright', 'zz-retired']]);
  assert.throws(() => resolve({ requested: ['playwright'] }), /Unknown MCP server\(s\): playwright/);
});

test('S8: adoptable ids are the lock row or the catalog for an installed harness, none otherwise', () => {
  const all = readAllServers(registry);
  const lock = lockWith({ claude: ['context7'] });
  const ledger = ledgerHolding('claude', 'kiro');
  const result = resolve({ targets: ['claude', 'kiro', 'pi', 'gemini'], requested: ['none'], lock, ledger });
  assert.deepEqual(result.adoptable, { claude: ['context7'], kiro: all, pi: [] });
  assert.deepEqual(adoptableMcpIds({ registry, lock, ledger, harnesses: ['claude', 'kiro', 'pi', 'gemini'] }), result.adoptable);
});

test('S9: retainedMcpIds is the union of the rows of lock harnesses not targeted', () => {
  const lock = lockWith({ claude: ['sequential-thinking'], codex: ['context7'], pi: ['context7'] });
  assert.deepEqual(resolve({ targets: ['pi'], lock }).retainedMcpIds, ['context7', 'sequential-thinking']);
  assert.deepEqual(resolve({ targets: ['claude', 'codex'], lock }).retainedMcpIds, ['context7']);
});

test('recordedMcpSelections reads each target\'s lock row, or keep, and never prompts', () => {
  const all = readAllServers(registry);
  const lock = lockWith({ claude: ['context7', 'playwright'], codex: ['sequential-thinking'] });
  const ledger = ledgerHolding('claude', 'kiro');
  assert.deepEqual(recordedMcpSelections({ registry, lock, ledger, targets: ['claude', 'kiro', 'gemini'] }), {
    selections: { claude: ['context7'], kiro: 'keep' },
    adoptable: { claude: ['context7'], kiro: all },
    retainedMcpIds: ['sequential-thinking'],
  });
});
