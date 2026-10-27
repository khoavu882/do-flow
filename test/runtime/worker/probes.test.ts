'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
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
} = require('../../../src/runtime/worker/probes/index.ts');

const { suiteTempDir } = require('../../helper/tmp.ts');

function createTempDir(prefix: string): string {
  return suiteTempDir(`doflow-test-probes-${prefix}-`);
}

test('Slice B: probe timeouts and binary mappings', () => {
  assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 3000);
  assert.equal(Object.keys(PROBES).length, 7);
  assert.equal(RELOGIN_HINTS.claude, 'claude login');
  assert.equal(RELOGIN_HINTS.codex, 'codex login');
  assert.equal(RELOGIN_HINTS.opencode, 'opencode auth login <provider>');
  assert.equal(RELOGIN_HINTS.pi, 'pi');
  assert.equal(RELOGIN_HINTS.copilot, 'copilot login');
  assert.equal(RELOGIN_HINTS.kiro, 'kiro-cli login');
  assert.equal(RELOGIN_HINTS.antigravity, 'agy');

  assert.equal(HARNESS_BINARIES.kiro, 'kiro-cli');
  assert.equal(HARNESS_BINARIES.antigravity, 'agy');
});

test('Slice B: claude probe runner', async () => {
  const tmpHome = createTempDir('claude');
  try {
    // 1. Uninstalled
    const notInstalledExec = (bin: string, args: string[], opts: any, cb: any) => {
      const err: any = new Error('spawn ENOENT');
      err.code = 'ENOENT';
      cb(err, '', '');
    };
    const res1 = await probeClaude({ execFileImpl: notInstalledExec, homeDir: tmpHome });
    assert.equal(res1.installed, false);
    assert.equal(res1.loginState, 'logged-out');
    assert.equal(res1.reloginHint, 'claude login');
    assert.equal(res1.detectedMode, 'unverified');
    assert.equal(res1.derivedBilling, 'unknown');

    // 2. Installed with API Key
    const installedExec = (bin: string, args: string[], opts: any, cb: any) => {
      assert.equal(opts.timeout, 3000);
      cb(null, 'claude 1.2.3\n', '');
    };
    const res2 = await probeClaude({
      execFileImpl: installedExec,
      env: { ANTHROPIC_API_KEY: 'sk-ant-test' },
      homeDir: tmpHome,
    });
    assert.equal(res2.installed, true);
    assert.equal(res2.version, '1.2.3');
    assert.equal(res2.loginState, 'logged-in');
    assert.equal(res2.reloginHint, null);
    assert.equal(res2.detectedMode, 'api-key');
    assert.equal(res2.derivedBilling, 'metered');

    // 3. Installed with OAuth session in ~/.claude.json
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ oauthAccount: 'user@example.com' }));
    const res3 = await probeClaude({
      execFileImpl: installedExec,
      env: {},
      homeDir: tmpHome,
    });
    assert.equal(res3.installed, true);
    assert.equal(res3.loginState, 'logged-in');
    assert.equal(res3.reloginHint, null);
    assert.equal(res3.detectedMode, 'subscription');
    assert.equal(res3.derivedBilling, 'free');

    // 4. Installed but logged out (no key, empty config)
    fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({}));
    const res4 = await probeClaude({
      execFileImpl: installedExec,
      env: {},
      homeDir: tmpHome,
    });
    assert.equal(res4.installed, true);
    assert.equal(res4.loginState, 'logged-out');
    assert.equal(res4.reloginHint, 'claude login');
    assert.equal(res4.detectedMode, 'unverified');
    assert.equal(res4.derivedBilling, 'unknown');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Slice B: codex probe runner', async () => {
  const tmpHome = createTempDir('codex');
  try {
    // 1. Uninstalled
    const notInstalledExec = (bin: string, args: string[], opts: any, cb: any) => {
      const err: any = new Error('spawn ENOENT');
      err.code = 'ENOENT';
      cb(err, '', '');
    };
    const res1 = await probeCodex({ execFileImpl: notInstalledExec, homeDir: tmpHome });
    assert.equal(res1.installed, false);
    assert.equal(res1.loginState, 'logged-out');
    assert.equal(res1.reloginHint, 'codex login');

    // 2. Installed, login status failure
    const loggedOutExec = (bin: string, args: string[], opts: any, cb: any) => {
      if (args.includes('--version')) return cb(null, 'codex 0.9.0\n', '');
      const err: any = new Error('not logged in');
      err.code = 1;
      cb(err, '', 'Authentication required');
    };
    const res2 = await probeCodex({ execFileImpl: loggedOutExec, homeDir: tmpHome });
    assert.equal(res2.installed, true);
    assert.equal(res2.loginState, 'logged-out');
    assert.equal(res2.reloginHint, 'codex login');

    // 3. Installed, login status ok with ChatGPT subscription
    const loggedInExec = (bin: string, args: string[], opts: any, cb: any) => {
      if (args.includes('--version')) return cb(null, 'codex 0.9.0\n', '');
      cb(null, 'Logged in with chatgpt account\n', '');
    };
    const res3 = await probeCodex({ execFileImpl: loggedInExec, homeDir: tmpHome, env: {} });
    assert.equal(res3.installed, true);
    assert.equal(res3.loginState, 'logged-in');
    assert.equal(res3.reloginHint, null);
    assert.equal(res3.detectedMode, 'subscription');
    assert.equal(res3.derivedBilling, 'free');

    // 4. Installed, API key mode
    const res4 = await probeCodex({
      execFileImpl: loggedInExec,
      homeDir: tmpHome,
      env: { OPENAI_API_KEY: 'sk-test' },
    });
    assert.equal(res4.installed, true);
    assert.equal(res4.loginState, 'logged-in');
    assert.equal(res4.detectedMode, 'api-key');
    assert.equal(res4.derivedBilling, 'metered');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('Slice B: opencode probe runner', async () => {
  // 1. OAuth subscription mode
  const oauthExec = (bin: string, args: string[], opts: any, cb: any) => {
    if (args.includes('--version')) return cb(null, 'opencode 1.1.0\n', '');
    cb(null, JSON.stringify([{ provider: 'anthropic', type: 'oauth' }]), '');
  };
  const res1 = await probeOpencode({ execFileImpl: oauthExec });
  assert.equal(res1.installed, true);
  assert.equal(res1.loginState, 'logged-in');
  assert.equal(res1.detectedMode, 'subscription');
  assert.equal(res1.derivedBilling, 'free');

  // 2. API Key mode
  const keyExec = (bin: string, args: string[], opts: any, cb: any) => {
    if (args.includes('--version')) return cb(null, 'opencode 1.1.0\n', '');
    cb(null, JSON.stringify([{ provider: 'openai', type: 'key' }]), '');
  };
  const res2 = await probeOpencode({ execFileImpl: keyExec });
  assert.equal(res2.installed, true);
  assert.equal(res2.loginState, 'logged-in');
  assert.equal(res2.detectedMode, 'api-key');
  assert.equal(res2.derivedBilling, 'metered');

  // 3. Logged out (empty auth list)
  const emptyExec = (bin: string, args: string[], opts: any, cb: any) => {
    if (args.includes('--version')) return cb(null, 'opencode 1.1.0\n', '');
    cb(null, '[]', '');
  };
  const res3 = await probeOpencode({ execFileImpl: emptyExec });
  assert.equal(res3.installed, true);
  assert.equal(res3.loginState, 'logged-out');
  assert.equal(res3.reloginHint, 'opencode auth login <provider>');
});

test('Slice B: pi, copilot, kiro, antigravity probe runners', async () => {
  const tmpHome = createTempDir('others');
  try {
    const installedExec = (bin: string, args: string[], opts: any, cb: any) => {
      cb(null, `${bin} 1.0.0\n`, '');
    };

    // pi with API key
    const piRes = await probePi({
      execFileImpl: installedExec,
      homeDir: tmpHome,
      env: { ANTHROPIC_API_KEY: 'pi-key' },
    });
    assert.equal(piRes.installed, true);
    assert.equal(piRes.loginState, 'logged-in');
    assert.equal(piRes.detectedMode, 'api-key');
    assert.equal(piRes.derivedBilling, 'metered');

    // copilot with token
    const copilotRes = await probeCopilot({
      execFileImpl: installedExec,
      env: { GITHUB_TOKEN: 'ghp_test' },
    });
    assert.equal(copilotRes.installed, true);
    assert.equal(copilotRes.loginState, 'logged-in');
    assert.equal(copilotRes.detectedMode, 'subscription');
    assert.equal(copilotRes.derivedBilling, 'free');

    // kiro with AWS IDC token cache
    const kiroDir = path.join(tmpHome, '.kiro');
    fs.mkdirSync(kiroDir, { recursive: true });
    fs.writeFileSync(path.join(kiroDir, 'credentials'), 'token');
    const kiroRes = await probeKiro({
      execFileImpl: installedExec,
      homeDir: tmpHome,
      env: {},
    });
    assert.equal(kiroRes.installed, true);
    assert.equal(kiroRes.loginState, 'logged-in');
    assert.equal(kiroRes.detectedMode, 'subscription');
    assert.equal(kiroRes.derivedBilling, 'free');

    // antigravity with ADC
    const agyRes = await probeAntigravity({
      execFileImpl: installedExec,
      homeDir: tmpHome,
      env: { AGY_ADC_AUTH: 'true' },
    });
    assert.equal(agyRes.installed, true);
    assert.equal(agyRes.loginState, 'logged-in');
    assert.equal(agyRes.detectedMode, 'api-key');
    assert.equal(agyRes.derivedBilling, 'metered');
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
