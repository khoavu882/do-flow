'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mergeSettings, settingsContains, stripManagedSettings } = require('../../src/helper/settings-merge');

const managedSettings = () => JSON.parse(
  fs.readFileSync(path.join(__dirname, '../..', 'core/harnesses/claude/settings/settings.json'), 'utf8'),
);

// Regression: one script legitimately registered under several matchers for the same event
// (post-edit-lint.sh on both `Edit` and `Write`). An identity keyed on commands alone makes those
// entries indistinguishable, so the merge collapses them and one hook silently stops firing --
// and because verification shares the comparator, it cannot see its own omission.
test('merging preserves every managed hook entry, including one command under multiple matchers', () => {
  const managed = managedSettings();
  const merged = mergeSettings({ model: 'user-choice' }, managed);

  for (const [event, entries] of Object.entries(managed.hooks)) {
    assert.equal(merged.hooks[event].length, entries.length,
      `event '${event}' must keep all ${entries.length} managed entries`);
    for (const entry of entries) {
      assert.ok(
        merged.hooks[event].some((m) => (m.matcher ?? null) === (entry.matcher ?? null)
          && JSON.stringify(m.hooks) === JSON.stringify(entry.hooks)),
        `event '${event}' lost the entry for matcher '${entry.matcher}'`,
      );
    }
  }
});

test('verification detects a dropped managed hook entry rather than reporting containment', () => {
  const managed = managedSettings();
  const damaged = mergeSettings({}, managed);
  damaged.hooks.PostToolUse = damaged.hooks.PostToolUse.slice(0, 1);   // drop matcher=Write
  assert.equal(settingsContains(damaged, managed), false,
    'containment must fail when a managed entry is missing, even if another shares its command');
});

test('a foreign hook on a DoFlow-managed event survives merge and remove', () => {
  const managed = managedSettings();
  const foreign = { matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool hook' }] };
  const existing = { model: 'user-choice', hooks: { PreToolUse: [foreign] } };

  const merged = mergeSettings(existing, managed);
  assert.ok(merged.hooks.PreToolUse.some((e) => e.hooks[0].command === 'other-tool hook'));

  const remaining = stripManagedSettings(merged, managed);
  assert.equal(remaining.model, 'user-choice');
  assert.deepEqual(remaining.hooks.PreToolUse, [foreign], 'only DoFlow entries are stripped');
});
