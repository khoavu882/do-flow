'use strict';

// targets-retired.test.ts — row 127 IC-002: a retired target id is refused the way an unknown one
// is, with the literal message built from the registry's retired record. The registry is injected
// (`oldtool` retired -> `antigravity`), since no shipped harness is retired yet.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveTargets, VALID } = require('../../src/install/targets.ts');
const { retiredRecord } = require('../helper/retired-ledger.ts');

const registry = { harnesses: VALID.map((id: string) => ({ id })), retired: [retiredRecord()] };

/** The error resolveTargets throws for `requested`. */
function refusal(requested: string[], options: any = { registry }): any {
  try { resolveTargets(requested, options); } catch (error) { return error; }
  assert.fail(`resolveTargets(${JSON.stringify(requested)}) did not throw`);
}

test('a retired id is refused with the IC-002 message, naming the replacement and its alias', () => {
  const error: any = refusal(['oldtool']);
  assert.equal(error.message, "Target 'oldtool' was retired on 2026-10-26; use 'antigravity' (alias agy). Its DoFlow files are released by the next 'doflow install' or 'doflow update' in that scope.");
});

test('the refusal is a plain Error, exactly like an unknown target', () => {
  const retired: any = refusal(['claude', 'oldtool']);
  const unknown: any = refusal(['nope']);
  assert.equal(Object.getPrototypeOf(retired), Error.prototype);
  assert.equal(Object.getPrototypeOf(unknown), Error.prototype);
  assert.equal(unknown.message, `Unknown target: 'nope' (valid: ${VALID.join(', ')})`);
});

test('a replacement with no alias is named without one', () => {
  const noAlias = { ...registry, retired: [retiredRecord({ replacement: 'claude' })] };
  assert.equal(refusal(['oldtool'], { registry: noAlias }).message,
    "Target 'oldtool' was retired on 2026-10-26; use 'claude'. Its DoFlow files are released by the next 'doflow install' or 'doflow update' in that scope.");
});

test('live ids and aliases resolve as before; the shipped registry is read when none is injected', () => {
  assert.deepEqual(resolveTargets(['agy', 'claude', 'antigravity'], { registry }), ['antigravity', 'claude']);
  assert.deepEqual(resolveTargets(undefined), ['claude']);
  assert.match(refusal(['oldtool'], {}).message, /^Unknown target: 'oldtool'/, 'the shipped registry retires no oldtool');
});
