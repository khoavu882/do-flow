'use strict';

// B.4 — dispatcher failure capture (IC-017, IC-011, IC-014). core/shared/scripts/doflow/bin/doflow-run
// is copied into a scratch tree with fake shell helpers and a fake Node CLI, so each capture point and
// each exclusion can be driven. Every point is run with capture on and with capture off, and the two
// must agree byte for byte on stdout, stderr and exit status. The dispatcher runs under /bin/bash
// (3.2 on macOS, the oldest shell supported) and every spawn uses a scratch HOME and XDG_CONFIG_HOME
// (DEC-041).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { captureIsOff } = require('../../src/runtime/failure/home');

const DISPATCHER = path.resolve(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const BASH = fs.existsSync('/bin/bash') ? '/bin/bash' : 'bash';
const scratch = createScratch('doflow-dispatcher-capture-');
after(() => scratch.remove());

let n = 0;
function tree(name, { helpers = true } = {}) {
  const dir = path.join(scratch.dir, `${name}-${n++}`);
  const bin = path.join(dir, 'tree', 'doflow', 'bin');
  const bashDir = path.join(dir, 'tree', 'doflow', 'bash');
  const t = {
    dir, bin, bashDir,
    home: path.join(dir, 'home'), xdg: path.join(dir, 'xdg'), config: path.join(dir, 'config'), cwd: path.join(dir, 'project'),
    script: path.join(bin, 'doflow-run'), cli: path.join(dir, 'fake-cli.js'),
  };
  for (const d of [bin, t.home, t.xdg, t.config, t.cwd]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(DISPATCHER, t.script);
  fs.chmodSync(t.script, 0o755);
  if (helpers) {
    fs.mkdirSync(bashDir, { recursive: true });
    for (const helper of ['do-paths.sh', 'do-task-brief.sh']) {
      fs.writeFileSync(path.join(bashDir, helper), '#!/usr/bin/env bash\necho "helper-out"\necho "helper-err" >&2\nexit "${FAKE_EXIT:-0}"\n', { mode: 0o755 });
    }
  }
  fs.writeFileSync(t.cli, 'process.stdout.write("cli-out\\n");process.stderr.write("cli-err\\n");process.exit(Number(process.env.FAKE_EXIT||0));\n');
  t.failures = path.join(t.xdg, 'doflow', 'failures');
  t.events = path.join(t.failures, 'events.jsonl');
  return t;
}

function baseEnv(t) {
  return { ...process.env, HOME: t.home, XDG_CONFIG_HOME: t.xdg, DOFLOW_CONFIG_DIR: t.config, DOFLOW_CLI: t.cli, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: '', FAKE_EXIT: '0' };
}

function dispatch(t, args, { env = {}, cwd = t.cwd, script = t.script } = {}) {
  const result = spawnSync(BASH, [script, ...args], { cwd, env: { ...baseEnv(t), ...env }, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const lines = (t) => (fs.existsSync(t.events) ? fs.readFileSync(t.events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

/** The same dispatch with capture on, then with capture off in a twin tree; asserts the two agree. */
function onOff(name, args, { env = {}, setup } = {}) {
  const on = tree(`${name}-on`);
  const off = tree(`${name}-off`);
  if (setup) { setup(on); setup(off); }
  const a = dispatch(on, args, { env });
  const b = dispatch(off, args, { env: { ...env, DOFLOW_FAILURE_CAPTURE: 'off' } });
  assert.equal(a.status, b.status, 'exit status differs');
  // The twin trees differ only in their scratch directory name, which messages quote.
  const same = (text, t) => text.split(t.dir).join('<tree>');
  assert.equal(same(a.stdout, on), same(b.stdout, off), 'stdout differs');
  assert.equal(same(a.stderr, on), same(b.stderr, off), 'stderr differs');
  assert.equal(fs.existsSync(off.failures), false, 'capture off creates no folder');
  return { on, off, a, b };
}

describe('exit-status point', () => {
  for (const [verb, helper] of [['paths', 'a shell verb'], ['classify', 'a Node verb']]) {
    for (const code of [3, 4, 7, 126, 128, 129, 137, 139, 255]) {
      if (verb === 'classify' && code === 126) continue;
      test(`${helper} ending ${code} is recorded as exit-${code}; output and status identical with capture off`, () => {
        const { on, a } = onOff(`exit-${verb}-${code}`, [verb, '--json'], { env: { FAKE_EXIT: String(code) } });
        assert.equal(a.status, code);
        const out = lines(on);
        assert.equal(out.length, 1);
        assert.deepEqual([out[0].source, out[0].command, out[0].kind, out[0].exit, out[0].message, out[0].frame], ['dispatcher', verb, `exit-${code}`, code, '', null]);
      });
    }
  }
  for (const code of [0, 1, 2, 127, 130, 141, 143]) {
    test(`status ${code} is not recorded`, () => {
      for (const verb of ['paths', 'classify']) {
        const { on, a } = onOff(`quiet-${verb}-${code}`, [verb], { env: { FAKE_EXIT: String(code) } });
        assert.equal(a.status, code);
        assert.equal(lines(on).length, 0);
        assert.equal(fs.existsSync(on.failures), false);
      }
    });
  }
  test('task-brief status 3 (task not found) is not recorded, but any other odd status is', () => {
    const quiet = onOff('brief-3', ['task-brief'], { env: { FAKE_EXIT: '3' } });
    assert.equal(quiet.a.status, 3);
    assert.equal(lines(quiet.on).length, 0);
    const loud = onOff('brief-9', ['task-brief'], { env: { FAKE_EXIT: '9' } });
    assert.equal(lines(loud.on)[0].kind, 'exit-9');
    assert.equal(lines(loud.on)[0].command, 'task-brief');
  });
  test('stdout, stderr and status of the verb pass through untouched', () => {
    const t = tree('passthrough');
    const r = dispatch(t, ['paths'], { env: { FAKE_EXIT: '139' } });
    assert.deepEqual([r.status, r.stdout, r.stderr], [139, 'helper-out\n', 'helper-err\n']);
  });
});

describe('fail() points', () => {
  test('helper-missing: recorded under the verb', () => {
    const { on, a } = onOff('helper-missing', ['paths', '--json'], { setup: (t) => fs.rmSync(path.join(t.bashDir, 'do-paths.sh')) });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /"error":"helper-missing"/);
    const [line] = lines(on);
    assert.deepEqual([line.command, line.kind, line.exit], ['paths', 'helper-missing', 2]);
  });
  test('helpers-not-found: recorded under the verb', () => {
    const { on, a } = onOff('helpers-not-found', ['paths'], { setup: (t) => fs.rmSync(t.bashDir, { recursive: true, force: true }) });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /cannot locate the shell helpers/);
    const [line] = lines(on);
    assert.deepEqual([line.command, line.kind, line.exit], ['paths', 'helpers-not-found', 2]);
  });
});

describe('symlink loop point', () => {
  test('recorded as dispatcher/symlink-loop; output and status identical with capture off', () => {
    // The kernel will not open a chain longer than its own limit, so the hop limit of a scratch copy
    // is lowered to 2; everything else in the copy is the shipped file.
    const make = (name) => {
      const t = tree(name);
      const text = fs.readFileSync(t.script, 'utf8');
      assert.ok(text.includes('"$hops" -gt 40'), 'the hop limit is where the test expects it');
      fs.writeFileSync(t.script, text.replace('"$hops" -gt 40', '"$hops" -gt 2'));
      fs.symlinkSync(t.script, path.join(t.bin, 'l3'));
      fs.symlinkSync(path.join(t.bin, 'l3'), path.join(t.bin, 'l2'));
      fs.symlinkSync(path.join(t.bin, 'l2'), path.join(t.bin, 'l1'));
      fs.symlinkSync(path.join(t.bin, 'l1'), path.join(t.bin, 'l0'));
      return t;
    };
    const on = make('loop-on');
    const off = make('loop-off');
    const a = dispatch(on, ['paths'], { script: path.join(on.bin, 'l0') });
    const b = dispatch(off, ['paths'], { script: path.join(off.bin, 'l0'), env: { DOFLOW_FAILURE_CAPTURE: 'off' } });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /symlink loop resolving/);
    assert.equal(a.status, b.status);
    assert.equal(a.stderr.replace(on.dir, 'D'), b.stderr.replace(off.dir, 'D'));
    assert.equal(a.stdout, b.stdout);
    const [line] = lines(on);
    assert.deepEqual([line.command, line.kind, line.exit], ['dispatcher', 'symlink-loop', 2]);
    assert.equal(fs.existsSync(off.failures), false);
  });
});

describe('what is never recorded (DEC-031)', () => {
  const toolDir = (withNode) => {
    const dir = fs.mkdtempSync(path.join(scratch.dir, 'tools-'));
    for (const tool of ['dirname', 'readlink', 'date', 'mkdir', 'cat', 'rm', 'mktemp', 'sed', 'head', 'tr', 'grep', 'perl', 'ls', 'uname', ...(withNode ? ['node'] : [])]) {
      let found = '';
      try { found = execFileSync('/bin/sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).trim(); } catch { /* absent */ }
      if (found.startsWith('/')) fs.symlinkSync(found, path.join(dir, tool));
    }
    return dir;
  };

  test('no verb, an unknown verb, --help', () => {
    for (const args of [[], ['no-such-verb'], ['--help']]) {
      const { on } = onOff(`plain-${args.join('') || 'none'}`, args);
      assert.equal(lines(on).length, 0, args.join(' '));
      assert.equal(fs.existsSync(on.failures), false);
    }
  });
  test('cli-not-found', () => {
    const { on, a } = onOff('cli-not-found', ['classify', '--json'], { env: { DOFLOW_CLI: '', PATH: toolDir(true) } });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /"error":"cli-not-found"/);
    assert.equal(lines(on).length, 0);
  });
  test('node-not-found', () => {
    const { on, a } = onOff('node-not-found', ['classify', '--json'], { env: { PATH: toolDir(false) } });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /"error":"node-not-found"/);
    assert.equal(lines(on).length, 0);
  });
  test('unlinked-checkout', () => {
    const { on, a } = onOff('unlinked', ['classify', '--json'], {
      env: { DOFLOW_CLI: '', PATH: toolDir(true) },
      setup: (t) => { fs.mkdirSync(path.join(t.cwd, 'bin')); fs.writeFileSync(path.join(t.cwd, 'bin', 'doflow.js'), ''); },
    });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /"error":"unlinked-checkout"/);
    assert.equal(lines(on).length, 0);
  });
  test('stale-runtime', () => {
    const { on, a } = onOff('stale-runtime', ['classify', '--json'], {
      env: { DOFLOW_CLI: '' },
      setup: (t) => {
        fs.mkdirSync(path.join(t.config, 'runtime', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(t.config, 'runtime', 'bin', 'doflow.js'), 'console.error("[ERROR] Invalid DoFlow registry: x");process.exit(1);\n');
      },
    });
    assert.equal(a.status, 2);
    assert.match(a.stderr, /"error":"stale-runtime"/);
    assert.equal(lines(on).length, 0);
  });
});

describe('the line (IC-011)', () => {
  const crash = ['paths'];
  const withCrash = (t, env = {}, opts = {}) => dispatch(t, crash, { env: { FAKE_EXIT: '139', ...env }, ...opts });

  test('fields, order and types', () => {
    const t = tree('line');
    fs.writeFileSync(path.join(t.config, '.install-manifest.json'), JSON.stringify({ script_version: '1.14.0', last_operation: 'install' }, null, 2));
    fs.mkdirSync(path.join(t.home, 'work', 'app'), { recursive: true });
    withCrash(t, { DOFLOW_AGENT: 'codex' }, { cwd: path.join(t.home, 'work', 'app') });
    const [line] = lines(t);
    assert.deepEqual(Object.keys(line), ['v', 'at', 'source', 'command', 'harness', 'version', 'project', 'kind', 'message', 'frame', 'exit']);
    assert.equal(line.v, 1);
    assert.match(line.at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.000Z$/);
    assert.deepEqual([line.harness, line.version, line.project], ['codex', '1.14.0', '~/work/app']);
    assert.ok(Buffer.byteLength(fs.readFileSync(t.events, 'utf8')) <= 1000);
  });
  test('harness is none and version unknown without DOFLOW_AGENT or a manifest', () => {
    const t = tree('line-defaults');
    withCrash(t, { DOFLOW_AGENT: 'bad value;' });
    const [line] = lines(t);
    assert.deepEqual([line.harness, line.version], ['none', 'unknown']);
  });
  test('the global manifest is the fallback when the project install has none', () => {
    const t = tree('line-global');
    fs.mkdirSync(path.join(t.home, '.doflow'), { recursive: true });
    fs.writeFileSync(path.join(t.home, '.doflow', '.install-manifest.json'), JSON.stringify({ script_version: '2.0.1' }, null, 2));
    withCrash(t);
    assert.equal(lines(t)[0].version, '2.0.1');
  });
  test('a project path with quotes, backslashes, control characters and unicode stays one valid JSON line', () => {
    const t = tree('line-escape');
    const nasty = path.join(t.dir, 'we"ird\\na\tme caf\u00e9 \u4e2d');
    fs.mkdirSync(nasty);
    withCrash(t, {}, { cwd: nasty });
    const raw = fs.readFileSync(t.events, 'utf8');
    assert.equal(raw.split('\n').filter(Boolean).length, 1);
    const [line] = lines(t);
    assert.ok(line.project.includes('we"ird\\na me caf'));
    assert.ok(Buffer.byteLength(raw) <= 1000);
  });
  test('a very long project path is cut and the line stays within 1000 bytes', () => {
    const t = tree('line-long');
    const long = path.join(t.dir, 'q"'.repeat(60));
    try { fs.mkdirSync(long, { recursive: true }); } catch { return; }
    withCrash(t, { DOFLOW_AGENT: 'a'.repeat(40) }, { cwd: long });
    const raw = fs.readFileSync(t.events, 'utf8');
    assert.ok(Buffer.byteLength(raw) <= 1000, `${Buffer.byteLength(raw)} bytes`);
    assert.equal(lines(t).length, 1);
  });
  test('the home prefix becomes ~ even with a trailing slash on HOME', () => {
    const t = tree('line-home-slash');
    fs.mkdirSync(path.join(t.home, 'p'));
    withCrash(t, { HOME: `${t.home}/` }, { cwd: path.join(t.home, 'p') });
    // XDG_CONFIG_HOME is still the scratch one, so the line lands where the test reads it.
    assert.equal(lines(t)[0].project, '~/p');
  });
  test('appends: two crashes make two lines, and the file is never rotated', () => {
    const t = tree('line-append');
    fs.mkdirSync(t.failures, { recursive: true });
    fs.writeFileSync(t.events, '');
    fs.truncateSync(t.events, 1048576);
    fs.appendFileSync(t.events, '\n');
    withCrash(t);
    withCrash(t);
    assert.deepEqual(fs.readdirSync(t.failures), ['events.jsonl']);
    assert.ok(fs.statSync(t.events).size > 1048576);
    assert.equal(fs.readFileSync(t.events, 'utf8').split('\n').filter((l) => l.startsWith('{')).length, 2);
  });
  test('the folder is 0700 and the new file 0600', { skip: process.platform === 'win32' }, () => {
    const t = tree('line-modes');
    withCrash(t);
    assert.equal(fs.statSync(t.failures).mode & 0o777, 0o700);
    assert.equal(fs.statSync(t.events).mode & 0o777, 0o600);
  });
});

describe('switch and home (IC-011, IC-014)', () => {
  test('DOFLOW_FAILURE_CAPTURE off, OFF, 0, false and No turn capture off', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'No', ' off ']) {
      const t = tree('switch-env');
      dispatch(t, ['paths'], { env: { FAKE_EXIT: '139', DOFLOW_FAILURE_CAPTURE: value } });
      assert.equal(fs.existsSync(t.failures), false, JSON.stringify(value));
    }
  });
  test('other env values leave capture on', () => {
    for (const value of ['on', '1', 'true', 'whatever']) {
      const t = tree('switch-on');
      dispatch(t, ['paths'], { env: { FAKE_EXIT: '139', DOFLOW_FAILURE_CAPTURE: value } });
      assert.equal(lines(t).length, 1, JSON.stringify(value));
    }
  });
  test('the sentinel file turns capture off, over an env value of on', () => {
    const t = tree('switch-sentinel');
    fs.mkdirSync(t.failures, { recursive: true });
    fs.writeFileSync(path.join(t.failures, 'off'), 'x');
    dispatch(t, ['paths'], { env: { FAKE_EXIT: '139', DOFLOW_FAILURE_CAPTURE: 'on' } });
    assert.deepEqual(fs.readdirSync(t.failures), ['off']);
  });
  test('HOME unset and no XDG_CONFIG_HOME: skipped, output and status unchanged', () => {
    const t = tree('nohome');
    const env = { ...baseEnv(t), FAKE_EXIT: '139' };
    delete env.HOME;
    delete env.XDG_CONFIG_HOME;
    const run = () => spawnSync(BASH, [t.script, 'paths'], { cwd: t.cwd, env, encoding: 'utf8' });
    const a = run();
    const b = spawnSync(BASH, [t.script, 'paths'], { cwd: t.cwd, env: { ...env, DOFLOW_FAILURE_CAPTURE: 'off' }, encoding: 'utf8' });
    assert.deepEqual([a.status, a.stdout, a.stderr], [b.status, b.stdout, b.stderr]);
    assert.equal(a.status, 139);
    assert.equal(fs.existsSync(path.join(t.dir, '.config')), false);
  });
  test('a relative XDG_CONFIG_HOME is skipped even when HOME is usable', () => {
    const t = tree('relxdg');
    const r = dispatch(t, ['paths'], { env: { FAKE_EXIT: '139', XDG_CONFIG_HOME: 'rel/cfg' } });
    assert.equal(r.status, 139);
    assert.equal(fs.existsSync(path.join(t.cwd, 'rel')), false);
    assert.equal(fs.existsSync(path.join(t.home, '.config')), false);
  });
  test('without XDG_CONFIG_HOME the home is $HOME/.config/doflow/failures', () => {
    const t = tree('homeconfig');
    const env = { ...baseEnv(t), FAKE_EXIT: '139' };
    delete env.XDG_CONFIG_HOME;
    spawnSync(BASH, [t.script, 'paths'], { cwd: t.cwd, env, encoding: 'utf8' });
    assert.equal(fs.readFileSync(path.join(t.home, '.config', 'doflow', 'failures', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).length, 1);
  });
  test('an unwritable store is silent: same output and status as capture off', () => {
    const t = tree('unwritable');
    const blocker = path.join(t.dir, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const a = dispatch(t, ['paths'], { env: { FAKE_EXIT: '139', XDG_CONFIG_HOME: blocker } });
    const b = dispatch(t, ['paths'], { env: { FAKE_EXIT: '139', DOFLOW_FAILURE_CAPTURE: 'off' } });
    assert.deepEqual(a, b);
  });
  test('a read-only events file is silent too', { skip: process.platform === 'win32' || (process.getuid && process.getuid() === 0) }, () => {
    const t = tree('readonly');
    fs.mkdirSync(t.failures, { recursive: true });
    fs.writeFileSync(t.events, '');
    fs.chmodSync(t.events, 0o400);
    const a = dispatch(t, ['paths'], { env: { FAKE_EXIT: '139' } });
    assert.equal(a.status, 139);
    assert.equal(a.stderr, 'helper-err\n');
    assert.equal(fs.readFileSync(t.events, 'utf8'), '');
  });
});

describe('the run ledger and the dispatcher itself', () => {
  test('trace_run still writes its record for a captured crash', () => {
    const t = tree('ledger');
    dispatch(t, ['paths'], { env: { FAKE_EXIT: '139' } });
    const runs = path.join(t.config, 'state', 'runs');
    const [file] = fs.readdirSync(runs);
    const record = JSON.parse(fs.readFileSync(path.join(runs, file), 'utf8').trim());
    assert.deepEqual([record.verb, record.exit_code], ['paths', 139]);
  });
  test('the shipped file parses under bash -n', () => {
    assert.equal(spawnSync(BASH, ['-n', DISPATCHER]).status, 0);
  });
});

describe('switch parsing parity and FIFOs', () => {
  const SWITCH_INPUTS = [' off ', ' o f f', 'OFF', '\toff', 'Off\t', 'o\tff', 'no', ' No ', '0 ', ' 0', 'fal se', 'false ', 'o ff', 'of f', 'on', '1', ' on ', 'fa lse', ' n o ', 'FALSE\n'];

  test('the dispatcher reads DOFLOW_FAILURE_CAPTURE exactly as the Node writer does', () => {
    for (const value of SWITCH_INPUTS) {
      const t = tree('parity');
      dispatch(t, ['paths'], { env: { FAKE_EXIT: '139', DOFLOW_FAILURE_CAPTURE: value } });
      const bashOff = lines(t).length === 0;
      assert.equal(bashOff, captureIsOff('/nonexistent-home', { DOFLOW_FAILURE_CAPTURE: value }), JSON.stringify(value));
    }
  });

  test('a FIFO at events.jsonl neither hangs the dispatcher nor changes its output or status', { skip: process.platform === 'win32' }, () => {
    const t = tree('fifo');
    fs.mkdirSync(t.failures, { recursive: true });
    assert.equal(spawnSync('mkfifo', [t.events]).status, 0);
    const started = Date.now();
    const r = spawnSync(BASH, [t.script, 'paths'], { cwd: t.cwd, env: { ...baseEnv(t), FAKE_EXIT: '139' }, encoding: 'utf8', timeout: 20000 });
    assert.ok(Date.now() - started < 15000, 'returned promptly');
    assert.deepEqual([r.status, r.stdout, r.stderr], [139, 'helper-out\n', 'helper-err\n']);
  });
});
