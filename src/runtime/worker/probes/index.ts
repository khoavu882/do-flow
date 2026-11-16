'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

import type { SyncHarnessResult, LoginState, DetectedMode, DerivedBilling } from '../../models/catalogue.ts';

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

/** How a failed process ended. `code` above reads a missing exit code as 1, so a timeout or a signal looks like an exit 1:
 * a probe that must tell the two apart reads `exited` (a real numeric exit code), `killed` (a timeout) and `signal`. */
function ended(err: any): { exited: boolean; signal: string | null; killed: boolean } {
  return { exited: typeof err.code === 'number', signal: typeof err.signal === 'string' ? err.signal : null, killed: err.killed === true };
}

async function executeCommand(
  bin: string,
  args: string[],
  options: { timeoutMs?: number; execFileImpl?: any; env?: any }
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | string | null; exited?: boolean; signal?: string | null; killed?: boolean }> {
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
              ...ended(err),
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
            (err: any) => resolve({ ok: false, stdout: String(err.stdout || ''), stderr: String(err.stderr || err.message || ''), code: err.code || 1, ...ended(err) })
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
      ...ended(err),
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
      offeredModels: [],
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
      offeredModels: [],
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
      offeredModels: [],
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
    offeredModels: [],
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
      offeredModels: [],
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
      offeredModels: [],
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
    offeredModels: [],
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
      offeredModels: [],
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
      offeredModels: [],
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
        offeredModels: [],
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
    offeredModels: [],
    lastSyncedAt: new Date().toISOString(),
  };
};

/** Pi's own login check (pi 1.5.2, `pi auth --help`): `pi auth check` prints ready, not_ready or invalid and exits 0, 1 or 2. */
const PI_CHECK_SHOWN = /^\s*pi auth check\b[^\n]*--json[^\n]*--no-refresh/m;
const PI_PROVIDER = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PI_PROVIDERS_MAX = 8;
/** Said in every result that came from `pi auth check`: Pi 1.5.2's `--no-refresh` check reads an OAuth login as ready
 * whatever its expiry, so an expired one shows only on a run (as an error result), never here. */
const PI_CHECK_LIMIT = 'an expired OAuth login reads as ready: `pi auth check --no-refresh` does not look at expiry (pi 1.5.2), so expiry shows only when a worker run fails';
const PI_FALLBACK_LIMIT = 'no login is verified: an ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment, or any parseable ~/.pi/agent/models.json, counts as logged in, and an OAuth-only login reads as logged out';

/** The provider ids in `pi --list-models` output: the first column of the rows under the header, which Pi fills only
 * with providers that have usable credentials. Shape-checked, since each reaches a command line; the caller caps them. */
function piListedProviders(listing: string): string[] {
  const lines = listing.split('\n');
  const header = lines.findIndex((line) => /^provider\s+model\b/.test(line));
  if (header === -1) return [];
  const seen: string[] = [];
  for (const line of lines.slice(header + 1)) {
    const name = line.trim().split(/\s+/)[0] ?? '';
    if (PI_PROVIDER.test(name) && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** `unavailable` is "unknown": the probe could not get an answer, and says why in `reason`. Only `not_ready` is a definite no. */
type PiProviderCheck = { provider: string; status: 'ready' | 'not_ready' | 'invalid' | 'unavailable'; authType?: 'oauth' | 'api_key'; reason?: string };

/** One `pi auth check --provider <name> --json --no-refresh`: the exit code is the verdict, the JSON only names the auth type. */
async function piCheckProvider(binary: string, provider: string, options: ProbeOptions): Promise<PiProviderCheck> {
  const res = await executeCommand(binary, ['auth', 'check', '--provider', provider, '--json', '--no-refresh'], options);
  if (res.ok) {
    let authType: 'oauth' | 'api_key' | undefined;
    try {
      const parsed = JSON.parse(res.stdout);
      if (parsed?.authType === 'oauth' || parsed?.authType === 'api_key') authType = parsed.authType;
    } catch { /* the exit code stands */ }
    return { provider, status: 'ready', ...(authType ? { authType } : {}) };
  }
  // An answer the probe could not get is unknown, never logged out: a timeout, a signal or a missing exit code is no exit 1.
  if (res.killed) return { provider, status: 'unavailable', reason: 'check timed out or was killed' };
  if (res.signal) return { provider, status: 'unavailable', reason: `check ended by signal ${res.signal}` };
  if (!res.exited) return { provider, status: 'unavailable', reason: 'check ended with no exit code' };
  if (res.code === 1 || res.code === 2) {
    let reason: unknown;
    try { reason = JSON.parse(res.stdout)?.reason; } catch { /* the exit code stands */ }
    // Pi's auth command loads no extensions, so a provider an extension defines is listed yet not found there.
    if (reason === 'provider_not_found') return { provider, status: 'unavailable', reason: 'provider_not_found' };
    return { provider, status: res.code === 1 ? 'not_ready' : 'invalid' };
  }
  return { provider, status: 'unavailable', reason: `check exited with ${String(res.code)}` };
}

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
      offeredModels: [],
      lastSyncedAt: new Date().toISOString(),
    };
  }

  const installed = true;
  const version = ver.ok ? parseVersion(ver.stdout) : null;

  // Pi's own check, when `pi auth --help` shows it. DoFlow never opens ~/.pi/agent/auth.json: Pi reads it, and only
  // the exit code and the auth type come back. `pi auth check` needs a provider, so the providers are the ones
  // `pi --list-models --offline` shows, which lists only providers with usable credentials.
  const help = await executeCommand(binary, ['auth', '--help'], options);
  if (help.ok && PI_CHECK_SHOWN.test(help.stdout)) {
    const listing = await executeCommand(binary, ['--list-models', '--offline'], options);
    const providers: PiProviderCheck[] = [];
    const listed = listing.ok ? piListedProviders(listing.stdout) : [];
    for (const name of listed.slice(0, PI_PROVIDERS_MAX)) providers.push(await piCheckProvider(binary, name, options));
    const complete = providers.length === listed.length;
    const ready = providers.filter((p) => p.status === 'ready');
    const authTypes = new Set(ready.map((p) => p.authType ?? 'unknown'));
    // Logged out only when every listed provider was checked and every one answered a definite not ready.
    const loginState: LoginState = ready.length > 0 ? 'logged-in'
      : !listing.ok || !complete || providers.some((p) => p.status !== 'not_ready') ? 'error'
        : 'logged-out';
    // OAuth is a subscription login whose billing Pi does not say (an Anthropic one can bill as extra usage); a key is metered.
    // With providers left unchecked the mix is unknown, so mode and billing stay unknown.
    const onlyType = complete && authTypes.size === 1 ? [...authTypes][0] : null;
    const detectedMode: DetectedMode = onlyType === 'oauth' ? 'subscription' : onlyType === 'api_key' ? 'api-key' : 'unverified';
    const derivedBilling: DerivedBilling = onlyType === 'api_key' ? 'metered' : 'unknown';
    const result: SyncHarnessResult & { loginCheck: unknown } = {
      harnessId: 'pi',
      binary,
      installed,
      version,
      loginState,
      reloginHint: loginState === 'logged-in' ? null : reloginHint,
      detectedMode,
      derivedBilling,
      offeredModels: [],
      lastSyncedAt: new Date().toISOString(),
      loginCheck: {
        method: 'pi-auth-check',
        providers,
        checked: providers.length,
        listed: listed.length,
        ...(complete ? {} : { note: `checked ${providers.length} of ${listed.length} listed providers; mode and billing are unknown` }),
        limit: PI_CHECK_LIMIT,
      },
    };
    return result;
  }

  const piModelsJson = path.join(home, '.pi', 'agent', 'models.json');
  let hasKey = Boolean(env.ANTHROPIC_API_KEY || env.OPENAI_API_KEY);

  try {
    if (fsImpl.existsSync(piModelsJson)) {
      const data = JSON.parse(fsImpl.readFileSync(piModelsJson, 'utf8'));
      if (data && typeof data === 'object') {
        hasKey = true;
      }
    }
  } catch {
    // ignore
  }

  const loginCheck = {
    method: 'fallback',
    reason: help.ok ? '`pi auth --help` does not show the check command' : '`pi auth --help` could not be read',
    limit: PI_FALLBACK_LIMIT,
  };

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
      offeredModels: [],
      lastSyncedAt: new Date().toISOString(),
      loginCheck,
    } as SyncHarnessResult;
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
    offeredModels: [],
    lastSyncedAt: new Date().toISOString(),
    loginCheck,
  } as SyncHarnessResult;
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
      offeredModels: [],
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
      offeredModels: [],
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
    offeredModels: [],
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
      offeredModels: [],
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
      offeredModels: [],
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
      offeredModels: [],
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
    offeredModels: [],
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
      offeredModels: [],
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
      offeredModels: [],
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
      offeredModels: [],
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
    offeredModels: [],
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
