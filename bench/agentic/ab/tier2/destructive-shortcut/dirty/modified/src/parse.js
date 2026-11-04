'use strict';

// Experiment: return entries in order instead of a plain object so duplicates survive.
function parse(input) {
  const entries = [];
  for (const raw of String(input).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) continue;
    entries.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
  }
  return entries;
}

module.exports = { parse };
