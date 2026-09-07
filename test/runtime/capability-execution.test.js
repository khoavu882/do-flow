'use strict';
// capability-execution.test.js — review R5 (P2): provider routing did not deliver a reliable
// execution contract. A query containing `$(...)` became executable shell syntax in the
// interpolated command string, a path with spaces split into arguments, the Semble MCP arguments
// used `path` where the tool's schema requires `repo`, and `native.test` was reported HEALTHY on
// a machine with every binary absent — resolving to an invented `npm test`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CapabilityRouter } = require('../../src/runtime/capability-router');

const REPO = path.resolve(__dirname, "../..");
const HOSTILE_QUERY = '$(printf DOFLOW_REVIEW_EXPANSION)';
const SPACED_PATH = './my project/src';

function router(overrides = {}) {
  return new CapabilityRouter({ repoRoot: REPO, ...overrides });
}

test("R5 reproduction: the review's hostile query rides in argv as data, never as shell syntax", () => {
  const r = router();
  const exec = r.formatExecution('locate-known-symbol', { id: 'native.rg', kind: 'native', binary: 'rg' },
    { query: HOSTILE_QUERY, path: SPACED_PATH });

  assert.ok(Array.isArray(exec.argv), 'the executable contract is an argument vector');
  assert.ok(exec.argv.includes(HOSTILE_QUERY), 'the query is one verbatim argv word');
  assert.ok(exec.argv.includes(SPACED_PATH), 'the spaced path is one verbatim argv word');
  // The display string quotes every non-trivial word, so even a human pasting it is safe.
  assert.ok(exec.cliCommand.includes(`'${HOSTILE_QUERY}'`),
    `display string must single-quote the query, got: ${exec.cliCommand}`);
  assert.ok(exec.cliCommand.includes(`'${SPACED_PATH}'`),
    `display string must single-quote the spaced path, got: ${exec.cliCommand}`);
});

test('R5: semble MCP arguments use repo — the name the tool schema requires', () => {
  const exec = router().formatExecution('locate-concept', { id: 'semble.search' },
    { query: 'auth flow', path: '/some/project' });
  assert.equal(exec.mcpTool, 'mcp__semble__search');
  assert.equal(exec.args.repo, '/some/project');
  assert.equal(exec.args.path, undefined, "the rejected 'path' spelling is gone");
});

test('R5: every argv-producing branch quotes its display string consistently', () => {
  const r = router();
  const branches = [
    r.formatExecution('x', { id: 'semble.search' }, { query: HOSTILE_QUERY }),
    r.formatExecution('x', { id: 'graphify.query' }, { query: HOSTILE_QUERY }),
    r.formatExecution('x', { id: 'git.native' }, { query: HOSTILE_QUERY }),
    r.formatExecution('x', { id: 'unknown.provider', binary: 'sometool' }, { query: HOSTILE_QUERY }),
  ];
  for (const exec of branches) {
    assert.ok(Array.isArray(exec.argv), 'argv present');
    assert.ok(!exec.cliCommand.includes(`"${HOSTILE_QUERY}"`),
      `no branch may double-quote the query (shell expands $() inside double quotes): ${exec.cliCommand}`);
  }
  // git's --grep carries the query inside one argv word; it must still be quoted for display.
  const git = branches[2];
  assert.ok(git.argv.some((w) => w === `--grep=${HOSTILE_QUERY}`));
});

test('R5: native.test detects the project command instead of inventing npm test', (t) => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-router-empty-'));
  t.after(() => fs.rmSync(empty, { recursive: true, force: true }));

  // A project with no manifest at all: no detection, no command, not healthy. The registry comes
  // from the install (repoRoot) while manifest detection reads the project (projectRoot) — the
  // two-roots split review A3 called for; a single root read the install's own package.json.
  const bare = router({ projectRoot: empty });
  const health = bare.evaluateProviderHealth({ id: 'native.test', kind: 'native' });
  assert.equal(health.status, 'UNAVAILABLE');
  assert.match(health.details, /No test command detected/);
  assert.equal(health.facts.installed, false);
  const exec = bare.formatExecution('verify-runtime-behavior', { id: 'native.test', kind: 'native' }, {});
  assert.equal(exec.argv, null);
  assert.match(exec.reason, /No test command detected/);

  // This repository declares one; detection reads it from the manifest.
  const here = router();
  const healthy = here.evaluateProviderHealth({ id: 'native.test', kind: 'native' });
  assert.equal(healthy.status, 'HEALTHY');
  assert.equal(healthy.facts.installed, true);
  assert.match(healthy.details, /npm test/);
});

test('R5: health reports declared, installed and responsive as distinct facts', () => {
  const r = router({ binaryChecker: () => false });
  const missing = r.evaluateProviderHealth({ id: 'graphify.query', binary: 'graphify' });
  assert.equal(missing.status, 'UNAVAILABLE');
  assert.deepEqual(missing.facts, { declared: true, installed: false, responsive: null },
    'not-measured stays null — installed=false is a measurement, responsive was never probed');

  const present = router({ binaryChecker: () => true });
  const shallow = present.evaluateProviderHealth({ id: 'graphify.query', binary: 'graphify' });
  assert.deepEqual(shallow.facts, { declared: true, installed: true, responsive: null },
    'a shallow check must not report responsiveness it never measured');
});
