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
const { spawnSync, execFileSync } = require('node:child_process');

const snapshotLib = require('../../bench/retrieval/lib/snapshot.ts');
const { validateTaskFile } = require('../../bench/retrieval/lib/tasks.ts');
const sealLib = require('../../bench/retrieval/lib/seal.ts');
const { sha256Hex } = sealLib;
const { classesFor } = require('../../bench/retrieval/lib/metrics.ts');
const { tempDir } = require('../helper/tmp.ts');

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
  const exactTask = copy1.tasks.find((t: any) => t.class === 'exact-lookup' && t.literal);
  assert.ok(exactTask, 'must find an exact-lookup task with literal');
  delete exactTask.literal;

  const f1 = validateTaskFile(copy1, { split: 'dev', snapshot, manifest, repoRoot: REPO });
  const missingLiteral = f1.find((f: any) => f.taskId === exactTask.id && f.code === 'E_FIELD');
  assert.ok(missingLiteral, 'must report E_FIELD for missing literal');
  assert.ok(missingLiteral.message.includes('literal'), 'error message must name the missing field');

  // Control 2: Mutate anchorSha on a qrel
  const copy2 = structuredClone(taskFile);
  const qrelTask = copy2.tasks.find((t: any) => t.qrels && t.qrels.length > 0);
  assert.ok(qrelTask, 'must find a task with qrels');
  qrelTask.qrels[0].anchorSha = '0'.repeat(64);

  const f2 = validateTaskFile(copy2, { split: 'dev', snapshot, manifest, repoRoot: REPO });
  const badAnchor = f2.find((f: any) => f.taskId === qrelTask.id && f.code === 'E_QREL_ANCHOR');
  assert.ok(badAnchor, 'must report E_QREL_ANCHOR when anchorSha does not match');
  assert.ok(badAnchor.message.includes('anchorSha'), 'error message must name anchorSha');
});

// ---- H.3: Holdout splits and canary checks (G33.4, G33.5) ----
const holdoutDir = path.join(REPO, 'bench/retrieval/holdout');

function toPosixPath(p: any) {
  return p.split(path.sep).join('/').replace(/\\/g, '/');
}

function h3LoadSeals(targetDir: any = holdoutDir) {
  const seals: any = [];
  assert.ok(fs.existsSync(targetDir), `holdout directory must exist at ${targetDir}`);
  const files = fs.readdirSync(targetDir).filter((f: any) => f.endsWith('.seal.json')).sort();
  assert.ok(files.length > 0, 'holdout directory must contain at least one *.seal.json');
  for (const f of files) {
    const fullPath = path.join(targetDir, f);
    const seal = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    const relSealPath = toPosixPath(path.relative(REPO, fullPath));
    seals.push({ corpus: seal.corpus, generation: seal.generation, seal, relSealPath });
  }
  for (const corpus of ['code', 'guidance']) {
    const corpusSeals = seals.filter((s: any) => s.corpus === corpus);
    assert.ok(corpusSeals.length > 0, `holdout directory must contain at least one generation for corpus ${corpus}`);
  }
  return seals;
}

function h3SplitProblems({ devTaskFile, seals }: any) {
  const p: any = [];
  const devIds: any = new Set((devTaskFile.tasks || []).map((t: any) => t.id));

  const devClassCounts: any = { code: {}, guidance: {} };
  for (const t of devTaskFile.tasks || []) {
    if (devClassCounts[t.corpus]) {
      devClassCounts[t.corpus][t.class] = (devClassCounts[t.corpus][t.class] || 0) + 1;
    }
  }

  for (const corpus of ['code', 'guidance']) {
    for (const cls of classesFor(corpus)) {
      if (!devClassCounts[corpus] || !devClassCounts[corpus][cls]) {
        p.push(`${corpus}: applicable class '${cls}' has 0 dev tasks in tasks/dev.json`);
      }
    }
  }

  for (const { corpus, seal, relSealPath } of seals) {
    for (const id of seal.ids || []) {
      if (devIds.has(id)) {
        p.push(`${relSealPath}: holdout task id ${id} appears in tasks/dev.json`);
      }
    }

    const applicable = classesFor(corpus);
    for (const cls of applicable) {
      const holdoutCount = (seal.classCounts && seal.classCounts[cls]) || 0;
      if (holdoutCount === 0) {
        p.push(`${corpus}: applicable class '${cls}' has 0 holdout tasks in classCounts`);
      }
    }
  }
  return p;
}

function h3CanaryProblems({ repoRoot, seals, grepFn = null }: any) {
  const p: any = [];
  for (const { seal, relSealPath } of seals) {
    const canary = seal.canary;
    if (!canary) {
      p.push(`${relSealPath}: seal has no canary`);
      continue;
    }
    const posixSealPath = toPosixPath(relSealPath);
    const lines = grepFn
      ? grepFn(canary)
      : spawnSync('git', ['-C', repoRoot, 'grep', '-F', canary], { encoding: 'utf8' })
          .stdout.trim().split('\n').filter(Boolean);

    for (const line of lines) {
      const matchFile = toPosixPath(line.split(':')[0]);
      if (matchFile !== posixSealPath) {
        p.push(`${posixSealPath}: canary leaked in tracked file ${matchFile}`);
      }
    }
  }
  return p;
}

test('G33.4: no seal ids entry in tasks/dev.json and every applicable class has dev and holdout tasks', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const devFile = path.join(REPO, snapshot.taskFiles.dev.path);
  const devTaskFile = JSON.parse(fs.readFileSync(devFile, 'utf8'));
  const seals = h3LoadSeals();
  assert.deepEqual(h3SplitProblems({ devTaskFile, seals }), []);
});

test('G33.4 control: duplicate id, missing dev class and missing holdout class are reported', () => {
  const snapshot = snapshotLib.loadSnapshot();
  const devFile = path.join(REPO, snapshot.taskFiles.dev.path);
  const devTaskFile = JSON.parse(fs.readFileSync(devFile, 'utf8'));
  const seals = h3LoadSeals();

  // Control 1: duplicate id from seal into dev
  const d1 = structuredClone(devTaskFile);
  d1.tasks[0].id = seals[0].seal.ids[0];
  const p1 = h3SplitProblems({ devTaskFile: d1, seals }).join('\n');
  assert.match(p1, /holdout task id .* appears in tasks\/dev\.json/);

  // Control 2: 0 dev tasks for an applicable class
  const d2 = structuredClone(devTaskFile);
  d2.tasks = d2.tasks.filter((t: any) => t.corpus !== 'code' || t.class !== 'exact-lookup');
  const p2 = h3SplitProblems({ devTaskFile: d2, seals }).join('\n');
  assert.match(p2, /code: applicable class 'exact-lookup' has 0 dev tasks/);

  // Control 3: 0 holdout tasks in classCounts
  const s3 = structuredClone(seals);
  s3[0].seal.classCounts['exact-lookup'] = 0;
  const p3 = h3SplitProblems({ devTaskFile, seals: s3 }).join('\n');
  assert.match(p3, /code: applicable class 'exact-lookup' has 0 holdout tasks/);
});

test('G33.4 control: seal loading requires each corpus to have at least one generation seal', (t) => {
  const dir = tempDir(t, 'doflow-g33-missing-corpus-');
  const codeSeal = path.join(holdoutDir, 'code.g1.seal.json');
  fs.copyFileSync(codeSeal, path.join(dir, 'code.g1.seal.json'));
  assert.throws(
    () => h3LoadSeals(dir),
    /holdout directory must contain at least one generation for corpus guidance/
  );
});

test('G33.4 control: multiple generations of seals are all checked', (t) => {
  const snapshot = snapshotLib.loadSnapshot();
  const devFile = path.join(REPO, snapshot.taskFiles.dev.path);
  const devTaskFile = JSON.parse(fs.readFileSync(devFile, 'utf8'));

  const dir = tempDir(t, 'doflow-g33-multigen-');
  const origGuidance = JSON.parse(fs.readFileSync(path.join(holdoutDir, 'guidance.g1.seal.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'guidance.g1.seal.json'), JSON.stringify(origGuidance));

  const origCode = JSON.parse(fs.readFileSync(path.join(holdoutDir, 'code.g1.seal.json'), 'utf8'));
  const g1 = structuredClone(origCode);
  g1.generation = 1;
  g1.ids = [devTaskFile.tasks[0].id];
  fs.writeFileSync(path.join(dir, 'code.g1.seal.json'), JSON.stringify(g1));

  const g2 = structuredClone(origCode);
  g2.generation = 2;
  g2.ids = ['HC-999'];
  g2.classCounts['impact-refactor'] = 0;
  fs.writeFileSync(path.join(dir, 'code.g2.seal.json'), JSON.stringify(g2));

  const seals = h3LoadSeals(dir);
  assert.equal(seals.length, 3, 'loader must load all generations for every corpus');
  assert.equal(seals.filter((s: any) => s.corpus === 'code').length, 2, 'loader must load both g1 and g2 for code');

  const p = h3SplitProblems({ devTaskFile, seals });
  assert.ok(p.some((msg: any) => msg.includes('code.g1.seal.json: holdout task id') && msg.includes('appears in tasks/dev.json')));
  assert.ok(p.some((msg: any) => msg.includes("applicable class 'impact-refactor' has 0 holdout tasks in classCounts")));
});

test('G33.5: each seal canary appears in no tracked file other than its seal file', () => {
  const seals = h3LoadSeals();
  assert.deepEqual(h3CanaryProblems({ repoRoot: REPO, seals }), []);
});

test('G33.5 control: canary appearance in another tracked file is reported', () => {
  const seals = h3LoadSeals();
  const mockGrep = (canary: any) => [
    `bench/retrieval/holdout/code.g1.seal.json:  "canary": "${canary}",`,
    `src/runtime/leaked.ts:  const c = "${canary}";`,
  ];
  const got: any = h3CanaryProblems({ repoRoot: REPO, seals: [seals[0]], grepFn: mockGrep }).join('\n');
  assert.match(got, /canary leaked in tracked file src\/runtime\/leaked\.ts/);
});

test('G33.5 control: comparing repo paths handles path.win32-style input', () => {
  const win32SealPath = path.win32.join('bench', 'retrieval', 'holdout', 'code.g1.seal.json');
  const canary = 'mock-canary-uuid';
  const seals: any = [{
    corpus: 'code',
    generation: 1,
    seal: { canary },
    relSealPath: win32SealPath,
  }];
  const mockGrep = () => [
    `bench/retrieval/holdout/code.g1.seal.json:  "canary": "${canary}",`,
  ];
  const noProblems: any = h3CanaryProblems({ repoRoot: REPO, seals, grepFn: mockGrep });
  assert.deepEqual(noProblems, [], 'must not report false leak when seal path uses win32 backslashes');

  const mockLeak = () => [
    `bench/retrieval/holdout/code.g1.seal.json:  "canary": "${canary}",`,
    `src/runtime/leaked.ts:  const c = "${canary}";`,
  ];
  const leakProblems: any = h3CanaryProblems({ repoRoot: REPO, seals, grepFn: mockLeak });
  assert.equal(leakProblems.length, 1);
  assert.match(leakProblems[0], /canary leaked in tracked file src\/runtime\/leaked\.ts/);
});

// ---- K.2: Inventory, registry and contract checks (G33.12, G33.13, G33.15, G33.16) ----
const k2Read = (rel: any) => JSON.parse(fs.readFileSync(path.join(REPO, rel), 'utf8'));
const K2_DATE = /^\d{4}-\d{2}-\d{2}$/;
const K2_ISO_OK = (s: any) => typeof s === 'string' && K2_DATE.test(s) && !Number.isNaN(Date.parse(s));

/** A Fact is {value, source, verifiedOn} or {unverified, verifiedOn}; `{unreached}` is allowed where a field says so. */
function k2FactProblems(fact: any, where: any, { allowUnreached = false }: any = {}): any {
  const p: any = [];
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
const k2Need = (obj: any, fields: any, where: any) => fields.filter((f: any) => !Object.hasOwn(obj, f) || obj[f] === undefined).map((f: any) => `${where}.${f}: required field missing`);

function k2InventoryProblems({ capabilities, tools, coverage }: any) {
  const p: any = [];
  for (const [name, doc] of [['capabilities.json', capabilities], ['tools.json', tools], ['coverage.json', coverage]]) {
    if (!doc.refresh || !doc.refresh.trigger || !doc.refresh.owner) p.push(`${name}.refresh: trigger and owner are required`);
  }
  const hops: any = ['intent', 'provider', 'retrieval-plan', 'evidence', 'context', 'verification'];
  const states: any = ['verified', 'partial', 'missing', 'target', 'declared'];
  if (!/^[0-9a-f]{40}$/.test(capabilities.inspectedAt || '')) p.push('capabilities.json.inspectedAt: must be a commit sha');
  for (const r of capabilities.rows) {
    const w = `capabilities.json ${r.id}`;
    p.push(...k2Need(r, ['id', 'hop', 'subject', 'adapter', 'state', 'locator', 'inspectedAt', 'note'], w));
    if (!/^INV-\d{3}$/.test(r.id || '')) p.push(`${w}.id: must match INV-nnn`);
    if (!hops.includes(r.hop)) p.push(`${w}.hop: ${r.hop}`);
    if (!states.includes(r.state)) p.push(`${w}.state: ${r.state}`);
    if (!r.locator || !['path-line', 'commit', 'command'].includes(r.locator.kind) || !r.locator.ref) p.push(`${w}.locator: kind and ref are required`);
  }
  const ids: any = new Set(capabilities.rows.map((r: any) => r.id));
  if (!(capabilities.gateEvidence || []).length || capabilities.gateEvidence.some((id: any) => !ids.has(id))) p.push('capabilities.json.gateEvidence: must name existing row ids');
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

function k2StarSplitProblems(tools: any) {
  const p: any = [];
  for (const r of tools.rows) {
    const w = `tools.json ${r.id} (${r.name})`;
    if (r.list === 'main' && !(r.stars?.value > tools.starThreshold)) p.push(`${w}.stars: a main row needs more than ${tools.starThreshold} stars`);
    if (r.list === 'small' && !(r.stars?.value <= tools.starThreshold)) p.push(`${w}.stars: a small row needs ${tools.starThreshold} stars or fewer`);
    if (r.list === 'excluded' && r.name !== 'Serena') p.push(`${w}.list: only Serena may be excluded`);
    if (r.name === 'Serena' && r.list !== 'excluded') p.push(`${w}.list: Serena may appear only as excluded`);
    if (r.list === 'excluded' && r.excludedBy !== 'ADR section 1') p.push(`${w}.excludedBy: must be "ADR section 1"`);
  }
  if (!tools.rows.some((r: any) => r.name === 'Serena')) p.push('tools.json: Serena must appear as an excluded row');
  return p;
}

function k2OrchestrationProblems(registryModule: any) {
  const registry = registryModule.loadRegistry({ repoRoot: REPO });
  const p: any = [];
  const withBlock = registry.harnesses.filter((h: any) => h.orchestration !== undefined);
  if (registry.harnesses.length !== 7 || withBlock.length !== 7) p.push(`core/registry/harnesses.json: ${withBlock.length} of ${registry.harnesses.length} harnesses carry the orchestration block, 7 expected`);
  const issues = registry.validation.errors.filter((e: any) => / orchestration/.test(e));
  return p.concat(issues.map((e: any) => `core/registry/harnesses.json: ${e}`));
}

function k2ContractProblems({ operatingModes, boundary, assertNoScoreFields }: any) {
  const p: any = [];
  const headings = (text: any) => [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1].trim());
  const want27: any = ['Modes', 'Ownership', 'Task states', 'Rules', 'User controls', 'Harness primitives', 'Refresh'];
  const got27 = headings(operatingModes).filter((h) => want27.includes(h));
  if (JSON.stringify(got27) !== JSON.stringify(want27)) p.push(`docs/specs/operating-modes.md: headings ${JSON.stringify(got27)} differ from IC-027 ${JSON.stringify(want27)}`);
  const section = operatingModes.split(/^## Task states$/m)[1]?.split(/^## /m)[0] || '';
  for (const state of ['PLANNED', 'READY', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED']) {
    const row = section.split('\n').find((l: any) => l.startsWith(`| ${state} |`));
    const cells = row ? row.split('|').map((c: any) => c.trim()) : [];
    if (!row) p.push(`docs/specs/operating-modes.md: Task states has no ${state} row`);
    else if (!['implemented', 'target'].includes(cells[3])) p.push(`docs/specs/operating-modes.md: ${state} Implemented cell must be implemented or target, got ${JSON.stringify(cells[3])}`);
  }
  const want28: any = ['Candidate', 'Evidence', 'Absence', 'Examples', 'Refresh'];
  const got28 = headings(boundary).filter((h) => want28.includes(h));
  if (JSON.stringify(got28) !== JSON.stringify(want28)) p.push(`docs/specs/candidate-evidence-boundary.md: headings ${JSON.stringify(got28)} differ from IC-028`);
  const examples: any = new Map();
  for (const m of boundary.matchAll(/<!-- example: (\S+) (valid|invalid) -->\n```json\n([\s\S]*?)\n```/g)) examples.set(m[1], m[3]);
  for (const id of ['valid-1', 'invalid-score-evidence', 'invalid-provider-binding', 'invalid-stale-absence']) if (!examples.has(id)) p.push(`docs/specs/candidate-evidence-boundary.md: example ${id} is missing`);
  if (examples.has('invalid-score-evidence')) {
    let threw = false;
    try { assertNoScoreFields(JSON.parse(examples.get('invalid-score-evidence')), ''); } catch { threw = true; }
    if (!threw) p.push('docs/specs/candidate-evidence-boundary.md: assertNoScoreFields did not throw on invalid-score-evidence');
  }
  if (examples.has('valid-1')) {
    try { assertNoScoreFields(JSON.parse(examples.get('valid-1')), ''); } catch (e: any) { p.push(`docs/specs/candidate-evidence-boundary.md: valid-1 was rejected: ${e.message.slice(0, 60)}`); }
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
  t.rows.find((r: any) => r.list === 'main').stars.value = 20000;
  t.rows.find((r: any) => r.list === 'small').stars.value = 20001;
  t.rows.find((r: any) => r.list === 'stack').list = 'excluded';
  const got = k2StarSplitProblems(t).join('\n');
  assert.match(got, /stars: a main row needs more than 20000 stars/);
  assert.match(got, /stars: a small row needs 20000 stars or fewer/);
  assert.match(got, /list: only Serena may be excluded/);
});

test('G33.15: seven harnesses carry the orchestration block and loadRegistry reports no issue with it', () => {
  assert.deepEqual(k2OrchestrationProblems(require(path.join(REPO, 'src/registry/index.ts'))), []);
});
test('G33.15 control: dropping one harness block or one operation is reported with the harness name', () => {
  const registryModule = require(path.join(REPO, 'src/registry/index.ts'));
  const registry = structuredClone(registryModule.loadRegistry({ repoRoot: REPO }));
  delete registry.harnesses[1].orchestration;
  delete registry.harnesses[2].orchestration.cancel;
  const errors = registryModule.validateRegistry(registry, { repoRoot: REPO }).errors.join('\n');
  assert.match(errors, /harness 'codex': orchestration block is required/);
  assert.match(errors, /harness 'opencode': orchestration is missing operation 'cancel'/);
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

// ---- M.5: Fourth step (G33.6, G33.9, G33.10, G33.14) ----
const { enumerateHookSurfaces, computeCeilingMs } = require('../../bench/perf/runner.ts');

function m5ThresholdProblems(t: any) {
  const p: any = [];
  const wantSentence = 'Fix tolerances/cost caps in P0 benchmark configuration before viewing holdout results.';
  if (t.roadmapSentence !== wantSentence) {
    p.push('thresholds.json.roadmapSentence: differs from IC-017 verbatim sentence');
  }
  const checkStatus = (item: any, where: any) => {
    if (!item || !['proposed', 'approved'].includes(item.status)) {
      p.push(`${where}.status: required field missing or invalid`);
    } else if (item.status === 'approved' && !K2_ISO_OK(item.approvedOn)) {
      p.push(`${where}.approvedOn: required when approved`);
    }
  };
  checkStatus(t.minN, 'thresholds.json.minN');
  checkStatus(t.costCaps, 'thresholds.json.costCaps');
  checkStatus(t.rerun, 'thresholds.json.rerun');
  for (const th of t.thresholds || []) checkStatus(th, `thresholds.json ${th.id}`);
  for (const r of t.rules || []) checkStatus(r, `thresholds.json ${r.id}`);
  return p;
}

function m5BaselineProblems(b: any, { snapshot, devBytes }: any) {
  const p: any = [];
  if (b.snapshotId !== snapshot.snapshotId) {
    p.push('baseline.json.snapshotId: differs from snapshot.json');
  }
  const devSha = sha256Hex(devBytes);
  if (b.tasksSha256 !== devSha) {
    p.push('baseline.json.tasksSha256: differs from tasks/dev.json sha256');
  }
  const QUERY_CLASSES: any = [
    'exact-lookup',
    'conceptual-discovery',
    'impact-refactor',
    'stale-index',
    'dirty-tree',
    'unavailable-provider',
    'oversized-context',
    'verification-failure',
  ];
  for (const corpus of ['code', 'guidance']) {
    const cdata = b.corpora && b.corpora[corpus];
    if (!cdata) {
      p.push(`baseline.json: missing corpus ${corpus}`);
      continue;
    }
    for (const cfg of ['A', 'B']) {
      const ccfg = cdata.configs && cdata.configs[cfg];
      if (!ccfg) {
        p.push(`baseline.json: missing config ${cfg} in ${corpus}`);
        continue;
      }
      for (const cls of QUERY_CLASSES) {
        const row = ccfg.classes && ccfg.classes[cls];
        if (!row) {
          p.push(`baseline.json ${corpus} ${cfg}: missing class row for ${cls}`);
          continue;
        }
        if (row.applicable === false) {
          if (typeof row.reason !== 'string' || !row.reason) {
            p.push(`baseline.json ${corpus} ${cfg} ${cls}: missing reason`);
          }
        } else if (row.applicable === true) {
          for (const f of ['n', 'underpowered', 'state', 'metrics', 'latency', 'context']) {
            if (row[f] === undefined) {
              p.push(`baseline.json ${corpus} ${cfg} ${cls}: missing ${f}`);
            }
          }
          if (row.latency) {
            for (const f of ['runs', 'p50Ms', 'p95Ms', 'maxMs']) {
              if (row.latency[f] === undefined) {
                p.push(`baseline.json ${corpus} ${cfg} ${cls}.latency: missing ${f}`);
              }
            }
          }
          if (row.context) {
            for (const f of ['payloadBytesP50', 'payloadBytesP95', 'tokensEstP50', 'tokensBasis']) {
              if (row.context[f] === undefined) {
                p.push(`baseline.json ${corpus} ${cfg} ${cls}.context: missing ${f}`);
              }
            }
          }
        } else {
          p.push(`baseline.json ${corpus} ${cfg} ${cls}: applicable must be boolean`);
        }
      }
    }
  }
  return p;
}

function m5BudgetProblems(budgets: any, { hookSurfaces }: any) {
  const p: any = [];
  const surfaces = budgets.surfaces || [];
  const intentBudgetsMs = budgets.intentBudgetsMs || {};
  const headroom = budgets.headroom || {};
  const rowFields: any = [
    'surfaceId', 'platform', 'arch', 'machineId', 'measuredOn',
    'runs', 'warmups', 'interleave', 'seed', 'p50Ms', 'p95Ms',
    'maxMs', 'madMs', 'controlP50Ms', 'redos', 'headroomMs', 'ceilingMs', 'status',
  ];

  for (const r of budgets.rows || []) {
    const w = `budgets.json row ${r.surfaceId}`;
    if (r.unmeasured) {
      if (typeof r.unmeasured !== 'string' || !r.unmeasured) {
        p.push(`${w}: unmeasured must be non-empty string`);
      }
      continue;
    }
    for (const f of rowFields) {
      if (r[f] === undefined) p.push(`${w}.${f}: required field missing`);
    }
    if (typeof r.runs !== 'number' || r.runs < 30) {
      p.push(`${w}: fewer than 30 runs (${r.runs})`);
    }
    const surface = surfaces.find((s: any) => s.id === r.surfaceId);
    const intent = surface && surface.intentClass && surface.intentClass !== 'none'
      ? intentBudgetsMs[surface.intentClass]
      : null;
    const expectedCeiling = computeCeilingMs(r.p95Ms, headroom, intent);
    if (r.ceilingMs !== expectedCeiling) {
      p.push(`${w}: stored ceiling ${r.ceilingMs} differs from expected ${expectedCeiling}`);
    }
    if (intent != null && r.ceilingMs > intent) {
      p.push(`${w}: ceiling ${r.ceilingMs} exceeds intent budget ${intent}`);
    }
  }

  const rowIds: any = new Set((budgets.rows || []).map((r: any) => r.surfaceId));
  const firstWriteVariants = hookSurfaces.filter((surface: any) => surface.variant === 'first-write');
  if (firstWriteVariants.length !== 1 || firstWriteVariants[0].id !== 'hook.claude.pre-bash-guard.first-write') {
    p.push('hook surface enumeration: exactly hook.claude.pre-bash-guard.first-write may be a first-write variant');
  }
  for (const h of hookSurfaces) {
    if (h.budgeted === false) {
      if ((h.variant !== 'first-write' || h.id !== 'hook.claude.pre-bash-guard.first-write')
          && (h.variant !== 'test-class' || h.id !== 'hook.claude.post-shell-observe.test-class')) {
        p.push(`unapproved budgetless hook surface ${h.id}`);
      }
      continue;
    }
    if (!rowIds.has(h.id)) {
      p.push(`budgets.json: hook surface ${h.id} has neither a row nor an unmeasured row`);
    }
  }
  return p;
}

function m5ProposalProblems(proposals: any) {
  const p: any = [];
  for (const pr of proposals.proposals || []) {
    const w = `proposals.json ${pr.id}`;
    if (pr.status === 'approved') {
      if (!pr.approvedOn || !K2_ISO_OK(pr.approvedOn)) {
        p.push(`${w}.approvedOn: required valid date when approved`);
      }
      if (pr.approvedBy !== 'user') {
        p.push(`${w}.approvedBy: must be "user" when approved, got ${JSON.stringify(pr.approvedBy)}`);
      }
    } else if (pr.status !== 'proposed') {
      p.push(`${w}.status: must be proposed or approved`);
    }
  }
  return p;
}

test('G33.6: every threshold has status, approved has approvedOn, and roadmapSentence matches verbatim', () => {
  const thresholds = JSON.parse(fs.readFileSync(path.join(REPO, 'bench/retrieval/thresholds.json'), 'utf8'));
  assert.deepEqual(m5ThresholdProblems(thresholds), []);
});

test('G33.6 control: a missing status, an approved threshold missing approvedOn, and a mutated roadmapSentence are reported', () => {
  const thresholds = JSON.parse(fs.readFileSync(path.join(REPO, 'bench/retrieval/thresholds.json'), 'utf8'));
  const tMut = structuredClone(thresholds);
  delete tMut.thresholds[0].status;
  tMut.thresholds[1].status = 'approved';
  delete tMut.thresholds[1].approvedOn;
  tMut.roadmapSentence = 'Different sentence.';
  const tGot = m5ThresholdProblems(tMut).join('\n');
  assert.match(tGot, /T-001\.status: required field missing/);
  assert.match(tGot, /T-002\.approvedOn: required when approved/);
  assert.match(tGot, /roadmapSentence: differs from IC-017/);
});

test('G33.9: baseline snapshotId and tasksSha256 match, every configuration has a row per class, and IC-015 fields are present', () => {
  const baseline = JSON.parse(fs.readFileSync(path.join(REPO, 'bench/retrieval/baseline.json'), 'utf8'));
  const snapshot = snapshotLib.loadSnapshot();
  const devFile = path.join(REPO, snapshot.taskFiles.dev.path);
  const devBytes = fs.readFileSync(devFile);
  assert.deepEqual(m5BaselineProblems(baseline, { snapshot, devBytes }), []);
});

function g33EnumerateHookSurfaces(opts: any = {}) {
  return enumerateHookSurfaces({ repoRoot: REPO, isToolInstalledFn: () => true, ...opts });
}

test('G33.10: budget rows carry required fields, at least 30 runs, ceilingMs matches formula, does not exceed intent, and all hook surfaces covered', () => {
  const budgets = JSON.parse(fs.readFileSync(path.join(REPO, 'bench/perf/budgets.json'), 'utf8'));
  const { surfaces: hookSurfaces } = g33EnumerateHookSurfaces();
  assert.deepEqual(hookSurfaces.filter((surface: any) => surface.budgeted === false).map((surface: any) => surface.id), [
    // Plan E.4: UNREACHED until approved by user (budget row awaits user decision)
    'hook.claude.post-shell-observe.test-class',
    'hook.claude.pre-bash-guard.first-write',
  ]);
  assert.deepEqual(m5BudgetProblems(budgets, { hookSurfaces }), []);
});

test('G33.10 control: hook surface enumeration does not depend on PATH and is identical with empty PATH', () => {
  const normal = g33EnumerateHookSurfaces();
  const origPath = process.env.PATH;
  process.env.PATH = '';
  try {
    const withEmptyPath = g33EnumerateHookSurfaces();
    assert.deepEqual(withEmptyPath, normal, 'enumeration with empty PATH must be identical');
  } finally {
    process.env.PATH = origPath;
  }
});

test('G33.10 control: an unapproved budgetless hook variant is reported', () => {
  const budgets = JSON.parse(fs.readFileSync(path.join(REPO, 'bench/perf/budgets.json'), 'utf8'));
  const { surfaces } = g33EnumerateHookSurfaces();
  const firstWrite = surfaces.find((surface: any) => surface.id === 'hook.claude.pre-bash-guard.first-write');
  const hookSurfaces: any = [...surfaces, { ...firstWrite, id: 'hook.codex.pre-bash-guard.first-write' }];
  const problems = m5BudgetProblems(budgets, { hookSurfaces }).join('\n');
  assert.match(problems, /unapproved budgetless hook surface hook\.codex\.pre-bash-guard\.first-write/);
});

test('G33.14: no proposal is approved without approvedOn and approvedBy: "user"', () => {
  const proposals = JSON.parse(fs.readFileSync(path.join(REPO, 'bench/inventory/proposals.json'), 'utf8'));
  assert.deepEqual(m5ProposalProblems(proposals), []);
});

test('G33.14 control: approved proposal missing approvedOn, missing approvedBy or with approvedBy !== "user" is reported', () => {
  const proposals = JSON.parse(fs.readFileSync(path.join(REPO, 'bench/inventory/proposals.json'), 'utf8'));
  const pMut = structuredClone(proposals);
  pMut.proposals[0].status = 'approved';
  delete pMut.proposals[0].approvedOn;
  delete pMut.proposals[0].approvedBy;
  pMut.proposals[1].status = 'approved';
  pMut.proposals[1].approvedOn = '2026-10-13';
  pMut.proposals[1].approvedBy = 'worker';
  const pGot = m5ProposalProblems(pMut).join('\n');
  assert.match(pGot, /S8-01\.approvedOn: required valid date when approved/);
  assert.match(pGot, /S8-01\.approvedBy: must be "user"/);
  assert.match(pGot, /S8-02\.approvedBy: must be "user"/);
});

// ---- O.2: Fifth step (G33.7, G33.8, G33.11) ----
const FORBIDDEN_RESULT_KEYS: any = new Set(['perTask', 'query', 'qrels', 'tasks']);

function getFirstAddCommit(repoRoot: any, relPath: any) {
  const posixPath = toPosixPath(relPath);
  const run = spawnSync('git', ['-C', repoRoot, 'log', '--diff-filter=A', '--format=%H', '--', posixPath], {
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    throw new Error(`git log failed for ${posixPath}: ${run.stderr}`);
  }
  const lines = run.stdout.trim().split('\n').filter(Boolean);
  if (lines.length === 0) return null;
  return lines[lines.length - 1];
}

function areAllThresholdsApproved(doc: any) {
  if (!doc || typeof doc !== 'object') return false;
  if (doc.minN?.status !== 'approved') return false;
  if (doc.costCaps?.status !== 'approved') return false;
  if (doc.rerun?.status !== 'approved') return false;
  if (!Array.isArray(doc.thresholds) || doc.thresholds.length === 0 || !doc.thresholds.every((t: any) => t.status === 'approved')) return false;
  if (!Array.isArray(doc.rules) || doc.rules.length === 0 || !doc.rules.every((r: any) => r.status === 'approved')) return false;
  return true;
}

function getFirstApprovedCommit(repoRoot: any, relPath: any) {
  const posixPath = toPosixPath(relPath);
  const run = spawnSync('git', ['-C', repoRoot, 'log', '--reverse', '--format=%H', '--', posixPath], {
    encoding: 'utf8',
  });
  if (run.status !== 0) {
    throw new Error(`git log failed for ${posixPath}: ${run.stderr}`);
  }
  const commits = run.stdout.trim().split('\n').filter(Boolean);
  for (const commit of commits) {
    const show = spawnSync('git', ['-C', repoRoot, 'show', `${commit}:${posixPath}`], {
      encoding: 'utf8',
    });
    if (show.status === 0) {
      try {
        const doc = JSON.parse(show.stdout);
        if (areAllThresholdsApproved(doc)) {
          return commit;
        }
      } catch {
        // ignore parse errors in older commits
      }
    }
  }
  return null;
}

function isAncestor(repoRoot: any, ancestorCommit: any, descendantCommit: any) {
  const run = spawnSync('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestorCommit, descendantCommit]);
  return run.status === 0;
}

function o2OrderProblems({ repoRoot }: any) {
  const p: any = [];
  const thresholdsRel = 'bench/retrieval/thresholds.json';
  const thresholdsCommit = getFirstAddCommit(repoRoot, thresholdsRel);
  if (!thresholdsCommit) {
    p.push(`${thresholdsRel}: no first-add commit found in git log`);
    return p;
  }

  const resultsDir = path.join(repoRoot, 'bench/retrieval/results');
  if (!fs.existsSync(resultsDir)) {
    p.push('bench/retrieval/results: directory does not exist');
    return p;
  }
  const files = fs.readdirSync(resultsDir)
    .filter((f: any) => /^holdout-.*\.json$/.test(f))
    .sort();
  if (files.length === 0) {
    p.push('bench/retrieval/results: no holdout-*.json files found');
    return p;
  }

  const approvedCommit = getFirstApprovedCommit(repoRoot, thresholdsRel);
  if (!approvedCommit) {
    p.push(`${thresholdsRel}: no commit found where every entry is approved`);
  }

  for (const f of files) {
    const relFile = toPosixPath(path.join('bench/retrieval/results', f));
    const holdoutCommit = getFirstAddCommit(repoRoot, relFile);
    if (!holdoutCommit) {
      p.push(`${relFile}: no first-add commit found in git log`);
      continue;
    }
    if (!isAncestor(repoRoot, thresholdsCommit, holdoutCommit)) {
      p.push(`${relFile}: first-add commit ${holdoutCommit} is not descended from thresholds.json first-add commit ${thresholdsCommit}`);
    }
    if (approvedCommit && !isAncestor(repoRoot, approvedCommit, holdoutCommit)) {
      p.push(`${relFile}: first-add commit ${holdoutCommit} is not descended from thresholds.json first-approval commit ${approvedCommit}`);
    }
  }
  return p;
}

function o2ForbiddenKeysInObject(obj: any, prefix: any = ''): any {
  const found: any = [];
  if (!obj || typeof obj !== 'object') return found;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      found.push(...o2ForbiddenKeysInObject(obj[i], `${prefix}[${i}]`));
    }
  } else {
    for (const [key, val] of Object.entries(obj)) {
      const loc = prefix ? `${prefix}.${key}` : key;
      if (FORBIDDEN_RESULT_KEYS.has(key)) {
        found.push(loc);
      }
      found.push(...o2ForbiddenKeysInObject(val, loc));
    }
  }
  return found;
}

function o2ResultsShapeProblems({ repoRoot }: any) {
  const p: any = [];
  const resultsDir = path.join(repoRoot, 'bench/retrieval/results');
  if (!fs.existsSync(resultsDir)) {
    p.push('bench/retrieval/results: directory does not exist');
    return p;
  }
  const files = fs.readdirSync(resultsDir)
    .filter((f: any) => /^holdout-.*\.json$/.test(f))
    .sort();
  if (files.length === 0) {
    p.push('bench/retrieval/results: no holdout-*.json files found');
    return p;
  }
  for (const f of files) {
    const relFile = path.join('bench/retrieval/results', f);
    const fullPath = path.join(resultsDir, f);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    } catch (e: any) {
      p.push(`${relFile}: invalid JSON: ${e.message}`);
      continue;
    }
    const forbidden = o2ForbiddenKeysInObject(parsed);
    for (const keyPath of forbidden) {
      p.push(`${relFile}: carries forbidden key '${keyPath}'`);
    }
  }
  return p;
}

function o2PerfTestProblems(content: any) {
  const p: any = [];
  if (!content.includes('bench/perf/budgets.json')) {
    p.push('performance-budget.test.ts: does not name bench/perf/budgets.json');
  }
  if (/ms\s*<=\s*\d{3}/.test(content)) {
    p.push('performance-budget.test.ts: matches forbidden literal pattern /ms\\s*<=\\s*\\d{3}/');
  }
  return p;
}

test('G33.7: the first-add commit of thresholds.json is an ancestor of the first-add commit of every holdout-*.json', () => {
  assert.deepEqual(o2OrderProblems({ repoRoot: REPO }), []);
});

test('G33.7 control: non-ancestor thresholds first-add commit is reported', (t) => {
  const dir = tempDir(t, 'doflow-g33-order-');
  const git = (...args: any[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');

  // Commit 1: add holdout result first
  const resultsDir = path.join(dir, 'bench/retrieval/results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'holdout-1-g1-code-A.json'), JSON.stringify({ schemaVersion: 1 }));
  git('add', '-A');
  git('commit', '-q', '-m', 'add holdout results');

  // Commit 2: add thresholds.json after holdout results
  const retDir = path.join(dir, 'bench/retrieval');
  fs.mkdirSync(retDir, { recursive: true });
  fs.writeFileSync(path.join(retDir, 'thresholds.json'), JSON.stringify({ schemaVersion: 1 }));
  git('add', '-A');
  git('commit', '-q', '-m', 'add thresholds');

  const problems = o2OrderProblems({ repoRoot: dir });
  assert.ok(problems.length > 0, 'must report order problem when thresholds is committed after holdout');
  assert.match(problems.join('\n'), /thresholds\.json first-add commit/);
});

test('G33.7 control: non-ancestor thresholds first-approval commit is reported', (t) => {
  const dir = tempDir(t, 'doflow-g33-approval-order-');
  const git = (...args: any[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');

  const sampleThresholds = (status: any) => ({
    schemaVersion: 1,
    minN: { ranking: 10, outcome: 3, status },
    costCaps: { status },
    rerun: { status },
    thresholds: [{ id: 'T-001', status }],
    rules: [{ id: 'RULE-001', status }],
  });

  // Commit 1: add thresholds.json with status: "proposed"
  const retDir = path.join(dir, 'bench/retrieval');
  fs.mkdirSync(retDir, { recursive: true });
  fs.writeFileSync(path.join(retDir, 'thresholds.json'), JSON.stringify(sampleThresholds('proposed')));
  git('add', '-A');
  git('commit', '-q', '-m', 'add proposed thresholds');

  // Commit 2: add holdout result before approval
  const resultsDir = path.join(dir, 'bench/retrieval/results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'holdout-1-g1-code-A.json'), JSON.stringify({ schemaVersion: 1 }));
  git('add', '-A');
  git('commit', '-q', '-m', 'add holdout results');

  // Commit 3: approve thresholds after holdout
  fs.writeFileSync(path.join(retDir, 'thresholds.json'), JSON.stringify(sampleThresholds('approved')));
  git('add', '-A');
  git('commit', '-q', '-m', 'approve thresholds');

  const problems = o2OrderProblems({ repoRoot: dir });
  assert.ok(problems.length > 0, 'must report order problem when thresholds is approved after holdout');
  assert.match(problems.join('\n'), /thresholds\.json first-approval commit/);
});

test('G33.7 control: comparing repo paths handles path.win32-style input', () => {
  const win32Rel = path.win32.join('bench', 'retrieval', 'thresholds.json');
  const commit = getFirstAddCommit(REPO, win32Rel);
  assert.ok(commit && /^[0-9a-f]{40}$/.test(commit), 'must resolve commit with win32 pathspec');
  const approvedCommit = getFirstApprovedCommit(REPO, win32Rel);
  assert.ok(approvedCommit && /^[0-9a-f]{40}$/.test(approvedCommit), 'must resolve approved commit with win32 pathspec');
});

test('G33.8: no holdout results file carries perTask, query, qrels or tasks', () => {
  assert.deepEqual(o2ResultsShapeProblems({ repoRoot: REPO }), []);
});

test('G33.8 control: holdout results file carrying forbidden keys is reported', (t) => {
  const dir = tempDir(t, 'doflow-g33-shape-');
  const git = (...args: any[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '-q');

  const resultsDir = path.join(dir, 'bench/retrieval/results');
  fs.mkdirSync(resultsDir, { recursive: true });
  fs.writeFileSync(path.join(resultsDir, 'holdout-1-g1-code-A.json'), JSON.stringify({
    schemaVersion: 1,
    perTask: [{ id: 't1' }],
    nested: { query: 'test', qrels: [], tasks: [] },
  }));
  const problems = o2ResultsShapeProblems({ repoRoot: dir });
  const joined = problems.join('\n');
  assert.match(joined, /forbidden key 'perTask'/);
  assert.match(joined, /forbidden key 'nested\.query'/);
  assert.match(joined, /forbidden key 'nested\.qrels'/);
  assert.match(joined, /forbidden key 'nested\.tasks'/);
});

test('G33.11: performance-budget.test.ts names bench/perf/budgets.json and matches no /ms\\s*<=\\s*\\d{3}/', () => {
  const content = fs.readFileSync(path.join(REPO, 'test/runtime/performance-budget.test.ts'), 'utf8');
  assert.deepEqual(o2PerfTestProblems(content), []);
});

test('G33.11 control: missing budgets path and matching forbidden literal pattern are reported', () => {
  const badContent1 = 'const x = 1;';
  const p1 = o2PerfTestProblems(badContent1);
  assert.match(p1.join('\n'), /does not name bench\/perf\/budgets\.json/);

  const badContent2 = "require('bench/perf/budgets.json'); assert.ok(ms <= 100);";
  const p2 = o2PerfTestProblems(badContent2);
  assert.match(p2.join('\n'), /matches forbidden literal pattern/);
});

// ---- Q.1: Final step (G33.17, G33.18) ----
const GATE_SENTENCES: any = [
  'Benchmarks rerun against the same snapshot.',
  'Registry slots alone do not establish operational hybrid support.',
  'Tool replacement requires comparative evidence.',
];

const REFRESH_DELIVERABLES: any = [
  'bench/retrieval/snapshot.json',
  'bench/retrieval/thresholds.json',
  'bench/perf/budgets.json',
  'bench/inventory/capabilities.json',
  'bench/inventory/tools.json',
  'bench/inventory/coverage.json',
  'bench/inventory/proposals.json',
];

const DELIVERABLES_IN_IC030: any = [
  'bench/retrieval/snapshot.json',
  'bench/retrieval/manifest.json',
  'bench/retrieval/tasks/dev.json',
  'bench/retrieval/thresholds.json',
  'bench/retrieval/baseline.json',
  'bench/retrieval/README.md',
  'bench/perf/budgets.json',
  'bench/inventory/capabilities.json',
  'bench/inventory/tools.json',
  'bench/inventory/coverage.json',
  'bench/inventory/proposals.json',
  'docs/specs/operating-modes.md',
  'docs/specs/candidate-evidence-boundary.md',
  'test/runtime/performance-budget.test.ts',
];

function q1GateRecordProblems(readmeContent: any, thresholdsDoc: any) {
  const p: any = [];
  for (const sentence of GATE_SENTENCES) {
    if (!readmeContent.includes(sentence)) {
      p.push(`bench/retrieval/README.md: missing gate sentence verbatim: "${sentence}"`);
    }
  }
  const roadmapSentence = thresholdsDoc?.roadmapSentence || 'Fix tolerances/cost caps in P0 benchmark configuration before viewing holdout results.';
  if (!readmeContent.includes(roadmapSentence)) {
    p.push(`bench/retrieval/README.md: missing roadmap sentence verbatim: "${roadmapSentence}"`);
  }
  return p;
}

function q1RefreshProblems({ repoRoot = REPO, refreshDocs = null, deliverablePaths = DELIVERABLES_IN_IC030 }: any = {}) {
  const p: any = [];

  for (const relPath of deliverablePaths) {
    if (relPath.startsWith('agent-docs/doflow/') || relPath.includes('/agent-docs/doflow/')) {
      p.push(`${relPath}: deliverable path must not lie under agent-docs/doflow/`);
    }
  }

  if (refreshDocs) {
    for (const [name, doc] of Object.entries(refreshDocs)) {
      if (!doc || !doc.refresh || typeof doc.refresh.trigger !== 'string' || !doc.refresh.trigger) {
        p.push(`${name}.refresh: trigger is required`);
      }
      if (!doc || !doc.refresh || typeof doc.refresh.owner !== 'string' || !doc.refresh.owner) {
        p.push(`${name}.refresh: owner is required`);
      }
    }
  } else {
    for (const relPath of REFRESH_DELIVERABLES) {
      const fullPath = path.join(repoRoot, relPath);
      if (!fs.existsSync(fullPath)) {
        p.push(`${relPath}: deliverable does not exist`);
        continue;
      }
      try {
        const doc = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        if (!doc.refresh || typeof doc.refresh.trigger !== 'string' || !doc.refresh.trigger) {
          p.push(`${relPath}.refresh: trigger is required`);
        }
        if (!doc.refresh || typeof doc.refresh.owner !== 'string' || !doc.refresh.owner) {
          p.push(`${relPath}.refresh: owner is required`);
        }
      } catch (e: any) {
        p.push(`${relPath}: invalid JSON: ${e.message}`);
      }
    }
  }

  return p;
}

test('G33.17: the three gate sentences and the roadmap sentence appear verbatim in bench/retrieval/README.md', () => {
  const readmeContent = fs.readFileSync(path.join(REPO, 'bench/retrieval/README.md'), 'utf8');
  const thresholdsDoc = JSON.parse(fs.readFileSync(path.join(REPO, 'bench/retrieval/thresholds.json'), 'utf8'));
  assert.deepEqual(q1GateRecordProblems(readmeContent, thresholdsDoc), []);
});

test('G33.17 control: missing gate sentence and missing roadmap sentence are reported', () => {
  const thresholdsDoc: any = { roadmapSentence: 'Roadmap sentence must appear.' };
  const incompleteReadme = '# Benchmark\n\nSome text without the required sentences.';
  const problems = q1GateRecordProblems(incompleteReadme, thresholdsDoc);
  const joined = problems.join('\n');
  assert.match(joined, /missing gate sentence verbatim: "Benchmarks rerun against the same snapshot\."/);
  assert.match(joined, /missing gate sentence verbatim: "Registry slots alone do not establish operational hybrid support\."/);
  assert.match(joined, /missing gate sentence verbatim: "Tool replacement requires comparative evidence\."/);
  assert.match(joined, /missing roadmap sentence verbatim: "Roadmap sentence must appear\."/);
});

test('G33.18: every deliverable listed in IC-030 carries top-level refresh.trigger and refresh.owner, and no deliverable path lies under agent-docs/doflow/', () => {
  assert.deepEqual(q1RefreshProblems({ repoRoot: REPO }), []);
});

test('G33.18 control: missing refresh trigger, missing refresh owner, and deliverable under agent-docs/doflow/ are reported', () => {
  const c1: any = q1RefreshProblems({
    refreshDocs: {
      'snapshot.json': { refresh: { owner: 'maintainer' } },
      'thresholds.json': { refresh: { trigger: 'trigger text' } },
    },
  } as any);
  const joined1 = c1.join('\n');
  assert.match(joined1, /snapshot\.json\.refresh: trigger is required/);
  assert.match(joined1, /thresholds\.json\.refresh: owner is required/);

  const c2: any = q1RefreshProblems({
    deliverablePaths: [
      'bench/retrieval/snapshot.json',
      'agent-docs/doflow/074-p0-baseline-contracts/baseline.json',
    ],
    refreshDocs: {},
  } as any);
  const joined2 = c2.join('\n');
  assert.match(joined2, /agent-docs\/doflow\/074-p0-baseline-contracts\/baseline\.json: deliverable path must not lie under agent-docs\/doflow\//);
});

