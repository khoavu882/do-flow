'use strict';
// The ambiguous-feature hint is printed to every harness, so it names no one harness's tool.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');

const BASH = path.resolve(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash');
const scratch = createScratch('doflow-ambiguous-hint-');
after(() => scratch.remove());

test('the ambiguous-feature hint of do-prereqs.sh and do-paths.sh does not name AskUserQuestion', () => {
  const project = path.join(scratch.dir, 'project');
  for (const slug of ['001-solo', '002-other']) fs.mkdirSync(path.join(project, 'agent-docs', 'doflow', slug), { recursive: true });
  for (const [script, args] of [['do-prereqs.sh', ['--require-plan']], ['do-paths.sh', ['--json', '--require', 'feature']]]) {
    const res = spawnSync('bash', [path.join(BASH, script), ...args], { cwd: project, encoding: 'utf8', env: scratch.env() });
    assert.equal(res.status, 2, `${script}: ${res.stdout}${res.stderr}`);
    const out = JSON.parse(res.stdout);
    assert.equal(out.error, 'ambiguous-feature', script);
    assert.doesNotMatch(out.hint, /AskUserQuestion/, script);
    assert.match(out.hint, /ask which one with the user question tool/, script);
  }
});
