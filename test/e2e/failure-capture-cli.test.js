'use strict';

// B.2 — the Node capture points (IC-016): main()'s catch, every error-to-usage catch site, and the
// uncaughtExceptionMonitor in bin/doflow.js. Each point is driven through the real bin/doflow.js with
// a fault injected by a --require preload, and run twice, capture on and capture off. The two runs
// must agree byte for byte on stdout, stderr and exit status, and the on run must leave exactly one
// line (the off run, none). Every spawn runs under a scratch HOME and XDG_CONFIG_HOME (DEC-041).

const { test, describe, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');

const REPO = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO, 'bin', 'doflow.js');
const scratch = createScratch('doflow-failure-cli-');
const PRELOAD = path.join(scratch.dir, 'fault-preload.js');

// The injected fault. `console` makes console.log throw, which is outside main()'s try. `proto` replaces a method on a class prototype, `export` replaces a function a
// module exports, `stub` makes a required module a function that throws when called, and `load`
// makes requiring a module throw. It runs before bin/doflow.js loads the CLI, so every destructured
// import sees the fault.
fs.writeFileSync(PRELOAD, `'use strict';
const path = require('node:path');
const Module = require('node:module');
const spec = JSON.parse(process.env.DOFLOW_FAULT);
const repo = ${JSON.stringify(REPO)};
function make() {
  switch (spec.error) {
    case 'huge': return new TypeError('x'.repeat(8000000));
    case 'plain': return new Error('injected refusal');
    case 'syntax': return new SyntaxError('injected syntax error');
    case 'epipe': return Object.assign(new Error('write EPIPE'), { code: 'EPIPE', syscall: 'write', errno: -32 });
    case 'enoent': return Object.assign(new Error("ENOENT: no such file or directory, open '/nowhere/file'"), { code: 'ENOENT', syscall: 'open', errno: -2 });
    case 'module-not-found': return Object.assign(new Error('Cannot find module injected'), { code: 'MODULE_NOT_FOUND' });
    default: return new TypeError('injected "secret value" at attempt 42');
  }
}
if (spec.kind === 'block') {
  // Every module under src/runtime/failure/ is unresolvable, as in a half-updated install.
  const load = Module._load;
  Module._load = function patched(request, parent, isMain) {
    let file = '';
    try { file = Module._resolveFilename(request, parent, isMain); } catch { /* not ours */ }
    if (file.startsWith(path.join(repo, 'src', 'runtime', 'failure') + path.sep)) throw Object.assign(new Error('Cannot find module ' + request), { code: 'MODULE_NOT_FOUND' });
    return load.apply(this, arguments);
  };
} else if (spec.kind === 'proto') {
  require(path.join(repo, spec.module))[spec.cls].prototype[spec.method] = function injected() { throw make(); };
} else if (spec.kind === 'console') {
  console.log = function injected() { throw make(); };
} else if (spec.kind === 'export') {
  require(path.join(repo, spec.module))[spec.method] = function injected() { throw make(); };
} else {
  const load = Module._load;
  Module._load = function patched(request, parent, isMain) {
    let file = '';
    try { file = Module._resolveFilename(request, parent, isMain); } catch { /* not ours */ }
    if (file === path.join(repo, spec.module)) {
      if (spec.kind === 'load') throw make();
      return function injected() { throw make(); };
    }
    return load.apply(this, arguments);
  };
}
`);
after(() => scratch.remove());

let n = 0;
/** One spawn of bin/doflow.js in its own scratch HOME, XDG folder and working directory. */
function run(args, { fault, env: extra = {}, dropHome = false, setup } = {}) {
  const dir = path.join(scratch.dir, `run-${n++}`);
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  const cwd = path.join(dir, 'project');
  for (const d of [home, xdg, cwd]) fs.mkdirSync(d, { recursive: true });
  if (setup) setup(cwd);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: '', DOFLOW_AGENT: '', DOFLOW_FAULT: '', ...extra };
  if (dropHome) { delete env.HOME; delete env.XDG_CONFIG_HOME; }
  if (fault) env.DOFLOW_FAULT = JSON.stringify(fault);
  const nodeArgs = fault ? ['--require', PRELOAD, BIN, ...args] : [BIN, ...args];
  const result = spawnSync(process.execPath, nodeArgs, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const failures = path.join(env.XDG_CONFIG_HOME || '', 'doflow', 'failures');
  const file = path.join(failures, 'events.jsonl');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, lines, failures, xdg };
}

/** The same invocation with capture on and with capture off. */
function onOff(args, fault, extra) {
  return {
    on: run(args, { fault, ...extra }),
    off: run(args, { fault, ...extra, env: { ...(extra && extra.env), DOFLOW_FAILURE_CAPTURE: 'off' } }),
  };
}

function assertIdentical({ on, off }) {
  assert.equal(on.status, off.status, 'exit status differs');
  // The two runs differ only in their scratch directory name (run-<n>), which some commands print.
  const same = (text) => text.replace(/run-\d+/g, 'run-N');
  assert.equal(same(on.stdout), same(off.stdout), 'stdout differs');
  // The uncaught crash prints a path-bearing stack; both runs use the same preload and binary, and
  // the two scratch directories only differ in the run-<n> segment, which never reaches the output.
  assert.equal(same(on.stderr), same(off.stderr), 'stderr differs');
}

describe('error-to-usage catch sites record a programming error and keep the usage result', () => {
  const T = 'TypeError';
  const sites = [
    ['readiness', ['readiness', '--task-class', 'feature', '--task-id', 't1', '--json'], { kind: 'export', module: 'src/runtime/readiness.js', method: 'evaluateTaskReadiness' }],
    ['evidence list (ledger load)', ['evidence', '--task-id', 't1', '--action', 'list', '--json'], { kind: 'proto', module: 'src/runtime/evidence-ledger.js', cls: 'EvidenceLedger', method: 'load' }],
    ['evidence supersede', ['evidence', '--task-id', 't1', '--action', 'supersede', '--evidence-id', 'E1', '--replaced-by', 'E2', '--json'], { kind: 'proto', module: 'src/runtime/evidence-ledger.js', cls: 'EvidenceLedger', method: 'supersedeEvidence' }],
    ['route', ['route', '--intent', 'locate-concept', '--json'], { kind: 'proto', module: 'src/runtime/capability-router.js', cls: 'CapabilityRouter', method: 'resolveIntent' }],
    ['claim', ['claim', '--task-id', 't1', '--action', 'add', '--statement', 'x', '--json'], { kind: 'proto', module: 'src/runtime/claims.js', cls: 'ClaimsManager', method: 'addClaim' }],
    ['inventory', ['inventory', '--json'], { kind: 'export', module: 'src/registry/index.js', method: 'loadRegistry' }],
    ['outcome record', ['outcome', '--action', 'record', '--task-id', 't1', '--task-class', 'feature', '--state', 'INCONCLUSIVE', '--json'], { kind: 'proto', module: 'src/runtime/workflow-engine.js', cls: 'WorkflowEngine', method: 'resolveWorkflow' }],
    ['research-request', ['research-request', '--action', 'list', '--task-id', 't1', '--json'], { kind: 'proto', module: 'src/runtime/research-request.js', cls: 'ResearchRequestStore', method: 'list' }],
    ['retrieval-plan declare', ['retrieval-plan', '--action', 'declare', '--task-id', 't1', '--stage', 'design', '--need', 'locate-concept', '--json'], { kind: 'proto', module: 'src/runtime/capability-router.js', cls: 'CapabilityRouter', method: 'resolveIntent' }],
    ['verify', ['verify', '--task-id', 't1', '--json'], { kind: 'proto', module: 'src/runtime/verification/engine.js', cls: 'VerificationEngine', method: 'compileContract' }],
    ['workflow', ['workflow', '--task-class', 'feature', '--json'], { kind: 'proto', module: 'src/runtime/workflow-engine.js', cls: 'WorkflowEngine', method: 'resolveWorkflow' }],
  ];
  for (const [name, args, spec] of sites) {
    test(`${name}: exit 2, one line recorded, output identical with capture off`, () => {
      const pair = onOff(args, { ...spec, error: 'type' });
      assert.equal(pair.on.status, 2, `expected the usage exit; stderr: ${pair.on.stderr}`);
      assertIdentical(pair);
      assert.equal(pair.on.lines.length, 1, 'one line recorded');
      const [line] = pair.on.lines;
      assert.equal(line.source, 'cli');
      assert.equal(line.command, args[0]);
      assert.equal(line.kind, T);
      assert.equal(line.exit, 2);
      assert.equal(line.message, 'injected "..." at attempt N');
      assert.equal(pair.off.lines.length, 0);
      assert.equal(fs.existsSync(pair.off.failures), false, 'capture off creates no folder');
    });
  }

  test('a refusal-shaped plain Error at a usage site is not recorded', () => {
    const pair = onOff(['workflow', '--task-class', 'feature', '--json'],
      { kind: 'proto', module: 'src/runtime/workflow-engine.js', cls: 'WorkflowEngine', method: 'resolveWorkflow', error: 'plain' });
    assert.equal(pair.on.status, 2);
    assertIdentical(pair);
    assert.equal(pair.on.lines.length, 0);
  });

  test('a real usage error (no fault) is not recorded', () => {
    const result = run(['workflow', '--task-class', 'no-such-class', '--json']);
    assert.equal(result.status, 2);
    assert.equal(result.lines.length, 0);
  });
});

describe('main() catch', () => {
  const stub = (error) => ({ kind: 'stub', module: 'src/cli/commands/status.js', error });

  test('a programming error: recorded with exit 1, output and exit status identical with capture off', () => {
    const pair = onOff(['status', '--json'], stub('type'));
    assert.equal(pair.on.status, 1);
    assert.match(pair.on.stderr, /^\[ERROR\] injected "secret value" at attempt 42\n$/);
    assertIdentical(pair);
    assert.equal(pair.on.lines.length, 1);
    const [line] = pair.on.lines;
    assert.deepEqual([line.source, line.command, line.kind, line.exit], ['cli', 'status', 'TypeError', 1]);
    assert.equal(pair.off.lines.length, 0);
    assert.equal(fs.existsSync(pair.off.failures), false);
  });

  test('a system error with a code is recorded under the code', () => {
    const { on } = onOff(['status', '--json'], stub('enoent'));
    assert.equal(on.status, 1);
    assert.equal(on.lines.length, 1);
    assert.equal(on.lines[0].kind, 'ENOENT');
    assert.equal(on.lines[0].message, 'ENOENT: no such file or directory, open "..."');
  });

  test('an 8 million character message is recorded truncated and the CLI output and status are unchanged', () => {
    const pair = onOff(['status', '--json'], stub('huge'));
    assert.equal(pair.on.status, 1);
    assert.equal(pair.off.status, 1);
    // The 8 MB message goes to a pipe that process.exit() may cut short on some systems, so the two
    // runs are compared on what is stable (status, the start of the message) and not byte for byte.
    assert.ok(pair.off.stderr.startsWith('[ERROR] xxxx'));
    assert.equal(pair.on.stdout, pair.off.stdout);
    assert.ok(pair.on.stderr.startsWith('[ERROR] xxxx'), 'the CLI prints the message as before');
    assert.equal(pair.on.lines.length, 1);
    assert.ok(pair.on.lines[0].message.length <= 200);
  });

  for (const error of ['plain', 'syntax', 'epipe']) {
    test(`${error} is not recorded and the output is unchanged`, () => {
      const pair = onOff(['status', '--json'], stub(error));
      assert.equal(pair.on.status, 1);
      assertIdentical(pair);
      assert.equal(pair.on.lines.length, 0);
    });
  }
});

describe('uncaughtExceptionMonitor in bin/doflow.js', () => {
  const load = (error) => ({ kind: 'load', module: 'src/cli/commands/status.js', error });

  test('an error that escapes is recorded as uncaught:<kind>; the crash output and exit status are unchanged', () => {
    const pair = onOff(['status'], load('type'));
    assert.equal(pair.on.status, 1);
    assert.match(pair.on.stderr, /TypeError: injected/);
    assertIdentical(pair);
    assert.equal(pair.on.lines.length, 1);
    const [line] = pair.on.lines;
    // The CLI had not finished loading, so no command name was registered yet and none is recorded.
    assert.deepEqual([line.source, line.command, line.kind, line.exit], ['cli', 'unknown', 'uncaught:TypeError', 1]);
    assert.equal(pair.off.lines.length, 0);
  });

  test('an error that escapes main() outside its try (as one out of parseArgs would) names the command', () => {
    const pair = onOff(['status', '--help'], { kind: 'console', error: 'type' });
    assert.equal(pair.on.status, 1);
    assert.match(pair.on.stderr, /TypeError: injected/);
    assertIdentical(pair);
    assert.equal(pair.on.lines.length, 1);
    assert.deepEqual([pair.on.lines[0].command, pair.on.lines[0].kind, pair.on.lines[0].exit], ['status', 'uncaught:TypeError', 1]);
    assert.equal(pair.off.lines.length, 0);
  });

  test('a MODULE_NOT_FOUND while the CLI loads is seen (a half-updated install)', () => {
    const { on } = onOff(['status'], load('module-not-found'));
    assert.equal(on.status, 1);
    assert.equal(on.lines.length, 1);
    assert.deepEqual([on.lines[0].command, on.lines[0].kind], ['unknown', 'uncaught:MODULE_NOT_FOUND']);
  });

  for (const error of ['plain', 'syntax', 'epipe']) {
    test(`an escaping ${error} error is not recorded and the crash output is unchanged`, () => {
      const pair = onOff(['status'], load(error));
      assert.equal(pair.on.status, 1);
      assertIdentical(pair);
      assert.equal(pair.on.lines.length, 0);
    });
  }
});

describe('what capture must never change', () => {
  const type = { kind: 'stub', module: 'src/cli/commands/status.js', error: 'type' };

  test('an unwritable store: silent, same output and exit status as capture off', () => {
    const dir = fs.mkdtempSync(path.join(scratch.dir, 'blocked-'));
    const blocker = path.join(dir, 'file');
    fs.writeFileSync(blocker, 'x');
    const off = run(['status', '--json'], { fault: type, env: { DOFLOW_FAILURE_CAPTURE: 'off' } });
    const blocked = run(['status', '--json'], { fault: type, env: { XDG_CONFIG_HOME: blocker } });
    assert.equal(blocked.status, off.status);
    assert.equal(blocked.stdout, off.stdout);
    assert.equal(blocked.stderr, off.stderr);
  });

  test('an unset HOME with no XDG_CONFIG_HOME: capture is skipped, output and exit status unchanged', () => {
    const pair = onOff(['status', '--json'], type, { dropHome: true });
    assert.equal(pair.on.status, 1);
    assertIdentical(pair);
  });

  test('a relative XDG_CONFIG_HOME skips capture and leaves nothing behind', () => {
    const result = run(['status', '--json'], { fault: type, env: { XDG_CONFIG_HOME: 'relative/cfg' } });
    assert.equal(result.status, 1);
    assert.equal(fs.existsSync(path.join(scratch.dir, 'relative')), false);
  });

  test('the sentinel turns capture off over an env value of on', () => {
    const dir = fs.mkdtempSync(path.join(scratch.dir, 'sentinel-'));
    const xdg = path.join(dir, 'xdg');
    fs.mkdirSync(path.join(xdg, 'doflow', 'failures'), { recursive: true });
    fs.writeFileSync(path.join(xdg, 'doflow', 'failures', 'off'), 'x');
    const result = run(['status', '--json'], { fault: type, env: { XDG_CONFIG_HOME: xdg, DOFLOW_FAILURE_CAPTURE: 'on' } });
    assert.equal(result.status, 1);
    assert.deepEqual(fs.readdirSync(path.join(xdg, 'doflow', 'failures')), ['off']);
  });

  test('a bad flag, an unknown command and --help are never recorded', () => {
    for (const args of [['status', '--no-such-flag'], ['no-such-command'], ['--help'], ['--version']]) {
      const result = run(args);
      assert.equal(result.lines.length, 0, args.join(' '));
      assert.equal(fs.existsSync(result.failures), false, args.join(' '));
    }
  });

  test('a normal command with capture on writes nothing and prints what it printed before', () => {
    const result = run(['--version']);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${require('../../package.json').version}\n`);
    assert.equal(result.stderr, '');
  });
});

describe('a CLI whose failure modules cannot be loaded runs as today (IC-016)', () => {
  const block = { kind: 'block' };
  for (const args of [['--version'], ['workflow', '--task-class', 'feature', '--json'], ['lifecycle', '--maintain', '--json'], ['followup', '--action', 'list', '--json'], ['workflow', '--task-class', 'no-such-class', '--json']]) {
    test(`${args.join(' ')}: same output and status as with the modules present`, () => {
      const plain = run(args);
      const blocked = run(args, { fault: block });
      assert.equal(blocked.status, plain.status);
      assert.equal(blocked.stdout.replace(/"generatedAt":[^,}]*/g, ''), plain.stdout.replace(/"generatedAt":[^,}]*/g, ''));
      assert.equal(blocked.stderr, plain.stderr);
    });
  }
  test('an internal error with the modules unloadable still prints [ERROR] and exits 1', () => {
    const r = run(['status', '--json'], { fault: { kind: 'stub', module: 'src/cli/commands/status.js', error: 'type' } });
    assert.equal(r.status, 1);
  });
  test('the failure verb itself reports the load fault only when asked for', () => {
    assert.equal(run(['--version'], { fault: block }).status, 0);
    assert.equal(run(['failure', '--action', 'list'], { fault: block }).status, 1);
  });
});

describe('handlers that print their own [ERROR] and exit 1 still record a programming error (IC-016)', () => {
  const sites = [
    ['retrieve', ['retrieve', '--query', 'x'], { kind: 'export', module: 'src/runtime/knowledge/index-store.js', method: 'isFresh' },
      (cwd) => { fs.mkdirSync(path.join(cwd, '.doflow', 'guidance'), { recursive: true }); fs.writeFileSync(path.join(cwd, '.doflow', 'guidance', 'a.md'), '# A\n\nhello\n'); }],
    ['model-role', ['model-role', '--role', 'reasoning'], { kind: 'export', module: 'src/registry/index.js', method: 'loadRegistry' }, undefined],
    ['rollback', ['rollback', 'no-such-backup', '-t', 'claude', '--force'], { kind: 'export', module: 'src/install/backup.js', method: 'restoreBackup' }, undefined],
  ];
  for (const [name, args, spec, setup] of sites) {
    test(`${name}: one line recorded, output and exit status identical with capture off`, () => {
      const pair = onOff(args, { ...spec, error: 'type' }, { setup });
      assert.equal(pair.on.status, 1, pair.on.stderr);
      assert.match(pair.on.stderr, /\[ERROR\] (retrieve: |model-role: )?injected "secret value" at attempt 42/);
      assertIdentical(pair);
      assert.equal(pair.on.lines.length, 1);
      assert.deepEqual([pair.on.lines[0].command, pair.on.lines[0].kind, pair.on.lines[0].exit], [name, 'TypeError', 1]);
      assert.equal(pair.off.lines.length, 0);
    });
    test(`${name}: a plain Error at the same site is not recorded`, () => {
      const pair = onOff(args, { ...spec, error: 'plain' }, { setup });
      assert.equal(pair.on.status, 1);
      assertIdentical(pair);
      assert.equal(pair.on.lines.length, 0);
    });
  }
});
