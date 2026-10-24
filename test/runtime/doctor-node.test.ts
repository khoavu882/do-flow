'use strict';

// maint-node24-floor: `doflow doctor` warns, and never refuses, when the running Node is below the
// patched release of its line (24.22.1, 26.12.1; the 2026-10-21 security release, CVE-2026-111497).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { buildHealthReport, nodeSecurityWarning } = require('../../src/runtime/health.ts');

const stub = () => { const error: any = new Error('not found'); error.code = 'ENOENT'; throw error; };

test('nodeSecurityWarning: below the patched release of a line warns and names the CVE, the version and the fix', () => {
  for (const [version, patched] of [['v26.12.0', '26.12.1'], ['v26.11.9', '26.12.1'], ['v26.0.0', '26.12.1'], ['v24.22.0', '24.22.1'], ['v24.3.0', '24.22.1'], ['v24.22.1-rc.1', '24.22.1'], ['v26.12.1-rc.0', '26.12.1']]) {
    const warning = nodeSecurityWarning(version);
    assert.equal(warning.kind, 'node-security-release', version);
    assert.equal(warning.subject, 'node');
    assert.ok(warning.detail.includes(`Node ${version.slice(1)} is below ${patched}`), warning.detail);
    assert.ok(warning.detail.includes('CVE-2026-111497'), warning.detail);
  }
});

test('nodeSecurityWarning: a patched release, a later release and a line without an entry do not warn', () => {
  for (const version of ['v24.22.1', 'v24.23.0', 'v26.12.1', 'v26.13.0', 'v27.0.0', 'v25.1.0', 'v22.23.4', 'v24.22.2-rc.1', 'v26.13.0-rc.1', 'garbage', '']) {
    assert.equal(nodeSecurityWarning(version), null, version);
  }
});

test('doctor report: the warning rides in warnings, not findings, for an injected old Node, and is absent on a patched one', (t) => {
  const dir = tempDir(t, 'doflow-doctor-node-');
  const report = (nodeVersion: any) => buildHealthReport({ repoRoot: REPO_ROOT, projectRoot: dir, execFileImpl: stub, nodeVersion });
  const old = report('v26.12.0');
  assert.equal(old.warnings.filter((w: any) => w.kind === 'node-security-release').length, 1);
  assert.equal(old.findings.some((f: any) => f.kind === 'node-security-release'), false, 'a warning never changes the exit rule');
  const patched = report('v26.12.1');
  assert.equal(patched.warnings.some((w: any) => w.kind === 'node-security-release'), false);
  assert.deepEqual(old.findings, patched.findings);
  assert.equal(report('v24.22.1').warnings.some((w: any) => w.kind === 'node-security-release'), false);
  assert.equal(report('v25.9.0').warnings.some((w: any) => w.kind === 'node-security-release'), false, 'a line with no entry gets no warning');
});
