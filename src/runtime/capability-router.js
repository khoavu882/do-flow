'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

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
    this.repoRoot = options.repoRoot || path.resolve(__dirname, '..', '..');
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
    const capsPath = path.join(this.registryDir, 'capabilities.yaml');
    const routesPath = path.join(this.registryDir, 'routes.yaml');
    
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
    
    // For native providers, check binary if specified (or fallback to basic availability)
    if (provider.kind === 'native') {
      if (provider.binary) {
        const available = this.isBinaryAvailable(provider.binary);
        if (!available && provider.binary === 'rg') {
          // If rg is not present, check for standard grep as baseline fallback
          const grepAvailable = this.isBinaryAvailable('grep');
          if (grepAvailable) {
            return { status: 'HEALTHY', details: 'Using grep fallback' };
          }
        }
        if (!available) {
          return { status: 'UNAVAILABLE', details: `Native binary '${provider.binary}' not found` };
        }
      }
      return { status: 'HEALTHY' };
    }

    if (provider.binary) {
      const available = this.isBinaryAvailable(provider.binary);
      if (!available) {
        return { status: 'UNAVAILABLE', details: `Tool binary '${provider.binary}' not found` };
      }
      if (deepCheck && provider.checkCommand) {
        const smoke = this.executeSmokeCheck(provider.checkCommand);
        if (!smoke.ok) {
          return { status: 'UNAVAILABLE', details: `Smoke check failed: ${smoke.error}` };
        }
      }
      return { status: 'HEALTHY' };
    }

    return { status: 'HEALTHY' };
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
   * @param {string} intent
   * @param {Object} provider
   * @param {Object} params
   * @returns {Object}
   */
  formatExecution(intent, provider, params = {}) {
    const query = params.query || params.symbol || params.concept || '';
    const targetPath = params.path || '.';

    if (provider.id === 'semble.search') {
      return {
        mcpTool: 'mcp__semble__search',
        cliCommand: `semble search "${query}" ${targetPath} --content ${params.content || 'code'}`,
        args: { query, path: targetPath, content: params.content || 'code' },
      };
    }

    if (provider.id === 'graphify.query') {
      return {
        mcpTool: 'mcp__graphify__query_graph',
        cliCommand: `graphify query "${query}"`,
        args: { query, project_path: targetPath },
      };
    }

    if (provider.id === 'native.rg') {
      const isRg = this.isBinaryAvailable('rg');
      const bin = isRg ? 'rg' : 'grep -rn';
      return {
        cliCommand: `${bin} -i "${query}" ${targetPath}`,
        args: { query, path: targetPath },
      };
    }

    if (provider.id === 'git.native') {
      return {
        cliCommand: `git log -n ${params.maxCommits || 10} --grep="${query}"`,
        args: { query },
      };
    }

    if (provider.id === 'rtk') {
      const rawCmd = params.command || 'git status';
      return {
        cliCommand: `rtk ${rawCmd}`,
        args: { rawCommand: rawCmd },
      };
    }

    return {
      cliCommand: `${provider.binary || provider.id} "${query}"`,
      args: params,
    };
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

module.exports = {
  CapabilityRouter,
  parseYamlFile,
};
