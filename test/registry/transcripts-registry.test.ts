'use strict';
// 093 V.1, IC-021: core/registry/transcripts.json, its loader, the id guard against harnesses.json
// and the doctor row for a stale `verifiedOn`. Fixtures edit a copy of the shipped file, never the file.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  loadTranscriptRegistry, validateTranscriptRegistry, staleEntries, transcriptsDoctorView, STALE_DAYS,
} = require('../../src/runtime/transcripts/registry.ts');
const { buildHealthReport } = require('../../src/runtime/health.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const SHIPPED = path.join(REPO, 'core', 'registry', 'transcripts.json');
const harnessIds: string[] = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses.map((h: any) => h.id);

const shipped = (): any => JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
const entry = (reg: any, id: string): any => reg.entries.find((e: any) => e.harness === id);
const errorsOf = (reg: any, ids: string[] = harnessIds): string[] => validateTranscriptRegistry(reg, { harnessIds: ids }).errors;

test('the shipped registry loads and is valid', () => {
  const loaded = loadTranscriptRegistry({ repoRoot: REPO });
  assert.equal(loaded.ok, true, loaded.detail);
  assert.equal(loaded.registry.entries.length, 7);
});

test('every id is a harnesses.json id and every harnesses.json id has an entry (exact set)', () => {
  const ids = shipped().entries.map((e: any) => e.harness);
  assert.deepEqual([...ids].sort(), [...harnessIds].sort());
  assert.equal(new Set(ids).size, ids.length);
});

test('id guard: a harness with no entry, an unknown entry and a duplicate are each refused', () => {
  const missing = shipped();
  missing.entries = missing.entries.filter((e: any) => e.harness !== 'kiro');
  assert.ok(errorsOf(missing).some((m) => /kiro.*no entry/.test(m)), errorsOf(missing).join('; '));

  const extra = shipped();
  extra.entries.push({ ...entry(extra, 'pi'), harness: 'gemini' });
  assert.ok(errorsOf(extra).some((m) => /gemini.*not a harnesses\.json id/.test(m)), errorsOf(extra).join('; '));

  const dup = shipped();
  dup.entries.push({ ...entry(dup, 'pi') });
  assert.ok(errorsOf(dup).some((m) => /pi.*duplicate/.test(m)), errorsOf(dup).join('; '));
});

test('the schema holds per entry: statuses, readers, formats, joins, locations', () => {
  const reg = shipped();
  for (const e of reg.entries) {
    assert.ok(['supported', 'events-only', 'unknown'].includes(e.status), e.harness);
    assert.ok(['jsonl', 'sqlite', 'jsonl+json'].includes(e.format), e.harness);
    assert.ok(['yes', 'no', 'unknown'].includes(e.appendOnly), e.harness);
    assert.ok(['session-id', 'cwd', 'none'].includes(e.join), e.harness);
    assert.ok(Array.isArray(e.requiredKeys) && e.evidence.length > 0, e.harness);
    assert.match(e.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(e.status === 'supported', e.reader !== null, `${e.harness}: reader is set exactly when supported`);
  }
  assert.deepEqual(errorsOf(reg), []);
});

test('lead rulings: OpenCode is events-only without a reader, Antigravity is not joined', () => {
  const reg = shipped();
  assert.deepEqual([entry(reg, 'opencode').status, entry(reg, 'opencode').reader, entry(reg, 'opencode').format], ['events-only', null, 'sqlite']);
  assert.deepEqual([entry(reg, 'antigravity').status, entry(reg, 'antigravity').reader, entry(reg, 'antigravity').join], ['events-only', null, 'none']);
  assert.deepEqual(['claude', 'codex', 'kiro', 'copilot', 'pi'].map((id) => entry(reg, id).reader),
    ['claude-jsonl', 'codex-rollout', 'kiro-jsonl', 'copilot-events', 'pi-jsonl']);
});

test('a win32 location carries status: unknown; a non-win32 location carries none', () => {
  const reg = shipped();
  const win = reg.entries.flatMap((e: any) => e.locations).filter((l: any) => l.os === 'win32');
  assert.ok(win.length > 0 && win.every((l: any) => l.status === 'unknown'));
  const bad = shipped();
  delete entry(bad, 'claude').locations.find((l: any) => l.os === 'win32').status;
  assert.ok(errorsOf(bad).some((m) => /win32.*status.*unknown/.test(m)), errorsOf(bad).join('; '));
  const wrong = shipped();
  entry(wrong, 'codex').locations[0].status = 'unknown';
  assert.ok(errorsOf(wrong).some((m) => /status.*win32/.test(m)), errorsOf(wrong).join('; '));
});

test('the validator refuses an entry missing a required key and a bad value', () => {
  for (const key of ['reader', 'status', 'locations', 'format', 'appendOnly', 'join', 'requiredKeys', 'evidence', 'verifiedOn', 'versions']) {
    const reg = shipped();
    delete entry(reg, 'pi')[key];
    assert.ok(errorsOf(reg).some((m) => m.includes(`pi.${key}`)), `${key}: ${errorsOf(reg).join('; ')}`);
  }
  const badDate = shipped();
  entry(badDate, 'pi').verifiedOn = '2026-13-40';
  assert.ok(errorsOf(badDate).some((m) => m.includes('pi.verifiedOn')));
  const badGlob = shipped();
  entry(badGlob, 'pi').locations[0].glob = '{unknown}/x.jsonl';
  assert.ok(errorsOf(badGlob).some((m) => /placeholder/.test(m)));
  const badBase = shipped();
  entry(badBase, 'pi').locations[0].base = 'env:lower';
  assert.ok(errorsOf(badBase).some((m) => /base/.test(m)));
  const promoted = shipped();
  entry(promoted, 'opencode').status = 'supported';
  assert.ok(errorsOf(promoted).some((m) => /opencode.*reader/.test(m)));
  assert.ok(errorsOf({ version: 2, entries: [] }).some((m) => /version/.test(m)));
});

test('the loader refuses a file that is missing, unparsable or invalid, with reason config-invalid', (t) => {
  const dir = tempDir(t, 'doflow-transcripts-');
  assert.equal(loadTranscriptRegistry({ repoRoot: REPO, file: path.join(dir, 'none.json') }).reason, 'config-invalid');
  fs.writeFileSync(path.join(dir, 'torn.json'), '{ "version": 1, ');
  assert.equal(loadTranscriptRegistry({ repoRoot: REPO, file: path.join(dir, 'torn.json') }).reason, 'config-invalid');
  const reg = shipped();
  reg.entries = reg.entries.filter((e: any) => e.harness !== 'kiro');
  fs.writeFileSync(path.join(dir, 'nokiro.json'), JSON.stringify(reg));
  const loaded = loadTranscriptRegistry({ repoRoot: REPO, file: path.join(dir, 'nokiro.json') });
  assert.equal(loaded.ok, false);
  assert.match(loaded.detail, /kiro/);
});

test('the shipped file is checked against the shipped harnesses.json (the guard that fails when either side drifts)', () => {
  assert.deepEqual(errorsOf(shipped()), []);
  assert.equal(loadTranscriptRegistry({ repoRoot: REPO }).ok, true);
});

test('staleEntries flags verifiedOn older than 90 days against a fake now', () => {
  const reg = shipped();
  entry(reg, 'pi').verifiedOn = '2026-01-01';
  const now = new Date('2026-10-27T00:00:00Z');
  assert.equal(STALE_DAYS, 90);
  assert.deepEqual(staleEntries(reg, now).map((s: any) => s.harness), ['pi']);
  // Exactly 90 days is not stale; 91 is.
  entry(reg, 'pi').verifiedOn = '2026-07-29';
  assert.deepEqual(staleEntries(reg, now), []);
  entry(reg, 'pi').verifiedOn = '2026-07-28';
  assert.deepEqual(staleEntries(reg, now).map((s: any) => s.harness), ['pi']);
});

test('doctor row: ok when fresh, stale when verifiedOn is old (fake now), drift when the registry is invalid', (t) => {
  const fresh = transcriptsDoctorView({ repoRoot: REPO, now: new Date('2026-10-27T00:00:00Z') });
  assert.equal(fresh.state, 'ok');
  assert.deepEqual(fresh.stale, []);
  assert.equal(fresh.entries, 7);

  const old = transcriptsDoctorView({ repoRoot: REPO, now: new Date('2027-06-01T00:00:00Z') });
  assert.equal(old.state, 'stale');
  assert.equal(old.stale.length, 7);
  assert.ok(old.stale.every((s: any) => s.verifiedOn === '2026-10-26' && s.ageDays > 90));

  const dir = tempDir(t, 'doflow-transcripts-drift-');
  const reg = shipped();
  reg.entries = reg.entries.filter((e: any) => e.harness !== 'kiro');
  fs.writeFileSync(path.join(dir, 'transcripts.json'), JSON.stringify(reg));
  const drift = transcriptsDoctorView({ repoRoot: REPO, file: path.join(dir, 'transcripts.json'), now: new Date('2026-10-27T00:00:00Z') });
  assert.equal(drift.state, 'drift');
  assert.ok(drift.errors.some((m: string) => /kiro/.test(m)));
});

test('buildHealthReport carries the transcripts row and it never becomes a finding or warning', () => {
  const report = buildHealthReport({ repoRoot: REPO, projectRoot: REPO, now: new Date('2027-06-01T00:00:00Z') });
  assert.equal(report.transcripts.state, 'stale');
  assert.ok(!report.findings.some((f: any) => /transcript/.test(f.kind)));
  assert.ok(!report.warnings.some((w: any) => /transcript/.test(w.kind)));
});
