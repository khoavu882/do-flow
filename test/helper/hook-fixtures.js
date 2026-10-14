'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { removeTree, suiteTempDir } = require('./tmp');

const REPO = path.resolve(__dirname, '../..');
const FIXTURE_ROOT = path.join(REPO, 'test', 'fixtures', 'hooks', 'policy-golden');
const SHARED_TMP = suiteTempDir('doflow-hook-fixtures-');
const HOME = path.join(SHARED_TMP, 'home');
const XDG = path.join(SHARED_TMP, 'xdg');
fs.mkdirSync(HOME);
fs.mkdirSync(XDG);

function loadCorpus(policy) {
  const root = path.join(FIXTURE_ROOT, policy);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      return {
        name: entry.name,
        input: fs.readFileSync(path.join(dir, 'input.json'), 'utf8'),
        stdout: fs.readFileSync(path.join(dir, 'stdout.txt'), 'utf8'),
        stderr: fs.readFileSync(path.join(dir, 'stderr.txt'), 'utf8'),
        status: Number(fs.readFileSync(path.join(dir, 'exit.txt'), 'utf8').trim()),
      };
    });
}

function runPolicy(policy, input, { decisionFd = false, cwd = REPO, env = {}, policyPath } = {}) {
  const stdio = decisionFd ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'];
  const child = spawnSync('bash', [policyPath || path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'policies', `${policy}.sh`)], {
    cwd,
    env: {
      ...process.env,
      HOME,
      XDG_CONFIG_HOME: XDG,
      DOFLOW_FAILURE_CAPTURE: 'off',
      DOFLOW_DECISION_FD: '',
      DOFLOW_PROJECT_DIR: '',
      DOFLOW_AGENT: '',
      ...env,
      ...(decisionFd ? { DOFLOW_DECISION_FD: '3' } : {}),
    },
    input,
    encoding: 'utf8',
    stdio,
  });
  return {
    status: child.status,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    records: decisionFd ? (child.output[3] || Buffer.from('')).toString('utf8') : '',
  };
}

function runPolicyV1(policy, native, { harness, event, ...options } = {}) {
  const input = encodeEnvelope(harness, event, policy, typeof native === 'string' ? native : JSON.stringify(native));
  return runPolicy(policy, input, options);
}

function buildInstallMirror(target) {
  const result = spawnSync('bash', [path.join(REPO, 'test', 'hooks', 'build-install-mirror.sh'), target], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'install mirror build failed');
  return target;
}

function createScratchGitRepo(scratch, name = 'repo') {
  const root = scratch.path(name);
  fs.mkdirSync(root, { recursive: true });
  const run = (...args) => {
    const result = spawnSync('git', ['-c', 'user.name=hook-test', '-c', 'user.email=hook-test@example.invalid', ...args], {
      cwd: root,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`);
    return result.stdout;
  };
  run('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a\n');
  run('add', '-A');
  run('commit', '-q', '-m', 'hook fixture');
  return { root, run };
}

function parseRecords(framed) {
  return framed.split('\n').filter(Boolean).map((line) => {
    if (line.charCodeAt(0) !== 0x1e) throw new Error('decision record is missing its RS frame');
    return JSON.parse(line.slice(1));
  });
}

function createScratch(name = 'doflow-hook-fixtures-') {
  const dir = suiteTempDir(name);
  return {
    dir,
    path: (...parts) => path.join(dir, ...parts),
    write(relative, value) {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, value);
      return target;
    },
    remove() { removeTree(dir); },
  };
}

function jqSorted(value) {
  const result = spawnSync('jq', ['-S', '.'], { input: `${JSON.stringify(value)}\n`, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || 'jq -S failed');
  return result.stdout;
}

function encodeEnvelope(harness, event, policy, nativeInput, env = {}) {
  const result = spawnSync('jq', [
    '-c', '--arg', 'harness', harness, '--arg', 'event', event, '--arg', 'policy', policy,
    '-f', path.join(REPO, 'core/harnesses/shared/hooks/bridge/envelope.jq'),
  ], { input: nativeInput, env: { ...process.env, ...env }, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || `envelope encoding failed for ${harness}/${event}/${policy}`);
  return result.stdout.trimEnd();
}

module.exports = { FIXTURE_ROOT, REPO, buildInstallMirror, createScratch, createScratchGitRepo, encodeEnvelope, jqSorted, loadCorpus, parseRecords, runPolicy, runPolicyV1 };
