'use strict';

// The one key-sorted JSON in src/runtime: `canonicalJson` (compact text) and `sortKeysDeep` (a tree).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { canonicalJson, sortKeysDeep } = require('../../src/runtime/canonical-json.ts');

test('canonicalJson sorts keys at every depth, keeps array order and writes no whitespace', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [{ y: 1, x: 2 }, 3], c: null } }), '{"a":{"c":null,"d":[{"x":2,"y":1},3]},"b":1}');
  assert.equal(canonicalJson([{ b: 1, a: 2 }]), '[{"a":2,"b":1}]');
});

test('canonicalJson gives the same text whatever the key order', () => {
  assert.equal(canonicalJson({ a: 1, b: { c: 1, d: 2 } }), canonicalJson({ b: { d: 2, c: 1 }, a: 1 }));
});

test('canonicalJson escapes keys and strings as JSON.stringify does, and sorts keys by UTF-16 code unit', () => {
  assert.equal(canonicalJson({ 'é': 1, 'z': 2, 'a"b': 3, B: 4 }), '{"B":4,"a\\"b":3,"z":2,"é":1}');
  assert.equal(canonicalJson('line\nbreak'), '"line\\nbreak"');
});

test('canonicalJson on an undefined leaf is what JSON.stringify gives, unless undefinedAsNull', () => {
  assert.equal(canonicalJson(undefined), undefined);
  assert.equal(canonicalJson({ a: undefined, b: 1 }), '{"a":undefined,"b":1}');
  assert.equal(canonicalJson([undefined, 1]), '[,1]');
  assert.equal(canonicalJson(undefined, { undefinedAsNull: true }), 'null');
  assert.equal(canonicalJson({ a: undefined, b: [undefined, 1] }, { undefinedAsNull: true }), '{"a":null,"b":[null,1]}');
});

test('canonicalJson treats every non-array object alike: a Date has no own keys and is written as {}', () => {
  assert.equal(canonicalJson({ at: new Date(0) }), '{"at":{}}');
  assert.equal(canonicalJson(null), 'null');
  assert.equal(canonicalJson(false), 'false');
});

test('sortKeysDeep sorts keys at every depth and returns a copy', () => {
  const input = { b: [{ y: 1, x: 2 }], a: { d: 1, c: 2 } };
  const sorted = sortKeysDeep(input);
  assert.deepEqual(Object.keys(sorted), ['a', 'b']);
  assert.deepEqual(Object.keys(sorted.a), ['c', 'd']);
  assert.deepEqual(Object.keys(sorted.b[0]), ['x', 'y']);
  assert.deepEqual(Object.keys(input), ['b', 'a'], 'the input is not reordered');
  assert.equal(JSON.stringify(sorted), '{"a":{"c":2,"d":1},"b":[{"x":2,"y":1}]}');
});

test('sortKeysDeep leaves primitives and null as they are and keeps an own __proto__ key', () => {
  assert.equal(sortKeysDeep(null), null);
  assert.equal(sortKeysDeep(3), 3);
  assert.equal(sortKeysDeep('x'), 'x');
  assert.equal(sortKeysDeep(undefined), undefined);
  assert.equal(JSON.stringify(sortKeysDeep(JSON.parse('{"__proto__":{"a":1},"b":2}'))), '{"__proto__":{"a":1},"b":2}');
});

test('sortKeysDeep drops undefined properties when stringified, unlike canonicalJson', () => {
  assert.equal(JSON.stringify(sortKeysDeep({ b: undefined, a: 1 })), '{"a":1}');
});
