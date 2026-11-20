'use strict';

// K7 (row 180, FR-J1, FR-J2): `doflow doctor` reports the HTTP/3 revisit trigger: a `revisits` array in --json
// (additive), one line in the text report, and a warning (never a finding) naming FU-3mv3gx when it is met.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { handleDoctorCommand } = require('../../src/runtime/health.ts');

const stub = () => { const error: any = new Error('not found'); error.code = 'ENOENT'; throw error; };
const quicProc = { version: 'v99.0.0', config: { variables: { node_use_quic: true } }, versions: { ngtcp2: '1', nghttp3: '1' } };
const plainProc = { version: 'v99.0.0', config: { variables: { node_use_quic: false } }, versions: {} };

async function doctor(t: any, json: boolean, revisitInputs: any) {
  const dir = tempDir(t, 'doflow-doctor-revisits-');
  const lines: string[] = [];
  const log = console.log;
  const saved = process.exitCode;
  console.log = (...args: any[]) => { lines.push(args.join(' ')); };
  try {
    await handleDoctorCommand({ json, repoRoot: REPO_ROOT, projectRoot: dir, execFileImpl: stub, homeDir: dir, env: { HOME: dir, XDG_CONFIG_HOME: dir, DOFLOW_TELEMETRY: 'off' }, revisitInputs });
  } finally { console.log = log; process.exitCode = saved; }
  return json ? JSON.parse(lines.join('\n')) : lines.join('\n');
}

test('doctor --json: revisits holds the one http3-quic entry; not-met adds no warning', async (t) => {
  const report = await doctor(t, true, { proc: plainProc, isBuiltin: () => false });
  assert.equal(report.revisits.length, 1);
  assert.equal(report.revisits[0].id, 'http3-quic');
  assert.equal(report.revisits[0].state, 'not-met');
  assert.equal(report.warnings.some((w: any) => w.kind === 'revisit-met'), false);
});

test('doctor --json: met adds a warning naming FU-3mv3gx and the design section, and no finding', async (t) => {
  const report = await doctor(t, true, { proc: quicProc, isBuiltin: () => true });
  assert.equal(report.revisits[0].state, 'met');
  const warnings = report.warnings.filter((w: any) => w.kind === 'revisit-met');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].subject, 'http3-quic');
  assert.ok(warnings[0].detail.includes('FU-3mv3gx'), warnings[0].detail);
  assert.ok(warnings[0].detail.includes('console/DESIGN-v2.md'), warnings[0].detail);
  assert.equal(report.findings.some((f: any) => f.kind === 'revisit-met'), false);
});

test('doctor text: one [Revisit triggers] line with the state, and the other two triggers printed as not checked', async (t) => {
  const text = await doctor(t, false, { proc: plainProc, isBuiltin: () => false });
  const section = text.split('\n[Revisit triggers]\n')[1].split('\n\n')[0];
  assert.equal(section.split('\n').length, 1);
  assert.match(section, /http3-quic \(FU-3mv3gx\): not-met/);
  assert.match(section, /not checked: measured SSE stalls, a high-rate loss-tolerant feature/);
});

test('doctor text: met shows in [Warnings]; an unreadable config reads unknown', async (t) => {
  const met = await doctor(t, false, { proc: quicProc, isBuiltin: () => true });
  assert.match(met.split('\n[Warnings]')[1], /http3-quic\s+.*FU-3mv3gx/);
  const unknown = await doctor(t, false, { proc: { version: 'v99.0.0' }, isBuiltin: () => true });
  assert.match(unknown, /http3-quic \(FU-3mv3gx\): unknown/);
});
