'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('./bash-locator.ts');
const { tempDir } = require('./tmp.ts');
const { boundedSpawnSync } = require('./bounded-spawn.ts');

function sleeperCount(marker: string) {
  const out = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' });
  return (out.stdout || '').split('\n').filter(Boolean).length;
}

test('a bridge command that never exits is killed at the timeout and fails with a message naming it and carrying stderr', { skip: process.platform === 'win32' }, (t: any) => {
  const dir = tempDir(t, 'doflow-bounded-spawn-');
  const marker = `doflow-bounded-sleep-${process.pid}`;
  const bridge = path.join(dir, 'bridge.sh');
  // Holds the pipes open through a grandchild too, as a bridge that forks a policy does.
  fs.writeFileSync(bridge, `#!/bin/bash\necho partial-out\necho hung-bridge-stderr >&2\nexec -a ${marker} sleep 600 &\nwait\n`);
  fs.chmodSync(bridge, 0o755);
  const started = Date.now();
  assert.throws(
    () => boundedSpawnSync(bashPath(), [bridge, 'claude', 'PreToolUse'], { cwd: dir, encoding: 'utf8', timeout: 1500 }),
    (err: any) => /timed out after 1500 ms/.test(err.message) && err.message.includes('hung-bridge-stderr') && err.message.includes('partial-out'),
  );
  assert.ok(Date.now() - started < 20000, 'the call returned long before the sleeper would have');
  const left = sleeperCount(marker);
  if (left) spawnSync('pkill', ['-f', marker]);
  assert.equal(left, 0, 'no sleeper process is left');
});

test('a child that exits normally returns the spawnSync result unchanged', () => {
  const r = boundedSpawnSync(bashPath(), ['-c', 'echo ok; exit 3'], { encoding: 'utf8' });
  assert.deepEqual([r.status, r.stdout], [3, 'ok\n']);
});
