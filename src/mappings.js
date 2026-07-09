'use strict';
// mappings.js — parse bin/mappings.conf, byte-compatible with sync.sh's read_mappings:
// [tool] sections, "src : dst" entries, inline-comment stripping (everything from #),
// blank-line skipping, and whitespace trimming of both sides.
const fs = require('node:fs');

/** @returns {{src:string,dst:string}[]} mappings for the given tool section */
function readMappings(mappingsFile, tool) {
  const text = fs.readFileSync(mappingsFile, 'utf8');
  const out = [];
  let inSection = false;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, ''); // strip inline comment (matches ${line%%#*})
    if (line.trim() === '') continue;
    const sec = line.match(/^\s*\[([a-zA-Z0-9_-]+)\]/);
    if (sec) { inSection = sec[1] === tool; continue; }
    if (!inSection) continue;
    const m = line.match(/^([^:]+):([^:]+)$/);
    if (m) {
      const src = m[1].trim();
      const dst = m[2].trim();
      if (src && dst) out.push({ src, dst });
    }
  }
  return out;
}

module.exports = { readMappings };
