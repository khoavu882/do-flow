'use strict';

// The tier, tools and report-format block of a generated brief (062 CH7, IC-016 to IC-018).
// `renderBriefTools` is driven with injected probe results and an injected reach object, so no
// provider is run and no install is read; the verb is driven through the CLI and through
// `doflow-run` for exit codes and the one-JSON-document stdout (RK1).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
const { renderBriefTools, currentStageOf } = require('../../src/runtime/brief-tools.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const registry = loadRegistry({ repoRoot: REPO_ROOT });
const SERVERS = registry.mcp.filter((server) => server.steps.some((step) => !step.expectedWhen));
const STEPPED = SERVERS[0];
const STEP_SKILL = STEPPED.steps.find((step) => !step.expectedWhen).skill;
const OTHER = registry.mcp.find((server) => server.id !== STEPPED.id && !server.steps.some((step) => step.skill === STEP_SKILL));
const SEARCH = registry.capabilities['code.semantic-search'].providers.find((provider) => provider.mcp);
const CLAUDE = registry.harnesses.find((harness) => harness.capabilities.mcp.toolName);
const OTHER_HARNESS = registry.harnesses.find((harness) => !harness.capabilities.mcp.toolName && harness.capabilities.mcp.status === 'supported');

function projectDir(t) {
  const dir = tempDir(t, 'doflow-brief-tools-');
  fs.mkdirSync(path.join(dir, 'proj'));
  return { dir, proj: path.join(dir, 'proj') };
}

/** Every provider the router knows, HEALTHY unless named in `bad`. */
function probesFor(router, bad = []) {
  const probes = {};
  for (const capability of Object.values(router.capabilities)) {
    for (const provider of capability.providers) {
      probes[provider.id] = { id: provider.id, status: bad.includes(provider.id) ? 'UNHEALTHY' : 'HEALTHY' };
    }
  }
  return probes;
}

/** A reach object shaped like `mcpReach`'s: rows are [harness id, scope, { server: state }]. */
function reachOf(rows) {
  const harnesses = rows.map(([id, scope, servers]) => ({ id, scope, catalog: 'taken', servers }));
  return {
    harnesses,
    unreadable: [],
    anyHarnessHas: (server) => {
      const states = harnesses.map((row) => row.servers[server]);
      if (states.some((state) => state === 'selected' || state === 'configured')) return true;
      return states.length > 0 && states.every((state) => state === 'not-selected' || state === 'not-taken') ? false : null;
    },
  };
}

function render(t, overrides = {}) {
  const { proj } = projectDir(t);
  const router = overrides.router || new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj });
  return renderBriefTools({
    registry: overrides.registry || registry,
    router,
    probes: overrides.probes || probesFor(router),
    reach: overrides.reach === undefined ? null : overrides.reach,
    owner: 'core-implementer',
    stage: null,
    ...overrides,
  });
}

function row(markdown, intent) {
  return markdown.split('\n').find((line) => line.startsWith(`| ${intent} |`));
}

test('a brief recommends a healthy provider and names the tier of the owner', (t) => {
  const { markdown, record } = render(t);
  assert.match(markdown, /^## Tier and tools\n\nTier: `standard` \(owner core-implementer\), per\n`references\/MODEL_SELECTION.md`\./);
  assert.doesNotMatch(markdown, /Pass it as the model/, 'X5: the dispatched agent cannot choose its model');
  assert.match(markdown, /recommended/);
  assert.match(markdown, /not required/);
  assert.match(row(markdown, 'locate-concept'), new RegExp(`\\| ${SEARCH.id.replace('.', '\\.')} \\|`));
  assert.equal(record.tier, 'standard');
  assert.equal(record.tierSource, 'owner');
  assert.equal(record.tools.find((tool) => tool.intent === 'locate-concept').provider, SEARCH.id);
  assert.equal(record.tools.find((tool) => tool.intent === 'locate-concept').status, 'HEALTHY');
});

test('an unhealthy provider is never named; the next healthy provider of the same capability is named plainly (X4)', (t) => {
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: projectDir(t).proj });
  const { markdown, record } = render(t, { router, probes: probesFor(router, [SEARCH.id]) });
  const line = row(markdown, 'locate-concept');
  // native.rg is itself a code.semantic-search provider, so "no healthy provider" would be false.
  assert.match(line, /^\| locate-concept \| native\.rg \|/);
  assert.doesNotMatch(line, /no healthy/);
  assert.ok(!line.includes(SEARCH.id), line);
  assert.ok(!line.includes(SEARCH.mcp.server), line);
  const tool = record.tools.find((entry) => entry.intent === 'locate-concept');
  assert.equal(tool.provider, 'native.rg');
  assert.equal(tool.status, 'HEALTHY');
});

test('X4: the fallback wording appears only for a provider of the route fallback capability', (t) => {
  const { proj } = projectDir(t);
  const base = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj });
  const capabilities = {
    ...JSON.parse(JSON.stringify(base.capabilities)),
    'fixture.primary': { description: 'fixture', providers: [{ id: 'fx.primary', name: 'P', kind: 'cli', binary: 'fx-p', checkCommand: ['fx-p'] }] },
    'fixture.backup': { description: 'fixture', providers: [{ id: 'fx.backup', name: 'B', kind: 'cli', binary: 'fx-b', checkCommand: ['fx-b'] }] },
  };
  const routes = { 'fixture-need': { description: 'fixture', capability: 'fixture.primary', fallback: ['fixture.backup'] } };
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj, capabilities, routes });
  const { markdown, record } = renderBriefTools({
    registry: { ...registry, capabilities }, router, probes: probesFor(router, ['fx.primary']), reach: null, owner: 'core-implementer', stage: null,
  });
  assert.match(row(markdown, 'fixture-need'), /\| no healthy fixture\.primary provider; fallback fx\.backup \|/);
  assert.deepEqual([record.tools[0].provider, record.tools[0].status], ['fx.backup', 'FALLBACK']);
});

test('X4: a provider with no probe (UNVERIFIED) is named as unverified, not as missing', (t) => {
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: projectDir(t).proj });
  const probes = probesFor(router);
  probes['native.test'] = { id: 'native.test', status: 'UNVERIFIED' };
  const { markdown, record } = render(t, { router, probes });
  const line = row(markdown, 'verify-runtime-behavior');
  assert.match(line, /^\| verify-runtime-behavior \| native\.test \(unverified: no probe\) \|/);
  assert.doesNotMatch(line, /no healthy provider/);
  const tool = record.tools.find((entry) => entry.intent === 'verify-runtime-behavior');
  assert.deepEqual([tool.provider, tool.status], ['native.test', 'UNVERIFIED']);
});

test('X9: a registry without dispatchTiers gives tier standard with a missing note, not an error', (t) => {
  const { dispatchTiers: _drop, ...bare } = registry;
  const { markdown, record } = render(t, { registry: bare });
  assert.equal(record.tier, 'standard');
  assert.equal(record.tierSource, 'default');
  assert.ok(record.missing.includes('models.json has no dispatchTiers; tier standard assumed'), JSON.stringify(record.missing));
  assert.match(markdown, /Tier: `standard` \(default; models\.json has no dispatchTiers\)/);
});

test('an intent with no healthy provider and no fallback says so', (t) => {
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: projectDir(t).proj });
  const { markdown, record } = render(t, { router, probes: probesFor(router, ['git.native']) });
  assert.match(row(markdown, 'inspect-history'), /no healthy provider and no fallback/);
  const tool = record.tools.find((entry) => entry.intent === 'inspect-history');
  assert.deepEqual([tool.provider, tool.status, tool.form], [null, 'NONE', 'none']);
});

test('one registry, two harness forms', (t) => {
  const servers = { [SEARCH.mcp.server]: 'configured' };
  const reach = reachOf([[CLAUDE.id, 'project', servers], [OTHER_HARNESS.id, 'global', servers]]);
  const claude = render(t, { reach, harness: CLAUDE.id });
  const other = render(t, { reach, harness: OTHER_HARNESS.id });
  const tool = `mcp__${SEARCH.mcp.server}__${SEARCH.mcp.tool}`;
  assert.ok(row(claude.markdown, 'locate-concept').includes(tool));
  assert.ok(!row(other.markdown, 'locate-concept').includes(tool));
  assert.match(row(other.markdown, 'locate-concept'), /semble search/);
  assert.equal(claude.record.tools.find((entry) => entry.intent === 'locate-concept').form, 'mcp');
  assert.equal(other.record.tools.find((entry) => entry.intent === 'locate-concept').form, 'cli');
});

test('a server the target harness does not have gets the CLI form even where the template exists', (t) => {
  const reach = reachOf([[CLAUDE.id, 'project', { [SEARCH.mcp.server]: 'not-selected' }]]);
  const { markdown } = render(t, { reach, harness: CLAUDE.id });
  assert.ok(!row(markdown, 'locate-concept').includes('mcp__'));
});

test('no target harness gives the neutral form: CLI plus where the MCP tool would be', (t) => {
  const { markdown, record } = render(t);
  assert.match(row(markdown, 'locate-concept'), new RegExp(`MCP server ${SEARCH.mcp.server}, tool ${SEARCH.mcp.tool}, where your harness registers it`));
  assert.equal(record.harness, null);
  assert.equal(record.tools.find((entry) => entry.intent === 'locate-concept').form, 'neutral');
});

test('one table row per routes.json intent, in file order', (t) => {
  const routes = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'routes.json'), 'utf8')).routes;
  const { markdown, record } = render(t);
  const intents = markdown.split('\n').filter((line) => /^\| [a-z-]+ \|/.test(line) && !line.startsWith('| Need ')).map((line) => line.split(' | ')[0].slice(2));
  assert.deepEqual(intents, Object.keys(routes));
  assert.deepEqual(record.tools.map((tool) => tool.intent), Object.keys(routes));
});

test('tier resolves from the task line, then the owner, then the default with a missing note', (t) => {
  const fromTask = render(t, { tier: 'frontier' });
  assert.equal(fromTask.record.tier, 'frontier');
  assert.equal(fromTask.record.tierSource, 'task');
  assert.match(fromTask.markdown, /Tier: `frontier` \(task line\)/);

  const unknownOwner = render(t, { owner: 'nobody-here' });
  assert.equal(unknownOwner.record.tier, registry.dispatchTiers.default);
  assert.equal(unknownOwner.record.tierSource, 'default');
  assert.match(unknownOwner.markdown, /\(default; owner nobody-here has no tier\)/);
  assert.ok(unknownOwner.record.missing.includes("owner 'nobody-here' has no tier in models.json dispatchTiers"));

  const invalid = render(t, { tier: 'turbo' });
  assert.equal(invalid.record.tier, 'standard');
  assert.equal(invalid.record.tierSource, 'owner');
  assert.ok(invalid.record.missing.some((note) => note.includes("'turbo'")), JSON.stringify(invalid.record.missing));
});

test('an expected server the target cannot reach is stated; selected servers outside the stage are listed with their trigger', (t) => {
  const reach = reachOf([[CLAUDE.id, 'project', {
    ...Object.fromEntries(registry.mcp.map((server) => [server.id, 'not-selected'])),
    ...(OTHER ? { [OTHER.id]: 'selected' } : {}),
  }]]);
  const { markdown, record } = render(t, { reach, harness: CLAUDE.id, stage: { feature: 'f', runTaskId: 'f', stageId: 'design', skill: STEP_SKILL } });
  assert.match(markdown, new RegExp(`Expected for ${STEP_SKILL}: .*\`${STEPPED.id}\``));
  assert.ok(markdown.includes(`\`${STEPPED.id}\` is not reachable on ${CLAUDE.displayName || CLAUDE.id}; report it as \`${STEPPED.id}=unavailable\`.`), markdown);
  const expected = record.expected.find((entry) => entry.server === STEPPED.id);
  assert.equal(expected.reach, 'unreachable');
  assert.equal(record.stage, 'design');
  assert.equal(record.stageSkill, STEP_SKILL);
  if (OTHER) {
    assert.deepEqual(record.optional.includes(OTHER.id), true);
    assert.ok(markdown.includes(`\`${OTHER.id}\` (${OTHER.trigger.replace(/\.$/, '')})`), markdown);
  }
});

test('X1: an expected server DoFlow cannot confirm is hedged, never stated unreachable', (t) => {
  const stage = { feature: 'f', runTaskId: 'f', stageId: 'design', skill: STEP_SKILL };
  const name = CLAUDE.displayName || CLAUDE.id;
  const hedge = `\`${STEPPED.id}\` may not be reachable on ${name}; if no tool answers, report \`${STEPPED.id}=unavailable\`.`;
  const unknown = render(t, { reach: reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'unknown' }]]), harness: CLAUDE.id, stage });
  assert.ok(unknown.markdown.includes(hedge), unknown.markdown);
  assert.ok(!unknown.markdown.includes('is not reachable'), unknown.markdown);
  assert.equal(unknown.record.expected.find((entry) => entry.server === STEPPED.id).reach, 'unknown');

  // One scope with a complete view saying absent and another that cannot say: still unknown.
  const mixed = render(t, { reach: reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'not-selected' }], [CLAUDE.id, 'global', { [STEPPED.id]: 'unknown' }]]), harness: CLAUDE.id, stage });
  assert.equal(mixed.record.expected.find((entry) => entry.server === STEPPED.id).reach, 'unknown');
  assert.ok(mixed.markdown.includes(hedge), mixed.markdown);

  // No target: any-harness answer null is unknown and hedged on "any installed harness".
  const neutral = render(t, { reach: reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'unknown' }], [OTHER_HARNESS.id, 'project', {}]]), stage });
  assert.equal(neutral.record.expected.find((entry) => entry.server === STEPPED.id).reach, 'unknown');
  assert.ok(neutral.markdown.includes(`\`${STEPPED.id}\` may not be reachable on any installed harness;`), neutral.markdown);
});

test('a reachable expected server is not reported unavailable', (t) => {
  const reach = reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'selected' }]]);
  const { markdown, record } = render(t, { reach, harness: CLAUDE.id, stage: { feature: 'f', runTaskId: 'f', stageId: 'design', skill: STEP_SKILL } });
  assert.ok(!markdown.includes(`${STEPPED.id}=unavailable`));
  assert.equal(record.expected.find((entry) => entry.server === STEPPED.id).reach, 'reachable');
});

test('heading levels 2 and 3 change only the heading marks', (t) => {
  const two = render(t, { headingLevel: 2 }).markdown;
  const three = render(t, { headingLevel: 3 }).markdown;
  assert.match(two, /^## Tier and tools\n/m);
  assert.match(two, /^## Report format\n/m);
  assert.match(three, /^### Tier and tools\n/m);
  assert.match(three, /^### Report format\n/m);
  assert.equal(three.replace(/^### /gm, '## ').replace(/each task's report/, 'your report'), two);
  assert.match(two, /Tools used: <name>\[=used\|nothing-usable\|unavailable\|skipped:<reason>\]/);
});

test('an unknown harness is ignored with a missing note', (t) => {
  const { record } = render(t, { harness: 'no-such-harness' });
  assert.equal(record.harness, null);
  assert.ok(record.missing.some((note) => note.includes('no-such-harness')), JSON.stringify(record.missing));
});

test('a single installed harness is the target when none is named', (t) => {
  const reach = reachOf([[CLAUDE.id, 'project', { [SEARCH.mcp.server]: 'selected' }]]);
  const { record, markdown } = render(t, { reach });
  assert.equal(record.harness, CLAUDE.id);
  assert.ok(row(markdown, 'locate-concept').includes(`mcp__${SEARCH.mcp.server}__${SEARCH.mcp.tool}`));
  const two = reachOf([[CLAUDE.id, 'project', {}], [OTHER_HARNESS.id, 'project', {}]]);
  assert.equal(render(t, { reach: two }).record.harness, null);
});

test('the block holds no timestamp, path or duration and the same inputs give the same bytes', (t) => {
  const { proj } = projectDir(t);
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj });
  const probes = probesFor(router);
  for (const key of Object.keys(probes)) probes[key].durationMs = Math.random() * 100;
  const a = renderBriefTools({ registry, router, probes, reach: null, owner: 'core-implementer', stage: null });
  const b = renderBriefTools({ registry, router, probes: probesFor(router), reach: null, owner: 'core-implementer', stage: null });
  assert.equal(a.markdown, b.markdown);
  assert.equal(JSON.stringify(a.record), JSON.stringify(b.record));
  assert.doesNotMatch(a.markdown, /\d{4}-\d\d-\d\dT|\bms\b|\/Users\/|\/private\/|\/tmp\//);
  assert.ok(!('tasks' in a.record));
});

test('a fixture registry with one more intent and one more provider reaches the block', (t) => {
  const { proj } = projectDir(t);
  const base = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj });
  const capabilities = JSON.parse(JSON.stringify(base.capabilities));
  capabilities['fixture.capability'] = { description: 'fixture', providers: [{ id: 'fixture.provider', name: 'Fixture', kind: 'cli', binary: 'fixture-bin', checkCommand: ['fixture-bin', '--version'] }] };
  const routes = { ...base.routes, 'fixture-need': { description: 'fixture', capability: 'fixture.capability', fallback: [] } };
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj, capabilities, routes });
  const { markdown, record } = renderBriefTools({
    registry: { ...registry, capabilities }, router, probes: probesFor(router), reach: null, owner: 'core-implementer', stage: null,
  });
  assert.match(row(markdown, 'fixture-need'), /\| fixture\.provider \| fixture-bin /);
  assert.equal(record.tools[record.tools.length - 1].intent, 'fixture-need');
});

test('currentStageOf reads the stage a feature run is at', (t) => {
  const { proj } = projectDir(t);
  new WorkflowOrchestrator({ repoRoot: REPO_ROOT, projectRoot: proj }).start({ taskId: 'feat-one', taskClass: 'feature' });
  const found = currentStageOf({ repoRoot: REPO_ROOT, projectRoot: proj, taskId: 'feat-one' });
  assert.equal(found.stageId, 'discovery');
  assert.equal(found.skill, 'do-brainstorm');
  assert.equal(currentStageOf({ repoRoot: REPO_ROOT, projectRoot: proj, taskId: 'no-run' }), null);
  assert.equal(currentStageOf({ repoRoot: REPO_ROOT, projectRoot: proj, taskId: '../bad' }), null);
});

function cleanEnv(t) {
  const { dir, proj } = projectDir(t);
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  fs.mkdirSync(xdg);
  // Only node, bash and the base utilities: no provider binary answers, so the run is the same everywhere.
  const env = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', DOFLOW_CLI: CLI, DOFLOW_FAILURE_CAPTURE: '',
  };
  return { proj, env };
}

function cli(t, args, { viaRun = false } = {}) {
  const { proj, env } = cleanEnv(t);
  fs.mkdirSync(path.join(proj, '.doflow', 'state'), { recursive: true });
  const result = viaRun
    ? spawnSync('bash', [RUN, 'brief-tools', ...args], { cwd: proj, env, encoding: 'utf8' })
    : spawnSync(process.execPath, [CLI, 'brief-tools', ...args], { cwd: proj, env, encoding: 'utf8' });
  return result;
}

test('a missing --owner or a bad --heading-level is a usage error (exit 2)', (t) => {
  assert.equal(cli(t, []).status, 2);
  assert.equal(cli(t, ['--owner', 'core-implementer', '--heading-level', '4']).status, 2);
  assert.equal(cli(t, ['--owner', 'core-implementer', '--heading-level', 'x']).status, 2);
});

test('every other outcome exits 0: an unknown harness, an unknown owner, no run', (t) => {
  const result = cli(t, ['--owner', 'nobody-here', '--harness', 'no-such-harness', '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.record.harness, null);
  assert.equal(parsed.record.tierSource, 'default');
  assert.ok(parsed.record.missing.length >= 2);
  assert.match(parsed.markdown, /^## Tier and tools/);
});

test('without --json the markdown alone is printed', (t) => {
  const result = cli(t, ['--owner', 'core-implementer', '--heading-level', '3']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^### Tier and tools\n/);
  assert.match(result.stdout, /\n### Report format\n/);
});

test('through doflow-run with storage upkeep due, --json stdout is one JSON document (RK1)', (t) => {
  const result = cli(t, ['--owner', 'core-implementer', '--json'], { viaRun: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['markdown', 'record']);
  assert.equal(parsed.record.owner, 'core-implementer');
});
