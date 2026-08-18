'use strict';

/**
 * Capability health probes and the health-aware `doctor` report (plan task C.3, components C4 and
 * C9; requirement FR-013).
 *
 * The distinction this module exists to make: **a binary on `PATH` is not a working capability**.
 * `capabilities` answers "which provider would be selected" from presence; `doctor` answers
 * "did the provider actually answer", which is a different question and the only one that can
 * catch a `semble` whose index is missing, a `graphify` whose graph was never built, or an `rtk`
 * that dies on startup. A provider that is installed but cannot answer reports UNHEALTHY, and a
 * provider that cannot be probed at all reports UNVERIFIED — never HEALTHY. That last rule is
 * deliberate: this feature's own audit found three defects of the shape "reported PASS over no
 * evidence" (a check with no command, a contract with no checks, a readiness verdict about the
 * wrong task), and "the binary exists, so call it healthy" is the same defect wearing a hat.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { CapabilityRouter } = require('./capability-router');
const { loadRegistry } = require('../registry');

/** Answered a probe. */
const HEALTHY = 'HEALTHY';
/** Present, but the probe failed, timed out, or returned nothing. */
const UNHEALTHY = 'UNHEALTHY';
/** Not installed. For an optional provider this is a normal state, not a fault. */
const ABSENT = 'ABSENT';
/** Installed (or needs no binary) but declares no probe, so function cannot be established. */
const UNVERIFIED = 'UNVERIFIED';

/** A probe must be fast enough that `doctor` stays interactive with every provider installed. */
const PROBE_TIMEOUT_MS = 2500;

/** Version banners are one short line; anything longer is not a banner and is not worth printing. */
const BANNER_MAX = 80;

/**
 * Where an index- or graph-backed provider keeps the artifact whose age determines whether its
 * answers can be trusted. Each entry lists every location DoFlow knows to look in; when none of
 * them exists the result is UNKNOWN naming the paths searched, because a provider that owns its
 * own cache layout must not have a freshness verdict invented for it.
 */
const PROVIDER_ARTIFACTS = Object.freeze({
  'graphify.query': {
    label: 'code graph',
    candidates: (root) => [path.join(root, 'graphify-out', 'graph.json')],
    refresh: 'graphify update .',
  },
  'semble.search': {
    label: 'semantic index',
    candidates: (root, home) => [
      path.join(root, '.semble', 'index.json'),
      path.join(root, '.semble'),
      path.join(home, '.cache', 'semble', 'index'),
    ],
    refresh: 'semble search "<any query>" . (rebuilds the index on first run)',
  },
});

/** Directories a source-freshness scan must not descend into: build output, dependency trees and
 * the provider artifacts themselves — a graph that indexed itself would always look fresh. */
const SCAN_SKIP = new Set([
  '.git', 'node_modules', 'graphify-out', '.doflow', 'dist', 'build', 'out', 'coverage',
  '.venv', 'venv', '__pycache__', '.next', '.nuxt', 'target', '.cache', '.pytest_cache', 'tmp',
]);

/** A bound on the freshness scan. Hitting it does not produce a guess — it produces UNKNOWN. */
const SCAN_FILE_LIMIT = 4000;

/**
 * Runs a provider's declared probe command.
 * @param {string[]} command
 * @param {Object} [options]
 * @param {Function} [options.execFileImpl=execFileSync]
 * @param {number} [options.timeoutMs=PROBE_TIMEOUT_MS]
 * @returns {{ok: boolean, output: string, durationMs: number, timedOut: boolean, error: string|null}}
 */
function runProbe(command, { execFileImpl = execFileSync, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
  const [bin, ...args] = command;
  const started = Number(process.hrtime.bigint() / 1000000n);
  try {
    const stdout = execFileImpl(bin, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return {
      ok: true,
      output: String(stdout || '').trim(),
      durationMs: Number(process.hrtime.bigint() / 1000000n) - started,
      timedOut: false,
      error: null,
    };
  } catch (error) {
    // A killed process and a non-zero exit are both "did not answer", but they are different
    // repairs — a timeout usually means a first-run index build, a non-zero exit usually means a
    // broken install — so they are reported apart rather than as one failure string.
    const timedOut = error.killed === true || error.code === 'ETIMEDOUT' || error.signal === 'SIGTERM';
    return {
      ok: false,
      output: '',
      durationMs: Number(process.hrtime.bigint() / 1000000n) - started,
      timedOut,
      error: timedOut ? `probe exceeded ${timeoutMs}ms` : (error.message || 'probe failed'),
    };
  }
}

/** First line of probe output, trimmed to a banner. Control characters are stripped so a provider
 * cannot rewrite the doctor report with an escape sequence. */
function banner(output) {
  if (!output) return null;
  // Control characters are removed by code point rather than by a literal class, so this source
  // file stays free of the escape sequences it is defending against.
  const firstLine = [...output.split('\n')[0]]
    .map((character) => (character.codePointAt(0) < 0x20 || character.codePointAt(0) === 0x7f ? ' ' : character))
    .join('')
    .trim();
  return firstLine.length > BANNER_MAX ? `${firstLine.slice(0, BANNER_MAX - 1)}…` : firstLine;
}

/**
 * Newest modification time among the project's own source files, used as the lower bound an index
 * must be at least as new as.
 * @param {string} root
 * @param {Object} [options]
 * @param {Object} [options.fsImpl=fs]
 * @param {number} [options.limit=SCAN_FILE_LIMIT]
 * @returns {{mtimeMs: number|null, filesScanned: number, truncated: boolean}}
 */
function newestSourceMtime(root, { fsImpl = fs, limit = SCAN_FILE_LIMIT } = {}) {
  let mtimeMs = null;
  let filesScanned = 0;
  let truncated = false;
  const queue = [root];

  while (queue.length) {
    if (filesScanned >= limit) { truncated = true; break; }
    const dir = queue.shift();
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // An unreadable directory narrows the scan; it does not fail the probe.
    }
    for (const entry of entries) {
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (SCAN_SKIP.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { queue.push(full); continue; }
      if (!entry.isFile()) continue;
      if (filesScanned >= limit) { truncated = true; break; }
      filesScanned += 1;
      try {
        const stat = fsImpl.statSync(full);
        if (mtimeMs === null || stat.mtimeMs > mtimeMs) mtimeMs = stat.mtimeMs;
      } catch {
        // Vanished between readdir and stat — a normal race in a working tree.
      }
    }
  }
  return { mtimeMs, filesScanned, truncated };
}

/**
 * Freshness of a provider's index or graph relative to the project's source.
 * @param {string} providerId
 * @param {Object} [options]
 * @param {string} [options.root=process.cwd()]
 * @param {string} [options.homeDir]
 * @param {Object} [options.fsImpl=fs]
 * @returns {Object|null} null when the provider is not index-backed
 */
function probeFreshness(providerId, { root = process.cwd(), homeDir = os.homedir(), fsImpl = fs } = {}) {
  const spec = PROVIDER_ARTIFACTS[providerId];
  if (!spec) return null;

  const searched = spec.candidates(path.resolve(root), path.resolve(homeDir || '.'));
  let artifact = null;
  let artifactMtimeMs = null;
  for (const candidate of searched) {
    try {
      const stat = fsImpl.statSync(candidate);
      artifact = candidate;
      artifactMtimeMs = stat.mtimeMs;
      break;
    } catch {
      // Not at this location; try the next.
    }
  }

  const base = { providerId, label: spec.label, searched, artifact, refresh: spec.refresh };
  if (!artifact) {
    return {
      ...base,
      state: 'UNKNOWN',
      reason: `no ${spec.label} found at any location DoFlow knows to check; the provider owns its own layout, so no age can be established for it`,
    };
  }

  const source = newestSourceMtime(path.resolve(root), { fsImpl });
  if (source.mtimeMs === null) {
    return { ...base, state: 'UNKNOWN', indexedAt: new Date(artifactMtimeMs).toISOString(), reason: 'no source file was readable under the project root, so there is nothing to compare the index against' };
  }
  const behindMs = Math.round(source.mtimeMs - artifactMtimeMs);
  if (behindMs > 0) {
    return {
      ...base,
      state: 'STALE',
      indexedAt: new Date(artifactMtimeMs).toISOString(),
      newestSourceAt: new Date(source.mtimeMs).toISOString(),
      behindMs,
      filesScanned: source.filesScanned,
      reason: `source has changed since the ${spec.label} was built`,
    };
  }
  if (source.truncated) {
    // The scan stopped early, so "nothing newer was seen" is not "nothing newer exists". Saying
    // FRESH here would be a verdict over incomplete evidence.
    return {
      ...base,
      state: 'UNKNOWN',
      indexedAt: new Date(artifactMtimeMs).toISOString(),
      filesScanned: source.filesScanned,
      reason: `freshness scan stopped at ${source.filesScanned} files, so no file newer than the ${spec.label} was seen — which is not the same as none existing`,
    };
  }
  return {
    ...base,
    state: 'FRESH',
    indexedAt: new Date(artifactMtimeMs).toISOString(),
    newestSourceAt: new Date(source.mtimeMs).toISOString(),
    filesScanned: source.filesScanned,
  };
}

/**
 * Probes one provider declared in `capabilities.yaml`.
 * @param {Object} provider
 * @param {Object} options
 * @param {CapabilityRouter} options.router
 * @param {string} [options.projectRoot]
 * @param {Function} [options.execFileImpl]
 * @param {Object} [options.fsImpl]
 * @returns {Object} probe result
 */
function probeProvider(provider, { router, projectRoot = process.cwd(), execFileImpl, fsImpl = fs } = {}) {
  if (!provider || !provider.id) {
    return { id: null, status: UNVERIFIED, detail: 'no provider declared' };
  }
  const result = {
    id: provider.id,
    name: provider.name || provider.id,
    binary: provider.binary || null,
    present: null,
    answered: false,
    status: UNVERIFIED,
    detail: null,
    durationMs: null,
    version: null,
    freshness: null,
  };

  if (provider.binary) {
    result.present = router.isBinaryAvailable(provider.binary);
    if (!result.present) {
      result.status = ABSENT;
      result.detail = `binary '${provider.binary}' is not on PATH`;
      return result;
    }
  }

  const command = Array.isArray(provider.checkCommand) && provider.checkCommand.length
    ? provider.checkCommand
    : null;
  if (!command) {
    result.status = UNVERIFIED;
    result.detail = provider.binary
      ? `binary '${provider.binary}' is present but the registry declares no probe command, so DoFlow cannot establish that it answers`
      : 'declares neither a binary nor a probe command, so its function depends entirely on the project (see the project commands section)';
    return result;
  }

  const probe = runProbe(command, { execFileImpl });
  result.durationMs = probe.durationMs;
  result.probeCommand = command.join(' ');
  if (!probe.ok) {
    result.status = UNHEALTHY;
    // `banner` rather than the raw error: a failing provider can emit a stack trace, and a
    // multi-line detail turns the report into an unreadable wall. The full text is not lost — the
    // reader is told the exact command to re-run.
    result.detail = `installed, but \`${result.probeCommand}\` did not answer: ${banner(probe.error) || 'no error text'}`;
    return result;
  }
  if (!probe.output) {
    // An exit-0 with no output is the exact "PASS over zero evidence" shape this feature is
    // correcting: the process ran, but nothing establishes that the capability works.
    result.status = UNHEALTHY;
    result.detail = `installed, but \`${result.probeCommand}\` returned no output, so nothing establishes that it answered`;
    return result;
  }

  result.answered = true;
  result.status = HEALTHY;
  result.version = banner(probe.output);
  result.freshness = probeFreshness(provider.id, { root: projectRoot, fsImpl });
  result.detail = result.version;
  return result;
}

/**
 * Probes every provider the capability registry declares, de-duplicated by provider id.
 * @param {Object} [options]
 * @param {string} [options.repoRoot] where the registry lives
 * @param {string} [options.projectRoot] the tree whose index freshness is judged
 * @param {string[]} [options.ids] restrict to these provider ids
 * @param {CapabilityRouter} [options.router]
 * @returns {Object} map of provider id -> probe result
 */
function probeProviders({ repoRoot, projectRoot = process.cwd(), ids = null, router, execFileImpl, fsImpl = fs } = {}) {
  const activeRouter = router || new CapabilityRouter({ repoRoot: repoRoot || path.resolve(__dirname, '..', '..') });
  const wanted = ids ? new Set(ids) : null;
  const results = {};
  for (const capability of Object.values(activeRouter.capabilities || {})) {
    for (const provider of capability.providers || []) {
      if (!provider || !provider.id) continue;
      if (wanted && !wanted.has(provider.id)) continue;
      if (results[provider.id]) continue; // one probe per provider, however many capabilities list it
      results[provider.id] = probeProvider(provider, { router: activeRouter, projectRoot, execFileImpl, fsImpl });
    }
  }
  return results;
}

/**
 * The project's build and test commands.
 *
 * Detection itself belongs to `command-detect.js` (plan task C.2) and is deliberately **not**
 * reimplemented here — two detectors would be exactly the "one verb, two implementations" defect
 * this feature exists to remove (FR-005). This function reports what that module found, and when
 * the module is absent it says so by name rather than guessing a command. A guessed build command
 * is worse than an admitted gap, because it is a command the model will run.
 *
 * @param {Object} [options]
 * @param {string} [options.projectRoot=process.cwd()]
 * @param {Function} [options.detector] injection seam; defaults to the C.2 module when present
 * @returns {{status: string, build: Object|null, test: Object|null, reason?: string}}
 */
function detectProjectCommands({ projectRoot = process.cwd(), detector } = {}) {
  let detect = detector;
  if (!detect) {
    let mod = null;
    try {
      mod = require('./command-detect');
    } catch {
      return {
        status: 'UNKNOWN',
        build: null,
        test: null,
        reason: 'src/runtime/command-detect.js is not present in this build; DoFlow reports detected commands but does not detect them itself, and will not guess',
      };
    }
    detect = typeof mod.detectCommands === 'function' ? mod.detectCommands : null;
    if (!detect) {
      return {
        status: 'UNKNOWN',
        build: null,
        test: null,
        reason: `src/runtime/command-detect.js exports no detectCommands() (found: ${Object.keys(mod).join(', ') || 'nothing'})`,
      };
    }
  }

  let detected;
  try {
    detected = detect({ projectRoot }) || {};
  } catch (error) {
    return { status: 'UNKNOWN', build: null, test: null, reason: `command detection failed: ${error.message}` };
  }

  const commands = detected.commands || {};
  const build = commands.build || null;
  const test = commands.test || null;
  // Reported per role rather than as one boolean: "test detected, build absent" is the common and
  // correct state for a project with no build step (this repository is one), and collapsing it into
  // a single NOT_DETECTED would read as a broken detector.
  const status = build && test ? 'DETECTED'
    : build || test ? 'PARTIAL'
      : detected.manifestFound ? 'NOT_DETECTED'
        : 'UNKNOWN';
  const absent = Array.isArray(detected.absent) ? detected.absent : [];
  const reason = status === 'DETECTED' ? null
    : status === 'UNKNOWN' ? 'no project manifest was recognised under this root, so no command could be detected'
      : `detector found no ${absent.length ? absent.join(', ') : 'build'} command declared by ${(detected.manifests || ['the project manifest']).join(', ')}`;

  return {
    status,
    build,
    test,
    manifests: detected.manifests || [],
    absent,
    errors: detected.errors || [],
    ...(reason ? { reason } : {}),
  };
}

/** Roll a capability's provider probes up into one status. */
function capabilityStatus(probes) {
  if (!probes.length) return { status: 'UNAVAILABLE', activeProvider: null };
  const firstHealthy = probes.findIndex((probe) => probe.status === HEALTHY);
  if (firstHealthy === 0) return { status: HEALTHY, activeProvider: probes[0].id };
  if (firstHealthy > 0) return { status: 'FALLBACK', activeProvider: probes[firstHealthy].id };
  // Nothing answered. "Installed but broken" and "not installed" are different problems: the first
  // is actionable now, the second is the graceful degradation NFR-002 requires.
  if (probes.some((probe) => probe.status === UNHEALTHY)) return { status: 'DEGRADED', activeProvider: null };
  if (probes.every((probe) => probe.status === ABSENT)) return { status: 'UNAVAILABLE', activeProvider: null };
  return { status: UNVERIFIED, activeProvider: null };
}

/**
 * The full health model behind `doflow doctor`.
 * @param {Object} [options]
 * @param {string} [options.repoRoot] where the registry lives
 * @param {string} [options.projectRoot] the project being reported on
 * @returns {Object} report model
 */
function buildHealthReport({ repoRoot, projectRoot = process.cwd(), router, execFileImpl, fsImpl = fs, detector } = {}) {
  const root = repoRoot || path.resolve(__dirname, '..', '..');
  const registry = loadRegistry({ repoRoot: root });
  const activeRouter = router || new CapabilityRouter({ repoRoot: root });
  const probes = probeProviders({ repoRoot: root, projectRoot, router: activeRouter, execFileImpl, fsImpl });
  const project = { root: path.resolve(projectRoot), commands: detectProjectCommands({ projectRoot, detector }) };

  // `native.test` is the one provider with neither a binary nor a probe: it stands for whatever the
  // project runs its tests with. Its detail is resolved from the detected commands so the report
  // says which of the two very different situations applies — a test command exists but running a
  // suite is too expensive to use as a probe, or no test command was found at all. It stays
  // UNVERIFIED either way, because neither case establishes that it answers.
  const projectTest = probes['native.test'];
  if (projectTest && projectTest.status === UNVERIFIED) {
    projectTest.detail = project.commands.test
      ? `no probe of its own; the project's test command was detected (\`${project.commands.test.command}\`), but running a suite is not a health probe`
      : 'no probe of its own, and no project test command was detected — nothing establishes that this capability can answer';
  }

  const capabilities = Object.entries(activeRouter.capabilities || {}).map(([id, capability]) => {
    const declared = (capability.providers || []).map((provider) => probes[provider.id]).filter(Boolean);
    const rolled = capabilityStatus(declared);
    return {
      capability: id,
      description: capability.description,
      status: rolled.status,
      activeProvider: rolled.activeProvider,
      totalProviders: declared.length,
      providers: declared.map((probe) => ({ id: probe.id, status: probe.status, detail: probe.detail })),
    };
  });

  // External tools are the same binaries the providers use, so their status comes from the probe
  // that already ran rather than from a second, weaker presence check.
  const externalTools = registry.externalTools.map((tool) => {
    const probe = Object.values(probes).find((candidate) => candidate.binary === tool.id);
    if (probe) return { id: tool.id, displayName: tool.displayName, status: probe.status, detail: probe.detail };
    const present = activeRouter.isBinaryAvailable(tool.id);
    return {
      id: tool.id,
      displayName: tool.displayName,
      status: present ? UNVERIFIED : ABSENT,
      detail: present ? 'on PATH, but no capability provider declares a probe for it' : `binary '${tool.id}' is not on PATH`,
    };
  });

  const freshness = Object.values(probes).map((probe) => probe.freshness).filter(Boolean);

  // A finding is a thing to act on now: something installed that does not work. An absent optional
  // provider is not a finding (NFR-002 makes degradation normal), and a stale index still answers,
  // so both are warnings that leave the exit code at 0.
  const findings = [
    ...Object.values(probes)
      .filter((probe) => probe.status === UNHEALTHY)
      .map((probe) => ({ kind: 'provider-unhealthy', subject: probe.id, detail: probe.detail })),
    ...capabilities
      .filter((capability) => capability.status === 'DEGRADED')
      .map((capability) => ({ kind: 'capability-degraded', subject: capability.capability, detail: 'every installed provider for this capability failed its probe' })),
  ];
  const warnings = [
    ...freshness
      .filter((item) => item.state === 'STALE')
      .map((item) => ({ kind: 'index-stale', subject: item.providerId, detail: `${item.label} is behind the working tree; refresh with: ${item.refresh}` })),
    ...freshness
      .filter((item) => item.state === 'UNKNOWN')
      .map((item) => ({ kind: 'index-age-unknown', subject: item.providerId, detail: item.reason })),
    ...Object.values(probes)
      .filter((probe) => probe.status === UNVERIFIED)
      .map((probe) => ({ kind: 'provider-unverified', subject: probe.id, detail: probe.detail })),
    ...(project.commands.status === 'DETECTED' ? [] : [{ kind: 'project-commands', subject: 'build/test', detail: project.commands.reason }]),
  ];

  return {
    harnesses: registry.harnesses.map((harness) => ({ id: harness.id, displayName: harness.displayName, status: 'PASS' })),
    externalTools,
    capabilities,
    providers: Object.values(probes),
    freshness,
    project,
    findings,
    warnings,
    summary: {
      probed: Object.keys(probes).length,
      healthy: Object.values(probes).filter((probe) => probe.status === HEALTHY).length,
      unhealthy: Object.values(probes).filter((probe) => probe.status === UNHEALTHY).length,
      absent: Object.values(probes).filter((probe) => probe.status === ABSENT).length,
      unverified: Object.values(probes).filter((probe) => probe.status === UNVERIFIED).length,
    },
  };
}

/**
 * Records the report's exit code and hands it back to the caller.
 *
 * Design §4.2: 0 = answered, 1 = a finding the caller must act on. Only an installed provider
 * that does not answer is a finding — an absent optional provider is the graceful degradation
 * NFR-002 requires, and a stale index still answers, so both leave the code at 0 and appear as
 * warnings. Setting `process.exitCode` rather than calling `process.exit` lets stdout flush.
 * @param {number} code
 * @returns {number}
 */
function finish(code) {
  process.exitCode = code;
  return code;
}

const STATUS_MARK = Object.freeze({
  HEALTHY: '✓ HEALTHY',
  UNHEALTHY: '✗ UNHEALTHY',
  ABSENT: '○ ABSENT',
  UNVERIFIED: '? UNVERIFIED',
  FALLBACK: '▲ FALLBACK',
  DEGRADED: '✗ DEGRADED',
  UNAVAILABLE: '○ UNAVAILABLE',
});

const FRESHNESS_MARK = Object.freeze({
  FRESH: '✓ FRESH',
  STALE: '▲ STALE',
  UNKNOWN: '? UNKNOWN',
});

/**
 * Handles `doflow doctor` — installation and capability health.
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 * @param {string} [options.projectRoot]
 * @returns {number} process exit code — 1 when a provider is installed but does not answer
 */
function handleDoctorCommand({ json = false, repoRoot, projectRoot = process.cwd(), ...rest } = {}) {
  const report = buildHealthReport({ repoRoot, projectRoot, ...rest });

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return finish(report.findings.length ? 1 : 0);
  }

  console.log('\nDoFlow System Diagnostics (doflow doctor)');
  console.log('═'.repeat(72));
  console.log('Health means a provider answered a probe, not that a binary exists on PATH.');

  console.log('\n[Harness Adapters]');
  for (const harness of report.harnesses) console.log(`  ${harness.displayName.padEnd(28)} PASS`);

  console.log('\n[Capability Providers]');
  for (const probe of report.providers) {
    console.log(`  ${probe.id.padEnd(18)}${(STATUS_MARK[probe.status] || probe.status).padEnd(15)}${probe.detail || ''}`);
  }

  console.log('\n[Runtime Capabilities]');
  for (const capability of report.capabilities) {
    console.log(`  ${capability.capability.padEnd(26)}${(STATUS_MARK[capability.status] || capability.status).padEnd(15)}(${capability.activeProvider || 'none answering'})`);
  }

  console.log('\n[Index Freshness]');
  if (!report.freshness.length) {
    console.log('  No index- or graph-backed provider answered, so there is no index to age.');
  } else {
    for (const item of report.freshness) {
      console.log(`  ${item.providerId.padEnd(18)}${FRESHNESS_MARK[item.state].padEnd(15)}${item.reason || item.artifact || ''}`);
    }
  }

  console.log('\n[Project Commands]');
  const commands = report.project.commands;
  const commandLine = (role) => (role
    ? `✓ ${role.command}${role.source ? `  (${role.source}, ${role.derivation || 'declared'})` : ''}`
    : '? not detected');
  console.log(`  build             ${commandLine(commands.build)}`);
  console.log(`  test              ${commandLine(commands.test)}`);
  if (commands.reason) console.log(`  note              ${commands.reason}`);

  if (report.warnings.length) {
    console.log('\n[Warnings] — not blocking; a stale or unprobeable provider still degrades cleanly');
    for (const warning of report.warnings) console.log(`  ${warning.subject.padEnd(18)}${warning.detail}`);
  }

  console.log('\n[Findings]');
  if (!report.findings.length) {
    console.log(`  None. ${report.summary.healthy} of ${report.summary.probed} provider(s) answered; ${report.summary.absent} not installed, ${report.summary.unverified} unprobeable.`);
  } else {
    for (const finding of report.findings) console.log(`  ${finding.kind.padEnd(22)}${finding.subject}: ${finding.detail}`);
  }
  console.log('═'.repeat(72) + '\n');

  return finish(report.findings.length ? 1 : 0);
}

module.exports = {
  HEALTHY,
  UNHEALTHY,
  ABSENT,
  UNVERIFIED,
  runProbe,
  probeProvider,
  probeProviders,
  probeFreshness,
  newestSourceMtime,
  detectProjectCommands,
  buildHealthReport,
  handleDoctorCommand,
  PROBE_TIMEOUT_MS,
};
