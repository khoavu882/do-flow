'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const {
  readAllServers, promptMcpCheckbox, parseMcpFlag, resolveMcpSelections, recordedMcpSelections, adoptableMcpIds,
} = require('../../src/install/mcp');
const { loadRegistry } = require('../../src/registry');

const REPO = path.resolve(__dirname, "../..");
const registry = loadRegistry({ repoRoot: REPO });

test('readAllServers returns the registry MCP catalog\'s server names in declaration order', () => {
  const servers = readAllServers(registry);
  assert.deepStrictEqual(servers, ['context7', 'sequential-thinking']);
});

// Writing Claude's MCP files is the Claude adapter's job: test/adapters/claude/claude-mcp.test.js.

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
