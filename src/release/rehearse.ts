'use strict';

// Release rehearsal: runs the stages a tagged cut depends on against a clone of a committed
// revision, on the declared floor Node, with a child environment built from nothing so a result
// cannot depend on the operator's machine. It never publishes, tags, pushes or touches the
// invoking checkout. Contract: IC-001 and IC-002 of the 085a specs.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../helper/repo-root.ts');

/**
 * Tools linked into the child PATH when they live outside /usr/bin and /bin on the operator's
 * machine. An entry needs a source showing the GitHub ubuntu and macOS runner images carry it.
 *   git     - actions/checkout runs on every runner image, and every workflow here starts with it.
 *   jq      - .github/workflows/drift.yml:54 calls jq on ubuntu-latest.
 *   python3 - .github/workflows/cross-os-tests.yml:81 states python3 is preinstalled on ubuntu-latest.
 * The macOS side of each row is not confirmed by a repo file; check the macOS image readme in
 * github.com/actions/runner-images before relying on it (design.md R6).
 */
const RUNNER_TOOLS = ['git', 'jq', 'python3'];

const SYSTEM_PATH = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];
const SEED_COMMIT = '0864b39a';
// What each seed's expected failure must print, all of it. plantuml: with the stub removed (the
// revert) and no PlantUML on the scratch PATH, render-puml.sh exits before the splice, so the first
// test fails on design.md still holding its old block. raw-ts: Node refuses .ts under node_modules.
const SEED_SIGNATURES: Record<string, string[]> = {
  plantuml: [
    'not ok 1 - a projector that writes to stderr does not pollute the generated block',
    'old <!-- end generated -->',
  ],
  'raw-ts': ['ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING'],
};
const SMOKE_TESTS = [
  'test/e2e/packed-install.e2e.test.ts',
  'test/e2e/node-floor-guard.test.ts',
  'test/e2e/compile-cache.test.ts',
  'test/e2e/install-shapes.test.ts',
];
const MINUTE = 60 * 1000;
const USAGE = 'usage: node src/release/rehearse.ts [--node <path>] [--ref <rev>] [--seed-fault plantuml|raw-ts] [--registry] [--keep]';

type Options = { node: string | null, ref: string, seed: string | null, registry: boolean, keep: boolean };
type RunOptions = { cwd?: string, env?: Record<string, string | undefined>, input?: string, timeout?: number };
type RunResult = { status: number | null, stdout: string, stderr: string, error?: any };
type Run = (command: string, args: string[], options: RunOptions) => RunResult;
type Outcome = { id: string, status: 'PASS' | 'FAIL' | 'SKIP', output: string, kind?: 'exit' | 'timeout' | 'spawn' };
type StageResult = { ok: boolean, message: string, output?: string, kind?: 'exit' | 'timeout' | 'spawn', fatal?: boolean };

function parseArgs(argv: string[]): Options {
  const options: Options = { node: null, ref: 'HEAD', seed: null, registry: false, keep: false };
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (!['--node', '--ref', '--seed-fault', '--registry', '--keep'].includes(flag) || seen.has(flag)) {
      throw new Error(USAGE);
    }
    seen.add(flag);
    if (flag === '--registry') {
      options.registry = true;
    } else if (flag === '--keep') {
      options.keep = true;
    } else {
      const value = argv[++i];
      if (!value || value.startsWith('-')) throw new Error(USAGE);
      if (flag === '--node') options.node = value;
      else if (flag === '--ref') options.ref = value;
      else if (value === 'plantuml' || value === 'raw-ts') options.seed = value;
      else throw new Error(USAGE);
    }
  }
  return options;
}

/** Child environment built from nothing: it never spreads the parent environment. */
function ciEnv({ scratch, nodeDir, shimDir, npmCli, base = {} }: {
  scratch: string, nodeDir: string, shimDir: string, npmCli: string, base?: Record<string, string | undefined>,
}): Record<string, string> {
  const home = path.join(scratch, 'home');
  const env: Record<string, string> = {
    PATH: [nodeDir, shimDir, ...SYSTEM_PATH].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(scratch, 'xdg', 'config'),
    XDG_DATA_HOME: path.join(scratch, 'xdg', 'data'),
    XDG_STATE_HOME: path.join(scratch, 'xdg', 'state'),
    XDG_CACHE_HOME: path.join(scratch, 'xdg', 'cache'),
    npm_config_cache: path.join(scratch, 'npm-cache'),
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
    npm_execpath: npmCli,
    CI: 'true',
    TERM: 'dumb',
  };
  // Deep scratch paths can exceed the macOS socket path limit, so temp stays where tests expect it.
  for (const key of ['TMPDIR', 'LANG']) if (base[key]) env[key] = base[key] as string;
  return env;
}

/** The ordered stages with their skip reasons for a seed. `seed` is a stage only in seed mode. */
function stagePlan({ seed = null }: { seed?: string | null } = {}): { id: string, run: boolean, reason?: string }[] {
  const only: Record<string, string[]> = {
    plantuml: ['env', 'clone', 'seed', 'suite'],
    'raw-ts': ['env', 'clone', 'pack', 'install', 'version'],
  };
  const all = ['env', 'clone', 'preflight', 'seed', 'suite', 'smoke', 'build', 'pack', 'install', 'version', 'install-g', 'verb'];
  const ids = seed ? all : all.filter((id) => id !== 'seed');
  return ids.map((id) => {
    if (!seed || only[seed].includes(id)) return { id, run: true };
    return { id, run: false, reason: id === 'seed' ? 'raw-ts needs no tree change' : `not part of the ${seed} seed` };
  });
}

function tail(text: string): string[] {
  return text.split(/\r?\n/).filter((line, i, all) => line !== '' || i < all.length - 1).slice(-40).map((line) => `    ${line}`);
}

/** First match of `name` on `pathVar`, as a real path. */
function findTool(name: string, pathVar: string | undefined, fsImpl: typeof fs): string | null {
  for (const dir of String(pathVar || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (fsImpl.existsSync(candidate)) return candidate;
  }
  return null;
}

function spawnRun(command: string, args: string[], { cwd, env, input, timeout }: RunOptions): RunResult {
  const result = spawnSync(command, args, {
    cwd, env, input, timeout, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024,
  });
  return { status: result.status, stdout: result.stdout || '', stderr: result.stderr || '', error: result.error };
}

/**
 * Runs the rehearsal. `run` is the only way anything is spawned; `scratchRoot` holds the scratch
 * directory; `baseEnv` supplies the inherited PATH, DOFLOW_REHEARSE_NODE and npm_execpath;
 * `invokingNode` is the Node used by the smoke stage and the default floor candidate.
 */
function runRehearse({
  repoRoot = REPO_ROOT,
  options = {},
  run = spawnRun,
  fsImpl = fs,
  scratchRoot = os.tmpdir(),
  baseEnv = process.env,
  invokingNode = process.execPath,
}: {
  repoRoot?: string,
  options?: Partial<Options>,
  run?: Run,
  fsImpl?: typeof fs,
  scratchRoot?: string,
  baseEnv?: Record<string, string | undefined>,
  invokingNode?: string,
} = {}): { exitCode: number, lines: string[] } {
  const opts: Options = { node: null, ref: 'HEAD', seed: null, registry: false, keep: false, ...options };
  const lines: string[] = [];
  const envFail = (message: string) => ({ exitCode: 3, lines: [...lines, `FAIL env: ${message}`] });

  // env: nothing here uses the scratch directory, so a failure leaves nothing behind.
  const git = run('git', ['--version'], { cwd: repoRoot, env: baseEnv });
  if (git.status !== 0) return envFail('git was not found on PATH');
  const pkgText = run('git', ['show', `${opts.ref}:package.json`], { cwd: repoRoot, env: baseEnv });
  if (pkgText.status !== 0) return envFail(`cannot read package.json at ${opts.ref}: ${(pkgText.stderr || '').trim()}`);
  let version: string;
  let floor: string;
  try {
    const pkg = JSON.parse(pkgText.stdout);
    version = String(pkg.version);
    floor = String(pkg.engines.node).match(/\d+\.\d+\.\d+/)![0];
  } catch {
    return envFail(`package.json at ${opts.ref} has no engines.node floor version`);
  }
  const nodeBin = path.resolve(opts.node || baseEnv.DOFLOW_REHEARSE_NODE || invokingNode);
  const nodeVersion = run(nodeBin, ['--version'], { env: baseEnv });
  const gotVersion = nodeVersion.status === 0 ? nodeVersion.stdout.trim() : '(not runnable)';
  if (gotVersion !== `v${floor}`) {
    return envFail(`need Node v${floor} but ${nodeBin} is ${gotVersion}; resolve it with `
      + `\`npx -y -p node@${floor} node -p process.execPath\` and pass it as --node or DOFLOW_REHEARSE_NODE`);
  }
  let npmCli = baseEnv.npm_execpath && fsImpl.existsSync(baseEnv.npm_execpath) ? baseEnv.npm_execpath : null;
  if (!npmCli) {
    const found = findTool('npm', baseEnv.PATH, fsImpl);
    if (found) npmCli = fsImpl.realpathSync(found);
  }
  if (!npmCli) return envFail('no npm CLI was found (set npm_execpath or put npm on PATH)');
  lines.push(`PASS env: Node v${floor} at ${nodeBin}, npm ${npmCli}, package version ${version}`);

  const scratch = fsImpl.mkdtempSync(path.join(scratchRoot, 'doflow-rehearse-'));
  const dir = (name: string) => path.join(scratch, name);
  const shimDir = dir('bin');
  for (const sub of ['home', 'xdg/config', 'xdg/data', 'xdg/state', 'xdg/cache', 'npm-cache', 'bin', 'project', 'tarballs']) {
    fsImpl.mkdirSync(dir(sub), { recursive: true });
  }
  fsImpl.writeFileSync(path.join(shimDir, 'npm'), `#!/bin/sh\nexec node ${JSON.stringify(npmCli)} "$@"\n`, { mode: 0o755 });
  for (const tool of RUNNER_TOOLS) {
    if (SYSTEM_PATH.slice(0, 2).some((d) => fsImpl.existsSync(path.join(d, tool)))) continue;
    const found = findTool(tool, baseEnv.PATH, fsImpl);
    if (found) fsImpl.symlinkSync(found, path.join(shimDir, tool));
  }

  const clone = dir('repo');
  const prefix = dir('prefix');
  // The child PATH gets a directory holding only a `node` link, never the folder the binary lives
  // in: that folder (Homebrew bin, ~/.local/bin) carries unrelated tools such as plantuml and jq.
  const nodeShim = (name: string, binary: string): string => {
    const shim = dir(name);
    fsImpl.mkdirSync(shim, { recursive: true });
    fsImpl.symlinkSync(binary, path.join(shim, 'node'));
    return shim;
  };
  const floorEnv = ciEnv({ scratch, nodeDir: nodeShim('node-floor', nodeBin), shimDir, npmCli, base: baseEnv });
  const invokingEnv = ciEnv({ scratch, nodeDir: nodeShim('node-invoking', invokingNode), shimDir, npmCli, base: baseEnv });
  let sha = '';
  let tarball = '';
  let packSource = dir('stage');

  const child = (command: string, args: string[], {
    cwd = clone, env = floorEnv, input, timeout = 5 * MINUTE,
  }: RunOptions = {}): { ok: boolean, output: string, stdout: string, kind?: 'exit' | 'timeout' | 'spawn', message: string } => {
    const result = run(command, args, { cwd, env, input, timeout });
    const output = `${result.stdout || ''}${result.stderr || ''}`;
    if (result.error) {
      const timedOut = result.error.code === 'ETIMEDOUT';
      return {
        ok: false, output, stdout: result.stdout || '', kind: timedOut ? 'timeout' : 'spawn',
        message: timedOut ? `timed out after ${Math.round(timeout / MINUTE)} min` : `could not run ${command}: ${result.error.message}`,
      };
    }
    if (result.status !== 0) return { ok: false, output, stdout: result.stdout || '', kind: 'exit', message: `exit ${result.status}` };
    return { ok: true, output, stdout: result.stdout || '', message: 'exit 0' };
  };
  const failed = (c: ReturnType<typeof child>, what: string): StageResult => (
    { ok: false, message: `${what}: ${c.message}`, output: c.output, kind: c.kind }
  );
  const nodeNpm = (args: string[], options: RunOptions = {}) => child(nodeBin, [npmCli as string, ...args], options);

  const stages: Record<string, () => StageResult> = {
    clone: () => {
      const rev = child('git', ['rev-parse', '--verify', `${opts.ref}^{commit}`], { cwd: repoRoot });
      if (!rev.ok) return failed(rev, `cannot resolve ${opts.ref}`);
      sha = rev.output.trim();
      const cloned = child('git', ['clone', '--quiet', '--no-local', repoRoot, clone], { cwd: scratch });
      if (!cloned.ok) return failed(cloned, 'git clone');
      const checkout = child('git', ['-C', clone, 'checkout', '--quiet', '--detach', sha], { cwd: scratch });
      if (!checkout.ok) return failed(checkout, 'git checkout');
      return { ok: true, message: `${opts.ref} is ${sha.slice(0, 12)}, cloned to ${clone}` };
    },
    preflight: () => {
      const c = child(nodeBin, ['src/release/preflight.ts', ...(opts.registry ? [] : ['--offline'])]);
      return c.ok ? { ok: true, message: opts.registry ? 'preflight passed' : 'preflight passed (--offline)' } : failed(c, 'preflight');
    },
    seed: () => {
      const c = child('git', ['revert', '--no-commit', SEED_COMMIT]);
      if (c.ok) return { ok: true, message: `reverted ${SEED_COMMIT} in the clone` };
      return { ...failed(c, `cannot apply seed plantuml (revert of ${SEED_COMMIT})`), fatal: true };
    },
    suite: () => {
      const seeded = opts.seed === 'plantuml';
      const c = child(nodeBin, ['--test', ...(seeded ? ['test/runtime/render-puml-stderr.test.ts'] : ['test/**/*.test.ts'])], { timeout: seeded ? 5 * MINUTE : 45 * MINUTE });
      if (c.ok) return { ok: true, message: seeded ? 'render-puml-stderr passed' : 'test suite passed' };
      return failed(c, seeded ? 'render-puml-stderr' : 'test suite');
    },
    smoke: () => {
      const c = child(invokingNode, ['--test', ...SMOKE_TESTS], { env: invokingEnv });
      return c.ok ? { ok: true, message: `${SMOKE_TESTS.length} files passed on the invoking Node` } : failed(c, 'smoke tests');
    },
    build: () => {
      const c = child(nodeBin, ['src/release/build-package.ts', packSource]);
      return c.ok ? { ok: true, message: `built ${packSource}` } : failed(c, 'build-package');
    },
    pack: () => {
      if (opts.seed === 'raw-ts') packSource = clone;
      const c = nodeNpm(['pack', packSource, '--pack-destination', dir('tarballs')]);
      if (!c.ok) return failed(c, 'npm pack');
      // npm prints the tarball name alone on stdout; its `npm notice filename:` line is on stderr.
      const names = [...new Set(c.stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.endsWith('.tgz')))];
      if (names.length !== 1) return { ok: false, message: `npm pack printed ${names.length} tarballs, expected 1`, output: c.output, kind: 'exit' };
      tarball = path.join(dir('tarballs'), path.basename(names[0]));
      return { ok: true, message: `packed ${path.basename(tarball)} from ${packSource}` };
    },
    install: () => {
      const c = nodeNpm(['install', '--offline', '--prefix', prefix, tarball], { cwd: dir('project') });
      return c.ok ? { ok: true, message: `installed into ${prefix}` } : failed(c, 'npm install');
    },
    version: () => {
      const c = child(path.join(prefix, 'node_modules', '.bin', 'doflow'), ['--version'], { cwd: dir('project') });
      if (!c.ok) return failed(c, 'doflow --version');
      const got = c.stdout.trim();
      return got === version ? { ok: true, message: `doflow --version is ${got}` }
        : { ok: false, message: `doflow --version printed ${JSON.stringify(got)}, expected ${version}`, output: c.output, kind: 'exit' };
    },
    'install-g': () => {
      const c = child(path.join(prefix, 'node_modules', '.bin', 'doflow'), ['install', '-g', '-f', '--no-backup', '-t', 'claude'], { cwd: dir('project'), input: '\n' });
      return c.ok ? { ok: true, message: 'global install into the scratch HOME passed' } : failed(c, 'doflow install -g');
    },
    verb: () => {
      const c = child('bash', [path.join(dir('home'), '.claude', 'bin', 'doflow-run'), 'paths', '--json'], { cwd: dir('project') });
      if (!c.ok) return failed(c, 'doflow-run paths');
      try {
        JSON.parse(c.stdout);
      } catch {
        return { ok: false, message: 'doflow-run paths --json did not print JSON', output: c.output, kind: 'exit' };
      }
      return { ok: true, message: 'doflow-run paths --json printed JSON' };
    },
  };

  const outcomes = new Map<string, Outcome>();
  let chainFailed: string | null = null;
  let anyFail = false;
  let fatal = false;
  for (const stage of stagePlan({ seed: opts.seed })) {
    if (stage.id === 'env') continue;
    if (!stage.run) {
      lines.push(`SKIP ${stage.id}: ${stage.reason}`);
      continue;
    }
    if (chainFailed) {
      lines.push(`SKIP ${stage.id}: after ${chainFailed} failed`);
      continue;
    }
    const result = stages[stage.id]();
    outcomes.set(stage.id, { id: stage.id, status: result.ok ? 'PASS' : 'FAIL', output: result.output || '', kind: result.kind });
    lines.push(`${result.ok ? 'PASS' : 'FAIL'} ${stage.id}: ${result.message}`);
    if (!result.ok) {
      anyFail = true;
      if (result.output) lines.push(...tail(result.output));
      if (stage.id !== 'preflight') chainFailed = stage.id;
      if (result.fatal) fatal = true;
    }
  }

  let exitCode: number;
  if (fatal) {
    exitCode = 3;
  } else if (opts.seed) {
    const expected = opts.seed === 'plantuml' ? 'suite' : 'version';
    const got = outcomes.get(expected);
    const missing = got ? SEED_SIGNATURES[opts.seed].filter((part) => !got.output.includes(part)) : [];
    const reproduced = Boolean(got && got.status === 'FAIL' && got.kind === 'exit' && missing.length === 0);
    if (reproduced) {
      lines.push(`SEED reproduced: ${opts.seed} failed at ${expected}`);
    } else {
      let outcome: string;
      if (!got) outcome = `FAIL at ${chainFailed}`;
      else if (got.status === 'PASS') outcome = 'PASS';
      else if (got.kind !== 'exit') outcome = `FAIL (${got.kind})`;
      else outcome = `FAIL without ${missing[0]}`;
      lines.push(`SEED not reproduced: ${opts.seed} expected ${expected}, got ${outcome}`);
    }
    exitCode = reproduced ? 0 : 1;
  } else {
    exitCode = anyFail ? 1 : 0;
  }

  if (exitCode === 0 && !opts.keep) {
    fsImpl.rmSync(scratch, { recursive: true, force: true });
  } else {
    lines.push(`scratch: ${scratch}`);
  }
  return { exitCode, lines };
}

if (require.main === module) {
  let options: Options | undefined;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error: any) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
  if (options) {
    const result = runRehearse({ options });
    process.stdout.write(`${result.lines.join('\n')}\n`);
    process.exitCode = result.exitCode;
  }
}

module.exports = { RUNNER_TOOLS, parseArgs, ciEnv, stagePlan, runRehearse };
