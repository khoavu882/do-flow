'use strict';

// 084 C-6 (D2): one cap -> mode table for the dispatcher and the callers' unset-kind path.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capMode, unsetKindPath } = require('../../src/runtime/advice/mode.ts');

test('capMode: off turns every configured mode off', () => {
  for (const mode of ['off', 'shadow', 'act']) assert.equal(capMode('off', mode), 'off');
});

test('capMode: shadow and staged (D2) cap act to shadow and keep shadow and off', () => {
  for (const cap of ['shadow', 'staged']) {
    assert.equal(capMode(cap, 'act'), 'shadow', cap);
    assert.equal(capMode(cap, 'shadow'), 'shadow', cap);
    assert.equal(capMode(cap, 'off'), 'off', cap);
  }
});

test('capMode: act and no chosen profile keep the configured mode', () => {
  for (const cap of ['act', null]) {
    for (const mode of ['off', 'shadow', 'act']) assert.equal(capMode(cap, mode), mode, `${cap}/${mode}`);
  }
});

test('capMode: an unknown cap or configured mode fails closed', () => {
  for (const cap of ['bogus', undefined, '', 'ACT', 1]) assert.equal(capMode(cap, 'act'), 'off', String(cap));
  for (const mode of ['bogus', undefined, null, 'ACT']) assert.equal(capMode(null, mode), 'off', String(mode));
});

test('unsetKindPath: no profile and act keep the legacy path; shadow and staged shadow; off and unknown off', () => {
  assert.equal(unsetKindPath(null), 'legacy');
  assert.equal(unsetKindPath('act'), 'legacy');
  assert.equal(unsetKindPath('shadow'), 'shadow');
  assert.equal(unsetKindPath('staged'), 'shadow');
  assert.equal(unsetKindPath('off'), 'off');
  for (const cap of ['bogus', undefined, '', 'SHADOW']) assert.equal(unsetKindPath(cap), 'off', String(cap));
});
