'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { rewriteHookPathsForProjectScope } = require('../src/settings-scope');

function scratchDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-settingsscope-'));
}

test('rewriteHookPathsForProjectScope replaces ~/.claude/hooks/ with ${CLAUDE_PROJECT_DIR}/.claude/hooks/', () => {
  const dir = scratchDir();
  const file = path.join(dir, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/session-start.sh' }] }],
      SubagentStart: [{ matcher: '.*', hooks: [{ type: 'command', command: '~/.claude/hooks/subagent-audit.sh' }] }],
    },
  }));

  const changed = rewriteHookPathsForProjectScope(file);
  assert.strictEqual(changed, true);

  const result = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.strictEqual(result.hooks.SessionStart[0].hooks[0].command, '${CLAUDE_PROJECT_DIR}/.claude/hooks/session-start.sh');
  assert.strictEqual(result.hooks.SubagentStart[0].hooks[0].command, '${CLAUDE_PROJECT_DIR}/.claude/hooks/subagent-audit.sh');
});

test('rewriteHookPathsForProjectScope is idempotent (already-rewritten file is a no-op)', () => {
  const dir = scratchDir();
  const file = path.join(dir, 'settings.json');
  const already = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PROJECT_DIR}/.claude/hooks/session-start.sh' }] }] } });
  fs.writeFileSync(file, already);

  const changed = rewriteHookPathsForProjectScope(file);
  assert.strictEqual(changed, false);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), already);
});

test('rewriteHookPathsForProjectScope returns false for a missing file', () => {
  assert.strictEqual(rewriteHookPathsForProjectScope('/nonexistent/settings.json'), false);
});
