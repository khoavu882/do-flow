'use strict';

// Row 134 (Sol review P1): the constitution exit check from an installed runtime. `doflow install -g`
// into a scratch HOME leaves `~/.doflow/runtime` with no core/shared, so the base constitution must be
// read from the projected guidance tree (`~/.doflow/guidance/references/`), or every valid plan is
// refused. The checkout-run suites have core/shared beside the code and cannot see this.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { IS_WIN } = require('../helper-platform.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const SKIP = IS_WIN ? 'the doflow-run shim is POSIX shell' : false;
const IDS = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6'];
const plan = (failing: string | null) => ['# Plan', '', '## 2. Constitution Check (GATE)', '', '| Principle | Tier | Result | How |', '|---|---|---|---|',
  ...IDS.map((id) => `| ${id} | MUST | ${id === failing ? 'FAIL' : 'PASS'} | how |`), '', '## 8. Tasks', '', '- [ ] A.1 Build', ''].join('\n');

test('installed runtime: plan-check reads the base constitution from the projected guidance tree', { skip: SKIP }, () => {
  const scratch = createScratch('doflow-installed-plan-check-');
  try {
    const env = scratch.env({ DOFLOW_CONFIG_DIR: '', DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '' });
    const install = spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'doflow.js'), 'install', '-g', '-f', '--no-backup', '-t', 'claude'],
      { cwd: scratch.dir, env, encoding: 'utf8', input: '\n' });
    assert.equal(install.status, 0, install.stdout + install.stderr);
    const runtime = path.join(scratch.home, '.doflow', 'runtime');
    assert.equal(fs.existsSync(path.join(runtime, 'core', 'shared')), false, 'an installed runtime carries no core/shared');
    assert.ok(fs.existsSync(path.join(scratch.home, '.doflow', 'guidance', 'references', 'CONSTITUTION_BASE.md')), 'the base is projected');

    const repo = path.join(scratch.dir, 'repo');
    fs.mkdirSync(path.join(repo, 'agent-docs', 'doflow', 'f'), { recursive: true });
    assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo, env }).status, 0);
    const file = path.join(repo, 'agent-docs', 'doflow', 'f', 'plan.md');
    const check = () => {
      const res = spawnSync('bash', [path.join(scratch.home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run'), 'plan-check', file, '--json'],
        { cwd: repo, env, encoding: 'utf8' });
      assert.equal(res.status, 0, res.stdout + res.stderr);
      return JSON.parse(res.stdout).findings.filter((f: any) => f.rule.startsWith('constitution-')).map((f: any) => `${f.rule} ${f.id || ''}`.trim());
    };
    fs.writeFileSync(file, plan(null));
    assert.deepEqual(check(), [], 'a passing plan is not refused for want of the base');
    fs.writeFileSync(file, plan('P4'));
    assert.deepEqual(check(), ['constitution-must-fail P4'], 'the base is read, not skipped');
  } finally { scratch.remove(); }
});
