'use strict';

// 181 E.1 (IC-007, FR-011): the feature map reader reads the project's map and the feature's map,
// uses neither copy of a flow id found in both, and reports each invalid shape as a finding.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../../helper/tmp.ts');
const { readFeatureMap } = require('../../../src/runtime/verification/feature-map.ts');

const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const flow = (over: any = {}) => ({ id: 'login', title: 'A user logs in', expect: 'the dashboard shows', ...over });

function project(t: any, doc: any, featureDoc: any = null) {
  const root = tempDir(t, 'doflow-feature-map-');
  const featureDir = path.join(root, 'agent-docs', 'doflow', 'feat');
  if (doc !== null) write(path.join(root, '.doflow', 'feature-map.json'), typeof doc === 'string' ? doc : JSON.stringify(doc));
  if (featureDoc !== null) write(path.join(featureDir, 'test', 'feature-map.json'), JSON.stringify(featureDoc));
  return { root, featureDir };
}
const read = (p: any) => readFeatureMap({ root: p.root, featureDir: p.featureDir });
const withFlows = (...flows: any[]) => ({ version: 1, flows });

test('valid maps parse, with the defaults of IC-007 filled in', (t) => {
  const p = project(t, withFlows(
    flow({ drive: { kind: 'command', argv: ['node', '-e', '0'] } }),
    flow({ id: 'pay', critical: true, property: 'no double charge', concurrency: true, drive: { kind: 'browser', start: 'http://localhost:3000', steps: 'Open the cart and pay.' } }),
  ), withFlows(flow({ id: 'extra' })));
  const map = read(p);
  assert.equal(map.featureMap, 'present');
  assert.deepEqual(map.problems, []);
  assert.deepEqual(map.flows.map((f: any) => f.id), ['login', 'pay', 'extra']);
  assert.deepEqual(map.flows[0], { id: 'login', title: 'A user logs in', expect: 'the dashboard shows', drive: { kind: 'command', argv: ['node', '-e', '0'] }, critical: false, property: null, concurrency: false });
  assert.deepEqual([map.flows[1].critical, map.flows[1].property, map.flows[1].concurrency], [true, 'no double charge', true]);
  assert.equal(map.flows[2].drive, null);
});

test('no map file is absent, and a missing feature folder reads the project map alone', (t) => {
  assert.deepEqual(read(project(t, null)), { featureMap: 'absent', flows: [], problems: [] });
  const alone = readFeatureMap({ root: project(t, withFlows(flow())).root, featureDir: null });
  assert.equal(alone.featureMap, 'present');
});

test('a flow id in both maps is a finding and neither copy is used', (t) => {
  const map = read(project(t, withFlows(flow(), flow({ id: 'solo' })), withFlows(flow({ title: 'Other' }), flow({ id: 'extra' }))));
  assert.equal(map.featureMap, 'invalid');
  assert.deepEqual(map.flows.map((f: any) => f.id), ['solo', 'extra']);
  assert.match(map.problems.join('\n'), /flow id 'login' is in both feature maps; neither copy is used/);
});

const INVALID: Array<[string, any, RegExp]> = [
  ['an id that breaks the pattern', withFlows(flow({ id: 'Login' })), /id must match/],
  ['an id over 48 characters', withFlows(flow({ id: 'a'.repeat(49) })), /id must match/],
  ['a title over 200 characters', withFlows(flow({ title: 'x'.repeat(201) })), /title must be at most 200 characters/],
  ['an expect over one line', withFlows(flow({ expect: 'a\nb' })), /expect must be one line/],
  ['a missing expect', withFlows({ id: 'login', title: 'T' }), /expect must be a non-empty string/],
  ['an unknown flow key', withFlows(flow({ owner: 'me' })), /flow 'login' has unknown key 'owner'/],
  ['a drive of an unknown kind', withFlows(flow({ drive: { kind: 'ssh' } })), /drive.kind must be 'command' or 'browser'/],
  ['a command drive with no argv', withFlows(flow({ drive: { kind: 'command', argv: [] } })), /drive.argv must be a non-empty array/],
  ['a command drive with a non-string argv word', withFlows(flow({ drive: { kind: 'command', argv: ['node', 1] } })), /drive.argv must be a non-empty array/],
  ['a drive with an unknown key', withFlows(flow({ drive: { kind: 'command', argv: ['a'], shell: true } })), /drive has unknown key 'shell'/],
  ['a browser drive with no start', withFlows(flow({ drive: { kind: 'browser', steps: 's' } })), /drive.start must be a non-empty/],
  ['a browser drive with two paragraphs', withFlows(flow({ drive: { kind: 'browser', start: '/', steps: 'a\n\nb' } })), /drive.steps must be one paragraph/],
  ['a critical that is not a boolean', withFlows(flow({ critical: 'yes' })), /critical must be true or false/],
  ['a property over one line', withFlows(flow({ property: 'a\nb' })), /property must be one line/],
  ['a duplicate id in one file', withFlows(flow(), flow()), /flow id 'login' appears twice/],
  ['an unknown top-level key', { version: 1, flows: [], extra: 1 }, /unknown key 'extra'/],
  ['version 2', { version: 2, flows: [] }, /expected \{ "version": 1, "flows": \[...\] \}/],
  ['more than 64 flows', withFlows(...Array.from({ length: 65 }, (_, i) => flow({ id: `f${i}` }))), /65 flows; at most 64 are allowed/],
  ['text that is not JSON', '{ nope', /is not valid JSON/],
];
for (const [name, doc, pattern] of INVALID) {
  test(`${name} is a finding`, (t) => {
    const map = read(project(t, doc));
    assert.equal(map.featureMap, 'invalid');
    assert.match(map.problems.join('\n'), pattern);
    assert.match(map.problems[0], /^\.doflow\/feature-map\.json: /);
  });
}

test('exactly 64 flows are accepted, and a flow with a finding is left out while its siblings stay', (t) => {
  assert.equal(read(project(t, withFlows(...Array.from({ length: 64 }, (_, i) => flow({ id: `f${i}` }))))).featureMap, 'present');
  const map = read(project(t, withFlows(flow({ id: 'bad', critical: 1 }), flow({ id: 'good' }))));
  assert.deepEqual(map.flows.map((f: any) => f.id), ['good']);
  assert.equal(map.featureMap, 'invalid');
});

test('a finding in the feature map names that file', (t) => {
  const map = read(project(t, withFlows(flow()), withFlows(flow({ id: 'BAD' }))));
  assert.match(map.problems[0], /^test\/feature-map\.json: flow 'BAD' id must match/);
});
