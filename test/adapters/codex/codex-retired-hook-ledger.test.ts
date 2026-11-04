'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, run, cleanup } = require('../../e2e/cli-e2e.shared.ts');

after(cleanup);

const RETIRED_BODY = '#!/usr/bin/env bash\ndoflow_bridge codex PreToolUse pre-bash-guard\n';
const retiredRows = (ledger: any) => ledger.resources.filter((row: any) => row.harness === 'codex' && row.kind === 'hooks-script' && row.identity === 'pre-bash-guard.sh');

test('install -f over an install that still has the retired pre-bash-guard front door drops its script and its ledger row', (t: any) => {
  const home = tempDir(t, 'doflow-codex-retired-home-');
  const xdg = tempDir(t, 'doflow-codex-retired-xdg-');
  const project = tempDir(t, 'doflow-codex-retired-project-');
  spawnSync('git', ['init', '-q', project], { encoding: 'utf8' });
  fs.mkdirSync(path.join(xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(xdg, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'hooks.harnesses': ['codex'] }));
  const opts = { home, env: { XDG_CONFIG_HOME: xdg } };
  let r = run(['install', project, '--force', '--target', 'codex'], opts);
  assert.equal(r.status, 0, r.stderr);

  // Turn the install into what the previous release left: the script on disk and a ledger row for it.
  const hooksDir = path.join(project, '.codex', 'hooks');
  const ledgerFile = path.join(project, '.doflow', 'state', 'ledger.json');
  const ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const sample = ledger.resources.find((row: any) => row.harness === 'codex' && row.kind === 'hooks-script');
  const target = path.join(hooksDir, 'pre-bash-guard.sh');
  fs.writeFileSync(target, RETIRED_BODY);
  ledger.resources.push({ ...sample, identity: 'pre-bash-guard.sh', target,
    ownershipIdentity: 'doflow:codex:hooks-script:pre-bash-guard.sh', fingerprint: `sha256:${crypto.createHash('sha256').update(RETIRED_BODY).digest('hex')}` });
  fs.writeFileSync(ledgerFile, JSON.stringify(ledger, null, 2));
  assert.equal(retiredRows(JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))).length, 1);

  r = run(['install', project, '--force', '--target', 'codex'], opts);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(target), false, 'the retired script is deleted');
  assert.equal(retiredRows(JSON.parse(fs.readFileSync(ledgerFile, 'utf8'))).length, 0, 'its ledger row is dropped');
  assert.ok(fs.existsSync(path.join(hooksDir, 'pre-implement-gate.sh')), 'the shipped scripts stay');
});
