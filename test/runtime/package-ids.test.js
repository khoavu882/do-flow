'use strict';

// Feature 122 A.4 (IC-003): package, local, qualified and projected identifiers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  isPackageId, isLocalId, isQualifiedId, isReservedPackageId, qualifiedId, projectedName,
} = require('../../src/helper/package-ids.ts');

const word = (n) => `a${'b'.repeat(n - 1)}`; // n characters, starts with a letter

test('a package id is 2 to 16 characters of a-z, 0-9 and single hyphens, ending alphanumeric', () => {
  for (const ok of ['ab', 'acme', 'a1', 'my-pkg', word(16), 'a-b-c', 'x9']) assert.equal(isPackageId(ok), true, ok);
  for (const bad of ['', 'a', word(17), 'Acme', 'acme_x', '1abc', '-abc', 'abc-', 'a--b', 'ab.cd', 'ab cd', null, undefined, 5]) {
    assert.equal(isPackageId(bad), false, String(bad));
  }
});

test('a local id is 2 to 15 characters on the same alphabet', () => {
  for (const ok of ['ab', 'strict', word(15), 'debate-3', 'seat-a']) assert.equal(isLocalId(ok), true, ok);
  for (const bad of ['', 'a', word(16), 'Strict', '3x', 'x-', 'a--b', 'a.b', null]) assert.equal(isLocalId(bad), false, String(bad));
});

test('a qualified id is <package>.<local>, at most 32 characters, no -- in either part', () => {
  const longest = `${word(16)}.${word(15)}`;
  assert.equal(longest.length, 32);
  assert.equal(isQualifiedId(longest), true);
  assert.equal(isQualifiedId('acme.strict'), true);
  const over = `${word(16)}.${word(16)}`; // 33 characters: the local part is one too long
  assert.equal(over.length, 33);
  assert.equal(isQualifiedId(over), false);
  assert.equal(isQualifiedId(`${word(17)}.ab`), false);
  for (const bad of ['acme', 'acme.', '.strict', 'acme.strict.more', 'ac--me.strict', 'acme.str--ict', 'Acme.strict', 'acme-strict', '', null]) {
    assert.equal(isQualifiedId(bad), false, String(bad));
  }
});

test('qualifiedId joins valid parts and refuses invalid ones with null', () => {
  assert.equal(qualifiedId('acme', 'strict'), 'acme.strict');
  assert.equal(qualifiedId('a', 'strict'), null);
  assert.equal(qualifiedId('acme', 'a--b'), null);
  assert.equal(qualifiedId(word(16), word(15)), `${word(16)}.${word(15)}`);
});

test('a projected name renders the qualified id as <package>-<local> and never holds --', () => {
  assert.equal(projectedName('acme.triage'), 'acme-triage');
  assert.equal(projectedName(`${word(16)}.${word(15)}`), `${word(16)}-${word(15)}`);
  assert.equal(projectedName('acme-triage'), null);
  assert.equal(projectedName('ac--me.triage'), null);
  assert.equal(projectedName(`${word(16)}.${word(16)}`), null);
  assert.ok(!projectedName('acme.a-b').includes('--'));
});

test('reserved package ids: the listed names and any do- or doflow- prefix', () => {
  for (const id of ['doflow', 'do', 'core', 'user', 'project', 'local', 'env', 'auto', 'package', 'packages', 'do-x', 'do-anything', 'doflow-extra']) {
    assert.equal(isReservedPackageId(id), true, id);
  }
  for (const id of ['docs', 'dox', 'acme', 'envy', 'usr', 'doing']) assert.equal(isReservedPackageId(id), false, id);
  // The grammar and the reserved list are separate: `doflow` is a well-formed package id the first-party package alone uses.
  assert.equal(isPackageId('doflow'), true);
});
