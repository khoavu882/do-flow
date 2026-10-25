'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  parseSemVer, compareSemVer, parseHostRange, satisfiesHostRange, HOST_RANGE_GRAMMAR,
} = require('../../src/helper/semver.ts');

test('a prerelease host satisfies a prerelease lower bound and an earlier one does not', () => {
  const range = '>=2.0.0-beta.7 <3.0.0';
  assert.equal(satisfiesHostRange('2.0.0-beta.7', range), true);
  assert.equal(satisfiesHostRange('2.0.0-beta.10', range), true);
  assert.equal(satisfiesHostRange('2.0.0', range), true);
  assert.equal(satisfiesHostRange('2.0.0-beta.6', range), false);
  assert.equal(satisfiesHostRange('3.0.0', range), false);
  assert.equal(satisfiesHostRange('3.0.0-beta.1', range), true, '3.0.0-beta.1 precedes 3.0.0');
});

test('a range the grammar does not allow is refused with the grammar as allowed, never thrown', () => {
  for (const text of ['^1.0.0', '1.x', '*', '>=1.0.0', '>=1 || <3', '~1.2.3', '>=1.0.0 || <3.0.0',
    '', ' ', '>=1.0.0  <2.0.0', ' <2.0.0', '<2.0.0 ', '>1.0.0 <2.0.0', '<=2.0.0', '>=1.0.0 <2', 'v1.0.0']) {
    const parsed = parseHostRange(text);
    assert.equal(parsed.ok, false, `"${text}" must be refused`);
    assert.equal(parsed.error.code, 'bad-type');
    assert.equal(parsed.error.allowed, HOST_RANGE_GRAMMAR);
    assert.equal(satisfiesHostRange('1.5.0', text), false);
  }
  for (const value of [undefined, null, 5, {}]) assert.equal(parseHostRange(value).ok, false);
});

test('comparators =V and a bare V are exact, and both count as an upper bound', () => {
  assert.equal(satisfiesHostRange('2.0.0-beta.7', '2.0.0-beta.7'), true);
  assert.equal(satisfiesHostRange('2.0.0-beta.8', '2.0.0-beta.7'), false);
  assert.equal(satisfiesHostRange('1.2.3', '=1.2.3'), true);
  assert.equal(satisfiesHostRange('1.2.4', '=1.2.3'), false);
  assert.equal(satisfiesHostRange('1.2.3', '>=1.0.0 =1.2.3'), true);
});

test('all comparators must hold and a version that is not semver satisfies nothing', () => {
  assert.equal(satisfiesHostRange('1.5.0', '>=1.0.0 <2.0.0'), true);
  assert.equal(satisfiesHostRange('2.0.0', '>=1.0.0 <2.0.0'), false);
  assert.equal(satisfiesHostRange('0.9.0', '>=1.0.0 <2.0.0'), false);
  assert.equal(satisfiesHostRange('not-a-version', '>=1.0.0 <2.0.0'), false);
});

test('a parsed range can be passed instead of the text', () => {
  const parsed = parseHostRange('>=1.0.0 <2.0.0');
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.comparators, [{ op: '>=', version: '1.0.0' }, { op: '<', version: '2.0.0' }]);
  assert.equal(satisfiesHostRange('1.1.0', parsed), true);
});

test('the moved parseSemVer and compareSemVer keep SemVer 2.0 precedence', () => {
  assert.equal(parseSemVer('01.0.0'), null);
  assert.deepEqual(parseSemVer('1.2.3-beta.1+build'), { major: '1', minor: '2', patch: '3', prerelease: ['beta', '1'] });
  const ordered = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0'];
  for (let i = 0; i + 1 < ordered.length; i++) {
    assert.equal(compareSemVer(ordered[i], ordered[i + 1]), -1, `${ordered[i]} < ${ordered[i + 1]}`);
    assert.equal(compareSemVer(ordered[i + 1], ordered[i]), 1);
  }
  assert.equal(compareSemVer('1.0.0+a', '1.0.0+b'), 0);
  assert.equal(compareSemVer('x', '1.0.0'), null);
});
