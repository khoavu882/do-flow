'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { RateLimiter } = require(path.join(process.cwd(), 'lib/limiter.js'));

function clock(start = 0) {
  const state = { t: start };
  return { now: () => state.t, set: (t) => { state.t = t; } };
}

test('reset restores a full bucket for that key only', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 2, refillPerSec: 1, now: c.now });
  assert.equal(limiter.tryAcquire('a', 2), true);
  assert.equal(limiter.tryAcquire('b', 2), true);
  assert.equal(limiter.available('a'), 0);

  limiter.reset('a');
  assert.equal(limiter.available('a'), 2);
  assert.equal(limiter.tryAcquire('a'), true);
  assert.equal(limiter.tryAcquire('a'), true);
  assert.equal(limiter.available('b'), 0);
  assert.doesNotThrow(() => limiter.reset('never-seen'));
});

test('fractional tokens add up across calls', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 5, refillPerSec: 1, now: c.now });
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.tryAcquire('a'), true);
  c.set(400);
  assert.equal(limiter.tryAcquire('a'), false);
  c.set(800);
  assert.equal(limiter.tryAcquire('a'), false);
  c.set(1200);
  assert.equal(limiter.tryAcquire('a'), true);
});

test('a burst never gets more than capacity through', () => {
  const c = clock();
  const limiter = new RateLimiter({ capacity: 3, refillPerSec: 1, now: c.now });
  const results = [1, 2, 3, 4, 5].map(() => limiter.tryAcquire('a'));
  assert.deepEqual(results, [true, true, true, false, false]);

  const bulk = new RateLimiter({ capacity: 5, refillPerSec: 1, now: c.now });
  assert.equal(bulk.tryAcquire('k', 3), true);
  assert.equal(bulk.tryAcquire('k', 3), false);
  assert.equal(bulk.available('k'), 2);
});

test('defaults are not shared between instances', () => {
  const c = clock();
  const first = new RateLimiter({ capacity: 2, refillPerSec: 1, now: c.now });
  first.tryAcquire('a');
  const second = new RateLimiter({ now: c.now });
  const taken = [];
  for (let i = 0; i < 12; i += 1) taken.push(second.tryAcquire('b'));
  assert.equal(taken.filter(Boolean).length, 10);
});
