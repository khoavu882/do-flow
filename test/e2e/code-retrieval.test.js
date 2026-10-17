'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.resolve(__dirname, '../../bin/doflow.js');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'code-retrieve-cli-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src/auth.js'), 'function parseToken() { return true; }\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('retrieve --scope code exposes the versioned exact response and root-bound live snippet', (t) => {
  const root = fixture(t);
  const result = spawnSync(process.execPath, [BIN, 'retrieve', '--scope', 'code', '--root', root,
    '--query', 'parseToken', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const response = JSON.parse(result.stdout);
  assert.equal(response.schemaVersion, 1);
  assert.equal(response.scope, 'code');
  assert.equal(response.queryClass, 'exact');
  assert.equal(response.effectiveProfile, 'lexical-only');
  assert.equal(response.results[0].locator.file, 'src/auth.js');
  assert.match(response.results[0].snippet, /function parseToken/);
  assert.equal(response.absenceEstablished, false);
});

test('invalid task binding exits 2 before code retrieval and guidance remains the default help contract', (t) => {
  const root = fixture(t);
  const invalid = spawnSync(process.execPath, [BIN, 'retrieve', '--scope', 'code', '--root', root,
    '--query', 'parseToken', '--task-id', 'missing-task', '--need', 'missing-need', '--json'],
  { cwd: root, encoding: 'utf8' });
  assert.equal(invalid.status, 2, invalid.stderr);
  assert.equal(JSON.parse(invalid.stdout).error, 'invalid-task-binding');
  const help = spawnSync(process.execPath, [BIN, '--help'], { cwd: root, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /BM25 guidance search by default/);
});
