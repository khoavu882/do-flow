'use strict';

// Parses text such as "name=kv\nmode=fast" into an object.
// Blank lines and lines starting with # are skipped; the first = splits key from value.
function parse(input) {
  if (input === '') throw new TypeError('parse: input must not be empty');
  const result = {};
  for (const raw of String(input).split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const at = line.indexOf('=');
    if (at < 1) throw new SyntaxError(`line has no key: ${line}`);
    result[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return result;
}

module.exports = { parse };
