'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp.ts');
const { RUNNER_TOOLS, parseArgs, ciEnv, stagePlan, runRehearse } = require('../../src/release/rehearse.ts');

const VERSION = '2.0.0-beta.6';
const FLOOR = '24.22.1';
const NODE = '/fake/node24/bin/node';
const PLANTUML_SIGNATURE = 'not ok 1 - a projector that writes to stderr does not pollute the generated block\n'
  + "      actual: 'before <!-- generated --> old <!-- end generated --> authored after '\n";
const ORDER = ['clone', 'preflight', 'suite', 'smoke', 'build', 'pack', 'install', 'version', 'install-g', 'verb'];

/** The spec forbids every registry, tag and push verb; this is the check the tests apply to each spawn. */
function forbidden(command: any, args: any) {
  return args.includes('publish') || args.includes('dist-tag')
    || (command === 'git' && ['push', 'tag'].includes(args[0]));
}

function fixture(t: any, { seed = null as any, node = NODE as any, override = ((...args: any[]): any => undefined), keep = false, registry = false, extraBase = {} }: any = {}) {
  const root = tempDir(t, 'doflow-rehearse-test-');
  const scratchRoot = path.join(root, 'scratch');
  fs.mkdirSync(scratchRoot);
  const npmCli = path.join(root, 'npm-cli.js');
  fs.writeFileSync(npmCli, '');
  const baseEnv = {
    PATH: root, HOME: '/operator/home', npm_execpath: npmCli, TMPDIR: '/operator/tmp', LANG: 'C',
    DOFLOW_RUNTIME_DIR: '/operator/doflow', NODE_OPTIONS: '--require /operator/x.js', SECRET_TOKEN: 'x', ...extraBase,
  };
  const calls: any = [];
  const run = (command: any, args: any, options: any) => {
    calls.push({ command, args, options });
    const custom = override(command, args, options);
    if (custom) return { stdout: '', stderr: '', status: 0, ...custom };
    const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
    if (command === 'git' && args[0] === '--version') return ok('git version 2\n');
    if (command === 'git' && args[0] === 'show') {
      return ok(JSON.stringify({ version: VERSION, engines: { node: `>=${FLOOR}` } }));
    }
    if (args[0] === '--version' && command === node) return ok(`v${FLOOR}\n`);
    if (command === 'git' && args[0] === 'rev-parse') return ok('a'.repeat(40) + '\n');
    if (args.includes('pack')) return { status: 0, stdout: 'doflow-2.0.0-beta.6.tgz\n', stderr: 'npm notice filename: noise-1.tgz\n' };
    if (command.endsWith('/.bin/doflow') && args[0] === '--version') return ok(`${VERSION}\n`);
    if (command === 'bash') return ok('{"ok":true}\n');
    return ok();
  };
  const result = runRehearse({
    repoRoot: path.join(root, 'checkout'),
    options: { node, seed, keep, registry },
    run,
    scratchRoot,
    baseEnv,
    invokingNode: '/fake/node26/bin/node',
  });
  return { root, scratchRoot, calls, result, baseEnv, npmCli };
}

function stageLines(result: any) {
  return result.lines.filter((l: any) => /^(PASS|FAIL|SKIP) /.test(l));
}

function scratchOf(result: any) {
  const line = result.lines.find((l: any) => l.startsWith('scratch: '));
  return line ? line.slice('scratch: '.length) : null;
}

test('parseArgs defaults and every flag', () => {
  assert.deepEqual(parseArgs([]), { node: null, ref: 'HEAD', seed: null, registry: false, keep: false });
  assert.deepEqual(
    parseArgs(['--node', '/n/node', '--ref', 'v1', '--seed-fault', 'raw-ts', '--registry', '--keep']),
    { node: '/n/node', ref: 'v1', seed: 'raw-ts', registry: true, keep: true },
  );
  assert.equal(parseArgs(['--seed-fault', 'plantuml']).seed, 'plantuml');
});

test('parseArgs rejects unknown, repeated, valueless and bad-valued flags with the usage line', () => {
  for (const argv of [
    ['--bogus'], ['stray'], ['--keep', '--keep'], ['--node', '/a', '--node', '/b'], ['--node'],
    ['--ref', '--keep'], ['--ref', '-x'], ['--seed-fault', 'nope'], ['--seed-fault'],
  ]) {
    assert.throws(() => parseArgs(argv), /^Error: usage: node src\/release\/rehearse\.ts /, JSON.stringify(argv));
  }
});

test('ciEnv builds the environment from nothing and keeps every path under scratch', () => {
  const base = {
    PATH: '/opt/homebrew/bin:/usr/bin', HOME: '/operator/home', DOFLOW_X: '1', DOFLOW_RUNTIME_DIR: '/r',
    NODE_OPTIONS: '--require /x.js', NPM_TOKEN: 't', XDG_CONFIG_HOME: '/operator/xdg', TMPDIR: '/var/tmp/x', LANG: 'en_US.UTF-8',
  };
  const scratch = '/scratch/rehearse';
  const env = ciEnv({ scratch, nodeDir: '/n24/bin', shimDir: `${scratch}/bin`, npmCli: '/npm/bin/npm-cli.js', base });
  assert.deepEqual(Object.keys(env).sort(), [
    'CI', 'HOME', 'LANG', 'PATH', 'TERM', 'TMPDIR', 'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME',
    'XDG_DATA_HOME', 'XDG_STATE_HOME', 'npm_config_audit', 'npm_config_cache', 'npm_config_fund',
    'npm_config_update_notifier', 'npm_execpath',
  ]);
  assert.equal(env.PATH, '/n24/bin:/scratch/rehearse/bin:/usr/bin:/bin:/usr/sbin:/sbin');
  for (const key of ['HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CACHE_HOME', 'npm_config_cache']) {
    assert.ok(env[key].startsWith(`${scratch}/`), `${key}=${env[key]}`);
  }
  assert.equal(env.TMPDIR, '/var/tmp/x');
  assert.equal(env.LANG, 'en_US.UTF-8');
  assert.deepEqual([env.CI, env.TERM, env.npm_config_audit, env.npm_config_fund, env.npm_config_update_notifier], ['true', 'dumb', 'false', 'false', 'false']);
  assert.equal(env.npm_execpath, '/npm/bin/npm-cli.js');
  const bare = ciEnv({ scratch, nodeDir: '/n', shimDir: '/s', npmCli: '/c', base: {} });
  assert.ok(!('TMPDIR' in bare) && !('LANG' in bare));
});

test('stagePlan orders the stages and names what each seed skips', () => {
  const plain = stagePlan({ seed: null });
  assert.deepEqual(plain.map((s: any) => s.id), ['env', 'clone', 'preflight', 'suite', 'smoke', 'build', 'pack', 'install', 'version', 'install-g', 'verb']);
  assert.ok(plain.every((s: any) => s.run));
  const plantuml = stagePlan({ seed: 'plantuml' });
  assert.deepEqual(plantuml.filter((s: any) => s.run).map((s: any) => s.id), ['env', 'clone', 'seed', 'suite']);
  assert.ok(plantuml.filter((s: any) => !s.run).every((s: any) => s.reason));
  const rawTs = stagePlan({ seed: 'raw-ts' });
  assert.deepEqual(rawTs.filter((s: any) => s.run).map((s: any) => s.id), ['env', 'clone', 'pack', 'install', 'version']);
  assert.match(rawTs.find((s: any) => s.id === 'seed').reason, /no tree change/);
  assert.deepEqual(rawTs.map((s: any) => s.id).filter((id: any) => id !== 'seed'), plain.map((s: any) => s.id));
});

test('the forbidden-argv check flags publish, dist-tag, push and tag (negative control)', () => {
  assert.ok(forbidden('node', ['/npm-cli.js', 'publish']));
  assert.ok(forbidden('node', ['/npm-cli.js', 'dist-tag', 'add']));
  assert.ok(forbidden('git', ['push', 'origin']));
  assert.ok(forbidden('git', ['tag', 'v1']));
  assert.ok(!forbidden('git', ['-C', '/x', 'checkout', '--detach']));
});

test('a clean run passes every stage in order, spawns the documented argv and removes the scratch', (t) => {
  const { result, calls, scratchRoot, baseEnv, npmCli } = fixture(t);
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  assert.deepEqual(stageLines(result).map((l: any) => l.split(':')[0]), ['env', ...ORDER].map((id) => `PASS ${id}`));
  assert.deepEqual(fs.readdirSync(scratchRoot), [], 'scratch removed on exit 0');
  assert.ok(!result.lines.some((l: any) => l.startsWith('scratch: ')));

  const find = (pred: any) => calls.find((c: any) => pred(c.command, c.args));
  const scratchAbs = (p: any) => p.startsWith(scratchRoot);
  assert.deepEqual(find((c: any, a: any) => c === 'git' && a[0] === 'show').args, ['show', 'HEAD:package.json']);
  const clone = find((c: any, a: any) => c === 'git' && a[0] === 'clone');
  assert.deepEqual(clone.args.slice(0, 3), ['clone', '--quiet', '--no-local']);
  assert.ok(scratchAbs(clone.args[4]) && clone.args[4].endsWith('/repo'));
  assert.deepEqual(find((c: any, a: any) => c === 'git' && a.includes('checkout')).args.slice(2), ['checkout', '--quiet', '--detach', 'a'.repeat(40)]);
  assert.deepEqual(find((c: any, a: any) => a[0] === 'src/release/preflight.ts').args, ['src/release/preflight.ts', '--offline']);
  assert.equal(find((c: any, a: any) => a[0] === 'src/release/preflight.ts').command, NODE);
  assert.deepEqual(find((c: any, a: any) => a[0] === '--test' && c === NODE).args, ['--test', 'test/**/*.test.ts']);
  assert.equal(find((c: any, a: any) => a[0] === '--test' && c === NODE).options.timeout, 45 * 60 * 1000);
  const smoke = find((c: any) => c === '/fake/node26/bin/node' && true);
  assert.equal(smoke.args[0], '--test');
  assert.equal(smoke.args.length, 5);
  assert.ok(smoke.options.env.PATH.startsWith(path.join(scratchRoot, ''))
    && smoke.options.env.PATH.split(path.delimiter)[0].endsWith('/node-invoking'), 'a node-only shim directory, not the Node folder');
  assert.ok(!calls.some((c: any) => c.options.env.PATH.split(path.delimiter).some((d: any) => d.startsWith('/fake/'))));
  assert.deepEqual(find((c: any, a: any) => a[0] === 'src/release/build-package.ts').args.slice(1).map(scratchAbs), [true]);
  const pack = find((c: any, a: any) => a.includes('pack'));
  assert.equal(pack.args[0], npmCli);
  assert.ok(pack.args[2].endsWith('/stage'), 'packs the built stage directory');
  const install = find((c: any, a: any) => a.includes('install') && a.includes('--offline'));
  assert.deepEqual(install.args.slice(1, 3), ['install', '--offline']);
  assert.ok(install.args.at(-1).endsWith('doflow-2.0.0-beta.6.tgz'));
  const global = find((c: any, a: any) => a[0] === 'install' && a.includes('-g'));
  assert.deepEqual(global.args, ['install', '-g', '-f', '--no-backup', '-t', 'claude']);
  assert.equal(global.options.input, '\n');
  assert.deepEqual(find((c: any) => c === 'bash').args.slice(1), ['paths', '--json']);

  for (const call of calls) assert.ok(!forbidden(call.command, call.args), `${call.command} ${call.args.join(' ')}`);
  // Every child after env gets the scratch environment, never the inherited one.
  const children = calls.filter((c: any) => c.options.env !== baseEnv);
  assert.ok(children.length >= 10);
  for (const c of children) {
    assert.ok(scratchAbs(c.options.env.HOME), `HOME for ${c.command} ${c.args[0]}`);
    assert.ok(!Object.keys(c.options.env).some((k) => k.startsWith('DOFLOW_') || k === 'NODE_OPTIONS' || k === 'SECRET_TOKEN'));
    assert.ok(!c.options.env.PATH.includes('homebrew'));
  }
  assert.ok(children.every((c: any) => c.options.timeout > 0), 'every non-env stage has a timeout');
});

test('--registry lets the preflight stage query npm', (t) => {
  const { calls } = fixture(t, { registry: true });
  assert.deepEqual(calls.find((c: any) => c.args[0] === 'src/release/preflight.ts').args, ['src/release/preflight.ts']);
});

test('the chain stops at the first failure, prints the last 40 lines and later SKIP lines, and keeps the scratch', (t) => {
  const output = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
  const { result } = fixture(t, {
    override: (command: any, args: any) => (args.includes('pack') ? { status: 1, stdout: output } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(result), { recursive: true, force: true }));
  assert.equal(result.exitCode, 1);
  const lines = result.lines;
  const failAt = lines.findIndex((l: any) => l.startsWith('FAIL pack:'));
  assert.ok(failAt > 0);
  assert.deepEqual(lines.slice(failAt + 1, failAt + 41), Array.from({ length: 40 }, (_, i) => `    line ${i + 11}`));
  assert.equal(lines[failAt + 41], 'SKIP install: after pack failed');
  for (const id of ['version', 'install-g', 'verb']) assert.ok(lines.includes(`SKIP ${id}: after pack failed`), id);
  assert.ok(!lines.some((l: any) => /^(PASS|FAIL) (install|version|install-g|verb):/.test(l)));
  assert.ok(fs.existsSync(scratchOf(result)), 'scratch kept on exit 1');
});

test('a preflight FAIL does not stop the chain and the run exits 1', (t) => {
  const { result } = fixture(t, {
    override: (command: any, args: any) => (args[0] === 'src/release/preflight.ts' ? { status: 1, stdout: 'FAIL clean-tree: dirty\n' } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(result), { recursive: true, force: true }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines.includes('    FAIL clean-tree: dirty'));
  assert.deepEqual(stageLines(result).filter((l: any) => l.startsWith('PASS')).map((l: any) => l.split(':')[0].slice(5)),
    ['env', 'clone', 'suite', 'smoke', 'build', 'pack', 'install', 'version', 'install-g', 'verb']);
});

test('a stage timeout is a FAIL that says so', (t) => {
  const { result } = fixture(t, {
    override: (command: any, args: any) => (args[0] === '--test' && command === NODE ? { status: null, error: Object.assign(new Error('spawnSync ETIMEDOUT'), { code: 'ETIMEDOUT' }) } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(result), { recursive: true, force: true }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines.includes('FAIL suite: test suite: timed out after 45 min'));
});

test('the version stage fails when the installed CLI prints another version', (t) => {
  const { result } = fixture(t, {
    override: (command: any, args: any) => (command.endsWith('/.bin/doflow') && args[0] === '--version' ? { stdout: '1.0.0\n' } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(result), { recursive: true, force: true }));
  assert.equal(result.exitCode, 1);
  assert.match(result.lines.find((l: any) => l.startsWith('FAIL version:')), /expected 2\.0\.0-beta\.6/);
});

test('seed plantuml: reverts the commit, runs only the render test, exits 0 when it fails', (t) => {
  const { result, calls, scratchRoot } = fixture(t, {
    seed: 'plantuml',
    override: (command: any, args: any) => (args[0] === '--test' ? { status: 1, stdout: PLANTUML_SIGNATURE } : undefined),
  });
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  assert.deepEqual(calls.find((c: any) => c.args[0] === 'revert').args, ['revert', '--no-commit', '0864b39a']);
  assert.deepEqual(calls.find((c: any) => c.args[0] === '--test').args, ['--test', 'test/runtime/render-puml-stderr.test.ts']);
  assert.ok(!calls.some((c: any) => ['src/release/preflight.ts', 'src/release/build-package.ts'].includes(c.args[0]) || c.args.includes('pack')));
  assert.ok(result.lines.includes('SEED reproduced: plantuml failed at suite'));
  assert.deepEqual(fs.readdirSync(scratchRoot), []);
  for (const id of ['preflight', 'smoke', 'build', 'pack', 'install', 'version', 'install-g', 'verb']) {
    assert.ok(result.lines.some((l: any) => l.startsWith(`SKIP ${id}:`)), id);
  }
});

test('seed plantuml: the render test failing for another reason is not a reproduction', (t) => {
  const { result } = fixture(t, {
    seed: 'plantuml',
    override: (command: any, args: any) => (args[0] === '--test' ? { status: 1, stdout: 'not ok\n' } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(result), { recursive: true, force: true }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines.includes('SEED not reproduced: plantuml expected suite, got FAIL without not ok 1 - a projector that writes to stderr does not pollute the generated block'));
  const half = fixture(t, {
    seed: 'plantuml',
    override: (command: any, args: any) => (args[0] === '--test' ? { status: 1, stdout: PLANTUML_SIGNATURE.split('\n')[0] + '\n' } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(half.result), { recursive: true, force: true }));
  assert.equal(half.result.exitCode, 1, 'the test name alone, without the design.md-kept-old-block assertion, is not enough');
});

test('a Node folder that holds other tools never reaches a child PATH, so the plantuml seed reproduces', (t) => {
  const nodeFolder = tempDir(t, 'doflow-rehearse-nodedir-');
  fs.writeFileSync(path.join(nodeFolder, 'node'), '');
  fs.writeFileSync(path.join(nodeFolder, 'plantuml'), '#!/bin/sh\nexit 0\n');
  const nodeBin = path.join(nodeFolder, 'node');
  // The fake suite passes when any directory on the child's PATH holds a plantuml (the stub case),
  // and fails with the signature when none does, the way the real test behaves.
  const visible = (env: any) => env.PATH.split(path.delimiter).some((d: any) => fs.existsSync(path.join(d, 'plantuml')));
  const { result, calls } = fixture(t, {
    seed: 'plantuml',
    node: nodeBin,
    keep: true,
    override: (command: any, args: any, options: any) => {
      if (command === nodeBin && args[0] === '--version') return { stdout: `v${FLOOR}\n` };
      if (args[0] === '--test') return visible(options.env) ? { status: 0 } : { status: 1, stdout: PLANTUML_SIGNATURE };
      return undefined;
    },
  });
  t.after(() => fs.rmSync(scratchOf(result), { recursive: true, force: true }));
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  assert.ok(result.lines.includes('SEED reproduced: plantuml failed at suite'));
  for (const c of calls.filter((x: any) => x.options.env.HOME.startsWith(scratchOf(result)))) {
    assert.ok(!c.options.env.PATH.split(path.delimiter).includes(nodeFolder), `${c.command} ${c.args[0]}`);
  }
  const floorShim = path.join(scratchOf(result), 'node-floor');
  assert.deepEqual(fs.readdirSync(floorShim), ['node']);
  assert.equal(fs.readlinkSync(path.join(floorShim, 'node')), nodeBin);
});

test('seed plantuml: a passing render test means the seed was not reproduced (exit 1)', (t) => {
  const { result } = fixture(t, { seed: 'plantuml' });
  t.after(() => fs.rmSync(scratchOf(result), { recursive: true, force: true }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.lines.includes('SEED not reproduced: plantuml expected suite, got PASS'));
});

test('seed plantuml: a revert that does not apply exits 3 and names the commit', (t) => {
  const { result } = fixture(t, {
    seed: 'plantuml',
    override: (command: any, args: any) => (args[0] === 'revert' ? { status: 1, stderr: 'conflict\n' } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(result), { recursive: true, force: true }));
  assert.equal(result.exitCode, 3);
  assert.match(result.lines.find((l: any) => l.startsWith('FAIL seed:')), /0864b39a/);
  assert.ok(result.lines.includes('SKIP suite: after seed failed'));
});

test('seed raw-ts: packs the raw clone, expects the type-stripping error and exits 0', (t) => {
  const { result, calls, scratchRoot } = fixture(t, {
    seed: 'raw-ts',
    override: (command: any, args: any) => (command.endsWith('/.bin/doflow')
      ? { status: 1, stderr: 'Error [ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING]: nope\n' } : undefined),
  });
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  const pack = calls.find((c: any) => c.args.includes('pack'));
  assert.ok(pack.args[2].endsWith('/repo'), 'packs the clone, not a built stage');
  assert.ok(!calls.some((c: any) => ['src/release/preflight.ts', 'src/release/build-package.ts', 'revert'].includes(c.args[0])));
  assert.ok(!calls.some((c: any) => c.args[0] === '--test'));
  assert.ok(result.lines.includes('SEED reproduced: raw-ts failed at version'));
  assert.deepEqual(fs.readdirSync(scratchRoot), []);
});

test('seed raw-ts: a version failure without the signature, or a pass, is not reproduced', (t) => {
  const plain = fixture(t, {
    seed: 'raw-ts',
    override: (command: any) => (command.endsWith('/.bin/doflow') ? { status: 1, stderr: 'some other error\n' } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(plain.result), { recursive: true, force: true }));
  assert.equal(plain.result.exitCode, 1);
  assert.ok(plain.result.lines.includes('SEED not reproduced: raw-ts expected version, got FAIL without ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'));

  const passing = fixture(t, { seed: 'raw-ts' });
  t.after(() => fs.rmSync(scratchOf(passing.result), { recursive: true, force: true }));
  assert.equal(passing.result.exitCode, 1);
  assert.ok(passing.result.lines.includes('SEED not reproduced: raw-ts expected version, got PASS'));

  const early = fixture(t, {
    seed: 'raw-ts',
    override: (command: any, args: any) => (args.includes('install') && args.includes('--offline') ? { status: 1 } : undefined),
  });
  t.after(() => fs.rmSync(scratchOf(early.result), { recursive: true, force: true }));
  assert.equal(early.result.exitCode, 1);
  assert.ok(early.result.lines.includes('SEED not reproduced: raw-ts expected version, got FAIL at install'));
});

test('env failures exit 3 before any scratch directory exists', (t) => {
  const wrong = fixture(t, {
    override: (command: any, args: any) => (command === NODE && args[0] === '--version' ? { stdout: 'v26.8.1\n' } : undefined),
  });
  assert.equal(wrong.result.exitCode, 3);
  assert.match(wrong.result.lines.join('\n'), /need Node v24\.22\.1 but .* is v26\.8\.1/);
  assert.match(wrong.result.lines.join('\n'), /npx -y -p node@24\.22\.1 node -p process\.execPath/);
  assert.deepEqual(fs.readdirSync(wrong.scratchRoot), []);
  assert.ok(!wrong.calls.some((c: any) => c.args[0] === 'clone'));

  const noGit = fixture(t, {
    override: (command: any, args: any) => (command === 'git' && args[0] === '--version'
      ? { status: null, error: Object.assign(new Error('spawnSync git ENOENT'), { code: 'ENOENT' }) } : undefined),
  });
  assert.equal(noGit.result.exitCode, 3);
  assert.match(noGit.result.lines.join('\n'), /git was not found/);
  assert.deepEqual(fs.readdirSync(noGit.scratchRoot), []);

  const badRef = fixture(t, {
    override: (command: any, args: any) => (command === 'git' && args[0] === 'show' ? { status: 128, stderr: 'fatal: bad ref\n' } : undefined),
  });
  assert.equal(badRef.result.exitCode, 3);
});

test('the default floor Node is the invoking one, and a mismatch exits 3 (negative control for the hint)', (t) => {
  const { result } = fixture(t, {
    node: null,
    override: (command: any, args: any) => (args[0] === '--version' && command.endsWith('/node') ? { stdout: 'v26.8.1\n' } : undefined),
  });
  assert.equal(result.exitCode, 3);
  assert.match(result.lines[0], /^FAIL env: need Node v24\.22\.1 but \/fake\/node26\/bin\/node is v26\.8\.1/);
});

test('--keep keeps the scratch after exit 0, with the npm shim and a linked runner tool', (t) => {
  const toolDir = tempDir(t, 'doflow-rehearse-tools-');
  const toolName = 'doflow-rehearse-fake-tool';
  fs.writeFileSync(path.join(toolDir, toolName), '');
  RUNNER_TOOLS.push(toolName);
  let result;
  try {
    ({ result } = fixture(t, { keep: true, extraBase: { PATH: toolDir } }));
  } finally {
    RUNNER_TOOLS.pop();
  }
  const scratch = scratchOf(result);
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  assert.equal(result.exitCode, 0, result.lines.join('\n'));
  assert.equal(result.lines.at(-1), `scratch: ${scratch}`);
  const shim = fs.readFileSync(path.join(scratch, 'bin', 'npm'), 'utf8');
  assert.match(shim, /^#!\/bin\/sh\nexec node ".*npm-cli\.js" "\$@"\n$/);
  assert.equal(fs.readlinkSync(path.join(scratch, 'bin', toolName)), path.join(toolDir, toolName));
});
