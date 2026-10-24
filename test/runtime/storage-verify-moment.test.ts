'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
test('verify runs unthrottled storage upkeep and preserves its visible result', () => {
  const scratch = createScratch('doflow-storage-verify-');
  try {
    const project = path.join(scratch.dir, 'project'); fs.mkdirSync(project);
    const plan = path.join(project, 'plan.md');
    fs.writeFileSync(plan, [
      '# Scratch verify contract',
      '- [x] D.3 one check; files: fixture.js',
      '```doflow-verification',
      `{"parse":null,"build":null,"lint":null,"typecheck":null,"test":"node -e 'process.stdout.write(\\"one-line\\")'"}`,
      '```',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(project, 'fixture.js'), 'console.log("fixture baseline")\n');
    fs.writeFileSync(path.join(project, '.gitignore'), '/.doflow/\n');
    const git = (...args: any[]) => spawnSync('git', args, { cwd: project, encoding: 'utf8' });
    for (const args of [['init', '-q'], ['config', 'user.name', 'DoFlow test'], ['config', 'user.email', 'doflow-test@example.invalid'], ['add', 'plan.md', 'fixture.js', '.gitignore'], ['commit', '-qm', 'baseline']]) {
      const result = git(...args);
      assert.equal(result.status, 0, result.stderr);
    }
    fs.appendFileSync(path.join(project, 'fixture.js'), '// changed\n');
    const logs = path.join(project, '.doflow/state/verification/logs'); fs.mkdirSync(logs, { recursive: true });
    const now = Date.now();
    const logNames: any = [];
    for (let i = 0; i < 60; i++) {
      const name = `${String(now + i).padStart(13, '0')}-fixture.log`;
      logNames.push(name);
      const file = path.join(logs, name);
      fs.writeFileSync(file, 'fixture\n');
      if (i < 10) fs.utimesSync(file, new Date(now - 40 * 86400000), new Date(now - 40 * 86400000));
    }
    const protectedName = logNames[0];
    const evidence = path.join(project, '.doflow/state/evidence/gate.json');
    const orchestration = path.join(project, '.doflow/state/orchestration/gate.json');
    fs.mkdirSync(path.dirname(evidence), { recursive: true });
    fs.mkdirSync(path.dirname(orchestration), { recursive: true });
    fs.writeFileSync(evidence, JSON.stringify({ log: protectedName }));
    fs.writeFileSync(orchestration, JSON.stringify({ state: 'AWAITING_GATE' }));
    const oldWorkTime: any = new Date(now - 40 * 86400000);
    fs.utimesSync(evidence, oldWorkTime, oldWorkTime);
    fs.utimesSync(orchestration, oldWorkTime, oldWorkTime);
    const runVerify = () => spawnSync(process.execPath, [BIN, 'verify', '--task-id', 'D.3', '--risk', 'LOW', '--plan-path', plan], {
      cwd: project, env: scratch.env(), encoding: 'utf8',
    });
    const setting = path.join(project, '.doflow/prune');
    fs.writeFileSync(setting, 'off\n');
    const baseline = runVerify();
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.match(baseline.stdout, /Checks: 1\/1 passed/, 'verify runs the one-check contract');

    fs.writeFileSync(setting, 'on\n');
    const dueMarker = path.join(project, '.doflow/state/upkeep-due');
    const dueText = `${Math.floor((now + 365 * 86400000) / 1000)}\n`;
    fs.writeFileSync(dueMarker, dueText);
    const result = runVerify();
    assert.equal(result.status, baseline.status);
    assert.equal(result.stdout, baseline.stdout, 'storage cleanup does not change verify output');
    assert.equal(result.stderr, baseline.stderr, 'storage cleanup does not change verify diagnostics');
    const remainingLogs = fs.readdirSync(logs).filter((name: any) => name.endsWith('.log')).sort();
    assert.deepEqual(remainingLogs, [protectedName, ...logNames.slice(20)].sort(),
      'verify keeps the 40 newest logs plus the log named by an AWAITING_GATE record');
    assert.equal(fs.existsSync(path.join(project, '.doflow/state/upkeep.lock')), false);
    assert.equal(fs.readFileSync(dueMarker, 'utf8'), dueText, 'verify leaves the future runtime-verb due time unchanged');
  } finally { scratch.remove(); }
});

test('C-9: upkeepAfterVerify prunes verification-reuse records aged 3 days; prune-off keeps them', () => {
  const scratch = createScratch('doflow-storage-verify-reuse-');
  try {
    const project = path.join(scratch.dir, 'project');
    fs.mkdirSync(project);
    const reuseDir = path.join(project, '.doflow/state/verification/reuse');
    fs.mkdirSync(reuseDir, { recursive: true });

    const now = Date.now();
    const DAY = 86400000;
    const oldTime: any = new Date(now - 3 * DAY);

    for (let i = 0; i < 450; i++) {
      const file = path.join(reuseDir, `reuse-${i.toString(16).padStart(16, '0')}.json`);
      fs.writeFileSync(file, '{}');
      fs.utimesSync(file, oldTime, oldTime);
    }
    assert.equal(fs.readdirSync(reuseDir).length, 450);

    const pruneFile = path.join(project, '.doflow/prune');
    fs.writeFileSync(pruneFile, 'off\n');
    const { upkeepAfterVerify } = require('../../src/runtime/storage/upkeep.ts');
    upkeepAfterVerify({ projectRoot: project, now, env: scratch.env() });
    assert.equal(fs.readdirSync(reuseDir).length, 450, 'with prune-off, 450 records are kept');

    fs.writeFileSync(pruneFile, 'on\n');
    upkeepAfterVerify({ projectRoot: project, now, env: scratch.env() });
    assert.equal(fs.readdirSync(reuseDir).length, 0, 'upkeepAfterVerify prunes all 450 records aged 3 days');
  } finally {
    scratch.remove();
  }
});
