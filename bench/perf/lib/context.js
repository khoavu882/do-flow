'use strict';

/**
 * Context library for latency and performance benchmarks (074 FR-013, FR-014; 075 IC-019, IC-020).
 * Computes startupContext and contextBudgets per harness.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { alwaysLoaded } = require('../../../test/helper/always-loaded.js');
const { measureSessionStart } = require('./session-start.js');

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

function validatePointerCostRows(rows) {
  for (const row of rows) {
    if (row.actual && typeof row.actual.basis === 'string' && row.actual.basis.startsWith('estimated:')) {
      throw new Error(`pointer ${row.pointerId} actual measurement cannot use an estimated basis`);
    }
  }
  return rows;
}

function pointerCostRows(pack, projectRoot) {
  const rows = [];
  for (const pointer of pack.pointers || []) {
    const targetPath = path.resolve(projectRoot, pointer.path);
    const relative = path.relative(projectRoot, targetPath);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(targetPath)) continue;
    const file = fs.readFileSync(targetPath, 'utf8');
    const lines = file.split(/\r?\n/);
    const slice = `${lines.slice(pointer.range.startLine - 1, pointer.range.endLine).join('\n')}\n`;
    const pointerBytes = pointer.bytes;
    const inlineBytes = pointer.inlineBytes;
    for (const target of [
      { kind: 'whole-file', bytes: Buffer.byteLength(file, 'utf8') },
      { kind: 'slice', bytes: Buffer.byteLength(slice, 'utf8') },
    ]) {
      rows.push({
        pointerId: pointer.id,
        path: pointer.path,
        range: pointer.range,
        target: target.kind,
        inlineBytes,
        pointerBytes,
        targetBytes: target.bytes,
        reads: 1,
        tokensEst: {
          inline: Math.ceil(inlineBytes / 4),
          followed: Math.ceil((pointerBytes + target.bytes) / 4),
          basis: 'estimated:bytes/4',
        },
        net: pointerBytes + target.bytes - inlineBytes,
        readProbability: { unmeasured: 'needs a model call (paid)' },
        actual: { unmeasured: 'needs a model call (paid)' },
      });
    }
  }
  return validatePointerCostRows(rows);
}

function runPointerCostPack({ fixture, repoRoot = REPO_ROOT, formatRows = pointerCostRows }) {
  const tempProjectDir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doflow-pointer-cost-'));
  try {
    const fixturePath = path.isAbsolute(fixture) ? fixture : path.join(repoRoot, fixture);
    if (!fs.existsSync(fixturePath)) throw new Error(`missing context-pack fixture: ${fixture}`);
    fs.cpSync(fixturePath, tempProjectDir, { recursive: true });
    const result = spawnSync(process.execPath, [
      path.join(repoRoot, 'bin', 'doflow.js'), 'context-pack', tempProjectDir,
      '--task-id', 'perf-cp', '--slug', 'perf-feature', '--json', '--no-record',
    ], { cwd: repoRoot, encoding: 'utf8', timeout: 30000, env: { ...process.env, DOFLOW_QUIET: '1' } });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`context-pack exited with status ${result.status}: ${result.stderr}`);
    const jsonStart = result.stdout.indexOf('{');
    if (jsonStart < 0) throw new Error('context-pack did not emit JSON');
    const pack = JSON.parse(result.stdout.slice(jsonStart));
    return formatRows(pack, tempProjectDir);
  } finally {
    fs.rmSync(tempProjectDir, { recursive: true, force: true });
  }
}

function computePointerCost({ fixture = 'bench/perf/fixtures/context-pack-project', repoRoot = REPO_ROOT, runPack = runPointerCostPack } = {}) {
  return runPack({ fixture, repoRoot, formatRows: pointerCostRows });
}

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
    measureSessionStartFn = measureSessionStart,
    homeDir = options.homeDir,
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

    const sessionRes = measureSessionStartFn(harness, {
      repoRoot,
      homeDir,
      isToolInstalledFn,
      ...options,
    });

    const sessionStartStdoutBytes = sessionRes.stdoutBytes;
    const sessionStartStderrBytes = sessionRes.stderrBytes;
    const sessionStartBasis = 'measured:temp-home-install';
    const perPromptStdoutBytes = { unmeasured: 'owner 077' };

    const hookBytes = typeof sessionStartStdoutBytes === 'number' ? sessionStartStdoutBytes : 0;
    const totalBytes = doflowProjectedBytes + hookBytes;
    const tokensEst = Math.ceil(totalBytes / 4);

    startupContext.push({
      harness,
      installedVersion,
      doflowProjectedBytes,
      sessionStartStdoutBytes,
      sessionStartStderrBytes,
      sessionStartBasis,
      perPromptStdoutBytes,
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
    contextProfiles,
    ...rest
  } = options;

  const startup = startupContext || computeStartupContext({ repoRoot, ...rest });

  let profiles = contextProfiles || null;
  if (!profiles) {
    const harnessesRegistryPath = path.join(repoRoot, 'core', 'registry', 'harnesses.json');
    if (fs.existsSync(harnessesRegistryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(harnessesRegistryPath, 'utf8'));
        if (Array.isArray(data.harnesses)) {
          profiles = {};
          for (const h of data.harnesses) {
            if (h.id && h.contextProfile) {
              profiles[h.id] = h.contextProfile;
            }
          }
        }
      } catch {
        // ignored
      }
    }
  }

  return startup.map((item) => {
    const harness = item.harness;
    const profile = profiles && profiles[harness] ? profiles[harness] : null;

    let capacityTokens = null;
    let capacityBasis = 'profile-required';
    if (declaredCapacities[harness] !== undefined) {
      capacityTokens = declaredCapacities[harness];
      capacityBasis = 'declared';
    } else if (profile && profile.capacityTokens) {
      if (profile.capacityTokens.unverified) {
        capacityTokens = null;
        capacityBasis = `unverified:${profile.capacityTokens.unverified}`;
      } else if (profile.capacityTokens.value !== undefined) {
        capacityTokens = profile.capacityTokens.value;
        capacityBasis = profile.capacityTokens.source || 'profile';
      }
    }

    let reserveTokens = 0;
    let reserveBasis = 'estimated';
    if (profile && profile.reserveTokens) {
      if (profile.reserveTokens.unverified) {
        reserveTokens = null;
        reserveBasis = `unverified:${profile.reserveTokens.unverified}`;
      } else if (profile.reserveTokens.value !== undefined) {
        reserveTokens = profile.reserveTokens.value;
        reserveBasis = profile.reserveTokens.source || 'profile';
      }
    }

    const startupTokens = item.tokensEst;
    const startupBasis = 'estimated';

    let availableTokens = null;
    let availableBasis = 'profile-required';
    if (capacityTokens != null && reserveTokens != null) {
      availableTokens = capacityTokens - startupTokens - reserveTokens;
      availableBasis = 'estimated';
    }

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
  computePointerCost,
  pointerCostRows,
  validatePointerCostRows,
  HARNESS_CLI_MAP,
  isToolInstalled,
  getToolVersion,
  getHarnessesList,
};
