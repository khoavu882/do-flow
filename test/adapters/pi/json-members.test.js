'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SKELETON, readDocument, insertMember, replaceValue, removeMember, renderNewDocument } = require('../../../src/adapters/pi/json-members');

const ENTRY = { command: 'npx', args: ['-y', 'pkg'] };

function read(text) {
  const doc = readDocument(text);
  assert.equal(doc.ok, true, doc.reason);
  return doc;
}

function member(container, key) { return container.members.find((item) => item.key === key); }

/** The only bytes an edit may add sit at one point: everything before it and everything after it is
 * the original text, unchanged. */
function assertSplicedAt(original, result, point) {
  assert.equal(result.slice(0, point), original.slice(0, point));
  assert.equal(result.slice(result.length - (original.length - point)), original.slice(point));
}

test('J1: a file without mcpServers gains the key at the end of the top-level object, every other byte kept', () => {
  const text = '{\n  "theme": "dark",\n  "nested": { "keep": [1, 2] }\n}\n';
  const doc = read(text);
  assert.equal(doc.servers, null);
  const result = insertMember(text, doc.root, 'mcpServers', { context7: ENTRY }, doc);
  assertSplicedAt(text, result, doc.root.members[1].valueEnd);
  assert.deepEqual(JSON.parse(result), { theme: 'dark', nested: { keep: [1, 2] }, mcpServers: { context7: ENTRY } });
  assert.equal(result, '{\n  "theme": "dark",\n  "nested": { "keep": [1, 2] },\n  "mcpServers": {\n    "context7": {\n      "command": "npx",\n      "args": [\n        "-y",\n        "pkg"\n      ]\n    }\n  }\n}\n');
});

test('J2: an insert into a populated mcpServers keeps the bytes on both sides of the insertion point', () => {
  const text = '{\n  "mcpServers": {\n    "mine": {"command": "my-server"}\n  },\n  "after": true\n}\n';
  const doc = read(text);
  const point = doc.servers.members[0].valueEnd;
  const result = insertMember(text, doc.servers, 'context7', ENTRY, doc);
  assertSplicedAt(text, result, point);
  assert.deepEqual(Object.keys(JSON.parse(result).mcpServers), ['mine', 'context7']);
  // A second run finds the member already present with the desired value: nothing to edit.
  const again = read(result);
  assert.deepEqual(member(again.servers, 'context7').value, ENTRY);
});

test('J3: four-space and tab indentation are inferred for the inserted member and its nested lines', () => {
  const four = '{\n    "mcpServers": {\n        "mine": {\n            "command": "x"\n        }\n    }\n}\n';
  let doc = read(four);
  assert.equal(doc.unit, '    ');
  const fourResult = insertMember(four, doc.servers, 'c', { command: 'y', args: ['a'] }, doc);
  assert.ok(fourResult.includes(',\n        "c": {\n            "command": "y",\n            "args": [\n                "a"\n            ]\n        }\n    }\n}\n'), fourResult);

  const tabs = '{\n\t"mcpServers": {\n\t\t"mine": {\n\t\t\t"command": "x"\n\t\t}\n\t}\n}\n';
  doc = read(tabs);
  assert.equal(doc.unit, '\t');
  const tabResult = insertMember(tabs, doc.servers, 'c', { command: 'y' }, doc);
  assert.ok(tabResult.includes(',\n\t\t"c": {\n\t\t\t"command": "y"\n\t\t}\n\t}\n}\n'), tabResult);
});

test('J4: a single-line file receives a single-line member joined with ", "', () => {
  const text = '{"mcpServers": {"mine": {"command": "x"}}, "z": 1}';
  const doc = read(text);
  const result = insertMember(text, doc.servers, 'c', { command: 'y' }, doc);
  assert.equal(result, '{"mcpServers": {"mine": {"command": "x"}, "c": {"command":"y"}}, "z": 1}');
  const bare = '{"z": 1}';
  const bareDoc = read(bare);
  assert.equal(insertMember(bare, bareDoc.root, 'mcpServers', { c: { command: 'y' } }, bareDoc), '{"z": 1, "mcpServers": {"c":{"command":"y"}}}');
});

test('J5: a CRLF file receives CRLF line endings in the inserted text', () => {
  const text = '{\r\n  "mcpServers": {\r\n    "mine": {\r\n      "command": "x"\r\n    }\r\n  }\r\n}\r\n';
  const doc = read(text);
  assert.equal(doc.eol, '\r\n');
  const result = insertMember(text, doc.servers, 'c', { command: 'y', args: ['a'] }, doc);
  assert.equal(result.replace(/\r\n/g, '').includes('\n'), false, 'no bare LF may be introduced');
  assert.deepEqual(JSON.parse(result).mcpServers.c, { command: 'y', args: ['a'] });
  const emptyServers = '{\r\n  "mcpServers": {}\r\n}\r\n';
  const emptyDoc = read(emptyServers);
  assert.equal(insertMember(emptyServers, emptyDoc.servers, 'c', { command: 'y' }, emptyDoc),
    '{\r\n  "mcpServers": {\r\n    "c": {\r\n      "command": "y"\r\n    }\r\n  }\r\n}\r\n');
});

test('J6: replacing a value keeps the key, its indentation and every other byte', () => {
  const text = '{\n  "mcpServers": {\n    "a": {"command": "old"},\n    "b":   {"command": "keep"}\n  }\n}\n';
  const doc = read(text);
  const target = member(doc.servers, 'a');
  const result = replaceValue(text, target, { command: 'new' }, doc);
  assert.equal(result.slice(0, target.valueStart), text.slice(0, target.valueStart));
  assert.equal(result.slice(result.length - (text.length - target.valueEnd)), text.slice(target.valueEnd));
  assert.equal(result, '{\n  "mcpServers": {\n    "a": {\n      "command": "new"\n    },\n    "b":   {"command": "keep"}\n  }\n}\n');
});

test('J7: removing a middle, a last and an only member; a DoFlow-created file returns to the skeleton', () => {
  const text = '{\n  "mcpServers": {\n    "a": 1,\n    "b": 2,\n    "c": 3\n  }\n}\n';
  let doc = read(text);
  const middle = removeMember(text, doc.servers, member(doc.servers, 'b'));
  assert.equal(middle, '{\n  "mcpServers": {\n    "a": 1,\n    "c": 3\n  }\n}\n');
  doc = read(middle);
  const last = removeMember(middle, doc.servers, member(doc.servers, 'c'));
  assert.equal(last, '{\n  "mcpServers": {\n    "a": 1\n  }\n}\n');
  doc = read(last);
  assert.equal(removeMember(last, doc.servers, member(doc.servers, 'a')), '{\n  "mcpServers": {}\n}\n');

  const created = renderNewDocument([['context7', ENTRY], ['sequential-thinking', { command: 'npx' }]]);
  doc = read(created);
  let next = removeMember(created, doc.servers, member(doc.servers, 'context7'));
  doc = read(next);
  next = removeMember(next, doc.servers, member(doc.servers, 'sequential-thinking'));
  assert.equal(next, SKELETON);
  assert.equal(renderNewDocument([]), SKELETON);
});

test('J8: a duplicate top-level key and a duplicate server key each return the duplicate refusal', () => {
  assert.deepEqual(readDocument('{"x": 1, "mcpServers": {}, "x": 2}'), { ok: false, reason: "duplicate key 'x'" });
  assert.deepEqual(readDocument('{"mcpServers": {"s": {"command": "a"}, "s": {"command": "b"}}}'), { ok: false, reason: "duplicate key 's'" });
  // JSON.parse keeps the last mcpServers; a splice could edit the first, so it is refused too.
  assert.deepEqual(readDocument('{"mcpServers": {"a": 1}, "mcpServers": {}}'), { ok: false, reason: "duplicate key 'mcpServers'" });
});

test('J9: keys and strings holding escaped quotes, backslashes, braces and commas are spanned correctly', () => {
  const text = '{\n  "we\\"ird{,}": "va\\\\l\\"ue}, {",\n  "mcpServers": {\n    "s\\\\": {"command": "a\\"}", "args": ["]", "{,"]}\n  }\n}\n';
  const doc = read(text);
  assert.deepEqual(doc.root.members.map((item) => item.key), ['we"ird{,}', 'mcpServers']);
  assert.equal(doc.root.members[0].value, 'va\\l"ue}, {');
  assert.deepEqual(member(doc.servers, 's\\').value, { command: 'a"}', args: [']', '{,'] });
  const result = insertMember(text, doc.servers, 'c', { command: 'y' }, doc);
  assert.deepEqual(JSON.parse(result), { 'we"ird{,}': 'va\\l"ue}, {', mcpServers: { 's\\': { command: 'a"}', args: [']', '{,'] }, c: { command: 'y' } } });
  const after = read(result);
  assert.equal(removeMember(result, after.servers, member(after.servers, 'c')), text);
});

test('J10: invalid JSON, a top-level array and a string mcpServers each return their refusal', () => {
  const invalid = readDocument('{"mcpServers": {,}');
  assert.equal(invalid.ok, false);
  assert.match(invalid.reason, /^invalid JSON( at line \d+ column \d+)?$/);
  assert.equal(readDocument('﻿{}').ok, false, 'a byte-order mark fails JSON.parse');
  assert.deepEqual(readDocument('[{"mcpServers": {}}]'), { ok: false, reason: 'top level is not an object' });
  assert.deepEqual(readDocument('"text"'), { ok: false, reason: 'top level is not an object' });
  assert.deepEqual(readDocument('{"mcpServers": "x"}'), { ok: false, reason: 'mcpServers is not an object' });
  assert.deepEqual(readDocument('{"mcpServers": []}'), { ok: false, reason: 'mcpServers is not an object' });
  assert.deepEqual(readDocument('{"mcpServers": null}'), { ok: false, reason: 'mcpServers is not an object' });
});

test('J10: an invalid-JSON refusal names a position, never the text around it', () => {
  const secret = 'SECRET-XYZ123';
  const cases = [
    `{"mcpServers": {"x": {"env": {"TOKEN": "${secret}" oops}}}}`,
    `{"mcpServers": {"x": {"env": {"TOKEN": "${secret}",}}}}`,
    `{"token": ${secret}}`,
    `{\n  "token": "${secret}"\n  "next": 1\n}`,
  ];
  for (const text of cases) {
    const { ok, reason } = readDocument(text);
    assert.equal(ok, false);
    assert.ok(!reason.includes('SECRET') && !reason.includes('XYZ'), reason);
    assert.match(reason, /^invalid JSON( at line \d+ column \d+)?$/);
  }
  assert.equal(readDocument(cases[3]).reason, 'invalid JSON at line 3 column 3');
});

test('J11: 3000 nested objects scan without exhausting the stack, at the top level and inside a server', () => {
  const deep = `${'{"a":'.repeat(3000)}1${'}'.repeat(3000)}`;
  const top = readDocument(`{"deep": ${deep}, "mcpServers": {}}`);
  assert.equal(top.ok, true, top.reason);
  assert.deepEqual(top.root.members.map((item) => item.key), ['deep', 'mcpServers']);
  const inServer = readDocument(`{"mcpServers": {"deep": ${deep}}}`);
  assert.equal(inServer.ok, true, inServer.reason);
  assert.deepEqual(inServer.servers.members.map((item) => item.key), ['deep']);
  const next = insertMember(`{"mcpServers": {"deep": ${deep}}}`, inServer.servers, 'c', { command: 'y' }, inServer);
  assert.ok(next.endsWith(`${'}'.repeat(3000)}, "c": {"command":"y"}}}`));
});
