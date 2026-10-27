'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { printContext } = require('../../src/install/context.ts');

test('printContext names the adapter as the resolver for a target with no install dir (antigravity)', () => {
  const lines: string[] = [];
  const original = console.error;
  console.error = (text: string) => { lines.push(String(text)); };
  try {
    printContext({
      scope: 'project',
      scopeRoot: '/tmp/p',
      targets: ['claude', 'antigravity'],
      dirs: { claude: '/tmp/p/.claude', antigravity: undefined },
      repoRoot: '/tmp/r',
      sourceCommit: 'abc',
      nodeVersion: 'v0',
    });
  } finally {
    console.error = original;
  }
  const out = lines.join('\n');
  assert.ok(!out.includes('undefined'), out);
  assert.match(out, /antigravity-> \(resolved by adapter\)/);
  assert.match(out, /claude\s+-> \/tmp\/p\/\.claude/);
});
