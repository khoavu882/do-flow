'use strict';
const { bashPath } = require('../helper/bash-locator.ts');
// render-drawio.sh writes design/presentation/<level>.drawio from design/c4/<level>.puml, exports a
// .drawio.svg when a draw.io binary is there, and never overwrites a .drawio a person has edited.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp.ts');

const ROOT = path.join(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'core', 'shared', 'scripts', 'doflow', 'bash', 'render-drawio.sh');
const NO_JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status !== 0 && 'jq is not on PATH';
const NO_SH_STUB = process.platform === 'win32' && 'the stub binary is a POSIX script';

const CONTAINER = [
  '@startuml', '!include <C4/C4_Container>',
  'Person(u, "User")',
  'System_Boundary(s, "Shop") {', '  Container(api, "API", "Go")', '  ContainerQueue(q, "Events", "Apache Kafka")', '}',
  'Rel(u, api, "Uses", "HTTPS")', 'Rel(api, q, "Publishes")',
  '@enduml', '',
].join('\n');
const CONTEXT = '@startuml\n!include <C4/C4_Context>\nPerson(u, "User")\nSystem(s, "Shop")\nRel(u, s, "Uses")\n@enduml\n';

/**
 * A repo on branch feat/001-x holding a feature with design/c4/{context,container}.puml. `linked`
 * puts the feature folder in the main checkout and runs from a linked worktree, as in
 * render-feature-root.test.ts. The projector modules are copied in: the verb takes them from repo_root.
 */
function fixture(linked = false, worktreeOutside = false) {
  const main = suiteTempDir('doflow-render-drawio-');
  const git = (cwd: string, ...args: string[]) => {
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
  fs.writeFileSync(path.join(feature, 'design', 'c4', 'context.puml'), CONTEXT);
  fs.writeFileSync(path.join(feature, 'design', 'c4', 'container.puml'), CONTAINER);
  let cwd = main;
  if (linked) {
    cwd = worktreeOutside ? path.join(suiteTempDir('doflow-render-drawio-wt-'), 'wt') : path.join(main, 'wt');
    git(main, 'worktree', 'add', '-q', cwd, '-b', 'feat/001-x');
  } else git(main, 'checkout', '-q', '-b', 'feat/001-x');
  for (const rel of ['c4-project.ts', 'drawio-project.ts', path.join('scaffold', 'fingerprint.ts')]) {
    fs.mkdirSync(path.dirname(path.join(cwd, 'src', 'runtime', rel)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, 'src', 'runtime', rel), path.join(cwd, 'src', 'runtime', rel));
  }
  const out = path.join(feature, 'design', 'presentation');
  return { main, cwd, feature, out, icons: path.join(out, 'icons') };
}

/** A `drawio` that records its arguments and writes the file named after -o; `exit` makes it fail instead. */
function stubBin(exit = 0) {
  const dir = suiteTempDir('doflow-render-drawio-stub-');
  const log = path.join(dir, 'args.log');
  fs.writeFileSync(path.join(dir, 'drawio'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n[ ${exit} -ne 0 ] && { echo "boom" >&2; exit ${exit}; }\n`
    + 'while [ $# -gt 0 ]; do [ "$1" = "-o" ] && { printf "<svg/>" > "$2"; exit 0; }; shift; done\nexit 1\n');
  fs.chmodSync(path.join(dir, 'drawio'), 0o755);
  return { dir, log };
}

function run(cwd: string, args: string[] = [], env: Record<string, string> = {}, stub: { dir: string } | null = null) {
  const e: any = { ...process.env, ...env };
  if (!('DOFLOW_DRAWIO' in env)) delete e.DOFLOW_DRAWIO;
  if (stub) e.PATH = `${stub.dir}${path.delimiter}${e.PATH}`;
  return spawnSync(bashPath(), [SCRIPT, '--json', ...args], { cwd, encoding: 'utf8', env: e });
}
const ABSENT = { DOFLOW_DRAWIO: 'doflow-no-such-drawio-binary' };
const ls = (dir: string) => fs.readdirSync(dir).sort();

test('writes one .drawio per C4 source, with a sha sidecar, and exports with the expected arguments', { skip: NO_JQ || NO_SH_STUB }, () => {
  const f = fixture();
  const stub = stubBin();
  const r = run(f.cwd, [], {}, stub);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.deepEqual(out.levels.map((l: any) => [l.level, l.status, l.export.status]), [['container', 'written', 'exported'], ['context', 'written', 'exported']]);
  assert.deepEqual(ls(f.out), ['container.drawio', 'container.drawio.sha', 'container.drawio.svg', 'context.drawio', 'context.drawio.sha', 'context.drawio.svg']);
  assert.match(fs.readFileSync(path.join(f.out, 'container.drawio'), 'utf8'), /id="el-api"/);
  const calls = fs.readFileSync(stub.log, 'utf8').trim().split('\n');
  assert.deepEqual(calls, [
    `-x -f svg -e --embed-svg-images -o ${path.join(f.out, 'container.drawio.svg')} ${path.join(f.out, 'container.drawio')}`,
    `-x -f svg -e --embed-svg-images -o ${path.join(f.out, 'context.drawio.svg')} ${path.join(f.out, 'context.drawio')}`,
  ]);
});

test('--level writes that level only; an unknown one is a usage error naming what exists', { skip: NO_JQ }, () => {
  const f = fixture();
  const r = run(f.cwd, ['--level=context'], ABSENT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(ls(f.out), ['context.drawio', 'context.drawio.sha']);
  const bad = run(f.cwd, ['--level=nope'], ABSENT);
  assert.equal(bad.status, 2);
  assert.match(JSON.parse(bad.stdout).message, /no nope\.puml .*found: container, context/);
});

test('without a draw.io binary the .drawio is still written, the export is skipped with its command, exit 0', { skip: NO_JQ }, () => {
  const f = fixture();
  const r = run(f.cwd, ['--level=context'], ABSENT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const level = JSON.parse(r.stdout).levels[0];
  assert.equal(level.status, 'written');
  assert.equal(level.export.status, 'skipped');
  assert.match(level.export.command, /^doflow-no-such-drawio-binary -x -f svg -e --embed-svg-images -o .*context\.drawio\.svg .*context\.drawio$/);
  assert.equal(fs.existsSync(path.join(f.out, 'context.drawio.svg')), false);
  const text = spawnSync(bashPath(), [SCRIPT, '--level=context'], { cwd: f.cwd, encoding: 'utf8', env: { ...process.env, ...ABSENT } });
  assert.match(text.stdout, /render-drawio:\s+export skipped: .* To export by hand: doflow-no-such-drawio-binary -x -f svg/);
});

test('a binary that fails is reported, keeps the .drawio, and does not fail the verb', { skip: NO_JQ || NO_SH_STUB }, () => {
  const f = fixture();
  const r = run(f.cwd, ['--level=context'], {}, stubBin(3));
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const level = JSON.parse(r.stdout).levels[0];
  assert.equal(level.export.status, 'failed');
  assert.match(level.export.reason, /exit 3: boom/);
  assert.ok(fs.existsSync(path.join(f.out, 'context.drawio')));
});

test('a binary that outlives --timeout is killed with everything it started, and reported', { skip: NO_JQ || NO_SH_STUB }, async () => {
  const f = fixture();
  const dir = suiteTempDir('doflow-render-drawio-slow-');
  const pidFile = path.join(dir, 'grandchild.pid');
  // The launcher starts a long-running child of its own and waits, as draw.io's launcher does with Electron.
  fs.writeFileSync(path.join(dir, 'drawio'), `#!/bin/sh\nsleep 30 &\necho $! > "${pidFile}"\nwait\n`);
  fs.chmodSync(path.join(dir, 'drawio'), 0o755);
  const started = Date.now();
  const r = run(f.cwd, ['--level=context', '--timeout=1'], {}, { dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(JSON.parse(r.stdout).levels[0].export.reason, /timed out after 1s/);
  assert.ok(Date.now() - started < 15000, 'the child was killed, not waited for');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(), false, 'the grandchild is gone too');
});

test('a binary that exits 0 without writing the svg is failed, and an earlier svg is not left to pass for it', { skip: NO_JQ || NO_SH_STUB }, () => {
  const f = fixture();
  assert.equal(run(f.cwd, ['--level=context'], {}, stubBin()).status, 0);
  const svg = path.join(f.out, 'context.drawio.svg');
  assert.ok(fs.existsSync(svg), 'the first run exported');
  const dir = suiteTempDir('doflow-render-drawio-silent-');
  fs.writeFileSync(path.join(dir, 'drawio'), '#!/bin/sh\nexit 0\n');
  fs.chmodSync(path.join(dir, 'drawio'), 0o755);
  const r = run(f.cwd, ['--level=context'], {}, { dir });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const level = JSON.parse(r.stdout).levels[0];
  assert.equal(level.status, 'unchanged');
  assert.equal(level.export.status, 'failed');
  assert.match(level.export.reason, /wrote no file/);
  assert.equal(fs.existsSync(svg), false, 'the stale export is gone');
});

test('a re-run regenerates an untouched file; a hand-edited one is left alone without --force', { skip: NO_JQ }, () => {
  const f = fixture();
  const file = path.join(f.out, 'context.drawio');
  assert.equal(run(f.cwd, ['--level=context'], ABSENT).status, 0);
  const generated = fs.readFileSync(file, 'utf8');
  const again = run(f.cwd, ['--level=context'], ABSENT);
  assert.equal(again.status, 0);
  assert.equal(JSON.parse(again.stdout).levels[0].status, 'unchanged');

  fs.writeFileSync(file, generated.replace('<root>', '<root><!-- moved by hand -->'));
  const edited = fs.readFileSync(file, 'utf8');
  const refused = run(f.cwd, ['--level=context'], ABSENT);
  assert.equal(refused.status, 1, refused.stdout);
  assert.equal(JSON.parse(refused.stdout).levels[0].status, 'refused-overwrite');
  assert.equal(fs.readFileSync(file, 'utf8'), edited, 'the edit is intact');
  const text = spawnSync(bashPath(), [SCRIPT, '--level=context'], { cwd: f.cwd, encoding: 'utf8', env: { ...process.env, ...ABSENT } });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /was edited since it was generated; left untouched\. Re-run with --force/);

  const forced = run(f.cwd, ['--level=context', '--force'], ABSENT);
  assert.equal(forced.status, 0, forced.stdout);
  assert.equal(fs.readFileSync(file, 'utf8'), generated);
});

test('an existing .drawio with no record of having been generated reads as hand-edited', { skip: NO_JQ }, () => {
  const f = fixture();
  fs.mkdirSync(f.out, { recursive: true });
  fs.writeFileSync(path.join(f.out, 'context.drawio'), '<mxfile/>');
  const r = run(f.cwd, ['--level=context'], ABSENT);
  assert.equal(r.status, 1);
  assert.equal(fs.readFileSync(path.join(f.out, 'context.drawio'), 'utf8'), '<mxfile/>');
});

test('icons come from design/presentation/icons by default; each element without one is listed with the names tried', { skip: NO_JQ }, () => {
  const f = fixture();
  fs.mkdirSync(f.icons, { recursive: true });
  fs.writeFileSync(path.join(f.icons, 'kafka.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const r = run(f.cwd, ['--level=container'], ABSENT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const icons = JSON.parse(r.stdout).levels[0].icons;
  assert.deepEqual(icons.used, [{ element: 'q', file: 'kafka.svg' }]);
  assert.deepEqual(icons.missing, [{ element: 'api', keys: ['go'] }]);
  assert.match(fs.readFileSync(path.join(f.out, 'container.drawio'), 'utf8'), /id="el-q" value="[^"]*" style="shape=image;image=data:image\/svg\+xml,/);
  const text = spawnSync(bashPath(), [SCRIPT, '--level=container'], { cwd: f.cwd, encoding: 'utf8', env: { ...process.env, ...ABSENT } });
  assert.match(text.stdout, /no icon for api; looked for go\.svg, go\.png/);
  assert.match(text.stdout, /icons are read from .*design\/presentation\/icons\//);
});

test('--icons names another folder inside the checkout; one outside it is refused and nothing is written', { skip: NO_JQ }, () => {
  const f = fixture();
  const mine = path.join(f.main, 'my-icons');
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, 'go.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const ok = run(f.cwd, ['--level=container', `--icons=${mine}`], ABSENT);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.deepEqual(JSON.parse(ok.stdout).levels[0].icons.used, [{ element: 'api', file: 'go.svg' }]);

  const outside = suiteTempDir('doflow-render-drawio-outside-');
  fs.writeFileSync(path.join(outside, 'go.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const g = fixture();
  const bad = run(g.cwd, ['--level=container', `--icons=${outside}`], ABSENT);
  assert.equal(bad.status, 1);
  assert.match(JSON.parse(bad.stdout).message, /outside the checkout/);
  assert.equal(fs.existsSync(g.out), false);
});

test('a source with an unrecognized macro is refused naming macro and line, and the verb exits 1', { skip: NO_JQ }, () => {
  const f = fixture();
  fs.writeFileSync(path.join(f.feature, 'design', 'c4', 'context.puml'), '@startuml\nPerson(u, "U")\nMadeUpMacro(u)\n@enduml\n');
  const r = run(f.cwd, ['--level=context'], ABSENT);
  assert.equal(r.status, 1);
  const level = JSON.parse(r.stdout).levels[0];
  assert.equal(level.status, 'refused-source');
  assert.match(level.message, /context\.puml:3: unrecognized macro 'MadeUpMacro'/);
  assert.equal(fs.existsSync(path.join(f.out, 'context.drawio')), false);
});

test('a feature without design/c4 is reported and exits 0; an unknown argument exits 2', { skip: NO_JQ }, () => {
  const f = fixture();
  fs.rmSync(path.join(f.feature, 'design', 'c4'), { recursive: true });
  const none = run(f.cwd);
  assert.equal(none.status, 0);
  assert.match(JSON.parse(none.stdout).note, /no design\/c4\/ directory/);
  assert.equal(run(f.cwd, ['--bogus']).status, 2);
  assert.equal(run(f.cwd, ['--level=../x']).status, 2);
});

test('from a linked worktree the files land in the main checkout, which holds the feature folder', { skip: NO_JQ }, () => {
  const f = fixture(true);
  const r = run(f.cwd, [], ABSENT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(f.out, 'container.drawio')), 'written beside the feature in the main checkout');
  assert.equal(fs.existsSync(path.join(f.cwd, 'agent-docs')), false, 'nothing is written into the worktree');
  assert.equal(JSON.parse(r.stdout).levels.length, 2);
});

test('from a linked worktree outside the main checkout, --icons may name a folder in the worktree', { skip: NO_JQ }, () => {
  const f = fixture(true, true);
  const mine = path.join(f.cwd, 'my-icons');
  fs.mkdirSync(mine);
  fs.writeFileSync(path.join(mine, 'go.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  const r = run(f.cwd, ['--level=container', `--icons=${mine}`], ABSENT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).levels[0].icons.used, [{ element: 'api', file: 'go.svg' }]);
  assert.ok(fs.existsSync(path.join(f.out, 'container.drawio')), 'still written beside the feature in the main checkout');
});

test('a symlinked .drawio.sha is refused by the verb with exit 1 and the file it points at is untouched', { skip: NO_JQ }, () => {
  const f = fixture();
  const victim = path.join(suiteTempDir('doflow-render-drawio-victim-'), 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  fs.mkdirSync(f.out, { recursive: true });
  try { fs.symlinkSync(victim, path.join(f.out, 'context.drawio.sha')); } catch { return; }
  const r = run(f.cwd, ['--level=context'], ABSENT);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).levels[0].status, 'refused-symlink');
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep me');
});
