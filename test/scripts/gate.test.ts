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
const { parseArgs, nodeRefusal, findConflictMarkers } = require('../../scripts/gate.ts');

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
