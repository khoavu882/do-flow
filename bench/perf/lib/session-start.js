'use strict';

/**
 * Session-start stdout/stderr measurement (075 IC-019).
 * Measures the byte contribution of session-start hooks installed into temporary HOME.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { declaredHarnessPaths, resolveHarnessPaths } = require('../../../src/helper/harness-paths.ts');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const HOOK_HARNESSES = new Set(['claude', 'codex', 'gemini', 'kiro']);

function isToolInstalled(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(cmd, [bin], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function resolveInstalledHook(harness, homeDir, repoRoot = REPO_ROOT) {
  if (!HOOK_HARNESSES.has(harness)) return null;
  const declared = declaredHarnessPaths(repoRoot)[harness];
  if (!declared) return null;
  const paths = resolveHarnessPaths(declared, { scope: 'user', scopeRoot: homeDir, homeDir });
  if (harness === 'claude') {
    return paths.configDir ? path.join(paths.configDir, 'hooks', 'session-start.sh') : null;
  }
  if (harness === 'codex' || harness === 'gemini') {
    return paths.hooksDirectory ? path.join(paths.hooksDirectory, 'session-start.sh') : null;
  }
  if (harness === 'kiro') {
    return paths.hooks ? path.join(paths.hooks, 'session-start.sh') : null;
  }
  return null;
}

function runHookProcess(hookPath, { cwd, homeDir, fixtureStdin, env: customEnv } = {}) {
  const env = {
    ...process.env,
    HOME: homeDir,
    XDG_CONFIG_HOME: path.join(homeDir, '.config'),
    ...customEnv,
  };
  try {
    const res = spawnSync('bash', [hookPath], {
      cwd,
      env,
      input: fixtureStdin,
      encoding: 'utf8',
      timeout: 10000,
    });
    // Some hooks ignore stdin and exit before spawnSync finishes writing it. Node then reports EPIPE
    // although the child ran to completion, so EPIPE with an exit status is a completed run: the exit
    // status below decides it, whatever it is. Any other error still fails the measurement.
    const completed = res.error && res.error.code === 'EPIPE' && res.status !== null;
    if (res.error && !completed) {
      if (res.error.code === 'ETIMEDOUT') {
        return {
          stdoutBytes: { unmeasured: 'hook timed out after 10s' },
          stderrBytes: { unmeasured: 'hook timed out after 10s' },
        };
      }
      return {
        stdoutBytes: { unmeasured: `hook failed: ${res.error.message}` },
        stderrBytes: { unmeasured: `hook failed: ${res.error.message}` },
      };
    }
    if (res.status !== 0) {
      return {
        stdoutBytes: { unmeasured: `hook failed with exit code ${res.status}` },
        stderrBytes: { unmeasured: `hook failed with exit code ${res.status}` },
      };
    }

    const stdoutBytes = Buffer.byteLength(res.stdout || '', 'utf8');
    const stderrBytes = Buffer.byteLength(res.stderr || '', 'utf8');
    return {
      stdoutBytes,
      stderrBytes,
    };
  } catch (err) {
    return {
      stdoutBytes: { unmeasured: `hook failed: ${err.message}` },
      stderrBytes: { unmeasured: `hook failed: ${err.message}` },
    };
  }
}

function measureSessionStart(harness, options = {}) {
  const {
    repoRoot = REPO_ROOT,
    homeDir,
    isJqAvailableFn = () => isToolInstalled('jq'),
    fixturePath = path.join(repoRoot, 'bench', 'perf', 'fixtures', 'shared', 'session-start.json'),
    installFn,
  } = options;

  if (!HOOK_HARNESSES.has(harness)) {
    return {
      stdoutBytes: { unmeasured: 'no session-start hook' },
      stderrBytes: { unmeasured: 'no session-start hook' },
    };
  }

  if (!isJqAvailableFn()) {
    return {
      stdoutBytes: { unmeasured: 'jq not on PATH' },
      stderrBytes: { unmeasured: 'jq not on PATH' },
    };
  }

  let fixtureStdin = '{}';
  if (fs.existsSync(fixturePath)) {
    fixtureStdin = fs.readFileSync(fixturePath, 'utf8');
  }

  // Pre-configured home directory (e.g. session-start-tree stub): run without install
  if (homeDir) {
    const hookPath = resolveInstalledHook(harness, homeDir, repoRoot);
    if (!hookPath || !fs.existsSync(hookPath)) {
      return {
        stdoutBytes: { unmeasured: 'no session-start hook' },
        stderrBytes: { unmeasured: 'no session-start hook' },
      };
    }
    return runHookProcess(hookPath, {
      cwd: options.cwd || repoRoot,
      homeDir,
      fixtureStdin,
      env: options.env,
    });
  }

  // Temporary HOME and XDG_CONFIG_HOME install
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), `doflow-perf-home-${harness}-`));
  const tempXdg = path.join(tempHome, '.config');
  fs.mkdirSync(tempXdg, { recursive: true });

  const tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), `doflow-perf-repo-${harness}-`));

  try {
    spawnSync('git', ['init', '-q'], { cwd: tempRepo });
    spawnSync(
      'git',
      ['-c', 'user.name=DoFlow', '-c', 'user.email=doflow@example.com', 'commit', '--allow-empty', '-m', 'fixed commit', '--date=2026-10-13T00:00:00Z'],
      { cwd: tempRepo }
    );

    let installStatus = 0;
    if (typeof installFn === 'function') {
      const res = installFn({ harness, tempHome, tempXdg, repoRoot });
      installStatus = res && res.status !== undefined ? res.status : 0;
    } else {
      const installBin = path.join(repoRoot, 'bin', 'doflow.js');
      const installRes = spawnSync(process.execPath, [installBin, 'install', '-g', '-t', harness, '-f'], {
        env: { ...process.env, HOME: tempHome, XDG_CONFIG_HOME: tempXdg },
        encoding: 'utf8',
        stdio: 'pipe',
      });
      installStatus = installRes.status ?? 1;
    }

    if (installStatus !== 0) {
      return {
        stdoutBytes: { unmeasured: `install failed: ${installStatus}` },
        stderrBytes: { unmeasured: `install failed: ${installStatus}` },
      };
    }

    const hookPath = resolveInstalledHook(harness, tempHome, repoRoot);
    if (!hookPath || !fs.existsSync(hookPath)) {
      return {
        stdoutBytes: { unmeasured: 'no session-start hook' },
        stderrBytes: { unmeasured: 'no session-start hook' },
      };
    }

    return runHookProcess(hookPath, {
      cwd: tempRepo,
      homeDir: tempHome,
      fixtureStdin,
    });
  } finally {
    try {
      fs.rmSync(tempHome, { recursive: true, force: true });
      fs.rmSync(tempRepo, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  }
}

module.exports = {
  HOOK_HARNESSES,
  isToolInstalled,
  resolveInstalledHook,
  measureSessionStart,
  runHookProcess,
};
