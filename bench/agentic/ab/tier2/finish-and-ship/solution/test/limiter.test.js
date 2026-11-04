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

test('reset gives the key a full bucket again', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: c.now });
  limiter.tryAcquire('a', 2);
  limiter.reset('a');
  assert.equal(limiter.available('a'), 2);
});

test('fractional refill is kept between calls', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: c.now });
  limiter.tryAcquire('a', 2);
  c.advance(500);
  assert.equal(limiter.tryAcquire('a'), false);
  c.advance(500);
  assert.equal(limiter.tryAcquire('a'), true);
});

test('a burst stops at capacity', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: c.now });
  assert.deepEqual([1, 2, 3].map(() => limiter.tryAcquire('a')), [true, true, false]);
});

test('options of one instance do not leak into the next', () => {
  const c = clock();
  new RateLimiter({ capacity: 2, now: c.now });
  assert.equal(new RateLimiter({ now: c.now }).options.capacity, 10);
});
