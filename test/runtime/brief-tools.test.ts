'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// The tier, tools and report-format block of a generated brief (062 CH7, IC-016 to IC-018).
// `renderBriefTools` is driven with injected probe results and an injected reach object, so no
// provider is run and no install is read; the verb is driven through the CLI and through
// `doflow-run` for exit codes and the one-JSON-document stdout (RK1).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
const { renderBriefTools, currentStageOf, handleBriefToolsCommand } = require('../../src/runtime/brief-tools.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const registry = loadRegistry({ repoRoot: REPO_ROOT });
const SERVERS = registry.mcp.filter((server: any) => server.steps.some((step: any) => !step.expectedWhen));
const STEPPED = SERVERS[0];
const STEP_SKILL = STEPPED.steps.find((step: any) => !step.expectedWhen).skill;
const OTHER = registry.mcp.find((server: any) => server.id !== STEPPED.id && !server.steps.some((step: any) => step.skill === STEP_SKILL));
const SEARCH = registry.capabilities['code.semantic-search'].providers.find((provider: any) => provider.mcp);
const CLAUDE = registry.harnesses.find((harness: any) => harness.capabilities.mcp.toolName);
const OTHER_HARNESS = registry.harnesses.find((harness: any) => !harness.capabilities.mcp.toolName && harness.capabilities.mcp.status === 'supported');

function projectDir(t: any) {
  const dir = tempDir(t, 'doflow-brief-tools-');
  fs.mkdirSync(path.join(dir, 'proj'));
  return { dir, proj: path.join(dir, 'proj') };
}

/** Every provider the router knows, HEALTHY unless named in `bad`. */
function probesFor(router: any, bad: any = []) {
  const probes: any = {};
  for (const capability of Object.values(router.capabilities)) {
    for (const provider of capability.providers) {
      probes[provider.id] = { id: provider.id, status: bad.includes(provider.id) ? 'UNHEALTHY' : 'HEALTHY' };
    }
  }
  return probes;
}

/** A reach object shaped like `mcpReach`'s: rows are [harness id, scope, { server: state }]. */
function reachOf(rows: any) {
  const harnesses = rows.map(([id, scope, servers]: any) => ({ id, scope, catalog: 'taken', servers }));
  return {
    harnesses,
    unreadable: [],
    anyHarnessHas: (server: any) => {
      const states = harnesses.map((row: any) => row.servers[server]);
      if (states.some((state: any) => state === 'selected' || state === 'configured')) return true;
      return states.length > 0 && states.every((state: any) => state === 'not-selected' || state === 'not-taken') ? false : null;
    },
  };
}

function render(t: any, overrides: any = {}) {
  const { proj } = projectDir(t);
  const router: any = overrides.router || new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj });
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

function row(markdown: any, intent: any) {
  return markdown.split('\n').find((line: any) => line.startsWith(`| ${intent} |`));
}

test('a brief recommends a healthy provider and names the tier of the owner', (t) => {
  const { markdown, record } = render(t);
  assert.match(markdown, /^Tier: `standard` \(owner core-implementer\), per `references\/MODEL_SELECTION.md`\.$/m);
  assert.doesNotMatch(markdown, /Pass it as the model/, 'X5: the dispatched agent cannot choose its model');
  assert.match(markdown, /recommended/);
  assert.match(markdown, /not required/);
  assert.match(row(markdown, 'locate-concept'), new RegExp(`\\| ${SEARCH.id.replace('.', '\\.')} \\|`));
  assert.equal(record.tier, 'standard');
  assert.equal(record.tierSource, 'owner');
  assert.equal(record.tools.find((tool: any) => tool.intent === 'locate-concept').provider, SEARCH.id);
  assert.equal(record.tools.find((tool: any) => tool.intent === 'locate-concept').status, 'HEALTHY');
});

test('an unhealthy provider is never named; the next healthy provider of the same capability is named plainly (X4)', (t) => {
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: projectDir(t).proj });
  const { markdown, record }: any = render(t, { router, probes: probesFor(router, [SEARCH.id]) });
  const line = row(markdown, 'locate-concept');
  // native.rg is itself a code.semantic-search provider, so "no healthy provider" would be false.
  assert.match(line, /^\| locate-concept \| native\.rg \|/);
  assert.doesNotMatch(line, /no healthy/);
  assert.ok(!line.includes(SEARCH.id), line);
  assert.ok(!line.includes(SEARCH.mcp.server), line);
  const tool = record.tools.find((entry: any) => entry.intent === 'locate-concept');
  assert.equal(tool.provider, 'native.rg');
  assert.equal(tool.status, 'HEALTHY');
});

test('X4: the fallback wording appears only for a provider of the route fallback capability', (t) => {
  const { proj } = projectDir(t);
  const base: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj });
  const capabilities: any = {
    ...JSON.parse(JSON.stringify(base.capabilities)),
    'fixture.primary': { description: 'fixture', providers: [{ id: 'fx.primary', name: 'P', kind: 'cli', binary: 'fx-p', checkCommand: ['fx-p'] }] },
    'fixture.backup': { description: 'fixture', providers: [{ id: 'fx.backup', name: 'B', kind: 'cli', binary: 'fx-b', checkCommand: ['fx-b'] }] },
  };
  const routes: any = { 'fixture-need': { description: 'fixture', capability: 'fixture.primary', fallback: ['fixture.backup'] } };
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj, capabilities, routes });
  const { markdown, record }: any = renderBriefTools({
    registry: { ...registry, capabilities }, router, probes: probesFor(router, ['fx.primary']), reach: null, owner: 'core-implementer', stage: null,
  });
  assert.match(row(markdown, 'fixture-need'), /\| no healthy fixture\.primary provider; fallback fx\.backup \|/);
  assert.deepEqual([record.tools[0].provider, record.tools[0].status], ['fx.backup', 'FALLBACK']);
});

test('X4: a provider with no probe (UNVERIFIED) is named as unverified, not as missing', (t) => {
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: projectDir(t).proj });
  const probes: any = probesFor(router);
  probes['native.test'] = { id: 'native.test', status: 'UNVERIFIED' };
  const { markdown, record } = render(t, { router, probes });
  const line = row(markdown, 'verify-runtime-behavior');
  assert.match(line, /^\| verify-runtime-behavior \| native\.test \(unverified: no probe\) \|/);
  assert.doesNotMatch(line, /no healthy provider/);
  const tool = record.tools.find((entry: any) => entry.intent === 'verify-runtime-behavior');
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
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: projectDir(t).proj });
  const { markdown, record }: any = render(t, { router, probes: probesFor(router, ['git.native']) });
  assert.match(row(markdown, 'inspect-history'), /no healthy provider and no fallback/);
  const tool = record.tools.find((entry: any) => entry.intent === 'inspect-history');
  assert.deepEqual([tool.provider, tool.status, tool.form], [null, 'NONE', 'none']);
});

test('one registry, two harness forms', (t) => {
  const servers: any = { [SEARCH.mcp.server]: 'configured' };
  const reach = reachOf([[CLAUDE.id, 'project', servers], [OTHER_HARNESS.id, 'global', servers]]);
  const claude = render(t, { reach, harness: CLAUDE.id });
  const other = render(t, { reach, harness: OTHER_HARNESS.id });
  const tool = `mcp__${SEARCH.mcp.server}__${SEARCH.mcp.tool}`;
  assert.ok(row(claude.markdown, 'locate-concept').includes(tool));
  assert.ok(!row(other.markdown, 'locate-concept').includes(tool));
  assert.match(row(other.markdown, 'locate-concept'), /semble search/);
  assert.equal(claude.record.tools.find((entry: any) => entry.intent === 'locate-concept').form, 'mcp');
  assert.equal(other.record.tools.find((entry: any) => entry.intent === 'locate-concept').form, 'cli');
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
  assert.equal(record.tools.find((entry: any) => entry.intent === 'locate-concept').form, 'neutral');
});

test('one table row per routes.json intent, in file order', (t) => {
  const routes = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'routes.json'), 'utf8')).routes;
  const { markdown, record } = render(t);
  const intents = markdown.split('\n').filter((line: any) => /^\| [a-z-]+ \|/.test(line) && !line.startsWith('| Need ')).map((line: any) => line.split(' | ')[0].slice(2));
  assert.deepEqual(intents, Object.keys(routes));
  assert.deepEqual(record.tools.map((tool: any) => tool.intent), Object.keys(routes));
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
  assert.ok(invalid.record.missing.some((note: any) => note.includes("'turbo'")), JSON.stringify(invalid.record.missing));
});

test('an expected server the target cannot reach is stated; selected servers outside the stage are listed with their trigger', (t) => {
  const reach = reachOf([[CLAUDE.id, 'project', {
    ...Object.fromEntries(registry.mcp.map((server: any) => [server.id, 'not-selected'])),
    ...(OTHER ? { [OTHER.id]: 'selected' } : {}),
  }]]);
  const { markdown, record } = render(t, { reach, harness: CLAUDE.id, stage: { feature: 'f', runTaskId: 'f', stageId: 'design', skill: STEP_SKILL } });
  assert.match(markdown, new RegExp(`Expected for ${STEP_SKILL}: .*\`${STEPPED.id}\``));
  assert.ok(markdown.includes(`\`${STEPPED.id}\` is not reachable on this harness; report it as \`${STEPPED.id}=unavailable\`.`), markdown);
  const expected = record.expected.find((entry: any) => entry.server === STEPPED.id);
  assert.equal(expected.reach, 'unreachable');
  assert.equal(record.stage, 'design');
  assert.equal(record.stageSkill, STEP_SKILL);
  if (OTHER) {
    assert.deepEqual(record.optional.includes(OTHER.id), true);
    assert.ok(markdown.includes(`\`${OTHER.id}\` (${OTHER.trigger.replace(/\.$/, '')})`), markdown);
  }
});

test('X1: an expected server DoFlow cannot confirm is hedged, never stated unreachable', (t) => {
  const stage: any = { feature: 'f', runTaskId: 'f', stageId: 'design', skill: STEP_SKILL };
  const hedge = `\`${STEPPED.id}\` may not be reachable on this harness; if no tool answers, report \`${STEPPED.id}=unavailable\`.`;
  const unknown = render(t, { reach: reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'unknown' }]]), harness: CLAUDE.id, stage });
  assert.ok(unknown.markdown.includes(hedge), unknown.markdown);
  assert.ok(!unknown.markdown.includes('is not reachable'), unknown.markdown);
  assert.equal(unknown.record.expected.find((entry: any) => entry.server === STEPPED.id).reach, 'unknown');

  // One scope with a complete view saying absent and another that cannot say: still unknown.
  const mixed = render(t, { reach: reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'not-selected' }], [CLAUDE.id, 'global', { [STEPPED.id]: 'unknown' }]]), harness: CLAUDE.id, stage });
  assert.equal(mixed.record.expected.find((entry: any) => entry.server === STEPPED.id).reach, 'unknown');
  assert.ok(mixed.markdown.includes(hedge), mixed.markdown);

  // No target: any-harness answer null is unknown and hedged on "any installed harness".
  const neutral = render(t, { reach: reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'unknown' }], [OTHER_HARNESS.id, 'project', {}]]), stage });
  assert.equal(neutral.record.expected.find((entry: any) => entry.server === STEPPED.id).reach, 'unknown');
  assert.ok(neutral.markdown.includes(`\`${STEPPED.id}\` may not be reachable on this harness;`), neutral.markdown);
});

test('a reachable expected server is not reported unavailable', (t) => {
  const reach = reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'selected' }]]);
  const { markdown, record } = render(t, { reach, harness: CLAUDE.id, stage: { feature: 'f', runTaskId: 'f', stageId: 'design', skill: STEP_SKILL } });
  assert.ok(!markdown.includes(`${STEPPED.id}=unavailable`));
  assert.equal(record.expected.find((entry: any) => entry.server === STEPPED.id).reach, 'reachable');
});

test('heading levels 2 and 3 change only the wording of the status line', (t) => {
  const two = render(t, { headingLevel: 2 }).markdown;
  const three = render(t, { headingLevel: 3 }).markdown;
  assert.doesNotMatch(three, /^### /m, 'the frame has one heading level');
  assert.equal(three.replace(/each task's report/, 'your report'), two);
  assert.match(two, /Tools used: <name>\[=used\|nothing-usable\|unavailable\|skipped:<reason>\]/);
});

test('an unknown harness is ignored with a missing note', (t) => {
  const { record } = render(t, { harness: 'no-such-harness' });
  assert.equal(record.harness, null);
  assert.ok(record.missing.some((note: any) => note.includes('no-such-harness')), JSON.stringify(record.missing));
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
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj });
  const probes: any = probesFor(router);
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
  const base: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj });
  const capabilities = JSON.parse(JSON.stringify(base.capabilities));
  capabilities['fixture.capability'] = { description: 'fixture', providers: [{ id: 'fixture.provider', name: 'Fixture', kind: 'cli', binary: 'fixture-bin', checkCommand: ['fixture-bin', '--version'] }] };
  const routes: any = { ...base.routes, 'fixture-need': { description: 'fixture', capability: 'fixture.capability', fallback: [] } };
  const router: any = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot: proj, capabilities, routes });
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
  assert.equal(found.taskClass, 'feature');
  assert.equal(currentStageOf({ repoRoot: REPO_ROOT, projectRoot: proj, taskId: 'no-run' }), null);
  assert.equal(currentStageOf({ repoRoot: REPO_ROOT, projectRoot: proj, taskId: '../bad' }), null);
});

test('IC-017: a binding is shown for a valid explicit harness and resolved tier', (t) => {
  const id = registry.harnesses[0].id;
  const { markdown, record } = render(t, {
    harness: id, tier: 'frontier',
    bindings: { state: 'set', map: { [id]: { frontier: 'gpt-6-luna' } }, reason: null },
  });
  assert.ok(markdown.includes(`Tier: \`frontier\` (task line), per \`references/MODEL_SELECTION.md\`.\nModel: \`gpt-6-luna\` [model unchecked] on \`${id}\` (binding, user layer).\n\n`));
  assert.deepEqual(record.model, { harness: id, model: 'gpt-6-luna', provider: null, effort: null, check: { model: 'unchecked', effort: null }, source: 'binding' });
});

test('169: the Model line is bindingText of the same cell the other surfaces show, with the effort and may-lower notes', (t) => {
  const { bindingText } = require('../../src/runtime/models/binding-text.ts');
  const { cellFor } = require('../../src/runtime/models/tier-view.ts');
  const id = registry.harnesses[0].id;
  const custom = structuredClone(registry);
  const worker = custom.harnesses[0].worker;
  worker.provider = { status: 'supported', via: 'id-prefix', separator: '/', evidence: ['x'], verification: 'x', verifiedOn: '2026-11-17' };
  worker.effort = { status: 'supported', via: 'flag', argv: ['--thinking', '{effort}'], levels: ['low', 'high'], mayLower: true, evidence: ['x'], verification: 'x', verifiedOn: '2026-11-17' };
  const catalogue = { version: 1, syncedAt: '', harnesses: { [id]: { offeredModels: [{ id: 'gpt-y', provider: 'openai' }, { id: 'gpt-y', provider: 'other' }], modelList: { status: 'listed' } } } };
  const value = { model: 'gpt-y', provider: 'openai', effort: 'low' };
  const { markdown, record } = render(t, {
    registry: custom, harness: id, tier: 'frontier', catalogue,
    bindings: { state: 'set', map: { [id]: { frontier: value } }, reason: null },
  });
  const cell = cellFor(value, worker, catalogue.harnesses[id]);
  assert.equal(bindingText(cell, { code: true }), '`gpt-y` (provider openai, effort low) [effort unchecked, the harness may lower the effort]');
  assert.ok(markdown.includes(`Model: ${bindingText(cell, { code: true })} on \`${id}\` (binding, user layer).`), markdown);
  assert.deepEqual(record.model, { harness: id, model: 'gpt-y', provider: 'openai', effort: 'low', check: { model: 'listed', effort: 'unchecked' }, source: 'binding' });
  // A plain id several providers list keeps running as typed and says so (R-8).
  const plain = render(t, { registry: custom, harness: id, tier: 'frontier', catalogue, bindings: { state: 'set', map: { [id]: { frontier: 'gpt-y' } }, reason: null } });
  assert.ok(plain.markdown.includes(`Model: \`gpt-y\` [several providers list it] on \`${id}\` (binding, user layer).`), plain.markdown);
});

test('169 A-03: the Model line says dispatch refuses a binding whose provider the harness cannot take', (t) => {
  const id = registry.harnesses[0].id;
  // The shipped claude descriptor takes no provider (`unknown`), so a bound provider is refused at dispatch.
  const { markdown } = render(t, { harness: id, tier: 'frontier', bindings: { state: 'set', map: { [id]: { frontier: { model: 'gpt-y', provider: 'openai' } } }, reason: null } });
  assert.ok(markdown.includes(`Model: \`gpt-y\` (provider openai) [model unchecked, dispatch refuses it (provider:unsupported)] on \`${id}\` (binding, user layer).`), markdown);
});

test('IC-017: absent and invalid bindings produce explicit harness-default lines', (t) => {
  const id = registry.harnesses[0].id;
  const fallback = render(t, { harness: id, tier: 'frontier', bindings: { state: 'unset', map: null, reason: null } });
  assert.ok(fallback.markdown.includes(`Model: harness default on \`${id}\`.`));
  assert.deepEqual(fallback.record.model, { harness: id, model: null, source: 'harness-default' });
  const invalid = render(t, { harness: id, bindings: { state: 'invalid', map: null, reason: 'unreadable' } });
  assert.ok(invalid.markdown.includes(`Model: binding unreadable on \`${id}\`; harness default.`));
  assert.deepEqual(invalid.record.model, { harness: id, model: null, source: 'invalid' });
});

test('IC-017: primary harness is the default target, while an explicit valid harness wins', (t) => {
  const p = { state: 'declared-only', harness: registry.harnesses[0].id };
  const primary = render(t, { primary: p });
  assert.equal(primary.record.harness, p.harness);
  assert.ok(primary.markdown.includes(`Model: harness default on \`${p.harness}\`.`));
  const other = registry.harnesses.find((entry: any) => entry.id !== p.harness);
  if (other) assert.equal(render(t, { primary: p, harness: other.id }).record.harness, other.id);
  const unknown = render(t, { primary: p, harness: 'no-such-harness' });
  assert.equal(unknown.record.harness, p.harness);
  assert.ok(unknown.record.missing.some((note: any) => note.includes('no-such-harness')));
});

test('IC-017: unresolved primary states do not supply a target or model line', (t) => {
  const noPrimary = render(t);
  for (const state of ['unknown', 'refused', 'not-primary']) {
    const result = render(t, { primary: { state, harness: registry.harnesses[0].id } });
    assert.equal(result.record.harness, noPrimary.record.harness);
    assert.equal(result.record.model, null);
    assert.doesNotMatch(result.markdown, /^Model:/m);
  }
});

test('IC-017 negative control: unknown primary preserves the old bytes and record fields', (t) => {
  const baseline = render(t);
  const result = render(t, { primary: { state: 'unknown', harness: registry.harnesses[0].id }, bindings: { state: 'set', map: {}, reason: null } });
  assert.equal(result.markdown, baseline.markdown);
  assert.equal(result.record.model, null);
  const { model: _model, ...record } = result.record;
  const { model: _baselineModel, ...baselineRecord } = baseline.record;
  assert.deepEqual(record, baselineRecord);
});

test('FU-tfkq06: the verb stamps the record with the injected clock, and the markdown does not change', async (t) => {
  const { proj } = projectDir(t);
  const emit = async (now: any) => {
    let printed = '';
    const oldLog = console.log;
    console.log = (text: any) => { printed += `${text}\n`; };
    try { await handleBriefToolsCommand({ owner: 'core-implementer', tier: 'frontier', json: true, repoRoot: REPO_ROOT, projectRoot: proj, now }); } finally { console.log = oldLog; }
    return JSON.parse(printed);
  };
  const first = await emit(() => new Date('2026-11-01T00:00:00.000Z'));
  const second = await emit(() => new Date('2026-11-02T00:00:00.000Z'));
  assert.equal(first.record.createdAt, '2026-11-01T00:00:00.000Z');
  assert.equal(second.record.createdAt, '2026-11-02T00:00:00.000Z');
  assert.equal(first.markdown, second.markdown);
});

test('IC-017: the CLI reads the resolved primary and global model binding', (t) => {
  const { proj, env } = cleanEnv(t);
  const id = registry.harnesses.find((entry: any) => entry.worker?.model)?.id;
  assert.ok(id, 'the registry has a harness with a model descriptor');
  const run = (extraEnv: any = {}, args: any[] = []) => spawnSync(process.execPath,
    [CLI, 'brief-tools', '--owner', 'core-implementer', '--tier', 'frontier', '--json', ...args],
    { cwd: proj, env: { ...env, DOFLOW_PRIMARY_HARNESS: id, ...extraEnv }, encoding: 'utf8' });

  const defaultRun = run();
  assert.equal(defaultRun.status, 0, defaultRun.stderr);
  const defaultResult = JSON.parse(defaultRun.stdout);
  assert.equal(defaultResult.record.harness, id);
  assert.deepEqual(defaultResult.record.model, { harness: id, model: null, source: 'harness-default' });
  assert.ok(defaultResult.markdown.includes('Model: harness default on `' + id + '`.' ));

  const configDir = path.join(env.XDG_CONFIG_HOME, 'doflow');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'settings.json'), JSON.stringify({
    schema: 1,
    'workers.models': { [id]: { frontier: 'gpt-6-luna' } },
  }));
  const boundRun = run();
  assert.equal(boundRun.status, 0, boundRun.stderr);
  const boundResult = JSON.parse(boundRun.stdout);
  assert.deepEqual(boundResult.record.model, { harness: id, model: 'gpt-6-luna', provider: null, effort: null, check: { model: 'unchecked', effort: null }, source: 'binding' });
  assert.ok(boundResult.markdown.includes('Model: `gpt-6-luna` [model unchecked] on `' + id + '` (binding, user layer).'));
});

test('IC-017: an explicit harness without config home reports an unreadable binding and exits successfully', (t) => {
  const { proj, env } = cleanEnv(t);
  const id = registry.harnesses.find((entry: any) => entry.worker?.model)?.id;
  assert.ok(id, 'the registry has a harness with a model descriptor');
  const result = spawnSync(process.execPath,
    [CLI, 'brief-tools', '--owner', 'core-implementer', '--tier', 'frontier', '--harness', id, '--json'],
    { cwd: proj, env: { PATH: env.PATH, DOFLOW_FAILURE_CAPTURE: '' }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.record.model, { harness: id, model: null, source: 'invalid' });
  assert.ok(actual.markdown.includes('Model: binding unreadable on `' + id + '`; harness default.'));
});

function cleanEnv(t: any) {
  const { dir, proj } = projectDir(t);
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(home);
  fs.mkdirSync(xdg);
  // Only node, bash and the base utilities: no provider binary answers, so the run is the same everywhere.
  const env: any = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: home, XDG_CONFIG_HOME: xdg,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, DOFLOW_CLI: CLI, DOFLOW_FAILURE_CAPTURE: '',
  };
  return { proj, env };
}

function cli(t: any, args: any, { viaRun = false }: any = {}) {
  const { proj, env } = cleanEnv(t);
  fs.mkdirSync(path.join(proj, '.doflow', 'state'), { recursive: true });
  const result = viaRun
    ? spawnSync(bashPath(), [RUN, 'brief-tools', ...args], { cwd: proj, env, encoding: 'utf8' })
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
  assert.match(parsed.markdown, /^Tier: /);
  assert.match(parsed.markdown, /\n## Tools\n/);
});

test('without --json the markdown alone is printed', (t) => {
  const result = cli(t, ['--owner', 'core-implementer', '--heading-level', '3']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Tier: /);
  assert.match(result.stdout, /<instructions>[\s\S]*<\/instructions>\n\n<output_format>[\s\S]*<\/output_format>\n$/);
  assert.match(result.stdout, /End each task's report with one line/);
});

test('through doflow-run with storage upkeep due, --json stdout is one JSON document (RK1)', (t) => {
  const result = cli(t, ['--owner', 'core-implementer', '--json'], { viaRun: true });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['markdown', 'parts', 'record']);
  assert.equal(parsed.record.owner, 'core-implementer');
});

test('brief-tools: includes expected servers matching dependency-change and manifest-review stage conditions', (t) => {
  const libraryServer = registry.mcp.find((s: any) => typeof s.trigger === 'string' && s.trigger.toLowerCase().includes('library'));
  assert.ok(libraryServer, 'registry declares a server whose trigger mentions library');

  // Test dependency-change:
  const depStep = libraryServer.steps.find((step: any) => step.expectedWhen === 'dependency-change');
  assert.ok(depStep, 'library server has a dependency-change step');

  const withoutDep = render(t, {
    stage: { feature: 'test-feat', runTaskId: 'test-feat', stageId: 'diagnose', skill: depStep.skill, taskClass: 'feature' },
  });
  assert.ok(!withoutDep.record.expected.some((e: any) => e.server === libraryServer.id));

  const withDep = render(t, {
    stage: { feature: 'test-feat', runTaskId: 'test-feat', stageId: 'diagnose', skill: depStep.skill, taskClass: 'dependency-change' },
  });
  assert.ok(withDep.record.expected.some((e: any) => e.server === libraryServer.id));
  assert.match(withDep.markdown, new RegExp(`Vendor/library facts: \`${libraryServer.id}\` first, else a URL, else UNVERIFIED\\.`));

  // Test manifest-review:
  const manStep = libraryServer.steps.find((step: any) => step.expectedWhen === 'manifest-review');
  assert.ok(manStep, 'library server has a manifest-review step');

  const withoutManifest = render(t, {
    stage: { feature: 'test-feat', runTaskId: 'test-feat', stageId: 'review', skill: manStep.skill, diffFiles: ['src/app.ts'] },
  });
  assert.ok(!withoutManifest.record.expected.some((e: any) => e.server === libraryServer.id));

  const withManifest = render(t, {
    stage: { feature: 'test-feat', runTaskId: 'test-feat', stageId: 'review', skill: manStep.skill, diffFiles: ['package.json'] },
  });
  assert.ok(withManifest.record.expected.some((e: any) => e.server === libraryServer.id));
  assert.match(withManifest.markdown, new RegExp(`Vendor/library facts: \`${libraryServer.id}\` first, else a URL, else UNVERIFIED\\.`));
});

test('currentStageOf: reads stageId, skill and taskClass from run', (t) => {
  const { proj } = projectDir(t);
  new WorkflowOrchestrator({ repoRoot: REPO_ROOT, projectRoot: proj }).start({ taskId: 'dep-task', taskClass: 'dependency-change' });
  const stage = currentStageOf({ repoRoot: REPO_ROOT, projectRoot: proj, taskId: 'dep-task' });
  assert.equal(stage.taskClass, 'dependency-change');
  assert.ok(stage.stageId);
  assert.ok(stage.skill);
});

// --- row 173 T2: the block as parts, and as one valid prompt frame ----------------------------------

const { handbackLines } = require('../../src/runtime/prompt/handback.ts');

const count = (text: string, needle: string) => text.split(needle).length - 1;

test('173 T2: parts holds the header pairs, the rules, the tools text and the report lines', (t) => {
  const id = CLAUDE.id;
  const { markdown, record, parts }: any = render(t, { harness: id, tier: 'frontier', bindings: { state: 'absent', map: {}, reason: null } });
  assert.deepEqual(Object.keys(parts).sort(), ['header', 'report', 'rules', 'tools']);
  assert.deepEqual(parts.header.map(([key]: any) => key), ['Tier', 'Model']);
  assert.match(parts.header[0][1], /^`frontier` \(task line\), per `references\/MODEL_SELECTION\.md`\.$/);
  assert.equal(parts.header[1][1], `harness default on \`${id}\`.`);
  assert.ok(parts.rules.length >= 3 && parts.rules.every((line: any) => typeof line === 'string' && !line.startsWith('- ')));
  assert.match(parts.tools, /^Tools this machine answers with/);
  assert.ok(parts.tools.split('\n').some((line: any) => line.startsWith('| locate-concept |')));
  assert.deepEqual(parts.report, handbackLines({ group: false }));
  assert.equal(record.tier, 'frontier', 'the record keeps its shape');
  assert.ok(markdown.startsWith('Tier: `frontier` (task line), per `references/MODEL_SELECTION.md`.\nModel: '), markdown);
});

test('173 T2: a block with no model line and no rules has a one-pair header and no Rules block', (t) => {
  const { proj } = projectDir(t);
  const { parts, markdown, record }: any = render(t, { repoRoot: proj });
  assert.deepEqual(parts.header.map(([key]: any) => key), ['Tier']);
  assert.deepEqual(parts.rules, []);
  assert.doesNotMatch(markdown, /^## Rules$/m);
  assert.ok(record.missing.some((m: string) => m.startsWith('brief-rules: ')));
});

test('173 T2: markdown is one valid frame: both tags once, the blocks in order, nothing between the sections', (t) => {
  const { markdown, parts }: any = render(t);
  for (const tag of ['instructions', 'output_format']) {
    assert.equal(count(markdown, `<${tag}>`), 1, tag);
    assert.equal(count(markdown, `</${tag}>`), 1, tag);
  }
  assert.equal(count(markdown, '<document'), 0);
  assert.match(markdown, /<\/instructions>\n\n<output_format>\n/);
  assert.ok(markdown.includes('<instructions>\nUse the tier and tools below for this dispatch.\n\n## Rules\n- '));
  assert.ok(markdown.indexOf('\n## Rules\n') < markdown.indexOf('\n## Tools\n'));
  assert.ok(markdown.indexOf('\n## Tools\n') < markdown.indexOf('\n## Stop rule\n'));
  assert.ok(markdown.includes(`\n## Tools\n${parts.tools}\n\n## Stop rule\n`));
  assert.ok(markdown.trimEnd().endsWith('</output_format>'));
  assert.equal(markdown.split('\n')[0].startsWith('Tier: '), true, 'the header comes before every section');
  assert.doesNotMatch(markdown, /Tier and tools|Report format|Rules that apply to you/);
});

test('173 T2: no vendor display name appears in markdown or parts, whatever the target', (t) => {
  const names = registry.harnesses.map((harness: any) => harness.displayName).filter(Boolean);
  assert.ok(names.length > 0);
  const reach = reachOf([[CLAUDE.id, 'project', { [STEPPED.id]: 'not-selected' }]]);
  const stage = { feature: 'f', runTaskId: 'f', stageId: 'design', skill: STEP_SKILL };
  for (const overrides of [{ reach, harness: CLAUDE.id, stage }, { reach: null, stage }, {}]) {
    const out: any = render(t, overrides);
    const all = `${out.markdown}\n${JSON.stringify(out.parts)}`;
    for (const name of names) assert.ok(!all.includes(name), `${name} in the output`);
  }
  const unreachable: any = render(t, { reach, harness: CLAUDE.id, stage });
  assert.ok(unreachable.markdown.includes(`\`${STEPPED.id}\` is not reachable on this harness; report it as \`${STEPPED.id}=unavailable\`.`), unreachable.markdown);
});

test('173 T2: the report lines put the Brief feedback line before Tools used, and heading level 3 words the status for a group', (t) => {
  const single: any = render(t);
  const group: any = render(t, { headingLevel: 3 });
  assert.deepEqual(single.parts.report, handbackLines({ group: false }));
  assert.deepEqual(group.parts.report, handbackLines({ group: true }));
  assert.ok(single.parts.report[0].includes('`Brief feedback: <what>`'));
  assert.ok(single.parts.report.findIndex((l: string) => l.includes('Brief feedback:')) < single.parts.report.findIndex((l: string) => l.startsWith('`Tools used: ')));
  assert.ok(single.parts.report.at(-1).startsWith('End your report with one line'));
  assert.ok(group.parts.report.at(-1).startsWith("End each task's report with one line"));
  assert.ok(single.markdown.includes(`<output_format>\nThe session that dispatched you reads this reply; put the conclusion first.\n${single.parts.report.join('\n')}\n</output_format>`));
  assert.ok(group.markdown.includes(group.parts.report.join('\n')));
  assert.ok(!group.markdown.includes('\nEnd your report'));
});

test('173 T2: --json prints markdown, record and parts; the text mode prints the same markdown', (t) => {
  const json = cli(t, ['--owner', 'core-implementer', '--json']);
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.deepEqual(Object.keys(parsed).sort(), ['markdown', 'parts', 'record']);
  assert.deepEqual(Object.keys(parsed.parts).sort(), ['header', 'report', 'rules', 'tools']);
  const text = cli(t, ['--owner', 'core-implementer']);
  assert.equal(text.status, 0, text.stderr);
  assert.equal(text.stdout, parsed.markdown);
});
