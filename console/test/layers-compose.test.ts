'use strict';

// Feature 161 IC-003 (DEC-019): the `layers` member keeps a gate's decider (`autopilot`, `manual` or null) as the
// core sent it; the retired `person` has no alias, so a core that sent it is a contract mismatch, never a decider.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { composeLayers } = require('../src/layers-compose.ts');

const WK = 'a1b2c3d4e5f60718';
const gate = (by: unknown) => ({ runKey: `${WK}/run-1/main`, slug: '161-live', taskId: 'T-1', gateId: 'g-design', name: 'Design approval', state: 'approved', at: '2026-11-15T08:30:00.000Z', by });

const gatesOf = async (rows: unknown[]) => ((await composeLayers(WK, new Map([['gates', { exit: 0, json: rows }]]), async () => ({ ok: false }))) as any).body.sections.gates;

test('161 DEC-019: a gate decided manually keeps by manual, autopilot and null stay; by person is a contract mismatch', async () => {
  const kept = await gatesOf([gate('manual'), gate('autopilot'), gate(null)]);
  assert.equal(kept.ok, true, JSON.stringify(kept));
  assert.deepEqual(kept.data.map((g: any) => g.by), ['manual', 'autopilot', null]);
  assert.deepEqual(await gatesOf([gate('person')]), { ok: false, code: 'core-contract-mismatch' });
});
