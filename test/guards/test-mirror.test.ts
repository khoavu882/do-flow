'use strict';

// G90 — test/runtime mirrors src/runtime (row 167).
//   A test file at the top level of test/runtime named `<dir>-*.test.ts` (or `.test.js`) fails when the folder
//   src/runtime/<dir>/ exists: it belongs in test/runtime/<dir>/. The message names the file and that folder.
//   It passes when its name starts with the stem of a top-level module src/runtime/<stem>.ts followed by `.test.` or `-`.
//   Control: a planted tree in a temp folder holds such a file, which is found, a file whose prefix has no
//   src/runtime folder, which is not, and a file that starts with a planted top-level module's stem, which is not.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { tempDir } = require('../helper/tmp.ts');

/** `test/runtime/<file> belongs in test/runtime/<dir>/` for each top-level `<dir>-*.test.(ts|js)` whose src/runtime/<dir>/ exists under `root`. */
function unmirroredTests(root: string): string[] {
  const testRuntime = path.join(root, 'test', 'runtime');
  const srcRuntime = path.join(root, 'src', 'runtime');
  const stems = fs.readdirSync(srcRuntime).filter((name: string) => name.endsWith('.ts')).map((name: string) => name.slice(0, -3));
  const ofModule = (name: string) => stems.some((stem: string) => name.startsWith(`${stem}.test.`) || name.startsWith(`${stem}-`));
  return fs.readdirSync(testRuntime, { withFileTypes: true })
    .filter((entry: any) => entry.isFile() && /^[^-]+-.+\.test\.(ts|js)$/.test(entry.name) && !ofModule(entry.name))
    .filter((entry: any) => fs.statSync(path.join(srcRuntime, entry.name.split('-')[0]), { throwIfNoEntry: false })?.isDirectory())
    .map((entry: any) => `test/runtime/${entry.name} belongs in test/runtime/${entry.name.split('-')[0]}/`)
    .sort();
}

test('G90: no top-level test/runtime/<dir>-*.test file has a src/runtime/<dir>/ folder', () => {
  assert.deepEqual(unmirroredTests(REPO_ROOT), []);
});

test('G90 control: a planted <dir>-x.test.ts is found; a prefix with no folder, or a top-level module stem, is not', (t) => {
  const root = tempDir(t, 'doflow-g90-');
  fs.mkdirSync(path.join(root, 'src', 'runtime', 'worker'), { recursive: true });
  fs.mkdirSync(path.join(root, 'test', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'worker-y.ts'), '');
  fs.writeFileSync(path.join(root, 'test', 'runtime', 'worker-x.test.ts'), '');
  fs.writeFileSync(path.join(root, 'test', 'runtime', 'worker-y-z.test.ts'), '');
  fs.writeFileSync(path.join(root, 'test', 'runtime', 'brief-tools.test.ts'), '');
  assert.deepEqual(unmirroredTests(root), ['test/runtime/worker-x.test.ts belongs in test/runtime/worker/']);
});
