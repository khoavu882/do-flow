'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { readMappings } = require('../src/mappings');
const { resolveTargets, VALID, toolDirs } = require('../src/targets');
const { planFiles } = require('../src/copy');

const REPO = path.resolve(__dirname, '..');
const MAP = path.join(REPO, 'bin', 'mappings.conf');

test('readMappings parses the claude section', () => {
  const m = readMappings(MAP, 'claude');
  assert.ok(m.length > 5, 'expected several claude mappings');
  assert.ok(m.every((x) => x.src && x.dst), 'every entry has src+dst');
  assert.ok(m.some((x) => x.src === 'core/agents/' && x.dst === 'agents/'));
  assert.ok(m.some((x) => x.dst === 'CLAUDE.md'));
});

test('readMappings codex is a subset (no skills)', () => {
  const c = readMappings(MAP, 'codex');
  assert.ok(c.length >= 3);
  assert.ok(!c.some((x) => x.dst === 'skills/'), 'codex must not get skills');
});

test('resolveTargets defaults to all and validates', () => {
  assert.deepStrictEqual(resolveTargets([]), VALID);
  assert.deepStrictEqual(resolveTargets(['claude']), ['claude']);
  assert.throws(() => resolveTargets(['bogus']), /Unknown target/);
});

test('planFiles yields tool-prefixed dest paths', () => {
  const files = planFiles(REPO, readMappings(MAP, 'claude'), 'claude');
  assert.ok(files.length > 10);
  assert.ok(files.every((f) => f.startsWith('claude/')), 'all dest paths tool-prefixed');
  assert.ok(files.includes('claude/CLAUDE.md'));
});

test('readMappings gemini includes skills and modes', () => {
  const g = readMappings(MAP, 'gemini');
  assert.ok(g.some((x) => x.dst === 'skills/'), 'gemini must include skills');
  assert.ok(g.some((x) => x.dst === 'modes/'), 'gemini must include modes');
});

test('toolDirs defaults to project scope rooted at projectRoot', () => {
  const dirs = toolDirs({ projectRoot: '/tmp/some-project' });
  assert.strictEqual(dirs.claude, '/tmp/some-project/.claude');
  assert.strictEqual(dirs.codex, '/tmp/some-project/.codex');
  assert.strictEqual(dirs.gemini, '/tmp/some-project/.agents');
});

test('toolDirs defaults projectRoot to cwd when omitted', () => {
  const dirs = toolDirs();
  assert.strictEqual(dirs.claude, path.join(process.cwd(), '.claude'));
});

test('toolDirs global:true resolves under $HOME (sync.sh parity)', () => {
  const dirs = toolDirs({ global: true });
  assert.strictEqual(dirs.claude, path.join(os.homedir(), '.claude'));
  assert.strictEqual(dirs.codex, path.join(os.homedir(), '.codex'));
});
