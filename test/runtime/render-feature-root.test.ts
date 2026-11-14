'use strict';
const { bashPath } = require('../helper/bash-locator.ts');
// render-diagrams.sh and render-puml.sh read the feature folder from the resolver's `feature_root`:
// in a linked worktree whose agent-docs lives only in the main checkout, `repo_root` is the worktree
// and holds no feature folder.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp.ts');

const BASH_DIR = path.join(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash');
const NO_JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status !== 0 && 'jq is not on PATH';

function fixture() {
  const main = suiteTempDir('doflow-render-feature-root-');
  const git = (cwd: string, ...args: any[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
  };
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, '.gitignore'), 'agent-docs/\nwt/\n');
  git(main, 'add', '.gitignore');
  git(main, 'commit', '-q', '-m', 'init');
  const feature = path.join(main, 'agent-docs', 'doflow', '001-x');
  fs.mkdirSync(path.join(feature, 'design', 'c4'), { recursive: true });
  fs.mkdirSync(path.join(feature, 'intention'));
  fs.writeFileSync(path.join(feature, 'intention', 'requirement.md'), '# r\n');
  fs.writeFileSync(path.join(feature, 'design', 'design.md'), '# d\n\n```mermaid\nflowchart LR\n  a --> b\n```\n');
  fs.writeFileSync(path.join(feature, 'design', 'c4', 'context.puml'), '@startuml\n@enduml\n');
  const worktree = path.join(main, 'wt');
  git(main, 'worktree', 'add', '-q', worktree, '-b', 'feat/001-x');
  return { main, worktree, feature };
}

// Stubs put ahead of PATH: `mmdc` writes the file named after -o, `plantuml` exits 0. Both scripts
// stop with a note before reading the feature folder when their renderer is absent.
function stubDir() {
  const dir = suiteTempDir('doflow-render-feature-root-stub-');
  fs.writeFileSync(path.join(dir, 'mmdc'),
    '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && { printf x > "$2"; exit 0; }; shift; done\nexit 1\n');
  fs.writeFileSync(path.join(dir, 'plantuml'), '#!/bin/sh\nexit 0\n');
  for (const name of ['mmdc', 'plantuml']) fs.chmodSync(path.join(dir, name), 0o755);
  return dir;
}

const run = (script: string, cwd: string) => spawnSync(bashPath(), [path.join(BASH_DIR, script), '--json'], {
  cwd,
  encoding: 'utf8',
  env: { ...process.env, PATH: `${stubDir()}${path.delimiter}${process.env.PATH}` },
});

test('render-diagrams renders the main checkout\'s feature folder from a linked worktree', { skip: NO_JQ }, () => {
  const { worktree, feature } = fixture();
  const r = run('render-diagrams.sh', worktree);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.blocks, 1, r.stdout);
  assert.equal(out.rendered.length, 1, r.stdout);
  assert.ok(fs.existsSync(path.join(feature, 'design', 'diagrams', 'design-01.png')), 'the image lands in the main checkout');
  assert.equal(fs.existsSync(path.join(worktree, 'agent-docs')), false, 'nothing is written into the worktree');
});

test('render-puml finds design/c4 in the main checkout from a linked worktree', { skip: NO_JQ }, () => {
  const { worktree } = fixture();
  const r = run('render-puml.sh', worktree);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.doesNotMatch(r.stdout + r.stderr, /no design\/c4\/ directory/);
});
