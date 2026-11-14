'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeToolState, planToolLifecycle, executeToolLifecycle, chooseInstallRoute, plainCommand,
} = require('../../src/install/tool-lifecycle.ts') as any;

const registry = {
  externalTools: [
    { id: 'rtk', officialEvidence: ['https://example.test/rtk'], status: { commands: [['rtk', '--version'], ['rtk', 'gain']] }, install: { command: ['cargo', 'install', 'rtk'] }, uninstall: { command: ['cargo', 'uninstall', 'rtk'] } },
    { id: 'graphify', officialEvidence: ['https://example.test/graphify'], prerequisites: ['uv'], status: { commands: [['graphify', '--version']] }, install: { command: ['uv', 'tool', 'install', 'graphifyy'] }, update: { command: ['uv', 'tool', 'upgrade', 'graphifyy'] }, uninstall: { command: ['uv', 'tool', 'uninstall', 'graphifyy'] } },
  ],
};

function absent(command: any) { const error: any = new Error(`${command} missing`); error.code = 'ENOENT'; return error; }
function fakeExec(outcomes: any, calls: any[] = []) {
  return (command: any, args: any) => {
    const vector: any = [command, ...args];
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

  const calls: any[] = [];
  const plan = planToolLifecycle({ registry, action: 'status', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', 'rtk 1'], ['rtk gain', absent('rtk gain')], ['graphify --version', absent('graphify')], ['uv --version', 'uv 1'],
  ]), calls) });
  assert.equal(plan.tools[0].state, 'unknown');
  assert.deepEqual(calls, [['rtk', '--version'], ['rtk', 'gain'], ['graphify', '--version'], ['uv', '--version']]);
});

test('missing uv blocks Graphify mutation without attempting to install a prerequisite', () => {
  const calls: any[] = [];
  const plan = planToolLifecycle({ registry, action: 'install', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', absent('rtk')], ['rtk gain', absent('rtk')], ['graphify --version', absent('graphify')], ['uv --version', absent('uv')],
  ]), calls) });
  const graphify = plan.tools[1];
  assert.match(graphify.action.reason, /missing installer: needs uv on PATH; see https:\/\/example.test\/graphify/);
  assert.ok(!calls.some((vector) => vector.join(' ') === 'uv tool install graphifyy'));
});

test('each executable command is displayed and confirmed separately; declined commands are not executed', () => {
  const plan = planToolLifecycle({ registry, action: 'install', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', absent('rtk')], ['rtk gain', absent('rtk')], ['graphify --version', absent('graphify')], ['uv --version', 'uv 1'],
  ])) });
  const shown: any = [];
  const executed: any[] = [];
  const result = executeToolLifecycle({ plan, displayCommand: (command: any) => shown.push(command), confirmCommand: (command: any) => command[0] !== 'cargo', execFileSyncImpl: fakeExec(new Map(), executed) });
  assert.deepEqual(result.notAttempted.map((item: any) => item.status), ['not-attempted', 'not-attempted']);
  assert.deepEqual(shown, [['cargo', 'install', 'rtk'], ['uv', 'tool', 'install', 'graphifyy']]);
  assert.deepEqual(result.results.map((item: any) => item.status), ['declined', 'succeeded']);
  assert.deepEqual(executed, [['uv', 'tool', 'install', 'graphifyy']]);
});

test('a failed command does not prevent independently confirmed commands from running', () => {
  const plan = planToolLifecycle({ registry, action: 'uninstall', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', 'rtk 1'], ['rtk gain', 'gain'], ['graphify --version', 'graphify 1'], ['uv --version', 'uv 1'],
  ])) });
  const result = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map<string, any>([
    ['cargo uninstall rtk', new Error('cargo failed')], ['uv tool uninstall graphifyy', 'removed'],
  ])) });
  assert.deepEqual(result.results.map((item: any) => item.status), ['failed', 'succeeded']);
});

test('unsupported platforms run no inspection or action commands', () => {
  let calls = 0;
  const plan = planToolLifecycle({ registry, action: 'install', platform: 'win32', execFileSyncImpl: () => { calls += 1; } });
  assert.equal(plan.supported, false);
  assert.equal(calls, 0);
  const result = executeToolLifecycle({ plan, displayCommand() { calls += 1; }, confirmCommand: () => true, execFileSyncImpl: () => { calls += 1; } });
  assert.deepEqual(result.results.map((item: any) => item.status), ['skipped', 'skipped']);
  assert.equal(calls, 0);
});

test('RTK update is skipped because no verified update command is registered', () => {
  const plan = planToolLifecycle({ registry, action: 'update', platform: 'darwin', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', 'rtk 1'], ['rtk gain', 'gain'], ['graphify --version', 'graphify 1'], ['uv --version', 'uv 1'],
  ])) });
  assert.equal(plan.tools[0].action.applicable, false);
  assert.match(plan.tools[0].action.reason, /no verified update command/);
});

// A tool with several routes and a step after the install, in the shape agent-browser has.
const browser = {
  id: 'browser', officialEvidence: ['https://example.test/browser', 'https://example.test/browser-brew'], status: { commands: [['browser', '--version']] },
  install: {
    routes: [
      { installer: 'brew', command: ['brew', 'install', 'browser'], platforms: ['darwin'], after: [['browser', 'install']], evidence: 'https://example.test/browser-brew' },
      { installer: 'npm', command: ['npm', 'install', '-g', 'browser'], after: [['browser', 'install']], evidence: 'https://example.test/browser' },
      { installer: 'apt-get', command: ['sudo', 'apt-get', 'install', 'browser'], platforms: ['linux'], privileged: true, evidence: 'https://example.test/browser' },
    ],
  },
};
const onPath = (...names: string[]) => (name: string) => names.includes(name);

test('the first route whose installer is on PATH wins; a route for another platform is skipped', () => {
  assert.deepEqual(chooseInstallRoute(browser, { platform: 'darwin', isInstalled: onPath('brew', 'npm') }).route.command, ['brew', 'install', 'browser']);
  assert.deepEqual(chooseInstallRoute(browser, { platform: 'darwin', isInstalled: onPath('npm') }).route.command, ['npm', 'install', '-g', 'browser']);
  assert.deepEqual(chooseInstallRoute(browser, { platform: 'linux', isInstalled: onPath('brew', 'npm') }).route.command, ['npm', 'install', '-g', 'browser']);
});

test('a tool whose every route needs a missing installer says so and names the documentation URL', () => {
  const chosen = chooseInstallRoute(browser, { platform: 'darwin', isInstalled: onPath() });
  assert.equal(chosen.route, undefined);
  assert.equal(chosen.reason, 'missing installer: needs brew, npm on PATH; see https://example.test/browser');
});

test('a tool with no install route for this platform names the documentation URL instead of a command', () => {
  const noInstall = { id: 'bash', officialEvidence: ['https://example.test/bash'], status: { commands: [['bash', '--version']] } };
  assert.equal(chooseInstallRoute(noInstall, { platform: 'linux', isInstalled: onPath('brew') }).reason, 'no verified install command is registered for linux; see https://example.test/bash');
  const darwinOnly = { ...noInstall, install: { routes: [{ installer: 'brew', command: ['brew', 'install', 'x'], platforms: ['darwin'], evidence: 'https://example.test/bash' }] } };
  assert.match(chooseInstallRoute(darwinOnly, { platform: 'linux', isInstalled: onPath('brew') }).reason, /no verified install command is registered for linux/);
});

test('a privileged route is offered as a command but never planned for execution', () => {
  const plan = planToolLifecycle({ registry: { externalTools: [browser] }, action: 'install', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['browser --version', absent('browser')], ['brew --version', absent('brew')], ['npm --version', absent('npm')], ['apt-get --version', 'apt 1'],
  ])) });
  assert.equal(plan.tools[0].install.route.privileged, true);
  assert.equal(plan.tools[0].action.applicable, false);
  assert.match(plan.tools[0].action.reason, /needs administrator rights.*run it yourself: sudo apt-get install browser/);
});

test('a present tool probes no installer; an absent one probes each installer once', () => {
  const calls: any[] = [];
  const present = planToolLifecycle({ registry: { externalTools: [browser] }, platform: 'darwin', execFileSyncImpl: fakeExec(new Map([['browser --version', 'b 1']]), calls) });
  assert.equal(present.tools[0].install, null);
  assert.deepEqual(calls, [['browser', '--version']]);
  const absentCalls: any[] = [];
  planToolLifecycle({ registry: { externalTools: [browser, { ...browser, id: 'browser2' }] }, platform: 'darwin', execFileSyncImpl: fakeExec(new Map([
    ['browser --version', absent('browser')], ['brew --version', absent('brew')], ['npm --version', 'npm 1'],
  ]), absentCalls) });
  assert.equal(absentCalls.filter((vector) => vector[0] === 'npm').length, 1);
});

test('the step after an install is shown and confirmed on its own, and only after the install succeeded', () => {
  const plan = planToolLifecycle({ registry: { externalTools: [browser] }, action: 'install', platform: 'darwin', execFileSyncImpl: fakeExec(new Map([
    ['browser --version', absent('browser')], ['brew --version', 'brew 1'],
  ])) });
  assert.deepEqual(plan.tools[0].action.followUps, [['browser', 'install']]);
  const asked: any[] = [];
  const executed: any[] = [];
  const done = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: (command: any) => { asked.push(command); return true; }, execFileSyncImpl: fakeExec(new Map(), executed) });
  assert.deepEqual(asked, [['brew', 'install', 'browser'], ['browser', 'install']]);
  assert.deepEqual(executed, asked);
  assert.deepEqual(done.results[0].followUps.map((step: any) => step.status), ['succeeded']);

  const declined = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: (command: any) => command[0] === 'brew', execFileSyncImpl: fakeExec(new Map()) });
  assert.equal(declined.results[0].status, 'succeeded');
  assert.deepEqual(declined.results[0].followUps.map((step: any) => step.status), ['declined']);

  const failedInstall: any[] = [];
  const failed = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map<string, any>([['brew install browser', new Error('brew failed')]]), failedInstall) });
  assert.equal(failed.results[0].status, 'failed');
  assert.equal(failed.results[0].followUps, undefined);
  assert.deepEqual(failedInstall, [['brew', 'install', 'browser']]);
});

test('plainCommand quotes only the parts that need it', () => {
  assert.equal(plainCommand(['brew', 'install', '--cask', 'drawio']), 'brew install --cask drawio');
  assert.equal(plainCommand(['sh', '-c', 'a b']), 'sh -c "a b"');
});
