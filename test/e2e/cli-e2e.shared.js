'use strict';
// cli-e2e.shared.js — scratch-$HOME runners shared by the cli-e2e test files. Not a test file.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, "../..");
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN, expectExecutable } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');
const { tempDir, suiteTempDir } = require('../helper/tmp');

function cleanup() { for (const scratch of SCRATCHES.values()) scratch.remove(); }

// The per-harness MCP cases run in a scratch HOME with its own XDG folder and git config: nothing the
// developer's environment sets (XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL, DOFLOW_RETENTION_HOURS) reaches them.
const SCRATCHES = new Map();

function scratchHome() {
  const scratch = createScratch('doflow-cli-e2e-');
  SCRATCHES.set(scratch.home, scratch);
  return scratch.home;
}

function inheritedEnv(home) {
  const scratch = SCRATCHES.get(home);
  if (!scratch) return process.env;
  const env = scratch.env();
  delete env.DOFLOW_RETENTION_HOURS;
  return env;
}

// A developer's own PI_CODING_AGENT_DIR would redirect Pi's user-scope mcp.json away from the
// scratch HOME; the Pi case that needs it sets it explicitly for its own spawn.
delete process.env.PI_CODING_AGENT_DIR;

/** Scratch-$HOME env for a spawned CLI. os.homedir() prefers USERPROFILE on Windows and ignores
 * HOME there entirely, so both must be redirected or -g installs would land in the runner's real
 * profile instead of the scratch directory. */
function homeEnv(home) {
  return IS_WIN ? { HOME: home, USERPROFILE: home } : { HOME: home };
}

function run(args, { home, input, env } = {}) {
  const resolvedHome = home ?? suiteTempDir('doflow-cli-e2e-');
  return spawnSync('node', [DOFLOW, ...args], {
    cwd: REPO,
    env: { ...inheritedEnv(resolvedHome), ...env, ...homeEnv(resolvedHome) },
    // Reply "no" explicitly for prompt-abort cases. An empty input can leave the test worker's
    // non-blocking pseudo-TTY attached and make the CLI retry EAGAIN as if a user were typing.
    input: input || '\n',
    encoding: 'utf8',
    // Once kiro also carries the runtime, `status --json` over several harnesses prints more than
    // the 1 MiB default on macOS temporary paths, and spawnSync fails with ENOBUFS.
    maxBuffer: 16 * 1024 * 1024,
  });
}

function fakeBin(t, files) {
  const dir = tempDir(t, 'doflow-tools-bin-');
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function toolEnv(bin, extra = {}) {
  // Keep Node and /bin/sh reachable for the spawned test CLI and fake scripts, but deliberately
  // exclude the developer's PATH so an installed RTK/Graphify cannot affect fixture outcomes.
  return { ...extra, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
}

function runInteractive(args, { home, env, replies }) {
  return new Promise((resolve, reject) => {
    const resolvedHome = home ?? suiteTempDir('doflow-cli-e2e-');
    const child = require('node:child_process').spawn('node', [DOFLOW, ...args], {
      cwd: REPO,
      env: { ...inheritedEnv(resolvedHome), ...env, ...homeEnv(resolvedHome) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sent = 0;
    const sendReplies = () => {
      const prompts = (stdout.match(/\[y\/N\] /g) || []).length;
      while (sent < prompts && sent < replies.length) child.stdin.write(`${replies[sent++]}\n`);
      if (sent === replies.length) child.stdin.end();
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; sendReplies(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// The tools fixtures are POSIX-bound by construction: fakeBin writes `#!/bin/sh` scripts and
// toolEnv builds a colon-separated PATH ending in /usr/bin:/bin. Windows can neither exec a
// shebang script nor interpret that PATH, so the whole class is skipped there rather than
// silently exercising nothing.
function skipToolsOnWin(t) {
  if (IS_WIN) t.skip('tools fixtures require #!/bin/sh scripts and a POSIX PATH');
  return !IS_WIN;
}

module.exports = {
  REPO, DOFLOW, IS_WIN, expectExecutable, tempDir, suiteTempDir, cleanup, scratchHome, inheritedEnv, homeEnv, run, fakeBin, toolEnv, runInteractive, skipToolsOnWin,
};
