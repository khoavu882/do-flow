'use strict';

// Feature 171 T3 (D4, D5, IC-002, IC-003, S5): a worker descriptor's `structuredOutput` may carry an inline
// `fieldMap`, and every reader resolves the run's parser through `parserOf` / `parserIdOf`. A package worker that
// carries only a field map is catalogued and its supervised run is parsed by the compiled map. The supervised run
// uses the fake harness CLI linked into a scratch bin/ as the package program; no real harness is started (NFR-002).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createScratch, childEnv } = require('../helper/scratch-env.ts');
const { linkBin, writeScenario } = require('../helper/fake-harness-cli.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadRegistry, validateWorker } = require('../../src/registry/index.ts');
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');
const { readLock, writeLock, lockPackages } = require('../../src/state/lockfile.ts');
const { POINT_VALIDATORS } = require('../../src/runtime/packages/points.ts');
const { workerCatalogue } = require('../../src/runtime/worker/catalogue.ts');
const { PARSERS, parserOf, parserIdOf, UNPARSED } = require('../../src/runtime/worker/parsers.ts');
const { launchEnv, launchRecord } = require('../../src/runtime/worker/launch.ts');
const { storeFileFor, newRunId, insertRun } = require('../../src/runtime/worker/run-store.ts');
const { superviseRun, resultOfRun } = require('../../src/runtime/worker/supervisor.ts');
const attempts = require('../../src/runtime/task-attempts.ts');
const { runKeyFor } = require('../../src/runtime/task-run.ts');

const AT = '2026-11-16T09:00:00Z';
const NO_TMP = '/nonexistent-doflow-tmp';
const BINARY = 'fake-mycli';
const SLUG = 'feat-fm';
const POSIX: any = { skip: process.platform === 'win32' && 'worker process control is unverified on win32 (DEC-008)' };

/** A valid `jsonl-field-map-v1` map: a `message` event carries the final text, a `done` event ends the turn. */
function fieldMap(id = 'mycli-stream-v1'): any {
  return {
    id,
    format: 'jsonl-field-map-v1',
    eventType: ['type'],
    missingTerminal: 'no-done',
    rules: [
      { when: [{ path: ['type'], equals: 'message' }, { path: ['text'], is: 'string' }], then: { final: ['text'] } },
      { when: [{ path: ['type'], equals: 'done' }], then: { terminal: { outcome: 'completed' }, usage: { tokens: { sum: [['tokens']], require: 'any' } } } },
    ],
  };
}

function entry(status: string, extra: any = {}) {
  const base: any = { status, evidence: status === 'unknown' ? [] : ['test'], verification: 'Check fake-mycli', verifiedOn: '2026-11-16' };
  if (status === 'unknown') base.reason = 'test';
  return { ...base, ...extra };
}

/** A package worker whose `structuredOutput` carries only a field map (D5). */
function mapWorker(map: any = fieldMap()): any {
  return {
    profile: null,
    billing: 'unknown',
    cli: entry('supported', { binary: BINARY, versionArgv: ['--version'] }),
    oneShot: entry('supported', { argv: ['run', '{prompt}'], promptVia: 'argv' }),
    structuredOutput: entry('supported', { argv: [], fieldMap: map }),
    readOnly: entry('supported', { argv: ['--read-only'] }),
    spawnDenial: entry('supported', { argv: ['--no-spawn'] }),
    runnableProbe: entry('unknown'),
    hooksProbe: entry('unknown'),
    guidanceProbe: entry('unknown'),
    loginProbe: entry('unknown'),
    persistentSession: entry('unknown'),
    resume: entry('unknown'),
    controlChannel: entry('unknown'),
    modelChecks: [],
  };
}

/** Writes package `acme` with one worker `mycli` and plans its add; returns the plan result unasserted. */
function planWith(scratch: any, worker: any) {
  const dir = path.join(scratch.dir, 'pkg-src');
  fs.mkdirSync(path.join(dir, 'workers'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify({
    manifest: 1, id: 'acme', version: '1.0.0', summary: 'A field-map worker package', doflow: '>=2.0.0-beta.1 <3.0.0',
    programs: [{ id: 'mycli', binary: BINARY, argv: 'worker-recipe' }],
    contributions: [{ point: 'worker', version: 1, id: 'mycli', file: 'workers/mycli.json', programs: ['mycli'] }],
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'workers', 'mycli.json'), JSON.stringify(worker, null, 2));
  return planPackage({ action: 'add', source: dir, homeDir: scratch.home, repoRoot: REPO_ROOT, now: Date.parse(AT) });
}

/** Writes, adds, enables and trusts package `acme` with one worker `mycli`; returns the active catalogue. */
function catalogueWith(scratch: any, worker: any) {
  const planned = planWith(scratch, worker);
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: scratch.home, repoRoot: REPO_ROOT, env: scratch.env() });
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));
  const lockOpts = { scope: 'global', homeDir: scratch.home };
  const lock = readLock(lockOpts);
  writeLock(lockOpts, { ...lock, packages: lockPackages(lock).map((r: any) => (r.id === 'acme' ? { ...r, enabled: true } : r)) });
  const grantsFile = path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl');
  fs.mkdirSync(path.dirname(grantsFile), { recursive: true });
  fs.appendFileSync(grantsFile, `${planned.plan.grantLines.trust}\n`);
  resetPackageView();
  const view = packageView({ repoRoot: REPO_ROOT, homeDir: scratch.home, env: scratch.env(), tmpDir: NO_TMP });
  assert.equal(view.packages.find((p: any) => p.id === 'acme')?.state, 'active');
  return workerCatalogue({ view, repoRoot: REPO_ROOT });
}

/** A project with plan.md, an active subagent attempt on A.1 whose worktree is a git repository, and a child env
 * whose PATH is a scratch bin/ holding the fake CLI as the package program, git, and node. */
function project(scratch: any, scenario: any) {
  const dir = path.join(scratch.dir, 'project');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  const planFile = path.join(dir, 'agent-docs', 'doflow', SLUG, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, ['# Plan', '', '**Task graph:** v1', '', '## Tasks', '', '### Phase A', '',
    '- [ ] A.1 first task; owner: core-implementer; files: a.js', ''].join('\n'));
  const execWorktree = path.join(scratch.dir, 'worktree');
  fs.mkdirSync(execWorktree);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: execWorktree, env: scratch.env(), stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(execWorktree, 'README.md'), 'readme\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'init');
  fs.mkdirSync(path.join(execWorktree, '.doflow', 'state'), { recursive: true });
  fs.writeFileSync(path.join(execWorktree, '.doflow', 'state', '.gitignore'), '*\n');

  const bin = path.join(scratch.dir, 'bin');
  const childPath = linkBin(bin, [BINARY]);
  const gitPath = (process.env.PATH || '').split(path.delimiter).map((d) => path.join(d, 'git'))
    .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } });
  fs.symlinkSync(gitPath, path.join(bin, 'git'));
  const env = childEnv(scratch, {
    PATH: childPath, FAKE_HARNESS_SCENARIO: writeScenario(scratch.dir, scenario),
    DOFLOW_RUN_ID: 'r1', DOFLOW_LINEAGE_ID: 'main', DOFLOW_SESSION_ROLE: 'main', DOFLOW_ROLE: 'main', DOFLOW_WORKTREE: dir,
    DOFLOW_ATTEMPT: null,
  });
  const key = runKeyFor(env, dir);
  const common: any = { file: attempts.storeFile(dir, SLUG), fsImpl: fs, roots: [dir], slug: SLUG, env, cwd: dir };
  assert.equal(attempts.start({ ...common, by: 'main' }).disposition, 'started');
  const claimed = attempts.claim({ ...common, task: 'A.1', owner: 'core-implementer', mode: 'subagent', epoch: 1, execWorktree });
  assert.equal(claimed.disposition, 'claimed');
  const store = storeFileFor(dir, SLUG);

  /** Inserts a `starting` run of `descriptor` the way the run command does, and supervises it in process. */
  const run = async (harness: string, descriptor: any, prompt = 'do the task') => {
    const runId = newRunId();
    const { identity } = launchEnv({ env, runKey: key.runKey, token: claimed.token, execWorktree, runId });
    const promptFile = path.join(dir, `prompt-${runId}.md`);
    fs.writeFileSync(promptFile, prompt);
    const record: any = {
      runId, task: 'A.1', token: claimed.token, harness, phase: 'starting', execWorktree,
      createdAt: new Date().toISOString(), timeoutSeconds: 60,
      caller: { cwd: dir, runKey: key.runKey, run: key.identity.run, lineage: key.identity.lineage, attempt: null, role: 'main', lineageKind: key.identity.lineageKind },
      ...launchRecord(descriptor, identity, prompt),
      descriptor,
      prompt: { path: promptFile, sha256: crypto.createHash('sha256').update(prompt).digest('hex'), bytes: Buffer.byteLength(prompt) },
      needs: [],
    };
    assert.equal(insertRun(store, record).applied, true);
    return superviseRun({ file: store, runId, env, cwd: dir });
  };
  return { run };
}

test('a package worker whose structuredOutput carries only a fieldMap is catalogued, and a supervised run on a fake binary reports success from its stream', POSIX, async (t: any) => {
  const scratch = createScratch('doflow-fieldmap-');
  t.after(() => scratch.remove());
  const catalogue = catalogueWith(scratch, mapWorker());
  const found = catalogue.find((e: any) => e.id === 'acme.mycli');
  assert.ok(found, 'acme.mycli is catalogued');
  assert.equal(found.origin, 'package');
  assert.equal(parserIdOf(found.worker.structuredOutput), 'mycli-stream-v1');

  const p = project(scratch, { run: [{ emit: [{ type: 'message', text: 'done by the map' }, { type: 'noise' }, { type: 'done', tokens: 7 }] }] });
  const run = await p.run('acme.mycli', found.worker);
  assert.equal(run.phase, 'ended');
  assert.equal(run.recipe.parser, 'mycli-stream-v1', 'the launch record names the map id');
  assert.equal(run.report.parser, 'mycli-stream-v1');
  assert.equal(run.report.status, 'success');
  assert.equal(run.report.summary, 'done by the map');
  assert.deepEqual(run.report.usage, { tokens: 7 });
  assert.equal(run.report.ignoredLines, 1);
  assert.deepEqual(resultOfRun(run), { resultOffered: true, withheld: [] });
});

test('a map with `expr` is refused', (t: any) => {
  const map = fieldMap();
  map.rules[0].then.expr = '$.text';
  const errors: string[] = [];
  validateWorker(mapWorker(map), "package 'acme' worker 'mycli'", errors);
  assert.deepEqual(errors, ["package 'acme' worker 'mycli' worker 'structuredOutput': fieldMap.rules[0].then: unknown key 'expr'"]);
  assert.ok(POINT_VALIDATORS['worker-v1']('mycli', mapWorker(map), { packageId: 'acme' }).some((e: string) => e.includes("unknown key 'expr'")));

  const scratch = createScratch('doflow-fieldmap-');
  t.after(() => scratch.remove());
  // The install's point validator refuses it (above); the catalogue refuses it too when the stored file changes later.
  const catalogue = catalogueWith(scratch, mapWorker());
  assert.ok(catalogue.some((e: any) => e.id === 'acme.mycli'));
  const stored = catalogue.find((e: any) => e.id === 'acme.mycli').worker.storeEntry;
  fs.writeFileSync(path.join(stored, 'workers', 'mycli.json'), JSON.stringify(mapWorker(map)));
  resetPackageView();
  const view = packageView({ repoRoot: REPO_ROOT, homeDir: scratch.home, env: scratch.env(), tmpDir: NO_TMP });
  assert.equal(workerCatalogue({ view, repoRoot: REPO_ROOT }).some((e: any) => e.id === 'acme.mycli'), false);
});

test('a map id equal to codex-exec-json-v1 is refused', (t: any) => {
  assert.ok(Object.hasOwn(PARSERS, 'codex-exec-json-v1'));
  const worker = mapWorker(fieldMap('codex-exec-json-v1'));
  const errors: string[] = [];
  validateWorker(worker, "package 'acme' worker 'mycli'", errors);
  assert.deepEqual(errors, [], 'validateWorker cannot tell a package from a built-in (S5 lives in the catalogue)');
  const scratch = createScratch('doflow-fieldmap-');
  t.after(() => scratch.remove());
  // The point validator cannot see a built-in, but a package install can: S5 refuses the core-id map at plan time.
  assert.ok(POINT_VALIDATORS['worker-v1']('mycli', worker, { packageId: 'acme' }).some((e: string) => e.includes("fieldMap.id 'codex-exec-json-v1' is a core parser id")));
  const refused = planWith(scratch, worker);
  assert.equal(refused.ok, false, 'the install of a package map named for a core parser is refused');
  assert.ok(refused.findings.some((f: any) => f.code === 'contribution-invalid' && f.message.includes("fieldMap.id 'codex-exec-json-v1' is a core parser id")), JSON.stringify(refused.findings));

  // Defence in depth: the catalogue refuses it too when the stored file changes after a valid install.
  const scratch2 = createScratch('doflow-fieldmap-');
  t.after(() => scratch2.remove());
  const first = catalogueWith(scratch2, mapWorker());
  assert.ok(first.some((e: any) => e.id === 'acme.mycli'));
  const stored = first.find((e: any) => e.id === 'acme.mycli').worker.storeEntry;
  fs.writeFileSync(path.join(stored, 'workers', 'mycli.json'), JSON.stringify(worker));
  resetPackageView();
  const view = packageView({ repoRoot: REPO_ROOT, homeDir: scratch2.home, env: scratch2.env(), tmpDir: NO_TMP });
  const catalogue = workerCatalogue({ view, repoRoot: REPO_ROOT });
  assert.equal(catalogue.some((e: any) => e.id === 'acme.mycli'), false, 'a package map can never shadow a core parser');
  assert.ok(catalogue.some((e: any) => e.id === 'codex'), 'the built-ins stay');
});

test('a built-in whose parser differs from fieldMap.id is refused', () => {
  const codex = loadRegistry({ repoRoot: REPO_ROOT }).harnesses.find((h: any) => h.id === 'codex');
  const worker = JSON.parse(JSON.stringify(codex.worker));
  worker.structuredOutput.fieldMap = fieldMap('other-stream-v1');
  const errors: string[] = [];
  validateWorker(worker, "harness 'codex'", errors);
  assert.deepEqual(errors, ["harness 'codex' worker 'structuredOutput': structuredOutput.parser must equal fieldMap.id"]);

  // Control: equal ids are accepted, and a structuredOutput with neither parser nor fieldMap is refused.
  worker.structuredOutput.fieldMap = fieldMap(worker.structuredOutput.parser);
  const equal: string[] = [];
  validateWorker(worker, "harness 'codex'", equal);
  assert.deepEqual(equal, []);
  delete worker.structuredOutput.fieldMap;
  delete worker.structuredOutput.parser;
  const neither: string[] = [];
  validateWorker(worker, "harness 'codex'", neither);
  assert.deepEqual(neither, ["harness 'codex' worker 'structuredOutput': requires recipe field 'parser' or 'fieldMap' when status is supported"]);
});

test('IC-003: parserIdOf prefers the map id; parserOf checks PARSERS first, then the descriptor map, else unparsed', () => {
  assert.equal(parserIdOf(undefined), null);
  assert.equal(parserIdOf({ parser: 'doflow-jsonl-v1' }), 'doflow-jsonl-v1');
  assert.equal(parserIdOf({ parser: 'x-v1', fieldMap: { id: 'y-v1' } }), 'y-v1');

  assert.equal(parserOf({ structuredOutput: { parser: 'doflow-jsonl-v1' } }, 'structured'), PARSERS['doflow-jsonl-v1']);
  // A map that names a core id resolves to the core parser, never the map (S5).
  assert.equal(parserOf({ structuredOutput: { fieldMap: fieldMap('codex-exec-json-v1') } }, 'structured'), PARSERS['codex-exec-json-v1']);

  const descriptor = { structuredOutput: { fieldMap: fieldMap() }, mainSession: { parser: 'mycli-stream-v1' } };
  const compiled = parserOf(descriptor, 'structured');
  assert.equal(compiled.id, 'mycli-stream-v1');
  assert.equal(parserOf(descriptor, 'main'), compiled, 'mainSession may name this worker\'s map; the compile is cached');
  assert.equal(parserOf(JSON.parse(JSON.stringify(descriptor)), 'structured'), compiled, 'the cache key is the map\'s canonical JSON');

  const unknown = parserOf({ structuredOutput: { parser: 'nonesuch-v1' } }, 'structured').create().end();
  assert.equal(unknown.parser, UNPARSED);
  assert.equal(unknown.reason, 'parser-unknown');
  assert.equal(parserOf({ mainSession: { parser: 'mycli-stream-v1' } }, 'main').id, UNPARSED, 'a map id with no map in the descriptor');
  assert.equal(parserOf({}, 'main').create().end().reason, 'no-structured-output-declared');
  // An invalid map in a stored descriptor reads as unparsed rather than throwing in a reader.
  const broken = fieldMap('broken-stream-v1');
  broken.rules = [];
  assert.equal(parserOf({ structuredOutput: { fieldMap: broken } }, 'structured').id, UNPARSED);
});

test('IC-003: the compile cache holds at most 64 maps', () => {
  const first = { structuredOutput: { fieldMap: fieldMap('cache-first-v1') } };
  const factory = parserOf(first, 'structured');
  assert.equal(parserOf(first, 'structured'), factory);
  for (let i = 0; i < 64; i++) parserOf({ structuredOutput: { fieldMap: fieldMap(`cache-fill-${i}-v1`) } }, 'structured');
  const again = parserOf(first, 'structured');
  assert.notEqual(again, factory, 'the oldest entry was evicted');
  assert.equal(again.id, 'cache-first-v1');
});

test('B3: a cache hit never returns a factory for a map that does not validate (a non-finite number is not null)', () => {
  const gated = (gate: any) => {
    const map = fieldMap('cache-gate-v1');
    map.rules[1].when.push({ path: ['gate'], equals: gate });
    return { structuredOutput: { fieldMap: map } };
  };
  const cached = parserOf(gated(null), 'structured');
  assert.equal(cached.id, 'cache-gate-v1');
  const infinite = parserOf(gated(JSON.parse('1e400')), 'structured');
  assert.equal(infinite.id, UNPARSED, 'refused, not the cached sibling');
  assert.equal(infinite.create().end().reason, 'parser-unknown');
  assert.equal(parserOf(gated(null), 'structured'), cached, 'the valid sibling stays cached');
});

test('the launch record stores parserIdOf: the map id for a map-only worker, the parser for a code parser', () => {
  const identity = { run: 'r', lineage: 'main', attempt: '1', runSource: 'env' };
  assert.equal(launchRecord(mapWorker(), identity, 'p').recipe.parser, 'mycli-stream-v1');
  const coded = mapWorker();
  coded.structuredOutput = entry('supported', { argv: [], parser: 'doflow-jsonl-v1' });
  assert.equal(launchRecord(coded, identity, 'p').recipe.parser, 'doflow-jsonl-v1');
});
