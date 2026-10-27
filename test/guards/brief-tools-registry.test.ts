'use strict';

// G29 — the brief's tier and tools block follows the registries (feature 062, IC-023, FR-021,
// FR-028, NFR-008).
//
// The block a generated brief carries (tier, tools per information need, MCP servers) is built from
// the capability, route, MCP, harness and model registries, so a new provider, intent or server needs
// no code change. This guard holds that: the generator and the brief script name no registry id as a
// literal, the rendered block names only registry providers and includes a fixture provider and
// intent added to the registry, the tier vocabulary in models.json matches MODEL_SELECTION.md and the
// agent specs, and every harness tool-name template holds both placeholders. Each check is a function
// run over the shipped tree and over a bad fixture, so a check that stops detecting is itself caught.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { REPO, AGENT_SPECS } = require('./_shared.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { CapabilityRouter } = require('../../src/runtime/capability-router.ts');
const { renderBriefTools } = require('../../src/runtime/brief-tools.ts');

const GENERATOR = 'src/runtime/brief-tools.ts';
const BRIEF_SCRIPT = 'core/shared/scripts/doflow/bash/do-task-brief.sh';
const MODEL_SELECTION = path.join(REPO, 'core', 'shared', 'guidance', 'references', 'MODEL_SELECTION.md');

const registry = loadRegistry({ repoRoot: REPO });
const router: any = new CapabilityRouter({ repoRoot: REPO, projectRoot: REPO });

/** Every name the generator and the script must not spell out: capability ids, provider ids and
 * binaries, route intents, MCP server ids and each provider's `mcp.server`. */
function registryNames({ capabilities, routes, mcp }: any) {
  const names: any = new Set([...Object.keys(capabilities), ...Object.keys(routes), ...mcp.map((server: any) => server.id)]);
  for (const capability of Object.values(capabilities)) {
    for (const provider of capability.providers) {
      names.add(provider.id);
      if (provider.binary) names.add(provider.binary);
      if (provider.mcp?.server) names.add(provider.mcp.server);
    }
  }
  return [...names].sort();
}

const escape = (text: any) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `{line, name}` for each line holding a registry name as a whole token (not part of a longer
 * identifier, dotted id or option name). */
function literalHits(text: any, names: any): any {
  const hits: any = [];
  text.split('\n').forEach((line: any, index: any) => {
    for (const name of names) {
      if (new RegExp(`(?<![A-Za-z0-9_.-])${escape(name)}(?![A-Za-z0-9_-])`).test(line)) hits.push({ line: index + 1, name });
    }
  });
  return hits;
}

const names = registryNames({ capabilities: router.capabilities, routes: router.routes, mcp: registry.mcp });
const where = (file: any, hits: any) => hits.map((hit: any) => `${file}:${hit.line} names '${hit.name}'`);

/** Problems with the tier vocabulary and the per-archetype prescription; empty when consistent.
 * `prescribedTiers` is optional: when given (the {archetype: tier} map parsed from
 * MODEL_SELECTION.md's "## Archetype dispatch tiers" table), byOwner must deep-equal it, so an
 * off-policy edit to models.json — e.g. system-architect dropped to standard — is caught. */
function tierProblems({ dispatchTiers, tableTiers, specNames, prescribedTiers }: any) {
  const problems: any = [];
  const same = (a: any, b: any) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  if (!same(dispatchTiers.tiers, tableTiers)) problems.push(`tiers [${dispatchTiers.tiers}] differ from MODEL_SELECTION.md [${tableTiers}]`);
  if (!dispatchTiers.tiers.includes(dispatchTiers.default)) problems.push(`default '${dispatchTiers.default}' is not in tiers`);
  for (const [owner, tier] of Object.entries(dispatchTiers.byOwner)) {
    if (!dispatchTiers.tiers.includes(tier)) problems.push(`byOwner '${owner}' has tier '${tier}' not in tiers`);
  }
  if (!same(Object.keys(dispatchTiers.byOwner), specNames)) problems.push(`byOwner keys [${Object.keys(dispatchTiers.byOwner)}] differ from agent specs [${specNames}]`);
  if (prescribedTiers) {
    const sameMap = (a: any, b: any) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    if (!sameMap(dispatchTiers.byOwner, prescribedTiers)) {
      problems.push(`byOwner ${JSON.stringify(dispatchTiers.byOwner)} differs from MODEL_SELECTION.md "## Archetype dispatch tiers" ${JSON.stringify(prescribedTiers)}; change the table and byOwner together`);
    }
  }
  return problems;
}

/** The {archetype: tier} map from the first two backticked columns under
 * `## Archetype dispatch tiers`. A trailing Why column and arbitrary prose in it are ignored. */
function prescribedTiersOf(markdown: any) {
  const section = markdown.split(/^## /m).find((part: any) => part.startsWith('Archetype dispatch tiers'));
  assert.ok(section, 'MODEL_SELECTION.md has an "## Archetype dispatch tiers" section');
  const map: any = {};
  for (const [, owner, tier] of section.matchAll(/^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|/gm)) map[owner] = tier;
  return map;
}

/** The backticked names in the first column of the table under `## Capability tiers`. */
function tableTiersOf(markdown: any) {
  const section = markdown.split(/^## /m).find((part: any) => part.startsWith('Capability tiers'));
  assert.ok(section, 'MODEL_SELECTION.md has a "## Capability tiers" section');
  return [...section.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)].map(([, tier]) => tier);
}

/** 106 review R-3: every dispatch REVIEW_OWNERS entry is a `byOwner` key (case-insensitive) and an
 * agent spec name, so renaming the archetype cannot silently turn review work steppable. */
function reviewOwnerProblems(reviewOwners: any, byOwner: any, specNames: any) {
  const lower = (xs: any) => xs.map((x: any) => String(x).toLowerCase());
  const keys = lower(Object.keys(byOwner));
  const specs = lower(specNames);
  const problems: any = [];
  for (const owner of reviewOwners) {
    if (!keys.includes(String(owner).toLowerCase())) problems.push(`REVIEW_OWNERS '${owner}' is not a dispatchTiers.byOwner key`);
    if (!specs.includes(String(owner).toLowerCase())) problems.push(`REVIEW_OWNERS '${owner}' is not an agent spec`);
  }
  return problems;
}

function agentSpecNames() {
  return fs.readdirSync(AGENT_SPECS).filter((file: any) => file.endsWith('.md')).map((file: any) => {
    const match = fs.readFileSync(path.join(AGENT_SPECS, file), 'utf8').match(/^name:\s*(\S+)\s*$/m);
    assert.ok(match, `${file} has a name: key`);
    return match[1];
  });
}

/** Harnesses whose `toolName` template lacks `{server}` or `{tool}`, or holds other braces. */
function toolNameProblems(harnesses: any) {
  const problems: any = [];
  for (const harness of harnesses) {
    const template = harness.capabilities?.mcp?.toolName;
    if (template === undefined) continue;
    const stripped = typeof template === 'string' ? template.replace('{server}', '').replace('{tool}', '') : '';
    if (typeof template !== 'string' || !template.includes('{server}') || !template.includes('{tool}') || /[{}]/.test(stripped)) {
      problems.push(`${harness.id}: toolName '${template}' must hold {server} and {tool} and nothing else in braces`);
    }
  }
  return problems;
}

const allHealthy = (liveRouter: any) => Object.fromEntries(Object.values(liveRouter.capabilities)
  .flatMap((capability) => capability.providers).map((provider) => [provider.id, { id: provider.id, status: 'HEALTHY' }]));

const render = (liveRouter: any, overrides: any = {}) => renderBriefTools({
  registry, router: liveRouter, probes: allHealthy(liveRouter), reach: null, owner: 'core-implementer', stage: null, ...overrides,
});

/** Providers a rendered block names (record and every `Use` cell) that the router's capabilities lack. */
function unknownProviders({ markdown, record }: any, liveRouter: any) {
  const known: any = new Set(Object.values(liveRouter.capabilities).flatMap((capability) => capability.providers.map((provider: any) => provider.id)));
  const used: any = new Set(record.tools.map((tool: any) => tool.provider).filter(Boolean));
  for (const line of markdown.split('\n')) {
    const cells = line.match(/^\| ([^|]+) \| ([^|]+) \|/);
    if (cells && Object.hasOwn(liveRouter.routes, cells[1])) cells[2].replace(/^no healthy .* provider; fallback /, '').split(/\s+/).forEach((word: any) => { if (/^[a-z]+\.[a-z]+$|^rtk$/.test(word)) used.add(word); });
  }
  return [...used].filter((id) => !known.has(id));
}

/** Route intents with no table row (`| <intent> |`) in a rendered block. */
function missingIntents(markdown: any, routes: any) {
  const rows: any = new Set(markdown.split('\n').map((line: any) => line.match(/^\| ([^|]+?) \|/)?.[1]).filter(Boolean));
  return Object.keys(routes).filter((intent) => !rows.has(intent));
}

/** A router over a fixture copy of the registries with one extra capability, provider and intent. */
function fixtureRouter() {
  const capabilities = structuredClone(router.capabilities);
  capabilities['fixture.capability'] = {
    description: 'fixture capability',
    providers: [{ id: 'fixture.provider', name: 'Fixture', kind: 'native', binary: 'fixture-binary', costTier: 'free' }],
  };
  const routes = structuredClone(router.routes);
  routes['fixture-intent'] = { description: 'fixture intent', capability: 'fixture.capability', fallback: [] };
  return new CapabilityRouter({ repoRoot: REPO, projectRoot: REPO, capabilities, routes });
}

// ---- shipped tree -------------------------------------------------------------------------------

test('G29: the registries yield a non-trivial set of names to scan for', () => {
  for (const expected of ['code.semantic-search', 'locate-concept', ...registry.mcp.map((server: any) => server.id)]) {
    assert.ok(names.includes(expected), `${expected} is among the scanned names`);
  }
  assert.ok(names.length >= 10);
});

test('G29: the generator names no harness id', () => {
  const harnessNames = registry.harnesses.map((harness: any) => harness.id);
  assert.deepEqual(literalHits(fs.readFileSync(path.join(REPO, GENERATOR), 'utf8'), harnessNames), []);
  const sample = `const id = '${harnessNames[0]}';`;
  assert.ok(literalHits(sample, harnessNames).length > 0);
});

test('G29: an added harness id is rendered without generator changes', () => {
  const fixtureId = 'fixture-harness';
  const fixtureRegistry = { ...registry, harnesses: [...registry.harnesses, { id: fixtureId, capabilities: { mcp: { status: 'unsupported' } } }] };
  const output = render(router, { registry: fixtureRegistry, harness: fixtureId });
  assert.match(output.markdown, /^Model: harness default on `fixture-harness`\.$/m);
});

test('G29: the generator and the brief script name no capability, provider, binary, intent or server', () => {
  const found: any = [];
  for (const file of [GENERATOR, BRIEF_SCRIPT]) {
    found.push(...where(file, literalHits(fs.readFileSync(path.join(REPO, file), 'utf8'), names)));
  }
  assert.deepEqual(found, [], `registry names are data, not code:\n${found.join('\n')}`);
});

test('G29: the block over the shipped registries names only providers capabilities.json declares', () => {
  const output = render(router);
  assert.ok(output.record.tools.length === Object.keys(router.routes).length, 'one tool row per route intent');
  assert.deepEqual(unknownProviders(output, router), []);
});

test('G29: a fixture registry with one more intent and provider reaches the block with no code change', () => {
  const output = render(fixtureRouter());
  assert.match(output.markdown, /\| fixture-intent \| fixture\.provider \|/);
  const row = output.record.tools.find((tool: any) => tool.intent === 'fixture-intent');
  assert.equal(row?.provider, 'fixture.provider');
  assert.equal(row?.capability, 'fixture.capability');
  assert.deepEqual(unknownProviders(output, fixtureRouter()), []);
});

test('G29: the block has one markdown row per route intent', () => {
  assert.deepEqual(missingIntents(render(router).markdown, router.routes), []);
});

test('G29: with reach and a stage set the block names the harness tool form and the expected servers', () => {
  const harness = registry.harnesses.find((h: any) => h.capabilities?.mcp?.toolName);
  const provider = Object.values(router.capabilities).flatMap((c) => c.providers).find((p) => p.mcp);
  const stepped = registry.mcp.find((server: any) => (server.steps || []).some((step: any) => !step.expectedWhen));
  const skill = stepped.steps.find((step: any) => !step.expectedWhen).skill;
  const reach: any = {
    harnesses: [{ id: harness.id, scope: 'project', catalog: 'taken', servers: { [provider.mcp.server]: 'selected' } }],
    unreadable: [],
    anyHarnessHas: () => true,
  };
  const stage: any = { feature: null, runTaskId: null, stageId: null, skill };
  const output = render(router, { reach, stage, harness: harness.id });
  const toolName = harness.capabilities.mcp.toolName.replace('{server}', provider.mcp.server).replace('{tool}', provider.mcp.tool);
  assert.ok(output.markdown.includes(toolName), `block names ${toolName}`);
  assert.match(output.markdown, new RegExp(`Expected for ${skill}: .*\`${stepped.id}\``));
  assert.deepEqual(missingIntents(output.markdown, router.routes), []);
  assert.deepEqual(unknownProviders(output, router), []);
});

test('G29: dispatchTiers matches MODEL_SELECTION.md and the agent specs', () => {
  const markdown = fs.readFileSync(MODEL_SELECTION, 'utf8');
  const problems = tierProblems({
    dispatchTiers: registry.dispatchTiers,
    tableTiers: tableTiersOf(markdown),
    specNames: agentSpecNames(),
    prescribedTiers: prescribedTiersOf(markdown),
  });
  assert.deepEqual(problems, []);
  const { REVIEW_OWNERS } = require('../../src/runtime/dispatch/loop.ts');
  assert.ok(REVIEW_OWNERS.length > 0);
  assert.deepEqual(reviewOwnerProblems(REVIEW_OWNERS, registry.dispatchTiers.byOwner, agentSpecNames()), []);
  // 118 IC-008 / IC-009: seven archetypes; the two new ones run at frontier and review work is reviewer's.
  assert.equal(Object.keys(registry.dispatchTiers.byOwner).length, 7);
  assert.equal(registry.dispatchTiers.byOwner['delivery-lead'], 'frontier');
  assert.equal(registry.dispatchTiers.byOwner.reviewer, 'frontier');
  assert.deepEqual([...REVIEW_OWNERS], ['reviewer']);
});

test('G29: every harness toolName template holds {server} and {tool}', () => {
  assert.deepEqual(toolNameProblems(registry.harnesses), []);
  assert.ok(registry.harnesses.some((harness: any) => harness.capabilities?.mcp?.toolName), 'at least one harness declares a template');
});

// ---- controls: each check fails on a bad fixture ------------------------------------------------

test('G29 control: a fixture copy of do-task-brief.sh with a provider name inserted fails naming the line', (t) => {
  const dir = tempDir(t, 'doflow-g29-');
  const lines = fs.readFileSync(path.join(REPO, BRIEF_SCRIPT), 'utf8').split('\n');
  lines.splice(9, 0, '# prefer semble for concept lookups');
  const copy = path.join(dir, 'do-task-brief.sh');
  fs.writeFileSync(copy, lines.join('\n'));
  const found = where('do-task-brief.sh', literalHits(fs.readFileSync(copy, 'utf8'), names));
  assert.deepEqual(found, ["do-task-brief.sh:10 names 'semble'"]);
});

test('G29 control: the literal scan catches a provider id, binary, intent, capability and server id in the generator', () => {
  const sample = [
    'const a = 1;',
    "const p = 'semble.search';", "const b = 'rg';", "const i = 'locate-concept';", "const c = 'code.relationships';", "const s = 'context7';",
    "const ok = 'rgb' + 'mcp__x__y' + 'locate-concepts';",
  ].join('\n');
  const hits = literalHits(sample, names).map((hit: any) => `${hit.line}:${hit.name}`);
  assert.deepEqual(hits.sort(), ['2:semble', '2:semble.search', '3:rg', '4:locate-concept', '5:code.relationships', '6:context7'].sort());
});

test('G29 control: the literal scan sees a name added to the registry with no edit to the scan', () => {
  const extended = registryNames({
    capabilities: { ...router.capabilities, 'acme.cap': { providers: [{ id: 'acme.tool', binary: 'acmebin', mcp: { server: 'acme-docs', tool: 'q' } }] } },
    routes: { ...router.routes, 'acme-intent': { capability: 'acme.cap' } },
    mcp: registry.mcp,
  });
  const hits = literalHits("a('acme.tool'); b('acmebin'); c('acme-docs'); d('acme-intent'); e('acme.cap');", extended);
  assert.equal(hits.length, 5);
});

test('G29 control: a block that omits a registry intent or names a provider the registry lacks is detected', () => {
  const full = render(fixtureRouter());
  assert.deepEqual(unknownProviders(full, fixtureRouter()), []);
  assert.deepEqual(missingIntents(full.markdown, fixtureRouter().routes), []);
  // The shipped router does not know the fixture provider: the same block over it is a bad block.
  assert.deepEqual(unknownProviders(full, router), ['fixture.provider']);
  // Dropping an intent's row from the rendered markdown is caught by the row check itself.
  const without = (intent: any) => full.markdown.split('\n').filter((line: any) => !line.startsWith(`| ${intent} |`)).join('\n');
  assert.deepEqual(missingIntents(without('fixture-intent'), fixtureRouter().routes), ['fixture-intent']);
  const [first] = Object.keys(router.routes);
  assert.deepEqual(missingIntents(without(first), fixtureRouter().routes), [first]);
});

test('G29 control: each tier-vocabulary violation fails', () => {
  const good: any = { dispatchTiers: { tiers: ['light', 'standard'], default: 'standard', byOwner: { a: 'light', b: 'standard' } }, tableTiers: ['light', 'standard'], specNames: ['a', 'b'] };
  assert.deepEqual(tierProblems(good), []);
  const bad = (change: any) => tierProblems({ ...good, ...change, dispatchTiers: { ...good.dispatchTiers, ...(change.dispatchTiers || {}) } });
  assert.match(bad({ tableTiers: ['light', 'standard', 'frontier'] })[0], /differ from MODEL_SELECTION\.md/);
  assert.match(bad({ dispatchTiers: { default: 'frontier' } })[0], /default 'frontier' is not in tiers/);
  assert.match(bad({ dispatchTiers: { byOwner: { a: 'light', b: 'epic' } } })[0], /byOwner 'b' has tier 'epic'/);
  assert.match(bad({ specNames: ['a', 'b', 'c'] })[0], /differ from agent specs/);
  assert.match(bad({ dispatchTiers: { byOwner: { a: 'light' } } })[0], /differ from agent specs/);
});

test('G29 control: a REVIEW_OWNERS entry renamed away from byOwner and the agent specs fails', () => {
  const { REVIEW_OWNERS } = require('../../src/runtime/dispatch/loop.ts');
  const byOwner: any = { ...registry.dispatchTiers.byOwner };
  const [renamed] = REVIEW_OWNERS;
  byOwner['quality-reviewer'] = byOwner[renamed];
  delete byOwner[renamed];
  const specs = agentSpecNames().map((name: any) => (name === renamed ? 'quality-reviewer' : name));
  assert.deepEqual(reviewOwnerProblems(REVIEW_OWNERS, byOwner, specs), [
    `REVIEW_OWNERS '${renamed}' is not a dispatchTiers.byOwner key`, `REVIEW_OWNERS '${renamed}' is not an agent spec`,
  ]);
});

test('G29 control: the tier table parser reads backticked first-column names only', () => {
  const md = '## Other\n\n| `no` | x |\n\n## Capability tiers\n\n| Tier | Claude |\n|---|---|\n| `one` | A |\n| `two` | B |\n\n## After\n\n| `three` | C |\n';
  assert.deepEqual(tableTiersOf(md), ['one', 'two']);
});

test('G29 control: an off-policy byOwner value is caught against the prescription', () => {
  const base: any = { tiers: ['light', 'standard', 'frontier'], default: 'standard' };
  assert.deepEqual(tierProblems({
    dispatchTiers: { ...base, byOwner: { 'system-architect': 'frontier' } },
    tableTiers: base.tiers, specNames: ['system-architect'],
    prescribedTiers: { 'system-architect': 'frontier' },
  }), []);
  assert.match(tierProblems({
    dispatchTiers: { ...base, byOwner: { 'system-architect': 'standard' } },
    tableTiers: base.tiers, specNames: ['system-architect'],
    prescribedTiers: { 'system-architect': 'frontier' },
  })[0], /differs from MODEL_SELECTION\.md "## Archetype dispatch tiers"/);
});

test('G29 control: the prescription parser reads archetype and single-backticked tier from the first two columns', () => {
  const md = '## Reviews\n\nprose\n\n## Archetype dispatch tiers\n\n| Archetype | Tier | Why |\n|---|---|---|\n| `system-architect` | `frontier` | sets `standard` shape in prose, ignored |\n| `core-implementer` | `standard` | routine |\n\n## Briefs\n\n| `later` | `x` |\n';
  assert.deepEqual(prescribedTiersOf(md), { 'system-architect': 'frontier', 'core-implementer': 'standard' });
});

test('G29 control: a toolName template missing a placeholder or holding other braces fails', () => {
  const harness = (toolName: any) => ({ id: 'h', capabilities: { mcp: { toolName } } });
  assert.deepEqual(toolNameProblems([harness('mcp__{server}__{tool}'), { id: 'none', capabilities: { mcp: {} } }]), []);
  assert.match(toolNameProblems([harness('mcp__{server}')])[0], /h: toolName/);
  assert.match(toolNameProblems([harness('{tool}')])[0], /h: toolName/);
  assert.match(toolNameProblems([harness('{server}{tool}{x}')])[0], /h: toolName/);
  assert.match(toolNameProblems([harness(42)])[0], /h: toolName/);
});
