'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  loadRegistry,
  validateRegistry,
  validateContextProfile,
  CONTEXT_PROFILE_FIELDS,
} = require('../../src/registry/index.ts');

const REPO = path.resolve(__dirname, '../..');

/** A fresh copy of the shipped registry whose first harness is claude, with a mutation applied. */
function mutated(mutate: any) {
  const registry = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(registry.harnesses[0].contextProfile, registry.harnesses[0]);
  return validateRegistry(registry, { repoRoot: REPO });
}

function assertReports(result: any, pattern: any) {
  assert.equal(result.ok, false, 'the mutated registry must be rejected');
  assert.match(result.errors.join('\n'), pattern);
}

test('contextProfile: the shipped registry declares the block on all seven harnesses and validates', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(registry.validation.ok, true, registry.validation.errors.join('\n'));
  assert.equal(registry.harnesses.length, 7);
  for (const harness of registry.harnesses) {
    assert.ok(harness.contextProfile, `${harness.id} must declare contextProfile`);
    assert.deepEqual(
      Object.keys(harness.contextProfile).sort(),
      [...CONTEXT_PROFILE_FIELDS].sort(),
      `${harness.id} contextProfile keys`
    );
  }
});

test('contextProfile: a harness without the block is reported', () => {
  assertReports(
    mutated((_block: any, harness: any) => { delete harness.contextProfile; }),
    /harness 'claude': contextProfile block is required/
  );
});

test('contextProfile: validateContextProfile reports non-object block without throwing', () => {
  const errors: any = [];
  validateContextProfile('not-an-object', "harness 'test'", errors);
  assert.deepEqual(errors, ["harness 'test': contextProfile block is required and must be an object"]);
});

test('contextProfile: a missing field is reported, naming the field', () => {
  assertReports(
    mutated((block: any) => { delete block.capacityTokens; }),
    /missing field 'capacityTokens'/
  );
  assertReports(
    mutated((block: any) => { delete block.retention; }),
    /missing field 'retention'/
  );
});

test('contextProfile: an unknown key is reported', () => {
  assertReports(
    mutated((block: any) => { block.extraField = { unverified: 'extra', verifiedOn: '2026-10-13' }; }),
    /unknown key 'extraField'/
  );
});

test('contextProfile: a non-object field is reported', () => {
  assertReports(
    mutated((block: any) => { block.capacityTokens = 'not-a-fact'; }),
    /contextProfile 'capacityTokens': must be a Fact object/
  );
});

test('contextProfile: an unverified Fact with empty or missing string is reported', () => {
  assertReports(
    mutated((block: any) => { block.capacityTokens = { unverified: '', verifiedOn: '2026-10-13' }; }),
    /contextProfile 'capacityTokens': unverified must be a non-empty string/
  );
});

test('contextProfile: a Fact declaring both value and unverified is reported', () => {
  assertReports(
    mutated((block: any) => {
      block.capacityTokens = {
        value: 100000,
        source: 'docs',
        unverified: 'reason',
        verifiedOn: '2026-10-13',
      };
    }),
    /cannot declare both value and unverified/
  );
});

test('contextProfile: a declared value without source is reported', () => {
  assertReports(
    mutated((block: any) => {
      block.capacityTokens = { value: 100000, verifiedOn: '2026-10-13' };
    }),
    /a declared value requires a non-empty source/
  );
  assertReports(
    mutated((block: any) => {
      block.capacityTokens = { value: 100000, source: '   ', verifiedOn: '2026-10-13' };
    }),
    /a declared value requires a non-empty source/
  );
});

test('contextProfile: a Fact with neither value nor unverified is reported', () => {
  assertReports(
    mutated((block: any) => {
      block.capacityTokens = { verifiedOn: '2026-10-13' };
    }),
    /requires either value with source or a non-empty unverified/
  );
});

test('contextProfile: invalid or missing verifiedOn is reported', () => {
  assertReports(
    mutated((block: any) => { delete block.capacityTokens.verifiedOn; }),
    /requires verifiedOn as an ISO date/
  );
  assertReports(
    mutated((block: any) => { block.capacityTokens.verifiedOn = 'today'; }),
    /requires verifiedOn as an ISO date/
  );
  assertReports(
    mutated((block: any) => { block.capacityTokens.verifiedOn = '2026-02-31'; }),
    /requires verifiedOn as an ISO date/
  );
});

test('contextProfile: field values violating type or enum are reported', () => {
  // capacityTokens: positive integer (> 0)
  assertReports(
    mutated((block: any) => {
      block.capacityTokens = { value: 0, source: 'docs', verifiedOn: '2026-10-13' };
    }),
    /contextProfile 'capacityTokens': value must be a positive integer/
  );
  assertReports(
    mutated((block: any) => {
      block.capacityTokens = { value: -100, source: 'docs', verifiedOn: '2026-10-13' };
    }),
    /contextProfile 'capacityTokens': value must be a positive integer/
  );
  assertReports(
    mutated((block: any) => {
      block.capacityTokens = { value: 10.5, source: 'docs', verifiedOn: '2026-10-13' };
    }),
    /contextProfile 'capacityTokens': value must be a positive integer/
  );

  // reserveTokens: non-negative integer (>= 0)
  assertReports(
    mutated((block: any) => {
      block.reserveTokens = { value: -1, source: 'docs', verifiedOn: '2026-10-13' };
    }),
    /contextProfile 'reserveTokens': value must be a non-negative integer/
  );

  // tokenTelemetry: 'harness-reported' | 'none'
  assertReports(
    mutated((block: any) => {
      block.tokenTelemetry = { value: 'unknown', source: 'docs', verifiedOn: '2026-10-13' };
    }),
    /contextProfile 'tokenTelemetry': value must be 'harness-reported' or 'none'/
  );

  // toolResultLimitBytes: positive integer (> 0)
  assertReports(
    mutated((block: any) => {
      block.toolResultLimitBytes = { value: 0, source: 'docs', verifiedOn: '2026-10-13' };
    }),
    /contextProfile 'toolResultLimitBytes': value must be a positive integer/
  );

  // retention: 'supported' | 'unsupported'
  assertReports(
    mutated((block: any) => {
      block.retention = { value: 'partial', source: 'docs', verifiedOn: '2026-10-13' };
    }),
    /contextProfile 'retention': value must be 'supported' or 'unsupported'/
  );
});

test('contextProfile: a valid declared profile passes validation', () => {
  const result = mutated((block: any) => {
    block.capacityTokens = { value: 200000, source: 'vendor docs', verifiedOn: '2026-10-13' };
    block.reserveTokens = { value: 0, source: 'vendor docs', verifiedOn: '2026-10-13' };
    block.tokenTelemetry = { value: 'harness-reported', source: 'vendor docs', verifiedOn: '2026-10-13' };
    block.toolResultLimitBytes = { value: 50000, source: 'vendor docs', verifiedOn: '2026-10-13' };
    block.retention = { value: 'supported', source: 'vendor docs', verifiedOn: '2026-10-13' };
  });
  assert.equal(result.ok, true, result.errors.join('\n'));
});
