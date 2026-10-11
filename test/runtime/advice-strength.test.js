'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { strengthOf, strengthWords } = require('../../src/runtime/advice/strength');

const bands = {
  choice: { clearAt: 0.8, splitWithin: 0.2 },
  yesno: { clearAbove: 0.85, clearBelow: 0.15, splitFrom: 0.35, splitTo: 0.65 },
};

function choice(probabilities) { return { type: 'choice', probabilities }; }
function yesno(yes) { return { type: 'yesno', probabilities: { no: 1 - yes, yes } }; }

test('score strength applies choice bands with ordered criterion words', () => {
  const score = (probabilities) => ({ type: 'score', criteria: ['Low', 'Medium', 'High'], probabilities });
  assert.deepEqual(strengthOf(score({ 0: 0.8, 1: 0.1, 2: 0.1 }), bands), { word: 'clear', between: null });
  assert.deepEqual(strengthOf(score({ 0: 0.1, 1: 0.6, 2: 0.3 }), bands), { word: 'leaning', between: null });
  assert.deepEqual(strengthOf(score({ 0: 0.25, 1: 0.35, 2: 0.4 }), bands), { word: 'split', between: ['High', 'Medium'] });
  const tied = strengthOf(score({ 0: 0.5, 1: 0.5, 2: 0 }), bands);
  assert.deepEqual(tied, { word: 'split', between: ['Low', 'Medium'] });
  assert.equal(strengthWords(tied), 'split between Low and Medium');
});

test('IC-007 choice: clearAt is inclusive and takes precedence over a small gap', () => {
  assert.deepEqual(strengthOf(choice({ a: 0.8, b: 0.1, c: 0.1 }), bands), { word: 'clear', between: null });
  assert.deepEqual(strengthOf(choice({ a: 0.81, b: 0.8 }), bands), { word: 'clear', between: null });
});

test('IC-007 choice: a gap exactly splitWithin is leaning; a smaller gap is split', () => {
  assert.deepEqual(strengthOf(choice({ a: 0.6, b: 0.4 }), bands), { word: 'leaning', between: null });
  assert.deepEqual(strengthOf(choice({ a: 0.6, b: 0.41 }), bands), { word: 'split', between: ['a', 'b'] });
});

test('IC-007 choice: split order follows descending probability, with stable ties', () => {
  assert.deepEqual(strengthOf(choice({ light: 0.39, standard: 0.4, frontier: 0.4 }), bands), { word: 'split', between: ['standard', 'frontier'] });
  assert.deepEqual(strengthOf(choice({ light: 0.2, frontier: 0.45, standard: 0.35 }), bands), { word: 'split', between: ['frontier', 'standard'] });
});

test('IC-007 yesno: clearAbove and clearBelow boundaries are inclusive', () => {
  assert.deepEqual(strengthOf(yesno(0.85), bands), { word: 'clear', between: null });
  assert.deepEqual(strengthOf(yesno(0.15), bands), { word: 'clear', between: null });
  assert.deepEqual(strengthOf(yesno(0.86), bands), { word: 'clear', between: null });
  assert.deepEqual(strengthOf(yesno(0.14), bands), { word: 'clear', between: null });
});

test('IC-007 yesno: splitFrom and splitTo boundaries are inclusive', () => {
  assert.deepEqual(strengthOf(yesno(0.35), bands), { word: 'split', between: ['yes', 'no'] });
  assert.deepEqual(strengthOf(yesno(0.65), bands), { word: 'split', between: ['yes', 'no'] });
  assert.deepEqual(strengthOf(yesno(0.5), bands), { word: 'split', between: ['yes', 'no'] });
  assert.deepEqual(strengthOf(yesno(0.34), bands), { word: 'leaning', between: null });
  assert.deepEqual(strengthOf(yesno(0.66), bands), { word: 'leaning', between: null });
});

test('IC-007 renders only the three human words and the ordered split labels', () => {
  assert.equal(strengthWords({ word: 'clear', between: null }), 'clear');
  assert.equal(strengthWords({ word: 'leaning', between: null }), 'leaning');
  assert.equal(strengthWords({ word: 'split', between: ['frontier', 'standard'] }), 'split between frontier and standard');
});
