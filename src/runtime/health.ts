'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

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
const { CapabilityRouter } = require('./capability-router.ts');
const { loadRegistry, agentToolScopeView } = require('../registry/index.ts');
const { evaluateReach } = require('./reach.ts');
const { mcpReach } = require('./mcp-reach.ts');
const { OUTCOME_LABELS } = require('./mcp-consultations.ts');
const { REPO_ROOT } = require('../helper/repo-root.ts');
const { readGrants, detectedProjectRoot } = require('./packages/grants.ts');
const { readState, grantRevoked } = require('./packages/state.ts');
const { transcriptsDoctorView } = require('./transcripts/registry.ts');

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
const PROVIDER_ARTIFACTS: Record<string, any> = Object.freeze({
  'graphify.query': {
    label: 'code graph',
    candidates: (root: any) => [path.join(root, 'graphify-out', 'graph.json')],
    refresh: 'graphify update .',
  },
  'semble.search': {
    label: 'semantic index',
    candidates: (root: any, home: any) => [
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
function runProbe(command: any, { execFileImpl = execFileSync, timeoutMs = PROBE_TIMEOUT_MS }: any = {}) {
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
  } catch (error: any) {
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
function banner(output: any) {
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
function newestSourceMtime(root: any, { fsImpl = fs, limit = SCAN_FILE_LIMIT }: any = {}) {
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
function probeFreshness(providerId: any, { root = process.cwd(), homeDir = os.homedir(), fsImpl = fs }: any = {}) {
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

async function probeLocalProvider(
  provider: any,
  options: { timeoutMs?: number; fetchImpl?: any; execFileImpl?: any; router?: any } = {}
): Promise<any> {
  const timeoutMs = options.timeoutMs ?? 1500;

  if (provider.kind === 'http') {
    const targetUrl = provider.healthEndpoint || provider.endpoint;
    const { probeHttpEndpoint } = require('./capabilities/executor.ts');
    const probeRes = await probeHttpEndpoint(targetUrl, {
      timeoutMs,
      fetchImpl: options.fetchImpl,
    });
    if (probeRes.ok) {
      return {
        id: provider.id,
        name: provider.name || provider.id,
        kind: 'http',
        status: 'HEALTHY',
        endpoint: targetUrl,
        answered: true,
        durationMs: probeRes.durationMs,
        detail: `HTTP ${probeRes.status}`,
      };
    }
    if (probeRes.isUnavailable) {
      return {
        id: provider.id,
        name: provider.name || provider.id,
        kind: 'http',
        status: 'UNAVAILABLE',
        endpoint: targetUrl,
        answered: false,
        durationMs: probeRes.durationMs,
        detail: `Local server at ${targetUrl} is not running`,
      };
    }
    return {
      id: provider.id,
      name: provider.name || provider.id,
      kind: 'http',
      status: 'UNHEALTHY',
      endpoint: targetUrl,
      answered: probeRes.status !== undefined,
      durationMs: probeRes.durationMs,
      detail: probeRes.status ? `HTTP status ${probeRes.status}` : (probeRes.error || 'HTTP request failed'),
    };
  }

  if (provider.kind === 'cli') {
    const binary = provider.binary || provider.program;
    const isAvail = options.router ? options.router.isBinaryAvailable(binary) : true;
    if (!isAvail) {
      return {
        id: provider.id,
        name: provider.name || provider.id,
        kind: 'cli',
        status: 'UNAVAILABLE',
        binary,
        answered: false,
        durationMs: null,
        detail: `Binary '${binary}' not found on PATH`,
      };
    }
    const checkCommand = provider.checkCommand || [binary, '--version'];
    const probe = runProbe(checkCommand, { execFileImpl: options.execFileImpl, timeoutMs });
    return {
      id: provider.id,
      name: provider.name || provider.id,
      kind: 'cli',
      status: probe.ok ? 'HEALTHY' : 'UNHEALTHY',
      binary,
      answered: probe.ok,
      durationMs: probe.durationMs,
      detail: probe.ok ? banner(probe.output) : probe.error,
    };
  }

  return {
    id: provider.id,
    name: provider.name || provider.id,
    kind: provider.kind || 'native',
    status: 'UNVERIFIED',
    answered: false,
    durationMs: null,
    detail: 'unsupported probe kind',
  };
}

/**
 * Probes one provider declared in `capabilities.json`.
 * @param {Object} provider
 * @param {Object} options
 * @param {CapabilityRouter} options.router
 * @param {string} [options.projectRoot]
 * @param {Function} [options.execFileImpl]
 * @param {Object} [options.fsImpl]
 * @returns {Object} probe result
 */
function probeProvider(provider: any, { router, projectRoot = process.cwd(), execFileImpl, fsImpl = fs }: any = {}) {
  if (!provider || !provider.id) {
    return { id: null, status: UNVERIFIED, detail: 'no provider declared' };
  }
  const binary = provider.binary || provider.program || null;
  const result: any = {
    id: provider.id,
    name: provider.name || provider.id,
    binary,
    present: null,
    answered: false,
    status: UNVERIFIED,
    detail: null,
    durationMs: null,
    version: null,
    freshness: null,
  };

  if (binary) {
    result.present = router ? router.isBinaryAvailable(binary) : false;
    if (!result.present) {
      result.status = ABSENT;
      result.detail = `binary '${binary}' is not on PATH`;
      return result;
    }
  }

  if (provider.kind === 'http' || provider.endpoint) {
    const { validateLoopbackUrl } = require('./capabilities/loopback.ts');
    const valid = validateLoopbackUrl(provider.endpoint);
    if (!valid.ok) {
      result.status = UNHEALTHY;
      result.detail = `Disallowed endpoint: ${valid.reason}`;
      return result;
    }
  }

  const command = Array.isArray(provider.checkCommand) && provider.checkCommand.length
    ? provider.checkCommand
    : (provider.kind === 'cli' && binary ? [binary, '--version'] : null);
  if (!command) {
    result.status = UNVERIFIED;
    result.detail = binary
      ? `binary '${binary}' is present but the registry declares no probe command, so DoFlow cannot establish that it answers`
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
function probeProviders({ repoRoot, projectRoot = process.cwd(), ids = null, router, execFileImpl, fsImpl = fs }: any = {}) {
  const activeRouter = router || new CapabilityRouter({ repoRoot: repoRoot || REPO_ROOT, projectRoot });
  const wanted = ids ? new Set(ids) : null;
  const results: Record<string, any> = {};
  for (const capability of Object.values<any>(activeRouter.capabilities || {})) {
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
 * Detection itself belongs to `command-detect.ts` (plan task C.2) and is deliberately **not**
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
function detectProjectCommands({ projectRoot = process.cwd(), detector }: any = {}) {
  let detect = detector;
  if (!detect) {
    let mod = null;
    try {
      mod = require('./command-detect.ts');
    } catch {
      return {
        status: 'UNKNOWN',
        build: null,
        test: null,
        reason: 'src/runtime/command-detect.ts is not present in this build; DoFlow reports detected commands but does not detect them itself, and will not guess',
      };
    }
    detect = typeof mod.detectCommands === 'function' ? mod.detectCommands : null;
    if (!detect) {
      return {
        status: 'UNKNOWN',
        build: null,
        test: null,
        reason: `src/runtime/command-detect.ts exports no detectCommands() (found: ${Object.keys(mod).join(', ') || 'nothing'})`,
      };
    }
  }

  let detected;
  try {
    detected = detect({ projectRoot }) || {};
  } catch (error: any) {
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
function capabilityStatus(probes: any) {
  if (!probes.length) return { status: 'UNAVAILABLE', activeProvider: null };
  const firstHealthy = probes.findIndex((probe: any) => probe.status === HEALTHY);
  if (firstHealthy === 0) return { status: HEALTHY, activeProvider: probes[0].id };
  if (firstHealthy > 0) return { status: 'FALLBACK', activeProvider: probes[firstHealthy].id };
  // Nothing answered. "Installed but broken" and "not installed" are different problems: the first
  // is actionable now, the second is the graceful degradation NFR-002 requires.
  if (probes.some((probe: any) => probe.status === UNHEALTHY)) return { status: 'DEGRADED', activeProvider: null };
  if (probes.every((probe: any) => probe.status === ABSENT)) return { status: 'UNAVAILABLE', activeProvider: null };
  return { status: UNVERIFIED, activeProvider: null };
}

/**
 * The full health model behind `doflow doctor`.
 * @param {Object} [options]
 * @param {string} [options.repoRoot] where the registry lives
 * @param {string} [options.projectRoot] the project being reported on
 * @returns {Object} report model
 */
/** The installed DoFlow source's own version, read from its package.json; null when unreadable. */
function installVersion(root: any, fsImpl = fs) {
  try {
    return JSON.parse(fsImpl.readFileSync(path.join(root, 'package.json'), 'utf8')).version || null;
  } catch {
    return null;
  }
}

/** The project's git identity — short commit and branch — or null outside a repository. */
function projectGitIdentity(projectRoot: any) {
  const git = (args: any) => {
    try {
      return execFileSync('git', ['-C', projectRoot, ...args], {
        encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null;
    } catch {
      return null;
    }
  };
  const commit = git(['rev-parse', '--short', 'HEAD']);
  if (!commit) return null;
  return { commit, branch: git(['rev-parse', '--abbrev-ref', 'HEAD']) };
}

/** How many of the most recent recorded stage runs per stage the consultations view counts. */
const CONSULTATION_WINDOW = 20;
/** How many no-outcome entries the view lists per server and stage; the count covers the rest. */
const NO_OUTCOME_SHOWN = 3;

/**
 * The `[MCP Servers]` data (IC-014): per server a shipped stage names, which installed harness has
 * it and the command that adds it where it is missing. Read-only; starts no server (NFR-001).
 * Server ids come from the registry, never from this file.
 */
function mcpServersView({ registry, projectRoot, fsImpl, adapters }: any) {
  const named = registry.mcp.filter((server: any) => (server.steps || []).length);
  if (!named.length) return [];
  if (!adapters) throw new Error('no adapter registry was given');
  const reach = mcpReach({ registry, projectRoot, fsImpl, adapters });
  const unreadableFile = (harness: any) => reach.unreadable.find((item: any) => item.harness === harness.id && item.scope === harness.scope);
  return named.map((server: any) => ({
    id: server.id,
    selection: server.selection,
    namedBy: [...new Set(server.steps.map((step: any) => (step.expectedWhen === 'research-request' ? `${step.skill} (research request)` : step.skill)))],
    harnesses: reach.harnesses.map((harness: any) => {
      const state = harness.servers[server.id];
      const row: any = { id: harness.id, scope: harness.scope, state };
      const unreadable = state === 'unknown' ? unreadableFile(harness) : null;
      // An unreadable config is fixed before anything is added to it (IC-014).
      if (unreadable) row.fix = unreadable.file || `${harness.id}'s MCP config`;
      else if (state !== 'selected' && state !== 'configured') row.add = reach.addCommand(harness.id, harness.scope, server.id);
      return row;
    }),
  }));
}

const byText = (a: any, b: any) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The `[MCP Consultations]` data (IC-015): the recorded `consultations` of the project's run
 * journals, grouped by calling skill, the most recent CONSULTATION_WINDOW entries per skill by
 * `at`, counted per server. An entry without `consultations` predates the feature and is never
 * counted (NFR-005); "no outcome" is `named` minus the servers with an outcome, never stored.
 */
function mcpConsultationsView({ projectRoot, fsImpl }: any) {
  const dir = path.join(projectRoot, '.doflow', 'state', 'orchestration');
  // Runs live flat or in `<slug>/` (115: a task id other than its feature's slug is namespaced).
  const listed: Array<{ rel: string; name: string; namespace: string; run: any }> = [];
  const readRunFile = (rel: string, name: string, namespace: string): void => {
    let run;
    try { run = JSON.parse(fsImpl.readFileSync(path.join(dir, rel), 'utf8')); } catch { run = null; }
    listed.push({ rel, name, namespace, run });
  };
  let entries: any[] = [];
  try { entries = fsImpl.readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  for (const entry of entries) if (entry.name.endsWith('.json') && !entry.isDirectory()) readRunFile(entry.name, entry.name, '');
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name) || entry.name.endsWith('.lock')) continue;
    let inner: any[] = [];
    try { inner = fsImpl.readdirSync(path.join(dir, entry.name), { withFileTypes: true }); } catch { inner = []; }
    for (const file of inner) if (file.name.endsWith('.json') && !file.isDirectory()) readRunFile(`${entry.name}/${file.name}`, file.name, entry.name);
  }
  listed.sort((a, b) => byText(a.rel, b.rel));
  // A flat run whose namespaced copy exists is that copy's seed, not a second run.
  const files = listed.filter((one) => one.namespace !== '' || !listed.some((other) => other.namespace !== '' && other.name === one.name
    && (typeof one.run?.featureSlug !== 'string' || one.run.featureSlug === other.namespace)));
  let unreadableRuns = 0;
  const bySkill = new Map();
  for (const { name, run } of files) {
    if (!run || typeof run !== 'object' || Array.isArray(run)) { unreadableRuns += 1; continue; }
    for (const item of Array.isArray(run.history) ? run.history : []) {
      const record = item && item.consultations;
      if (!record || typeof record !== 'object' || typeof record.skill !== 'string') continue;
      if (!bySkill.has(record.skill)) bySkill.set(record.skill, []);
      bySkill.get(record.skill).push({ taskId: run.taskId || name.replace(/\.json$/, ''), node: item.node ?? null, at: String(item.at ?? ''), record });
    }
  }
  const stages = [...bySkill.keys()].sort(byText).map((skill) => {
    const kept = bySkill.get(skill)
      .sort((a: any, b: any) => byText(b.at, a.at) || byText(a.taskId, b.taskId) || byText(String(a.node), String(b.node)))
      .slice(0, CONSULTATION_WINDOW);
    const counts = new Map();
    const row = (server: any) => {
      if (!counts.has(server)) counts.set(server, { server, used: 0, nothingUsable: 0, skipped: 0, unavailable: 0, noOutcome: 0 });
      return counts.get(server);
    };
    const key: Record<string, any> = { 'consulted-used': 'used', 'consulted-nothing-usable': 'nothingUsable', skipped: 'skipped', unavailable: 'unavailable' };
    const noOutcome = [];
    const shown = new Map();
    for (const { taskId, node, at, record } of kept) {
      const outcomes = new Map();
      for (const outcome of Array.isArray(record.outcomes) ? record.outcomes : []) {
        if (outcome && typeof outcome.server === 'string' && key[outcome.state]) outcomes.set(outcome.server, key[outcome.state]);
      }
      for (const [server, field] of outcomes) row(server)[field] += 1;
      for (const server of (Array.isArray(record.named) ? record.named : []).filter((id: any) => typeof id === 'string').sort(byText)) {
        if (outcomes.has(server)) continue;
        row(server).noOutcome += 1;
        // `kept` is newest first, so the first entries per server are its latest.
        shown.set(server, (shown.get(server) || 0) + 1);
        if (shown.get(server) <= NO_OUTCOME_SHOWN) noOutcome.push({ taskId, node, at, server });
      }
    }
    return { skill, runs: kept.length, servers: [...counts.values()].sort((a, b) => byText(a.server, b.server)), noOutcome };
  });
  return { window: CONSULTATION_WINDOW, stages, unreadableRuns };
}

/** The doctor's `mcp` block. A servers view that cannot be built degrades to a one-line note; the
 * sections never enter findings or change the exit code (FR-011, FR-012). */
function mcpView({ registry, projectRoot, fsImpl, adapters }: any) {
  let servers = [];
  let serversNote;
  try { servers = mcpServersView({ registry, projectRoot, fsImpl, adapters }); } catch (error: any) { serversNote = `MCP server view unavailable: ${error.message}`; }
  return { servers, ...(serversNote ? { serversNote } : {}), consultations: mcpConsultationsView({ projectRoot, fsImpl }) };
}

/**
 * The doctor's `packages` block (122 IC-008, IC-009): the grants file path and mtime, every grant with its state,
 * and the counts held in `state.json`. A trust or exempt grant a revocation covers (or any, when `state.json` is
 * unreadable) is listed `revoked`. Read-only and not blocking; a failure degrades to a note.
 */
function packagesView({ projectRoot, fsImpl, env, homeDir, tmpDir }: any) {
  try {
    // The trust root is the project detected from the directory reported on, never that directory itself (IC-008).
    const home = homeDir ?? (typeof env?.HOME === 'string' && path.isAbsolute(env.HOME) ? env.HOME : os.homedir());
    const grants = readGrants({ env, fsImpl, projectRoot: detectedProjectRoot({ cwd: projectRoot, homeDir: home, fsImpl }), tmpDir });
    const state = readState({ homeDir, fsImpl });
    const rows = grants.entries.map((entry: any) => {
      const revoked = entry.state === 'valid' && entry.grant !== 'fetch' && grantRevoked(state, entry);
      const target = entry.grant === 'fetch' ? (entry.source.url || entry.source.name) : `${entry.package}@${entry.version}`;
      return { line: entry.line, grant: entry.grant, target, state: revoked ? 'revoked' : entry.state, ...(revoked ? { reason: state.unreadable ? 'state-unreadable' : 'revoked' } : entry.reason ? { reason: entry.reason } : {}) };
    });
    return {
      grants: { path: grants.path, noConfigHome: grants.noConfigHome, exists: grants.exists, mtime: grants.mtime, rows, findings: grants.findings },
      suspendedProjected: state.state.suspended.filter((item: any) => item.projected).map((item: any) => item.package).sort(),
      state: {
        path: state.path, exists: state.exists, unreadable: state.unreadable, findings: state.findings,
        revoked: state.state.revoked.length, suspended: state.state.suspended.length, removed: state.state.removed.length,
      },
    };
  } catch (error: any) {
    return { note: `package grants unavailable: ${error.message}` };
  }
}

function printPackagesSection(packages: any) {
  console.log('\n[Packages] — person grants and DoFlow state; not blocking');
  if (packages.note) { console.log(`  ${packages.note}`); return; }
  const { grants, state } = packages;
  if (grants.noConfigHome) console.log('  grants            no config home (HOME and XDG_CONFIG_HOME unset): no grant can exist');
  else if (!grants.exists) console.log(`  grants            none (no file at ${grants.path})`);
  else {
    console.log(`  grants            ${grants.path} (modified ${grants.mtime})`);
    for (const row of grants.rows) console.log(`    line ${String(row.line).padEnd(5)}${row.grant.padEnd(8)}${row.target.padEnd(28)}${row.state}${row.reason ? ` (${row.reason})` : ''}`);
    for (const item of grants.findings) console.log(`    ${item.code}: ${item.message}`);
  }
  if (state.unreadable) console.log(`  state             ${state.path} is unreadable: every package counts as revoked (run: doflow package --action verify --repair)`);
  else if (state.revoked || state.suspended || state.removed) console.log(`  state             ${state.revoked} revoked, ${state.suspended} suspended, ${state.removed} removed (${state.path})`);
  for (const id of packages.suspendedProjected ?? []) {
    console.log(`  suspended         ${id} still has projected files (run: doflow package --action verify)`);
  }
}

/** Whether the text report shows `[Packages]`: only when there is something to say. */
/** The `[Transcripts]` row (093 V.1): shown only when the registry is stale or drifted; never a finding. */
function printTranscriptsSection(transcripts: any) {
  if (transcripts.state === 'ok') return;
  console.log('\n[Transcripts] — transcript locator registry; not blocking');
  if (transcripts.state === 'drift') {
    console.log('  transcripts.json  drift: the transcript feature is off');
    for (const error of transcripts.errors) console.log(`    ${error}`);
    return;
  }
  for (const item of transcripts.stale) console.log(`  ${item.harness.padEnd(18)}verifiedOn ${item.verifiedOn} (${item.ageDays} days ago): re-verify its locations`);
}

const packagesWorthShowing = (packages: any) => Boolean(packages.note || packages.grants.exists || packages.state.exists);

const MCP_STATE_MARK: Record<string, any> = Object.freeze({
  selected: '✓ selected',
  configured: '✓ configured',
  'not-selected': '○ not selected',
  'not-taken': '○ not taken',
  unknown: '? unknown',
});

function printMcpSections(mcp: any) {
  console.log('\n[MCP Servers] — named by shipped stages; not blocking');
  if (mcp.serversNote) {
    console.log(`  ${mcp.serversNote}`);
  } else if (!mcp.servers.some((server: any) => server.harnesses.length)) {
    console.log('  No harness has DoFlow ledger rows here, so no server selection to report.');
  } else {
    for (const server of mcp.servers) {
      console.log(`  ${server.id.padEnd(22)}named by ${server.namedBy.join(', ')}`);
      for (const harness of server.harnesses) {
        // An install command reads `add: <command>`; "configure it in ..." text stands as it is.
        const add = harness.fix ? `fix ${harness.fix} first`
          : harness.add ? (harness.add.startsWith('doflow ') ? `add: ${harness.add}` : harness.add) : '';
        console.log(`    ${harness.id.padEnd(14)}${harness.scope.padEnd(9)}${(MCP_STATE_MARK[harness.state] || harness.state).padEnd(19)}${add}`.trimEnd());
      }
    }
  }

  const { window, stages, unreadableRuns } = mcp.consultations;
  console.log(`\n[MCP Consultations] — last ${window} recorded stage runs per stage in this project; not blocking`);
  if (!stages.length) console.log('  No stage run in this project has recorded MCP outcomes yet.');
  for (const item of stages) {
    for (const row of item.servers) {
      const counts = [
        `${OUTCOME_LABELS['consulted-used']} ${row.used}`,
        `${OUTCOME_LABELS['consulted-nothing-usable']} ${row.nothingUsable}`,
        `${OUTCOME_LABELS.skipped} ${row.skipped}`,
        `${OUTCOME_LABELS.unavailable} ${row.unavailable}`,
        `${OUTCOME_LABELS['no-outcome']} ${row.noOutcome}`,
      ];
      console.log(`  ${item.skill.padEnd(16)}${row.server.padEnd(22)}${counts.join(' · ')}`);
    }
    for (const miss of item.noOutcome) {
      console.log(`    ${OUTCOME_LABELS['no-outcome']}: ${miss.taskId} ${miss.node} ${miss.at} (${miss.server})`);
    }
  }
  if (unreadableRuns) console.log(`  ${unreadableRuns} run file(s) could not be read`);
}

/** The first release of each Node line that carries the 2026-10-21 security fix (CVE-2026-111497). */
const NODE_PATCHED_RELEASE: Record<number, number[]> = Object.freeze({ 24: [24, 22, 1], 26: [26, 12, 1] });

/**
 * A warning when `version` (a `process.version` string) is a release of a Node line below that
 * line's patched release; null for a patched release and for a line this table does not know.
 * The floor in `bin/doflow.js` already refuses anything under 24.22.1, so in practice this fires for
 * a Node 26 below 26.12.1; the 24 entry keeps the table complete for a caller that bypasses the bin. A line with no entry (25, 27) gets no warning. A prerelease of the
 * patched release (26.12.1-rc.1) counts as below it.
 */
function nodeSecurityWarning(version: string): { kind: string, subject: string, detail: string } | null {
  const parts = /^v?(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(String(version));
  if (!parts) return null;
  const running = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const patched = NODE_PATCHED_RELEASE[running[0]];
  if (!patched) return null;
  const order = patched.reduce((result, part, i) => result || Math.sign(running[i] - part), 0);
  const below = order < 0 || (order === 0 && Boolean(parts[4])); // a prerelease of the patched release sorts below it
  if (!below) return null;
  return {
    kind: 'node-security-release',
    subject: 'node',
    detail: `Node ${String(version).replace(/^v/, '')} is below ${patched.join('.')}, the first ${running[0]}.x release with the fix for CVE-2026-111497 (2026-10-21 security release); upgrade Node`,
  };
}

function buildHealthReport({ repoRoot, projectRoot = process.cwd(), router, execFileImpl, fsImpl = fs, detector, adapters, env = process.env, nodeVersion = process.version, homeDir, tmpDir, now }: any = {}) {
  const root = repoRoot || REPO_ROOT;
  const registry = loadRegistry({ repoRoot: root });
  const activeRouter = router || new CapabilityRouter({ repoRoot: root, projectRoot });
  const probes: Record<string, any> = probeProviders({ repoRoot: root, projectRoot, router: activeRouter, execFileImpl, fsImpl });
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

  const capabilities = Object.entries<any>(activeRouter.capabilities || {}).map(([id, capability]) => {
    const declared = (capability.providers || []).map((provider: any) => probes[provider.id]).filter(Boolean);
    const rolled = capabilityStatus(declared);
    return {
      capability: id,
      description: capability.description,
      status: rolled.status,
      activeProvider: rolled.activeProvider,
      totalProviders: declared.length,
      providers: declared.map((probe: any) => ({ id: probe.id, status: probe.status, detail: probe.detail })),
    };
  });

  // External tools are the same binaries the providers use, so their status comes from the probe
  // that already ran rather than from a second, weaker presence check.
  const externalTools = registry.externalTools.map((tool: any) => {
    const probe: any = Object.values(probes).find((candidate) => candidate.binary === tool.id);
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
  const reach = evaluateReach({ registry, projectRoot, fsImpl });

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
    ...reach.rows
      .filter((row: any) => row.state === 'NO-REACH')
      .map((row: any) => ({ kind: 'runtime-no-reach', subject: `${row.harness}:${row.scope}`, detail: `${row.reason}; fix: ${row.fix}` })),
  ];
  const nodeWarning = nodeSecurityWarning(nodeVersion);
  const warnings = [
    ...(nodeWarning ? [nodeWarning] : []),
    ...freshness
      .filter((item) => item.state === 'STALE')
      .map((item) => ({ kind: 'index-stale', subject: item.providerId, detail: `${item.label} is behind the working tree; refresh with: ${item.refresh}` })),
    ...freshness
      .filter((item) => item.state === 'UNKNOWN')
      .map((item) => ({ kind: 'index-age-unknown', subject: item.providerId, detail: item.reason })),
    ...Object.values(probes)
      .filter((probe) => probe.status === UNVERIFIED)
      .map((probe) => ({ kind: 'provider-unverified', subject: probe.id, detail: probe.detail })),
    ...reach.unreadable
      .map((item: any) => ({ kind: 'reach-ledger-unreadable', subject: `${item.scope}: ${item.ledger}`, detail: item.detail })),
    ...(project.commands.status === 'DETECTED' ? [] : [{ kind: 'project-commands', subject: 'build/test', detail: project.commands.reason }]),
  ];

  // Effective identity, in one block (review A3): which DoFlow source answered, which project it
  // was asked about, and which capabilities are actually connected — so "a clean install has a
  // usable X" claims can be checked against what THIS machine effectively runs, rather than
  // inferred from the pieces separately.
  const identity = {
    source: { root, version: installVersion(root, fsImpl) },
    project: { root: path.resolve(projectRoot), git: projectGitIdentity(projectRoot) },
    connectedCapabilities: capabilities.filter((capability) => capability.activeProvider).map((capability) => capability.capability),
  };

  return {
    identity,
    harnesses: registry.harnesses.map((harness: any) => ({
      id: harness.id,
      displayName: harness.displayName,
      status: 'PASS',
      reach: reach.rows.filter((row: any) => row.harness === harness.id).map(({ harness: _harness, ...row }: any) => row),
    })),
    externalTools,
    capabilities,
    providers: Object.values(probes),
    freshness,
    project,
    mcp: mcpView({ registry, projectRoot, fsImpl, adapters }),
    packages: packagesView({ projectRoot, fsImpl, env, homeDir, tmpDir }),
    transcripts: transcriptsDoctorView({ repoRoot: root, fsImpl, now }),
    findings,
    warnings,
    summary: {
      probed: Object.keys(probes).length,
      healthy: Object.values(probes).filter((probe) => probe.status === HEALTHY).length,
      unhealthy: Object.values(probes).filter((probe) => probe.status === UNHEALTHY).length,
      absent: Object.values(probes).filter((probe) => probe.status === ABSENT).length,
      unverified: Object.values(probes).filter((probe) => probe.status === UNVERIFIED).length,
    },
    // IC-006: the read switch of doctor's own environment, only when set (additive key).
    ...(env.DOFLOW_UPKEEP === 'off' ? { upkeepSwitch: 'off' } : {}),
  };
}

/**
 * Records the report's exit code and hands it back to the caller.
 *
 * Design §4.2: 0 = answered, 1 = a finding the caller must act on. An installed provider that
 * does not answer is a finding, and so is an installed harness whose skills cannot reach a runtime
 * (`runtime-no-reach`). An absent optional provider is the graceful degradation NFR-002 requires,
 * and a stale index still answers, so both leave the code at 0 and appear as warnings; so do a
 * harness with no skills at a scope (N/A) and an unreadable ledger. Setting `process.exitCode`
 * rather than calling `process.exit` lets stdout flush.
 * @param {number} code
 * @returns {number}
 */
function finish(code: any) {
  process.exitCode = code;
  return code;
}

const STATUS_MARK: Record<string, any> = Object.freeze({
  HEALTHY: '✓ HEALTHY',
  UNHEALTHY: '✗ UNHEALTHY',
  ABSENT: '○ ABSENT',
  UNVERIFIED: '? UNVERIFIED',
  FALLBACK: '▲ FALLBACK',
  DEGRADED: '✗ DEGRADED',
  UNAVAILABLE: '○ UNAVAILABLE',
});

const REACH_MARK: Record<string, any> = Object.freeze({
  REACHED: '✓ REACHED',
  'NO-REACH': '✗ NO-REACH',
  'N/A': '○ N/A',
});

const FRESHNESS_MARK: Record<string, any> = Object.freeze({
  FRESH: '✓ FRESH',
  STALE: '▲ STALE',
  UNKNOWN: '? UNKNOWN',
});

/** IC-014: read enabled state, bound tiers and unfiltered eligibility without writing or running worker probes. */
function workersDoctorView({
  env = process.env, projectRoot, repoRoot = REPO_ROOT, descriptors, now,
}: any = {}) {
  const reg = loadRegistry({ repoRoot });
  const root = require('./lifecycle/root.ts').projectRoot(projectRoot);
  const { activeWorkers } = require('./worker/active.ts');
  // Readiness already requires health.ts; load it only after this module has initialized.
  const { select, enabledOf, workerDescriptors } = require('./worker/readiness.ts');
  const { readBindings, resolveBinding } = require('./worker/models.ts');
  const active = activeWorkers({ registry: reg, env, projectRoot: root });
  const bindings = readBindings({ env, projectRoot: root });
  const entries = workerDescriptors({ descriptors, registry: reg });
  const tiers = reg.dispatchTiers?.tiers ?? [];
  const selection = select({
    descriptors, registry: reg, env, cwd: projectRoot, root, now, needs: [], includeDisabled: true,
  });
  const rows = selection.candidates.map(({ harness, eligible, gaps }: any) => {
    const gap = gaps[0];
    const descriptor = entries.find((entry: any) => entry.harness === harness)?.worker;
    const bound = tiers.flatMap((tier: string) => {
      const resolved = resolveBinding({ worker: harness, tier, bindings, descriptor });
      return resolved.source === 'binding' ? [{ tier, flag: resolved.flag }] : [];
    });
    return {
      harness,
      enabled: enabledOf(active, harness),
      eligible,
      firstGap: gap ? { requirement: gap.requirement, result: gap.result, reason: gap.reason } : null,
      bound,
    };
  });
  return {
    state: active.state,
    origin: active.origin,
    inSession: active.inSession,
    reason: active.reason,
    dangling: active.dangling,
    bindings: { state: bindings.state, reason: bindings.reason },
    rows,
  };
}

/** IC-005: read observed catalogue, login states, derived billing and enabled models without running probes. */
function workerPoolDoctorView({
  env = process.env, projectRoot, repoRoot = REPO_ROOT,
}: any = {}) {
  const { readCatalogue } = require('./models/catalogue.ts');
  const { readAllowedModels } = require('./worker/models.ts');
  const { readWorkerBilling, effectiveBilling } = require('./settings/worker-billing.ts');
  const { HARNESS_IDS } = require('./worker/probes/index.ts');
  const reg = loadRegistry({ repoRoot });
  const root = require('./lifecycle/root.ts').projectRoot(projectRoot);

  const catalogue = readCatalogue(root);
  const allowed = readAllowedModels({ projectRoot: root }) || [];
  const workerIds = reg.harnesses.map((h: any) => h.id);
  const billingRecord = readWorkerBilling(env, { workerIds });

  const observedModelIds = new Set<string>();
  const harnesses: any[] = [];
  const allHarnessIds = Array.from(new Set([...HARNESS_IDS, ...Object.keys(catalogue?.harnesses || {})]));

  for (const id of allHarnessIds) {
    const catEntry = catalogue?.harnesses?.[id];
    const regEntry = reg.harnesses.find((h: any) => h.id === id);
    const descBilling = regEntry?.worker?.billing ?? 'unknown';

    if (catEntry) {
      for (const m of catEntry.offeredModels || []) {
        if (m && m.id) observedModelIds.add(m.id);
      }
      const effBilling = effectiveBilling(descBilling, id, billingRecord, catalogue);
      harnesses.push({
        harness: id,
        binary: catEntry.binary || id,
        installed: Boolean(catEntry.installed),
        loginState: catEntry.loginState,
        reloginHint: catEntry.reloginHint || null,
        detectedMode: catEntry.detectedMode,
        effectiveBilling: effBilling,
        offeredCount: (catEntry.offeredModels || []).length,
      });
    } else {
      const effBilling = effectiveBilling(descBilling, id, billingRecord, null);
      harnesses.push({
        harness: id,
        binary: id,
        installed: false,
        loginState: 'uncalibrated',
        reloginHint: null,
        detectedMode: 'unverified',
        effectiveBilling: effBilling,
        offeredCount: 0,
      });
    }
  }

  let enabledCount = 0;
  for (const mId of observedModelIds) {
    if (allowed.includes(mId)) enabledCount++;
  }

  return {
    state: catalogue ? 'synced' : 'unsynced',
    syncedAt: catalogue?.syncedAt || null,
    harnesses,
    models: {
      enabledCount,
      listedCount: observedModelIds.size,
      enabled: allowed,
    },
  };
}

/**
 * Handles `doflow doctor` — installation and capability health.
 * @param {Object} options
 * @param {boolean} [options.json=false]
 * @param {string} [options.repoRoot]
 * @param {string} [options.projectRoot]
 * @returns {number} process exit code — 1 when a provider is installed but does not answer, or an
 *   installed harness's skills cannot reach a runtime
 */
async function handleDoctorCommand({ json = false, repoRoot, projectRoot = process.cwd(), ...rest }: any = {}) {
  const root = repoRoot || REPO_ROOT;
  const activeRouter = rest.router || new CapabilityRouter({ repoRoot: root, projectRoot });
  const report: any = buildHealthReport({ repoRoot: root, projectRoot, router: activeRouter, ...rest });

  // Probe local capability providers asynchronously (REV-1)
  for (const capability of Object.values<any>(activeRouter.capabilities || {})) {
    for (const provider of capability.providers || []) {
      if (!provider || !provider.id) continue;
      if (provider.kind === 'http' || provider.kind === 'cli') {
        const localRes = await probeLocalProvider(provider, {
          router: activeRouter,
          execFileImpl: rest.execFileImpl,
          fetchImpl: rest.fetchImpl,
        });
        const provIdx = report.providers.findIndex((p: any) => p.id === provider.id);
        if (provIdx !== -1) {
          report.providers[provIdx] = { ...report.providers[provIdx], ...localRes };
        } else {
          report.providers.push(localRes);
        }
      }
    }
  }

  // Refresh report.capabilities with updated probe states
  const probeMap: Record<string, any> = {};
  for (const p of report.providers) {
    probeMap[p.id] = p;
  }
  for (const cap of report.capabilities) {
    const capDef = activeRouter.capabilities[cap.capability];
    if (capDef && Array.isArray(capDef.providers)) {
      const declared = capDef.providers.map((p: any) => probeMap[p.id]).filter(Boolean);
      const rolled = capabilityStatus(declared);
      cap.status = rolled.status;
      cap.activeProvider = rolled.activeProvider;
      cap.providers = declared.map((p: any) => ({ id: p.id, status: p.status, detail: p.detail }));
    }
  }

  // Refresh summary, findings, warnings, and effective identity
  report.summary.healthy = report.providers.filter((p: any) => p.status === HEALTHY).length;
  report.summary.unhealthy = report.providers.filter((p: any) => p.status === UNHEALTHY).length;
  report.summary.absent = report.providers.filter((p: any) => p.status === ABSENT).length;
  report.summary.unverified = report.providers.filter((p: any) => p.status === UNVERIFIED).length;
  report.summary.probed = report.providers.length;

  const nonProviderFindings = report.findings.filter(
    (f: any) => f.kind !== 'provider-unhealthy' && f.kind !== 'capability-degraded'
  );
  report.findings = [
    ...nonProviderFindings,
    ...report.providers
      .filter((p: any) => p.status === UNHEALTHY)
      .map((p: any) => ({ kind: 'provider-unhealthy', subject: p.id, detail: p.detail })),
    ...report.capabilities
      .filter((c: any) => c.status === 'DEGRADED')
      .map((c: any) => ({ kind: 'capability-degraded', subject: c.capability, detail: 'every installed provider for this capability failed its probe' })),
  ];

  const nonProviderWarnings = report.warnings.filter(
    (w: any) => w.kind !== 'provider-unverified'
  );
  report.warnings = [
    ...nonProviderWarnings,
    ...report.providers
      .filter((p: any) => p.status === UNVERIFIED)
      .map((p: any) => ({ kind: 'provider-unverified', subject: p.id, detail: p.detail })),
  ];

  report.identity.connectedCapabilities = report.capabilities
    .filter((c: any) => c.activeProvider)
    .map((c: any) => c.capability);

  const { buildAdviceDoctor, printAdviceDoctor } = require('./advice/doctor.ts');
  const { buildSettingsReport, printSettingsReport } = require('./settings/cli.ts');
  const adviceSections = await buildAdviceDoctor({ repoRoot, projectRoot, fsImpl: rest.fsImpl });
  const settings = buildSettingsReport({ repoRoot, projectRoot, env: rest.env, fsImpl: rest.fsImpl });
  report.decisionModel = adviceSections.decisionModel;
  report.advice = adviceSections.advice;
  report.settings = settings;
  const { buildProfilesDoctor, printProfilesDoctor } = require('./profiles/doctor.ts');
  const profilesSection = buildProfilesDoctor({ repoRoot, projectRoot, env: rest.env, fsImpl: rest.fsImpl });
  report.rolloutProfile = profilesSection;
  try {
    const { loadRuleLedger, getAblationCandidates } = require('./guidance/ablation.ts');
    const ledger = loadRuleLedger({ repoRoot, fsImpl: rest.fsImpl });
    const candidates = getAblationCandidates(ledger);
    const neverAblateCount = ledger.rules.filter((r: any) => r.neverAblate).length;
    report.guidance = {
      rulesCount: ledger.rules.length,
      neverAblateCount,
      candidateCount: candidates.length,
    };
  } catch (error: any) {
    report.guidance = { state: 'unavailable', message: error?.message || String(error) };
  }
  try {
    const { AdmissionController, AdmissionError, resolveTeamSettings } = require('./team/admission.ts');
    const { validateTaskBrief, validateTaskHandBack, quarantineInput, formatTaskBriefPrompt, EnvelopeError } = require('./team/envelope.ts');
    const { assertReviewerSeparation, assertMechanicalPreChecks, ReviewGuardError, NeverReviewOwnCodeError, MechanicalPreChecksIncompleteError } = require('./team/review-guard.ts');
    const teamController = new AdmissionController({ projectRoot, fsImpl: rest.fsImpl });
    const activeClaims = teamController.getActiveClaims();
    report.team = {
      state: 'ready',
      activeClaimsCount: activeClaims.length,
      writerCap: teamController.writerCap,
      maxAttempts: teamController.maxAttempts,
      _symbols: [
        AdmissionController,
        AdmissionError,
        resolveTeamSettings,
        validateTaskBrief,
        validateTaskHandBack,
        quarantineInput,
        formatTaskBriefPrompt,
        EnvelopeError,
        assertReviewerSeparation,
        assertMechanicalPreChecks,
        ReviewGuardError,
        NeverReviewOwnCodeError,
        MechanicalPreChecksIncompleteError,
      ],
    };
  } catch (error: any) {
    report.team = { state: 'unavailable', message: error?.message || String(error) };
  }
  try {
    report.agentToolScope = agentToolScopeView(loadRegistry({ repoRoot, sources: 'skip' }));
  } catch (error: any) {
    report.agentToolScope = { state: 'unavailable', message: error?.message || String(error) };
  }
  // Read on use (row 120 A.4): no probe runs, nothing is written, and a fault never breaks the report.
  let primaryText: string;
  try {
    const { primaryDoctorView, resolveForReport } = require('./context/primary-command.ts');
    const resolved = resolveForReport({ env: rest.env ?? process.env, projectRoot, repoRoot });
    report.primary = primaryDoctorView(resolved);
    primaryText = `${report.primary.state} ${report.primary.harness ?? '-'}/${report.primary.model ?? '-'} (${report.primary.origin}), probe ${report.primary.probe}`;
  } catch (error: any) {
    report.primary = { state: 'unavailable', message: error?.message || String(error) };
    primaryText = `unavailable (${report.primary.message})`;
  }
  try {
    report.workers = workersDoctorView({ env: rest.env ?? process.env, projectRoot, repoRoot });
  } catch (error: any) {
    report.workers = { state: 'unavailable', message: error?.message || String(error) };
  }
  try {
    report.workerPool = workerPoolDoctorView({ env: rest.env ?? process.env, projectRoot, repoRoot });
  } catch (error: any) {
    report.workerPool = { state: 'unavailable', message: error?.message || String(error) };
  }

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return finish(report.findings.length ? 1 : 0);
  }

  console.log('\nDoFlow System Diagnostics (doflow doctor)');
  console.log('═'.repeat(72));
  console.log('Health means a provider answered a probe, not that a binary exists on PATH.');
  if (report.upkeepSwitch === 'off') console.log('note: DOFLOW_UPKEEP=off in this environment: upkeep and lifecycle retention are skipped');

  console.log('\n[Effective Identity]');
  const identity = report.identity;
  console.log(`  source            ${identity.source.root}${identity.source.version ? ` (v${identity.source.version})` : ' (version unreadable)'}`);
  console.log(`  project           ${identity.project.root}${identity.project.git ? ` (${identity.project.git.branch} @ ${identity.project.git.commit})` : ' (not a git repository)'}`);
  console.log(`  connected         ${identity.connectedCapabilities.length ? identity.connectedCapabilities.join(', ') : 'no capability has an answering provider'}`);

  console.log('\n[Harness Adapters]');
  for (const harness of report.harnesses) console.log(`  ${harness.displayName.padEnd(28)} adapter PASS`);

  console.log('\n[Agent Tool Scope]');
  if (Array.isArray(report.agentToolScope)) {
    for (const row of report.agentToolScope) console.log(`  ${row.harness.padEnd(14)}${row.status === 'native' ? `native      ${row.field}` : `unenforced  projects no tool field: ${row.reason}`}`);
  } else console.log(`  unavailable (${report.agentToolScope.message})`);

  console.log('\n[Runtime Reach]');
  const reachLines = report.harnesses.flatMap((harness: any) => harness.reach.map((row: any) => {
    const detail = ({ REACHED: row.root, 'NO-REACH': `fix: ${row.fix}`, 'N/A': row.reason } as Record<string, any>)[row.state];
    const where = row.scope === 'project' ? ` [install at ${row.installRoot}]` : '';
    return `  ${harness.id.padEnd(14)}${row.scope.padEnd(9)}${(REACH_MARK[row.state] || row.state).padEnd(13)}${detail}${where}`;
  }));
  if (reachLines.length) for (const line of reachLines) console.log(line);
  else console.log('  No harness has DoFlow ledger rows in this project or in the home directory.');

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
  const commandLine = (role: any) => (role
    ? `✓ ${role.command}${role.source ? `  (${role.source}, ${role.derivation || 'declared'})` : ''}`
    : '? not detected');
  console.log(`  build             ${commandLine(commands.build)}`);
  console.log(`  test              ${commandLine(commands.test)}`);
  if (commands.reason) console.log(`  note              ${commands.reason}`);

  console.log('\n[Primary and Workers]');
  console.log(`  primary: ${primaryText}`);
  if (report.workers.state === 'unavailable') {
    console.log(`  worker: unavailable (${report.workers.message})`);
  } else {
    if (report.workers.bindings.state === 'invalid') {
      console.log(`  workers.models: invalid (${report.workers.bindings.reason})`);
    }
    if (report.workers.state === 'invalid') {
      console.log(`  workers.enabled: invalid (${report.workers.reason})`);
    }
    for (const row of report.workers.rows) {
      const position = row.enabled.position === null ? '' : ` #${row.enabled.position}`;
      const eligibility = row.eligible ? 'eligible' : `ineligible (${row.firstGap.requirement})`;
      const bound = row.bound.map((item: any) => `${item.tier}(${item.flag})`).join(', ') || 'none';
      console.log(`  worker ${row.harness}: ${row.enabled.state}${position}, ${eligibility}; bound tiers: ${bound}`);
    }
    for (const id of report.workers.dangling) {
      console.log(`  worker ${id}: dangling (no registry or enabled package knows it)`);
    }
  }

  console.log('\n[Worker Pool & Models]');
  if (report.workerPool.state === 'unavailable') {
    console.log(`  worker pool: unavailable (${report.workerPool.message})`);
  } else if (report.workerPool.state === 'unsynced') {
    console.log('  No observed catalogue. Run `doflow models --action sync` to probe worker pool.');
    console.log(`  Models: ${report.workerPool.models.enabledCount} enabled, ${report.workerPool.models.listedCount} listed`);
  } else {
    for (const h of report.workerPool.harnesses) {
      const binStatus = h.installed ? 'installed' : (h.loginState === 'uncalibrated' ? 'unknown' : 'missing');
      const hint = h.loginState === 'logged-out' && h.reloginHint ? ` (re-login: ${h.reloginHint})` : '';
      const billSource = h.effectiveBilling.source ? ` (${h.effectiveBilling.source})` : '';
      console.log(`  ${h.harness.padEnd(14)} binary: ${binStatus.padEnd(10)} ${h.loginState.padEnd(12)} mode: ${h.detectedMode.padEnd(14)} billing: ${h.effectiveBilling.value}${billSource}${hint}`);
    }
    console.log(`  Models: ${report.workerPool.models.enabledCount} enabled, ${report.workerPool.models.listedCount} listed`);
  }

  printMcpSections(report.mcp);
  if (packagesWorthShowing(report.packages)) printPackagesSection(report.packages);
  printTranscriptsSection(report.transcripts);
  printAdviceDoctor(adviceSections);
  printProfilesDoctor(profilesSection);
  printSettingsReport(settings);
  if (report.guidance) {
    console.log('\n[Guidance Rules]');
    if (report.guidance.state === 'unavailable') {
      console.log(`  guidance: unavailable (${report.guidance.message})`);
    } else {
      console.log(`  ${report.guidance.rulesCount} registered rules (${report.guidance.neverAblateCount} protected invariants, ${report.guidance.candidateCount} ablation candidates)`);
    }
  }
  if (report.team) {
    console.log('\n[Agent Teams & Coordination]');
    if (report.team.state === 'unavailable') {
      console.log(`  team: unavailable (${report.team.message})`);
    } else {
      console.log(`  writer cap: ${report.team.writerCap}, max attempts: ${report.team.maxAttempts}, active claims: ${report.team.activeClaimsCount}`);
    }
  }

  if (report.warnings.length) {
    console.log('\n[Warnings] — not blocking; a stale or unprobeable provider still degrades cleanly, and a Node below the security release of its line is named here');
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
  probeLocalProvider,
  probeFreshness,
  PROVIDER_ARTIFACTS,
  newestSourceMtime,
  detectProjectCommands,
  buildHealthReport,
  nodeSecurityWarning,
  workersDoctorView,
  workerPoolDoctorView,
  handleDoctorCommand,
  PROBE_TIMEOUT_MS,
};
