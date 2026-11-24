'use strict';

// External-tool lifecycle coordination deliberately uses execFile-style argument vectors.
// Commands in the registry are data, never shell snippets, so neither inspection nor mutation
// needs interpolation or a shell process.
const { execFileSync, spawn, spawnSync } = require('node:child_process');

const SUPPORTED_PLATFORMS = new Set(['darwin', 'linux']);
// A status command or an installer probe that has not answered by then leaves the tool's state at
// `inspection-timeout`; a hung binary must not hold up the whole list. Install commands have no limit.
const INSPECTION_TIMEOUT_MS = 5000;

// What DoFlow runs is an allow-list, because a list of forbidden first words is never complete (`nice sudo x`,
// `npx sudo x`, `busybox sh -c ...`). A command DoFlow runs must start with the tool's own program or with its
// route's installer, the installer must be one of the names below, and no word of it may name a privilege word.
// The registry validator checks this and `executeToolLifecycle` checks it again just before it runs anything.
// Content that is only shown (`manual`, a `privileged` route, the alternatives) is free.
const PRIVILEGE_WORDS = new Set(['sudo', 'doas', 'su', 'pkexec', 'run0']);
/** The package managers a route may name as its installer, with why each is not itself a registered tool. */
const KNOWN_INSTALLERS: Record<string, string> = {
  brew: 'Homebrew, the package manager the macOS routes use; its own install page is the documentation',
  npm: 'ships with Node, which DoFlow itself runs on; the routes that install a Node tool use it',
  cargo: 'the Rust toolchain, the managed route for rtk',
  uv: 'Astral uv, the managed route for graphify and semble',
  pipx: 'the alternative Python installer for graphify and semble',
  'apt-get': 'the Debian and Ubuntu package manager; its routes are privileged and shown only',
};

/** The program a command runs, as a name: the last path segment (either separator), without a `.exe`/`.cmd`/`.bat` ending, in lower case. */
function programName(word: any): string {
  return String(word ?? '').split(/[\\/]/).pop()!.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

/** The first word of a command that names a privilege word (by name or by path), or null. */
function privilegeWord(command: any): string | null {
  for (const word of Array.isArray(command) ? command : []) if (PRIVILEGE_WORDS.has(programName(word))) return word;
  return null;
}

/** The tool's own program: what its first status command runs. */
function ownProgram(tool: any): string | undefined {
  return tool?.status?.commands?.[0]?.[0];
}

/** The programs a command of this tool may start with: its own, and the route's installer when that is a known one. */
function allowedPrograms(tool: any, installer?: string): Set<string> {
  const allowed = new Set<string>();
  const own = ownProgram(tool);
  if (typeof own === 'string') allowed.add(own);
  if (typeof installer === 'string' && Object.hasOwn(KNOWN_INSTALLERS, installer)) allowed.add(installer);
  return allowed;
}

// Programs that run whatever else they are handed: a shell, `env`, a package runner, a wrapper, an interpreter. Run only as
// `<program> --version`, as an action and as a status command alike. None of these is a KNOWN_INSTALLERS name, so a route's
// installer is never caught here; an installer is limited to the subcommands listed in INSTALLER_SUBCOMMANDS instead.
const RUNS_OTHER = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'tcsh', 'csh', 'busybox', 'cmd', 'powershell', 'pwsh', 'env',
  'npx', 'bunx', 'pnpm', 'yarn', 'deno', 'php', 'lua', 'osascript', 'nice', 'nohup', 'xargs', 'time', 'command', 'exec', 'timeout', 'arch', 'xcrun']);
// An interpreter by name family, with a version or a suffix (`python3.13t`, `pypy3`, `nodejs`, `ruby3.2`, `perl5.34`, `bun`, `gawk`).
// The list is not exhaustive; the allow-list above it (the tool's own program or its installer) is what bounds a command.
const INTERPRETERS = /^(python[\d.]*[a-z]*|pypy[\d.]*[a-z]*|node(js)?|ruby[\d.]*|perl[\d.]*|bun|g?awk|mawk|nawk)$/;

/** The subcommands DoFlow runs for each known installer, as the words after the program. Anything else is refused, which is
 * every subcommand that runs a program or code it is given (`npm exec`/`x`/`run`/`run-script`/`start`/`test`/`init`/`explore`,
 * `brew ruby`/`sh`/`irb`, `uv run`/`tool run`/`x`, `pipx run`/`runpip`, `cargo run`, an external `cargo <x>` or `brew <x>`). */
const INSTALLER_SUBCOMMANDS: Record<string, string[][]> = {
  brew: ['install', 'uninstall', 'remove', 'upgrade', 'reinstall', 'update', 'tap', 'untap', 'list', 'info'].map((word) => [word]),
  npm: ['install', 'i', 'add', 'uninstall', 'remove', 'rm', 'un', 'update', 'up', 'list', 'ls', 'view'].map((word) => [word]),
  cargo: ['install', 'uninstall'].map((word) => [word]),
  uv: [['tool', 'install'], ['tool', 'upgrade'], ['tool', 'uninstall'], ['tool', 'list'], ['pip', 'install'], ['pip', 'uninstall']],
  pipx: ['install', 'uninstall', 'upgrade', 'reinstall', 'list'].map((word) => [word]),
  'apt-get': ['install', 'remove', 'purge', 'update', 'upgrade'].map((word) => [word]),
};

/** A command that can run text it was handed: a shell, `env`, a package runner or wrapper, or an interpreter. Such a command is
 * only run as `<program> --version`, which runs nothing else (`python3 setup` would run the file `setup`; `node --import=data:...`,
 * `python3 -m timeit '<code>'` and `timeout 5 sh -c ...` run code with no `-c`). */
function runsGivenText(command: any): boolean {
  if (!Array.isArray(command) || !command.length) return false;
  const name = programName(command[0]);
  return RUNS_OTHER.has(name) || INTERPRETERS.test(name);
}

/** Why a known installer's command is not one of its listed subcommands, or null (not an installer, or listed). */
function installerRefusal(command: any): string | null {
  if (!Array.isArray(command) || !command.length) return null;
  const name = programName(command[0]);
  if (!Object.hasOwn(INSTALLER_SUBCOMMANDS, name) || (command.length === 2 && command[1] === '--version')) return null;
  const words = command.slice(1);
  if (INSTALLER_SUBCOMMANDS[name].some((prefix) => prefix.every((word, index) => words[index] === word))) return null;
  return `a command starting with '${command[0]}' can run a program or code it is given unless it is one of its listed subcommands (${INSTALLER_SUBCOMMANDS[name].map((prefix) => prefix.join(' ')).join(', ')}) as its first words, so DoFlow does not run it`;
}

/** Why DoFlow will not run this command, or null when it may. `allowed` is the set of programs it may start with. */
function refusalReason(command: string[], allowed: Set<string> | null = null): string | null {
  const word = privilegeWord(command);
  if (word !== null) return `a command naming '${word}' needs administrator rights, so DoFlow does not run it`;
  if (allowed && !allowed.has(command?.[0])) return `a command starting with '${command?.[0]}' is neither the tool's own program nor its installer (${[...allowed].join(', ') || 'none'}), so DoFlow does not run it`;
  if (runsGivenText(command) && !(command.length === 2 && command[1] === '--version')) return `a command starting with '${command[0]}' can run text it is given, so DoFlow runs it only as '${command[0]} --version'`;
  return installerRefusal(command);
}

/** A status command is the tool's program and one argument, a flag or a plain subcommand (`--version`, `-version`, `gain`):
 * it runs on every list with no confirmation, so it carries no further words. Returns why not, or null. */
function statusRefusal(command: string[], allowed: Set<string>): string | null {
  const reason = refusalReason(command, allowed);
  if (reason) return reason;
  if (!Array.isArray(command) || command.length !== 2 || !/^-{0,2}[A-Za-z][A-Za-z-]*$/.test(String(command[1]))) {
    return `a status command is the tool's program and one flag or subcommand (for example --version), so DoFlow does not run '${Array.isArray(command) ? command.join(' ') : command}'`;
  }
  return null;
}

// An implementation may answer at once or later; the default one answers later.
type ExecImpl = (file: string, args: string[], opts: any) => any;

function isSupportedPlatform(platform: string = process.platform): boolean {
  return SUPPORTED_PLATFORMS.has(platform);
}

function commandText(command: string[]): string {
  return command.map((part) => JSON.stringify(part)).join(' ');
}

/** A command as a person would type it: parts with spaces or shell characters are quoted, the rest are not. */
function plainCommand(command: string[]): string {
  return command.map((part) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(part) ? part : JSON.stringify(part))).join(' ');
}

/** Every process below `rootPid`, deepest first, from the process table. */
function descendantsOf(rootPid: number): number[] {
  const table = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (table.error || table.status !== 0) return [];
  const children = new Map<number, number[]>();
  for (const line of String(table.stdout).split('\n')) {
    const [pid, parent] = line.trim().split(/\s+/).map(Number);
    if (Number.isInteger(pid) && Number.isInteger(parent)) children.set(parent, [...(children.get(parent) ?? []), pid]);
  }
  const found: { pid: number; depth: number }[] = [];
  const walk = (pid: number, depth: number) => { for (const child of children.get(pid) ?? []) { found.push({ pid: child, depth }); walk(child, depth + 1); } };
  walk(rootPid, 1);
  return found.sort((a, b) => b.depth - a.depth).map((entry) => entry.pid);
}

/** End a probe and everything it started. POSIX: list the process table, kill the descendants leaves first (a parent
 * killed first would hide its children from the next listing), list again for one that forked meanwhile, then kill the
 * probe's process group (it leads its own) for anything that left the parent chain, and the probe. Windows:
 * `taskkill /T /F /PID` while the probe is still alive, so the tree is still linked (from its documentation; not run
 * on this machine). */
function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') { spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' }); return; }
  for (let pass = 0; pass < 3; pass += 1) {
    const victims = descendantsOf(pid);
    if (!victims.length) break;
    for (const victim of victims) { try { process.kill(victim, 'SIGKILL'); } catch { /* already gone */ } }
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* the group is already gone */ }
  try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

// A probe runs in its own process group (so the group can be ended whole), which a terminal's Ctrl-C does not signal. So
// while probes are alive DoFlow itself ends them on SIGINT, on SIGTERM and on any exit, then lets the signal take its course.
const liveProbes = new Set<any>();
function endLiveProbes(): void {
  for (const child of liveProbes) killTree(child.pid);
  liveProbes.clear();
}
function onSignal(signal: string): void {
  endLiveProbes();
  stopWatching();
  process.kill(process.pid, signal);
}
const onSigint = () => onSignal('SIGINT');
const onSigterm = () => onSignal('SIGTERM');
function stopWatching(): void {
  process.removeListener('SIGINT', onSigint);
  process.removeListener('SIGTERM', onSigterm);
  process.removeListener('exit', endLiveProbes);
}
function watchProbe(child: any): void {
  if (!liveProbes.size) { process.once('SIGINT', onSigint); process.once('SIGTERM', onSigterm); process.once('exit', endLiveProbes); }
  liveProbes.add(child);
}
function unwatchProbe(child: any): void {
  liveProbes.delete(child);
  if (!liveProbes.size) stopWatching();
}

/** The default probe: runs the program without a shell (in `opts.env` and `opts.cwd` when given), answers with its stdout, or rejects with an error whose `code` is
 * ENOENT (not found), ETIMEDOUT (no answer in `opts.timeout` ms; its whole process tree is ended by then) or EMAXBUFFER
 * (more than `opts.maxBuffer` bytes of stdout; the tree is ended and nothing is kept). */
function probeExec(file: string, args: string[], opts: any): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: any;
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    // Watched before it starts: a SIGINT or SIGTERM between the spawn and the watch would end DoFlow by the default action
    // and leave the probe's group running. A signal is handled only after this synchronous block, when the pid is known.
    const watched: { pid?: number } = {};
    watchProbe(watched);
    let child: any;
    try {
      child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', ...(opts?.env ? { env: opts.env } : {}), ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    } catch (error) {
      unwatchProbe(watched);
      throw error;
    }
    watched.pid = child.pid;
    const finish = (settle: (value: any) => void, value: any) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unwatchProbe(watched);
      settle(value);
    };
    if (opts?.timeout) {
      timer = setTimeout(() => {
        killTree(child.pid);
        const error: any = new Error(`${file} gave no answer within ${opts.timeout} ms`);
        error.code = 'ETIMEDOUT';
        finish(reject, error);
      }, opts.timeout);
    }
    let seen = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      seen += chunk.length;
      if (opts?.maxBuffer && seen > opts.maxBuffer) {
        killTree(child.pid);
        const error: any = new Error(`${file} wrote more than ${opts.maxBuffer} bytes`);
        error.code = 'EMAXBUFFER';
        finish(reject, error);
        return;
      }
      out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => { if (!opts?.maxBuffer || Buffer.concat(err).length < opts.maxBuffer) err.push(chunk); });
    child.on('error', (error: any) => finish(reject, error));
    child.on('close', (code: number | null) => {
      if (code === 0) { finish(resolve, Buffer.concat(out).toString('utf8')); return; }
      const error: any = new Error(`Command failed: ${file} ${args.join(' ')}${err.length ? `\n${Buffer.concat(err).toString('utf8')}` : ''}`);
      error.status = code;
      finish(reject, error);
    });
  });
}

function failureKind(error: any): 'absent' | 'timeout' | 'failed' {
  if (error?.code === 'ENOENT') return 'absent';
  return error?.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
}

/** One status check or probe. `allowed` limits what it may start with (a status check starts with the tool's own program). */
async function runInspection(command: string[], execImpl: ExecImpl, timeoutMs: number = INSPECTION_TIMEOUT_MS, allowed: Set<string> | null = null, status = false): Promise<any> {
  const refusal = status && allowed ? statusRefusal(command, allowed) : refusalReason(command, allowed);
  if (refusal) return { command: [...command], result: 'failed', error: refusal };
  try {
    const output = await execImpl(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe', timeout: timeoutMs });
    return { command: [...command], result: 'succeeded', output: output == null ? '' : String(output) };
  } catch (error: any) {
    return {
      command: [...command], result: failureKind(error),
      error: error?.message || String(error),
    };
  }
}

/** Reduce every status command result to a safe tool state. */
function normalizeToolState(inspections: any[]): string {
  if (inspections.every((inspection) => inspection.result === 'succeeded')) return 'installed';
  if (inspections.some((inspection) => inspection.result === 'timeout')) return 'inspection-timeout';
  if (inspections.every((inspection) => inspection.result === 'absent')) return 'absent';
  if (inspections.some((inspection) => inspection.result === 'succeeded')) return 'unknown';
  return 'inspection-failed';
}

async function inspectTool(tool: any, { execImpl = probeExec, timeoutMs = INSPECTION_TIMEOUT_MS }: { execImpl?: ExecImpl; timeoutMs?: number } = {}): Promise<any> {
  const allowed = allowedPrograms(tool);
  const inspections = await Promise.all(tool.status.commands.map((command: string[]) => runInspection(command, execImpl, timeoutMs, allowed, true)));
  return { state: normalizeToolState(inspections), inspections };
}

async function inspectPrerequisites(tool: any, { execImpl = probeExec, timeoutMs = INSPECTION_TIMEOUT_MS }: { execImpl?: ExecImpl; timeoutMs?: number } = {}): Promise<any[]> {
  return Promise.all((tool.prerequisites || []).map(async (name: string) => {
    const inspection = await runInspection([name, '--version'], execImpl, timeoutMs);
    return { name, available: inspection.result === 'succeeded', inspection };
  }));
}

/** Every way the registry knows to install a tool: its `routes`, or its single `command` as one route. */
function installRoutes(tool: any): any[] {
  if (!tool.install) return [];
  if (tool.install.routes) return tool.install.routes;
  return [{ installer: tool.install.command[0], command: tool.install.command, evidence: tool.officialEvidence[0] }];
}

/** A route as plain data for the plan and the report. */
function routeView(route: any): any {
  return {
    installer: route.installer,
    command: [...route.command],
    after: (route.after || []).map((step: string[]) => [...step]),
    manual: (route.manual || []).map((step: any) => ({ command: [...step.command], reason: step.reason })),
    privileged: route.privileged === true,
    evidence: route.evidence,
  };
}

/** The routes that fit a platform, in registry order. The first is the managed one. */
function routesFor(tool: any, platform: string): any[] {
  return installRoutes(tool).filter((route) => !route.platforms || route.platforms.includes(platform));
}

/**
 * The managed install route for this machine: the first route of its platform. It is the only route
 * DoFlow runs, because it is the one `update` and `uninstall` are registered to handle; every other
 * route of the platform comes back as an `alternative` to show, never to run. `isInstalled(name)` answers
 * whether an installer is present. Without a usable route the result says why and names the page.
 */
function chooseInstallRoute(tool: any, { platform = process.platform, isInstalled }: { platform?: string; isInstalled: (name: string) => boolean }): any {
  const docs = tool.officialEvidence[0];
  const [managed, ...others] = routesFor(tool, platform);
  if (!managed) return { reason: `no verified install command is registered for ${platform}; see ${docs}`, docs };
  const alternatives = others.map(routeView);
  if (isInstalled(managed.installer)) return { route: routeView(managed), alternatives };
  return { reason: `missing installer: needs ${managed.installer} on PATH; see ${docs}`, docs, alternatives };
}

/** `chooseInstallRoute`'s answer as plain data: the command chosen, or why there is none and where to read. */
function describeInstall(chosen: any): any {
  if (!chosen) return null;
  const { route, reason, docs } = chosen;
  const alternatives = chosen.alternatives?.length ? { alternatives: chosen.alternatives } : {};
  if (!route) return { command: null, reason, docs, ...alternatives };
  return { command: route.command, after: route.after, manual: route.manual, privileged: route.privileged, runnable: !route.privileged, evidence: route.evidence, ...alternatives };
}

/** What update or uninstall runs for this tool: the managed route's own command when it has one, else the tool's. */
function lifecycleContract(tool: any, action: string, platform: string): any {
  return action === 'install' ? tool.install : (routesFor(tool, platform)[0]?.[action] ?? tool[action]);
}

function actionEligibility(tool: any, state: string, action: string, prerequisites: any[], chosen: any = null, platform: string = process.platform, isInstalled: (name: string) => boolean = () => true): any {
  if (action === 'status') return { applicable: false, reason: 'status inspection only' };
  // update and uninstall handle what the managed route installed, and a route may carry its own pair.
  const contract = lifecycleContract(tool, action, platform);
  if (!contract) {
    return { applicable: false, reason: action === 'install' && chosen ? chosen.reason : `no verified ${action} command is registered` };
  }
  const missing = prerequisites.filter((prerequisite) => !prerequisite.available);
  if (missing.length) return { applicable: false, reason: `missing prerequisite: ${missing.map((item) => item.name).join(', ')}` };
  if (state === 'unknown' || state === 'inspection-failed' || state === 'inspection-timeout') {
    return { applicable: false, reason: `tool state is ${state}` };
  }
  if (action === 'install') {
    if (state !== 'absent') return { applicable: false, reason: 'tool is already installed' };
    if (!chosen.route) return { applicable: false, reason: chosen.reason };
    if (chosen.route.privileged) {
      return { applicable: false, reason: `needs administrator rights, so DoFlow does not run it; run it yourself: ${plainCommand(chosen.route.command)}` };
    }
    // Only the managed route is ever planned. Its steps that need administrator rights are `manual`: listed, never run.
    return { applicable: true, command: chosen.route.command, followUps: chosen.route.after, manual: chosen.route.manual, status: 'not-attempted' };
  }
  if (state !== 'installed') return { applicable: false, reason: 'tool is not installed' };
  // The command runs the installer that put the tool there (or the tool's own binary, a self-update); with that
  // installer gone it would fail with ENOENT, so say what install says: which installer is missing and where to read.
  const program = contract.command[0];
  if (program !== ownProgram(tool) && !isInstalled(program)) {
    return { applicable: false, reason: `missing installer: needs ${program} on PATH; see ${tool.officialEvidence[0]}` };
  }
  // The plan records a command before execution begins; callers can show this preview without
  // implying that it has run. executeToolLifecycle replaces this with a terminal result.
  return { applicable: true, command: [...contract.command], status: 'not-attempted' };
}

/**
 * Inspect all status command vectors, then create a non-mutating action plan. Every probe of one plan runs
 * side by side; the answer keeps the registry's order. The registry can be the loaded registry or an
 * { externalTools } fixture. An `execFileSyncImpl` may answer at once or return a promise.
 */
async function planToolLifecycle({ registry, action = 'status', platform = process.platform, execFileSyncImpl = probeExec, timeoutMs = INSPECTION_TIMEOUT_MS }: { registry?: any; action?: string; platform?: string; execFileSyncImpl?: ExecImpl; timeoutMs?: number } = {}): Promise<any> {
  if (!['install', 'update', 'uninstall', 'status'].includes(action)) {
    throw new Error(`Unsupported external-tool action '${action}'`);
  }
  const supported = isSupportedPlatform(platform);
  // One plan asks each distinct command once: two tools needing `uv` share one `uv --version`.
  const answers = new Map<string, Promise<{ value?: any; error?: any }>>();
  const execOnce: ExecImpl = async (file, args, opts) => {
    const key = JSON.stringify([file, ...args]);
    if (!answers.has(key)) {
      answers.set(key, Promise.resolve().then(() => execFileSyncImpl(file, args, opts)).then((value) => ({ value }), (error) => ({ error })));
    }
    const answer = await (answers.get(key) as Promise<{ value?: any; error?: any }>);
    if ('error' in answer) throw answer.error;
    return answer.value;
  };
  const tools = registry?.externalTools || [];
  // Round one: every tool's status commands and prerequisites at once.
  const inspected = await Promise.all(tools.map(async (tool: any) => {
    if (!supported) return { tool, state: 'unknown', inspections: [], prerequisites: [] };
    const [{ state, inspections }, prerequisites] = await Promise.all([
      inspectTool(tool, { execImpl: execOnce, timeoutMs }),
      inspectPrerequisites(tool, { execImpl: execOnce, timeoutMs }),
    ]);
    return { tool, state, inspections, prerequisites };
  }));
  // Round two: the installers those answers make relevant. An absent tool needs its managed route's installer; an
  // installed one needs the installer its update or uninstall command runs, unless that is the tool's own program.
  const wanted = new Set<string>();
  for (const { tool, state } of inspected) {
    if (!supported) break;
    if (state === 'absent') { const installer = routesFor(tool, platform)[0]?.installer; if (installer) wanted.add(installer); }
    if (state === 'installed' && (action === 'update' || action === 'uninstall')) {
      const program = lifecycleContract(tool, action, platform)?.command?.[0];
      if (program && program !== ownProgram(tool)) wanted.add(program);
    }
  }
  const present = new Set<string>();
  await Promise.all([...wanted].map(async (name) => { if ((await runInspection([name, '--version'], execOnce, timeoutMs)).result === 'succeeded') present.add(name); }));
  const isInstalled = (name: string): boolean => present.has(name);
  const results = inspected.map(({ tool, state, inspections, prerequisites }: any) => {
    if (!supported) {
      return {
        tool, state, inspections, prerequisites,
        action: { applicable: false, reason: `unsupported platform: ${platform}` },
      };
    }
    // Installers are probed only for a tool that is absent: a present tool needs no install route.
    const install = state === 'absent' ? chooseInstallRoute(tool, { platform, isInstalled }) : null;
    return { tool, state, inspections, prerequisites, install, action: actionEligibility(tool, state, action, prerequisites, install, platform, isInstalled) };
  });
  return { action, platform, supported, tools: results };
}

function defaultDisplay(command: string[]): void { console.error(`[INFO]  ${commandText(command)}`); }

/**
 * Display and separately confirm every planned mutation.  A failed command never prevents later
 * commands from being independently offered and executed.
 */
function executeToolLifecycle({ plan, execFileSyncImpl = execFileSync, displayCommand = defaultDisplay, confirmCommand }: { plan?: any; execFileSyncImpl?: ExecImpl; displayCommand?: (command: string[], tool?: any, action?: string) => void; confirmCommand?: (command: string[], tool?: any, action?: string) => boolean } = {}): any {
  if (!plan) throw new Error('executeToolLifecycle requires a plan');
  if (typeof confirmCommand !== 'function') throw new Error('executeToolLifecycle requires confirmCommand');

  const notAttempted = plan.tools
    .filter((item: any) => item.action.applicable)
    .map((item: any) => ({ tool: item.tool.id, status: 'not-attempted', command: [...item.action.command] }));
  const results = [];
  for (const item of plan.tools) {
    const action = item.action;
    if (!plan.supported || !action.applicable) {
      results.push({ tool: item.tool.id, status: 'skipped', reason: action.reason });
      continue;
    }
    const run = (command: string[]): any => {
      // The registry validator rejects these too; this stays as the last line before the runner, for a registry it never saw.
      const refusal = refusalReason(command, allowedPrograms(item.tool, routesFor(item.tool, plan.platform)[0]?.installer));
      if (refusal) return { status: 'refused', command: [...command], reason: refusal };
      displayCommand([...command], item.tool, plan.action);
      if (!confirmCommand([...command], item.tool, plan.action)) return { status: 'declined', command: [...command] };
      try {
        const output = execFileSyncImpl(command[0], command.slice(1), { encoding: 'utf8', stdio: 'pipe' });
        return { status: 'succeeded', command: [...command], output: output == null ? '' : String(output) };
      } catch (error: any) {
        return { status: 'failed', command: [...command], error: error?.message || String(error) };
      }
    };
    const result: any = { tool: item.tool.id, ...run(action.command) };
    // A step that follows the install (a browser download, say) is shown and confirmed on its own,
    // and only after the install command itself succeeded; the first one that does not succeed ends the chain.
    if (result.status === 'succeeded' && action.manual?.length) result.manual = action.manual;
    if (result.status === 'succeeded' && action.followUps?.length) {
      result.followUps = [];
      for (const step of action.followUps) {
        const outcome = run(step);
        result.followUps.push(outcome);
        if (outcome.status !== 'succeeded') break;
      }
    }
    results.push(result);
  }
  return { action: plan.action, notAttempted, results };
}

// Deliberately no plan-then-execute convenience wrapper. One existed and nothing called it: the
// only caller, `doflow tools`, plans and executes as two steps precisely so a confirmation lands
// between them (`src/cli/commands/tools.ts` refuses `--force` for that reason). A single call that
// did both would be the one code path able to run an install command unconfirmed, so the gap is
// the safety property rather than an omission to fill.
module.exports = {
  SUPPORTED_PLATFORMS,
  INSPECTION_TIMEOUT_MS,
  probeExec,
  PRIVILEGE_WORDS,
  KNOWN_INSTALLERS,
  programName,
  privilegeWord,
  ownProgram,
  allowedPrograms,
  refusalReason,
  statusRefusal,
  isSupportedPlatform,
  commandText,
  plainCommand,
  installRoutes,
  chooseInstallRoute,
  describeInstall,
  normalizeToolState,
  inspectTool,
  inspectPrerequisites,
  planToolLifecycle,
  executeToolLifecycle,
};
