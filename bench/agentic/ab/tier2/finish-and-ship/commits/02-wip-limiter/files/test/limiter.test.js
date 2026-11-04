'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RateLimiter } = require('../lib/limiter');

function clock(start = 0) {
  const state = { t: start };
  return { now: () => state.t, advance: (ms) => { state.t += ms; } };
}

test('a fresh key can use its whole capacity', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1, now: c.now });
  assert.equal(limiter.tryAcquire('a'), true);
  assert.equal(limiter.tryAcquire('a'), true);
  assert.equal(limiter.tryAcquire('a'), true);
  assert.equal(limiter.available('a'), 0);
});

test('whole seconds hand tokens back', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1, now: c.now });
  limiter.tryAcquire('a', 3);
  c.advance(2000);
  assert.equal(limiter.available('a'), 2);
});

test('refill stops at capacity', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1, now: c.now });
  limiter.tryAcquire('a');
  c.advance(60000);
  assert.equal(limiter.available('a'), 3);
});

test('keys are independent', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 1, refillPerSec: 1, now: c.now });
  assert.equal(limiter.tryAcquire('a'), true);
  assert.equal(limiter.tryAcquire('b'), true);
});

test('the limiter works without options', () => {
  const limiter = new RateLimiter();
  assert.equal(limiter.tryAcquire('anyone'), true);
});
