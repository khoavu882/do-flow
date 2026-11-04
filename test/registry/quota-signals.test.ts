'use strict';

// FU-msddrn (106 C-12): a quotaSignals list holds no case-folded duplicates and no zero-width characters.
// The matcher lowercases both sides (src/runtime/worker/quota.ts), so 'Quota' and 'quota' are one signal,
// and a zero-width character makes a signal that looks like another yet never matches the text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { validateWorker, loadRegistry } = require('../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../..');

function validateQuota(quotaSignals: any): string[] {
  const errors: string[] = [];
  const worker = structuredClone(loadRegistry({ repoRoot: REPO }).harnesses.find((h: any) => h.id === 'codex').worker);
  const { quotaSignals: _dropped, ...rest } = worker.structuredOutput;
  worker.structuredOutput = quotaSignals === undefined ? rest : { ...rest, quotaSignals };
  validateWorker(worker, "harness 'codex'", errors);
  return errors;
}
const quota = (signals: string[]) => ({ signals, basis: 'unverified', evidence: [] });
const at = "harness 'codex' worker 'structuredOutput'";

test('quotaSignals rejects signals that differ only by letter case', () => {
  for (const signals of [['quota', 'Quota'], ['rate limit', 'usage limit', 'RATE LIMIT'], ['ÄBC', 'äbc']]) {
    const errors = validateQuota(quota(signals));
    assert.ok(errors.some((line) => line.includes(at) && /duplicate/.test(line)), `${JSON.stringify(signals)}: ${JSON.stringify(errors)}`);
  }
});

test('quotaSignals rejects zero-width and invisible format characters inside a signal', () => {
  for (const mark of ['\u200b', '\u200c', '\u200d', '\u2060', '\ufeff', '\u00ad', '\u200e']) {
    const errors = validateQuota(quota([`quo${mark}ta`]));
    assert.ok(errors.some((line) => line.includes(at) && /zero-width|invisible/.test(line)), `U+${mark.codePointAt(0)!.toString(16)}: ${JSON.stringify(errors)}`);
  }
});

test('quotaSignals still accepts distinct signals, and an absent quotaSignals stays valid', () => {
  assert.deepEqual(validateQuota(quota(['rate limit', 'usage limit', 'quota exceeded'])), []);
  assert.deepEqual(validateQuota(undefined), []);
});
