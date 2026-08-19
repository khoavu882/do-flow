'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeToolState, planToolLifecycle, executeToolLifecycle,
} = require('../../src/install/tool-lifecycle');

const registry = {
  externalTools: [
    { id: 'rtk', status: { commands: [['rtk', '--version'], ['rtk', 'gain']] }, install: { command: ['cargo', 'install', 'rtk'] }, uninstall: { command: ['cargo', 'uninstall', 'rtk'] } },
    { id: 'graphify', prerequisites: ['uv'], status: { commands: [['graphify', '--version']] }, install: { command: ['uv', 'tool', 'install', 'graphifyy'] }, update: { command: ['uv', 'tool', 'upgrade', 'graphifyy'] }, uninstall: { command: ['uv', 'tool', 'uninstall', 'graphifyy'] } },
  ],
};

function absent(command) { const error = new Error(`${command} missing`); error.code = 'ENOENT'; return error; }
function fakeExec(outcomes, calls = []) {
  return (command, args) => {
    const vector = [command, ...args];
    calls.push(vector);
    const outcome = outcomes.get(vector.join(' '));
    if (outcome instanceof Error) throw outcome;
    return outcome ?? '';
  };
}

test('normalizes status outcomes without shortcutting any status command', () => {
  assert.equal(normalizeToolState([{ result: 'absent' }]), 'absent');
  assert.equal(normalizeToolState([{ result: 'succeeded' }]), 'installed');
  assert.equal(normalizeToolState([{ result: 'succeeded' }, { result: 'absent' }]), 'unknown');
  assert.equal(normalizeToolState([{ result: 'failed' }]), 'inspection-failed');

  const calls = [];
  const plan = planToolLifecycle({ registry, action: 'status', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', 'rtk 1'], ['rtk gain', absent('rtk gain')], ['graphify --version', absent('graphify')], ['uv --version', 'uv 1'],
  ]), calls) });
  assert.equal(plan.tools[0].state, 'unknown');
  assert.deepEqual(calls, [['rtk', '--version'], ['rtk', 'gain'], ['graphify', '--version'], ['uv', '--version']]);
});

test('missing uv blocks Graphify mutation without attempting to install a prerequisite', () => {
  const calls = [];
  const plan = planToolLifecycle({ registry, action: 'install', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', absent('rtk')], ['rtk gain', absent('rtk')], ['graphify --version', absent('graphify')], ['uv --version', absent('uv')],
  ]), calls) });
  const graphify = plan.tools[1];
  assert.match(graphify.action.reason, /missing prerequisite: uv/);
  assert.ok(!calls.some((vector) => vector.join(' ') === 'uv tool install graphifyy'));
});

test('each executable command is displayed and confirmed separately; declined commands are not executed', () => {
  const plan = planToolLifecycle({ registry, action: 'install', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', absent('rtk')], ['rtk gain', absent('rtk')], ['graphify --version', absent('graphify')], ['uv --version', 'uv 1'],
  ])) });
  const shown = [];
  const executed = [];
  const result = executeToolLifecycle({ plan, displayCommand: (command) => shown.push(command), confirmCommand: (command) => command[0] !== 'cargo', execFileSyncImpl: fakeExec(new Map(), executed) });
  assert.deepEqual(result.notAttempted.map((item) => item.status), ['not-attempted', 'not-attempted']);
  assert.deepEqual(shown, [['cargo', 'install', 'rtk'], ['uv', 'tool', 'install', 'graphifyy']]);
  assert.deepEqual(result.results.map((item) => item.status), ['declined', 'succeeded']);
  assert.deepEqual(executed, [['uv', 'tool', 'install', 'graphifyy']]);
});

test('a failed command does not prevent independently confirmed commands from running', () => {
  const plan = planToolLifecycle({ registry, action: 'uninstall', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', 'rtk 1'], ['rtk gain', 'gain'], ['graphify --version', 'graphify 1'], ['uv --version', 'uv 1'],
  ])) });
  const result = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map([
    ['cargo uninstall rtk', new Error('cargo failed')], ['uv tool uninstall graphifyy', 'removed'],
  ])) });
  assert.deepEqual(result.results.map((item) => item.status), ['failed', 'succeeded']);
});

test('unsupported platforms run no inspection or action commands', () => {
  let calls = 0;
  const plan = planToolLifecycle({ registry, action: 'install', platform: 'win32', execFileSyncImpl: () => { calls += 1; } });
  assert.equal(plan.supported, false);
  assert.equal(calls, 0);
  const result = executeToolLifecycle({ plan, displayCommand() { calls += 1; }, confirmCommand: () => true, execFileSyncImpl: () => { calls += 1; } });
  assert.deepEqual(result.results.map((item) => item.status), ['skipped', 'skipped']);
  assert.equal(calls, 0);
});

test('RTK update is skipped because no verified update command is registered', () => {
  const plan = planToolLifecycle({ registry, action: 'update', platform: 'darwin', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', 'rtk 1'], ['rtk gain', 'gain'], ['graphify --version', 'graphify 1'], ['uv --version', 'uv 1'],
  ])) });
  assert.equal(plan.tools[0].action.applicable, false);
  assert.match(plan.tools[0].action.reason, /no verified update command/);
});
