'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadPoints } = require('../../src/runtime/packages/points.ts');
const { checkPackage } = require('../../src/runtime/packages/manifest.ts');
const { launchSpec } = require('../../src/runtime/packages/programs.ts');

const POINTS = loadPoints().registry;
const CORE = require('../../src/runtime/review/protocols.ts').loadProtocols().registry;
const HOST = require('../../package.json').version;
const clone = (value) => JSON.parse(JSON.stringify(value));

function workerPoints() {
  const registry = clone(POINTS);
  const worker = registry.points.find((point) => point.id === 'worker');
  worker.status = 'open';
  worker.versions = [1];
  return registry;
}

function workerManifest(programs, contributionPrograms = ['runner']) {
  return {
    manifest: 1,
    id: 'acme',
    version: '1.2.0',
    summary: 'Worker program test',
    doflow: `=${HOST}`,
    ...(programs === undefined ? {} : { programs }),
    contributions: [{
      point: 'worker',
      version: 1,
      id: 'job',
      file: 'worker.json',
      ...(contributionPrograms === null ? {} : { programs: contributionPrograms }),
    }],
  };
}

function makePackage(t, manifest, files = {}) {
  const dir = path.join(tempDir(t, 'doflow-pprog-'), 'pkg');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(dir, 'worker.json'), '{}');
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    if (typeof body === 'function') body(abs);
    else fs.writeFileSync(abs, body);
  }
  return dir;
}

function checkWorker(t, manifest, files = {}) {
  return checkPackage(makePackage(t, manifest, files), {
    pointsRegistry: workerPoints(),
    hostVersion: HOST,
    bundled: [],
  });
}

function binaryProgram(overrides = {}) {
  return { id: 'runner', binary: 'worker-bin', argv: 'worker-recipe', ...overrides };
}

function programFindings(result) {
  return result.findings.filter((finding) =>
    ['program-invalid', 'program-undeclared', 'path-escapes-root', 'file-missing'].includes(finding.code));
}

test('executable contributions must name declared programs', (t) => {
  const missingDeclaration = checkWorker(t, workerManifest([binaryProgram()], ['missing']));
  assert.deepEqual(programFindings(missingDeclaration).map((finding) => finding.code), ['program-undeclared']);

  const missingReferences = checkWorker(t, workerManifest([binaryProgram()], null));
  assert.deepEqual(programFindings(missingReferences).map((finding) => finding.code), ['program-undeclared']);
});

test('binary, path and argv declaration rules are enforced', (t) => {
  for (const binary of ['a b', '../x']) {
    const result = checkWorker(t, workerManifest([binaryProgram({ binary })]));
    assert.deepEqual(programFindings(result).map((finding) => finding.code), ['program-invalid'], binary);
  }

  if (process.platform !== 'win32') {
    const nonExecutable = checkWorker(t, workerManifest([{
      id: 'runner', path: 'bin/tool', argv: 'worker-recipe',
    }]), { 'bin/tool': (abs) => fs.writeFileSync(abs, 'tool') });
    assert.deepEqual(programFindings(nonExecutable).map((finding) => finding.code), ['program-invalid']);
  }

  const escaping = checkWorker(t, workerManifest([{
    id: 'runner', path: '../x', argv: 'worker-recipe',
  }]));
  assert.deepEqual(programFindings(escaping).map((finding) => finding.code), ['path-escapes-root']);

  const invalidArgv = checkWorker(t, workerManifest([binaryProgram({ argv: 'nope' })]));
  assert.deepEqual(programFindings(invalidArgv).map((finding) => finding.code), ['program-invalid']);
});

test('valid binary and executable package path declarations have no program findings', (t) => {
  const binary = checkWorker(t, workerManifest([binaryProgram()]));
  assert.deepEqual(programFindings(binary), []);

  const shipped = checkWorker(t, workerManifest([{
    id: 'runner', path: 'bin/tool', argv: 'worker-recipe',
  }]), {
    'bin/tool': (abs) => {
      fs.writeFileSync(abs, 'tool');
      fs.chmodSync(abs, 0o755);
    },
  });
  assert.deepEqual(programFindings(shipped), []);
});

test('launch specs use the binary or absolute store path and core recipe argv only', (t) => {
  const storeEntry = path.join(tempDir(t, 'doflow-pprog-store-'), 'store');
  const recipeArgv = ['--task', 'run'];
  const markerManifest = {
    id: 'package-marker-id',
    programs: [{ id: 'program-marker-id', binary: 'declared-binary', argv: 'argv-marker-shape' }],
  };
  const binary = launchSpec({
    program: markerManifest.programs[0], storeEntry, recipeArgv, cwd: '/core/cwd', env: { CORE: '1' },
  });
  assert.equal(binary.file, 'declared-binary');
  assert.equal(binary.options.shell, false);
  assert.deepEqual(binary.args, recipeArgv);
  assert.ok(!JSON.stringify([binary.file, binary.args]).includes(markerManifest.id));
  assert.ok(!JSON.stringify([binary.file, binary.args]).includes(markerManifest.programs[0].id));
  assert.ok(!JSON.stringify([binary.file, binary.args]).includes(markerManifest.programs[0].argv));

  const shipped = launchSpec({
    program: { id: markerManifest.programs[0].id, path: 'bin/tool', argv: markerManifest.programs[0].argv },
    storeEntry, recipeArgv, cwd: '/core/cwd', env: { CORE: '1' },
  });
  assert.equal(shipped.file, path.resolve(storeEntry, 'bin/tool'));
  assert.equal(shipped.options.shell, false);
  assert.deepEqual(shipped.args, recipeArgv);
  assert.ok(!JSON.stringify([shipped.file, shipped.args]).includes(markerManifest.id));
  assert.ok(!JSON.stringify([shipped.file, shipped.args]).includes(markerManifest.programs[0].id));
  assert.ok(!JSON.stringify([shipped.file, shipped.args]).includes(markerManifest.programs[0].argv));
});

test('inert packages need no programs and the shipped worker point remains reserved', (t) => {
  const preset = clone(CORE.presets['review-deep']);
  delete preset.depth;
  const dir = path.join(tempDir(t, 'doflow-pprog-inert-'), 'pkg');
  fs.mkdirSync(path.join(dir, 'presets'), { recursive: true });
  const inertManifest = {
    manifest: 1,
    id: 'acme',
    version: '1.2.0',
    summary: 'Inert package',
    doflow: `=${HOST}`,
    contributions: [{ point: 'review-preset', version: 1, id: 'strict', file: 'presets/strict.json' }],
  };
  fs.writeFileSync(path.join(dir, 'doflow-package.json'), JSON.stringify(inertManifest, null, 2));
  fs.writeFileSync(path.join(dir, 'presets', 'strict.json'), JSON.stringify(preset));
  const inert = checkPackage(dir, { pointsRegistry: POINTS, hostVersion: HOST, bundled: [] });
  assert.deepEqual(inert.findings, []);

  const reserved = checkPackage(makePackage(t, workerManifest(undefined), {}), {
    pointsRegistry: POINTS,
    hostVersion: HOST,
    bundled: [],
  });
  assert.ok(reserved.findings.some((finding) => finding.code === 'point-reserved'));
});
