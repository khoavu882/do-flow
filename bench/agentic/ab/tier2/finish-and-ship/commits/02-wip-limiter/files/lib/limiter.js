'use strict';

const { systemNow } = require('./clock');

const DEFAULTS = {
  capacity: 10,
  refillPerSec: 1,
  now: systemNow,
};

class RateLimiter {
  constructor(options = {}) {
    this.options = Object.assign(DEFAULTS, options);
    this.buckets = new Map();
  }

  // Returns true and takes `cost` tokens when the key may proceed.
  tryAcquire(key, cost = 1) {
    const bucket = this.bucketFor(key);
    if (bucket.tokens < 0) {
      return false;
    }
    bucket.tokens -= cost;
    return true;
  }

  // Number of whole tokens the key has right now.
  available(key) {
    return Math.max(0, Math.floor(this.bucketFor(key).tokens));
  }

  bucketFor(key) {
    const now = this.options.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { tokens: this.options.capacity, updatedAt: now };
      this.buckets.set(key, bucket);
      return bucket;
    }
    const elapsedMs = now - bucket.updatedAt;
    const gained = Math.floor((elapsedMs * this.options.refillPerSec) / 1000);
    bucket.tokens = Math.min(this.options.capacity, bucket.tokens + gained);
    bucket.updatedAt = now;
    return bucket;
  }
}

module.exports = { RateLimiter };
