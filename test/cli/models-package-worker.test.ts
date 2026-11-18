'use strict';
// `doflow models` reads the same worker list as the worker verbs: the built-in harnesses and the active package workers.
// A package worker declaring `modelList` and a `model` flag can be synced, listed, bound and unbound, and shows in the tier
// view. The package is installed into a scratch HOME; its CLI is a scratch script, so no real CLI or home is touched.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { planPackage, applyPlan } = require('../../src/runtime/packages/store.ts');
const { packageView, resetPackageView } = require('../../src/runtime/packages/view.ts');
const { readLock, writeLock, lockPackages } = require('../../src/state/lockfile.ts');
const { handleModelsCommand } = require('../../src/runtime/models/command.ts');
const { tierView } = require('../../src/runtime/models/tier-view.ts');
const { loadRegistry } = require('../../src/registry/index.ts');

const AT = '2026-10-24T09:12:03Z';
const NO_TMP = '/nonexistent-doflow-tmp';
const unknown = (what: string) => ({ status: 'unknown', evidence: [], verification: `Check ${what}`, verifiedOn: '2026-10-24', reason: 'test' });

function workerJson() {
  const supported = (extra: any) => ({ status: 'supported', evidence: ['test'], verification: 'test', verifiedOn: '2026-10-24', ...extra });
  return {
    profile: null, billing: 'unknown', family: 'custom-family',
    cli: supported({ binary: 'mycli', versionArgv: ['--version'] }),
    oneShot: supported({ argv: ['{prompt}'], promptVia: 'argv' }),
    structuredOutput: supported({ argv: [], parser: 'doflow-jsonl-v1' }),
    model: supported({ argv: ['--model', '{model}'] }),
    modelList: { status: 'supported', argv: ['list-models'], parse: 'lines', verifiedOn: '2026-10-24', evidence: ['test'] },
    readOnly: unknown('readOnly'), spawnDenial: unknown('spawnDenial'), runnableProbe: unknown('runnableProbe'), hooksProbe: unknown('hooksProbe'),
    guidanceProbe: unknown('guidanceProbe'), loginProbe: unknown('loginProbe'), persistentSession: unknown('persistentSession'), resume: unknown('resume'), controlChannel: unknown('controlChannel'),
    modelChecks: [],
  };
}

function fixture(t: any) {
  const scratch = createScratch('doflow-models-package-');
  const exitCode = process.exitCode;
  t.after(() => { scratch.remove(); process.exitCode = exitCode; });
  const src = path.join(scratch.dir, 'pkg-src');
  fs.mkdirSync(path.join(src, 'workers'), { recursive: true });
  fs.writeFileSync(path.join(src, 'doflow-package.json'), JSON.stringify({
    manifest: 1, id: 'acme', version: '1.2.0', summary: 'A worker package', doflow: '>=2.0.0-beta.1 <3.0.0',
    programs: [{ id: 'mycli', binary: 'mycli', argv: 'worker-recipe' }],
    contributions: [{ point: 'worker', version: 1, id: 'mycli', file: 'workers/mycli.json', programs: ['mycli'] }],
  }, null, 2));
  fs.writeFileSync(path.join(src, 'workers', 'mycli.json'), JSON.stringify(workerJson(), null, 2));
  fs.writeFileSync(path.join(src, 'README.md'), 'notes\n');
  const planned = planPackage({ action: 'add', source: src, homeDir: scratch.home, repoRoot: REPO_ROOT, now: Date.parse(AT) });
  assert.equal(planned.ok, true, JSON.stringify(planned.findings));
  const applied = applyPlan({ planId: planned.plan.planId, action: 'add', homeDir: scratch.home, repoRoot: REPO_ROOT, env: scratch.env() });
  assert.equal(applied.ok, true, JSON.stringify(applied.findings));
  const lockOpts = { scope: 'global', homeDir: scratch.home };
  const lock = readLock(lockOpts);
  writeLock(lockOpts, { ...lock, packages: lockPackages(lock).map((r: any) => (r.id === 'acme' ? { ...r, enabled: true } : r)) });
  const grants = path.join(scratch.xdg, 'doflow', 'packages', 'grants.jsonl');
  fs.mkdirSync(path.dirname(grants), { recursive: true });
  fs.appendFileSync(grants, `${planned.plan.grantLines.trust}\n`);
  resetPackageView();
  const view = packageView({ repoRoot: REPO_ROOT, homeDir: scratch.home, env: scratch.env(), tmpDir: NO_TMP });
  assert.equal(view.packages.find((p: any) => p.id === 'acme').state, 'active');
  // The package worker's own CLI: lists two models, and a log line that is not one.
  const bin = path.join(scratch.dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'mycli'), '#!/bin/sh\nif [ "$1" = "list-models" ]; then printf "mine/small\\nmine/large\\nWARN: update available\\n"; else echo "mycli 1.0.0"; fi\n', { mode: 0o755 });
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const env = scratch.env({ PATH: bin });
  const settings = path.join(scratch.xdg, 'doflow', 'settings.json');
  return { scratch, view, project, env, settings };
}

async function run(args: any) {
  let out = '';
  let err = '';
  const log = console.log;
  const error = console.error;
  console.log = (msg: any) => { out += `${msg}\n`; };
  console.error = (msg: any) => { err += `${msg}\n`; };
  try {
    const code = await handleModelsCommand({ actionGiven: true, json: false, interactive: false, ...args });
    return { code, out, err };
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('a package worker declaring modelList and a model flag is synced, listed, bound, unbound and in the tier view', async (t: any) => {
  const f = fixture(t);
  // The listing runs the scratch script by name on the scratch PATH.
  const listExecImpl = async (file: string, args: string[]) => execFileSync(file, args, { env: f.env, encoding: 'utf8' });
  const common = { projectRoot: f.project, env: f.env, syncOptions: { view: f.view, listExecImpl } };

  const synced = await run({ ...common, action: 'sync', harness: 'acme.mycli', json: true });
  assert.equal(synced.code, 0, synced.err);
  const entry = JSON.parse(synced.out);
  assert.equal(entry.harnessId, 'acme.mycli');
  assert.equal(entry.installed, true);
  assert.deepEqual(entry.offeredModels.map((m: any) => m.id), ['mine/small', 'mine/large']);
  assert.deepEqual(entry.modelList, { status: 'listed' });

  const bound = await run({ ...common, action: 'bind', harness: 'acme.mycli', tier: 'frontier', model: 'mine/large', json: true });
  assert.equal(bound.code, 0, bound.err);
  assert.equal(JSON.parse(bound.out).checked, 'listed');
  const refused = await run({ ...common, action: 'bind', harness: 'acme.mycli', tier: 'light', model: 'mine/larg' });
  assert.equal(refused.code, 1);
  assert.match(refused.err, /not in acme\.mycli's model list; closest: mine\/large/);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.settings, 'utf8'))['workers.models'], { 'acme.mycli': { frontier: 'mine/large' } });

  const listed = JSON.parse((await run({ ...common, action: 'list', json: true })).out);
  const row = listed.harnesses.find((h: any) => h.harness === 'acme.mycli');
  assert.deepEqual(row.frontier, { model: 'mine/large', provider: null, effort: null, check: { model: 'listed', effort: null } });
  assert.deepEqual(row.orchestrator, row.frontier);
  assert.deepEqual(listed.models.filter((m: any) => m.harness === 'acme.mycli').map((m: any) => m.model), ['mine/small', 'mine/large']);
  const view = tierView({ registry: loadRegistry({ repoRoot: REPO_ROOT }), env: f.env, projectRoot: f.project, primary: null, view: f.view });
  assert.equal(view.harnesses.find((h: any) => h.harness === 'acme.mycli').frontier.model, 'mine/large');

  const unbound = await run({ ...common, action: 'unbind', harness: 'acme.mycli', tier: 'frontier' });
  assert.equal(unbound.code, 0, unbound.err);
  assert.match(unbound.out, /Unbound acme\.mycli frontier/);

  const all = await run({ ...common, action: 'sync', json: true });
  assert.ok(Object.hasOwn(JSON.parse(all.out).harnesses, 'acme.mycli'), 'sync without --harness covers the package worker');
  const unknownId = await run({ ...common, action: 'bind', harness: 'acme.nope', tier: 'light', model: 'x' });
  assert.equal(unknownId.code, 2);
  assert.match(unknownId.err, /unknown harness 'acme\.nope'; expected one of: .*acme\.mycli/);
});
