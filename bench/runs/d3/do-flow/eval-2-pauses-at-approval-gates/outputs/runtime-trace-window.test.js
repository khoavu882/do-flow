'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RunLedger, buildTrace } = require('../src/runtime/trace');

const NOW = new Date('2026-08-18T12:00:00Z');

/** A ledger dir with one record per named day partition. */
function ledgerWith(days) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-trace-window-'));
  for (const day of days) {
    const record = { timestamp: `${day}T09:00:00.000Z`, verb: 'paths', outcome: 'ok', durationMs: 5 };
    fs.writeFileSync(path.join(dir, `${day}.jsonl`), `${JSON.stringify(record)}\n`);
  }
  return dir;
}

function read(dir, options) {
  return new RunLedger({ dir, clock: () => NOW }).read(options);
}

// FR-001
test('--since keeps partitions on or after the date, inclusive', () => {
  const dir = ledgerWith(['2026-07-30', '2026-08-01', '2026-08-05']);
  const result = read(dir, { since: '2026-08-01' });
  assert.deepEqual(result.files, ['2026-08-01.jsonl', '2026-08-05.jsonl']);
  assert.equal(result.records.length, 2);
  assert.equal(result.windowStart, '2026-08-01');
});

// FR-002
test('--since rejects an unparseable value rather than reading everything', () => {
  const dir = ledgerWith(['2026-08-05']);
  assert.throws(() => read(dir, { since: 'notadate' }), /--since expects a YYYY-MM-DD date/);
});

test('--since rejects a well-formed but unreal date', () => {
  const dir = ledgerWith(['2026-08-05']);
  assert.throws(() => read(dir, { since: '2026-02-31' }), /--since expects a real calendar date/);
});

test('--since rejects a future date', () => {
  const dir = ledgerWith(['2026-08-05']);
  assert.throws(() => read(dir, { since: '2099-01-01' }), /--since is in the future/);
});

// FR-003
test('--since with --days applies the narrower window and records both inputs', () => {
  const dir = ledgerWith(['2026-08-01', '2026-08-16', '2026-08-18']);
  // --days 3 => cutoff 2026-08-16; --since 2026-08-01 is wider, so days wins.
  const narrowedByDays = read(dir, { days: 3, since: '2026-08-01' });
  assert.equal(narrowedByDays.windowStart, '2026-08-16');
  assert.equal(narrowedByDays.days, 3);
  assert.equal(narrowedByDays.since, '2026-08-01');

  // --days 30 => cutoff 2026-07-20; --since 2026-08-16 is narrower, so since wins.
  const narrowedBySince = read(dir, { days: 30, since: '2026-08-16' });
  assert.equal(narrowedBySince.windowStart, '2026-08-16');
});

// NFR-001
test('trace --json still emits ledger.windowDays alongside the new fields', () => {
  const dir = ledgerWith(['2026-08-18']);
  const view = buildTrace(read(dir, { days: 2 }));
  assert.equal(view.ledger.windowDays, 2);
  assert.equal(view.ledger.windowSince, null);
  assert.ok('windowStart' in view.ledger);
});

test('an unwindowed read is unchanged: no cutoff, no since', () => {
  const dir = ledgerWith(['2026-07-01', '2026-08-18']);
  const result = read(dir, {});
  assert.equal(result.files.length, 2);
  assert.equal(result.windowStart, null);
  assert.equal(result.since, null);
  assert.equal(result.days, null);
});
