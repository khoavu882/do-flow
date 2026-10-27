'use strict';

const crypto = require('node:crypto');

/**
 * Deterministic canary sampler based on consistent hashing of unitKey.
 * Pure Node.js with zero external dependencies.
 */
function hashKey(key: string): number {
  if (typeof key !== 'string' || !key) return 0;
  const hash = crypto.createHash('sha256').update(key).digest('hex').slice(0, 8);
  return parseInt(hash, 16);
}

/**
 * Deterministic sampling check.
 * @param unitKey Distinct identifier (e.g. session ID, task ID, query hash)
 * @param sampleRate Number between 0.0 and 1.0 (e.g. 0.10 for 10%)
 */
function shouldSample(unitKey: string, sampleRate: number): boolean {
  if (typeof sampleRate !== 'number' || Number.isNaN(sampleRate) || sampleRate <= 0) return false;
  if (sampleRate >= 1.0) return true;
  const hashVal = hashKey(unitKey);
  const normalized = (hashVal % 10000) / 10000;
  return normalized < sampleRate;
}

class CanarySampler {
  shouldSample(unitKey: string, sampleRate: number = 0.10): boolean {
    return shouldSample(unitKey, sampleRate);
  }
  hashKey(key: string): number {
    return hashKey(key);
  }
}

module.exports = {
  hashKey,
  shouldSample,
  CanarySampler,
};
