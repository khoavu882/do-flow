'use strict';

// Byte-preserving member edits on a JSON object's text. Every edit replaces exactly one span of the
// original string, so whitespace, key order, line endings and every member DoFlow does not touch
// survive as the user wrote them; re-serialising the parsed document would rewrite all of that.
// Pure string in, string out: no file I/O and no knowledge of who owns which member.

const SKELETON = '{\n  "mcpServers": {}\n}\n';
const WHITESPACE = ' \t\n\r';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function skipWhitespace(text, i) {
  while (i < text.length && WHITESPACE.includes(text[i])) i += 1;
  return i;
}

/** Index just past the string token that opens at `i`. */
function stringEnd(text, i) {
  for (i += 1; text[i] !== '"'; i += 1) if (text[i] === '\\') i += 1;
  return i + 1;
}

// The text has already passed JSON.parse, so the scanner only has to find spans, never validate.
function scanValue(text, i) {
  const ch = text[i];
  if (ch === '{') return scanObject(text, i);
  if (ch === '[') {
    i = skipWhitespace(text, i + 1);
    while (text[i] !== ']') {
      i = skipWhitespace(text, scanValue(text, i).end);
      if (text[i] === ',') i = skipWhitespace(text, i + 1);
    }
    return { end: i + 1, node: null };
  }
  if (ch === '"') return { end: stringEnd(text, i), node: null };
  let end = i;
  while (end < text.length && !`,}]${WHITESPACE}`.includes(text[end])) end += 1;
  return { end, node: null };
}

function scanObject(text, open) {
  const members = [];
  let i = skipWhitespace(text, open + 1);
  while (text[i] !== '}') {
    const keyStart = i;
    const keyEnd = stringEnd(text, keyStart);
    const valueStart = skipWhitespace(text, skipWhitespace(text, keyEnd) + 1);
    const { end: valueEnd, node } = scanValue(text, valueStart);
    members.push({ key: JSON.parse(text.slice(keyStart, keyEnd)), keyStart, valueStart, valueEnd,
      value: JSON.parse(text.slice(valueStart, valueEnd)), node });
    i = skipWhitespace(text, valueEnd);
    if (text[i] === ',') i = skipWhitespace(text, i + 1);
  }
  return { end: i + 1, node: { open, close: i, members } };
}

/** The whitespace that starts the line `at` sits on, or null when something else precedes it there. */
function lineIndent(text, at) {
  const prefix = text.slice(text.lastIndexOf('\n', at - 1) + 1, at);
  return /^[ \t]*$/.test(prefix) ? prefix : null;
}

/** Attach the formatting a container's new members follow: whether it spans lines, the indent of
 * its members and the indent of its closing brace. An empty container takes its parent's. */
function attachLayout(text, node, parent, unit) {
  const parentIndent = parent ? parent.indent : '';
  const empty = node.members.length === 0;
  node.multiline = text.slice(node.open, node.close).includes('\n') || (empty && Boolean(parent?.multiline));
  node.indent = (!empty && lineIndent(text, node.members[0].keyStart)) || parentIndent + unit;
  node.closeIndent = parentIndent;
}

function duplicateKey(node) {
  const seen = new Set();
  for (const member of node.members) {
    if (seen.has(member.key)) return member.key;
    seen.add(member.key);
  }
  return null;
}

function readDocument(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { return { ok: false, reason: `invalid JSON: ${error.message}` }; }
  if (!isPlainObject(parsed)) return { ok: false, reason: 'top level is not an object' };
  if (Object.prototype.hasOwnProperty.call(parsed, 'mcpServers') && !isPlainObject(parsed.mcpServers)) {
    return { ok: false, reason: 'mcpServers is not an object' };
  }
  const root = scanObject(text, skipWhitespace(text, 0)).node;
  const duplicateTop = duplicateKey(root);
  if (duplicateTop !== null) return { ok: false, reason: `duplicate key '${duplicateTop}'` };
  const servers = root.members.find((member) => member.key === 'mcpServers')?.node ?? null;
  const duplicateServer = servers ? duplicateKey(servers) : null;
  if (duplicateServer !== null) return { ok: false, reason: `duplicate key '${duplicateServer}'` };

  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const spansLines = text.slice(root.open, root.close).includes('\n');
  const unit = (spansLines && root.members.length && lineIndent(text, root.members[0].keyStart)) || '  ';
  attachLayout(text, root, null, unit);
  if (servers) attachLayout(text, servers, root, unit);
  return { ok: true, root, servers, eol, unit };
}

function renderValue(value, container, layout) {
  if (!container.multiline) return JSON.stringify(value);
  return JSON.stringify(value, null, layout.unit).split('\n').join(layout.eol + container.indent);
}

function renderMember(key, value, container, layout) {
  return `${JSON.stringify(key)}: ${renderValue(value, container, layout)}`;
}

function splice(text, start, end, inserted) {
  return text.slice(0, start) + inserted + text.slice(end);
}

/** `layout` is the readDocument result the container or member came from. */
function insertMember(text, container, key, value, layout) {
  const member = renderMember(key, value, container, layout);
  const last = container.members[container.members.length - 1];
  if (last) {
    const inserted = container.multiline ? `,${layout.eol}${container.indent}${member}` : `, ${member}`;
    return splice(text, last.valueEnd, last.valueEnd, inserted);
  }
  const inserted = container.multiline
    ? `${layout.eol}${container.indent}${member}${layout.eol}${container.closeIndent}`
    : member;
  return splice(text, container.open + 1, container.close, inserted);
}

function replaceValue(text, member, value, layout) {
  const container = layout.servers?.members.includes(member) ? layout.servers : layout.root;
  return splice(text, member.valueStart, member.valueEnd, renderValue(value, container, layout));
}

function removeMember(text, container, member) {
  const index = container.members.indexOf(member);
  if (index === -1) throw new Error(`member '${member.key}' is not in this container`);
  if (container.members.length === 1) return splice(text, container.open + 1, container.close, '');
  if (index < container.members.length - 1) return splice(text, member.keyStart, container.members[index + 1].keyStart, '');
  return splice(text, container.members[index - 1].valueEnd, member.valueEnd, '');
}

function renderNewDocument(entries) {
  return `${JSON.stringify({ mcpServers: Object.fromEntries(entries) }, null, 2)}\n`;
}

module.exports = { SKELETON, readDocument, insertMember, replaceValue, removeMember, renderNewDocument };
