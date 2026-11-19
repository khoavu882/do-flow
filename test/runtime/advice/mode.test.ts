'use strict';

// 084 C-6 (D2): one cap -> mode table for the dispatcher.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { capMode } = require('../../../src/runtime/advice/mode.ts');

test('capMode: off turns every configured mode off', () => {
  for (const mode of ['off', 'shadow', 'show', 'act']) assert.equal(capMode('off', mode), 'off');
});

test('capMode: shadow and staged (D2) cap act and show (175 FR-014) to shadow and keep shadow and off', () => {
  for (const cap of ['shadow', 'staged']) {
    assert.equal(capMode(cap, 'act'), 'shadow', cap);
    assert.equal(capMode(cap, 'show'), 'shadow', cap);
    assert.equal(capMode(cap, 'shadow'), 'shadow', cap);
    assert.equal(capMode(cap, 'off'), 'off', cap);
  }
});

test('capMode: act and no chosen profile keep the configured mode', () => {
  for (const cap of ['act', null]) {
    for (const mode of ['off', 'shadow', 'show', 'act']) assert.equal(capMode(cap, mode), mode, `${cap}/${mode}`);
  }
});

test('capMode: an unknown cap or configured mode fails closed', () => {
  for (const cap of ['bogus', undefined, '', 'ACT', 1]) assert.equal(capMode(cap, 'act'), 'off', String(cap));
  for (const cap of ['bogus', undefined, '', 'SHOW']) assert.equal(capMode(cap, 'show'), 'off', String(cap));
  for (const mode of ['bogus', undefined, null, 'ACT', 'SHOW']) assert.equal(capMode(null, mode), 'off', String(mode));
});
