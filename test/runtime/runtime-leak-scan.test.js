'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { scanPaths, LEAK_PATTERNS } = require('../../src/runtime/leak-scan');

function tmpRepo(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-leak-'));
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(root, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body, 'utf8');
  }
  return root;
}

test('a requirement item reference in a shipped file is reported with file and line', () => {
  const root = tmpRepo({ 'openapi/users.yaml': 'summary: List users\ndescription: Implements FR-001\n' });
  const { findings } = scanPaths({ paths: ['openapi/users.yaml'], repoRoot: root });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, path.join('openapi', 'users.yaml'));
  assert.equal(findings[0].line, 2);
  assert.equal(findings[0].text, 'FR-001');
  assert.equal(findings[0].pattern, 'requirement-item');
});

test('the same text inside the artifact directory is correct usage and is not reported', () => {
  const root = tmpRepo({ 'agent-docs/doflow/001-x/requirement.md': 'FR-001 and agent-docs/ everywhere\n' });
  const result = scanPaths({ paths: ['agent-docs/doflow/001-x/requirement.md'], repoRoot: root });
  assert.equal(result.findings.length, 0);
  assert.deepEqual(result.unscanned, [{ file: path.join('agent-docs', 'doflow', '001-x', 'requirement.md'), reason: 'excluded' }]);
});

test('every declared pattern is detectable', () => {
  const root = tmpRepo({
    'ship.md': [
      'traces to FR-001',
      'and NFR-002',
      'story US3',
      'see agent-docs/doflow/x',
      'stored in .doflow/state/evidence',
      'per design.md section 4',
    ].join('\n'),
  });
  const { findings } = scanPaths({ paths: ['ship.md'], repoRoot: root });
  const seen = new Set(findings.map((f) => f.pattern));
  for (const rule of LEAK_PATTERNS) assert.ok(seen.has(rule.id), `pattern '${rule.id}' produced no finding`);
});

test('C# is not reported as a DoFlow component reference', () => {
  const root = tmpRepo({ 'ship.md': 'Written in C# for the .NET runtime. See also C1 and C2 grades.\n' });
  const { findings } = scanPaths({ paths: ['ship.md'], repoRoot: root });
  assert.deepEqual(findings, []);
});

test('a clean file is scanned and produces nothing', () => {
  const root = tmpRepo({ 'ship.md': 'A perfectly ordinary document.\n' });
  const result = scanPaths({ paths: ['ship.md'], repoRoot: root });
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.scanned, ['ship.md']);
  assert.deepEqual(result.unscanned, []);
});

test('an unreadable path is reported as unscanned, never dropped and never fatal', () => {
  const root = tmpRepo({ 'ship.md': 'ok\n' });
  const result = scanPaths({ paths: ['ship.md', 'gone.md'], repoRoot: root });
  assert.deepEqual(result.scanned, ['ship.md']);
  assert.deepEqual(result.unscanned, [{ file: 'gone.md', reason: 'not-a-file' }]);
});

test('a directory given as a path is reported rather than read', () => {
  const root = tmpRepo({ 'sub/ship.md': 'ok\n' });
  const result = scanPaths({ paths: ['sub'], repoRoot: root });
  assert.deepEqual(result.unscanned, [{ file: 'sub', reason: 'not-a-file' }]);
});

test('every path given is accounted for exactly once', () => {
  const root = tmpRepo({ 'a.md': 'FR-001\n', 'b.md': 'clean\n', 'agent-docs/c.md': 'FR-002\n' });
  const result = scanPaths({ paths: ['a.md', 'b.md', 'agent-docs/c.md', 'missing.md'], repoRoot: root });
  const accounted = new Set([...result.scanned, ...result.unscanned.map((u) => u.file)]);
  assert.equal(accounted.size, 4);
});

test('multiple findings on separate lines are all reported', () => {
  const root = tmpRepo({ 'ship.md': 'FR-001\nclean\nFR-002\n' });
  const { findings } = scanPaths({ paths: ['ship.md'], repoRoot: root });
  assert.deepEqual(findings.map((f) => f.line), [1, 3]);
});

test('no paths yields an empty result rather than an error', () => {
  const result = scanPaths({ paths: [], repoRoot: '/nonexistent' });
  assert.deepEqual(result, { findings: [], scanned: [], unscanned: [] });
});

test('extra excluded segments narrow the scan without replacing the artifact exclusion', () => {
  const root = tmpRepo({
    'ship/spec.yaml': 'FR-001\n',
    'vendor/impl.js': 'FR-002\n',
    'agent-docs/x.md': 'FR-003\n',
  });
  const result = scanPaths({
    paths: ['ship/spec.yaml', 'vendor/impl.js', 'agent-docs/x.md'],
    repoRoot: root,
    excludedSegments: ['agent-docs', 'vendor'],
  });
  assert.deepEqual(result.findings.map((f) => f.text), ['FR-001']);
  assert.deepEqual(
    result.unscanned.map((u) => u.reason).sort(),
    ['excluded', 'excluded'],
    'an excluded path is reported as unscanned, never dropped',
  );
});
