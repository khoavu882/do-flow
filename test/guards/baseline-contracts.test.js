'use strict';

/**
 * G33: Baseline and contracts guard (074 IC-030).
 *
 * Verifies that the pinned benchmark snapshot commit is present in git history,
 * that manifest entries recomputed from git objects at that commit match manifest.json,
 * and that dev tasks conform to IC-013 rules against blobs at the pinned commit.
 *
 * Reads git objects of the pinned snapshot commit, never the working tree and
 * never installed tool versions. Spawns only `git`.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const snapshotLib = require('../../bench/retrieval/lib/snapshot.js');
const { validateTaskFile } = require('../../bench/retrieval/lib/tasks.js');
const { sha256Hex } = require('../../bench/retrieval/lib/seal.js');

const REPO = path.resolve(__dirname, '..', '..');

test('G33.1: pinned snapshot commit is present in git history', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const commit = snapshot.commit;
  const run = spawnSync('git', ['-C', REPO, 'cat-file', '-e', `${commit}^{commit}`]);
  if (run.status !== 0) {
    assert.fail('pinned commit absent; CI must fetch full history (fetch-depth 0)');
  }
});

test('G33.2: manifest recomputed from git ls-tree matches manifest.json and manifestSha256', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const manifest = snapshotLib.loadManifest();

  const entries = snapshotLib.buildManifest(REPO, snapshot.commit, snapshot);
  const actualSha = snapshotLib.manifestDigest(entries);

  assert.equal(actualSha, snapshot.manifestSha256, 'recomputed manifest digest must match snapshot.manifestSha256');
  assert.deepEqual(entries, manifest.entries, 'recomputed manifest entries must match manifest.json');
});

test('G33.3: dev task file digest matches snapshot.json and satisfies IC-013 rules', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const manifest = snapshotLib.loadManifest();
  const devFile = path.join(REPO, snapshot.taskFiles.dev.path);

  assert.ok(fs.existsSync(devFile), `dev tasks file must exist at ${devFile}`);
  const rawBytes = fs.readFileSync(devFile);
  const actualSha = sha256Hex(rawBytes);
  assert.equal(actualSha, snapshot.taskFiles.dev.sha256, 'dev tasks file sha256 must match snapshot.taskFiles.dev.sha256');

  const taskFile = JSON.parse(rawBytes.toString('utf8'));
  const findings = validateTaskFile(taskFile, {
    split: 'dev',
    snapshot,
    manifest,
    repoRoot: REPO,
  });

  assert.deepEqual(findings, [], `dev tasks must have 0 findings: ${JSON.stringify(findings)}`);
});

test('G33.3 control: mutated in-memory task missing a required field or anchor is reported with field name', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const manifest = snapshotLib.loadManifest();
  const devFile = path.join(REPO, snapshot.taskFiles.dev.path);
  const taskFile = JSON.parse(fs.readFileSync(devFile, 'utf8'));

  // Control 1: Remove required literal field from exact-lookup task
  const copy1 = structuredClone(taskFile);
  const exactTask = copy1.tasks.find((t) => t.class === 'exact-lookup' && t.literal);
  assert.ok(exactTask, 'must find an exact-lookup task with literal');
  delete exactTask.literal;

  const f1 = validateTaskFile(copy1, { split: 'dev', snapshot, manifest, repoRoot: REPO });
  const missingLiteral = f1.find((f) => f.taskId === exactTask.id && f.code === 'E_FIELD');
  assert.ok(missingLiteral, 'must report E_FIELD for missing literal');
  assert.ok(missingLiteral.message.includes('literal'), 'error message must name the missing field');

  // Control 2: Mutate anchorSha on a qrel
  const copy2 = structuredClone(taskFile);
  const qrelTask = copy2.tasks.find((t) => t.qrels && t.qrels.length > 0);
  assert.ok(qrelTask, 'must find a task with qrels');
  qrelTask.qrels[0].anchorSha = '0'.repeat(64);

  const f2 = validateTaskFile(copy2, { split: 'dev', snapshot, manifest, repoRoot: REPO });
  const badAnchor = f2.find((f) => f.taskId === qrelTask.id && f.code === 'E_QREL_ANCHOR');
  assert.ok(badAnchor, 'must report E_QREL_ANCHOR when anchorSha does not match');
  assert.ok(badAnchor.message.includes('anchorSha'), 'error message must name anchorSha');
});

// ---- K.2: Inventory, registry and contract checks (G33.12, G33.13, G33.15, G33.16) ----
const k2Read = (rel) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const K2_DATE = /^\d{4}-\d{2}-\d{2}$/;
const K2_ISO_OK = (s) => typeof s === 'string' && K2_DATE.test(s) && !Number.isNaN(Date.parse(s));

/** A Fact is {value, source, verifiedOn} or {unverified, verifiedOn}; `{unreached}` is allowed where a field says so. */
function k2FactProblems(fact, where, { allowUnreached = false } = {}) {
  const p = [];
  if (fact === null || typeof fact !== 'object' || Array.isArray(fact)) return [`${where}: must be a Fact object`];
  if (allowUnreached && typeof fact.unreached === 'string' && fact.unreached) return p;
  if (Object.hasOwn(fact, 'unverified')) {
    if (typeof fact.unverified !== 'string' || !fact.unverified) p.push(`${where}.unverified: must be a non-empty reason`);
  } else if (Object.hasOwn(fact, 'value')) {
    if (typeof fact.source !== 'string' || !fact.source) p.push(`${where}.source: a Fact with a value needs a source`);
  } else p.push(`${where}: neither value with source nor unverified`);
  if (!K2_ISO_OK(fact.verifiedOn)) p.push(`${where}.verifiedOn: must be YYYY-MM-DD, got ${JSON.stringify(fact.verifiedOn)}`);
  return p;
}
const k2Need = (obj, fields, where) => fields.filter((f) => !Object.hasOwn(obj, f) || obj[f] === undefined).map((f) => `${where}.${f}: required field missing`);

function k2InventoryProblems({ capabilities, tools, coverage }) {
  const p = [];
  for (const [name, doc] of [['capabilities.json', capabilities], ['tools.json', tools], ['coverage.json', coverage]]) {
    if (!doc.refresh || !doc.refresh.trigger || !doc.refresh.owner) p.push(`${name}.refresh: trigger and owner are required`);
  }
  const hops = ['intent', 'provider', 'retrieval-plan', 'evidence', 'context', 'verification'];
  const states = ['verified', 'partial', 'missing', 'target', 'declared'];
  if (!/^[0-9a-f]{40}$/.test(capabilities.inspectedAt || '')) p.push('capabilities.json.inspectedAt: must be a commit sha');
  for (const r of capabilities.rows) {
    const w = `capabilities.json ${r.id}`;
    p.push(...k2Need(r, ['id', 'hop', 'subject', 'adapter', 'state', 'locator', 'inspectedAt', 'note'], w));
    if (!/^INV-\d{3}$/.test(r.id || '')) p.push(`${w}.id: must match INV-nnn`);
    if (!hops.includes(r.hop)) p.push(`${w}.hop: ${r.hop}`);
    if (!states.includes(r.state)) p.push(`${w}.state: ${r.state}`);
    if (!r.locator || !['path-line', 'commit', 'command'].includes(r.locator.kind) || !r.locator.ref) p.push(`${w}.locator: kind and ref are required`);
  }
  const ids = new Set(capabilities.rows.map((r) => r.id));
  if (!(capabilities.gateEvidence || []).length || capabilities.gateEvidence.some((id) => !ids.has(id))) p.push('capabilities.json.gateEvidence: must name existing row ids');
  for (const r of tools.rows) {
    const w = `tools.json ${r.id}`;
    p.push(...k2Need(r, ['id', 'name', 'class', 'list', 'repo', 'version', 'licence', 'platforms', 'stars'], w));
    if (!tools.classes.includes(r.class)) p.push(`${w}.class: ${r.class}`);
    for (const f of ['repo', 'version', 'licence', 'platforms', 'stars']) if (r[f]) p.push(...k2FactProblems(r[f], `${w}.${f}`));
    if (r.localVersion) p.push(...k2FactProblems(r.localVersion, `${w}.localVersion`));
    if (r.list === 'stack' && !r.localVersion) p.push(`${w}.localVersion: required for a stack row`);
  }
  const adv = tools.localAdvisor || {};
  for (const f of ['modelId', 'backend', 'backendVersion', 'structuredOutput']) p.push(...k2FactProblems(adv[f] || null, `tools.json localAdvisor.${f}`));
  for (const f of ['rssAloneMB', 'rssWithCodingModelMB']) {
    const v = adv[f];
    if (!v || (typeof v.unmeasured !== 'string' && k2FactProblems(v, f).length)) p.push(`tools.json localAdvisor.${f}: Fact or {unmeasured}`);
  }
  for (const [i, r] of coverage.rows.entries()) {
    const w = `coverage.json row ${i} (${r.harness}/${r.event})`;
    p.push(...k2Need(r, ['harness', 'installedVersion', 'executionMode', 'event', 'wired', 'registryClaim', 'observedSemantics', 'sameNameNotAssumed'], w));
    p.push(...k2FactProblems(r.installedVersion || null, `${w}.installedVersion`, { allowUnreached: true }));
    p.push(...k2FactProblems(r.observedSemantics || null, `${w}.observedSemantics`, { allowUnreached: true }));
    if (!['interactive', 'headless', 'unknown'].includes(r.executionMode)) p.push(`${w}.executionMode: ${r.executionMode}`);
    if (!['supported', 'different', 'unavailable', 'absent'].includes(r.registryClaim)) p.push(`${w}.registryClaim: ${r.registryClaim}`);
    if (r.sameNameNotAssumed !== true) p.push(`${w}.sameNameNotAssumed: must be true`);
  }
  return p;
}

function k2StarSplitProblems(tools) {
  const p = [];
  for (const r of tools.rows) {
    const w = `tools.json ${r.id} (${r.name})`;
    if (r.list === 'main' && !(r.stars?.value > tools.starThreshold)) p.push(`${w}.stars: a main row needs more than ${tools.starThreshold} stars`);
    if (r.list === 'small' && !(r.stars?.value <= tools.starThreshold)) p.push(`${w}.stars: a small row needs ${tools.starThreshold} stars or fewer`);
    if (r.list === 'excluded' && r.name !== 'Serena') p.push(`${w}.list: only Serena may be excluded`);
    if (r.name === 'Serena' && r.list !== 'excluded') p.push(`${w}.list: Serena may appear only as excluded`);
    if (r.list === 'excluded' && r.excludedBy !== 'ADR section 1') p.push(`${w}.excludedBy: must be "ADR section 1"`);
  }
  if (!tools.rows.some((r) => r.name === 'Serena')) p.push('tools.json: Serena must appear as an excluded row');
  return p;
}

function k2OrchestrationProblems(registryModule) {
  const registry = registryModule.loadRegistry({ repoRoot: REPO });
  const p = [];
  const withBlock = registry.harnesses.filter((h) => h.orchestration !== undefined);
  if (registry.harnesses.length !== 8 || withBlock.length !== 8) p.push(`core/registry/harnesses.json: ${withBlock.length} of ${registry.harnesses.length} harnesses carry the orchestration block, 8 expected`);
  const issues = registry.validation.errors.filter((e) => / orchestration/.test(e));
  return p.concat(issues.map((e) => `core/registry/harnesses.json: ${e}`));
}

function k2ContractProblems({ operatingModes, boundary, assertNoScoreFields }) {
  const p = [];
  const headings = (text) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const want27 = ['Modes', 'Ownership', 'Task states', 'Rules', 'User controls', 'Harness primitives', 'Refresh'];
  const got27 = headings(operatingModes).filter((h) => want27.includes(h));
  if (JSON.stringify(got27) !== JSON.stringify(want27)) p.push(`docs/specs/operating-modes.md: headings ${JSON.stringify(got27)} differ from IC-027 ${JSON.stringify(want27)}`);
  const section = operatingModes.split(/^## Task states$/m)[1]?.split(/^## /m)[0] || '';
  for (const state of ['PLANNED', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']) {
    const row = section.split('\n').find((l) => l.startsWith(`| ${state} |`));
    const cells = row ? row.split('|').map((c) => c.trim()) : [];
    if (!row) p.push(`docs/specs/operating-modes.md: Task states has no ${state} row`);
    else if (!['implemented', 'target'].includes(cells[3])) p.push(`docs/specs/operating-modes.md: ${state} Implemented cell must be implemented or target, got ${JSON.stringify(cells[3])}`);
  }
  const want28 = ['Candidate', 'Evidence', 'Absence', 'Examples', 'Refresh'];
  const got28 = headings(boundary).filter((h) => want28.includes(h));
  if (JSON.stringify(got28) !== JSON.stringify(want28)) p.push(`docs/specs/candidate-evidence-boundary.md: headings ${JSON.stringify(got28)} differ from IC-028`);
  const examples = new Map();
  for (const m of boundary.matchAll(/<!-- example: (\S+) (valid|invalid) -->\n```json\n([\s\S]*?)\n```/g)) examples.set(m[1], m[3]);
  for (const id of ['valid-1', 'invalid-score-evidence', 'invalid-provider-binding', 'invalid-stale-absence']) if (!examples.has(id)) p.push(`docs/specs/candidate-evidence-boundary.md: example ${id} is missing`);
  if (examples.has('invalid-score-evidence')) {
    let threw = false;
    try { assertNoScoreFields(JSON.parse(examples.get('invalid-score-evidence')), ''); } catch { threw = true; }
    if (!threw) p.push('docs/specs/candidate-evidence-boundary.md: assertNoScoreFields did not throw on invalid-score-evidence');
  }
  if (examples.has('valid-1')) {
    try { assertNoScoreFields(JSON.parse(examples.get('valid-1')), ''); } catch (e) { p.push(`docs/specs/candidate-evidence-boundary.md: valid-1 was rejected: ${e.message.slice(0, 60)}`); }
  }
  return p;
}

const k2Load = () => ({
  capabilities: k2Read('bench/inventory/capabilities.json'),
  tools: k2Read('bench/inventory/tools.json'),
  coverage: k2Read('bench/inventory/coverage.json'),
});

test('G33.12: inventory rows and Facts carry every required field with a YYYY-MM-DD date', () => {
  assert.deepEqual(k2InventoryProblems(k2Load()), []);
});
test('G33.12 control: a row missing a field, a bad date and a Fact without a source are each named', () => {
  const d = structuredClone(k2Load());
  delete d.capabilities.rows[0].locator;
  d.tools.rows[0].stars.verifiedOn = '12/10/2026';
  delete d.tools.rows[1].licence.source;
  delete d.coverage.rows[0].sameNameNotAssumed;
  const got = k2InventoryProblems(d).join('\n');
  assert.match(got, /capabilities\.json INV-001\.locator: required field missing/);
  assert.match(got, /tools\.json TOOL-001\.stars\.verifiedOn: must be YYYY-MM-DD/);
  assert.match(got, /tools\.json TOOL-002\.licence\.source: a Fact with a value needs a source/);
  assert.match(got, /coverage\.json row 0 \(claude\/SessionStart\)\.sameNameNotAssumed: required field missing/);
});

test('G33.13: main rows exceed the star threshold, small rows do not, and only Serena is excluded', () => {
  assert.deepEqual(k2StarSplitProblems(k2Load().tools), []);
});
test('G33.13 control: a main row at 20000 stars, a small row above it and a second excluded row are reported', () => {
  const t = structuredClone(k2Load().tools);
  t.rows.find((r) => r.list === 'main').stars.value = 20000;
  t.rows.find((r) => r.list === 'small').stars.value = 20001;
  t.rows.find((r) => r.list === 'stack').list = 'excluded';
  const got = k2StarSplitProblems(t).join('\n');
  assert.match(got, /stars: a main row needs more than 20000 stars/);
  assert.match(got, /stars: a small row needs 20000 stars or fewer/);
  assert.match(got, /list: only Serena may be excluded/);
});

test('G33.15: eight harnesses carry the orchestration block and loadRegistry reports no issue with it', () => {
  assert.deepEqual(k2OrchestrationProblems(require(path.join(REPO, 'src/registry/index.ts'))), []);
});
test('G33.15 control: dropping one harness block or one operation is reported with the harness name', () => {
  const registryModule = require(path.join(REPO, 'src/registry/index.ts'));
  const registry = structuredClone(registryModule.loadRegistry({ repoRoot: REPO }));
  delete registry.harnesses[1].orchestration;
  delete registry.harnesses[2].orchestration.cancel;
  const errors = registryModule.validateRegistry(registry, { repoRoot: REPO }).errors.join('\n');
  assert.match(errors, /harness 'codex': orchestration block is required/);
  assert.match(errors, /harness 'gemini': orchestration is missing operation 'cancel'/);
});

test('G33.16: IC-027 headings and state rows, IC-028 headings and examples, and the score refusal hold', () => {
  const { assertNoScoreFields } = require(path.join(REPO, 'src/runtime/cli.ts'));
  assert.deepEqual(k2ContractProblems({
    operatingModes: fs.readFileSync(path.join(REPO, 'docs/specs/operating-modes.md'), 'utf8'),
    boundary: fs.readFileSync(path.join(REPO, 'docs/specs/candidate-evidence-boundary.md'), 'utf8'),
    assertNoScoreFields,
  }), []);
});
test('G33.16 control: a dropped heading, a dropped state row, a dropped example and a non-throwing refusal are reported', () => {
  const { assertNoScoreFields } = require(path.join(REPO, 'src/runtime/cli.ts'));
  const operatingModes = fs.readFileSync(path.join(REPO, 'docs/specs/operating-modes.md'), 'utf8')
    .replace(/^## Rules$/m, '## Rule').replace(/^\| CANCELLED \|.*$/m, '');
  const boundary = fs.readFileSync(path.join(REPO, 'docs/specs/candidate-evidence-boundary.md'), 'utf8')
    .replace('<!-- example: invalid-stale-absence invalid -->', '');
  const got = k2ContractProblems({ operatingModes, boundary, assertNoScoreFields: () => {} }).join('\n');
  assert.match(got, /operating-modes\.md: headings .* differ from IC-027/);
  assert.match(got, /Task states has no CANCELLED row/);
  assert.match(got, /example invalid-stale-absence is missing/);
  assert.match(got, /assertNoScoreFields did not throw on invalid-score-evidence/);
});
