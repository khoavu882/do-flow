'use strict';

const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { spawnFakeServer } = require('../helper/fake-decision-server');

const ROOT = path.resolve(__dirname, '../..');
const scratch = createScratch('doflow-advice-bench-');
const registry = require('../../core/registry/advice.json');
const source = (id) => require(`../../core/registry/${id}.json`);
const { adviceCoverage } = require('../../bench/advice.js');
const fakeServers = [];
after(async () => {
  await Promise.all(fakeServers.map((server) => server.close()));
  scratch.remove();
});

function run(...args) {
  return runAt(ROOT, ...args);
}

function runAt(cwd, ...args) {
  return spawnSync(process.execPath, [path.join(ROOT, 'bench/runner.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: scratch.env(),
  });
}

function expectedOff(reason) {
  return `[Decision Model] — advisory, never blocking\n  off (${reason}). To turn it on: doflow advise --action configure --model <a decision-capable model>\n  or write ~/.config/doflow/decision-model.json:\n  {"schema": 1, "enabled": true, "endpoint": "http://127.0.0.1:11434", "model": "<a decision-capable model>"}\n`;
}

function configure(origin) {
  fs.writeFileSync(path.join(scratch.xdg, 'doflow', 'decision-model.json'), JSON.stringify({
    schema: 1, enabled: true, endpoint: origin, model: 'clef-flash',
  }));
}

test('adviceCoverage covers every shipped kind and names a removed case by kind and missing item', () => {
  assert.deepEqual(adviceCoverage().gaps, []);
  const corpus = Object.fromEntries(registry.kinds.map(({ id }) => [id, require(`../../bench/advice/${id}.json`)]));
  const result = adviceCoverage({ adviceRegistry: registry, corpus, sources: {
    workflows: source('workflows'), verification: source('verification'), mcp: source('mcp'),
  } });
  assert.deepEqual(result.gaps, []);

  const broken = structuredClone(corpus);
  broken.tier.cases = broken.tier.cases.filter((item) => item.expected !== 'frontier');
  const gap = adviceCoverage({ adviceRegistry: registry, corpus: broken, sources: {
    workflows: source('workflows'), verification: source('verification'), mcp: source('mcp'),
  } });
  assert.ok(gap.gaps.some((item) => item.includes('tier') && item.includes('frontier')), JSON.stringify(gap.gaps));
});

test('adviceCoverage rejects each IC-016 structural violation and malformed corpus fails closed', () => {
  const good = Object.fromEntries(registry.kinds.map(({ id }) => [id, structuredClone(require(`../../bench/advice/${id}.json`))]));
  const sources = { workflows: source('workflows'), verification: source('verification'), mcp: source('mcp') };
  const controls = [
    ['missing corpus file', (c) => { delete c.tier; }, /tier: missing corpus file/],
    ['unregistered kind', (c) => { c.unknown = { kind: 'unknown', cases: [] }; }, /unknown: unregistered kind/],
    ['non-object corpus case', (c) => { c.tier.cases[0] = null; }, /tier: case 1 must be an object/],
    ['cases must be an array', (c) => { c.tier.cases = {}; }, /tier: cases must be an array/],
    ['kind/file mismatch', (c) => { c.tier.kind = 'followup-triage'; }, /tier: kind must match/],
    ['id pattern', (c) => { c.tier.cases[0].id = 'tier-x'; }, /tier: .*id must match/],
    ['duplicate id', (c) => { c.tier.cases[1].id = c.tier.cases[0].id; }, /tier: .*duplicate id/],
    ['split', (c) => { c.tier.cases[0].split = 'other'; }, /tier: .*split must be/],
    ['empty state', (c) => { c.tier.cases[0].state = '  '; }, /tier: .*state must be non-empty/],
    ['UTF-8 state limit', (c) => { c.tier.cases[0].state = 'é'.repeat(Math.floor(registry.limits.maxStateBytes / 2) + 1); }, /tier: .*state exceeds maxStateBytes/],
    ['expected option', (c) => { c.tier.cases[0].expected = 'invalid'; }, /tier: .*expected must be/],
    ['source note', (c) => { delete c.tier.cases[0].note; }, /tier: .*note must be non-empty/],
    ['MCP server per case', (c) => { c['mcp-need'].cases[0].server = 'missing-server'; }, /mcp-need: mcp-need-001 server .*not a valid/],
    ['MCP question materialization', (c, s) => { s.mcp.servers.find((server) => server.id === 'context7').trigger = ''; }, /mcp-need: mcp-need-001 MCP question could not be materialized/],
  ];
  for (const [name, corrupt, expectedGap] of controls) {
    const corpus = structuredClone(good);
    const fixtureSources = structuredClone(sources);
    corrupt(corpus, fixtureSources);
    const result = adviceCoverage({ adviceRegistry: registry, corpus, sources: fixtureSources });
    assert.equal(result.ok, false, name);
    assert.match(result.gaps.join('\n'), expectedGap, name);
  }
  const emptyRegistry = structuredClone(registry);
  emptyRegistry.kinds = [];
  const invalidRegistry = adviceCoverage({ adviceRegistry: emptyRegistry, corpus: {}, sources });
  assert.equal(invalidRegistry.ok, false);
  assert.match(invalidRegistry.gaps.join('\n'), /advice registry is invalid: .*kinds must be a non-empty array/);

  const malformed = adviceCoverage({ adviceRegistry: registry, corpus: null, sources });
  assert.equal(malformed.ok, false);
  let output = '';
  const originalLog = console.log;
  console.log = (line) => { output += `${line}\n`; };
  try {
    assert.equal(require('../../bench/advice.js').cmdAdviceCoverage({ adviceRegistry: registry, corpus: null, sources }), 1);
  } finally { console.log = originalLog; }
  assert.match(output, /GAP: corpus: input must be an object/);
});

test('advice-coverage prints one row per kind, succeeds for corpus and fails for a gap', () => {
  const good = run('advice-coverage');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout.trim().split('\n').length, registry.kinds.length);
  assert.ok(good.stdout.includes('tier'));

  const broken = Object.fromEntries(registry.kinds.map(({ id }) => [id, require(`../../bench/advice/${id}.json`)]));
  broken.tier = { ...broken.tier, cases: broken.tier.cases.filter((item) => item.expected !== 'frontier') };
  let output = '';
  const originalLog = console.log;
  console.log = (line) => { output += `${line}\n`; };
  try {
    const code = require('../../bench/advice.js').cmdAdviceCoverage({
      adviceRegistry: registry, corpus: broken,
      sources: { workflows: source('workflows'), verification: source('verification'), mcp: source('mcp') },
    });
    assert.equal(code, 1);
  } finally { console.log = originalLog; }
  assert.match(output, /tier: GAP .*frontier/);

  const unregistered = Object.fromEntries(registry.kinds.map(({ id }) => [id, require(`../../bench/advice/${id}.json`)]));
  unregistered.orphan = { kind: 'orphan', cases: [] };
  output = '';
  console.log = (line) => { output += `${line}\n`; };
  try {
    assert.equal(require('../../bench/advice.js').cmdAdviceCoverage({
      adviceRegistry: registry, corpus: unregistered,
      sources: { workflows: source('workflows'), verification: source('verification'), mcp: source('mcp') },
    }), 1);
  } finally { console.log = originalLog; }
  assert.match(output, /GAP: orphan: unregistered kind/);
});

test('advice off text exactly matches IC-014 for absent and disabled settings without opening a socket', () => {
  const absent = run('advice', '--kind', 'tier');
  assert.equal(absent.status, 1);
  assert.equal(absent.stderr, expectedOff('not configured'));

  const userFile = path.join(scratch.xdg, 'doflow', 'decision-model.json');
  fs.writeFileSync(userFile, JSON.stringify({ schema: 1, enabled: false }));
  const userOff = run('advice', '--kind', 'tier');
  assert.equal(userOff.status, 1);
  assert.equal(userOff.stderr, expectedOff(`switched off in ${userFile}`));

  fs.writeFileSync(userFile, JSON.stringify({ schema: 1, enabled: true, endpoint: 'http://127.0.0.1:1', model: 'clef-flash' }));
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(project, '.doflow'), { recursive: true });
  const projectFile = path.join(project, '.doflow', 'decision-model.json');
  fs.writeFileSync(projectFile, JSON.stringify({ schema: 1, enabled: false }));
  const projectOff = runAt(project, 'advice', '--kind', 'tier');
  assert.equal(projectOff.status, 1);
  assert.equal(projectOff.stderr, expectedOff(`switched off in ${projectFile}`));
  assert.equal(fs.existsSync(path.join(project, '.doflow', 'state', 'advice', 'picks')), false);
  const unknown = run('advice', '--kind', 'not-a-kind');
  assert.equal(unknown.status, 2);
});

test('runner rejects missing --kind values and --kind on commands other than advice', () => {
  for (const args of [['advice', '--kind'], ['advice', '--kind', '--json']]) {
    const result = run(...args);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /--kind requires a value/);
  }
  const wrongCommand = run('coverage', '--kind', 'tier');
  assert.equal(wrongCommand.status, 2);
  assert.match(wrongCommand.stderr, /--kind is not accepted/);
});

test('advice uses fake local server without recording picks, reports agreement and JSON answers, and accepts --split', async () => {
  const server = await spawnFakeServer({ dir: scratch.dir });
  fakeServers.push(server);
  configure(server.origin);

  const project = path.join(scratch.dir, 'enabled-project');
  fs.mkdirSync(project, { recursive: true });
  const result = runAt(project, 'advice', '--split', 'heldout');
  assert.equal(result.status, 0, result.stderr);
  const rows = result.stdout.trim().split('\n');
  assert.equal(rows.length, registry.kinds.length);
  for (const line of rows) {
    assert.match(line, /^[a-z][a-z0-9-]*: \d+ cases, \d+ answered, agreed on \d+ of \d+, \d+ unavailable$/);
    assert.doesNotMatch(line, /\d+(?:\.\d+)?%|probabilit|confidence/i);
  }
  const userPicksRoot = path.join(scratch.xdg, 'doflow', 'state', 'advice', 'picks');
  const projectPicksRoot = path.join(project, '.doflow', 'state', 'advice', 'picks');
  assert.equal(fs.existsSync(userPicksRoot), false, 'bench must pass record:false and create no user pick store');
  assert.equal(fs.existsSync(projectPicksRoot), false, 'bench must pass record:false and create no project pick store');

  const json = runAt(project, 'advice', '--kind', 'tier', '--split', 'heldout', '--json');
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  const cases = report.kinds?.tier?.results;
  assert.ok(Array.isArray(cases));
  assert.equal(cases.length, require('../../bench/advice/tier.json').cases.filter((item) => item.split === 'heldout').length);
  assert.ok(cases.length > 0);
  for (const item of cases) {
    assert.equal(typeof item.pick, 'string');
    assert.equal(typeof item.word, 'string');
    assert.ok(item.probabilities && typeof item.probabilities === 'object');
    assert.equal(typeof item.confidence, 'number');
  }
});
