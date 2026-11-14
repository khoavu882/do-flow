'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { tempDir } = require('../helper/tmp.ts');
const path = require('node:path');
const { spawn } = require('node:child_process');
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

test('normalizes status outcomes without shortcutting any status command', async () => {
  assert.equal(normalizeToolState([{ result: 'absent' }]), 'absent');
  assert.equal(normalizeToolState([{ result: 'succeeded' }]), 'installed');
  assert.equal(normalizeToolState([{ result: 'succeeded' }, { result: 'absent' }]), 'unknown');
  assert.equal(normalizeToolState([{ result: 'failed' }]), 'inspection-failed');

  const calls: any[] = [];
  const plan = await planToolLifecycle({ registry, action: 'status', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', 'rtk 1'], ['rtk gain', absent('rtk gain')], ['graphify --version', absent('graphify')], ['uv --version', 'uv 1'],
  ]), calls) });
  assert.equal(plan.tools[0].state, 'unknown');
  assert.deepEqual(calls, [['rtk', '--version'], ['rtk', 'gain'], ['graphify', '--version'], ['uv', '--version']]);
});

test('missing uv blocks Graphify mutation without attempting to install a prerequisite', async () => {
  const calls: any[] = [];
  const plan = await planToolLifecycle({ registry, action: 'install', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', absent('rtk')], ['rtk gain', absent('rtk')], ['graphify --version', absent('graphify')], ['uv --version', absent('uv')],
  ]), calls) });
  const graphify = plan.tools[1];
  assert.equal(graphify.action.reason, 'missing prerequisite: uv', 'the prerequisite check still runs before an install');
  assert.match(graphify.install.reason, /missing installer: needs uv on PATH; see https:\/\/example.test\/graphify/);
  assert.ok(!calls.some((vector) => vector.join(' ') === 'uv tool install graphifyy'));
});

test('each executable command is displayed and confirmed separately; declined commands are not executed', async () => {
  const plan = await planToolLifecycle({ registry, action: 'install', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
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

test('a failed command does not prevent independently confirmed commands from running', async () => {
  const plan = await planToolLifecycle({ registry, action: 'uninstall', platform: 'linux', execFileSyncImpl: fakeExec(new Map([
    ['rtk --version', 'rtk 1'], ['rtk gain', 'gain'], ['graphify --version', 'graphify 1'], ['uv --version', 'uv 1'],
  ])) });
  const result = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map<string, any>([
    ['cargo uninstall rtk', new Error('cargo failed')], ['uv tool uninstall graphifyy', 'removed'],
  ])) });
  assert.deepEqual(result.results.map((item: any) => item.status), ['failed', 'succeeded']);
});

test('unsupported platforms run no inspection or action commands', async () => {
  let calls = 0;
  const plan = await planToolLifecycle({ registry, action: 'install', platform: 'win32', execFileSyncImpl: () => { calls += 1; } });
  assert.equal(plan.supported, false);
  assert.equal(calls, 0);
  const result = executeToolLifecycle({ plan, displayCommand() { calls += 1; }, confirmCommand: () => true, execFileSyncImpl: () => { calls += 1; } });
  assert.deepEqual(result.results.map((item: any) => item.status), ['skipped', 'skipped']);
  assert.equal(calls, 0);
});

test('RTK update is skipped because no verified update command is registered', async () => {
  const plan = await planToolLifecycle({ registry, action: 'update', platform: 'darwin', execFileSyncImpl: fakeExec(new Map([
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

test('the first route of the platform is the managed one; the others are alternatives', async () => {
  const darwin = chooseInstallRoute(browser, { platform: 'darwin', isInstalled: onPath('brew', 'npm', 'cargo') });
  assert.deepEqual(darwin.route.command, ['brew', 'install', 'browser']);
  assert.deepEqual(darwin.alternatives.map((route: any) => route.command[0]), ['npm', 'cargo']);
  const linux = chooseInstallRoute(browser, { platform: 'linux', isInstalled: onPath('brew', 'npm') });
  assert.deepEqual(linux.route.command, ['npm', 'install', '-g', 'browser'], 'a route for another platform is not considered');
  assert.deepEqual(linux.alternatives.map((route: any) => route.command[0]), ['cargo']);
});

test('when the managed installer is missing, the answer names it, shows the alternatives and offers none to run', async () => {
  const chosen = chooseInstallRoute(browser, { platform: 'darwin', isInstalled: onPath('npm', 'cargo') });
  assert.equal(chosen.route, undefined);
  assert.equal(chosen.reason, 'missing installer: needs brew on PATH; see https://example.test/browser');
  assert.deepEqual(chosen.alternatives.map((route: any) => route.command[0]), ['npm', 'cargo']);
  assert.equal(describeInstall(chosen).command, null);
  assert.equal(describeInstall(chosen).alternatives.length, 2);
});

test('an alternative route is never executed, even when its installer is present and everything is confirmed', async () => {
  const calls: any[] = [];
  const plan = await planWith(browser, ['npm', 'cargo'], 'darwin', 'install', calls);
  assert.equal(plan.tools[0].action.applicable, false);
  const executed: any[] = [];
  const result = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), executed) });
  assert.deepEqual(result.results.map((item: any) => item.status), ['skipped']);
  assert.deepEqual(executed, [], 'nothing ran: neither npm install nor cargo install');
});

test('a tool with no install route for this platform names the documentation URL instead of a command', async () => {
  const noInstall = { id: 'bash', officialEvidence: ['https://example.test/bash'], status: { commands: [['bash', '--version']] } };
  assert.equal(chooseInstallRoute(noInstall, { platform: 'linux', isInstalled: onPath('brew') }).reason, 'no verified install command is registered for linux; see https://example.test/bash');
  const darwinOnly = { ...noInstall, install: { routes: [{ installer: 'brew', command: ['brew', 'install', 'x'], platforms: ['darwin'], evidence: 'https://example.test/bash' }] } };
  assert.match(chooseInstallRoute(darwinOnly, { platform: 'linux', isInstalled: onPath('brew') }).reason, /no verified install command is registered for linux/);
});

test('a privileged managed route is offered as a command but never planned for execution', async () => {
  const plan = await planWith(system, ['apt-get'], 'linux');
  assert.equal(plan.tools[0].install.route.privileged, true);
  assert.equal(plan.tools[0].action.applicable, false);
  assert.match(plan.tools[0].action.reason, /needs administrator rights.*run it yourself: sudo apt-get install system/);
});

test('a manual step travels with the plan and the result, and is never run', async () => {
  const plan = await planWith(browser, ['npm'], 'linux');
  assert.deepEqual(plan.tools[0].action.manual, [{ command: ['browser', 'install', '--with-deps'], reason: 'installs system libraries with sudo' }]);
  const executed: any[] = [];
  const done = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), executed) });
  assert.deepEqual(executed, [['npm', 'install', '-g', 'browser'], ['browser', 'install']]);
  assert.deepEqual(done.results[0].manual.map((step: any) => step.command), [['browser', 'install', '--with-deps']]);
});

test('update and uninstall run the managed route\'s own pair when it has one, else the tool\'s', async () => {
  const tool = {
    ...browser, update: { command: ['browser', 'upgrade'] }, uninstall: { command: ['cargo', 'uninstall', 'browser'] },
    install: { routes: [{ ...browser.install.routes[0], uninstall: { command: ['brew', 'uninstall', 'browser'] } }, browser.install.routes[1]] },
  };
  const installed = async (platform: string, action: string) => (await planToolLifecycle({ registry: { externalTools: [tool] }, action, platform, execFileSyncImpl: fakeExec(new Map([['browser --version', 'b 1']])) })).tools[0].action;
  assert.deepEqual((await installed('darwin', 'uninstall')).command, ['brew', 'uninstall', 'browser']);
  assert.deepEqual((await installed('linux', 'uninstall')).command, ['cargo', 'uninstall', 'browser']);
  assert.deepEqual((await installed('darwin', 'update')).command, ['browser', 'upgrade']);
});

test('a present tool probes no installer; an absent one probes each installer once', async () => {
  const calls: any[] = [];
  const present = await planToolLifecycle({ registry: { externalTools: [browser] }, platform: 'darwin', execFileSyncImpl: fakeExec(new Map([['browser --version', 'b 1']]), calls) });
  assert.equal(present.tools[0].install, null);
  assert.deepEqual(calls, [['browser', '--version']]);
  const absentCalls: any[] = [];
  await planToolLifecycle({ registry: { externalTools: [browser, { ...browser, id: 'browser2' }] }, platform: 'darwin', execFileSyncImpl: fakeExec(new Map([
    ['browser --version', absent('browser')], ['browser2 --version', absent('browser2')], ['brew --version', 'brew 1'],
  ]), absentCalls) });
  assert.equal(absentCalls.filter((vector) => vector[0] === 'brew').length, 1);
});

test('the step after an install is shown and confirmed on its own, and only after the install succeeded', async () => {
  const plan = await planWith(browser, ['brew'], 'darwin');
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

test('a status command that does not answer in time gives the state inspection-timeout and does not stop the list', async (t: any) => {
  const dir = tempDir(t, 'doflow-slow-');
  const slow = path.join(dir, 'slow');
  fs.writeFileSync(slow, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const tools = [
    { id: 'slow', officialEvidence: ['https://example.test/slow'], status: { commands: [[slow, '--version']] }, install: { command: ['brew', 'install', 'slow'] } },
    { id: 'gone', officialEvidence: ['https://example.test/gone'], status: { commands: [[path.join(dir, 'missing'), '--version']] } },
  ];
  const started = Date.now();
  const plan = await planToolLifecycle({ registry: { externalTools: tools }, platform: 'linux', timeoutMs: 300 });
  assert.ok(Date.now() - started < 5000, 'the slow binary was cut off, not waited for');
  assert.deepEqual(plan.tools.map((item: any) => item.state), ['inspection-timeout', 'absent']);
  assert.equal(normalizeToolState([{ result: 'succeeded' }, { result: 'timeout' }]), 'inspection-timeout');
  const install = (await planToolLifecycle({ registry: { externalTools: [tools[0]] }, action: 'install', platform: 'linux', timeoutMs: 300 })).tools[0].action;
  assert.equal(install.reason, 'tool state is inspection-timeout');
});

test('after a timeout nothing the probe started is left running', { skip: process.platform === 'win32' && 'the fake wrapper is a POSIX shell script; the Windows path (taskkill /T /F) cannot run here' }, async (t: any) => {
  const dir = tempDir(t, 'doflow-slow-');
  const pidFile = path.join(dir, 'child.pid');
  const wrapper = path.join(dir, 'wrapper');
  // No `exec`: the shell stays the direct child and `sleep` is its child, which the timeout alone would not reach.
  fs.writeFileSync(wrapper, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`, { mode: 0o755 });
  const tool = { id: 'wrapped', officialEvidence: ['https://example.test/w'], status: { commands: [[wrapper, '--version']] } };
  const plan = await planToolLifecycle({ registry: { externalTools: [tool] }, platform: 'linux', timeoutMs: 500 });
  assert.equal(plan.tools[0].state, 'inspection-timeout');
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.ok(pid > 1, 'the wrapper started its child');
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 40 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(alive(), false, 'the sleep the wrapper started is gone');
});

// A terminal Ctrl-C signals the foreground process group. The wrapper's own `sleep &` ignores SIGINT (a POSIX shell does that for
// a background job), so the probe's children are ended by DoFlow, which must also hold for a SIGTERM that reaches node alone.
for (const [name, signal, toGroup] of [['SIGINT to the foreground group', 'SIGINT', true], ['SIGTERM to node alone', 'SIGTERM', false]] as [string, string, boolean][]) {
  test(`nothing a probe started survives ${name}`, { skip: process.platform === 'win32' && 'POSIX signals and a POSIX shell wrapper' }, async (t: any) => {
    const dir = tempDir(t, 'doflow-sig-');
    const pidFile = path.join(dir, 'child.pid');
    const wrapper = path.join(dir, 'wrapper');
    fs.writeFileSync(wrapper, `#!/bin/sh\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`, { mode: 0o755 });
    const lifecycle = path.join(__dirname, '..', '..', 'src', 'install', 'tool-lifecycle.ts');
    const inner = `require(${JSON.stringify(lifecycle)}).planToolLifecycle({ registry: { externalTools: [{ id: 'h', officialEvidence: ['https://x.test'], status: { commands: [[${JSON.stringify(wrapper)}, '--version']] } }] }, platform: 'linux', timeoutMs: 20000 });`;
    // Its own group, as a terminal job has: the group is what Ctrl-C signals.
    const node = spawn(process.execPath, ['-e', inner], { detached: true, stdio: 'ignore' });
    const exited = new Promise((resolve) => node.on('exit', (code: any, sig: any) => resolve({ code, sig })));
    for (let i = 0; i < 100 && !fs.existsSync(pidFile); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    assert.ok(pid > 1, 'the wrapper started its child');
    const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
    assert.equal(alive(), true, 'the child is running before the signal');
    try {
      process.kill(toGroup ? -node.pid : node.pid, signal);
      await exited;
      for (let i = 0; i < 60 && alive(); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(alive(), false, 'the sleep the wrapper started is gone');
    } finally {
      if (alive()) process.kill(pid, 'SIGKILL');
      try { process.kill(node.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  });
}

test('an installer probe that does not answer in time counts as not installed', async (t: any) => {
  const dir = tempDir(t, 'doflow-slow-');
  fs.writeFileSync(path.join(dir, 'slowbrew'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const tool = { id: 'x', officialEvidence: ['https://example.test/x'], status: { commands: [[path.join(dir, 'nothing'), '--version']] }, install: { routes: [{ installer: path.join(dir, 'slowbrew'), command: [path.join(dir, 'slowbrew'), 'install', 'x'], evidence: 'https://example.test/x' }] } };
  const plan = await planToolLifecycle({ registry: { externalTools: [tool] }, action: 'install', platform: 'linux', timeoutMs: 300 });
  assert.match(plan.tools[0].install.reason, /^missing installer/);
});

// The registry validator rejects these; the lifecycle must refuse them on its own, for a registry it never saw.
test('the lifecycle refuses a privilege word or a wrapper before its runner, with no validator in front of it', async () => {
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
    const plan = await planToolLifecycle({ registry: { externalTools: [tool] }, action: 'install', platform: 'darwin', execFileSyncImpl: fakeExec(new Map([[`tool-${id} --version`, absent(id)], ['brew --version', 'brew 1']])) });
    const ran: any[] = [];
    const out = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), ran) });
    assert.deepEqual(ran, expectedRuns, `${id}: the runner saw only what is allowed`);
    const refused = out.results[0].followUps?.[0] ?? out.results[0];
    assert.equal(refused.status, 'refused', id);
    assert.match(refused.reason, /does not run|runs it only as/, id);
  }
  // update and uninstall go through the same door.
  const tool = { ...crafted('upd', route(['brew', 'install', 'x'])), update: { command: ['sh', '-c', 'x'] }, uninstall: { command: ['doas', 'x'] } };
  // `sh --version` answers, so the plan offers the update and the lifecycle refuses it; `doas` is never probed as an installer, so the plan skips it.
  for (const [action, status] of [['update', 'refused'], ['uninstall', 'skipped']]) {
    const plan = await planToolLifecycle({ registry: { externalTools: [tool] }, action, platform: 'darwin', execFileSyncImpl: fakeExec(new Map([['tool-upd --version', 'upd 1']])) });
    const ran: any[] = [];
    const out = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), ran) });
    assert.deepEqual(ran, [], action);
    assert.equal(out.results[0].status, status, action);
  }
});

// The reviewer's third reproducer: wrappers, interpreters and privilege words in every position. The lifecycle is given a
// registry no validator has seen and a runner that records its calls; the runner must not see any of these.
test('the lifecycle runs only the tool\'s own program or a known installer, whatever the registry says', async () => {
  const crafted = (command: string[], extra: any = {}) => ({ id: 'x', officialEvidence: ['https://example.test/x'], status: { commands: [['tool-x', '--version']] }, install: { routes: [{ installer: command[0], command, evidence: 'https://example.test/x', ...extra }] } });
  const withAfter = (step: string[]) => ({ ...crafted(['brew', 'install', 'x']), install: { routes: [{ installer: 'brew', command: ['brew', 'install', 'x'], after: [step], evidence: 'https://example.test/x' }] } });
  const cases: [string, any, string[][]][] = [
    ['abs sudo', crafted(['/usr/bin/sudo', 'apt-get', 'install', 'x']), []], ['pkexec', crafted(['pkexec', 'x']), []], ['SUDO', crafted(['SUDO', 'x']), []],
    ['env sudo', crafted(['env', 'sudo', 'x']), []], ['sh -c', crafted(['sh', '-c', 'sudo x']), []], ['nice', crafted(['nice', 'sudo', 'x']), []],
    ['nohup', crafted(['nohup', 'sudo', 'x']), []], ['timeout', crafted(['timeout', '5', 'sudo', 'x']), []], ['xargs', crafted(['xargs', 'sudo']), []],
    ['time', crafted(['time', 'sudo', 'x']), []], ['command', crafted(['command', 'sudo', 'x']), []], ['npx sudo', crafted(['npx', 'sudo', 'x']), []],
    ['npm exec', crafted(['npm', 'exec', '--', 'sudo', 'x']), []], ['stdbuf', crafted(['stdbuf', '-o0', 'sudo', 'x']), []], ['setsid', crafted(['setsid', 'sudo', 'x']), []],
    ['busybox sh', crafted(['busybox', 'sh', '-c', 'x']), []], ['tcsh', crafted(['tcsh', '-c', 'x']), []], ['python3 -c', crafted(['python3', '-c', 'x']), []],
    ['node -e', crafted(['node', '-e', 'x']), []], ['brew naming sudo', crafted(['brew', 'install', '--', 'sudo']), []],
    ['after nice', withAfter(['nice', 'sudo', 'true']), [['brew', 'install', 'x']]], ['after abs sudo', withAfter(['/usr/bin/sudo', 'true']), [['brew', 'install', 'x']]],
    ['after unknown program', withAfter(['curl', 'x']), [['brew', 'install', 'x']]],
  ];
  for (const [name, tool, expectedRuns] of cases) {
    const plan = await planToolLifecycle({ registry: { externalTools: [tool] }, action: 'install', platform: 'darwin', execFileSyncImpl: (file: string, args: string[]) => { if (file === 'tool-x') throw absent(file); return 'ok'; } });
    const ran: any[] = [];
    const out = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), ran) });
    assert.deepEqual(ran, expectedRuns, `${name}: the runner saw only what is allowed`);
    const refused = out.results[0].followUps?.[0] ?? out.results[0];
    assert.ok(['refused', 'skipped'].includes(refused.status), `${name}: ${refused.status}`);
    if (!expectedRuns.length) assert.notEqual(out.results[0].status, 'succeeded', name);
  }
  // A status command that is not the tool's own program, or names sudo, is never run: nothing answers, so the tool is not installed.
  const ran: any[] = [];
  const plan = await planToolLifecycle({ registry: { externalTools: [{ ...crafted(['brew', 'install', 'x']), status: { commands: [['tool-x', '--version'], ['nice', 'sudo', 'x']] } }] }, platform: 'darwin', execFileSyncImpl: fakeExec(new Map(), ran) });
  assert.deepEqual(ran.map((call) => call[0]), ['tool-x'], 'only the own program was asked');
  assert.equal(plan.tools[0].state, 'unknown');
});

test('a shell, env or an interpreter with inline code is run only as <program> --version', async () => {
  const withStatus = (command: string[]) => ({ id: 'x', officialEvidence: ['https://example.test/x'], status: { commands: [command] } });
  const asked = async (command: string[]) => {
    const ran: any[] = [];
    const plan = await planToolLifecycle({ registry: { externalTools: [withStatus(command)] }, platform: 'darwin', execFileSyncImpl: fakeExec(new Map(), ran) });
    return { ran, state: plan.tools[0].state };
  };
  for (const command of [['bash', '--version'], ['sh', '--version'], ['env', '--version'], ['python3', '--version']]) {
    const { ran, state } = await asked(command);
    assert.deepEqual(ran, [command], `${command.join(' ')} runs as a version check`);
    assert.equal(state, 'installed');
  }
  for (const command of [['bash', '--version', '-c', 'x'], ['bash', '-c', 'x', '--version'], ['sh', '-c', 'sudo x'], ['env', 'sudo', 'x'], ['env', 'true'], ['python3', '-c', 'import os'], ['node', '-e', 'x'], ['perl', '-e', 'x'], ['/bin/zsh', '-c', 'x']]) {
    const { ran, state } = await asked(command);
    assert.deepEqual(ran, [], `${command.join(' ')} never reaches the runner`);
    assert.equal(state, 'inspection-failed');
  }
  // The same rule holds for a command that is run: an install route, an after step, an update.
  const route = { installer: 'brew', command: ['brew', 'install', 'x'], after: [['bash', '-c', 'x']], evidence: 'https://example.test/x' };
  const tool = { ...withStatus(['tool-x', '--version']), install: { routes: [route] }, update: { command: ['bash', '-c', 'x'] } };
  const plan = await planToolLifecycle({ registry: { externalTools: [tool] }, action: 'install', platform: 'darwin', execFileSyncImpl: (file: string) => { if (file === 'tool-x') throw absent(file); return 'ok'; } });
  const ran: any[] = [];
  const out = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), ran) });
  assert.deepEqual(ran, [['brew', 'install', 'x']]);
  assert.equal(out.results[0].followUps[0].status, 'refused');
});

test('update and uninstall say which installer is missing instead of failing with ENOENT', async () => {
  const rtk = registry.externalTools.find((tool: any) => tool.id === 'rtk');
  for (const action of ['uninstall']) {
    const calls: any[] = [];
    const plan = await planToolLifecycle({ registry: { externalTools: [rtk] }, action, platform: 'linux', execFileSyncImpl: fakeExec(new Map([['rtk --version', 'rtk 1'], ['rtk gain', 'gain'], ['cargo --version', absent('cargo')]]), calls) });
    assert.equal(plan.tools[0].action.applicable, false);
    assert.equal(plan.tools[0].action.reason, 'missing installer: needs cargo on PATH; see https://example.test/rtk');
    const ran: any[] = [];
    const out = executeToolLifecycle({ plan, displayCommand() {}, confirmCommand: () => true, execFileSyncImpl: fakeExec(new Map(), ran) });
    assert.deepEqual(ran, [], 'cargo is never run');
    assert.equal(out.results[0].status, 'skipped');
  }
  // A self-update through the tool's own binary needs no other installer.
  const own = { ...browser, update: { command: ['browser', 'upgrade'] } };
  const plan = await planToolLifecycle({ registry: { externalTools: [own] }, action: 'update', platform: 'darwin', execFileSyncImpl: fakeExec(new Map([['browser --version', 'b 1']])) });
  assert.deepEqual(plan.tools[0].action.command, ['browser', 'upgrade']);
});

test('plainCommand quotes only the parts that need it', async () => {
  assert.equal(plainCommand(['brew', 'install', '--cask', 'drawio']), 'brew install --cask drawio');
  assert.equal(plainCommand(['sh', '-c', 'a b']), 'sh -c "a b"');
});
