'use strict';

// Every external binary DoFlow's own scripts rely on is either registered in
// core/registry/external-tools.json or named, with the reason, in the short allow-list below.
// `doflow tools` and `doflow doctor` can only tell a person what to install for a tool the registry
// knows; a script that starts probing a new binary without registering it leaves the gap silent.
//
// Scanned: every `command -v <binary>`, `which <binary>` and `type <binary>` (in command position, not in a comment) in the shell scripts the package ships (core/ and src/, the
// `.sh` files plus the extensionless `doflow-run`), and every binary a render-*.sh script runs
// in an `if <binary> ...` step, plus the draw.io binary the projector render-drawio.sh calls.
//
// The registry itself is read the same way: every installer, prerequisite and first command word in
// external-tools.json (install, after, manual, update, uninstall, status), and the command of every
// server in mcp.json, must be a registered tool or a name in INSTALLER_NOT_REGISTERED with its reason.
//
// The capability providers (`binary`, `checkCommand` in core/registry/capabilities.json) and the harness CLIs
// (`worker.cli.binary` in core/registry/harnesses.json) are read the same way. A harness CLI is not a tool DoFlow
// installs, so those names share one allow-list reason. `primaryProbe` in harnesses.json names no binary.
//
// A failing guard means the registry or the allow-list is stale: add the tool to the registry, or the
// binary to the allow-list with its reason. Do not delete the scan.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const { loadRegistry } = require('../../src/registry/index.ts');
const { KNOWN_INSTALLERS } = require('../../src/install/tool-lifecycle.ts');

// Probed with `command -v` and deliberately not registered: DoFlow degrades without them or they ship with the OS.
const PROBED_NOT_REGISTERED: Record<string, string> = {
  shasum: 'checksum, with sha256sum as the other spelling; one of the two ships with the OS',
  sha256sum: 'checksum, with shasum as the other spelling; one of the two ships with the OS',
  timeout: 'optional wrapper, GNU coreutils; the script runs without it',
  gtimeout: 'the same wrapper under its Homebrew coreutils name',
  setsid: 'optional detach wrapper from util-linux; the hook runs without it',
  cmp: 'POSIX utility; the script falls back to a shell comparison',
  perl: 'clock fallback in doflow-run when date has no nanoseconds; seconds are used without it',
  node: 'the runtime DoFlow itself runs on, not a tool a person installs for DoFlow',
  doflow: 'DoFlow itself',
  ruff: 'the project own Python linter, run by the stop check only when the project uses it',
  eslint: 'the project own JavaScript linter, run by the stop check only when the project uses it',
  gofmt: 'the project own Go formatter, run by the stop check only when the project uses it',
};
// Run by a render-*.sh step and not probed with `command -v`: a POSIX utility, not a tool to register.
const RUN_NOT_REGISTERED: Record<string, string> = {
  grep: 'POSIX utility used to test a file in the render scripts',
};
// The harness CLIs named by core/registry/harnesses.json. The person installs the AI tool they run DoFlow in; DoFlow does not.
const HARNESS_CLI_REASON = 'a harness CLI (the AI coding tool DoFlow runs in), installed by the person who uses that harness, not by DoFlow';
const HARNESS_CLIS = ['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro-cli', 'agy'];
// Words that open an `if` condition in shell without being a program to install.
const SHELL_WORDS = new Set(['command', 'test', 'cat', 'printf', 'echo', 'read', 'type']);

// Programs the registry or the MCP registry runs or names that are installed by the platform or are the means
// of installing, not tools DoFlow offers to install.
// The package managers a route may name are the validator's own list (KNOWN_INSTALLERS in src/install/tool-lifecycle.ts), read here so
// there is one list; npx is how the MCP servers launch, and sudo starts a privileged route that DoFlow only shows.
const INSTALLER_NOT_REGISTERED: Record<string, string> = {
  ...KNOWN_INSTALLERS,
  npx: 'ships with npm; the MCP servers in mcp.json are launched with it',
  sudo: 'a privileged route starts with it; DoFlow never runs such a step, it is shown to the person',
  ...Object.fromEntries(HARNESS_CLIS.map((binary) => [binary, HARNESS_CLI_REASON])),
};

function shippedScripts(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.sh') || entry.name === 'doflow-run') found.push(full);
    }
  };
  for (const root of ['core', 'src']) walk(path.join(REPO, root));
  return found.sort();
}
const read = (file: string) => fs.readFileSync(file, 'utf8');

/** Binaries a script probes: `command -v <literal>` anywhere, and `which <literal>` or `type <literal>` where a command
 * starts (line start, after ; & | ( ! $( || if then elif), never in a comment line. A variable (`command -v "$x"`) names none. */
function scanProbes(text: string): string[] {
  const found: string[] = [];
  for (const [, binary] of text.matchAll(/command -v ["']?([A-Za-z][A-Za-z0-9._-]*)["']?/g)) found.push(binary);
  const code = text.split('\n').filter((line) => !/^\s*#/.test(line)).join('\n');
  for (const [, binary] of code.matchAll(/(?:^|[;&|(!]|\$\(|\b(?:if|then|elif))\s*(?:which|type)\s+(?:-[A-Za-z]+\s+)?["']?([A-Za-z][A-Za-z0-9._-]*)["']?/gm)) found.push(binary);
  return found;
}

function probedBinaries(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of shippedScripts()) {
    for (const binary of scanProbes(read(file))) if (!out.has(binary)) out.set(binary, path.relative(REPO, file));
  }
  return out;
}

/** Binaries a render-*.sh script runs as the head of an `if` condition, directly or in `if ! x="$(bin ...`. */
function renderRunBinaries(): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of shippedScripts().filter((candidate) => /render-[a-z]+\.sh$/.test(candidate))) {
    for (const [, binary] of read(file).matchAll(/^\s*(?:if|elif)\s+!?\s*(?:[A-Za-z_]+="\$\()?([a-z][a-z0-9._-]*)\s/gm)) {
      if (!SHELL_WORDS.has(binary) && !out.has(binary)) out.set(binary, path.relative(REPO, file));
    }
  }
  // The export step of render-drawio.sh runs in src/runtime/drawio-project.ts: `process.env.DOFLOW_DRAWIO || '<binary>'`.
  const projector = path.join(REPO, 'src', 'runtime', 'drawio-project.ts');
  const drawio = read(projector).match(/process\.env\.DOFLOW_DRAWIO \|\| '([^']+)'/);
  assert.ok(drawio, 'src/runtime/drawio-project.ts must still pick its binary from DOFLOW_DRAWIO || <default>');
  out.set(drawio[1], path.relative(REPO, projector));
  return out;
}

/** Every program the external-tools registry names, with where it was named: installer, prerequisite or first command word. */
function registryWords(): Map<string, string> {
  const { externalTools, mcp } = loadRegistry({ repoRoot: REPO });
  const out = new Map<string, string>();
  const note = (word: any, where: string) => { if (typeof word === 'string' && !out.has(word)) out.set(word, where); };
  const command = (value: any, where: string) => { if (Array.isArray(value?.command ?? value)) note((value.command ?? value)[0], where); };
  for (const tool of externalTools) {
    for (const status of tool.status.commands) command(status, `${tool.id} status`);
    for (const prerequisite of tool.prerequisites ?? []) note(prerequisite, `${tool.id} prerequisite`);
    for (const key of ['update', 'uninstall']) if (tool[key]) command(tool[key], `${tool.id} ${key}`);
    for (const route of tool.install ? (tool.install.routes ?? [tool.install]) : []) {
      note(route.installer, `${tool.id} installer`);
      command(route.command, `${tool.id} install`);
      for (const step of route.after ?? []) command(step, `${tool.id} after`);
      for (const step of route.manual ?? []) command(step, `${tool.id} manual`);
      for (const key of ['update', 'uninstall']) if (route[key]) command(route[key], `${tool.id} ${key}`);
    }
  }
  for (const server of mcp) note(server.command, `mcp server ${server.id}`);
  // Capability providers and harness CLIs, read from the files themselves.
  const json = (name: string) => JSON.parse(read(path.join(REPO, 'core', 'registry', name)));
  for (const capability of Object.values(json('capabilities.json').capabilities) as any[]) {
    for (const provider of capability.providers ?? []) {
      note(provider.binary, `capability provider ${provider.id} binary`);
      command(provider.checkCommand, `capability provider ${provider.id} checkCommand`);
    }
  }
  for (const harness of json('harnesses.json').harnesses) note(harness.worker?.cli?.binary, `harness ${harness.id} worker.cli.binary`);
  return out;
}

const registered = () => new Set<string>(loadRegistry({ repoRoot: REPO }).externalTools.map((tool: any) => tool.status.commands[0][0]));

test('the probe scan finds command -v, which and type in command position and ignores prose and comments', () => {
  const sample = ['# which zzcomment is used', 'echo "which one"', 'if which zzwhich >/dev/null; then', '  x=$(type -p zztype)', 'cmd && type zzand', 'command -v zzcv', 'command -v "$var"'].join('\n');
  assert.deepEqual(scanProbes(sample).sort(), ['zzand', 'zzcv', 'zztype', 'zzwhich']);
});

test('the scan sees what it is meant to see, so an empty result cannot pass', () => {
  const probed = probedBinaries();
  for (const binary of ['jq', 'mmdc', 'plantuml', 'perl', 'doflow', 'shasum', 'ruff']) assert.ok(probed.has(binary), `command -v ${binary} is no longer found`);
  const run = renderRunBinaries();
  for (const binary of ['mmdc', 'plantuml', 'drawio']) assert.ok(run.has(binary), `${binary} is no longer found as a render step`);
});

test('every binary probed with command -v is registered or allow-listed with its reason', () => {
  const known = registered();
  const unknown = [...probedBinaries()].filter(([binary]) => !known.has(binary) && !(binary in PROBED_NOT_REGISTERED))
    .map(([binary, file]) => `${binary} (probed in ${file})`);
  assert.deepEqual(unknown, [], 'register these in core/registry/external-tools.json, or allow-list them with a reason');
});

test('every binary a render script runs is registered or allow-listed with its reason', () => {
  const known = registered();
  const unknown = [...renderRunBinaries()].filter(([binary]) => !known.has(binary) && !(binary in PROBED_NOT_REGISTERED) && !(binary in RUN_NOT_REGISTERED))
    .map(([binary, file]) => `${binary} (run in ${file})`);
  assert.deepEqual(unknown, [], 'register these in core/registry/external-tools.json, or allow-list them with a reason');
});

test('the allow-list holds no entry the scripts stopped using, and none the registry now carries', () => {
  const probed = probedBinaries();
  const run = renderRunBinaries();
  const known = registered();
  assert.deepEqual(Object.keys(PROBED_NOT_REGISTERED).filter((binary) => !probed.has(binary)), [], 'allow-listed but no longer probed');
  assert.deepEqual(Object.keys(RUN_NOT_REGISTERED).filter((binary) => !run.has(binary)), [], 'allow-listed but no longer run by a render script');
  assert.deepEqual([...Object.keys(PROBED_NOT_REGISTERED), ...Object.keys(RUN_NOT_REGISTERED)].filter((binary) => known.has(binary)), [], 'allow-listed but now registered');
});

test('every installer, prerequisite, command word and MCP server command in the registries is registered or allow-listed with its reason', () => {
  const known = registered();
  const words = registryWords();
  assert.ok(words.size > 8 && words.has('npx'), 'the registry read found too little, so an empty result cannot pass');
  const unknown = [...words].filter(([word]) => !known.has(word) && !(word in INSTALLER_NOT_REGISTERED)).map(([word, where]) => `${word} (${where})`);
  assert.deepEqual(unknown, [], 'register these in core/registry/external-tools.json, or allow-list them in INSTALLER_NOT_REGISTERED with a reason');
  const named = new Set(words.keys());
  assert.deepEqual(Object.keys(INSTALLER_NOT_REGISTERED).filter((word) => !named.has(word)), [], 'allow-listed but no longer named by a registry');
  assert.deepEqual(Object.keys(INSTALLER_NOT_REGISTERED).filter((word) => known.has(word)), [], 'allow-listed but now registered');
});
