'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { finishRuntime, usageError } = require('./cli-result');
const { REPO_ROOT } = require('../helper/repo-root');

// Mirrors bin/doflow.js's own REPO_ROOT computation, relative to this file's location, so
// handleRouteCommand resolves the same repo root it did before relocation. (D8)

/** POSIX single-quote escaping, for the DISPLAY string only — execution always uses the argv
 * vector, never a shell string, so retrieved data can never become shell syntax (review R5). */
function shellQuote(word) {
  const text = String(word);
  if (text !== '' && /^[A-Za-z0-9_@%+=:,.\/-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function parseYamlFile(filePath, fsImpl = fs) {
  try {
    const text = fsImpl.readFileSync(filePath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Failed to parse registry file '${filePath}': ${error.message}`);
  }
}

class CapabilityRouter {
  /**
   * @param {Object} [options]
   * @param {string} [options.repoRoot]
   * @param {string} [options.registryDir]
   * @param {Object} [options.capabilities]
   * @param {Object} [options.routes]
   * @param {Object} [options.fsImpl]
   * @param {Function} [options.binaryChecker]
   */
  constructor(options = {}) {
    this.fsImpl = options.fsImpl || fs;
    this.repoRoot = options.repoRoot || REPO_ROOT;
    // Two roots, deliberately distinct (review A3, surfaced by R5's tests): `repoRoot` locates the
    // DoFlow install — the registry ships inside it — while `projectRoot` is the repository under
    // work, whose manifests native.test detection reads. Under an npm install they differ; a
    // single root made detection read the DoFlow package's own package.json.
    this.projectRoot = options.projectRoot || options.repoRoot || process.cwd();
    this.registryDir = options.registryDir || path.join(this.repoRoot, 'core', 'registry');
    this.binaryChecker = options.binaryChecker || null;
    this.binaryCache = new Map();
    
    if (options.capabilities && options.routes) {
      this.capabilities = options.capabilities;
      this.routes = options.routes;
    } else {
      this.loadRegistries();
    }
  }

  loadRegistries() {
    const capsPath = path.join(this.registryDir, 'capabilities.json');
    const routesPath = path.join(this.registryDir, 'routes.json');
    
    const capsData = parseYamlFile(capsPath, this.fsImpl);
    const routesData = parseYamlFile(routesPath, this.fsImpl);

    this.capabilities = capsData.capabilities || {};
    this.routes = routesData.routes || {};
  }

  /**
   * Check if an executable binary is present in PATH or environment with caching.
   * @param {string} binary
   * @returns {boolean}
   */
  isBinaryAvailable(binary) {
    if (!binary) return false;
    if (this.binaryChecker) {
      return this.binaryChecker(binary);
    }
    if (this.binaryCache.has(binary)) {
      return this.binaryCache.get(binary);
    }
    try {
      const isWin = process.platform === 'win32';
      const cmd = isWin ? 'where' : 'which';
      execFileSync(cmd, [binary], { stdio: 'ignore', timeout: 1000 });
      this.binaryCache.set(binary, true);
      return true;
    } catch {
      this.binaryCache.set(binary, false);
      return false;
    }
  }

  /**
   * Executes a smoke check command for a provider.
   * @param {Array<string>} checkCommand
   * @returns {{ ok: boolean, output?: string, error?: string }}
   */
  executeSmokeCheck(checkCommand) {
    if (!Array.isArray(checkCommand) || checkCommand.length === 0) {
      return { ok: true };
    }
    const [bin, ...args] = checkCommand;
    try {
      const stdout = execFileSync(bin, args, {
        encoding: 'utf8',
        timeout: 2500,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, output: stdout.trim() };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  }

  /**
   * Evaluates the health of a single provider.
   * @param {Object} provider
   * @param {boolean} [deepCheck=false]
   * @returns {{ status: 'HEALTHY'|'UNAVAILABLE', details?: string }}
   */
  evaluateProviderHealth(provider, deepCheck = false) {
    if (!provider) return { status: 'UNAVAILABLE', details: 'No provider declared' };

    // Declared / installed / responsive are DISTINCT facts (review R5): `facts` reports each one
    // as true, false, or null-for-not-measured, so "healthy" can never silently mean only
    // "declared in the registry". The summary `status` stays for existing callers.
    const facts = { declared: true, installed: null, responsive: null };

    // `native.test` has no binary — its installedness is whether this project's manifests declare
    // a test command at all. Reporting HEALTHY without that check routed verify-runtime-behavior
    // to an invented `npm test` on machines where every binary probe failed (review R5).
    if (provider.id === 'native.test') {
      const command = this.detectTestCommand();
      facts.installed = Boolean(command);
      if (!command) {
        return { status: 'UNAVAILABLE', details: 'No test command detected in project manifests', facts };
      }
      return { status: 'HEALTHY', details: `Project test command: ${command}`, facts };
    }

    // For native providers, check binary if specified (or fallback to basic availability)
    if (provider.kind === 'native') {
      if (provider.binary) {
        const available = this.isBinaryAvailable(provider.binary);
        facts.installed = available;
        if (!available && provider.binary === 'rg') {
          // If rg is not present, check for standard grep as baseline fallback
          const grepAvailable = this.isBinaryAvailable('grep');
          if (grepAvailable) {
            facts.installed = true;
            return { status: 'HEALTHY', details: 'Using grep fallback', facts };
          }
        }
        if (!available) {
          return { status: 'UNAVAILABLE', details: `Native binary '${provider.binary}' not found`, facts };
        }
      }
      return { status: 'HEALTHY', facts };
    }

    if (provider.binary) {
      const available = this.isBinaryAvailable(provider.binary);
      facts.installed = available;
      if (!available) {
        return { status: 'UNAVAILABLE', details: `Tool binary '${provider.binary}' not found`, facts };
      }
      if (deepCheck && provider.checkCommand) {
        const smoke = this.executeSmokeCheck(provider.checkCommand);
        facts.responsive = smoke.ok;
        if (!smoke.ok) {
          return { status: 'UNAVAILABLE', details: `Smoke check failed: ${smoke.error}`, facts };
        }
      }
      return { status: 'HEALTHY', facts };
    }

    return { status: 'HEALTHY', facts };
  }

  /**
   * Resolves a capability to its highest-priority healthy provider.
   * @param {string} capabilityId
   * @param {Object} [options]
   * @param {boolean} [options.deepCheck=false]
   * @returns {{ capabilityId: string, provider: Object|null, status: string, fallbackProviders: Array<Object> }}
   */
  resolveCapability(capabilityId, { deepCheck = false } = {}) {
    const capability = this.capabilities[capabilityId];
    if (!capability) {
      throw new Error(`Unknown capability '${capabilityId}'`);
    }

    const providers = capability.providers || [];
    let selectedProvider = null;
    let selectedStatus = 'UNAVAILABLE';
    const fallbackProviders = [];

    for (let i = 0; i < providers.length; i++) {
      const prov = providers[i];
      const health = this.evaluateProviderHealth(prov, deepCheck);
      
      if (health.status === 'HEALTHY') {
        if (!selectedProvider) {
          selectedProvider = prov;
          selectedStatus = i === 0 ? 'HEALTHY' : 'FALLBACK';
        } else {
          fallbackProviders.push(prov);
        }
      } else {
        fallbackProviders.push({ ...prov, status: 'UNAVAILABLE', reason: health.details });
      }
    }

    return {
      capabilityId,
      description: capability.description,
      provider: selectedProvider,
      status: selectedStatus,
      fallbackProviders,
    };
  }

  /**
   * Formats concrete execution instructions for a provider based on intent parameters.
   *
   * The executable contract is `argv` — an argument VECTOR, executed without a shell (review R5:
   * the old interpolated strings turned a query containing `$(...)` into executable shell syntax
   * and split a path containing spaces). `cliCommand` remains for display and for a human typing
   * it, built by quoting every argv word; it is never the primary contract. MCP invocations get a
   * validated tool name plus an argument object using the tool's own parameter names.
   *
   * @param {string} intent
   * @param {Object} provider
   * @param {Object} params
   * @returns {Object}
   */
  formatExecution(intent, provider, params = {}) {
    const query = params.query || params.symbol || params.concept || '';
    const targetPath = params.path || '.';
    const withDisplay = (result) => (result.argv ? { ...result, cliCommand: result.argv.map(shellQuote).join(' ') } : result);

    if (provider.id === 'semble.search') {
      const content = params.content || 'code';
      return withDisplay({
        mcpTool: 'mcp__semble__search',
        // `repo`, not `path`: the MCP tool's schema names the project root `repo` and rejects a
        // call without it (review R5 — the routed arguments did not fit the tool they named).
        args: { query, repo: targetPath, content },
        argv: ['semble', 'search', query, targetPath, '--content', content],
      });
    }

    if (provider.id === 'graphify.query') {
      return withDisplay({
        mcpTool: 'mcp__graphify__query_graph',
        args: { query, project_path: targetPath },
        argv: ['graphify', 'query', query],
      });
    }

    if (provider.id === 'native.rg') {
      const isRg = this.isBinaryAvailable('rg');
      return withDisplay({
        argv: isRg ? ['rg', '-i', query, targetPath] : ['grep', '-rn', '-i', query, targetPath],
        args: { query, path: targetPath },
      });
    }

    if (provider.id === 'git.native') {
      return withDisplay({
        argv: ['git', 'log', '-n', String(params.maxCommits || 10), `--grep=${query}`],
        args: { query },
      });
    }

    if (provider.id === 'rtk') {
      // `params.command` is by contract a command the caller already owns, not retrieved data, so
      // it passes through; there is no argv because splitting a caller's command string here would
      // corrupt any quoted argument it contains.
      const rawCmd = params.command || 'git status';
      return {
        cliCommand: `rtk ${rawCmd}`,
        args: { rawCommand: rawCmd },
      };
    }

    // `native.test` stands for "whatever this project runs its tests with", read from the project's
    // own manifests via the shared command detector. No detection, no command: inventing `npm test`
    // for a project that never declared it hands the model a plausible-looking command that answers
    // a question nobody asked (review R5).
    if (provider.id === 'native.test') {
      const command = params.testCommand || this.detectTestCommand();
      if (!command) {
        return {
          cliCommand: null,
          argv: null,
          args: {},
          reason: 'No test command detected in this project\'s manifests; declare one (plan.md override or package manifest) before routing verify-runtime-behavior here.',
        };
      }
      return withDisplay({
        argv: [...command.split(' '), ...(query ? [query] : [])],
        args: { testCommand: command, ...(query ? { filter: query } : {}) },
      });
    }

    return withDisplay({
      argv: [provider.binary || provider.id, query],
      args: params,
    });
  }

  /** The project's own test entrypoint, read from its manifests by the shared command detector —
   * the same detector `doflow verify` uses, so the two agree. Returns null when no manifest
   * declares one: a wrong guess here becomes a command the model runs. */
  detectTestCommand() {
    try {
      const { detectCommands } = require('./command-detect');
      const detected = detectCommands({ projectRoot: this.projectRoot });
      return detected.commands?.test?.command || null;
    } catch {
      return null;
    }
  }

  /**
   * Resolves a user/task information intent to a structured RetrievalPlan.
   * @param {string} intentId
   * @param {Object} [params={}]
   * @param {Object} [options={}]
   * @returns {Object} RetrievalPlan
   */
  resolveIntent(intentId, params = {}, { deepCheck = false } = {}) {
    const route = this.routes[intentId];
    if (!route) {
      throw new Error(`Unknown route/intent '${intentId}'`);
    }

    const primaryCapId = route.capability;
    const primaryResolution = this.resolveCapability(primaryCapId, { deepCheck });

    if (primaryResolution.provider) {
      return {
        intent: intentId,
        description: route.description,
        capability: primaryCapId,
        selectedProvider: primaryResolution.provider,
        status: primaryResolution.status,
        execution: this.formatExecution(intentId, primaryResolution.provider, params),
        fallbackChain: (route.fallback || []).map((fbCap) => ({
          capability: fbCap,
          resolved: this.resolveCapability(fbCap, { deepCheck }),
        })),
      };
    }

    // Primary capability had no healthy providers. Evaluate route fallbacks in order.
    for (const fallbackCapId of route.fallback || []) {
      const fallbackResolution = this.resolveCapability(fallbackCapId, { deepCheck });
      if (fallbackResolution.provider) {
        return {
          intent: intentId,
          description: route.description,
          capability: fallbackCapId,
          selectedProvider: fallbackResolution.provider,
          status: 'FALLBACK',
          execution: this.formatExecution(intentId, fallbackResolution.provider, params),
          fallbackChain: [
            {
              capability: primaryCapId,
              status: 'UNAVAILABLE',
              reason: 'No healthy providers available',
            },
          ],
        };
      }
    }

    return {
      intent: intentId,
      description: route.description,
      capability: primaryCapId,
      selectedProvider: null,
      status: 'UNAVAILABLE',
      execution: null,
      fallbackChain: (route.fallback || []).map((cap) => ({ capability: cap, status: 'UNAVAILABLE' })),
    };
  }

  /**
   * Returns a complete diagnostic health report for all registered capabilities and routes.
   * @param {boolean} [deepCheck=false]
   * @returns {Array<Object>}
   */
  getAllCapabilitiesHealth(deepCheck = false) {
    const report = [];
    for (const [capId, cap] of Object.entries(this.capabilities)) {
      const resolution = this.resolveCapability(capId, { deepCheck });
      report.push({
        capability: capId,
        description: cap.description,
        status: resolution.status,
        activeProvider: resolution.provider ? resolution.provider.name : 'None',
        providerId: resolution.provider ? resolution.provider.id : null,
        totalProviders: cap.providers ? cap.providers.length : 0,
      });
    }
    return report;
  }
}

/**
 * Handles `doflow route` — resolve an information need to a provider that is actually healthy.
 *
 * Exits 1 when no provider can serve the intent: that is a finding the caller must act on (the
 * work still has to be done, by hand or by a different route), not an error in the request.
 *
 * @param {Object} options
 * @param {string|null} options.intent
 * @param {string} [options.query]
 * @param {boolean} [options.check=false] deep smoke check instead of a presence check
 * @param {boolean} [options.json=false]
 * @param {string} [options.projectRoot]
 * @returns {number} exit code
 */
function handleRouteCommand({ intent, query, check = false, json = false, projectRoot } = {}) {
  const router = new CapabilityRouter({ repoRoot: REPO_ROOT, projectRoot });
  if (typeof intent !== 'string' || intent.trim() === '') {
    return usageError('route', `--intent is required. Declared intents: ${Object.keys(router.routes).join(', ')}`, json);
  }

  let resolution;
  try {
    resolution = router.resolveIntent(intent, { query, path: projectRoot || '.' }, { deepCheck: check });
  } catch (error) {
    return usageError('route', `${error.message}. Declared intents: ${Object.keys(router.routes).join(', ')}`, json);
  }

  if (json) console.log(JSON.stringify(resolution, null, 2));
  else {
    console.log(`\nDoFlow Route [${resolution.intent}] — ${resolution.status}:`);
    console.log('═'.repeat(78));
    console.log(`Need:       ${resolution.description}`);
    console.log(`Capability: ${resolution.capability}`);
    console.log(`Provider:   ${resolution.selectedProvider ? resolution.selectedProvider.name : 'none — no provider on this machine can answer'}`);
    if (resolution.execution) {
      console.log('─'.repeat(78));
      for (const [key, value] of Object.entries(resolution.execution)) console.log(`  ${key.padEnd(12)} ${value}`);
    }
    console.log('═'.repeat(78) + '\n');
  }
  return finishRuntime(resolution.selectedProvider ? 0 : 1);
}

module.exports = {
  CapabilityRouter,
  parseYamlFile,
  handleRouteCommand,
};
