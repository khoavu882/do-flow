'use strict';

// IC-003: the tracked local gate. These cases never run the gate itself (no export, no install, no
// suite): they cover the Node refusal, usage, the conflict-marker scan and that the script holds no
// path of any one machine.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { parseArgs, nodeRefusal, summaryLine, findConflictMarkers, exportHead } = require('../../scripts/gate.ts');
const { TEST_GLOB, DOCKER_INFO_TIMEOUT_MS, dockerArgs, dockerUnavailable } = require('../../scripts/linux-run.ts');
const { parseShellSuites } = require('../../scripts/shell-suites.ts');

const SCRIPT = path.join(REPO_ROOT, 'scripts', 'gate.ts');

function runGate(args: string[], cwd: string) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

/** A git repository whose release.yml pins `pin` (or no Node at all when null). */
function repoPinning(t: any, pin: string | null) {
  const repo = tempDir(t, 'doflow-gate-');
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: repo }).status, 0);
  fs.mkdirSync(path.join(repo, '.github', 'workflows'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.github', 'workflows', 'release.yml'),
    'jobs:\n  preflight:\n    steps:\n      - uses: actions/setup-node@x\n' + (pin ? `        with:\n          node-version: ${pin}\n` : ''));
  return repo;
}

test('gate: a Node other than the release pin is refused with the one line, exit 1, before anything runs', (t) => {
  const repo = repoPinning(t, '1.2.3');
  const result = runGate([], repo);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.ok(result.stdout.split('\n').includes(
    `gate: Node ${process.versions.node} is not the release Node 1.2.3; switch Node and rerun`), result.stdout);
  assert.doesNotMatch(result.stdout, /export HEAD|npm install/);
});

test('gate: the Node check passes when the running Node is the pin', (t) => {
  assert.equal(nodeRefusal('24.22.1', '24.22.1'), null);
  assert.equal(nodeRefusal('26.0.0', '24.22.1'), 'gate: Node 26.0.0 is not the release Node 24.22.1; switch Node and rerun');
  const repo = repoPinning(t, process.versions.node);
  // No commit exists, so the run stops at the export step: it got past the Node check and went no further.
  const result = runGate([], repo);
  assert.match(result.stdout, /gate: Node .* \(the release Node\)/);
  assert.match(result.stdout, /gate: export HEAD FAILED/);
  assert.match(result.stdout, /gate: red at export HEAD/);
  assert.equal(result.status, 1);
});

test('gate: a release.yml with no Node pin is refused naming the file', (t) => {
  const result = runGate([], repoPinning(t, null));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /gate: no Node pin found in \.github\/workflows\/release\.yml/);
});

test('gate: any argument but --keep is a usage error, exit 2', (t) => {
  const repo = repoPinning(t, '1.2.3');
  for (const args of [['--bogus'], ['--keep', '--keep'], ['extra'], ['--keep', '--node', '24']]) {
    const result = runGate(args, repo);
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /^usage: node scripts\/gate\.ts \[--keep\]/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(parseArgs([]), { keep: false });
  assert.deepEqual(parseArgs(['--keep']), { keep: true });
  assert.equal(parseArgs(['-k']), null);
});

test('gate: the script source holds no absolute path, and the npm script runs it', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /\/Users\/|\/home\/|[A-Za-z]:\\|(?:^|['"`\s(])\/(?:private|var|opt|tmp|usr)\b/m);
  assert.ok(!source.includes(REPO_ROOT), 'the script must not name this checkout');
  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts.gate, 'node scripts/gate.ts');
});

test('gate: the conflict-marker scan finds git markers and ignores rules, binaries and unreadable entries', (t) => {
  const dir = tempDir(t, 'doflow-gate-scan-');
  fs.writeFileSync(path.join(dir, 'bad.md'), 'a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> topic\n');
  fs.writeFileSync(path.join(dir, 'tail.txt'), 'x\n>>>>>>>\n');
  fs.writeFileSync(path.join(dir, 'rule.md'), 'Title\n=======\n\ncode: a <<<<<<< b\n');
  fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from('<<<<<<< x\n\0\n'));
  fs.symlinkSync(path.join(dir, 'missing'), path.join(dir, 'dangling'));
  assert.deepEqual(findConflictMarkers(dir, ['bad.md', 'tail.txt', 'rule.md', 'blob.bin', 'dangling']), ['bad.md', 'tail.txt']);
});

test('gate: the export step is a shared clone at HEAD that still holds the history', (t) => {
  const repo = tempDir(t, 'doflow-gate-src-');
  const git = (args: string[], cwd: string) => {
    const result = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git(['init', '-q'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(['add', 'a.txt'], repo);
  git(['commit', '-q', '-m', 'first'], repo);
  const older = git(['rev-parse', 'HEAD'], repo);
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git(['commit', '-q', '-am', 'second'], repo);
  const head = git(['rev-parse', 'HEAD'], repo);
  const before = git(['status', '--porcelain=v1', '--branch'], repo);

  const clone = tempDir(t, 'doflow-gate-clone-');
  assert.equal(exportHead(repo, clone), true);
  assert.equal(git(['log', '-1', '--format=%H'], clone), head);
  git(['cat-file', '-e', older], clone);
  assert.equal(fs.readFileSync(path.join(clone, 'a.txt'), 'utf8'), 'two\n');
  assert.match(fs.readFileSync(path.join(clone, '.git', 'objects', 'info', 'alternates'), 'utf8'), /\.git[\\/]objects/);
  assert.equal(git(['status', '--porcelain=v1', '--branch'], repo), before, 'the source repository is untouched');
});

test('gate: the shell suites are the workflow\'s, in its order, and the workflow has none the parser cannot read', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'cross-os-tests.yml'), 'utf8');
  assert.deepEqual(parseShellSuites(workflow), {
    suites: ['test/doflow-chain-test.sh', 'test/hooks/test-hooks.sh', 'test/verify-hooks.sh', 'test/code-review-fixtures.sh'],
    unreadable: [],
  });
});

test('gate: the summary line names every skipped step and why, and a red step wins', () => {
  assert.equal(summaryLine(null, []), 'gate: green');
  assert.equal(summaryLine(null, ['linux worker tests — no docker daemon answered']), 'gate: green (skipped: linux worker tests — no docker daemon answered)');
  assert.equal(summaryLine(null, ['a — x', 'b — y']), 'gate: green (skipped: a — x; b — y)');
  assert.equal(summaryLine('npm test', ['a — x']), 'gate: red at npm test');
});

test('gate: the Linux run is a docker run of the release Node on the worker test folder, with no host path in the container script', () => {
  const args = dockerArgs('/some/checkout', '24.22.1');
  assert.deepEqual(args.slice(0, 7), ['run', '--rm', '--init', '-v', '/some/checkout:/src:ro', 'node:24.22.1', 'sh']);
  assert.match(args[args.length - 1], /node --test "test\/runtime\/worker\/\*\.test\.ts"/);
  assert.equal(TEST_GLOB, 'test/runtime/worker/*.test.ts');
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'test', 'runtime', 'worker', 'process-tree.test.ts')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).scripts['test:linux'], 'node scripts/linux-run.ts');
});

test('gate: docker info has a 10 s timeout and a missing docker is a named skip, not a failure', (t) => {
  assert.equal(DOCKER_INFO_TIMEOUT_MS, 10000);
  const empty = tempDir(t, 'doflow-gate-nodocker-');
  const before = process.env.PATH;
  process.env.PATH = empty;
  try {
    assert.equal(dockerUnavailable(), 'no docker command');
  } finally {
    process.env.PATH = before;
  }
  if (process.platform === 'win32') return;
  const slow = tempDir(t, 'doflow-gate-slowdocker-');
  fs.writeFileSync(path.join(slow, 'docker'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  process.env.PATH = `${slow}${path.delimiter}${before}`;
  try {
    // A hung docker is reported after the timeout, not waited on: use a 1 s stand-in through the same code path.
    const started = Date.now();
    const reason = dockerUnavailable(1000);
    assert.match(reason, /did not answer in 1 s/);
    assert.ok(Date.now() - started < 10000);
  } finally {
    process.env.PATH = before;
  }
});
