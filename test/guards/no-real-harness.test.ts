'use strict';

// Row 169 A-02 tripwire. The models and worker test folders sync, list and launch against fakes; none of them may reach a
// real harness binary. This runs those files as a child `node --test` whose PATH holds only a directory of tripwire fakes
// (one per harness binary name, each writes a marker file and exits 1) and the node directory, then asserts no marker was
// written. A test that resolves a harness binary on the real PATH shows up here as a marker.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const SELF = path.basename(__filename);

/** Every harness binary name the registry declares (worker cli binary, listing argv[0], harness id), plus the names a
 * harness is known by outside it. */
function harnessBinaries(): string[] {
  const names = new Set<string>(['kiro-cli', 'agy', 'gemini', 'antigravity', 'copilot']);
  for (const harness of JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses) {
    names.add(harness.id);
    if (typeof harness.worker?.cli?.binary === 'string') names.add(harness.worker.cli.binary);
    if (typeof harness.worker?.modelList?.binary === 'string') names.add(harness.worker.modelList.binary);
  }
  return [...names].sort();
}

/** The test files of the models and worker folders, relative to the repo, this file excluded. */
function targetFiles(): string[] {
  const files: string[] = [];
  const add = (dir: string, keep: (name: string) => boolean) => {
    for (const name of fs.readdirSync(path.join(REPO, dir)).sort()) if (/\.test\.(ts|js)$/.test(name) && keep(name) && name !== SELF) files.push(`${dir}/${name}`);
  };
  add('test/runtime/models', () => true);
  add('test/runtime/worker', () => true);
  add('test/runtime', (name) => name.startsWith('worker-'));
  add('test/cli', (name) => name.startsWith('models-'));
  return files;
}

test('no test in the models and worker folders reaches a real harness binary', { skip: process.platform === 'win32' && 'the tripwire fakes are shell scripts', timeout: 600000 }, (t: any) => {
  const root = suiteTempDir('doflow-tripwire-');
  const bin = path.join(root, 'bin');
  const markers = path.join(root, 'markers');
  fs.mkdirSync(bin);
  fs.mkdirSync(markers);
  for (const name of harnessBinaries()) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "$0 $*" >> "${path.join(markers, name)}"\nexit 1\n`, { mode: 0o755 });
  }
  const files = targetFiles();
  assert.ok(files.length > 50, `the target set is ${files.length} files`);
  const env: any = { ...process.env, PATH: [bin, path.dirname(process.execPath)].join(path.delimiter) };
  delete env.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: REPO, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const found = fs.readdirSync(markers).map((name: string) => `${name}: ${fs.readFileSync(path.join(markers, name), 'utf8').trim().split('\n')[0]}`);
  assert.deepEqual(found, [], `${found.length} harness binaries were reached from ${files.length} test files (child exit ${run.status})`);
  const count = (label: string) => Number(String(run.stdout).match(new RegExp(`^# ${label} (\\d+)`, 'm'))?.[1]);
  assert.ok(count('tests') > 0, 'the child run reported a test count');
  t.diagnostic(`${files.length} files, ${count('tests')} tests (${count('pass')} pass, ${count('fail')} fail), ${found.length} markers`);
});
