'use strict';

/**
 * Context library for latency and performance benchmarks (074 FR-013, FR-014, IC-019).
 * Computes startupContext and contextBudgets per harness.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { alwaysLoaded } = require('../../../test/helper/always-loaded.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const HARNESS_CLI_MAP = Object.freeze({
  claude: 'claude',
  codex: 'codex',
  gemini: 'gemini',
  opencode: 'opencode',
  pi: 'pi',
  copilot: 'copilot',
  kiro: 'kiro-cli',
  antigravity: 'agy',
});

function isToolInstalled(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(cmd, [bin], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function getToolVersion(bin) {
  try {
    const res = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 5000 });
    if (res.status === 0 && res.stdout) {
      const line = res.stdout.trim().split('\n')[0].trim();
      return line || null;
    }
    return null;
  } catch {
    return null;
  }
}

function getHarnessesList(repoRoot) {
  const harnessesRegistryPath = path.join(repoRoot, 'core', 'registry', 'harnesses.json');
  if (fs.existsSync(harnessesRegistryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(harnessesRegistryPath, 'utf8'));
      if (Array.isArray(data.harnesses)) {
        return data.harnesses.map((h) => h.id);
      }
    } catch {
      // ignored
    }
  }
  return Object.keys(HARNESS_CLI_MAP);
}

function computeStartupContext(options = {}) {
  const {
    repoRoot = REPO_ROOT,
    harnesses = getHarnessesList(repoRoot),
    isToolInstalledFn = isToolInstalled,
    getToolVersionFn = getToolVersion,
    alwaysLoadedFn = alwaysLoaded,
  } = options;

  const always = alwaysLoadedFn();
  const doflowProjectedBytes = Array.isArray(always.files)
    ? always.files.reduce((sum, f) => sum + (f.bytes || 0), 0)
    : 0;

  const startupContext = [];

  for (const harness of harnesses) {
    const cli = HARNESS_CLI_MAP[harness] || harness;
    const installed = isToolInstalledFn(cli);
    const installedVersion = installed ? getToolVersionFn(cli) : null;

    let sessionStartStdoutBytes;
    if (!installed) {
      sessionStartStdoutBytes = { unmeasured: 'harness not installed' };
    } else {
      const hookPath = path.join(repoRoot, 'core', 'harnesses', harness, 'hooks', 'session-start.sh');
      if (!fs.existsSync(hookPath)) {
        sessionStartStdoutBytes = { unmeasured: 'no session-start hook' };
      } else {
        const harnessFixture = path.join(repoRoot, 'bench', 'perf', 'fixtures', harness, 'session-start.json');
        const sharedFixture = path.join(repoRoot, 'bench', 'perf', 'fixtures', 'shared', 'session-start.json');
        let fixturePath = null;
        if (fs.existsSync(harnessFixture)) {
          fixturePath = harnessFixture;
        } else if (fs.existsSync(sharedFixture)) {
          fixturePath = sharedFixture;
        }

        if (!fixturePath) {
          sessionStartStdoutBytes = { unmeasured: 'no fixture' };
        } else {
          try {
            const input = fs.readFileSync(fixturePath, 'utf8');
            const res = spawnSync('bash', [hookPath], {
              cwd: repoRoot,
              input,
              encoding: 'utf8',
              timeout: 10000,
            });
            if (res.status === 0) {
              sessionStartStdoutBytes = Buffer.byteLength(res.stdout || '', 'utf8');
            } else {
              sessionStartStdoutBytes = { unmeasured: `hook failed with exit code ${res.status}` };
            }
          } catch (e) {
            sessionStartStdoutBytes = { unmeasured: `hook execution error: ${e.message}` };
          }
        }
      }
    }

    const hookBytes = typeof sessionStartStdoutBytes === 'number' ? sessionStartStdoutBytes : 0;
    const totalBytes = doflowProjectedBytes + hookBytes;
    const tokensEst = Math.ceil(totalBytes / 4);

    startupContext.push({
      harness,
      installedVersion,
      doflowProjectedBytes,
      sessionStartStdoutBytes,
      tokensEst,
      tokensBasis: 'estimated:bytes/4',
      harnessNative: { unmeasured: 'needs a model call (paid)' },
    });
  }

  return startupContext;
}

function computeContextBudgets(options = {}) {
  const {
    repoRoot = REPO_ROOT,
    startupContext,
    declaredCapacities = {},
    ...rest
  } = options;

  const startup = startupContext || computeStartupContext({ repoRoot, ...rest });

  return startup.map((item) => {
    const harness = item.harness;
    const capacityTokens = declaredCapacities[harness] ?? null;
    const capacityBasis = capacityTokens != null ? 'declared' : 'profile-required';
    const startupTokens = item.tokensEst;
    const startupBasis = 'estimated';
    const reserveTokens = 0;
    const reserveBasis = 'estimated';
    const availableTokens = capacityTokens != null ? capacityTokens - startupTokens - reserveTokens : null;
    const availableBasis = capacityTokens != null ? 'estimated' : 'profile-required';

    return {
      harness,
      capacityTokens,
      capacityBasis,
      startupTokens,
      startupBasis,
      reserveTokens,
      reserveBasis,
      availableTokens,
      availableBasis,
    };
  });
}

module.exports = {
  computeStartupContext,
  computeContextBudgets,
  HARNESS_CLI_MAP,
  isToolInstalled,
  getToolVersion,
  getHarnessesList,
};
