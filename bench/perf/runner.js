#!/usr/bin/env node
'use strict';

/**
 * Performance benchmark runner (074 IC-018): `npm run bench -- perf <measure|check> [flags]`.
 * Measures command and hook latency, verifies latency ceilings against intent budgets,
 * and maintains bench/perf/budgets.json.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const stats = require('../retrieval/lib/stats.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_BUDGETS_PATH = path.join(__dirname, 'budgets.json');
const DEFAULT_SEED = 20261012;
const DEFAULT_RUNS = 30;
const DEFAULT_WARMUPS = 3;

const DEFAULT_INTENT_BUDGETS_MS = Object.freeze({
  help: 100,
  verb: 150,
  diagnostic: 500,
  install: 200,
  hook: 100,
  guardFile: 250,
});

const DEFAULT_HEADROOM = Object.freeze({ minMs: 10, pct: 25 });

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

class UsageError extends Error {}

function isToolInstalled(bin) {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const res = spawnSync(cmd, [bin], { stdio: 'ignore' });
    return res.status === 0;
  } catch {
    return false;
  }
}

function isAnotherNodeTestRunning({ excludePids = new Set([process.pid, process.ppid]) } = {}) {
  try {
    const out = execFileSync('ps', ['-A', '-o', 'pid,command'], { encoding: 'utf8' });
    const lines = out.split('\n');
    for (const line of lines) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) continue;
      const pid = parseInt(match[1], 10);
      const cmd = match[2];
      if (excludePids.has(pid)) continue;
      if (cmd.includes('node --test')) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** First 12 hex of SHA-256 of hostname|cpu model|cpu count|total memory (IC-015, IC-019). */
function getMachineId({
  hostname = os.hostname(),
  cpus = os.cpus(),
  totalmem = os.totalmem(),
} = {}) {
  const model = cpus.length > 0 ? cpus[0].model : '';
  return crypto
    .createHash('sha256')
    .update(`${hostname}|${model}|${cpus.length}|${totalmem}`)
    .digest('hex')
    .slice(0, 12);
}

function computeCeilingMs(p95Ms, headroom, intentBudget) {
  const minMs = headroom && typeof headroom.minMs === 'number' ? headroom.minMs : DEFAULT_HEADROOM.minMs;
  const pct = headroom && typeof headroom.pct === 'number' ? headroom.pct : DEFAULT_HEADROOM.pct;
  const headroomMs = Math.max(minMs, (p95Ms * pct) / 100);
  const rawCeiling = Math.ceil(p95Ms + headroomMs);
  if (intentBudget != null && Number.isFinite(intentBudget)) {
    return Math.min(intentBudget, rawCeiling);
  }
  return rawCeiling;
}

/**
 * Enumerate hook surfaces from filesystem and determine unmeasured reasons (IC-018).
 */
function enumerateHookSurfaces({
  repoRoot = REPO_ROOT,
  isToolInstalledFn = isToolInstalled,
} = {}) {
  const surfaces = [];
  const unmeasuredRows = [];

  const harnessesRegistryPath = path.join(repoRoot, 'core', 'registry', 'harnesses.json');
  let harnessesList = [];
  if (fs.existsSync(harnessesRegistryPath)) {
    try {
      const data = JSON.parse(fs.readFileSync(harnessesRegistryPath, 'utf8'));
      harnessesList = data.harnesses || [];
    } catch {
      // ignored
    }
  }

  for (const h of harnessesList) {
    const harnessId = h.id;
    const cliName = HARNESS_CLI_MAP[harnessId] || harnessId;
    if (!isToolInstalledFn(cliName)) {
      const id = `hook.${harnessId}`;
      surfaces.push({
        id,
        kind: 'hook',
        argv: [],
        harness: harnessId,
        intentClass: 'hook',
        enforced: false,
      });
      unmeasuredRows.push({
        surfaceId: id,
        unmeasured: 'harness not installed',
      });
      continue;
    }

    const hooksDir = path.join(repoRoot, 'core', 'harnesses', harnessId, 'hooks');
    if (!fs.existsSync(hooksDir) || !fs.statSync(hooksDir).isDirectory()) {
      if (harnessId === 'pi') continue;
      const id = `hook.${harnessId}`;
      surfaces.push({
        id,
        kind: 'hook',
        argv: [],
        harness: harnessId,
        intentClass: 'hook',
        enforced: false,
      });
      unmeasuredRows.push({
        surfaceId: id,
        unmeasured: 'no hooks are projected',
      });
      continue;
    }

    if (harnessId === 'antigravity') continue;
    const entries = fs.readdirSync(hooksDir);
    for (const file of entries) {
      if (!file.endsWith('.sh') || file === 'lib.sh' || file.endsWith('.impl.sh')) continue;
      const stem = file.slice(0, -3);
      const surfaceId = `hook.${harnessId}.${stem}`;
      const fixtureRel = path.join('bench', 'perf', 'fixtures', harnessId, `${stem}.json`);
      const fixtureAbs = path.join(repoRoot, fixtureRel);
      const corpusRel = path.join('test', 'fixtures', 'hooks', harnessId, stem, 'perf.json');
      const corpusAbs = path.join(repoRoot, corpusRel);
      const hasFixture = fs.existsSync(fixtureAbs) || fs.existsSync(corpusAbs);

      const surface = {
        id: surfaceId,
        kind: 'hook',
        argv: ['bash', `{mirror}/.${harnessId}/hooks/${file}`],
        harness: harnessId,
        intentClass: 'hook',
        enforced: false,
        setup: { kind: 'hook-install-mirror', fixture: 'bench/perf/fixtures/hook-bridge-project', git: true },
      };
      if (hasFixture) {
        if (fs.existsSync(fixtureAbs)) {
          surface.stdinFixture = fixtureRel;
        } else {
          surface.stdinFixture = corpusRel;
          surface.stdinField = 'native';
        }
      }
      surfaces.push(surface);

      // Kiro exposes the same front door from two config sources; keep both observable.
      const agentFixtureRel = path.join('test', 'fixtures', 'hooks', harnessId, stem, 'agent-perf.json');
      if (harnessId === 'kiro' && fs.existsSync(path.join(repoRoot, agentFixtureRel))) {
        surfaces.push({
          ...surface,
          id: `${surfaceId}.agent-config`,
          stdinFixture: agentFixtureRel,
          stdinField: 'native',
        });
      }

      if (!hasFixture) {
        unmeasuredRows.push({
          surfaceId,
          unmeasured: 'no fixture',
        });
      }
    }
  }

  // Antigravity's bridge front door is the stream runner, not a shell hook file.
  const antigravityRunner = path.join(repoRoot, 'core', 'harnesses', 'shared', 'hooks', 'stream-hook-runner.js');
  if (fs.existsSync(antigravityRunner)) {
    for (const [stem, fixtureStem, event] of [['pre-implementation-gate', 'pre-implement-gate', 'PreToolUse'], ['stop-check', 'stop-check', 'Stop']]) {
      const fixtureRel = path.join('test', 'fixtures', 'hooks', 'antigravity', fixtureStem, 'allow-perf.json');
      const id = `hook.antigravity.${stem}`;
      surfaces.push({
        id,
        kind: 'hook',
        argv: ['node', path.join('core', 'harnesses', 'shared', 'hooks', 'stream-hook-runner.js'), event],
        harness: 'antigravity',
        intentClass: 'hook',
        enforced: false,
        stdinFixture: fixtureRel,
        stdinField: 'native',
        setup: { kind: 'copy-fixture-project', fixture: 'bench/perf/fixtures/hook-bridge-project', git: true, branch: 'feat/perf', cwdProject: true },
      });
    }
  }

  // Pi has no shell front door; measure the shared bridge policy entry points directly.
  const piExtension = path.join(repoRoot, 'core', 'harnesses', 'pi', 'extensions', 'doflow-guard.js');
  const piFixtureDir = path.join(repoRoot, 'test', 'fixtures', 'hooks', 'pi', 'tool_call');
  if (fs.existsSync(piExtension)) {
    for (const policy of ['pre-implementation-gate', 'pre-bash-guard', 'mcp-tool-guard']) {
      const id = `hook.pi.tool-call-${policy}`;
      surfaces.push({
        id,
        kind: 'hook',
        argv: ['bash', path.join('core', 'harnesses', 'shared', 'hooks', 'bridge', 'bridge.sh'), 'pi', 'tool_call', policy],
        harness: 'pi',
        intentClass: 'hook',
        enforced: false,
        stdinFixture: path.join('test', 'fixtures', 'hooks', 'pi', 'tool_call', `${policy === 'pre-implementation-gate' ? 'perf-edit' : policy === 'pre-bash-guard' ? 'perf-bash' : 'perf-mcp'}.json`),
        stdinField: 'native',
        setup: { kind: 'copy-fixture-project', fixture: 'bench/perf/fixtures/hook-bridge-project', git: true, branch: 'feat/perf', cwdProject: true },
      });
      if (!fs.existsSync(piFixtureDir)) unmeasuredRows.push({ surfaceId: id, unmeasured: 'no fixture' });
    }
  }

  // Enumerate shared policy hooks
  const sharedPoliciesDir = path.join(repoRoot, 'core', 'harnesses', 'shared', 'hooks', 'policies');
  if (fs.existsSync(sharedPoliciesDir) && fs.statSync(sharedPoliciesDir).isDirectory()) {
    const entries = fs.readdirSync(sharedPoliciesDir);
    for (const file of entries) {
      if (!file.endsWith('.sh') || file === 'lib.sh' || file === 'deny-json.sh' || file === 'contract.sh') continue;
      const stem = file.slice(0, -3);
      const surfaceId = `hook.shared.${stem}`;
      const fixtureRel = path.join('bench', 'perf', 'fixtures', 'shared', `${stem}.json`);
      const fixtureAbs = path.join(repoRoot, fixtureRel);
      const hasFixture = fs.existsSync(fixtureAbs);
      const enforced = stem === 'pre-bash-guard' || stem === 'user-prompt-submit';

      const surface = {
        id: surfaceId,
        kind: 'hook',
        argv: ['bash', path.join('core', 'harnesses', 'shared', 'hooks', 'policies', file)],
        harness: 'shared',
        intentClass: 'hook',
        enforced,
      };
      if (hasFixture) {
        surface.stdinFixture = fixtureRel;
      }
      surfaces.push(surface);

      if (!hasFixture) {
        unmeasuredRows.push({
          surfaceId,
          unmeasured: 'no fixture',
        });
      }
    }
  }

  return { surfaces, unmeasuredRows };
}

function parseFlags(args, allowed) {
  const out = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      rest.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = arg.slice(2, eq === -1 ? undefined : eq);
    const kind = allowed[name];
    if (!kind) throw new UsageError(`unknown flag --${name}`);
    if (kind === 'bool') {
      if (eq !== -1) throw new UsageError(`--${name} takes no value`);
      out[name] = true;
    } else {
      const value = eq !== -1 ? arg.slice(eq + 1) : args[++i];
      if (value === undefined || (eq === -1 && value.startsWith('--'))) {
        throw new UsageError(`--${name} needs a value`);
      }
      out[name] = value;
    }
  }
  return { flags: out, rest };
}

function runSurfaceProcess(surface, repoRoot, tempHome) {
  const argv = surface.argv || [];
  if (argv.length === 0) return 0;

  let tempProjectDir = null;
  let tempMirrorDir = null;
  try {
    if (surface.setup && surface.setup.kind === 'hook-install-mirror') {
      tempMirrorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-perf-mirror-'));
      const buildMirror = spawnSync('bash', [path.join(repoRoot, 'test', 'hooks', 'build-install-mirror.sh'), tempMirrorDir], {
        cwd: repoRoot,
        encoding: 'utf8',
      });
      if (buildMirror.status !== 0) throw new Error(`install mirror failed: ${buildMirror.stderr || buildMirror.error?.message || buildMirror.status}`);
      tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-perf-project-'));
      const fixtureSrc = path.isAbsolute(surface.setup.fixture)
        ? surface.setup.fixture
        : path.join(repoRoot, surface.setup.fixture);
      if (!fs.existsSync(fixtureSrc)) throw new Error(`missing fixture directory: ${surface.setup.fixture}`);
      fs.cpSync(fixtureSrc, tempProjectDir, { recursive: true });
      const gitInit = spawnSync('git', ['init', '-q', '-b', 'feat/perf'], { cwd: tempProjectDir, encoding: 'utf8' });
      if (gitInit.status !== 0) throw new Error(`fixture git init failed: ${gitInit.stderr || gitInit.error?.message || gitInit.status}`);
    } else if (surface.setup && surface.setup.kind === 'copy-fixture-project') {
      tempProjectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-perf-fixture-'));
      const fixtureSrc = path.isAbsolute(surface.setup.fixture)
        ? surface.setup.fixture
        : path.join(repoRoot, surface.setup.fixture);
      if (!fs.existsSync(fixtureSrc)) {
        throw new Error(`missing fixture directory: ${surface.setup.fixture}`);
      }
      fs.cpSync(fixtureSrc, tempProjectDir, { recursive: true });
      let untrackedGeneratedDir = null;
      if (surface.setup.generate !== undefined) {
        const { dir, count } = surface.setup.generate || {};
        if (typeof dir !== 'string' || !dir || path.isAbsolute(dir)
          || !Number.isInteger(count) || count < 1 || count > 10000) {
          throw new Error('copy-fixture-project setup generate needs a relative dir and a positive integer count no greater than 10000');
        }
        const generatedDir = path.resolve(tempProjectDir, dir);
        const relativeDir = path.relative(tempProjectDir, generatedDir);
        if (relativeDir === '..' || relativeDir.startsWith(`..${path.sep}`)) {
          throw new Error('copy-fixture-project setup generate dir must stay inside the project');
        }
        if (surface.setup.generate.untracked === true) {
          untrackedGeneratedDir = { generatedDir, count };
        } else {
          fs.mkdirSync(generatedDir, { recursive: true });
          for (let i = 0; i < count; i++) {
            fs.writeFileSync(path.join(generatedDir, `f${i}.js`), `export const v${i} = ${i};\n`, 'utf8');
          }
        }
      }
      if (surface.setup.git !== false) {
        const gitArgs = ['init', '-q'];
        if (surface.setup.branch) gitArgs.push('-b', surface.setup.branch);
        spawnSync('git', gitArgs, { cwd: tempProjectDir });
        spawnSync('git', ['add', '-A'], { cwd: tempProjectDir });
        spawnSync(
          'git',
          [
            '-c', 'user.name=DoFlow Perf',
            '-c', 'user.email=perf@doflow.dev',
            'commit', '-q', '-m', 'fixture',
            '--date=2026-10-13T00:00:00Z',
          ],
          { cwd: tempProjectDir }
        );
      }
      if (untrackedGeneratedDir) {
        fs.mkdirSync(untrackedGeneratedDir.generatedDir, { recursive: true });
        for (let i = 0; i < untrackedGeneratedDir.count; i++) {
          fs.writeFileSync(path.join(untrackedGeneratedDir.generatedDir, `f${i}.js`), `export const v${i} = ${i};\n`, 'utf8');
        }
      }
    }

    const effectiveArgv = (tempProjectDir || tempMirrorDir)
      ? argv.map((a) => {
        if (typeof a !== 'string') return a;
        const substituted = a.replace(/\{project\}/g, tempProjectDir || '').replace(/\{mirror\}/g, tempMirrorDir || '');
        return tempProjectDir && substituted.startsWith(`core${path.sep}harnesses${path.sep}`)
          ? path.join(repoRoot, substituted)
          : substituted;
      })
      : argv;

    let [cmd, ...args] = effectiveArgv;
    if (cmd === 'node') {
      cmd = process.execPath;
    }
    const env = { ...process.env, DOFLOW_QUIET: '1' };
    if (surface.kind === 'install' || surface.intentClass === 'install' || surface.id === 'install.dry-run') {
      if (tempHome) env.HOME = tempHome;
    }
    const timeoutMs = surface.timeoutMs != null
      ? surface.timeoutMs
      : (surface.timeout != null ? surface.timeout : 30000);
    const spawnOpts = {
      cwd: tempProjectDir && (surface.setup?.kind === 'hook-install-mirror' || surface.setup?.cwdProject)
        ? tempProjectDir
        : repoRoot,
      env,
      encoding: 'utf8',
      timeout: timeoutMs,
    };
    if (surface.stdinFixture) {
      const fixturePath = path.isAbsolute(surface.stdinFixture)
        ? surface.stdinFixture
        : path.join(repoRoot, surface.stdinFixture);
      if (!fs.existsSync(fixturePath)) {
        throw new Error(`missing stdin fixture: ${surface.stdinFixture}`);
      }
      const fixtureText = fs.readFileSync(fixturePath, 'utf8');
      if (surface.stdinField) {
        const fixture = JSON.parse(fixtureText);
        if (!Object.hasOwn(fixture, surface.stdinField)) {
          throw new Error(`missing ${surface.stdinField} in stdin fixture: ${surface.stdinFixture}`);
        }
        let payload = JSON.stringify(fixture[surface.stdinField]);
        if (tempProjectDir) payload = payload.replace(/<project>/g, tempProjectDir);
        spawnOpts.input = payload;
      } else {
        spawnOpts.input = fixtureText;
      }
    }
    const start = process.hrtime.bigint();
    const res = spawnSync(cmd, args, spawnOpts);
    const end = process.hrtime.bigint();
    if (res.error) {
      if (res.error.code === 'ETIMEDOUT') {
        throw new Error(`timed out after ${spawnOpts.timeout / 1000}s`);
      }
      throw new Error(`process error: ${res.error.message}`);
    }
    if (res.status !== 0) {
      throw new Error(`process exited with status ${res.status}`);
    }
    return Number(end - start) / 1_000_000;
  } finally {
    if (tempProjectDir) {
      try {
        fs.rmSync(tempProjectDir, { recursive: true, force: true });
      } catch {
        // ignored
      }
    }
    if (tempMirrorDir) {
      try { fs.rmSync(tempMirrorDir, { recursive: true, force: true }); } catch { /* ignored */ }
    }
  }
}

function cmdMeasure(flags, options = {}) {
  const {
    repoRoot = REPO_ROOT,
    budgetsPath = flags.budgets ? path.resolve(flags.budgets) : DEFAULT_BUDGETS_PATH,
    isAnotherNodeTestRunningFn = isAnotherNodeTestRunning,
    runSurfaceFn = runSurfaceProcess,
    log = (m) => process.stdout.write(`${m}\n`),
    err = (m) => process.stderr.write(`${m}\n`),
  } = options;

  // 1. Refuse with exit 2 while another node --test process is running
  if (isAnotherNodeTestRunningFn()) {
    err('perf measure: another node --test process is running; exclusive execution required');
    return { exitCode: 2, error: 'another node --test process is running' };
  }

  const runs = flags.runs ? parseInt(flags.runs, 10) : DEFAULT_RUNS;
  if (!Number.isInteger(runs) || runs <= 0) {
    throw new UsageError('--runs must be a positive integer');
  }
  const warmups = flags.warmups ? parseInt(flags.warmups, 10) : DEFAULT_WARMUPS;
  if (!Number.isInteger(warmups) || warmups < 0) {
    throw new UsageError('--warmups must be a non-negative integer');
  }
  const seed = flags.seed ? parseInt(flags.seed, 10) : DEFAULT_SEED;

  // Load budgets.json if it exists
  let budgets = null;
  if (fs.existsSync(budgetsPath)) {
    try {
      budgets = JSON.parse(fs.readFileSync(budgetsPath, 'utf8'));
    } catch {
      // ignored
    }
  }

  const intentBudgetsMs = budgets && budgets.intentBudgetsMs ? budgets.intentBudgetsMs : DEFAULT_INTENT_BUDGETS_MS;
  const headroom = budgets && budgets.headroom ? budgets.headroom : DEFAULT_HEADROOM;

  // Enumerate hook surfaces
  const { surfaces: hookSurfaces, unmeasuredRows: hookUnmeasured } = enumerateHookSurfaces({ repoRoot });

  // Surfaces pool
  let allSurfaces = [];
  if (options.surfaces) {
    allSurfaces = options.surfaces;
  } else if (budgets && Array.isArray(budgets.surfaces) && budgets.surfaces.length > 0) {
    const knownIds = new Set(budgets.surfaces.map((s) => s.id));
    allSurfaces = [...budgets.surfaces];
    for (const hs of hookSurfaces) {
      if (!knownIds.has(hs.id)) {
        allSurfaces.push(hs);
        knownIds.add(hs.id);
      }
    }
  } else {
    allSurfaces = [...hookSurfaces];
  }

  // Filter if --surface was supplied
  let selectedSurfaces = allSurfaces;
  if (flags.surface) {
    const selectedIds = new Set(flags.surface.split(',').map((s) => s.trim()));
    selectedSurfaces = allSurfaces.filter((s) => selectedIds.has(s.id));
  }

  const unmeasuredMap = new Map();
  for (const u of hookUnmeasured) {
    unmeasuredMap.set(u.surfaceId, u.unmeasured);
  }

  const measurableSurfaces = [];
  const unmeasuredRows = [];

  for (const s of selectedSurfaces) {
    if (unmeasuredMap.has(s.id)) {
      unmeasuredRows.push({ surfaceId: s.id, unmeasured: unmeasuredMap.get(s.id) });
    } else if (!s.argv || s.argv.length === 0) {
      unmeasuredRows.push({ surfaceId: s.id, unmeasured: 'no executable command' });
    } else {
      measurableSurfaces.push(s);
    }
  }

  // Run warm-ups
  let tempHomeDir = null;
  const hasInstall = measurableSurfaces.some(
    (s) => s.kind === 'install' || s.intentClass === 'install' || s.id === 'install.dry-run'
  );
  if (hasInstall) {
    tempHomeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-perf-home-'));
  }

  try {
    const failedSurfaces = new Map();
    const tryRunSurface = (surface) => {
      try {
        const res = runSurfaceFn(surface, repoRoot, tempHomeDir);
        if (typeof res === 'object' && res !== null && res.error) {
          throw new Error(res.error);
        }
        return { ok: true, durMs: Number(res) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    };

    for (const surface of measurableSurfaces) {
      for (let w = 0; w < warmups; w++) {
        const outcome = tryRunSurface(surface);
        if (!outcome.ok) {
          failedSurfaces.set(surface.id, outcome.error);
          break;
        }
      }
    }

    // Initialize round measurements
    const surfaceSamples = new Map();
    for (const s of measurableSurfaces) {
      if (!failedSurfaces.has(s.id)) {
        surfaceSamples.set(s.id, []);
      }
    }

    let redos = 0;
    const controlSamples = [];
    const rng = stats.mulberry32(seed);

    for (let r = 0; r < runs; r++) {
      let accepted = false;
      while (!accepted) {
        // Control: node -e 0
        const cStart = process.hrtime.bigint();
        spawnSync(process.execPath, ['-e', '0'], { cwd: repoRoot, env: { ...process.env, DOFLOW_QUIET: '1' } });
        const cEnd = process.hrtime.bigint();
        const cMs = Number(cEnd - cStart) / 1_000_000;

        const runningMedian = controlSamples.length > 0 ? stats.median(controlSamples) : cMs;
        if (controlSamples.length > 0 && cMs > 2 * runningMedian && redos < 10) {
          redos++;
          continue;
        }

        controlSamples.push(cMs);
        accepted = true;

        const shuffled = stats.shuffle(measurableSurfaces, rng);
        for (const surface of shuffled) {
          if (failedSurfaces.has(surface.id)) continue;
          const outcome = tryRunSurface(surface);
          if (!outcome.ok) {
            failedSurfaces.set(surface.id, outcome.error);
            surfaceSamples.delete(surface.id);
          } else {
            surfaceSamples.get(surface.id).push(outcome.durMs);
          }
        }
      }
    }

    for (const [id, reason] of failedSurfaces.entries()) {
      err(`perf measure: surface ${id} failed: ${reason}`);
    }

    const successfullyMeasuredSurfaces = measurableSurfaces.filter((s) => !failedSurfaces.has(s.id));
    const machine = getMachineId();
    const measuredOn = new Date().toISOString().slice(0, 10);
    const controlP50Ms = controlSamples.length > 0 ? stats.median(controlSamples) : 0;

    const measuredRows = successfullyMeasuredSurfaces.map((surface) => {
      const samples = surfaceSamples.get(surface.id);
      const p50Ms = stats.median(samples);
      const p95Ms = stats.percentile(samples, 0.95);
      const maxMs = Math.max(...samples);
      const madMs = stats.mad(samples);
      const roundedP95Ms = Math.round(p95Ms * 100) / 100;
      const intent = surface.intentClass && surface.intentClass !== 'none' ? intentBudgetsMs[surface.intentClass] : null;
      const minMs = headroom.minMs ?? DEFAULT_HEADROOM.minMs;
      const pct = headroom.pct ?? DEFAULT_HEADROOM.pct;
      const headroomMs = Math.max(minMs, (roundedP95Ms * pct) / 100);
      const ceilingMs = computeCeilingMs(roundedP95Ms, headroom, intent);

      return {
        surfaceId: surface.id,
        platform: process.platform,
        arch: process.arch,
        machineId: machine,
        measuredOn,
        runs: samples.length,
        warmups,
        interleave: 'seeded-shuffle-per-round',
        seed,
        p50Ms: Math.round(p50Ms * 100) / 100,
        p95Ms: roundedP95Ms,
        maxMs: Math.round(maxMs * 100) / 100,
        madMs: Math.round(madMs * 100) / 100,
        controlP50Ms: Math.round(controlP50Ms * 100) / 100,
        redos,
        headroomMs: Math.round(headroomMs * 100) / 100,
        ceilingMs,
        status: 'proposed',
      };
    });

    const allOutputRows = [...measuredRows, ...unmeasuredRows];

    if (flags.write && failedSurfaces.size === 0) {
      if (!budgets) {
        budgets = {
          schemaVersion: 1,
          intentBudgetsMs,
          headroom,
          machines: [],
          surfaces: allSurfaces,
          rows: [],
        };
      }
      if (!Array.isArray(budgets.machines)) budgets.machines = [];
      if (!Array.isArray(budgets.rows)) budgets.rows = [];

      // Upsert machine
      const mIdx = budgets.machines.findIndex((m) => m.machineId === machine);
      const machineRecord = {
        machineId: machine,
        os: process.platform,
        arch: process.arch,
        cpuModel: os.cpus().length > 0 ? os.cpus()[0].model : '',
        cpuCount: os.cpus().length,
        totalMemMB: Math.round(os.totalmem() / (1024 * 1024)),
        node: process.version,
      };
      if (mIdx >= 0) budgets.machines[mIdx] = machineRecord;
      else budgets.machines.push(machineRecord);

      // Upsert rows
      for (const row of measuredRows) {
        const idx = budgets.rows.findIndex(
          (r) =>
            r.surfaceId === row.surfaceId &&
            r.platform === row.platform &&
            r.arch === row.arch &&
            r.machineId === row.machineId
        );
        if (idx >= 0) budgets.rows[idx] = row;
        else budgets.rows.push(row);
      }
      for (const u of unmeasuredRows) {
        const idx = budgets.rows.findIndex((r) => r.surfaceId === u.surfaceId && r.unmeasured);
        if (idx >= 0) budgets.rows[idx] = u;
        else budgets.rows.push(u);
      }

      // Try populating context library if available
      try {
        const contextLibPath = path.join(__dirname, 'lib', 'context.js');
        if (fs.existsSync(contextLibPath)) {
          const contextLib = require('./lib/context.js');
          if (typeof contextLib.computeStartupContext === 'function') {
            budgets.startupContext = contextLib.computeStartupContext({ repoRoot });
          }
          if (typeof contextLib.computeContextBudgets === 'function') {
            budgets.contextBudgets = contextLib.computeContextBudgets({ repoRoot });
          }
          if (typeof contextLib.computePointerCost === 'function') {
            budgets.pointerCost = contextLib.computePointerCost({ repoRoot });
          }
        }
      } catch {
        // ignored
      }

      fs.mkdirSync(path.dirname(budgetsPath), { recursive: true });
      fs.writeFileSync(budgetsPath, `${JSON.stringify(budgets, null, 2)}\n`, 'utf8');
    }

    const exitCode = failedSurfaces.size > 0 ? 1 : 0;

    if (flags.json) {
      log(
        JSON.stringify(
          {
            verb: 'measure',
            ok: exitCode === 0,
            exitCode,
            runs,
            warmups,
            seed,
            rows: allOutputRows,
            ...(failedSurfaces.size > 0 ? { failed: [...failedSurfaces.entries()].map(([id, reason]) => ({ surfaceId: id, reason })) } : {}),
          },
          null,
          2
        )
      );
    } else {
      log(`perf measure: ${measuredRows.length} measured, ${unmeasuredRows.length} unmeasured${failedSurfaces.size > 0 ? `, ${failedSurfaces.size} failed` : ''} (redos=${redos})`);
      for (const r of measuredRows) {
        log(`  ${r.surfaceId.padEnd(30)} p50=${r.p50Ms}ms p95=${r.p95Ms}ms ceiling=${r.ceilingMs}ms`);
      }
      for (const u of unmeasuredRows) {
        log(`  ${u.surfaceId.padEnd(30)} unmeasured: ${u.unmeasured}`);
      }
      for (const [id, reason] of failedSurfaces.entries()) {
        log(`  ${id.padEnd(30)} failed: ${reason}`);
      }
    }

    return { exitCode, rows: allOutputRows };
  } finally {
    if (tempHomeDir) {
      try {
        fs.rmSync(tempHomeDir, { recursive: true, force: true });
      } catch {
        // ignored
      }
    }
  }
}

function cmdCheck(flags, options = {}) {
  const {
    budgetsPath = flags.budgets ? path.resolve(flags.budgets) : DEFAULT_BUDGETS_PATH,
    log = (m) => process.stdout.write(`${m}\n`),
    err = (m) => process.stderr.write(`${m}\n`),
  } = options;

  if (!fs.existsSync(budgetsPath)) {
    if (flags.json) {
      log(JSON.stringify({ verb: 'check', ok: true, exitCode: 0, findings: [], rowsChecked: 0 }));
    }
    return { exitCode: 0, findings: [] };
  }

  let budgets;
  try {
    budgets = JSON.parse(fs.readFileSync(budgetsPath, 'utf8'));
  } catch (e) {
    err(`perf check: unreadable budgets file at ${budgetsPath}: ${e.message}`);
    return { exitCode: 1, findings: [`unreadable budgets file: ${e.message}`] };
  }

  const rows = budgets.rows || [];
  const surfaces = budgets.surfaces || [];
  const intentBudgetsMs = budgets.intentBudgetsMs || DEFAULT_INTENT_BUDGETS_MS;
  const headroom = budgets.headroom || DEFAULT_HEADROOM;

  const findings = [];
  let checkedCount = 0;

  for (const row of rows) {
    if (row.unmeasured) continue;
    checkedCount++;

    // Check minimum runs (must be >= 30)
    if (typeof row.runs !== 'number' || row.runs < 30) {
      findings.push(`surface ${row.surfaceId} has ${row.runs} runs (fewer than 30)`);
    }

    const surface = surfaces.find((s) => s.id === row.surfaceId);
    const intent =
      surface && surface.intentClass && surface.intentClass !== 'none'
        ? intentBudgetsMs[surface.intentClass]
        : null;

    const expectedCeiling = computeCeilingMs(row.p95Ms, headroom, intent);
    if (row.ceilingMs !== expectedCeiling) {
      findings.push(
        `surface ${row.surfaceId} stored ceiling ${row.ceilingMs} differs from expected ${expectedCeiling}`
      );
    }

    if (intent != null && row.ceilingMs > intent) {
      findings.push(`surface ${row.surfaceId} ceiling ${row.ceilingMs} exceeds intent budget ${intent}`);
    }
  }

  const ok = findings.length === 0;
  const exitCode = ok ? 0 : 1;

  if (flags.json) {
    log(
      JSON.stringify(
        {
          verb: 'check',
          ok,
          exitCode,
          rowsChecked: checkedCount,
          findings,
        },
        null,
        2
      )
    );
  } else if (!ok) {
    err(`perf check failed with ${findings.length} finding(s):`);
    for (const f of findings) err(`  - ${f}`);
  } else {
    log(`perf check: ok (${checkedCount} rows checked)`);
  }

  return { exitCode, findings };
}

function main(args = process.argv.slice(2), options = {}) {
  const log = options.out || ((m) => process.stdout.write(`${m}\n`));
  const err = options.err || ((m) => process.stderr.write(`${m}\n`));

  const verb = args[0] && !args[0].startsWith('--') ? args[0] : null;
  if (!verb) {
    err('usage: bench perf <measure|check> [flags]');
    return 2;
  }

  if (verb !== 'measure' && verb !== 'check') {
    err(`perf: unknown command "${verb}" (expected measure or check)`);
    return 2;
  }

  const allowedFlags = {
    surface: 'value',
    runs: 'value',
    warmups: 'value',
    seed: 'value',
    write: 'bool',
    json: 'bool',
    budgets: 'value',
  };

  let parsed;
  try {
    parsed = parseFlags(args.slice(1), allowedFlags);
  } catch (e) {
    err(`perf ${verb}: ${e.message}`);
    return 2;
  }

  if (parsed.rest.length > 0) {
    err(`perf ${verb}: unexpected argument "${parsed.rest[0]}"`);
    return 2;
  }

  const runnerOpts = { ...options, log, err };
  try {
    if (verb === 'measure') {
      const res = cmdMeasure(parsed.flags, runnerOpts);
      return res.exitCode;
    }
    if (verb === 'check') {
      const res = cmdCheck(parsed.flags, runnerOpts);
      return res.exitCode;
    }
  } catch (e) {
    err(`perf ${verb}: ${e.message}`);
    return 2;
  }

  return 0;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = {
  main,
  isAnotherNodeTestRunning,
  isToolInstalled,
  getMachineId,
  computeCeilingMs,
  enumerateHookSurfaces,
  runSurfaceProcess,
  HARNESS_CLI_MAP,
  DEFAULT_INTENT_BUDGETS_MS,
  DEFAULT_HEADROOM,
};
