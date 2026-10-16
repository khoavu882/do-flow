'use strict';

// 082 A.3 (IC-034, DEC-012, DEC-031, DEC-042): RunLedger#append fills run, lineage and attempt
// from the environment, writing each only when it matches its identity pattern. In process only:
// every case passes its identity environment explicitly, so the parent's DOFLOW_* never leaks in.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { RunLedger, RUN_FIELDS, normalizeRunRecord } = require('../../src/runtime/trace/ledger.ts');
const { ATTEMPT_PATTERN, ID_PATTERN, identityFields } = require('../../src/runtime/context/identity.ts');

const NOW = new Date('2026-10-12T08:00:00.000Z');
const VALID = Object.freeze({ DOFLOW_RUN_ID: 'r_082-a', DOFLOW_LINEAGE_ID: 'lin_1', DOFLOW_ATTEMPT: '3' });

function ledger(t, env) {
  const dir = tempDir(t, 'doflow-run-ledger-identity-');
  return new RunLedger({ dir, clock: () => NOW, env });
}

/** The single line `append` wrote, read back from disk. */
function written(result) {
  const lines = fs.readFileSync(result.file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]);
}

test('A.3: RUN_FIELDS declares run, lineage and attempt as tokens after retryCount', () => {
  const keys = RUN_FIELDS.map((field) => field.key);
  assert.deepEqual(keys.slice(keys.indexOf('retryCount')), ['retryCount', 'run', 'lineage', 'attempt']);
  for (const key of ['run', 'lineage', 'attempt']) {
    assert.deepEqual(RUN_FIELDS.find((field) => field.key === key), { key, wire: key, type: 'token' });
  }
  assert.ok(ATTEMPT_PATTERN instanceof RegExp && ID_PATTERN instanceof RegExp);
});

test('A.3: a valid identity trio is written', (t) => {
  const result = ledger(t, { ...VALID }).append({ verb: 'route' });
  assert.equal(result.written, true);
  assert.deepEqual(result.dropped, []);
  const line = written(result);
  assert.equal(line.run, 'r_082-a');
  assert.equal(line.lineage, 'lin_1');
  assert.equal(line.attempt, '3');
});

test('A.3: an invalid value is omitted while the other two are written (DEC-042)', async (t) => {
  const cases = [
    { name: 'DOFLOW_RUN_ID=local', env: { ...VALID, DOFLOW_RUN_ID: 'local' }, omitted: 'run' },
    { name: 'attempt 0', env: { ...VALID, DOFLOW_ATTEMPT: '0' }, omitted: 'attempt' },
    { name: 'attempt 10000', env: { ...VALID, DOFLOW_ATTEMPT: '10000' }, omitted: 'attempt' },
    { name: 'lineage with a space', env: { ...VALID, DOFLOW_LINEAGE_ID: 'lin 1' }, omitted: 'lineage' },
  ];
  for (const { name, env, omitted } of cases) {
    await t.test(name, (st) => {
      const result = ledger(st, env).append({ verb: 'route' });
      assert.equal(result.written, true);
      assert.deepEqual(result.dropped, [], 'an omitted identity value is not a caller rejection');
      const line = written(result);
      assert.equal(Object.prototype.hasOwnProperty.call(line, omitted), false, `${omitted} must be omitted`);
      for (const key of ['run', 'lineage', 'attempt'].filter((k) => k !== omitted)) {
        assert.equal(typeof line[key], 'string', `${key} must still be written`);
      }
    });
  }
});

test('A.3: identityFields writes nothing for an absent environment', () => {
  assert.deepEqual(identityFields({}), {});
  assert.deepEqual(identityFields({ DOFLOW_RUN_ID: '', DOFLOW_LINEAGE_ID: '', DOFLOW_ATTEMPT: '' }), {});
});

test('A.3: a caller-supplied run, lineage or attempt is dropped and named', (t) => {
  const result = ledger(t, {}).append({ verb: 'route', run: 'spoofed', lineage: 'x', attempt: '2' });
  assert.equal(result.written, true);
  assert.deepEqual(result.dropped.sort(), ['attempt', 'lineage', 'run']);
  const line = written(result);
  for (const key of ['run', 'lineage', 'attempt']) assert.equal(line[key], undefined);

  // The environment wins over the caller, and the caller's value is still named.
  const env = ledger(t, { ...VALID }).append({ verb: 'route', run: 'spoofed' });
  assert.deepEqual(env.dropped, ['run']);
  assert.equal(written(env).run, 'r_082-a');
});

test('A.3: normalizeRunRecord reads null identity values as absent', () => {
  const out = normalizeRunRecord({ timestamp: NOW.toISOString(), verb: 'route', run: null, lineage: null, attempt: null });
  assert.ok(out);
  for (const key of ['run', 'lineage', 'attempt']) {
    assert.equal(Object.prototype.hasOwnProperty.call(out, key), false);
  }
  const full = normalizeRunRecord({ timestamp: NOW.toISOString(), verb: 'route', run: 'r1', lineage: 'l1', attempt: '1' });
  assert.equal(full.run, 'r1');
  assert.equal(full.lineage, 'l1');
  assert.equal(full.attempt, '1');
});

test("A.3: append's return keys are unchanged apart from the three fields", (t) => {
  const event = { verb: 'route', outcome: 'ok', exitCode: 0, durationMs: 5 };
  const bare = ledger(t, {}).append(event);
  const withIdentity = ledger(t, { ...VALID }).append(event);
  assert.deepEqual(Object.keys(withIdentity).sort(), Object.keys(bare).sort());
  assert.deepEqual(Object.keys(bare).sort(), ['dropped', 'file', 'record', 'written']);
  const extra = Object.keys(withIdentity.record).filter((key) => !(key in bare.record));
  assert.deepEqual(extra.sort(), ['attempt', 'lineage', 'run']);
  assert.deepEqual(Object.keys(bare.record).sort(), Object.keys(written(bare)).sort());
  assert.equal(path.basename(bare.file), '2026-10-12.jsonl');
  // A non-object event is still rejected the same way.
  assert.deepEqual(ledger(t, { ...VALID }).append('route'), { written: false, dropped: [], reason: 'event must be an object' });
});
