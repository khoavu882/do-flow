'use strict';

// Hook tiers (maint-hooks): content goes to every harness; DoFlow's hooks, gates and bridge go only
// to the harnesses `hooks.harnesses` names, and a harness taken out of the list loses the hooks an
// earlier run wrote while its content stays. Every CLI cell runs in a scratch HOME and project.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { tieredRegistry, hooksTieredOff, hookHoldersFromLedger, TIER_REASON } = require('../../src/lifecycle/hook-tier.ts');

const ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(ROOT, 'bin', 'doflow.js');
const TARGETS = 'claude,codex,kiro,pi';

test('tieredRegistry switches hooks off only for harnesses outside the list, and no list changes nothing', () => {
  const registry = loadRegistry({ repoRoot: ROOT });
  assert.equal(tieredRegistry(registry, undefined), registry);
  const tiered = tieredRegistry(registry, ['claude']);
  const byId = (id: string) => tiered.harnesses.find((harness: any) => harness.id === id);
  assert.equal(hooksTieredOff(byId('claude')), false);
  assert.equal(byId('claude').capabilities.hooks.status, registry.harnesses.find((h: any) => h.id === 'claude').capabilities.hooks.status);
  assert.equal(hooksTieredOff(byId('codex')), true);
  assert.deepEqual([byId('codex').capabilities.hooks.status, byId('codex').capabilities.hooks.reason], ['unavailable', TIER_REASON]);
  assert.equal(hooksTieredOff(byId('opencode')), false, 'a harness without hooks is left as it is');
});

test('a removal takes the hooks the ledger records: a harness with no hook rows holds none', () => {
  const registry = loadRegistry({ repoRoot: ROOT });
  const ledger = { resources: [
    { harness: 'claude', assetId: 'hooks.shared', target: '/x/.doflow/shared/hooks/bridge/bridge.sh' },
    { harness: 'pi', assetId: 'skills.do', target: '/x/.pi/skills/do/SKILL.md' },
  ] };
  assert.deepEqual(hookHoldersFromLedger(registry, ledger), ['claude']);
});

function cell(t: any) {
  const scratch = createScratch('doflow-hook-tier-');
  t.after(() => scratch.remove());
  const proj = path.join(scratch.dir, 'proj');
  fs.mkdirSync(proj);
  const settings = path.join(scratch.xdg, 'doflow', 'settings.json');
  const runRaw = (args: string[]) => spawnSync(process.execPath, [CLI, ...args], { cwd: scratch.dir, env: scratch.env({ DOFLOW_FAILURE_CAPTURE: 'off' }), input: 'y\n', encoding: 'utf8' });
  const run = (args: string[]) => {
    const done = spawnSync(process.execPath, [CLI, ...args], { cwd: scratch.dir, env: scratch.env({ DOFLOW_FAILURE_CAPTURE: 'off' }), input: 'y\n', encoding: 'utf8' });
    assert.equal(done.status, 0, `${args.join(' ')}\n${done.stdout}\n${done.stderr}`);
    return `${done.stdout}\n${done.stderr}`;
  };
  const setTier = (ids: string[], extra: any = {}) => fs.writeFileSync(settings, JSON.stringify({ schema: 1, 'hooks.harnesses': ids, ...extra }));
  const at = (...parts: string[]) => path.join(proj, ...parts);
  const hooksOf = () => ({
    claude: fs.existsSync(at('.claude', 'hooks')) || 'hooks' in JSON.parse(fs.readFileSync(at('.claude', 'settings.json'), 'utf8')),
    codex: fs.existsSync(at('.codex', 'hooks.json')),
    kiro: fs.readdirSync(at('.kiro', 'agents')).filter((name: string) => name.endsWith('.json'))
      .some((name: string) => 'hooks' in JSON.parse(fs.readFileSync(at('.kiro', 'agents', name), 'utf8'))),
    pi: fs.existsSync(at('.pi', 'extensions', 'doflow-guard.js')),
    tree: fs.existsSync(at('.doflow', 'shared', 'hooks')),
  });
  return { run, runRaw, setTier, at, hooksOf };
}

test('CLI: the default tier hooks claude, codex and pi, not kiro; dropping every harness removes the hooks and keeps the content', { timeout: 300000 }, (t) => {
  const { run, setTier, at, hooksOf } = cell(t);
  run(['install', 'proj', '-f', '--no-backup', '-t', TARGETS]);
  assert.deepEqual(hooksOf(), { claude: true, codex: true, kiro: false, pi: true, tree: true });

  setTier(['claude', 'codex', 'kiro', 'pi']);
  run(['update', 'proj', '-f', '-t', TARGETS]);
  assert.deepEqual(hooksOf(), { claude: true, codex: true, kiro: true, pi: true, tree: true });

  setTier([]);
  const out = run(['update', 'proj', '-f', '-t', TARGETS]);
  assert.match(out, /\[WARN\] claude is the primary session but not in hooks\.harnesses/, 'leaving claude out warns');
  for (const id of TARGETS.split(',')) assert.match(out, new RegExp(`removing ${id} hooks: not in hooks\\.harnesses \\(content stays\\)`));
  assert.deepEqual(hooksOf(), { claude: false, codex: false, kiro: false, pi: false, tree: false });
  assert.ok(fs.existsSync(at('.claude', 'settings.json')) && fs.existsSync(at('.kiro', 'agents')), 'content stays');
  assert.match(run(['update', 'proj', '-f', '-t', TARGETS]), /Already up to date/, 'a second update plans nothing');

  run(['remove', 'proj', '-f', '-t', TARGETS]);
  assert.equal(fs.existsSync(at('.doflow', 'shared', 'hooks')), false);
});

// R-2: every current holder leaves the tier while a newcomer joins in the same update. The shared
// hooks tree the newcomer writes must survive the holders' releases, and one update must settle.
test('CLI: the tier moves from claude, codex and antigravity to kiro in one update; the shared tree stays and the next plan is empty', { timeout: 300000 }, (t) => {
  const { run, runRaw, setTier, at } = cell(t);
  const targets = 'claude,codex,kiro,antigravity';
  run(['install', 'proj', '-f', '--no-backup', '-t', targets]);
  assert.ok(fs.existsSync(at('.agents', 'hooks.json')) && !fs.existsSync(at('.kiro', 'hooks')));

  setTier(['kiro'], { 'workers.enabled': ['codex', 'primary'] });
  const out = run(['update', 'proj', '-f', '-t', targets]);
  assert.match(out, /\[WARN\] codex is a worker in workers\.enabled but not in hooks\.harnesses/);
  assert.ok(fs.existsSync(at('.doflow', 'shared', 'hooks', 'bridge', 'bridge.sh')), 'the shared tree kiro now holds is not deleted');
  assert.ok(fs.existsSync(at('.kiro', 'hooks', 'pre-bash-guard.sh')));
  for (const gone of [['.agents', 'hooks.json'], ['.claude', 'hooks'], ['.codex', 'hooks.json']]) assert.equal(fs.existsSync(at(...gone)), false, gone.join('/'));

  const dry = runRaw(['update', 'proj', '--dry-run', '-t', targets]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Already up to date — no changes detected/, dry.stdout);
  const status = runRaw(['status', 'proj']);
  assert.match(status.stdout, /Registry lifecycle:\s+0 pending, 0 conflict\(s\)/, status.stdout);
});
