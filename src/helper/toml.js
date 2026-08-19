'use strict';

// A deliberately generic, restricted TOML parser. It has no knowledge of Codex, or of any other
// harness — it only understands the TOML subset needed to safely locate scalar keys and table
// headers for a surgical, comment-preserving rewrite. It was extracted out of codex-config.js
// (which is Codex-specific and is moving under src/adapters/codex/) so that non-Codex code, such
// as the lifecycle layer, can parse TOML without depending on a harness-specific module.
function stripComment(line) {
  let quote = null;
  let escape = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '#') return line.slice(0, i);
  }
  return line;
}

function splitAssignment(line) {
  let quote = null;
  let escape = false;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') depth--;
    else if (char === '=' && depth === 0) return [line.slice(0, i), line.slice(i + 1)];
  }
  return null;
}

function balanced(value) {
  let quote = null;
  let escape = false;
  let depth = 0;
  for (const char of value) {
    if (quote) {
      if (escape) escape = false;
      else if (char === '\\') escape = true;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth++;
    else if (char === ']' || char === '}') {
      depth--;
      if (depth < 0) return false;
    }
  }
  return !quote && depth === 0;
}

function parseValue(raw) {
  const value = raw.trim();
  if (!value || !balanced(value)) throw new Error('invalid TOML value');
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(value)) return Number(value);
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    if (value[0] === '"') return JSON.parse(value);
    return value.slice(1, -1);
  }
  // Valid TOML arrays/inline tables/datetime values do not need interpretation when unmanaged.
  if (value.startsWith('[') || value.startsWith('{') || /^\d{4}-\d\d-\d\d(?:[Tt ].*)?$/.test(value)) return value;
  throw new Error('unsupported or invalid TOML value');
}

const BARE_KEY = /^[A-Za-z0-9_-]+$/;

/** Splits a TOML key path (`a.b`, `mcp_servers."my-server"`, `'lit'.x`) into its segments.
 * Quoted segments are ordinary TOML — a table header like `[mcp_servers."timo-document-hub"]` is
 * spec-valid — but this scanner previously matched bare keys only and rejected the whole file,
 * making any config that used one unreadable. Returns null for anything it cannot represent
 * faithfully, so every caller keeps failing closed rather than guessing at a rewrite.
 *
 * A dot *inside* a quoted segment is legal TOML (`"gpt-5.5" = 4`) and is preserved — see
 * flattenKeyPath for how it is kept from colliding with a genuine path separator. */
function parseKeyPath(raw) {
  const segments = [];
  let i = 0;
  const skipSpace = () => { while (i < raw.length && (raw[i] === ' ' || raw[i] === '\t')) i += 1; };
  skipSpace();
  if (i >= raw.length) return null;
  while (i < raw.length) {
    let segment;
    const quote = raw[i];
    if (quote === '"' || quote === "'") {
      i += 1;
      let body = '';
      while (i < raw.length && raw[i] !== quote) {
        if (quote === '"' && raw[i] === '\\') { body += raw.slice(i, i + 2); i += 2; continue; }
        body += raw[i]; i += 1;
      }
      if (raw[i] !== quote) return null;                       // unterminated
      i += 1;
      try { segment = quote === '"' ? JSON.parse(`"${body}"`) : body; } catch { return null; }
    } else {
      const start = i;
      while (i < raw.length && raw[i] !== '.' && raw[i] !== ' ' && raw[i] !== '\t') i += 1;
      segment = raw.slice(start, i);
      if (!BARE_KEY.test(segment)) return null;
    }
    if (!segment) return null;
    segments.push(segment);
    skipSpace();
    if (i >= raw.length) break;
    if (raw[i] !== '.') return null;
    i += 1;
    skipSpace();
    if (i >= raw.length) return null;                          // trailing dot
  }
  return segments.length ? segments : null;
}

/** Flattens key-path segments into the dotted string `entries` is keyed by, escaping any dot that
 * lives *inside* a segment so it cannot be mistaken for a path separator — without this,
 * `["a.b"]` and `[a.b]` collide and a surgical edit could rewrite the wrong line. Managed
 * identities (normaliseDesired) are bare-key-only, so their flattened form is unchanged and
 * lookups against them still match. */
function flattenKeyPath(segments) {
  return segments.map((segment) => segment.replace(/\\/g, '\\\\').replace(/\./g, '\\.')).join('.');
}

/** A conservative TOML scanner. It validates the subset needed to safely locate scalar keys;
 * unsupported multi-line syntax fails closed rather than risking a destructive rewrite. */
function parseToml(text) {
  const lines = text.split(/\r?\n/);
  let table = [];
  const entries = new Map();
  for (let index = 0; index < lines.length; index++) {
    const clean = stripComment(lines[index]).trim();
    if (!clean) continue;
    // `[[array.of.tables]]` still fails closed: the inner capture starts with '[', which
    // parseKeyPath rejects, so array-of-tables remains unsupported exactly as before.
    const tableMatch = clean.match(/^\[(.+)\]$/);
    if (tableMatch) {
      const tablePath = parseKeyPath(tableMatch[1].trim());
      if (!tablePath) throw new Error(`Malformed or unsupported TOML table on line ${index + 1}`);
      table = tablePath;
      continue;
    }
    if (clean.startsWith('[')) throw new Error(`Malformed or unsupported TOML table on line ${index + 1}`);
    const assignment = splitAssignment(clean);
    if (!assignment) throw new Error(`Malformed TOML assignment on line ${index + 1}`);
    const keyPath = parseKeyPath(assignment[0].trim());
    if (!keyPath) throw new Error(`Unsupported TOML key on line ${index + 1}`);
    let value;
    try { value = parseValue(assignment[1]); } catch { throw new Error(`Malformed TOML value on line ${index + 1}`); }
    const fullKey = flattenKeyPath([...table, ...keyPath]);
    if (entries.has(fullKey)) throw new Error(`Duplicate TOML key '${fullKey}'`);
    entries.set(fullKey, { value, line: index, table: flattenKeyPath(table) });
  }
  return { lines, entries };
}

module.exports = { parseToml, stripComment };
