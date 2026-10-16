'use strict';

// dispatch-sandbox.js — feature 082, IC-041 fixtures (DEC-010, DEC-056). Test-only, never shipped.
//
// The one place a dispatch test builds a child PATH. makeDispatchSandbox(t, options) returns:
//   - a scratch git repository (test/helper/tmp.js) holding agent-docs/doflow/<slug>/plan.md, with
//     every file the plan's tasks declare seeded and committed so `commit -a` sees the edit, and
//     agent-docs/ and .doflow/ ignored as in a real checkout;
//   - a scratch bin/ holding the fake harness CLI links (test/helper/fake-harness-cli.js), a `node`
//     symlink to process.execPath, a `git` symlink to the git binary resolved from this process's
//     PATH, and only the system tools a test names (`systemTools`, for hook front doors);
//   - an env whose PATH is that bin/ alone, with HOME in the scratch and the five DOFLOW_* identity
//     variables set;
//   - a verification argv that starts with the absolute process.execPath.
//
// The PATH never contains dirname(process.execPath): on a developer machine the node install
// directory holds real codex, gemini or claude binaries (DEC-056, NFR-002, plan RK3). No harness
// binary is ever linked; a systemTools entry naming one throws.
//
// editDescriptors() is test/fixtures/worker/descriptors.json with a supported `isolatedEdit` on the
// claude fake (argv ['--edit-in-cwd']); gemini keeps none, so it reads unknown, reason
// not-declared. It lives here rather than in descriptors.json because 081's
// test/runtime/worker-fake-cli.test.js asserts each descriptors.json block holds exactly
// WORKER_KEYS, and that file stays byte-identical (plan §1, NFR-003).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('./tmp.js');
const { IDENTITY_VARS, linkBin, writeScenario } = require('./fake-harness-cli.js');
const DESCRIPTORS = require('../fixtures/worker/descriptors.json');
const { parsePlan } = require('../../src/runtime/scaffold/artifacts.ts');

const PLAN_DIR = path.join(__dirname, '..', 'fixtures', 'dispatch', 'plans');
const PLAN_FIXTURES = Object.freeze(['dependent', 'disjoint', 'overlap', 'budget']);
/** Real harness binary names a sandbox must never link or resolve. */
const HARNESS_BINARIES = Object.freeze(['claude', 'codex', 'gemini', 'opencode', 'kiro', 'kiro-cli', 'pi', 'copilot', 'antigravity']);
const FAKE_BINARIES = Object.freeze(Object.values(DESCRIPTORS).map((block) => block.cli.binary));
const EDIT_ARGV = Object.freeze(['--edit-in-cwd']);

/** descriptors.json with claude's supported isolatedEdit (IC-041); a fresh copy per call. */
function editDescriptors() {
  const copy = structuredClone(DESCRIPTORS);
  copy.claude.isolatedEdit = {
    status: 'supported',
    evidence: ['test/helper/dispatch-sandbox.js → editDescriptors'],
    verification: 'Run the fake CLI under test/helper/fake-harness-cli.js with --edit-in-cwd and a scenario for run.',
    verifiedOn: '2026-10-16',
    argv: [...EDIT_ARGV],
  };
  return copy;
}

/** The first executable named `name` on this process's PATH, or null. */
function resolveTool(name) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const full = path.join(dir, name);
    try {
      fs.accessSync(full, fs.constants.X_OK);
      if (fs.statSync(full).isFile()) return full;
    } catch { /* not here */ }
  }
  return null;
}

/** The text of a plan fixture name, or `plan` itself when it is plan text. */
function planText(plan) {
  if (PLAN_FIXTURES.includes(plan)) return fs.readFileSync(path.join(PLAN_DIR, `${plan}.md`), 'utf8');
  if (typeof plan === 'string' && plan.includes('\n')) return plan;
  throw new Error(`dispatch-sandbox: plan must be one of ${PLAN_FIXTURES.join(', ')} or plan text`);
}

/** git in `cwd` with the sandbox env; throws on failure. */
function git(cwd, env, args) {
  const r = spawnSync('git', args, { cwd, env, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`dispatch-sandbox: git ${args.join(' ')} failed: ${r.error?.code ?? r.stderr}`);
  return r.stdout;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {{ plan?: string, slug?: string, scenario?: object, systemTools?: string[], fakes?: string[],
 *   identity?: Record<string, string|undefined>, verify?: string }} [options]
 *   `plan`: a PLAN_FIXTURES name or plan text (default 'dependent'); `scenario`: written to
 *   FAKE_HARNESS_SCENARIO; `systemTools`: extra bare tool names to link (bash, jq, coreutils);
 *   `identity`: overrides for the five DOFLOW_* values, undefined deletes one; `verify`: the
 *   verification script run by `node -e` (default exits 0).
 */
function makeDispatchSandbox(t, { plan = 'dependent', slug = '082-dispatch-fixture', scenario = {}, systemTools = [], fakes = FAKE_BINARIES, identity = {}, verify = 'process.exitCode = 0' } = {}) {
  if (process.platform === 'win32') throw new Error('dispatch-sandbox: POSIX only (tree cleanup is unverified on win32, NFR-005)');
  const dir = tempDir(t, 'doflow-dispatch-');
  const root = path.join(dir, 'repo');
  const bin = path.join(dir, 'bin');
  const home = path.join(dir, 'home');
  fs.mkdirSync(root);
  fs.mkdirSync(home);

  // Fake CLI links (linkBin's returned 081 PATH is ignored), node and git, then named tools only.
  linkBin(bin, fakes);
  fs.symlinkSync(process.execPath, path.join(bin, 'node'));
  const gitPath = resolveTool('git');
  if (!gitPath) throw new Error('dispatch-sandbox: git is not on PATH');
  fs.symlinkSync(gitPath, path.join(bin, 'git'));
  for (const name of systemTools) {
    if (HARNESS_BINARIES.includes(name) || /[\\/]/.test(name) || ['node', 'git'].includes(name)) {
      throw new Error(`dispatch-sandbox: '${name}' is not a linkable system tool`);
    }
    const found = resolveTool(name);
    if (!found) throw new Error(`dispatch-sandbox: system tool '${name}' is not on PATH`);
    fs.symlinkSync(found, path.join(bin, name));
  }

  const scenarioFile = writeScenario(dir, scenario);
  const log = path.join(dir, 'harness-log.jsonl');
  const ids = {
    DOFLOW_RUN_ID: crypto.randomBytes(6).toString('hex'),
    DOFLOW_LINEAGE_ID: 'main',
    DOFLOW_ATTEMPT: '1',
    DOFLOW_SESSION_ROLE: 'main',
    DOFLOW_WORKTREE: root,
    ...identity,
  };
  const env = {
    PATH: bin,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_NOSYSTEM: '1',
    FAKE_HARNESS_SCENARIO: scenarioFile,
    FAKE_HARNESS_LOG: log,
  };
  for (const key of IDENTITY_VARS) if (ids[key] !== undefined) env[key] = ids[key];

  // The scratch repository: the plan, its declared files seeded, one initial commit.
  const text = planText(plan);
  const planFile = path.join(root, 'agent-docs', 'doflow', slug, 'plan.md');
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, text);
  fs.writeFileSync(path.join(root, '.gitignore'), 'agent-docs/\n.doflow/\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# dispatch sandbox\n');
  const files = [...new Set(parsePlan(text).tasks.flatMap((task) => task.files))];
  for (const file of files) {
    const full = path.join(root, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, `// ${file}\n`);
  }
  git(root, env, ['init', '-q', '-b', 'main']);
  git(root, env, ['add', '-A']);
  git(root, env, ['-c', 'user.name=sandbox', '-c', 'user.email=sandbox@invalid', 'commit', '-qm', 'sandbox: initial']);

  return {
    dir, root, bin, home, slug, planFile, files, scenarioFile, log, env, identity: ids,
    gitPath,
    verifyArgv: [process.execPath, '-e', verify],
    descriptors: editDescriptors(),
    /** Rewrites FAKE_HARNESS_SCENARIO in place. */
    setScenario: (next) => writeScenario(dir, next),
  };
}

module.exports = { makeDispatchSandbox, editDescriptors, resolveTool, PLAN_DIR, PLAN_FIXTURES, HARNESS_BINARIES, FAKE_BINARIES, EDIT_ARGV };
