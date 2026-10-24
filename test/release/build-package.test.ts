'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { buildPackage } = require('../../src/release/build-package.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO_ROOT = path.resolve(__dirname, '../..');

function walkFiles(root: any): string[] {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(file));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

test('buildPackage stages a runnable JavaScript package with no converted TypeScript paths', (t) => {
  const output = path.join(tempDir(t, 'doflow-package-'), 'package');
  buildPackage(output);

  for (const directory of ['src', 'bin']) {
    const remaining = walkFiles(path.join(output, directory))
      .filter((file: any) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
    assert.deepEqual(remaining, [], `${directory} should contain no runtime .ts files`);
  }

  const sourceFiles = walkFiles(path.join(REPO_ROOT, 'src'))
    .filter((file: any) => file.endsWith('.ts') && !file.endsWith('.d.ts'));
  const convertedPaths = sourceFiles.map((file: any) => path.relative(REPO_ROOT, file).split(path.sep).join('/'));
  for (const file of walkFiles(output)) {
    if (!['.js', '.json', '.sh', '.md', '.yaml', '.yml'].includes(path.extname(file))) continue;
    const contents = fs.readFileSync(file, 'utf8');
    for (const sourcePath of convertedPaths) {
      assert.equal(contents.includes(sourcePath), false, `${path.relative(output, file)} retains ${sourcePath}`);
    }
  }

  const entrypoint = path.join(output, 'bin', 'doflow.js');
  const stagedRequire = createRequire(entrypoint);
  assert.equal(
    stagedRequire.resolve('../src/runtime/failure/capture.js'),
    path.join(output, 'src/runtime/failure/capture.js'),
    'rewritten relative require should resolve',
  );

  const result = spawnSync(process.execPath, [entrypoint, '--version'], { cwd: output, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8')).version);
});
