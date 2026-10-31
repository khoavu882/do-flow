'use strict';

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

module.exports = { parseDuration };
