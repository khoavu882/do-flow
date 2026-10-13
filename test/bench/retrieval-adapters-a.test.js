'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const a = require('../../bench/retrieval/lib/adapters-a.js');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '..', '..');
const CAPS = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'capabilities.json'), 'utf8')).capabilities;
const hasRg = spawnSync('rg', ['--version']).status === 0;
const posix = process.platform !== 'win32' ? false : 'stub executables need a POSIX shebang';

const RETRIEVAL_STUB = `'use strict';
module.exports = { tokenize: (t) => String(t).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length >= 2) };
`;

function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

function world(t, { semble = 'results', graphify = true, rtk = true } = {}) {
  const root = tempDir(t, 'doflow-adapter-a-');
  fs.mkdirSync(path.join(root, 'src', 'runtime', 'knowledge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'knowledge', 'retrieval.ts'), RETRIEVAL_STUB);
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const needleSymbol = 1;\n');
  const bin = tempDir(t, 'doflow-adapter-a-bin-');
  const bins = {};
  if (semble === 'results') {
    bins.semble = stub(bin, 'semble', `console.log(JSON.stringify({ query: 'q', results: [{ file_path: 'src/a.ts', start_line: 1, end_line: 3, score: 0.9, content: 'semantic hit body' }] }));`);
  } else if (semble === 'empty') {
    bins.semble = stub(bin, 'semble', `console.log(JSON.stringify({ query: 'q', results: [] }));`);
  } else bins.semble = 'doflow-no-such-semble-074';
  bins.graphify = graphify ? stub(bin, 'graphify', `
const [cmd] = process.argv.slice(2);
if (cmd === 'affected') { console.log('Affected nodes for x()\\nDepth: 2\\n- dep() [calls] src/dep.ts:L7\\n- other [imports] src/o.ts:L2'); }
else if (cmd === 'query') { console.log('Graph: x\\nNODE a [src=src/g.ts loc=L4 community=c]\\nNODE ref [src= loc= community=c]'); }
else if (cmd === 'update') { const fs = require('fs'); const p = require('path'); const d = p.join(process.argv[3], 'graphify-out'); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(p.join(d, 'graph.json'), '{}'); }
`) : 'doflow-no-such-graphify-074';
  bins.rtk = rtk ? stub(bin, 'rtk', `const fs = require('fs'); const f = process.argv[4]; console.log(fs.readFileSync(f, 'utf8').split('\\n')[0]);`) : 'doflow-no-such-rtk-074';
  return { root, bins, scratchDir: tempDir(t, 'doflow-adapter-a-scratch-'), semble: { env: undefined } };
}

const task = (over) => ({ query: 'where is needle', class: 'conceptual-discovery', expect: { result: ['RETRIEVED'] }, ...over });

test('capability routing: ranking classes by class, outcome classes by task.capability or semantic search', () => {
  assert.equal(a.capabilityFor({ class: 'exact-lookup' }), 'code.exact-search');
  assert.equal(a.capabilityFor({ class: 'conceptual-discovery', capability: 'x' }), 'code.semantic-search');
  assert.equal(a.capabilityFor({ class: 'impact-refactor' }), 'code.impact-analysis');
  assert.equal(a.capabilityFor({ class: 'stale-index', capability: 'code.relationships' }), 'code.relationships');
  assert.equal(a.capabilityFor({ class: 'dirty-tree' }), 'code.semantic-search');
});

test('semble answer: index provider, UNKNOWN freshness, score dropped, rtk compression recorded', { skip: posix }, (t) => {
  const w = world(t);
  const ans = a.runA({ task: task(), exportRoot: w.root, capabilities: CAPS, bins: w.bins, semble: w.semble, scratchDir: w.scratchDir });
  assert.equal(ans.result, 'RETRIEVED');
  assert.equal(ans.freshness, 'UNKNOWN');
  assert.deepEqual(ans.candidates.map((c) => [c.path, c.startLine, c.endLine, c.provider, c.rank]), [['src/a.ts', 1, 3, 'semble.search', 1]]);
  assert.ok(ans.candidates.every((c) => !('score' in c)));
  assert.equal(ans.payloadBytes, Buffer.byteLength('semantic hit body'));
  assert.equal(ans.compressedBytes, Buffer.byteLength('semantic hit body\n'));
  assert.deepEqual(ans.providers, [{ id: 'semble.search', state: 'reached' }, { id: 'rtk', state: 'reached' }]);
});

test('an empty answer from an index provider is UNVERIFIED, not EMPTY', { skip: posix }, (t) => {
  const w = world(t, { semble: 'empty' });
  const ans = a.runA({ task: task(), exportRoot: w.root, capabilities: CAPS, bins: w.bins, semble: w.semble, scratchDir: w.scratchDir });
  assert.equal(ans.result, 'UNVERIFIED');
  assert.equal(ans.freshness, 'UNKNOWN');
  assert.equal(ans.compressedBytes, undefined, 'nothing to compress');
});

test('a missing semble falls back to rg and records both providers', { skip: posix || (hasRg ? false : 'rg is not installed') }, (t) => {
  const w = world(t, { semble: 'missing' });
  const ans = a.runA({ task: task({ query: 'needleSymbol' }), exportRoot: w.root, capabilities: CAPS, bins: w.bins, semble: w.semble, scratchDir: w.scratchDir });
  assert.equal(ans.result, 'RETRIEVED');
  assert.equal(ans.freshness, 'NOT_APPLICABLE', 'the answer is the fallback live provider');
  assert.deepEqual(ans.providers.slice(0, 2), [{ id: 'semble.search', state: 'unreached', cause: 'binary absent' }, { id: 'native.rg', state: 'reached' }]);
  assert.equal(ans.candidates[0].path, 'src/a.ts');
});

test('setup.disable makes a provider unreached; with no fallback the answer is UNREACHED', { skip: posix }, (t) => {
  const w = world(t);
  const ans = a.runA({ task: task({ class: 'impact-refactor', literal: 'dep', setup: { disable: ['graphify.query'] } }), exportRoot: w.root, capabilities: CAPS, bins: w.bins, semble: w.semble, scratchDir: w.scratchDir });
  assert.equal(ans.result, 'UNREACHED');
  assert.deepEqual(ans.providers, [{ id: 'graphify.query', state: 'unreached', cause: 'disabled by setup.disable' }]);
  assert.deepEqual(ans.candidates, []);
});

test('graphify: impact lines parse path:L, other classes parse src= loc=, empty src is skipped', { skip: posix }, (t) => {
  const w = world(t);
  const impact = a.runA({ task: task({ class: 'impact-refactor', literal: 'dep' }), exportRoot: w.root, capabilities: CAPS, bins: w.bins, semble: w.semble, scratchDir: w.scratchDir });
  assert.deepEqual(impact.candidates.map((c) => [c.path, c.startLine, c.endLine]), [['src/dep.ts', 7, 7], ['src/o.ts', 2, 2]]);
  const rel = a.runA({ task: task({ class: 'dirty-tree', capability: 'code.relationships', setup: { patch: 'x' } }), exportRoot: w.root, capabilities: CAPS, bins: w.bins, semble: w.semble, scratchDir: w.scratchDir });
  assert.deepEqual(rel.candidates.map((c) => [c.path, c.startLine]), [['src/g.ts', 4]]);
  assert.equal(rel.freshness, 'UNKNOWN');
  const absent = a.runA({ task: task({ class: 'impact-refactor', literal: 'dep' }), exportRoot: w.root, capabilities: CAPS, bins: { ...w.bins, graphify: 'doflow-no-such-graphify-074' }, semble: w.semble, scratchDir: w.scratchDir });
  assert.equal(absent.result, 'UNREACHED');
});

test('without rtk compressedBytes is omitted and rtk is recorded unreached', { skip: posix }, (t) => {
  const w = world(t, { rtk: false });
  const ans = a.runA({ task: task(), exportRoot: w.root, capabilities: CAPS, bins: w.bins, semble: w.semble, scratchDir: w.scratchDir });
  assert.equal(ans.result, 'RETRIEVED');
  assert.equal('compressedBytes' in ans, false);
  assert.deepEqual(ans.providers.at(-1), { id: 'rtk', state: 'unreached', cause: 'binary absent' });
});

test('a stale index answers from indexRoot while live providers read exportRoot', { skip: posix }, (t) => {
  const w = world(t);
  const seen = [];
  const bin = tempDir(t, 'doflow-adapter-a-bin2-');
  const recorder = stub(bin, 'semble', `console.log(JSON.stringify({ results: [{ file_path: 'src/a.ts', start_line: 1, end_line: 1, content: process.argv[4] }] }));`);
  const indexRoot = tempDir(t, 'doflow-adapter-a-index-');
  a.runA({ task: task(), exportRoot: w.root, indexRoot, capabilities: CAPS, bins: { ...w.bins, semble: recorder }, semble: w.semble, scratchDir: w.scratchDir });
  const ans = a.runA({ task: task(), exportRoot: w.root, indexRoot, capabilities: CAPS, bins: { ...w.bins, semble: recorder }, semble: w.semble, scratchDir: w.scratchDir });
  seen.push(ans.candidates[0].snippet);
  assert.equal(seen[0], indexRoot, 'semble was pointed at the index root');
});

test('verification-failure: B returns raw output and exit code, A returns it compressed', { skip: posix }, (t) => {
  const w = world(t);
  const t1 = task({ class: 'verification-failure', setup: { command: [process.execPath, '-e', 'console.log("FAIL one"); console.error("boom"); process.exit(3)'] } });
  const raw = a.runVerification({ task: t1, root: w.root, config: 'B' });
  assert.equal(raw.exitCode, 3);
  assert.equal(raw.output, 'FAIL one\nboom\n');
  assert.equal(raw.result, 'RETRIEVED');
  assert.equal(raw.payloadBytes, Buffer.byteLength('FAIL one\nboom\n'));
  const packed = a.runA({ task: t1, exportRoot: w.root, bins: w.bins, scratchDir: w.scratchDir });
  assert.equal(packed.exitCode, 3);
  assert.equal(packed.output, 'FAIL one\n', 'the rtk stub keeps one line');
  assert.equal(packed.compressedBytes, Buffer.byteLength('FAIL one\n'));
  assert.equal(packed.payloadBytes, raw.payloadBytes);
  const missing = a.runVerification({ task: { setup: { command: ['doflow-no-such-cmd-074'] } }, root: w.root, config: 'B' });
  assert.equal(missing.result, 'UNREACHED');
});

test('buildIndexes times the builds, restores the probed file and reports unmeasured values for missing tools', { skip: posix }, (t) => {
  const w = world(t);
  const probe = path.join(w.root, 'src', 'a.ts');
  const before = fs.readFileSync(probe, 'utf8');
  const cache = tempDir(t, 'doflow-adapter-a-cache-');
  fs.writeFileSync(path.join(cache, 'blob'), '12345');
  const index = a.buildIndexes({ exportRoot: w.root, semble: { env: { ...process.env, SEMBLE_CACHE_DIR: cache } }, bins: w.bins, patchFile: probe });
  assert.equal(typeof index.buildMs, 'number');
  assert.equal(typeof index.incrementalMs, 'number');
  assert.equal(index.diskBytes, 2 + 5, 'graph.json plus the semble cache');
  assert.ok(typeof index.peakRssMB === 'number' || typeof index.peakRssMB.unmeasured === 'string');
  assert.equal(fs.readFileSync(probe, 'utf8'), before, 'the one-line patch is undone');

  const none = a.buildIndexes({ exportRoot: w.root, semble: { env: undefined }, bins: { graphify: 'doflow-no-such-graphify-074', semble: 'doflow-no-such-semble-074' }, patchFile: probe });
  assert.match(none.buildMs.unmeasured, /binary absent/);
  assert.ok(none.incrementalMs.unmeasured);
  assert.ok(none.diskBytes.unmeasured);
});

test('rssFromTime reads the darwin and linux /usr/bin/time formats', () => {
  assert.equal(a.rssFromTime('   0.01 real\n  10485760  maximum resident set size\n'), 10);
  assert.equal(a.rssFromTime('\tMaximum resident set size (kbytes): 20480\n'), 20);
  assert.equal(a.rssFromTime('nothing'), null);
});

test('extractIdentifier: deterministic extraction on sample queries', () => {
  assert.equal(a.extractIdentifier('which call sites depend on validateCapabilityProviders'), 'validateCapabilityProviders');
  assert.equal(a.extractIdentifier('what call sites depend on sanitizeRunEvent'), 'sanitizeRunEvent');
  assert.equal(a.extractIdentifier('where is Foo_Bar referenced'), 'Foo_Bar');
  assert.equal(a.extractIdentifier('who uses $schema in runtime'), '$schema');
  assert.equal(a.extractIdentifier('where is config.port defined'), 'config.port');
  assert.equal(a.extractIdentifier('does ProviderA call ProviderB'), 'ProviderB');
  assert.equal(a.extractIdentifier('what callers depend on searchGuidance?'), 'searchGuidance');
  assert.equal(a.extractIdentifier('who calls tokenize'), 'tokenize');
  assert.equal(a.extractIdentifier('If I rename foo what fails'), 'foo');
  assert.equal(a.extractIdentifier('What calls tokenize'), 'tokenize');
  assert.equal(a.extractIdentifier('Which callers depend on Registry'), 'Registry');
  assert.equal(a.extractIdentifier('What breaks if I change runVerb?'), 'runVerb');
});

test('graphify impact: the symbol, not the sentence, is passed to graphify affected', { skip: posix }, (t) => {
  const w = world(t);
  const bin = tempDir(t, 'doflow-adapter-a-symbin-');
  const recorder = stub(bin, 'graphify', `
const [cmd, target] = process.argv.slice(2);
if (cmd === 'affected') {
  if (target === 'validateCapabilityProviders') {
    console.log('Affected nodes for validateCapabilityProviders()\\n- dep() [calls] src/dep.ts:L7');
  } else {
    console.log('UNEXPECTED: ' + target);
  }
}
`);
  const ans = a.runA({
    task: task({ class: 'impact-refactor', query: 'which call sites depend on validateCapabilityProviders' }),
    exportRoot: w.root, capabilities: CAPS, bins: { ...w.bins, graphify: recorder }, semble: w.semble, scratchDir: w.scratchDir,
  });
  assert.equal(ans.result, 'RETRIEVED');
  assert.equal(ans.candidates.length, 1);
  assert.equal(ans.candidates[0].path, 'src/dep.ts');
});

test('graphify impact: a stub graphify printing No unique node match yields unreached', { skip: posix }, (t) => {
  const w = world(t);
  const bin = tempDir(t, 'doflow-adapter-a-nomatch-');
  const noMatch = stub(bin, 'graphify', `
const [cmd] = process.argv.slice(2);
if (cmd === 'affected') {
  console.log('No unique node match for missingSymbol');
}
`);
  const ans = a.runA({
    task: task({ class: 'impact-refactor', query: 'which call sites depend on missingSymbol' }),
    exportRoot: w.root, capabilities: CAPS, bins: { ...w.bins, graphify: noMatch }, semble: w.semble, scratchDir: w.scratchDir,
  });
  assert.equal(ans.result, 'UNREACHED');
  assert.equal(ans.providers[0].id, 'graphify.query');
  assert.equal(ans.providers[0].state, 'unreached');
  assert.equal(ans.providers[0].cause, 'No unique node match');
});
