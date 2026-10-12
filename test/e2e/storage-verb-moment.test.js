'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');
const { createScratch } = require('../helper/scratch-env');
const registry = require('../../core/registry/storage.json');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const REPO = path.resolve(__dirname, '../..');
const RUN = path.join(REPO, 'core/shared/scripts/doflow/bin/doflow-run');
const CLI = path.join(REPO, 'bin/doflow.js');
const DAY = 86400000;

for (const args of [ ['evidence', '--action', 'list', '--task-id', 'idle'], ['trace'], ['lifecycle'] ]) {
  test(`IC-009: no-hook sandbox is cleaned after ordinary ${args[0]}`, { skip: process.platform === 'win32' }, t => {
    const scratch = createScratch('doflow-verb-moment-', { prune: 'on' });
    t.after(() => scratch.remove());
    const projectRoot = path.join(scratch.dir, 'project'); fs.mkdirSync(projectRoot);
    const env = scratch.env({ DOFLOW_CLI: CLI, DOFLOW_CONFIG_DIR: path.join(projectRoot, '.doflow') });
    const roots = resolveRoots({ registry, projectRoot, env });
    for (const id of ['project-state', 'user-state']) fs.mkdirSync(roots[id], { recursive: true });
    const now = Date.now(), stale = new Date(now - 200 * DAY), removed = [];
    const log = path.join(roots['project-state'], 'verification/logs', `${now - 31 * DAY}-expired.log`);
    fs.mkdirSync(path.dirname(log), { recursive: true }); fs.writeFileSync(log, 'expired'); removed.push(log);
    for (const id of ['project-state', 'user-state']) {
      const partition = path.join(roots[id], 'runs', '2000-01-01.jsonl');
      fs.mkdirSync(path.dirname(partition), { recursive: true }); fs.writeFileSync(partition, '{}\n'); removed.push(partition);
    }
    for (const [sub, name] of [['sessions', 'old-session'], ['projects', '0123456789abcdef']]) {
      const dir = path.join(roots['config-home'], 'session-env', sub, name);
      fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'activity'), 'old');
      fs.utimesSync(path.join(dir, 'activity'), stale, stale); fs.utimesSync(dir, stale, stale); removed.push(dir);
    }
    // Observe the real pass result without adding a production test seam or installing hooks.
    const output = path.join(scratch.dir, 'passes.jsonl'), preload = path.join(scratch.dir, 'observe.cjs');
    fs.writeFileSync(preload, `const fs = require('node:fs');\nconst engine = require(${JSON.stringify(path.join(REPO, 'src/runtime/storage/engine.ts'))});\nconst runPass = engine.runPass;\nengine.runPass = options => { const result = runPass(options); fs.appendFileSync(${JSON.stringify(output)}, JSON.stringify(result) + '\\n'); return result; };\n`);
    const result = spawnSync('/bin/bash', [RUN, ...args, '--json'], {
      cwd: projectRoot, env: { ...env, NODE_OPTIONS: `--require=${preload}` }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    removed.forEach(file => assert.equal(fs.existsSync(file), false, file));
    const passes = fs.readFileSync(output, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(passes.length, 3);
    assert.deepEqual(passes.flatMap(pass => pass.stores.map(store => store.id)).sort(),
      registry.stores.filter(store => store.moments.includes('verb') && !['existing', 'control'].includes(store.rule)).map(store => store.id).sort());
    assert.equal(fs.existsSync(path.join(projectRoot, '.claude')), false, 'no hooks or harness installed');
    assert.equal(fs.existsSync(path.join(roots['config-home'], 'state/runs')), false);
  });
}

test('IC-009: trace from a subdirectory uses the ledger root it resolved', { skip: process.platform === 'win32' }, t => {
  const scratch = createScratch('doflow-verb-root-', { prune: 'on' }); t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project'), nested = path.join(project, 'src');
  const state = path.join(project, '.doflow/state'); fs.mkdirSync(nested, { recursive: true });
  const old = path.join(state, 'verification/logs', `${Date.now() - 31 * DAY}-expired.log`);
  fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, 'old');
  const result = spawnSync('/bin/bash', [RUN, 'trace', '--json'], { cwd: nested,
    env: scratch.env({ DOFLOW_CLI: CLI, DOFLOW_CONFIG_DIR: path.join(project, '.doflow') }), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(old), false);
  assert.equal(fs.existsSync(path.join(nested, '.doflow')), false);
});

test('IC-008/009: a verb exitCode and returned value survive post-verb upkeep', async t => {
  const scratch = createScratch('doflow-verb-exit-', { prune: 'on' }); t.after(() => scratch.remove());
  scratch.apply(); t.after(() => scratch.restore());
  const project = tempDir(t, 'doflow-verb-exit-project-'); fs.mkdirSync(path.join(project, '.doflow/state'), { recursive: true });
  const out = [], log = console.log, exitCode = process.exitCode;
  console.log = text => out.push(text);
  try {
    const { dispatchRuntimeCommand } = require('../../src/cli/runtime-commands.ts');
    const result = await dispatchRuntimeCommand({ cmd: 'classify', taskClass: 'not-a-class', positional: [project], json: true });
    assert.equal(result, 1); assert.equal(process.exitCode, 1);
    assert.equal(out.length, 1);
    assert.equal(fs.existsSync(path.join(project, '.doflow/state/upkeep-due')), true);
  } finally { console.log = log; process.exitCode = exitCode; }
});

test('IC-009: early process.exit usage error runs no upkeep moment', { skip: process.platform === 'win32' }, t => {
  const scratch = createScratch('doflow-verb-usage-', { prune: 'on' }); t.after(() => scratch.remove());
  const project = path.join(scratch.dir, 'project'); fs.mkdirSync(path.join(project, '.doflow/state'), { recursive: true });
  const result = spawnSync('/bin/bash', [RUN, 'evidence', '--action', 'list', '--json'], {
    cwd: project, env: scratch.env({ DOFLOW_CLI: CLI, DOFLOW_CONFIG_DIR: path.join(project, '.doflow') }), encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(fs.existsSync(path.join(project, '.doflow/state/.gitignore')), false);
  assert.equal(fs.existsSync(path.join(project, '.doflow/state/upkeep-due')), false);
});

test('CLI async dispatcher failures stay inside main error boundary', t => {
  const scratch = createScratch('doflow-verb-error-'); t.after(() => scratch.remove());
  const preload = path.join(scratch.dir, 'throw.cjs');
  fs.writeFileSync(preload, `require(${JSON.stringify(path.join(REPO, 'src/runtime/cli.js'))}).handleEvidenceCommand = () => { throw new Error('verb boundary regression'); };\n`);
  const result = spawnSync(process.execPath, ['--require', preload, CLI, 'evidence', '--action', 'list', '--task-id', 'idle'], {
    cwd: scratch.dir, env: scratch.env(), encoding: 'utf8',
  });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '[ERROR] verb boundary regression\n');
});
