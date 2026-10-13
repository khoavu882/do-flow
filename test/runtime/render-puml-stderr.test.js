'use strict';
// render-puml.sh splices the projector's stdout into authored design.md prose. A projector that also
// writes to stderr (Node prints an ExperimentalWarning there on 23.6 to 24.2) must not leak into it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp');

const SCRIPT = path.join(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash', 'render-puml.sh');
const OPEN = '<!-- generated from context.puml source-hash: 000000000000 -->';
const CLOSE = '<!-- end generated -->';

function fixture(projector) {
  const root = suiteTempDir('doflow-render-puml-stderr-');
  const git = (...args) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', 'feat/001-x');
  const designDir = path.join(root, 'agent-docs', 'doflow', '001-x', 'design');
  fs.mkdirSync(path.join(designDir, 'c4'), { recursive: true });
  fs.writeFileSync(path.join(designDir, 'c4', 'context.puml'), '@startuml\n@enduml\n');
  fs.writeFileSync(path.join(designDir, 'design.md'), `before\n${OPEN}\nold\n${CLOSE}\nauthored after\n`);
  fs.mkdirSync(path.join(designDir, '..', 'intention'));
  fs.writeFileSync(path.join(designDir, '..', 'intention', 'requirement.md'), '# r\n');
  fs.mkdirSync(path.join(root, 'src', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'runtime', 'c4-project.ts'), projector);
  return { root, design: path.join(designDir, 'design.md') };
}

// render-puml.sh stops before the splice when no `plantuml` is on PATH (it notes the missing renderer
// and exits 0), so a machine without PlantUML, a GitHub runner for one, never reaches the subject of
// these tests. A stub that exits 0 and writes nothing makes the run the same everywhere; it is put
// ahead of the real PATH, so an installed PlantUML is shadowed rather than invoked.
function stubPlantumlDir() {
  const dir = suiteTempDir('doflow-render-puml-stub-');
  const stub = path.join(dir, 'plantuml');
  fs.writeFileSync(stub, '#!/bin/sh\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  return dir;
}

const run = (root) => spawnSync('bash', [SCRIPT], {
  cwd: root,
  encoding: 'utf8',
  env: { ...process.env, PATH: `${stubPlantumlDir()}${path.delimiter}${process.env.PATH}` },
});

test('a projector that writes to stderr does not pollute the generated block', () => {
  const { root, design } = fixture(
    `process.stderr.write('(node:1) ExperimentalWarning: Type Stripping is an experimental feature\\n');\n` +
    `process.stdout.write(${JSON.stringify(`${OPEN}\nNEW BLOCK\n${CLOSE}`)});\n`);
  const r = run(root);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = fs.readFileSync(design, 'utf8');
  assert.doesNotMatch(out, /ExperimentalWarning/, 'nothing from stderr is spliced into design.md');
  assert.equal(out.replace(/\s+/g, ' '), `before ${OPEN} NEW BLOCK ${CLOSE}authored after `.replace(/\s+/g, ' '));
  assert.match(r.stderr, /ExperimentalWarning/, 'the warning is still surfaced, on stderr');
});

test('a failing projector surfaces its stderr and leaves design.md untouched', () => {
  const { root, design } = fixture(`process.stderr.write('boom\\n'); process.exit(1);\n`);
  const before = fs.readFileSync(design, 'utf8');
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /render-puml: boom/);
  assert.equal(fs.readFileSync(design, 'utf8'), before);
});
