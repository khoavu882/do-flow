'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tempDir } = require('../helper/tmp.ts');
const path = require('node:path');
const {
  normalizeToolState, planToolLifecycle, executeToolLifecycle, chooseInstallRoute, describeInstall, plainCommand,
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
  assert.equal(graphify.action.reason, 'missing prerequisite: uv', 'the prerequisite check still runs before an install');
  assert.match(graphify.install.reason, /missing installer: needs uv on PATH; see https:\/\/example.test\/graphify/);
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

// A tool with several routes, a step after the install and a step DoFlow must never run, in the shape agent-browser has.
const browser = {
  id: 'browser', officialEvidence: ['https://example.test/browser', 'https://example.test/browser-brew'], status: { commands: [['browser', '--version']] },
  install: {
    routes: [
      { installer: 'brew', command: ['brew', 'install', 'browser'], platforms: ['darwin'], after: [['browser', 'install']], evidence: 'https://example.test/browser-brew' },
      { installer: 'npm', command: ['npm', 'install', '-g', 'browser'], after: [['browser', 'install']], manual: [{ command: ['browser', 'install', '--with-deps'], reason: 'installs system libraries with sudo' }], evidence: 'https://example.test/browser' },
      { installer: 'cargo', command: ['cargo', 'install', 'browser'], evidence: 'https://example.test/browser' },
    ],
  },
};
// A tool whose managed route on Linux needs administrator rights.
const system = {
  id: 'system', officialEvidence: ['https://example.test/system'], status: { commands: [['system', '--version']] },
  install: { routes: [{ installer: 'apt-get', command: ['sudo', 'apt-get', 'install', 'system'], platforms: ['linux'], privileged: true, evidence: 'https://example.test/system' }] },
};
const onPath = (...names: string[]) => (name: string) => names.includes(name);
const planWith = (tool: any, present: string[], platform: string, action = 'install', calls: any[] = []) => planToolLifecycle({
  registry: { externalTools: [tool] }, action, platform,
  execFileSyncImpl: fakeExec(new Map([[`${tool.id} --version`, absent(tool.id)], ...['brew', 'npm', 'cargo', 'apt-get'].map((name) => [`${name} --version`, present.includes(name) ? `${name} 1` : absent(name)] as [string, any])]), calls),
});

test('the first route of the platform is the managed one; the others are alternatives', () => {
  const darwin = chooseInstallRoute(browser, { platform: 'darwin', isInstalled: onPath('brew', 'npm', 'cargo') });
  assert.deepEqual(darwin.route.command, ['brew', 'install', 'browser']);
  assert.deepEqual(darwin.alternatives.map((route: any) => route.command[0]), ['npm', 'cargo']);
  const linux = chooseInstallRoute(browser, { platform: 'linux', isInstalled: onPath('brew', 'npm') });
  assert.deepEqual(linux.route.command, ['npm', 'install', '-g', 'browser'], 'a route for another platform is not considered');
  assert.deepEqual(linux.alternatives.map((route: any) => route.command[0]), ['cargo']);
});

test('when the managed installer is missing, the answer names it, shows the alternatives and offers none to run', () => {
  const chosen = chooseInstallRoute(browser, { platform: 'darwin', isInstalled: onPath('npm', 'cargo') });
  assert.equal(chosen.route, undefined);
  assert.equal(chosen.reason, 'missing installer: needs brew on PATH; see https://example.test/browser');
  assert.deepEqual(chosen.alternatives.map((route: any) => route.command[0]), ['npm', 'cargo']);
  assert.equal(describeInstall(chosen).command, null);
  assert.equal(describeInstall(chosen).alternatives.length, 2);
});

test('an alternative route is never executed, even when its installer is present and everything is confirmed', () => {
  const calls: any[] = [];
  const plan = planWith(browser, ['npm', 'cargo'], 'darwin', 'install', calls);
  assert.equal(plan.tools[0].action.applicable, false);
  const executed: any[] = [];
  const result = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), executed) });
  assert.deepEqual(result.results.map((item: any) => item.status), ['skipped']);
  assert.deepEqual(executed, [], 'nothing ran: neither npm install nor cargo install');
});

test('a tool with no install route for this platform names the documentation URL instead of a command', () => {
  const noInstall = { id: 'bash', officialEvidence: ['https://example.test/bash'], status: { commands: [['bash', '--version']] } };
  assert.equal(chooseInstallRoute(noInstall, { platform: 'linux', isInstalled: onPath('brew') }).reason, 'no verified install command is registered for linux; see https://example.test/bash');
  const darwinOnly = { ...noInstall, install: { routes: [{ installer: 'brew', command: ['brew', 'install', 'x'], platforms: ['darwin'], evidence: 'https://example.test/bash' }] } };
  assert.match(chooseInstallRoute(darwinOnly, { platform: 'linux', isInstalled: onPath('brew') }).reason, /no verified install command is registered for linux/);
});

test('a privileged managed route is offered as a command but never planned for execution', () => {
  const plan = planWith(system, ['apt-get'], 'linux');
  assert.equal(plan.tools[0].install.route.privileged, true);
  assert.equal(plan.tools[0].action.applicable, false);
  assert.match(plan.tools[0].action.reason, /needs administrator rights.*run it yourself: sudo apt-get install system/);
});

test('a manual step travels with the plan and the result, and is never run', () => {
  const plan = planWith(browser, ['npm'], 'linux');
  assert.deepEqual(plan.tools[0].action.manual, [{ command: ['browser', 'install', '--with-deps'], reason: 'installs system libraries with sudo' }]);
  const executed: any[] = [];
  const done = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), executed) });
  assert.deepEqual(executed, [['npm', 'install', '-g', 'browser'], ['browser', 'install']]);
  assert.deepEqual(done.results[0].manual.map((step: any) => step.command), [['browser', 'install', '--with-deps']]);
});

test('update and uninstall run the managed route\'s own pair when it has one, else the tool\'s', () => {
  const tool = {
    ...browser, update: { command: ['browser', 'upgrade'] }, uninstall: { command: ['cargo', 'uninstall', 'browser'] },
    install: { routes: [{ ...browser.install.routes[0], uninstall: { command: ['brew', 'uninstall', 'browser'] } }, browser.install.routes[1]] },
  };
  const installed = (platform: string, action: string) => planToolLifecycle({ registry: { externalTools: [tool] }, action, platform, execFileSyncImpl: fakeExec(new Map([['browser --version', 'b 1']])) }).tools[0].action;
  assert.deepEqual(installed('darwin', 'uninstall').command, ['brew', 'uninstall', 'browser']);
  assert.deepEqual(installed('linux', 'uninstall').command, ['cargo', 'uninstall', 'browser']);
  assert.deepEqual(installed('darwin', 'update').command, ['browser', 'upgrade']);
});

test('a present tool probes no installer; an absent one probes each installer once', () => {
  const calls: any[] = [];
  const present = planToolLifecycle({ registry: { externalTools: [browser] }, platform: 'darwin', execFileSyncImpl: fakeExec(new Map([['browser --version', 'b 1']]), calls) });
  assert.equal(present.tools[0].install, null);
  assert.deepEqual(calls, [['browser', '--version']]);
  const absentCalls: any[] = [];
  planToolLifecycle({ registry: { externalTools: [browser, { ...browser, id: 'browser2' }] }, platform: 'darwin', execFileSyncImpl: fakeExec(new Map([
    ['browser --version', absent('browser')], ['browser2 --version', absent('browser2')], ['brew --version', 'brew 1'],
  ]), absentCalls) });
  assert.equal(absentCalls.filter((vector) => vector[0] === 'brew').length, 1);
});

test('the step after an install is shown and confirmed on its own, and only after the install succeeded', () => {
  const plan = planWith(browser, ['brew'], 'darwin');
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

test('a status command that does not answer in time gives the state inspection-timeout and does not stop the list', (t: any) => {
  const dir = tempDir(t, 'doflow-slow-');
  const slow = path.join(dir, 'slow');
  fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const tools = [
    { id: 'slow', officialEvidence: ['https://example.test/slow'], status: { commands: [[slow, '--version']] }, install: { command: ['brew', 'install', 'slow'] } },
    { id: 'gone', officialEvidence: ['https://example.test/gone'], status: { commands: [[path.join(dir, 'missing'), '--version']] } },
  ];
  const started = Date.now();
  const plan = planToolLifecycle({ registry: { externalTools: tools }, platform: 'linux', timeoutMs: 300 });
  assert.ok(Date.now() - started < 5000, 'the slow binary was cut off, not waited for');
  assert.deepEqual(plan.tools.map((item: any) => item.state), ['inspection-timeout', 'absent']);
  assert.equal(normalizeToolState([{ result: 'succeeded' }, { result: 'timeout' }]), 'inspection-timeout');
  const install = planToolLifecycle({ registry: { externalTools: [tools[0]] }, action: 'install', platform: 'linux', timeoutMs: 300 }).tools[0].action;
  assert.equal(install.reason, 'tool state is inspection-timeout');
});

test('after a timeout nothing the probe started is left running', { skip: process.platform === 'win32' && 'the fake wrapper is a POSIX shell script; the Windows path (taskkill /T /F) cannot run here' }, async (t: any) => {
  const dir = tempDir(t, 'doflow-slow-');
  const pidFile = path.join(dir, 'child.pid');
  const wrapper = path.join(dir, 'wrapper');
  // No `exec`: the shell stays the direct child and `sleep` is its child, which the timeout alone would not reach.
  fs.writeFileSync(wrapper, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`, { mode: 0o755 });
  const tool = { id: 'wrapped', officialEvidence: ['https://example.test/w'], status: { commands: [[wrapper, '--version']] } };
  const plan = planToolLifecycle({ registry: { externalTools: [tool] }, platform: 'linux', timeoutMs: 500 });
  assert.equal(plan.tools[0].state, 'inspection-timeout');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 1, 'the wrapper started its child');
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'the sleep the wrapper started is gone');
});

test('an installer probe that does not answer in time counts as not installed', (t: any) => {
  const dir = tempDir(t, 'doflow-slow-');
  fs.writeFileSync(path.join(dir, 'slowbrew'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const tool = { id: 'x', officialEvidence: ['https://example.test/x'], status: { commands: [[path.join(dir, 'nothing'), '--version']] }, install: { routes: [{ installer: path.join(dir, 'slowbrew'), command: [path.join(dir, 'slowbrew'), 'install', 'x'], evidence: 'https://example.test/x' }] } };
  const plan = planToolLifecycle({ registry: { externalTools: [tool] }, action: 'install', platform: 'linux', timeoutMs: 300 });
  assert.match(plan.tools[0].install.reason, /^missing installer/);
});

// The registry validator rejects these; the lifecycle must refuse them on its own, for a registry it never saw.
test('the lifecycle refuses a privilege word or a wrapper before its runner, with no validator in front of it', () => {
  const crafted = (id: string, install: any, extra: any = {}) => ({ id, officialEvidence: ['https://example.test/x'], status: { commands: [[`tool-${id}`, '--version']] }, install, ...extra });
  const route = (command: string[], after?: string[][]) => ({ routes: [{ installer: 'brew', command, ...(after ? { after } : {}), evidence: 'https://example.test/x' }] });
  const cases: [string, any, string[][]][] = [
    ['abs-sudo', crafted('abs-sudo', route(['/usr/bin/sudo', 'apt-get', 'install', 'x'])), []],
    ['pkexec', crafted('pkexec', route(['pkexec', 'x'])), []],
    ['run0', crafted('run0', route(['run0', 'x'])), []],
    ['env-sudo', crafted('env-sudo', route(['env', 'sudo', 'x'])), []],
    ['sh-c', crafted('sh-c', route(['sh', '-c', 'sudo x'])), []],
    ['win-cmd', crafted('win-cmd', route(['C:\\Windows\\System32\\cmd.exe', '/c', 'x'])), []],
    ['after-sudo', crafted('after-sudo', route(['brew', 'install', 'x'], [['/usr/bin/sudo', 'true']])), [['brew', 'install', 'x']]],
  ];
  for (const [id, tool, expectedRuns] of cases) {
    const plan = planToolLifecycle({ registry: { externalTools: [tool] }, action: 'install', platform: 'darwin', execFileSyncImpl: fakeExec(new Map([[`tool-${id} --version`, absent(id)], ['brew --version', 'brew 1']])) });
    const ran: any[] = [];
    const out = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), ran) });
    assert.deepEqual(ran, expectedRuns, `${id}: the runner saw only what is allowed`);
    const refused = out.results[0].followUps?.[0] ?? out.results[0];
    assert.equal(refused.status, 'refused', id);
    assert.match(refused.reason, /does not run it/, id);
  }
  // update and uninstall go through the same door.
  const tool = { ...crafted('upd', route(['brew', 'install', 'x'])), update: { command: ['sh', '-c', 'x'] }, uninstall: { command: ['doas', 'x'] } };
  for (const action of ['update', 'uninstall']) {
    const plan = planToolLifecycle({ registry: { externalTools: [tool] }, action, platform: 'darwin', execFileSyncImpl: fakeExec(new Map([['tool-upd --version', 'upd 1']])) });
    const ran: any[] = [];
    const out = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), ran) });
    assert.deepEqual(ran, [], action);
    assert.equal(out.results[0].status, 'refused', action);
  }
});

test('plainCommand quotes only the parts that need it', () => {
  assert.equal(plainCommand(['brew', 'install', '--cask', 'drawio']), 'brew install --cask drawio');
  assert.equal(plainCommand(['sh', '-c', 'a b']), 'sh -c "a b"');
});
