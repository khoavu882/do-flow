'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

test('toEvidence measures tree state with one status spawn for multiple file items', (t) => {
  const root = tempDir(t, 'doflow-sv-spawns-');
  const realExecFileSync = childProcess.execFileSync;
  realExecFileSync('git', ['-C', root, 'init', '-q']);
  realExecFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  realExecFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(root, 'base.txt'), 'base\n');
  realExecFileSync('git', ['-C', root, 'add', 'base.txt']);
  realExecFileSync('git', ['-C', root, 'commit', '-m', 'initial'], { stdio: 'ignore' });
  let statusSpawns = 0;
  let revParseSpawns = 0;
  childProcess.execFileSync = function (file, args, options) {
    if (file === 'git' && args.includes('status')) statusSpawns++;
    if (file === 'git' && args.includes('rev-parse')) revParseSpawns++;
    return realExecFileSync.call(this, file, args, options);
  };

  try {
    const { toEvidence } = require('../../src/runtime/candidate.ts');
    const { clearTreeStateCache } = require('../../src/runtime/source-version.ts');
    clearTreeStateCache();
    for (const name of ['one.js', 'two.js', 'three.js']) {
      fs.writeFileSync(path.join(root, name), `${name}\n`);
      toEvidence({ item: {
        kind: 'semantic-retrieval',
        provenance: 'extracted',
        source: { provider: 'test', capability: 'inspection' },
        locator: { file: name },
        content: `${name} content`,
        establishes: ['test claim'],
      } }, { taskId: 'task-1', root });
    }
    assert.equal(statusSpawns, 1, 'three items should share one status measurement');
    assert.equal(revParseSpawns, 0, 'successful status must not spawn rev-parse');
  } finally {
    childProcess.execFileSync = realExecFileSync;
  }
});
