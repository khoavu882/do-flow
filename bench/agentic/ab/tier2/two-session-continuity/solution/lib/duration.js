'use strict';

const { formatLong } = require('./long');

const UNIT_MS = { ms: 1, s: 1000, m: 60 * 1000, h: 60 * 60 * 1000, d: 24 * 60 * 60 * 1000 };

// Reads text such as "90s", "1h30m" or "2d" and returns milliseconds.
function parseDuration(text) {
  const source = String(text).trim();
  const pattern = /(\d+)(ms|s|m|h|d)/g;
  let total = 0;
  let consumed = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index !== consumed) break;
    total += Number(match[1]) * UNIT_MS[match[2]];
    consumed += match[0].length;
  }
  if (consumed === 0 || consumed !== source.length) {
    throw new RangeError(`cannot read duration: ${text}`);
  }
  return total;
}

const SPAN_MS = [['d', 86400000], ['h', 3600000], ['m', 60000], ['s', 1000]];

// Formats milliseconds using the two largest non-zero units, truncating.
function formatDuration(ms, { style = 'short' } = {}) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new TypeError('formatDuration: ms must be a finite number');
  }
  let rest = Math.floor(Math.abs(ms) / 1000) * 1000;
  const parts = [];
  for (const [unit, size] of SPAN_MS) {
    const count = Math.floor(rest / size);
    rest -= count * size;
    if (count > 0 && parts.length < 2) parts.push([unit, count]);
  }
  const sign = ms < 0 && parts.length > 0 ? '-' : '';
  if (style === 'long') return sign + formatLong(parts);
  return sign + (parts.length ? parts.map(([unit, count]) => `${count}${unit}`).join(' ') : '0s');
}

module.exports = { parseDuration, formatDuration };
