'use strict';

// `doflow ui` launcher (092 IC-008, 093 G.1). The launcher finds the Console package by file
// existence — the core's sibling `../doflow-ui`, then a walk up from the project for
// `node_modules/@khoavu882/doflow-ui` — and runs its bin with `--core <this core>/bin/doflow.js`,
// forwarding the exit code. Absent, it prints the install hint and exits 2, touching nothing.
//
// Most cases run the handler in a child Node process with a fake core root, so the sibling lookup
// is exercised on a temp tree rather than on whatever sits next to this checkout. Two cases go
// through the real bin/doflow.js to prove the COMMANDS wiring and the `--port` flag.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '..', '..');
const UI = path.join(REPO, 'src', 'cli', 'commands', 'ui.ts');
const INDEX = path.join(REPO, 'src', 'cli', 'index.ts');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const SCOPE = path.join('node_modules', '@khoavu882');
const HINT = 'doflow ui: the Console is not installed. Install it with: npm install -g @khoavu882/doflow-ui';

// Parses argv with the CLI's own parser and calls the handler with an injected core root.
const RUNNER = [
  "const { parseArgs } = require(process.env.T_INDEX);",
  "const ui = require(process.env.T_UI);",
  "Promise.resolve(ui(parseArgs(JSON.parse(process.env.T_ARGV)), process.env.T_CORE));",
].join('\n');

// A fake Console bin: reports its argv, then exits with T_EXIT (or waits for SIGTERM in hold mode).
// Hold mode arms its SIGTERM handler BEFORE it reports, so a test that signals the launcher on seeing
// the report never reaches a Console that is not yet listening (a descheduled process would die of SIGTERM).
const FAKE_BIN = [
  "'use strict';",
  "if (process.env.T_HOLD) {",
  "  process.on('SIGTERM', () => { process.stdout.write('got SIGTERM\\n'); process.exit(5); });",
  "  setInterval(() => {}, 1000);",
  "}",
  "process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }) + '\\n');",
  "if (!process.env.T_HOLD) process.exit(Number(process.env.T_EXIT || 0));",
].join('\n');

/** Writes a fake package (package.json + bin/doflow-ui.js) into `dir`; returns its bin path. */
function fakePackage(dir: string): string {
  fs.mkdirSync(path.join(dir, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"@khoavu882/doflow-ui","bin":{"doflow-ui":"bin/doflow-ui.js"}}\n');
  fs.writeFileSync(path.join(dir, 'bin', 'doflow-ui.js'), FAKE_BIN);
  return path.join(dir, 'bin', 'doflow-ui.js');
}

/** A temp tree with a fake core root at <root>/prefix/node_modules/@khoavu882/doflow and an empty project. */
function layout(t: any) {
  const root = tempDir(t, 'doflow-ui-launcher-');
  const scope = path.join(root, 'prefix', SCOPE);
  const core = path.join(scope, 'doflow');
  fs.mkdirSync(core, { recursive: true });
  const project = path.join(root, 'work', 'app');
  fs.mkdirSync(project, { recursive: true });
  return { root, scope, core, project };
}

function runHandler(argv: string[], core: string, opts: any = {}) {
  return spawnSync(process.execPath, ['-e', RUNNER], {
    cwd: opts.cwd || REPO,
    encoding: 'utf8',
    timeout: 20000,
    env: { ...process.env, T_INDEX: INDEX, T_UI: UI, T_CORE: core, T_ARGV: JSON.stringify(['ui', ...argv]), ...(opts.env || {}) },
  });
}

/** Every path under `dir`, sorted, so a case can prove nothing was created. */
function listing(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).sort();
}

test('ui-launcher: the module requires only node:fs, node:path and node:child_process, never the package', () => {
  const source = fs.readFileSync(UI, 'utf8');
  const allowed = new Set(["'node:fs'", "'node:path'", "'node:child_process'"]);
  const calls = [...source.matchAll(/\brequire(?:\.resolve)?\s*\(([^)]*)\)/g)].map((m) => m[1].trim());
  assert.ok(calls.length > 0, 'the module should load its built-ins with require');
  assert.deepEqual(calls.filter((arg) => !allowed.has(arg)), [],
    'ui.ts may require only node:fs, node:path and node:child_process; the Console is found by file existence (IC-008, G50)');
  // The install hint names the package, so the specifier itself is not searched for; every require
  // argument above already has to be one of the three built-ins.
  assert.doesNotMatch(source, /\bimport\s*\(|\bcreateRequire\b|\bprocess\.dlopen\b/,
    'no dynamic import, createRequire or dlopen: the package is never loaded into the core');
});

test('ui-launcher: absent everywhere -> the install hint on stderr, exit 2, nothing written', (t) => {
  const { root, core, project } = layout(t);
  const before = listing(root);
  const r = runHandler([project], core);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, `${HINT}\n`);
  assert.equal(r.stdout, '');
  assert.deepEqual(listing(root), before, 'the launcher installs and writes nothing');
});

test('ui-launcher: the core sibling is found, printed, and spawned with --core, --project and --port; exit forwarded', (t) => {
  const { scope, core, project } = layout(t);
  const bin = fakePackage(path.join(scope, 'doflow-ui'));
  const r = runHandler([project, '--port', '4321'], core, { env: { T_EXIT: '7' } });
  assert.equal(r.status, 7, r.stderr);
  assert.equal(r.stderr, `doflow ui: using ${bin}\n`);
  const seen = JSON.parse(r.stdout.trim());
  assert.deepEqual(seen.argv, ['--core', path.join(core, 'bin', 'doflow.js'), '--project', project, '--port', '4321']);
});

test('ui-launcher: private TLS flags reach the Console binary unchanged', (t) => {
  const { scope, core, project } = layout(t);
  const bin = fakePackage(path.join(scope, 'doflow-ui'));
  const r = runHandler([project, '--listen-address', '192.168.1.2', '--tls-cert', '/tmp/fullchain.pem', '--tls-key', '/tmp/private-key.pem'], core);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, `doflow ui: using ${bin}\n`);
  assert.deepEqual(JSON.parse(r.stdout.trim()).argv, [
    '--core', path.join(core, 'bin', 'doflow.js'), '--project', project,
    '--listen-address', '192.168.1.2', '--tls-cert', '/tmp/fullchain.pem', '--tls-key', '/tmp/private-key.pem',
  ]);
});

test('ui-launcher: the core sibling wins over a project node_modules copy', (t) => {
  const { root, scope, core, project } = layout(t);
  const sibling = fakePackage(path.join(scope, 'doflow-ui'));
  fakePackage(path.join(root, 'work', SCOPE, 'doflow-ui'));
  const r = runHandler([project], core);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, `doflow ui: using ${sibling}\n`);
});

test('ui-launcher: walks up from the project; without a project or --port, neither flag is passed', (t) => {
  const { root, core, project } = layout(t);
  const bin = fakePackage(path.join(root, 'work', SCOPE, 'doflow-ui'));
  const nested = path.join(project, 'src');
  fs.mkdirSync(nested);
  const r = runHandler([], core, { cwd: nested, env: { T_EXIT: '3' } });
  assert.equal(r.status, 3, r.stderr);
  assert.equal(r.stderr, `doflow ui: using ${bin}\n`);
  const seen = JSON.parse(r.stdout.trim());
  assert.deepEqual(seen.argv, ['--core', path.join(core, 'bin', 'doflow.js')]);
  assert.equal(fs.realpathSync(seen.cwd), fs.realpathSync(nested), 'the Console runs in the caller\'s directory');
});

test('ui-launcher: a package.json without its bin is not an install', (t) => {
  const { scope, core, project } = layout(t);
  fs.mkdirSync(path.join(scope, 'doflow-ui'));
  fs.writeFileSync(path.join(scope, 'doflow-ui', 'package.json'), '{}\n');
  const r = runHandler([project], core);
  assert.equal(r.status, 2, r.stderr);
  assert.equal(r.stderr, `${HINT}\n`);
});

test('ui-launcher: usage errors exit 2 before any lookup or spawn', (t) => {
  const { scope, core, project } = layout(t);
  fakePackage(path.join(scope, 'doflow-ui'));
  for (const argv of [[project, '--port', 'abc'], [project, '--port', '70000'], [project, project], [project, '--json'], ['--port=-1'], [project, '--listen-address', '192.168.1.2']]) {
    const r = runHandler(argv, core, { env: { T_EXIT: '9' } });
    assert.equal(r.status, 2, `${argv.join(' ')}: ${r.stderr}`);
    assert.equal(r.stdout, '', `${argv.join(' ')}: nothing is spawned`);
    assert.match(r.stderr, /^doflow ui: usage: doflow ui \[<project>\] \[--port N\] \[--listen-address <private IP> --tls-cert <absolute path> --tls-key <absolute path>\]\n$/, argv.join(' '));
  }
});

test('ui-launcher: SIGINT to the launcher reaches the Console as SIGTERM and its exit code comes back', async (t) => {
  const { scope, core, project } = layout(t);
  fakePackage(path.join(scope, 'doflow-ui'));
  const child = spawn(process.execPath, ['-e', RUNNER], {
    cwd: REPO,
    env: { ...process.env, T_INDEX: INDEX, T_UI: UI, T_CORE: core, T_ARGV: JSON.stringify(['ui', project]), T_HOLD: '1' },
  });
  let out = '';
  const exited = new Promise<any>((resolve) => child.on('exit', (code: any, signal: any) => resolve({ code, signal })));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the fake Console never started: ${out}`)), 15000);
    child.stdout.on('data', (chunk: any) => {
      out += chunk;
      if (out.includes('"argv"')) { clearTimeout(timer); resolve(); }
    });
  });
  child.kill('SIGINT');
  const { code, signal } = await exited;
  if (process.platform === 'win32') {
    // win32 has no signal delivery: kill('SIGINT') ends the launcher outright, so the SIGTERM forwarding and exit-code return cannot be observed.
    assert.equal(signal, 'SIGINT');
    return;
  }
  assert.equal(signal, null, 'the launcher stays up until the Console exits');
  assert.equal(code, 5);
  assert.match(out, /got SIGTERM/);
});

// Through the real entry point. The sibling of this checkout must be absent for the hint case.
const REPO_SIBLING = path.join(REPO, '..', 'doflow-ui', 'package.json');
const siblingSkip = fs.existsSync(REPO_SIBLING) && `a doflow-ui package sits next to this checkout (${REPO_SIBLING})`;

test('ui-launcher: `doflow ui` through bin/doflow.js — absent prints the hint, present runs with --port', { skip: siblingSkip }, (t) => {
  const root = tempDir(t, 'doflow-ui-cli-');
  const project = path.join(root, 'app');
  fs.mkdirSync(project);
  const absent = spawnSync(process.execPath, [DOFLOW, 'ui', project, '--port', '0'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(absent.status, 2, absent.stderr);
  assert.equal(absent.stderr, `${HINT}\n`);

  const bin = fakePackage(path.join(root, SCOPE, 'doflow-ui'));
  const present = spawnSync(process.execPath, [DOFLOW, 'ui', project, '--port=0'], { encoding: 'utf8', timeout: 20000, env: { ...process.env, T_EXIT: '4' } });
  assert.equal(present.status, 4, present.stderr);
  assert.equal(present.stderr, `doflow ui: using ${bin}\n`);
  assert.deepEqual(JSON.parse(present.stdout.trim()).argv, ['--core', DOFLOW, '--project', project, '--port', '0']);
});
