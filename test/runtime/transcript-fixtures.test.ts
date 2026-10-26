'use strict';
// 093 V.2: the synthetic V8 transcript fixtures hold every planted marker and nothing from this machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { V8_ROOT, FIXTURES, MARKERS, LOCATION_ROOTS, realMachineIdentity, scanFixtures } = require('../fixtures/transcripts/v8/scan.ts');
const { loadTranscriptRegistry } = require('../../src/runtime/transcripts/registry.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const NONE = { homeDirs: [], emails: [], sessionIds: [] };

function copyOfFixtures(t: any): string {
  const dir = tempDir(t, 'doflow-v8-fixtures-');
  fs.cpSync(V8_ROOT, dir, { recursive: true });
  return dir;
}

test('the fixtures hold every marker and nothing from this machine', () => {
  assert.deepEqual(scanFixtures(), []);
});

test('the scan reads this machine\'s identity from the real account, not the scratch HOME', () => {
  const id = realMachineIdentity();
  assert.ok(id.homeDirs.length > 0 && id.homeDirs.every((dir: string) => path.isAbsolute(dir)));
});

test('control: the real home path planted in a copy turns the scan red', (t) => {
  const dir = copyOfFixtures(t);
  const forbidden = { ...NONE, homeDirs: ['/Users/fixture-machine'] };
  assert.deepEqual(scanFixtures({ root: dir, forbidden }), []);
  const target = path.join(dir, FIXTURES.find((fx: any) => fx.kind === 'main' && fx.harness === 'claude').file);
  fs.appendFileSync(target, '{"cwd":"/Users/fixture-machine/work"}\n');
  assert.ok(scanFixtures({ root: dir, forbidden }).some((f: string) => /home path/.test(f)));
});

test('control: a planted email and a planted session id are found', (t) => {
  const dir = copyOfFixtures(t);
  const target = path.join(dir, FIXTURES.find((fx: any) => fx.harness === 'pi' && fx.kind === 'main').file);
  fs.appendFileSync(target, '{"note":"someone@example.org","id":"11111111-aaaa-bbbb-cccc-222222222222"}\n');
  const findings = scanFixtures({ root: dir, forbidden: { ...NONE, emails: ['someone@example.org'], sessionIds: ['11111111-aaaa-bbbb-cccc-222222222222'] } });
  assert.ok(findings.some((f: string) => /user's email/.test(f)));
  assert.ok(findings.some((f: string) => /session id/.test(f)));
});

test('control: a removed marker, a stray file and a README gap are each found', (t) => {
  const dir = copyOfFixtures(t);
  const codex = path.join(dir, FIXTURES.find((fx: any) => fx.harness === 'codex' && fx.kind === 'main').file);
  fs.writeFileSync(codex, fs.readFileSync(codex, 'utf8').replaceAll('FIXTURE-THINKING-MARKER-7f3a', 'gone'));
  fs.writeFileSync(path.join(dir, 'claude', 'stray.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'README.md'), 'no rules here\n');
  const findings = scanFixtures({ root: dir, forbidden: NONE });
  assert.ok(findings.some((f: string) => /codex.*marker thinking is not planted/.test(f)));
  assert.ok(findings.some((f: string) => /stray\.jsonl.*does not list/.test(f)));
  assert.ok(findings.some((f: string) => /NO REAL CONTENT/.test(f)));
  assert.ok(findings.some((f: string) => /does not list marker secret-reply/.test(f)));
});

test('each harness fixture directory sits where the registry says the harness keeps its transcripts', () => {
  const { registry } = loadTranscriptRegistry({ repoRoot: REPO });
  for (const entry of registry.entries) {
    const home = entry.locations.find((l: any) => l.os === 'darwin' && (l.base === 'home' || l.base === 'xdg-data'));
    const expected = home.base === 'xdg-data' ? ['.local', 'share', ...home.segments] : home.segments;
    assert.deepEqual(LOCATION_ROOTS[entry.harness], expected, entry.harness);
    assert.ok(FIXTURES.some((fx: any) => fx.harness === entry.harness), `${entry.harness} has a fixture`);
  }
  assert.equal(MARKERS.length, 12);
});
