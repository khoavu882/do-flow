'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REGISTRY_FILES, COPY_TREE_SELECTS, loadRegistry, validateRegistry, selectAssets, selectMcpServers, mcpCapable, capabilityMapData,
} = require('../../src/registry/index.ts');
const { SELECTORS } = require('../../src/adapters/copy-tree.ts');
const { activeIds } = require('../../src/registry/harness-ids.ts');
const { projectAdapterInput } = require('../../src/adapters/index.ts');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, "../..");

test('loads and validates the complete multi-harness registry', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(registry.harnesses.map((item: any) => item.id), activeIds());
  assert.deepEqual(Object.keys(REGISTRY_FILES), ['harnesses', 'assets', 'mcp', 'lifecycle', 'contracts', 'externalTools', 'models']);
  // contracts.json declares what each harness ACCEPTS, deliberately separate from harnesses.json's
  // what-DoFlow-SUPPORTS: nesting them would make the registry-truth guard validate the registry
  // against itself. Every harness must have exactly one contract.
  assert.deepEqual(registry.contracts.map((c: any) => c.harness), activeIds());
  assert.equal(registry.validation.ok, true);
  assert.deepEqual(registry.harnesses.find((harness: any) => harness.id === 'codex').nativeProjection.config.resources,
    [{ kind: 'configuration-entry', identity: 'features.hooks', value: true }]);
  assert.deepEqual(registry.externalTools.map((tool: any) => tool.id), ['rtk', 'graphify', 'semble', 'mermaid-cli', 'plantuml', 'jq', 'git', 'bash', 'ripgrep', 'drawio', 'python3', 'agent-browser']);
});

test('registry copy-tree select names stay in sync with the adapter selector table', () => {
  assert.deepEqual([...COPY_TREE_SELECTS].sort(), Object.keys(SELECTORS).sort());
});

test('adapter input carries the projection select name', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const harness = registry.harnesses.find((item: any) => item.id === 'claude');
  const asset = registry.assets.find((item: any) => item.appliesTo.includes('claude')
    && item.projection?.claude?.renderer === 'copy-tree');
  asset.projection.claude.select = 'guidance-manifest';

  const input = projectAdapterInput({ registry, harness, scope: 'project', scopeRoot: REPO, assets: [asset] });
  assert.equal(input.assets[0].select, 'guidance-manifest');
});

test('registry rejects select on non-copy-tree projections and unknown selector names with asset and harness', () => {
  const registry = loadRegistry({ repoRoot: REPO });

  const wrongRenderer = structuredClone(registry);
  const nonCopyAsset = wrongRenderer.assets.find((asset: any) => asset.appliesTo.includes('claude')
    && asset.projection?.claude?.renderer !== 'copy-tree');
  assert.ok(nonCopyAsset, 'fixture must contain a non-copy-tree Claude projection');
  nonCopyAsset.projection.claude.select = 'guidance-manifest';
  const wrongRendererResult = validateRegistry(wrongRenderer, { repoRoot: REPO });
  assert.equal(wrongRendererResult.ok, false);
  assert.match(wrongRendererResult.errors.join('\n'), new RegExp(`asset '${nonCopyAsset.id}'.*projection 'claude'.*select`));

  const unknownSelector = structuredClone(registry);
  const copyTreeAsset = unknownSelector.assets.find((asset: any) => asset.appliesTo.includes('claude')
    && asset.projection?.claude?.renderer === 'copy-tree');
  assert.ok(copyTreeAsset, 'fixture must contain a copy-tree Claude projection');
  copyTreeAsset.projection.claude.select = 'nope';
  const unknownSelectorResult = validateRegistry(unknownSelector, { repoRoot: REPO });
  assert.equal(unknownSelectorResult.ok, false);
  assert.match(unknownSelectorResult.errors.join('\n'), new RegExp(`asset '${copyTreeAsset.id}'.*projection 'claude'.*select.*guidance-manifest`));
});

test('loads evidence-backed external tool definitions with argument-vector commands only', () => {
  const { externalTools } = loadRegistry({ repoRoot: REPO });
  const rtk = externalTools.find((tool: any) => tool.id === 'rtk');
  const graphify = externalTools.find((tool: any) => tool.id === 'graphify');
  const semble = externalTools.find((tool: any) => tool.id === 'semble');

  assert.deepEqual(rtk.status.commands, [['rtk', '--version'], ['rtk', 'gain']]);
  assert.deepEqual(rtk.install.routes.map((route: any) => route.command), [
    ['cargo', 'install', '--git', 'https://github.com/rtk-ai/rtk', '--branch', 'master', 'rtk'],
    ['brew', 'install', 'rtk-ai/tap/rtk'],
  ]);
  assert.equal(rtk.update, undefined, 'RTK has no verified update command');
  assert.deepEqual(graphify.prerequisites, ['uv']);
  assert.deepEqual(graphify.install.routes.map((route: any) => route.command), [['uv', 'tool', 'install', 'graphifyy'], ['pipx', 'install', 'graphifyy']]);
  assert.deepEqual(graphify.update.command, ['uv', 'tool', 'upgrade', 'graphifyy']);
  assert.deepEqual(graphify.uninstall.command, ['uv', 'tool', 'uninstall', 'graphifyy']);
  assert.deepEqual(semble.prerequisites, ['uv']);
  assert.deepEqual(semble.install.command, ['uv', 'tool', 'install', 'semble']);
  assert.deepEqual(semble.update.command, ['uv', 'tool', 'upgrade', 'semble']);
  assert.deepEqual(semble.uninstall.command, ['uv', 'tool', 'uninstall', 'semble']);
  for (const tool of externalTools) {
    assert.ok(tool.officialEvidence.every((url: any) => url.startsWith('https://')));
    assert.ok(tool.status.commands.every((command: any) => Array.isArray(command) && command.every((argument) => typeof argument === 'string')));
  }
});

test('rejects malformed external tool provenance, identifiers, and command arrays', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const invalid = structuredClone(registry);
  invalid.externalTools[0].id = 'unknown-tool';
  invalid.externalTools[0].officialEvidence = ['http://example.test'];
  invalid.externalTools[0].status.commands = ['rtk --version'];
  invalid.externalTools[1].install.command = 'uv tool install graphifyy';

  const result = validateRegistry(invalid, { repoRoot: REPO });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /id must be one of: rtk, graphify/);
  assert.match(result.errors.join('\n'), /HTTPS officialEvidence URLs/);
  assert.match(result.errors.join('\n'), /command must be a non-empty array of non-empty strings/);
});

test('required and optional tools, and the install routes that carry a second step or need administrator rights', () => {
  const { externalTools } = loadRegistry({ repoRoot: REPO });
  const byId = (id: string) => externalTools.find((tool: any) => tool.id === id);
  assert.deepEqual(externalTools.filter((tool: any) => tool.role === 'required').map((tool: any) => tool.id), ['jq', 'git', 'bash']);
  assert.equal(byId('bash').install, undefined, 'bash has no install command on its official page');
  assert.equal(byId('python3').install, undefined, 'python3 has no install command on its official pages');
  const browser = byId('agent-browser');
  assert.deepEqual(browser.install.routes.map((route: any) => [route.installer, route.platforms, route.after]), [
    ['npm', ['darwin'], [['agent-browser', 'install']]],
    ['npm', ['linux'], [['agent-browser', 'install']]],
    ['brew', ['darwin'], [['agent-browser', 'install']]],
  ]);
  assert.deepEqual(browser.install.routes[1].manual.map((step: any) => step.command), [['agent-browser', 'install', '--with-deps']]);
  assert.ok(browser.officialEvidence.includes('https://github.com/vercel-labs/agent-browser/blob/main/cli/src/main.rs'), '--version is stated in the source file only');
  assert.deepEqual(byId('drawio').install.routes.map((route: any) => route.command), [['brew', 'install', '--cask', 'drawio']]);
});

test('every external tool declares a role and an unlocks line', () => {
  const { externalTools } = loadRegistry({ repoRoot: REPO });
  for (const tool of externalTools) {
    assert.ok(['required', 'optional'].includes(tool.role), `${tool.id} role`);
    assert.ok(typeof tool.unlocks === 'string' && tool.unlocks.trim(), `${tool.id} unlocks`);
  }
});

test('external tool install accepts one command or evidence-backed routes, and rejects the rest', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const errorsFor = (change: (tool: any) => void) => {
    const copy = structuredClone(registry);
    change(copy.externalTools.find((tool: any) => tool.id === 'bash'));
    return validateRegistry(copy, { repoRoot: REPO }).errors.join('\n');
  };
  const evidence = registry.externalTools.find((tool: any) => tool.id === 'bash').officialEvidence[0];
  const route = { installer: 'brew', command: ['brew', 'install', 'x'], evidence };
  assert.equal(errorsFor((tool) => { tool.install = { routes: [route, { ...route, installer: 'npm', command: ['npm', 'install', 'x'], platforms: ['linux'], after: [['bash', '--version']] }] }; }), '');
  assert.match(errorsFor((tool) => { delete tool.role; }), /role must be one of: required, optional/);
  assert.match(errorsFor((tool) => { tool.unlocks = ' '; }), /requires unlocks/);
  assert.match(errorsFor((tool) => { tool.install = { command: ['a'], routes: [route] }; }), /exactly one of 'command' or 'routes'/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [] }; }), /routes must be a non-empty array/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...route, evidence: 'https://elsewhere.example' }] }; }), /evidence must be one of the tool officialEvidence URLs/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...route, installer: '' }] }; }), /requires installer/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...route, platforms: ['win32'] }] }; }), /platforms must be a non-empty array of: darwin, linux/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...route, after: ['x install'] }] }; }), /after\[0\]: command must be a non-empty array/);
});

test('the validator enforces that DoFlow never runs a command that needs administrator rights', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const errorsFor = (change: (tool: any) => void) => {
    const copy = structuredClone(registry);
    change(copy.externalTools.find((tool: any) => tool.id === 'bash'));
    return validateRegistry(copy, { repoRoot: REPO }).errors.join('\n');
  };
  const evidence = registry.externalTools.find((tool: any) => tool.id === 'bash').officialEvidence[0];
  const sudoRoute = { installer: 'apt-get', command: ['sudo', 'apt-get', 'install', 'x'], privileged: true, evidence };
  assert.equal(errorsFor((tool) => { tool.install = { routes: [sudoRoute] }; }), '');
  for (const word of ['sudo', 'doas', 'su']) {
    assert.match(errorsFor((tool) => { tool.install = { routes: [{ installer: 'apt-get', command: [word, 'apt-get', 'install', 'x'], evidence }] }; }), new RegExp(`starting with '${word}' requires privileged: true`));
    assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...sudoRoute, command: [word, 'apt-get', 'install', 'x'], after: [[word, 'x']] }] }; }), new RegExp(`after\\[0\\].*naming '${word}' needs administrator rights`));
  }
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...sudoRoute, command: ['apt-get', 'install', 'x'] }] }; }), /privileged: true requires a command starting with one of: sudo, doas, su, pkexec, run0/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...sudoRoute, installer: 'sudo' }] }; }), /installer 'sudo' must equal the program the command runs \('apt-get'\)/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ installer: 'npm', command: ['brew', 'install', 'x'], evidence }] }; }), /installer 'npm' must equal the program the command runs \('brew'\)/);
  assert.match(errorsFor((tool) => { tool.install = { command: ['sudo', 'x'] }; }), /install\.command: a command naming 'sudo' needs administrator rights/);
  assert.match(errorsFor((tool) => { tool.update = { command: ['sudo', 'x'] }; }), /update\.command: a command naming 'sudo' needs administrator rights/);
  // The reviewer's crafted registries. DoFlow runs an allow-list, so a path, another privilege word and any wrapper
  // (`nice`, `env`, `npx`, `sh -c`, an interpreter) fail without being named: every one of these is rejected.
  const route2 = (command: string[], extra: any = {}) => ({ routes: [{ installer: command[0], command, evidence, ...extra }] });
  const afterStep = (step: string[]) => ({ routes: [{ ...route(evidence), after: [step] }] });
  const installs: Record<string, any> = {
    absSudo: route2(['/usr/bin/sudo', 'apt-get', 'install', 'x']), pkexec: route2(['pkexec', 'x']), envSudo: route2(['env', 'sudo', 'x']), shC: route2(['sh', '-c', 'sudo x']),
    afterAbsSudo: afterStep(['/usr/bin/sudo', 'true']), upperSudo: route2(['SUDO', 'x']), nice: route2(['nice', 'sudo', 'x']), nohup: route2(['nohup', 'sudo', 'x']),
    timeout: route2(['timeout', '5', 'sudo', 'x']), xargs: route2(['xargs', 'sudo']), time: route2(['time', 'sudo', 'x']), command: route2(['command', 'sudo', 'x']),
    npxSudo: route2(['npx', 'sudo', 'x']), npmExec: route2(['npm', 'exec', '--', 'sudo', 'x']), stdbuf: route2(['stdbuf', '-o0', 'sudo', 'x']), setsid: route2(['setsid', 'sudo', 'x']),
    busybox: route2(['busybox', 'sh', '-c', 'x']), tcsh: route2(['tcsh', '-c', 'x']), python: route2(['python3', '-c', 'import os;os.system("sudo x")']), node: route2(['node', '-e', 'x']),
    afterNice: afterStep(['nice', 'sudo', 'true']), afterShell: afterStep(['/bin/bash', '-c', 'x']), brewSudoWord: route2(['brew', 'install', '--', 'sudo']),
    shellVersionAsRoute: route2(['bash', '--version']),
  };
  for (const [name, install] of Object.entries(installs)) assert.notEqual(errorsFor((tool) => { tool.install = install; }), '', `${name} is accepted`);
  for (const [name, command] of Object.entries({ niceStatus: ['nice', 'sudo', 'x'], sudoStatus: ['sudo', '--version'], absSudoStatus: ['/usr/bin/sudo', '--version'] })) {
    assert.notEqual(errorsFor((tool) => { tool.status = { commands: [command] }; }), '', `status ${name} is accepted`);
  }
  assert.notEqual(errorsFor((tool) => { tool.status = { commands: [['bash', '--version'], ['nice', 'sudo', 'x']] }; }), '', 'a second status command is checked too');
  assert.match(errorsFor((tool) => { tool.install = installs.nice; }), /installer 'nice' is not a known installer \(brew, npm, cargo, uv, pipx, apt-get\)/);
  assert.match(errorsFor((tool) => { tool.install = installs.afterNice; }), /after\[0\]: a command naming 'sudo' needs administrator rights/);
  assert.match(errorsFor((tool) => { tool.install = afterStep(['nice', 'true']); }), /after\[0\]: a command starting with 'nice' is neither the tool's own program nor its installer \(bash, brew\)/);
  assert.match(errorsFor((tool) => { tool.update = { command: ['run0', 'x'] }; }), /update\.command: a command naming 'run0' needs administrator rights/);
  // A shell, `env` or an interpreter given inline code is run only as `<program> --version`, which runs nothing else.
  for (const command of [['bash', '--version'], ['sh', '--version'], ['env', '--version'], ['python3', '--version'], ['node', '--version']]) {
    assert.equal(errorsFor((tool) => { tool.status = { commands: [command] }; }), '', `${command.join(' ')} is a harmless version check`);
  }
  for (const command of [['bash', '--version', '-c', 'x'], ['bash', '-c', 'x', '--version'], ['sh', '-c', 'sudo x'], ['/bin/sh', '-c', 'x'], ['env', 'sudo', 'x'], ['env', 'true'], ['python3', '-c', 'import os'], ['node', '-e', 'x'], ['perl', '-e', 'x'], ['busybox', 'sh'], ['bash', 'script.sh']]) {
    assert.match(errorsFor((tool) => { tool.status = { commands: [command] }; }), /can run text it is given|needs administrator rights/, `${command.join(' ')} is accepted`);
  }
  // A status command runs on every list with no confirmation: the tool's program and one flag or subcommand, the same program throughout.
  for (const command of [['osascript', '-e', 'do shell script "id" with administrator privileges'], ['npm', 'exec', '--yes', '--', 'cowsay', 'hi'], ['nice', 'node', '-e', 'x'], ['jq'], ['jq', '--version', 'x'], ['jq', 'a b'], ['jq', '1'], ['node', '--eval', 'x'], ['node', '-p', 'x'], ['node', '--print', 'x'], ['perl', '-E', 'x']]) {
    assert.notEqual(errorsFor((tool) => { tool.status = { commands: [command] }; }), '', `status ${command.join(' ')} is accepted`);
  }
  assert.match(errorsFor((tool) => { tool.status = { commands: [['jq', '--version'], ['osascript', '--version']] }; }), /status\.commands\[1\]: a command starting with 'osascript' is neither the tool's own program/);
  for (const command of [['rtk', 'gain'], ['plantuml', '-version'], ['jq', '--version']]) assert.equal(errorsFor((tool) => { tool.status = { commands: [command] }; }), '', command.join(' '));
  assert.match(errorsFor((tool) => { tool.install = afterStep(['bash', '-c', 'x']); }), /after\[0\]: a command starting with 'bash' can run text it is given/);
  assert.equal(errorsFor((tool) => { tool.status = { commands: [['bash', '--version']] }; tool.install = afterStep(['bash', '--version']); }), '');
  // A step that needs sudo is allowed where DoFlow only shows it, and a privileged shown-only route may hold anything.
  assert.equal(errorsFor((tool) => { tool.install = { routes: [{ installer: 'apt-get', command: ['sudo', 'apt-get', 'env', 'x'], privileged: true, evidence }] }; }), '');
  assert.equal(errorsFor((tool) => { tool.install = { routes: [{ ...route(evidence), manual: [{ command: ['sudo', 'x'], reason: 'needs root' }] }] }; }), '');
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...route(evidence), manual: [{ command: ['x'] }] }] }; }), /requires a reason/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...route(evidence), manual: [] }] }; }), /manual must be a non-empty array/);
});

function route(evidence: string) { return { installer: 'brew', command: ['brew', 'install', 'x'], evidence }; }

test('an interpreter given code, or a program that runs something else, is refused in every inline form, as a status command and as an action', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const errorsFor = (program: string, change: (tool: any) => void) => {
    const copy = structuredClone(registry);
    const tool = copy.externalTools.find((entry: any) => entry.id === 'bash');
    tool.status = { commands: [[program, '--version']] };
    change(tool);
    return validateRegistry(copy, { repoRoot: REPO }).errors.join('\n');
  };
  const inline: string[][] = [['python3', '-Ic', 'print(1)'], ['perl', '-le', 'print 1'], ['node', '--eval=1'], ['node', '--print=1'], ['python3', '-', 'x'], ['ruby', '-ne', 'x'], ['node', '-pe', 'x'], ['python3', '-cprint(1)']];
  for (const command of inline) {
    assert.equal(errorsFor(command[0], () => {}), '', `${command[0]} --version stays accepted`);
    assert.match(errorsFor(command[0], (tool) => { tool.status = { commands: [command] }; }), /can run text it is given/, `status ${command.join(' ')} is accepted`);
    assert.match(errorsFor(command[0], (tool) => { tool.update = { command }; }), /can run text it is given/, `update ${command.join(' ')} is accepted`);
  }
  // A status command that hands an interpreter, shell or wrapper a bare word runs a file or another program on every list.
  for (const command of [['python3', 'setup'], ['node', 'index'], ['nice', 'sh'], ['sh', 'x'], ['env', 'x'], ['npx', 'x'], ['deno', 'x'], ['osascript', 'x'], ['xargs', 'x'], ['exec', 'x'], ['time', 'x']]) {
    assert.match(errorsFor(command[0], (tool) => { tool.status = { commands: [command] }; }), /can run text it is given/, `status ${command.join(' ')} is accepted`);
  }
  // Those programs are version-only as an action too; a package installer on the list (npm, uv) is not one of them.
  for (const program of ['npx', 'bunx', 'pnpm', 'yarn', 'deno', 'php', 'lua', 'osascript', 'nice', 'nohup', 'xargs', 'time', 'command', 'exec']) {
    assert.equal(errorsFor(program, () => {}), '', `${program} --version stays accepted`);
    assert.match(errorsFor(program, (tool) => { tool.update = { command: [program, 'x'] }; }), /can run text it is given/, `update ${program} x is accepted`);
  }
  // An interpreter is version-only whatever it is given or how its name is spelled: no `-c` is needed to run code.
  const interpreters: string[][] = [['node', '--import=data:text/javascript,console.log(1)'], ['node', '--loader', 'data:text/javascript,1'], ['node', '--require=./x'], ['node', 'x.js'],
    ['python3', '-m', 'timeit', 'import os'], ['python3', '-m', 'pip', 'install', 'x'], ['python3.13t', '-c', '1'], ['pypy3', 'x.py'], ['nodejs', '-e', '1'], ['ruby3.2', '-e', '1'], ['perl5.34', '-e', '1'],
    ['bun', 'x.ts'], ['awk', 'BEGIN{system("id")}'], ['NODE.EXE', '-e', '1'], ['timeout', '5', 'sh', '-c', 'id'], ['arch', '-arm64', 'sh'], ['xcrun', 'sh']];
  for (const command of interpreters) {
    assert.equal(errorsFor(command[0], () => {}), '', `${command[0]} --version stays accepted`);
    assert.match(errorsFor(command[0], (tool) => { tool.update = { command }; }), /can run text it is given/, `update ${command.join(' ')} is accepted`);
    assert.match(errorsFor(command[0], (tool) => { tool.status = { commands: [command] }; }), /can run text it is given/, `status ${command.join(' ')} is accepted`);
  }
});

test('a known installer runs only its listed subcommands, as a route command and as an after step', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const errorsFor = (change: (tool: any) => void) => {
    const copy = structuredClone(registry);
    change(copy.externalTools.find((tool: any) => tool.id === 'bash'));
    return validateRegistry(copy, { repoRoot: REPO }).errors.join('\n');
  };
  const evidence = registry.externalTools.find((tool: any) => tool.id === 'bash').officialEvidence[0];
  const viaRoute = (command: string[]) => errorsFor((tool) => { tool.install = { routes: [{ installer: command[0], command, evidence }] }; });
  for (const command of [['npm', 'exec', '--', 'sh', '-c', 'id'], ['npm', 'x', '-c', 'id'], ['npm', 'run', 'x'], ['npm', 'init', 'x'], ['npm', '-g', 'install', 'x'], ['uv', 'run', 'python', '-c', '1'], ['uv', 'tool', 'run', 'x'],
    ['uv', 'x', 'y'], ['brew', 'ruby', '-e', '1'], ['brew', 'sh'], ['brew', 'irb'], ['brew', 'some-external-command'], ['pipx', 'run', 'pkg'], ['pipx', 'runpip', 'x', 'install'], ['cargo', 'run'], ['cargo', 'x'], ['apt-get', 'source', 'x']]) {
    assert.match(viaRoute(command), /can run a program or code it is given unless it is one of its listed subcommands/, `route ${command.join(' ')} is accepted`);
  }
  assert.match(errorsFor((tool) => { tool.install = { routes: [{ ...route(evidence), after: [['brew', 'ruby', '-e', '1']] }] }; }), /after\[0\]: a command starting with 'brew' can run a program or code/);
  for (const command of [['npm', 'install', '-g', 'x'], ['npm', 'uninstall', '-g', 'x'], ['brew', 'install', '--cask', 'x'], ['brew', 'install', 'ruby'], ['cargo', 'install', 'x'], ['uv', 'tool', 'install', 'x'], ['pipx', 'install', 'x']]) {
    assert.equal(viaRoute(command), '', `route ${command.join(' ')} is refused`);
  }
});

test('update and uninstall must handle what the managed install route installs', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const errorsFor = (change: (tool: any) => void) => {
    const copy = structuredClone(registry);
    change(copy.externalTools.find((tool: any) => tool.id === 'jq'));
    return validateRegistry(copy, { repoRoot: REPO }).errors.join('\n');
  };
  const evidence = registry.externalTools.find((tool: any) => tool.id === 'jq').officialEvidence[0];
  const own = 'jq';
  const npm = { installer: 'npm', command: ['npm', 'install', '-g', 'x'], evidence };
  // Same installer, or the tool's own binary (a self-update), agrees.
  assert.equal(errorsFor((tool) => { tool.install = { routes: [npm] }; tool.update = { command: ['npm', 'update', '-g', 'x'] }; tool.uninstall = { command: [own, 'remove'] }; }), '');
  // The first route of a platform is the managed one: update through another installer is a mismatch.
  assert.match(errorsFor((tool) => { tool.install = { routes: [route(evidence), npm] }; tool.update = { command: ['npm', 'update', '-g', 'x'] }; }), /update runs 'npm' but the managed install route on darwin uses 'brew'/);
  assert.match(errorsFor((tool) => { tool.install = { routes: [route(evidence), npm] }; tool.uninstall = { command: ['npm', 'uninstall', '-g', 'x'] }; }), /uninstall runs 'npm' but the managed install route on linux uses 'brew'/);
  // The check is per platform: brew is managed on darwin only, so a brew uninstall is a mismatch on linux alone.
  const perPlatform = errorsFor((tool) => { tool.install = { routes: [{ ...route(evidence), platforms: ['darwin'] }, npm] }; tool.uninstall = { command: ['brew', 'uninstall', 'x'] }; });
  assert.match(perPlatform, /uninstall runs 'brew' but the managed install route on linux uses 'npm'/);
  assert.doesNotMatch(perPlatform, /on darwin/);
  // A route may carry the pair that fits its platform.
  assert.equal(errorsFor((tool) => { tool.install = { routes: [{ ...route(evidence), platforms: ['darwin'], uninstall: { command: ['brew', 'uninstall', 'x'] } }, { ...npm, uninstall: { command: ['npm', 'uninstall', '-g', 'x'] } }] }; }), '');
});

test('every shipped install route keeps DoFlow from running anything that needs administrator rights', () => {
  const { externalTools } = loadRegistry({ repoRoot: REPO });
  const PRIVILEGE = ['sudo', 'doas', 'su'];
  let routes = 0;
  for (const tool of externalTools) {
    const list = tool.install?.routes || (tool.install ? [{ installer: tool.install.command[0], command: tool.install.command }] : []);
    for (const route of list) {
      routes += 1;
      const at = `${tool.id}: ${route.command.join(' ')}`;
      const wrapped = PRIVILEGE.includes(route.command[0]);
      assert.equal(route.privileged === true, wrapped, `${at}: privileged exactly when the command starts with a privilege word`);
      assert.equal(route.installer, wrapped ? route.command[1] : route.command[0], `${at}: installer is the program the command runs`);
      for (const step of route.after || []) assert.ok(!PRIVILEGE.includes(step[0]), `${at}: after step '${step.join(' ')}' must be manual`);
    }
    for (const action of ['update', 'uninstall']) {
      for (const contract of [tool[action], ...(tool.install?.routes || []).map((candidate: any) => candidate[action])].filter(Boolean)) {
        assert.ok(!PRIVILEGE.includes(contract.command[0]), `${tool.id}: ${action} must not start with a privilege word`);
      }
    }
  }
  assert.ok(routes >= 12, 'the walk reached the shipped routes');
});

test('selects only renderable harness assets and filters by capability', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const codex = selectAssets(registry, { harness: 'codex' });
  assert.ok(codex.some((asset: any) => asset.id === 'skills.doflow'));
  assert.ok(!codex.some((asset: any) => asset.id === 'modes.doflow'));
  assert.deepEqual(selectAssets(registry, { harness: 'codex', capability: 'skills' }).map((asset: any) => asset.id), ['skills.doflow']);
  assert.throws(() => selectAssets(registry, { harness: 'unknown' }), /Unknown registry harness/);
});

test('selects the neutral MCP catalog and rejects unknown selections', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.equal(selectMcpServers(registry).length, 2);
  assert.deepEqual(selectMcpServers(registry, ['context7', 'sequential-thinking']).map((item: any) => item.id), ['context7', 'sequential-thinking']);
  assert.throws(() => selectMcpServers(registry, ['unknown']), /Unknown registry MCP server/);
});

test('mcpCapable names every harness that takes the shared MCP catalog', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(registry.harnesses.map((item: any) => item.id).filter((id: any) => mcpCapable(registry, id)),
    activeIds());
  assert.throws(() => mcpCapable(registry, 'unknown'), /Unknown registry harness/);
});

test('generates capability-map records with evidence and explicit gaps', () => {
  const map = capabilityMapData(loadRegistry({ repoRoot: REPO }));
  const codexHooks = map.find((row: any) => row.harness === 'codex' && row.capability === 'hooks');
  assert.equal(codexHooks.status, 'supported');
  assert.ok(codexHooks.evidence.every((url: any) => url.startsWith('https://')));
});

test('fails closed for malformed JSON', (t) => {
  const root = tempDir(t, 'doflow-registry-');
  fs.mkdirSync(path.join(root, 'core', 'registry'), { recursive: true });
  for (const file of Object.values(REGISTRY_FILES)) fs.writeFileSync(path.join(root, 'core', 'registry', file), '{}');
  fs.writeFileSync(path.join(root, 'core', 'registry', 'harnesses.json'), '{not valid json');
  assert.throws(() => loadRegistry({ repoRoot: root }), /not valid JSON/);
});

test('rejects projections to unavailable capabilities and missing source files', () => {
  const registry = {
    harnesses: [{ id: 'test', displayName: 'Test', adapter: 'test', scopes: ['project'], nativeTargets: {}, capabilities: {
      hooks: { status: 'unavailable', evidence: ['https://example.test/docs'], verification: 'Report the gap.' },
    } }],
    assets: [{ id: 'bad.asset', kind: 'hook', source: 'missing', appliesTo: ['test'], projection: { test: { renderer: 'test', capability: 'hooks' } }, ownership: 'managed-file' }],
    mcp: [], lifecycle: [],
  };
  const result = validateRegistry(registry, { repoRoot: REPO });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /source does not exist/);
  assert.match(result.errors.join('\n'), /cannot render unavailable capability/);
});

test('fails closed when Codex native projection source metadata is missing or escapes the repository', () => {
  const registry = loadRegistry({ repoRoot: REPO });
  const invalid = structuredClone({ harnesses: registry.harnesses, assets: registry.assets, mcp: registry.mcp, lifecycle: registry.lifecycle });
  invalid.harnesses.find((harness: any) => harness.id === 'codex').nativeProjection.hooks.scriptsSource = '../outside';
  const result = validateRegistry(invalid, { repoRoot: REPO });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /nativeProjection hooks: source does not exist inside repository/);
});

// ---- 062 A.1: MCP steps/triggers, provider MCP descriptors, tool-name templates, dispatch tiers ----

const errorsOf = (mutate: any) => {
  const invalid = structuredClone(loadRegistry({ repoRoot: REPO }));
  mutate(invalid);
  const result = validateRegistry(invalid, { repoRoot: REPO });
  assert.equal(result.ok, false);
  return result.errors.join('\n');
};

test('the shipped registry declares a trigger and steps on every MCP server, and loads', () => {
  const { mcp } = loadRegistry({ repoRoot: REPO });
  for (const server of mcp) {
    assert.match(server.trigger, /^[^\n]{20,300}$/, `${server.id} trigger`);
    assert.ok(Array.isArray(server.steps), `${server.id} steps`);
  }
  assert.deepEqual(mcp.find((s: any) => s.id === 'context7').steps.map((s: any) => [s.skill, s.file, s.expectedWhen]),
    [
      ['do-brainstorm', 'SKILL.md', undefined],
      ['do-design', 'SKILL.md', undefined],
      ['do-document', 'references/embedded-research.md', 'research-request'],
      ['do-document', 'references/embedded-research.md', 'dependency-change'],
      ['do-diagnose', 'SKILL.md', 'dependency-change'],
      ['do-implement', 'SKILL.md', 'dependency-change'],
      ['do-code-review', 'SKILL.md', 'manifest-review'],
    ]);
  assert.deepEqual(mcp.find((s: any) => s.id === 'sequential-thinking').steps.map((s: any) => [s.skill, s.file]),
    [['do-brainstorm', 'SKILL.md'], ['do-design', 'SKILL.md']]);
});

test('MCP servers: a missing or malformed trigger or steps fails load naming the server', () => {
  const trigger = 'x'.repeat(40);
  assert.match(errorsOf((r: any) => { delete r.mcp[0].trigger; }), /MCP server 'context7': trigger/);
  assert.match(errorsOf((r: any) => { r.mcp[0].trigger = 'x'.repeat(301); }), /MCP server 'context7': trigger/);
  assert.match(errorsOf((r: any) => { r.mcp[0].trigger = 'short'; }), /MCP server 'context7': trigger/);
  assert.match(errorsOf((r: any) => { r.mcp[1].trigger = `${trigger}\n${trigger}`; }), /MCP server 'sequential-thinking': trigger/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps = 'do-design'; }), /MCP server 'context7': steps must be an array/);
  assert.match(errorsOf((r: any) => { delete r.mcp[0].steps; }), /MCP server 'context7': steps must be an array/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps[0].extra = true; }), /MCP server 'context7': .*unknown key 'extra'/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps[0].skill = ''; }), /MCP server 'context7': .*skill/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps[0].file = ''; }), /MCP server 'context7': .*file/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps.push({ ...r.mcp[0].steps[0] }); }), /MCP server 'context7': .*duplicate/);
  assert.match(errorsOf((r: any) => { r.mcp[0].steps[0].expectedWhen = 'always'; }), /MCP server 'context7': .*expectedWhen/);
  // An empty steps array is legal.
  const ok = structuredClone(loadRegistry({ repoRoot: REPO }));
  ok.mcp[1].steps = [];
  assert.equal(validateRegistry(ok, { repoRoot: REPO }).ok, true);
});

test('loadRegistry throws on a registry directory whose mcp.json lacks steps', (t) => {
  const root = tempDir(t, 'doflow-registry-steps-');
  fs.cpSync(path.join(REPO, 'core'), path.join(root, 'core'), { recursive: true });
  const file = path.join(root, 'core', 'registry', 'mcp.json');
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete doc.servers[0].steps;
  fs.writeFileSync(file, JSON.stringify(doc));
  assert.throws(() => loadRegistry({ repoRoot: root }), /MCP server 'context7': steps must be an array/);
});

test('capability providers: the two MCP-backed providers carry an mcp descriptor; a bad one fails', () => {
  const { capabilities } = loadRegistry({ repoRoot: REPO });
  const withMcp = Object.values(capabilities).flatMap((c: any) => c.providers).filter((p) => p.mcp);
  assert.deepEqual(withMcp.map((p) => [p.id, p.mcp]), [
    ['semble.search', { server: 'semble', tool: 'search' }],
    ['graphify.query', { server: 'graphify', tool: 'query_graph' }],
    ['graphify.query', { server: 'graphify', tool: 'query_graph' }],
  ]);
  const first = (r: any) => Object.values(r.capabilities).flatMap((c: any) => c.providers).find((p) => p.mcp);
  assert.match(errorsOf((r: any) => { first(r).mcp.server = ''; }), /provider 'semble.search'.*mcp\.server/);
  assert.match(errorsOf((r: any) => { first(r).mcp.tool = 'bad tool!'; }), /provider 'semble.search'.*mcp\.tool/);
  assert.match(errorsOf((r: any) => { delete first(r).mcp.tool; }), /provider 'semble.search'.*mcp\.tool/);
  assert.match(errorsOf((r: any) => { first(r).mcp = 'semble'; }), /provider 'semble.search'.*mcp must be an object/);
});

test('capability providers: every provider declares sourceMode live|index; a missing or bad one fails (068)', () => {
  const { capabilities } = loadRegistry({ repoRoot: REPO });
  const providers = Object.values(capabilities).flatMap((c: any) => c.providers);
  for (const provider of providers) assert.ok(['live', 'index'].includes(provider.sourceMode), `${provider.id} sourceMode`);
  assert.deepEqual([...new Set(providers.filter((p) => p.sourceMode === 'index').map((p) => p.id))].sort(), ['graphify.query', 'semble.search']);
  const first = (r: any) => (Object.values(r.capabilities)[0] as any).providers[0];
  assert.match(errorsOf((r: any) => { delete first(r).sourceMode; }), /provider 'native.rg'.*sourceMode is required.*live, index.*got nothing/);
  assert.match(errorsOf((r: any) => { first(r).sourceMode = 'cached'; }), /provider 'native.rg'.*sourceMode.*got "cached"/);
});

test('harness capabilities.mcp.toolName: claude declares a template; one lacking a placeholder fails', () => {
  const { harnesses } = loadRegistry({ repoRoot: REPO });
  assert.equal(harnesses.find((h: any) => h.id === 'claude').capabilities.mcp.toolName, 'mcp__{server}__{tool}');
  assert.equal(harnesses.filter((h: any) => h.capabilities.mcp?.toolName !== undefined).length, 1);
  const claude = (r: any) => r.harnesses.find((h: any) => h.id === 'claude').capabilities.mcp;
  assert.match(errorsOf((r: any) => { claude(r).toolName = 'mcp__{server}'; }), /harness 'claude'.*toolName/);
  assert.match(errorsOf((r: any) => { claude(r).toolName = 'mcp__{tool}'; }), /harness 'claude'.*toolName/);
  assert.match(errorsOf((r: any) => { claude(r).toolName = '{server}__{tool}__{other}'; }), /harness 'claude'.*toolName/);
  assert.match(errorsOf((r: any) => { claude(r).toolName = 7; }), /harness 'claude'.*toolName/);
});

test('models.json dispatchTiers: shipped values load; a default or owner tier outside tiers fails', () => {
  const { dispatchTiers } = loadRegistry({ repoRoot: REPO });
  assert.deepEqual(dispatchTiers, {
    tiers: ['light', 'standard', 'frontier'],
    default: 'standard',
    byOwner: { 'system-architect': 'frontier', 'core-implementer': 'standard', 'quality-guardian': 'standard', 'spec-analyst': 'standard', 'research-writer': 'standard', 'delivery-lead': 'frontier', reviewer: 'frontier' },
  });
  assert.match(errorsOf((r: any) => { r.dispatchTiers.default = 'heavy'; }), /dispatchTiers.*default/);
  assert.match(errorsOf((r: any) => { r.dispatchTiers.byOwner['core-implementer'] = 'heavy'; }), /dispatchTiers.*core-implementer/);
  assert.match(errorsOf((r: any) => { r.dispatchTiers.tiers = []; }), /dispatchTiers.*tiers/);
  assert.match(errorsOf((r: any) => { r.dispatchTiers.byOwner = []; }), /dispatchTiers.*byOwner/);
});
