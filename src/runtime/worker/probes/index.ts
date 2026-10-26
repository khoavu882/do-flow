'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

import type { SyncHarnessResult, LoginState, DetectedMode, DerivedBilling, OfferedModel } from '../../models/catalogue.ts';

export interface ProbeOptions {
  timeoutMs?: number;
  execFileImpl?: any;
  env?: Record<string, string | undefined>;
  fsImpl?: any;
  homeDir?: string;
  projectRoot?: string;
}

export type HarnessProbeRunner = (options?: ProbeOptions) => Promise<SyncHarnessResult>;

const DEFAULT_PROBE_TIMEOUT_MS = 3000;

const RELOGIN_HINTS: Record<string, string> = {
  claude: 'claude login',
  codex: 'codex login',
  opencode: 'opencode auth login <provider>',
  pi: 'pi',
  copilot: 'copilot login',
  kiro: 'kiro-cli login',
  antigravity: 'agy',
};

const HARNESS_BINARIES: Record<string, string> = {
  claude: 'claude',
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  copilot: 'copilot',
  kiro: 'kiro-cli',
  antigravity: 'agy',
};

const DEFAULT_MODELS: Record<string, OfferedModel[]> = {
  claude: [
    { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'claude' },
    { id: 'claude-3-5-sonnet', displayName: 'Claude 3.5 Sonnet', family: 'claude' },
    { id: 'claude-3-5-haiku', displayName: 'Claude 3.5 Haiku', family: 'claude' },
  ],
  codex: [
    { id: 'o3-mini', displayName: 'o3-mini', family: 'openai' },
    { id: 'o1', displayName: 'o1', family: 'openai' },
    { id: 'gpt-4o', displayName: 'GPT-4o', family: 'openai' },
  ],
  opencode: [
    { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'claude' },
    { id: 'gpt-4o', displayName: 'GPT-4o', family: 'openai' },
  ],
  pi: [
    { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'claude' },
  ],
  copilot: [
    { id: 'claude-3.5-sonnet', displayName: 'Claude 3.5 Sonnet', family: 'claude' },
    { id: 'gpt-4o', displayName: 'GPT-4o', family: 'openai' },
  ],
  kiro: [
    { id: 'claude-3-7-sonnet', displayName: 'Claude 3.7 Sonnet', family: 'claude' },
  ],
  antigravity: [
    { id: 'gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', family: 'gemini' },
    { id: 'gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', family: 'gemini' },
  ],
};

async function executeCommand(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; execFileImpl?: any; env?: any }
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | string | null }> {
  const timeout = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const runner = options.execFileImpl;

  if (runner) {
    return new Promise((resolve) => {
      try {
        const proc = runner(bin, args, { timeout, env: options.env }, (err: any, stdout: string, stderr: string) => {
          if (err) {
            resolve({
              ok: false,
              stdout: String(stdout || ''),
              stderr: String(stderr || err.message || ''),
              code: err.code || 1,
            });
          } else {
            resolve({
              ok: true,
              stdout: String(stdout || '').trim(),
              stderr: String(stderr || '').trim(),
              code: 0,
            });
          }
        });
        if (proc && typeof proc.then === 'function') {
          proc.then(
            (res: any) => resolve({ ok: true, stdout: String(res.stdout || '').trim(), stderr: String(res.stderr || '').trim(), code: 0 }),
            (err: any) => resolve({ ok: false, stdout: String(err.stdout || ''), stderr: String(err.stderr || err.message || ''), code: err.code || 1 })
          );
        }
      } catch (err: any) {
        resolve({
          ok: false,
          stdout: '',
          stderr: err.message || String(err),
          code: err.code || 'ERR',
        });
      }
    });
  }

  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { timeout, env: options.env });
    return { ok: true, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), code: 0 };
  } catch (err: any) {
    return {
      ok: false,
      stdout: String(err.stdout || ''),
      stderr: String(err.stderr || err.message || ''),
      code: err.code || 1,
    };
  }
}

function parseVersion(text: string): string | null {
  const match = text.match(/\b\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.]+)?\b/);
  return match ? match[0] : null;
}

const probeClaude: HarnessProbeRunner = async (options: ProbeOptions = {}) => {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const home = options.homeDir ?? os.homedir();
  const binary = HARNESS_BINARIES.claude;
  const reloginHint = RELOGIN_HINTS.claude;

  const ver = await executeCommand(binary, ['--version'], options);
  if (!ver.ok && (ver.code === 'ENOENT' || ver.stderr.includes('ENOENT') || ver.stderr.includes('not found'))) {
    return {
      harnessId: 'claude',
      binary,
      installed: false,
      version: null,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.claude,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const installed = true;
  const version = ver.ok ? parseVersion(ver.stdout) : null;

  if (env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim()) {
    return {
      harnessId: 'claude',
      binary,
      installed,
      version,
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'api-key',
      derivedBilling: 'metered',
      offeredModels: DEFAULT_MODELS.claude,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const claudeJson = path.join(home, '.claude.json');
  let hasSession = false;
  try {
    if (fsImpl.existsSync(claudeJson)) {
      const data = JSON.parse(fsImpl.readFileSync(claudeJson, 'utf8'));
      if (data && (data.oauthAccount || data.sessionKey || data.token || data.userID)) {
        hasSession = true;
      }
    }
  } catch {
    // unreadable
  }

  if (hasSession) {
    return {
      harnessId: 'claude',
      binary,
      installed,
      version,
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'subscription',
      derivedBilling: 'free',
      offeredModels: DEFAULT_MODELS.claude,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  return {
    harnessId: 'claude',
    binary,
    installed,
    version,
    loginState: 'logged-out',
    reloginHint,
    detectedMode: 'unverified',
    derivedBilling: 'unknown',
    offeredModels: DEFAULT_MODELS.claude,
    lastSyncedAt: new Date().toISOString(),
  };
};

const probeCodex: HarnessProbeRunner = async (options: ProbeOptions = {}) => {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const home = options.homeDir ?? os.homedir();
  const binary = HARNESS_BINARIES.codex;
  const reloginHint = RELOGIN_HINTS.codex;

  const ver = await executeCommand(binary, ['--version'], options);
  if (!ver.ok && (ver.code === 'ENOENT' || ver.stderr.includes('ENOENT') || ver.stderr.includes('not found'))) {
    return {
      harnessId: 'codex',
      binary,
      installed: false,
      version: null,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.codex,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const installed = true;
  const version = ver.ok ? parseVersion(ver.stdout) : null;

  const status = await executeCommand(binary, ['login', 'status'], options);
  if (!status.ok) {
    return {
      harnessId: 'codex',
      binary,
      installed,
      version,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.codex,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const configToml = path.join(home, '.codex', 'config.toml');
  let configText = '';
  try {
    if (fsImpl.existsSync(configToml)) {
      configText = fsImpl.readFileSync(configToml, 'utf8');
    }
  } catch {
    // ignore
  }

  let detectedMode: DetectedMode = 'subscription';
  let derivedBilling: DerivedBilling = 'free';

  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim()) {
    detectedMode = 'api-key';
    derivedBilling = 'metered';
  } else if (configText.includes('[model_providers]') || configText.includes('api_key')) {
    detectedMode = 'api-key';
    derivedBilling = 'metered';
  } else if (configText.includes('forced_login_method = "chatgpt"') || status.stdout.toLowerCase().includes('chatgpt')) {
    detectedMode = 'subscription';
    derivedBilling = 'free';
  }

  return {
    harnessId: 'codex',
    binary,
    installed,
    version,
    loginState: 'logged-in',
    reloginHint: null,
    detectedMode,
    derivedBilling,
    offeredModels: DEFAULT_MODELS.codex,
    lastSyncedAt: new Date().toISOString(),
  };
};

const probeOpencode: HarnessProbeRunner = async (options: ProbeOptions = {}) => {
  const binary = HARNESS_BINARIES.opencode;
  const reloginHint = RELOGIN_HINTS.opencode;

  const ver = await executeCommand(binary, ['--version'], options);
  if (!ver.ok && (ver.code === 'ENOENT' || ver.stderr.includes('ENOENT') || ver.stderr.includes('not found'))) {
    return {
      harnessId: 'opencode',
      binary,
      installed: false,
      version: null,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.opencode,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const installed = true;
  const version = ver.ok ? parseVersion(ver.stdout) : null;

  const authRes = await executeCommand(binary, ['auth', 'list', '--format', 'json'], options);
  if (!authRes.ok) {
    return {
      harnessId: 'opencode',
      binary,
      installed,
      version,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.opencode,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  try {
    const parsed = JSON.parse(authRes.stdout);
    const accounts = Array.isArray(parsed) ? parsed : (parsed.accounts || parsed.providers || Object.values(parsed));
    if (Array.isArray(accounts) && accounts.length > 0) {
      const isOauth = accounts.some((a: any) =>
        (typeof a === 'string' && a.includes('oauth')) ||
        a.type === 'oauth' || a.method === 'oauth' || a.authType === 'oauth'
      );
      return {
        harnessId: 'opencode',
        binary,
        installed,
        version,
        loginState: 'logged-in',
        reloginHint: null,
        detectedMode: isOauth ? 'subscription' : 'api-key',
        derivedBilling: isOauth ? 'free' : 'metered',
        offeredModels: DEFAULT_MODELS.opencode,
        lastSyncedAt: new Date().toISOString(),
      };
    }
  } catch {
    // not valid json or empty
  }

  return {
    harnessId: 'opencode',
    binary,
    installed,
    version,
    loginState: 'logged-out',
    reloginHint,
    detectedMode: 'unverified',
    derivedBilling: 'unknown',
    offeredModels: DEFAULT_MODELS.opencode,
    lastSyncedAt: new Date().toISOString(),
  };
};

const probePi: HarnessProbeRunner = async (options: ProbeOptions = {}) => {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const home = options.homeDir ?? os.homedir();
  const binary = HARNESS_BINARIES.pi;
  const reloginHint = RELOGIN_HINTS.pi;

  const ver = await executeCommand(binary, ['--version'], options);
  if (!ver.ok && (ver.code === 'ENOENT' || ver.stderr.includes('ENOENT') || ver.stderr.includes('not found'))) {
    return {
      harnessId: 'pi',
      binary,
      installed: false,
      version: null,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.pi,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const installed = true;
  const version = ver.ok ? parseVersion(ver.stdout) : null;

  const piModelsJson = path.join(home, '.pi', 'agent', 'models.json');
  let hasKey = Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);
  let customModels: OfferedModel[] = DEFAULT_MODELS.pi;

  try {
    if (fsImpl.existsSync(piModelsJson)) {
      const data = JSON.parse(fsImpl.readFileSync(piModelsJson, 'utf8'));
      if (data && typeof data === 'object') {
        hasKey = true;
        if (Array.isArray(data.models)) {
          customModels = data.models.map((m: any) => ({
            id: typeof m === 'string' ? m : m.id,
            displayName: typeof m === 'object' ? m.name || m.displayName : undefined,
          }));
        }
      }
    }
  } catch {
    // ignore
  }

  if (hasKey) {
    return {
      harnessId: 'pi',
      binary,
      installed,
      version,
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'api-key',
      derivedBilling: 'metered',
      offeredModels: customModels,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  return {
    harnessId: 'pi',
    binary,
    installed,
    version,
    loginState: 'logged-out',
    reloginHint,
    detectedMode: 'unverified',
    derivedBilling: 'unknown',
    offeredModels: customModels,
    lastSyncedAt: new Date().toISOString(),
  };
};

const probeCopilot: HarnessProbeRunner = async (options: ProbeOptions = {}) => {
  const env = options.env ?? process.env;
  const binary = HARNESS_BINARIES.copilot;
  const reloginHint = RELOGIN_HINTS.copilot;

  const ver = await executeCommand(binary, ['--version'], options);
  if (!ver.ok && (ver.code === 'ENOENT' || ver.stderr.includes('ENOENT') || ver.stderr.includes('not found'))) {
    return {
      harnessId: 'copilot',
      binary,
      installed: false,
      version: null,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.copilot,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const installed = true;
  const version = ver.ok ? parseVersion(ver.stdout) : null;

  let loggedIn = Boolean((env.COPILOT_GITHUB_TOKEN && env.COPILOT_GITHUB_TOKEN.trim()) || (env.GITHUB_TOKEN && env.GITHUB_TOKEN.trim()));

  if (!loggedIn) {
    const ghCheck = await executeCommand('gh', ['auth', 'status'], options);
    if (ghCheck.ok || (ghCheck.stdout && ghCheck.stdout.includes('Logged in to github.com'))) {
      loggedIn = true;
    }
  }

  if (loggedIn) {
    return {
      harnessId: 'copilot',
      binary,
      installed,
      version,
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'subscription',
      derivedBilling: 'free',
      offeredModels: DEFAULT_MODELS.copilot,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  return {
    harnessId: 'copilot',
    binary,
    installed,
    version,
    loginState: 'logged-out',
    reloginHint,
    detectedMode: 'unverified',
    derivedBilling: 'unknown',
    offeredModels: DEFAULT_MODELS.copilot,
    lastSyncedAt: new Date().toISOString(),
  };
};

const probeKiro: HarnessProbeRunner = async (options: ProbeOptions = {}) => {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const home = options.homeDir ?? os.homedir();
  const binary = HARNESS_BINARIES.kiro;
  const reloginHint = RELOGIN_HINTS.kiro;

  const ver = await executeCommand(binary, ['--version'], options);
  if (!ver.ok && (ver.code === 'ENOENT' || ver.stderr.includes('ENOENT') || ver.stderr.includes('not found'))) {
    return {
      harnessId: 'kiro',
      binary,
      installed: false,
      version: null,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.kiro,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const installed = true;
  const version = ver.ok ? parseVersion(ver.stdout) : null;

  if (env.KIRO_API_KEY && env.KIRO_API_KEY.trim()) {
    return {
      harnessId: 'kiro',
      binary,
      installed,
      version,
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'api-key',
      derivedBilling: 'metered',
      offeredModels: DEFAULT_MODELS.kiro,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const kiroDir = path.join(home, '.kiro');
  let hasSubscription = false;
  try {
    if (fsImpl.existsSync(kiroDir)) {
      const files = fsImpl.readdirSync(kiroDir);
      hasSubscription = files.some((f: string) => f.includes('session') || f.includes('token') || f.includes('credentials'));
    }
  } catch {
    // ignore
  }

  if (hasSubscription) {
    return {
      harnessId: 'kiro',
      binary,
      installed,
      version,
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'subscription',
      derivedBilling: 'free',
      offeredModels: DEFAULT_MODELS.kiro,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  return {
    harnessId: 'kiro',
    binary,
    installed,
    version,
    loginState: 'logged-out',
    reloginHint,
    detectedMode: 'unverified',
    derivedBilling: 'unknown',
    offeredModels: DEFAULT_MODELS.kiro,
    lastSyncedAt: new Date().toISOString(),
  };
};

const probeAntigravity: HarnessProbeRunner = async (options: ProbeOptions = {}) => {
  const env = options.env ?? process.env;
  const fsImpl = options.fsImpl ?? fs;
  const home = options.homeDir ?? os.homedir();
  const binary = HARNESS_BINARIES.antigravity;
  const reloginHint = RELOGIN_HINTS.antigravity;

  const ver = await executeCommand(binary, ['--version'], options);
  if (!ver.ok && (ver.code === 'ENOENT' || ver.stderr.includes('ENOENT') || ver.stderr.includes('not found'))) {
    return {
      harnessId: 'antigravity',
      binary,
      installed: false,
      version: null,
      loginState: 'logged-out',
      reloginHint,
      detectedMode: 'unverified',
      derivedBilling: 'unknown',
      offeredModels: DEFAULT_MODELS.antigravity,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const installed = true;
  const version = ver.ok ? parseVersion(ver.stdout) : null;

  if (env.AGY_ADC_AUTH === 'true' || env.GOOGLE_APPLICATION_CREDENTIALS) {
    return {
      harnessId: 'antigravity',
      binary,
      installed,
      version,
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'api-key',
      derivedBilling: 'metered',
      offeredModels: DEFAULT_MODELS.antigravity,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const agyDir = path.join(home, '.gemini', 'antigravity-cli');
  let hasToken = false;
  try {
    if (fsImpl.existsSync(agyDir)) {
      const files = fsImpl.readdirSync(agyDir);
      hasToken = files.some((f: string) => f.includes('token') || f.includes('profile') || f.endsWith('.json'));
    }
  } catch {
    // ignore
  }

  if (hasToken) {
    return {
      harnessId: 'antigravity',
      binary,
      installed,
      version,
      loginState: 'logged-in',
      reloginHint: null,
      detectedMode: 'subscription',
      derivedBilling: 'free',
      offeredModels: DEFAULT_MODELS.antigravity,
      lastSyncedAt: new Date().toISOString(),
    };
  }

  return {
    harnessId: 'antigravity',
    binary,
    installed,
    version,
    loginState: 'logged-out',
    reloginHint,
    detectedMode: 'unverified',
    derivedBilling: 'unknown',
    offeredModels: DEFAULT_MODELS.antigravity,
    lastSyncedAt: new Date().toISOString(),
  };
};

const PROBES: Record<string, HarnessProbeRunner> = {
  claude: probeClaude,
  codex: probeCodex,
  opencode: probeOpencode,
  pi: probePi,
  copilot: probeCopilot,
  kiro: probeKiro,
  antigravity: probeAntigravity,
};

const HARNESS_IDS = Object.keys(PROBES);

module.exports = {
  DEFAULT_PROBE_TIMEOUT_MS,
  RELOGIN_HINTS,
  HARNESS_BINARIES,
  DEFAULT_MODELS,
  probeClaude,
  probeCodex,
  probeOpencode,
  probePi,
  probeCopilot,
  probeKiro,
  probeAntigravity,
  PROBES,
  HARNESS_IDS,
};
