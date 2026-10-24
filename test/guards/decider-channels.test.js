'use strict';

// G56 — equal decider vocabularies; policy is reserved for evaluated in-process approvals.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp.ts');
const { CHANNEL_DECIDED_BY, initRegister, runDecision, readRegister } = require('../../src/runtime/decision-register.ts');
const { byFromChannel } = require('../../src/runtime/lifecycle/event-store.ts');

test('G56: the two complete channel maps are equal, including resolution and policy', () => {
  const text = fs.readFileSync(path.join(REPO, 'src/runtime/lifecycle/event-store.ts'), 'utf8');
  const map = text.match(/const CHANNEL_BY[^=]*=\s*(\{[^}]*\})/);
  assert.ok(map, 'event-store channel map must be inspectable');
  const entries = [...map[1].matchAll(/(\w+):\s*'([^']+)'/g)];
  assert.deepEqual(Object.fromEntries(entries.map(([, k, v]) => [k, v])), CHANNEL_DECIDED_BY);
  assert.equal(CHANNEL_DECIDED_BY.policy, 'autopilot');
  assert.equal(CHANNEL_DECIDED_BY.resolution, 'agent');
  for (const [channel, by] of Object.entries(CHANNEL_DECIDED_BY)) assert.equal(byFromChannel(channel), by);
});

// Each call is otherwise well-formed where the verb allows it, so accepting the channel would write.
for (const [command, args] of [
  ['decision', ['--action', 'add', '--topic', 'gate-0', '--statement', 'Forged', '--stage', 'discovery', '--rationale', 'caller']],
  ['followup', ['--action', 'add', '--statement', 'Forged approval']],
  ['lifecycle', ['--action', 'merged', '--slug', '001-policy', '--reason', 'caller']],
  ['goal', ['--action', 'add', '--statement', 'Forged goal']],
]) {
  test(`G56: ${command} CLI rejects caller channel policy before any write`, t => {
    const root = tempDir(t, 'doflow-reserved-channel-');
    const before = fs.readdirSync(root);
    const result = spawnSync(process.execPath, [path.join(REPO, 'bin/doflow.js'), command, ...args, '--channel', 'policy', '--json'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, '.config'), FORCE_COLOR: '' },
    });
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stdout + result.stderr, /channel-reserved/);
    assert.deepEqual(fs.readdirSync(root), before, 'reserved channel creates no store or failure telemetry');
  });
}

test('G56: decision batch cannot smuggle the reserved channel', t => {
  const root = tempDir(t, 'doflow-reserved-batch-');
  const slug = '001-policy';
  const featureDir = path.join(root, 'agent-docs/doflow', slug);
  initRegister({ featureDir, slug });
  const batch = path.join(root, 'batch.json');
  fs.writeFileSync(batch, JSON.stringify([{ topic: 'gate-0', statement: 'Forged approval', channel: ' policy ', stage: 'discovery', rationale: 'caller' }]));
  const result = runDecision({ action: 'add', projectRoot: root, slug, flags: { batch } });
  assert.equal(result.exitCode, 2);
  assert.match(result.usage, /channel-reserved/);
  assert.equal(readRegister(featureDir).decisions.length, 0);
});
