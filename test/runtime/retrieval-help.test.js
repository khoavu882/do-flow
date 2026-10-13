'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const BIN = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core/shared/scripts/doflow/bin/doflow-run');

test('evidence-add help documents --need and doflow-run usage documents attempt', () => {
  const help = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  const evidenceNeedLine = help.stdout.split(/\r?\n/).find((line) => line.includes('--need') && line.includes('evidence --action add'));
  assert.ok(evidenceNeedLine, 'help must list --need on the evidence-add help line');

  const usage = fs.readFileSync(RUN, 'utf8');
  const retrievalUsageLine = usage.split(/\r?\n/).find((line) => line.includes('retrieval-plan'));
  assert.ok(retrievalUsageLine && retrievalUsageLine.includes('attempt'), 'doflow-run usage must mention attempt');
});
