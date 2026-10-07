'use strict';
// cli-e2e.test.js — spawns the real bin/doflow.js CLI against scratch $HOMEs. Complements the
// unit tests (which exercise src/* modules directly) by covering the actual command wiring in
// bin/doflow.js: flag parsing, dispatch, and the full install -> update -> rollback lifecycle.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, "../..");
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const { IS_WIN, expectExecutable } = require('../helper-platform');
const { createScratch } = require('../helper/scratch-env');

// The per-harness MCP cases run in a scratch HOME with its own XDG folder and git config: nothing the
// developer's environment sets (XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL, DOFLOW_RETENTION_HOURS) reaches them.
const SCRATCHES = new Map();
after(() => { for (const scratch of SCRATCHES.values()) scratch.remove(); });

function scratchHome() {
  const scratch = createScratch('doflow-cli-e2e-');
  SCRATCHES.set(scratch.home, scratch);
  return scratch.home;
}

function inheritedEnv(home) {
  const scratch = SCRATCHES.get(home);
  if (!scratch) return process.env;
  const env = scratch.env();
  delete env.DOFLOW_RETENTION_HOURS;
  return env;
}

// A developer's own PI_CODING_AGENT_DIR would redirect Pi's user-scope mcp.json away from the
// scratch HOME; the Pi case that needs it sets it explicitly for its own spawn.
delete process.env.PI_CODING_AGENT_DIR;

/** Scratch-$HOME env for a spawned CLI. os.homedir() prefers USERPROFILE on Windows and ignores
 * HOME there entirely, so both must be redirected or -g installs would land in the runner's real
 * profile instead of the scratch directory. */
function homeEnv(home) {
  return IS_WIN ? { HOME: home, USERPROFILE: home } : { HOME: home };
}

function run(args, { home, input, env } = {}) {
  const resolvedHome = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  return spawnSync('node', [DOFLOW, ...args], {
    cwd: REPO,
    env: { ...inheritedEnv(resolvedHome), ...env, ...homeEnv(resolvedHome) },
    // Reply "no" explicitly for prompt-abort cases. An empty input can leave the test worker's
    // non-blocking pseudo-TTY attached and make the CLI retry EAGAIN as if a user were typing.
    input: input || '\n',
    encoding: 'utf8',
    // Once kiro also carries the runtime, `status --json` over several harnesses prints more than
    // the 1 MiB default on macOS temporary paths, and spawnSync fails with ENOBUFS.
    maxBuffer: 16 * 1024 * 1024,
  });
}

function fakeBin(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-tools-bin-'));
  for (const [name, body] of Object.entries(files)) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(file, 0o755);
  }
  return dir;
}

function toolEnv(bin, extra = {}) {
  // Keep Node and /bin/sh reachable for the spawned test CLI and fake scripts, but deliberately
  // exclude the developer's PATH so an installed RTK/Graphify cannot affect fixture outcomes.
  return { ...extra, PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin` };
}

function runInteractive(args, { home, env, replies }) {
  return new Promise((resolve, reject) => {
    const resolvedHome = home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
    const child = require('node:child_process').spawn('node', [DOFLOW, ...args], {
      cwd: REPO,
      env: { ...inheritedEnv(resolvedHome), ...env, ...homeEnv(resolvedHome) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let sent = 0;
    const sendReplies = () => {
      const prompts = (stdout.match(/\[y\/N\] /g) || []).length;
      while (sent < prompts && sent < replies.length) child.stdin.write(`${replies[sent++]}\n`);
      if (sent === replies.length) child.stdin.end();
    };
    child.stdout.on('data', (chunk) => { stdout += chunk; sendReplies(); });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}

// The tools fixtures are POSIX-bound by construction: fakeBin writes `#!/bin/sh` scripts and
// toolEnv builds a colon-separated PATH ending in /usr/bin:/bin. Windows can neither exec a
// shebang script nor interpret that PATH, so the whole class is skipped there rather than
// silently exercising nothing.
function skipToolsOnWin(t) {
  if (IS_WIN) t.skip('tools fixtures require #!/bin/sh scripts and a POSIX PATH');
  return !IS_WIN;
}

test('tools status selects both registered tools and returns one JSON result per tool', (t) => {
  if (!skipToolsOnWin(t)) return;
  const bin = fakeBin({
    rtk: 'case "$1" in --version|gain) exit 0;; *) exit 1;; esac',
    graphify: 'test "$1" = "--version"',
    uv: 'test "$1" = "--version"',
  });
  const r = run(['tools', '--tool', 'rtk,graphify', '--json'], { env: toolEnv(bin) });
  assert.strictEqual(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.action, 'status');
  assert.deepStrictEqual(result.results.map((item) => item.tool), ['rtk', 'graphify']);
  assert.deepStrictEqual(result.results.map((item) => item.result.status), ['skipped', 'skipped']);
});

test('tools rejects --force and requires --tool outside an interactive terminal', () => {
  const forced = run(['tools', '--tool', 'rtk', '--force']);
  assert.strictEqual(forced.status, 1);
  assert.match(forced.stderr, /--force is not supported/);

  const omitted = run(['tools']);
  assert.strictEqual(omitted.status, 1);
  assert.match(omitted.stderr, /--tool is required when stdin is not an interactive terminal/);
});

test('tools --dry-run inspects and plans mutations without executing them', (t) => {
  if (!skipToolsOnWin(t)) return;
  const bin = fakeBin({
    uv: 'test "$1" = "--version"',
  });
  const r = run(['tools', '--tool', 'rtk,graphify', '--action', 'install', '--dry-run', '--json'], { env: toolEnv(bin) });
  assert.strictEqual(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.dryRun, true);
  assert.deepStrictEqual(result.results.map((item) => item.result.status), ['not-attempted', 'not-attempted']);
  assert.deepStrictEqual(result.results.map((item) => item.result.command), [
    ['cargo', 'install', '--git', 'https://github.com/rtk-ai/rtk', '--branch', 'master', 'rtk'],
    ['uv', 'tool', 'install', 'graphifyy'],
  ]);
});

test('tools reports a declined lifecycle action without executing it', (t) => {
  if (!skipToolsOnWin(t)) return;
  const bin = fakeBin({});
  const r = run(['tools', '--tool', 'rtk', '--action', 'install'], { env: toolEnv(bin), input: 'n\n' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /RTK \(Rust Token Killer\): "cargo" "install"/);
  assert.match(r.stdout, /rtk: declined/);
});

test('tools continues independently when one confirmed lifecycle command fails', async (t) => {
  if (!skipToolsOnWin(t)) return;
  const bin = fakeBin({
    rtk: 'case "$1" in --version|gain) exit 0;; *) exit 1;; esac',
    graphify: 'test "$1" = "--version"',
    uv: 'if test "$1" = "--version"; then exit 0; fi\nif test "$1" = "tool" && test "$2" = "uninstall"; then exit 0; fi\nexit 1',
    cargo: 'exit 7',
  });
  const r = await runInteractive(['tools', '--tool', 'rtk,graphify', '--action', 'uninstall'], {
    env: toolEnv(bin), replies: ['y', 'y'],
  });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stdout, /rtk: failed/);
  assert.match(r.stdout, /graphify: succeeded/);
});

test('--no-backup without --force is a hard error (exit 1), for install and update alike', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r1 = run(['install', '--no-backup', '-g', '--target', 'claude'], { home });
  assert.strictEqual(r1.status, 1);
  assert.match(r1.stderr, /--no-backup skips all backup protection and requires --force/);

  const r2 = run(['update', '--no-backup', '-g', '--target', 'claude'], { home });
  assert.strictEqual(r2.status, 1);
});

test('--no-backup without --force is now a hard error for every command, not just install/update', () => {
  // Regression test: the check used to only run inside cmdInstall/cmdUpdate; sync.sh's
  // validate_env() runs it once before dispatching to any operation, including --status.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['status', '--no-backup', '-g'], { home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--no-backup skips all backup protection and requires --force/);
});

test('--target and --prune reject a following flag as their value instead of silently swallowing it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r1 = run(['install', '--target', '--no-backup', '-g', '--force'], { home });
  assert.strictEqual(r1.status, 1);
  assert.match(r1.stderr, /--target requires a value/);

  const r2 = run(['install', '--prune', '--force', '-g'], { home });
  assert.strictEqual(r2.status, 1);
  assert.match(r2.stderr, /--prune requires a number/);
});

test("rollback only restores --target's tools, even when the chosen backup also contains other tools' data", () => {
  // Regression test: restoreBackup used to loop over every tool present in the backup dir
  // regardless of --target, while the pre-rollback safety snapshot only covered --target's
  // tools — so a tool the snapshot didn't cover could get silently overwritten by rollback.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  // First install: $HOME/.claude, .codex don't exist yet, so this install's own backup is empty
  // (nothing to snapshot) — same "nothing to back up" case noted in workflow_doflow-cli.md.
  let r = run(['install', '-g', '--force', '--target', 'claude,codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // Second install snapshots the now-existing (clean) install before re-syncing over it — this
  // backup actually contains both claude.tar.gz and codex.tar.gz.
  r = run(['install', '-g', '--force', '--target', 'claude,codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const codexFile = path.join(home, '.codex', 'agents', 'code-reviewer.md');
  fs.writeFileSync(codexFile, 'mutated codex content');

  r = run(['list-backups', '-g'], { home });
  // listBackups sorts newest-first, so the first row is the second install's backup — the one
  // with real claude+codex content (the first install's own backup was empty, nothing pre-existed).
  const ids = [...r.stdout.matchAll(/install_[\d_-]+/g)].map((m) => m[0]);
  const bid = ids[0];
  assert.ok(bid, `expected install_* backup ids (contains both claude and codex data):\n${r.stdout}`);

  // This backup's directory has both claude.tar.gz and codex.tar.gz — restoring it unscoped
  // would silently revert the codex mutation. Restoring it scoped to claude must leave codex alone.
  r = run(['rollback', bid, '-g', '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(codexFile, 'utf8'), 'mutated codex content', 'rollback --target claude must not touch codex, even though the backup contains codex data');
});

test('install without --force waits on confirm and aborts when stdin is empty', () => {
  const r = run(['install', '-g', '--target', 'claude'], { input: '' });
  // Exit 1: a declined prompt is a decision, not a completed run. This asserted 0 until the D.4
  // sweep found that `doflow install <path>` in a script printed "Aborted.", wrote nothing, and
  // reported success — the assertion had pinned the observed value rather than the stated intent,
  // which is "waits on confirm and aborts".
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /Aborted/);
});

test('project-scoped install (no -g, no path) resolves under cwd, not $HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  const r = run(['install', projectDir, '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(projectDir, '.claude', 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.doflow', '.install-manifest.json')));
  assert.ok(!fs.existsSync(path.join(projectDir, '.claude', '.install-manifest.json')));
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'must not also write to $HOME');
});

test('Codex install merges AGENTS.md and installs reusable skills', () => {  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const codexDir = path.join(home, '.codex');
  fs.mkdirSync(codexDir, { recursive: true });
  fs.writeFileSync(path.join(codexDir, 'AGENTS.md'), '# Project instructions\n\nPreserve this content.\n');

  const r = run(['install', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const agents = fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8');
  assert.match(agents, /Preserve this content\./);
  // Codex has no native @file import expansion, so its managed section is a prose pointer into
  // the shared .doflow/guidance/ tree rather than the full merged guidance content.
  assert.match(agents, /\.doflow\/guidance\/DOFLOW_CORE\.md/);
  assert.ok(fs.existsSync(path.join(home, '.doflow', 'guidance', 'rules', 'RULE_01_SAFETY.md')));
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, '.doflow', 'scripts', 'doflow', 'bash', 'do-paths.sh')));
  assert.ok(fs.existsSync(path.join(home, '.doflow', 'templates', 'doflow', 'plan-template.md')));

  fs.writeFileSync(path.join(codexDir, 'AGENTS.md'), agents.replace('.doflow/guidance/DOFLOW_CORE.md', 'stale managed instructions'));
  const update = run(['update', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(update.status, 0, update.stderr);
  const updatedAgents = fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8');
  assert.match(updatedAgents, /Preserve this content\./);
  assert.match(updatedAgents, /\.doflow\/guidance\/DOFLOW_CORE\.md/);
});

test('full lifecycle: install -> mutate -> update -> rollback restores the pre-update dst content', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');

  let r = run(['install', '-g', '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // A fresh install's CLAUDE.md is already exactly doflow's marked section, verbatim (no user
  // content yet) — see src/helper/marker-merge.js.
  const cleanContent = fs.readFileSync(claudeMd, 'utf8');

  fs.writeFileSync(claudeMd, 'mutated by test\n');
  const past = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(claudeMd, past, past);
  const mutatedContent = fs.readFileSync(claudeMd, 'utf8');

  r = run(['update', '-g', '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // CLAUDE.md is merge-managed, not mirrored: mutatedContent has no doflow markers, so update
  // must treat it as foreign content and APPEND doflow's section after it (not overwrite it) —
  // that's the whole point of this feature. mutatedContent ends with exactly one "\n", so the
  // separator-normalization rule (src/helper/marker-merge.js) adds exactly one more before the
  // section.
  const expectedAfterUpdate = `${mutatedContent}\n${cleanContent}`;
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), expectedAfterUpdate, 'update should append doflow\'s section after the foreign (unmarked) content, not overwrite it');

  r = run(['list-backups', '-g'], { home });
  const bid = /update_[\d_-]+/.exec(r.stdout)?.[0];
  assert.ok(bid, `expected an update_* backup id in list-backups output:\n${r.stdout}`);

  r = run(['rollback', bid, '-g', '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), mutatedContent, 'rollback should restore the pre-update (mutated) content');
});

test('status --json emits parseable JSON with the manifest', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['status', '-g', '--json'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.manifest.operation, 'install');
  assert.strictEqual(parsed.context.scope, 'global');
});

test('status reports a harness the ledger owns nothing of as not-installed, in JSON and text', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const parsed = JSON.parse(run(['status', '-g', '--json', '--target', 'claude,codex'], { home }).stdout);
  assert.strictEqual(parsed.context.claude.status, 'verified');
  assert.strictEqual(parsed.context.codex.status, 'not-installed');
  assert.deepStrictEqual(parsed.context.codex.resources, []);
  const text = run(['status', '-g', '--target', 'claude,codex'], { home });
  assert.match(text.stdout, /Codex verification:\s+not-installed/);
  assert.match(text.stdout, /Claude verification:\s+verified/);
});

test('status keeps a conflict ahead of not-installed: a user-owned file in the way, or ledger rows lost over edited files', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), '# personal setting\n[features]\nhooks = false\n');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  let parsed = JSON.parse(run(['status', '-g', '--json', '--target', 'claude,codex'], { home }).stdout);
  assert.strictEqual(parsed.context.codex.status, 'conflict-or-invalid');
  assert.ok(parsed.context.codex.errors.length > 0);

  const skill = path.join(home, '.claude', 'skills', 'do-brainstorm', 'SKILL.md');
  fs.rmSync(path.join(home, '.doflow', 'state', 'ledger.json'));
  fs.writeFileSync(skill, '# my own file\n');
  parsed = JSON.parse(run(['status', '-g', '--json', '--target', 'claude'], { home }).stdout);
  assert.strictEqual(parsed.context.claude.status, 'conflict-or-invalid');
});

test('rollback with an unknown id fails cleanly (exit 1, no crash)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['rollback', 'no_such_backup', '-g', '--force'], { home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Backup not found/);
});

test('install --dry-run previews files and writes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['install', '-g', '--dry-run', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // Every Claude asset is registry-owned as of Phase E — the legacy copier's per-file preview
  // lines are gone; the registry lifecycle's own preview line is the real signal now.
  assert.match(r.stdout, /\[DRY\] Registry lifecycle: \d+ native change\(s\)/);
  assert.match(r.stdout, /Dry run complete/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'dry-run must not create any files');
});

test('update --dry-run previews changed files and writes nothing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, 'mutated\n');
  const past = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(claudeMd, past, past);

  const r = run(['update', '-g', '--dry-run', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /\[DRY\]/);
  assert.match(r.stdout, /Dry run complete/);
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), 'mutated\n', 'dry-run update must not touch the file');
});

test('update --dry-run when already up to date reports so and exits before the dry-run branch', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['update', '-g', '--dry-run', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Already up to date/);
});

test('a second update with no upstream change is a true no-op for CLAUDE.md (idempotent merge)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  const bytesAfterInstall = fs.readFileSync(claudeMd, 'utf8');

  const r = run(['update', '-g', '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Already up to date/, 'nothing changed, including CLAUDE.md\'s marked section, so this must not run the write/backup path');
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), bytesAfterInstall, 'CLAUDE.md bytes must be untouched by a no-op update');
});

test('status (text, no --json) prints the resolved context and install status table', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['status', '-g'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[CONTEXT\] Resolved install context/);
  assert.match(r.stdout, /Install Status/);
  assert.match(r.stdout, /Last operation:\s+install/);
  assert.match(r.stdout, /claude\s+installed/);
});

test('status (text, no --json) before any install warns no manifest found', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['status', '-g'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /No install manifest found/);
});

test('list-backups with none present reports "No backups found" instead of an empty table', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['list-backups', '-g'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /No backups found/);
});

test('rollback --dry-run (no --force) does not block on the confirm prompt', () => {
  // Regression test: cmdRollback used to call confirm() unconditionally, even under --dry-run,
  // unlike install/update (which skip the prompt entirely when previewing). That meant a
  // non-interactive `rollback <id> --dry-run` would abort as if the user answered "no" (or hang
  // waiting on a TTY), instead of behaving like a no-op preview. Feeding empty stdin here proves
  // the dry-run path no longer depends on an answer to that prompt.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const listed = run(['list-backups', '-g'], { home });
  const bid = /install_[\d_-]+/.exec(listed.stdout)?.[0];
  assert.ok(bid, `expected an install_* backup id:\n${listed.stdout}`);

  const r = run(['rollback', bid, '-g', '--dry-run'], { home, input: '' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run complete/);
  assert.ok(!/Aborted/.test(r.stderr), 'dry-run rollback must not be treated as aborted by an empty confirm answer');
});

test('Codex-native lifecycle supports isolated project dry-run, selected MCP update, and verifiable ownership', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));

  let r = run(['install', project, '--dry-run', '--target', 'codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Registry lifecycle: \d+ native change\(s\), 0 conflict\(s\)/);
  assert.match(r.stdout, /\[DRY\]\s+codex: \d+ change\(s\)/);
  assert.match(r.stdout, /codex hooks trust: review-required \(review required in codex\)/);
  assert.ok(!fs.existsSync(path.join(project, '.codex')), 'Codex dry-run must not create project config');

  r = run(['install', project, '--force', '--target', 'codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const config = path.join(project, '.codex', 'config.toml');
  assert.match(fs.readFileSync(config, 'utf8'), /\[features\]\nhooks = true/);
  assert.match(fs.readFileSync(config, 'utf8'), /\[mcp_servers\.context7\]/);
  expectExecutable(fs, path.join(project, '.codex', 'hooks', 'session-start.sh'), 'deployed codex hook script');
  assert.ok(fs.existsSync(path.join(project, '.codex', 'agents', 'system-architect.toml')));

  r = run(['update', project, '--force', '--target', 'codex', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const updated = fs.readFileSync(config, 'utf8');
  assert.doesNotMatch(updated, /mcp_servers\.context7/);
  assert.match(updated, /mcp_servers\.sequential-thinking/);

  r = run(['status', project, '--target', 'codex', '--json'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  assert.strictEqual(status.codex.status, 'verified');
  assert.strictEqual(status.codex.hooks.status, 'installed-pending');
  assert.deepStrictEqual(status.codex.hooks.prerequisites, ['trusted-project', 'hook-review']);
  assert.ok(status.codex.resources.some((resource) => resource.kind === 'mcp-server' && resource.identity === 'sequential-thinking'));
});

test('status --json reports the general per-harness hook-wiring status for claude, codex, gemini, and kiro', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));

  let r = run(['install', project, '--force', '--target', 'claude,codex,gemini,kiro', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['status', project, '--target', 'claude,codex,gemini,kiro', '--json'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);

  assert.deepStrictEqual(status.context.claude.hooks, { status: 'active', prerequisites: [] });
  assert.deepStrictEqual(status.context.kiro.hooks, { status: 'active', prerequisites: [] });
  assert.strictEqual(status.codex.hooks.status, 'installed-pending');
  assert.deepStrictEqual(status.codex.hooks.prerequisites, ['trusted-project', 'hook-review']);
  assert.strictEqual(status.context.gemini.hooks.status, 'installed-pending');
  assert.ok(status.context.gemini.hooks.prerequisites.length > 0);
});

test('Codex reconciliation preserves foreign config and fails closed on a conflicting managed key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const codex = path.join(home, '.codex');
  fs.mkdirSync(codex, { recursive: true });
  const config = path.join(codex, 'config.toml');
  const foreign = '# personal setting\n[features]\nhooks = false\n';
  fs.writeFileSync(config, foreign);

  const r = run(['install', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /exists but is not owned by DoFlow/);
  assert.strictEqual(fs.readFileSync(config, 'utf8'), foreign, 'foreign TOML must remain byte-for-byte intact');
});

test('Codex dry-run and status expose the non-mutating registry lifecycle and neutral state location', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  const dry = run(['install', project, '--dry-run', '--target', 'codex', '--mcp', 'context7'], { home });
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Registry lifecycle: \d+ native change\(s\), 0 conflict\(s\)/);
  // The CLI echoes the state root joined with native separators (path.join in src/lifecycle/view.js),
  // so the expected path is built — and escaped whole — the same way rather than assuming '/'.
  const stateRoot = path.join(project, '.doflow', 'state');
  assert.match(dry.stdout, new RegExp(`Neutral state: ${stateRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.ok(!fs.existsSync(path.join(project, '.doflow')), 'dry planning must not create neutral state');

  const status = run(['status', project, '--target', 'codex', '--json'], { home });
  assert.strictEqual(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.strictEqual(parsed.context.registry.ledgerPresent, false);
  assert.strictEqual(parsed.context.registry.stateRoot, path.join(project, '.doflow', 'state'));
  assert.ok(parsed.context.registry.plan.changes > 0);
});

test('Codex remove clears only lifecycle-owned native resources and retains compatibility assets', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  let result = run(['install', project, '--force', '--target', 'codex', '--mcp', 'context7'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  // A genuinely foreign, untracked file the user placed themselves — unlike a doflow-shipped
  // asset, this can never become lifecycle-owned by a later migration phase, so it's a durable
  // "remove never broadly deletes" example (as of Phase E, every doflow-shipped Codex asset is
  // lifecycle-owned; there is no longer an unmigrated compatibility asset to point at instead).
  const foreignFile = path.join(project, '.codex', 'notes.txt');
  fs.mkdirSync(path.dirname(foreignFile), { recursive: true });
  fs.writeFileSync(foreignFile, 'my own notes\n');
  result = run(['remove', project, '--force', '--target', 'codex'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  const ledger = JSON.parse(fs.readFileSync(path.join(project, '.doflow', 'state', 'ledger.json'), 'utf8'));
  assert.deepStrictEqual(ledger.resources, []);
  assert.ok(!fs.existsSync(path.join(project, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')), 'skills are lifecycle-owned and must be removed');
  assert.equal(fs.readFileSync(foreignFile, 'utf8'), 'my own notes\n', 'a foreign file never owned by doflow must survive remove untouched');
  // Nothing DoFlow wrote is left behind: no shipped hook script, no emptied AGENTS.md, no
  // config.toml holding only the table DoFlow's own key lived in.
  assert.ok(!fs.existsSync(path.join(project, '.codex', 'hooks')), 'shipped hook scripts and their emptied directory are removed');
  assert.ok(!fs.existsSync(path.join(project, 'AGENTS.md')), 'an AGENTS.md DoFlow created is removed, not left empty');
  assert.ok(!fs.existsSync(path.join(project, '.codex', 'config.toml')), 'a config.toml DoFlow created is removed, not left with an empty table');
});

test('Codex remove with a duplicated span in AGENTS.md is refused before anything is removed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  let result = run(['install', project, '--force', '--target', 'codex'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  const agents = path.join(project, 'AGENTS.md');
  fs.appendFileSync(agents, `\n${fs.readFileSync(agents, 'utf8')}`);
  const ledgerFile = path.join(project, '.doflow', 'state', 'ledger.json');
  const ledgerBefore = fs.readFileSync(ledgerFile, 'utf8');
  result = run(['remove', project, '--force', '--target', 'codex'], { home });
  assert.notStrictEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /malformed DoFlow markers/);
  for (const rel of [path.join('.codex', 'hooks.json'), path.join('.codex', 'config.toml'), path.join('.codex', 'hooks', 'session-start.sh'),
    path.join('.agents', 'skills', 'do-execute-plan', 'SKILL.md')]) {
    assert.ok(fs.existsSync(path.join(project, rel)), `${rel} must survive a refused remove`);
  }
  assert.strictEqual(fs.readFileSync(ledgerFile, 'utf8'), ledgerBefore);
});

test('Codex project remove rooted at HOME leaves every file the global install still owns', () => {
  // A project rooted at $HOME shares ~/.codex, ~/.agents and the one ledger with the global install.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let result = run(['install', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  result = run(['install', home, '--force', '--target', 'codex'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  const globalOwned = ['hooks.json', 'config.toml', path.join('hooks', 'session-start.sh'), path.join('bin', 'doflow-run')]
    .map((rel) => path.join(home, '.codex', rel));
  const before = globalOwned.map((file) => fs.readFileSync(file, 'utf8'));
  result = run(['remove', home, '--force', '--target', 'codex'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /codex: retained \d+ shared resource\(s\) still claimed by codex \(global scope\)/);
  assert.deepStrictEqual(globalOwned.map((file) => fs.readFileSync(file, 'utf8')), before);
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')), 'global skills survive');
  assert.ok(!fs.existsSync(path.join(home, 'AGENTS.md')), 'the project-only AGENTS.md is still removed');
  const ledger = JSON.parse(fs.readFileSync(path.join(home, '.doflow', 'state', 'ledger.json'), 'utf8'));
  assert.ok(ledger.resources.length > 0 && ledger.resources.every((resource) => resource.scope === 'global'), 'only the project rows are released');
});

test('Codex remove keeps a user hook script, AGENTS.md line and config.toml table byte for byte', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  const agents = path.join(project, 'AGENTS.md');
  const config = path.join(project, '.codex', 'config.toml');
  const userAgents = '# My project rules\n';
  const userConfig = '[profile]\nmodel = "mine"\n';
  fs.writeFileSync(agents, userAgents);
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, userConfig);
  let result = run(['install', project, '--force', '--target', 'codex', '--mcp', 'context7'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  const userHook = path.join(project, '.codex', 'hooks', 'my-hook.sh');
  fs.writeFileSync(userHook, '#!/bin/sh\necho mine\n');
  // A shipped script the user edited is theirs now and stays too.
  const editedHook = path.join(project, '.codex', 'hooks', 'session-start.sh');
  fs.appendFileSync(editedHook, '# my tweak\n');
  const editedBytes = fs.readFileSync(editedHook, 'utf8');
  result = run(['remove', project, '--force', '--target', 'codex'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.strictEqual(fs.readFileSync(agents, 'utf8'), userAgents);
  assert.strictEqual(fs.readFileSync(config, 'utf8'), userConfig);
  assert.strictEqual(fs.readFileSync(userHook, 'utf8'), '#!/bin/sh\necho mine\n');
  assert.strictEqual(fs.readFileSync(editedHook, 'utf8'), editedBytes);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(userHook)).sort(), ['my-hook.sh', 'session-start.sh']);
});

test('rollback with no id argument prompts interactively and accepts a typed backup id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const listed = run(['list-backups', '-g'], { home });
  const bid = /install_[\d_-]+/.exec(listed.stdout)?.[0];
  assert.ok(bid, `expected an install_* backup id:\n${listed.stdout}`);

  const r = run(['rollback', '-g', '--force'], { home, input: `${bid}\n` });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Rollback to .* complete/);
});

test('rollback with no id argument and empty stdin aborts instead of restoring', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['rollback', '-g', '--force'], { home, input: '' });
  // Exit 1: a declined prompt is a decision, not a completed run. This asserted 0 until the D.4
  // sweep found that `doflow install <path>` in a script printed "Aborted.", wrote nothing, and
  // reported success — the assertion had pinned the observed value rather than the stated intent,
  // which is "waits on confirm and aborts".
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /Aborted/);
});

test('update without --force waits on confirm and aborts when stdin is empty', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, 'mutated\n');
  fs.utimesSync(claudeMd, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));

  const r = run(['update', '-g', '--target', 'claude'], { home, input: '' });
  // Exit 1: a declined prompt is a decision, not a completed run. This asserted 0 until the D.4
  // sweep found that `doflow install <path>` in a script printed "Aborted.", wrote nothing, and
  // reported success — the assertion had pinned the observed value rather than the stated intent,
  // which is "waits on confirm and aborts".
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /Aborted/);
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), 'mutated\n', 'aborted update must not touch the file');
});

test('rollback with an explicit id but no --force aborts on an empty confirm answer, without restoring', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const listed = run(['list-backups', '-g'], { home });
  const bid = /install_[\d_-]+/.exec(listed.stdout)?.[0];
  assert.ok(bid, `expected an install_* backup id:\n${listed.stdout}`);

  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, 'should survive an aborted rollback\n');

  const r = run(['rollback', bid, '-g'], { home, input: '' });
  // Exit 1: a declined prompt is a decision, not a completed run. This asserted 0 until the D.4
  // sweep found that `doflow install <path>` in a script printed "Aborted.", wrote nothing, and
  // reported success — the assertion had pinned the observed value rather than the stated intent,
  // which is "waits on confirm and aborts".
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /Aborted/);
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), 'should survive an aborted rollback\n');
});

test('--prune keeps only the N most recent backups on both install and update', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  for (let i = 0; i < 3; i++) {
    const r = run(['install', '-g', '--force', '--target', 'claude', '--prune', '1'], { home });
    assert.strictEqual(r.status, 0, r.stderr);
  }
  let listed = run(['list-backups', '-g'], { home });
  assert.strictEqual((listed.stdout.match(/install_[\d_-]+/g) || []).length, 1, 'install --prune 1 must keep exactly one backup');

  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, 'mutated\n');
  fs.utimesSync(claudeMd, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  const r = run(['update', '-g', '--force', '--target', 'claude', '--prune', '1'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /Pruned \d+ old backup\(s\)/);

  listed = run(['list-backups', '-g'], { home });
  assert.strictEqual((listed.stdout.match(/(install|update)_[\d_-]+/g) || []).length, 1, '--prune 1 on update must also keep exactly one backup total');
});

// Three regression tests formerly here ("a missing bin/mappings.conf fails every command
// cleanly...", "update rejects a traversing CLAUDE.md destination...", "update skips a missing
// CLAUDE.md source...") protected the legacy mappings.conf-driven copier (readMappings/
// installTool/diffFiles/resolveManagedInstructionUpdates), deleted entirely in Phase I once every
// asset it copied became adapter-owned via the registry/lifecycle path. The safety properties they
// covered — rejecting a traversing or missing asset source, and failing cleanly rather than with a
// raw stack trace — are now enforced earlier and more strongly at registry load time; see
// test/registry/registry.test.js's "rejects projections to unavailable capabilities and missing source
// files" test.

test('--mcp <list> on global install merges only the selected servers into ~/.claude.json, not .claude/.mcp.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'context7,sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['context7', 'sequential-thinking']);
  assert.ok(!fs.existsSync(path.join(home, '.claude', '.mcp.json')), 'Claude Code never reads .claude/.mcp.json — it must not be written there');
});

test('--mcp <list> on project-scoped install writes <projectRoot>/.mcp.json, not <projectRoot>/.claude/.mcp.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  const r = run(['install', projectDir, '--force', '--no-backup', '--target', 'claude', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const mcpJson = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(mcpJson.mcpServers), ['sequential-thinking']);
  assert.ok(!fs.existsSync(path.join(projectDir, '.claude', '.mcp.json')));
});

test('an install with no --mcp flag (non-interactive, piped stdin) selects none — safe by default', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /MCP: none selected by default/);
  // An empty selection with nothing owned leaves ~/.claude.json unwritten.
  const file = path.join(home, '.claude.json');
  const claudeJson = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers ?? {}).sort(), [], 'third-party servers are opt-in');
});

test('--mcp all adopts the full catalog; the notice is absent when a selection is explicit', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /MCP: none selected by default/);
  const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['context7', 'sequential-thinking']);
});

test('update with no --mcp flag remembers the prior install\'s selection instead of reverting to all servers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['update', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers), ['context7'], 'update must not silently re-add servers a prior install deliberately excluded');
});

test('update with an explicit --mcp overrides and re-persists the remembered selection', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['update', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  let claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['sequential-thinking']);

  // A later update with no --mcp must now remember THIS selection, not the original install's.
  r = run(['update', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['sequential-thinking']);
});

test('update --dry-run for an MCP-only change claims a backup exactly when the real run creates one', () => {
  // Regression test: the dry-run branch used to print "Would create partial backup" whenever
  // --no-backup was absent, regardless of whether the real run would back anything up.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['update', '-g', '--force', '--dry-run', '--target', 'claude', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const claimed = /Would create partial backup/.test(r.stdout);

  r = run(['update', '-g', '--force', '--target', 'claude', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const listed = run(['list-backups', '-g'], { home });
  assert.strictEqual(/update_/.test(listed.stdout), claimed, `the dry run's backup claim must match the real run:\n${listed.stdout}`);
});

test('an update whose only change is a Claude MCP entry backs up nothing, so no copy of ~/.claude.json exists to restore', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const file = path.join(home, '.claude.json');
  fs.writeFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), numStartups: 7 }, null, 2)}\n`);

  r = run(['update', '-g', '--force', '--target', 'claude', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const claudeJson = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers), ['sequential-thinking']);
  assert.strictEqual(claudeJson.numStartups, 7, 'Claude Code\'s own state is untouched');

  assert.ok(!/update_/.test(run(['list-backups', '-g'], { home }).stdout), 'an MCP-only update creates no backup');
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  assert.deepStrictEqual(walk(home).filter((f) => path.basename(f) === '.claude.json'), [file], 'no backup holds a copy of ~/.claude.json');
});

test('--mcp on install rejects an unknown server name with a clear message', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'not-a-real-server'], { home });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Unknown MCP server\(s\): not-a-real-server/);
});

test('doflow status reports the persisted MCP server selection', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'context7,sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['status', '-g', '--json', '--target', 'claude,codex,gemini'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  assert.deepStrictEqual(status.mcpSelections, { claude: ['context7', 'sequential-thinking'], codex: null },
    'each MCP-capable target reports its own doflow.lock row, null when it has none; gemini takes no servers');

  r = run(['status', '-g', '--target', 'claude,codex,gemini'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}MCP selections: {7}claude context7, sequential-thinking; codex not recorded$/m);
});

test('T1: --mcp help says the default is none and reaches every harness that takes MCP servers', () => {
  const r = run(['--help'], { home: scratchHome() });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /--mcp <list> {5}Comma-separated MCP server names, or all or none, for every targeted/);
  assert.match(r.stdout, /or the servers an\s+installed harness already has/, 'an installed harness with no recorded selection keeps what it has');
  assert.match(r.stdout, /harness that takes MCP servers \(all but gemini\)\. Default: none, or the/);
  assert.doesNotMatch(r.stdout, /default: all|Applies to Claude and Codex/);
});

// --- Multi-harness lifecycle wiring (claude/codex/gemini all reconcile through the same
// registry/lifecycle path — see bin/doflow.js's unified `lifecycleView`) ---------------------

test('Claude lifecycle: fresh install owns the instructions asset in the neutral ledger with unchanged CLAUDE.md bytes', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  const r = run(['install', project, '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // Claude now owns its instructions asset plus every copy-tree asset (rules, skills, agents,
  // templates, scripts, modes, references, hooks scripts) and claude.settings — well over 1,
  // unlike before the registry migration covered anything beyond the instructions file.
  assert.match(r.stdout, /\[INFO\] claude: lifecycle verified \((\d+) owned resource\(s\)\)/);
  const ownedCount = Number(r.stdout.match(/lifecycle verified \((\d+) owned resource/)[1]);
  assert.ok(ownedCount > 50, `expected well over 50 owned Claude resources once copy-tree/settings assets are included, got ${ownedCount}`);

  const claudeMd = path.join(project, '.claude', 'CLAUDE.md');
  const content = fs.readFileSync(claudeMd, 'utf8');
  // A fresh install has no foreign content to preserve, so CLAUDE.md must be exactly doflow's
  // marker span around the pointer source's own content, byte for byte — CLAUDE.md's managed
  // section is a short pointer into .doflow/guidance/, not the full guidance content anymore.
  const MARKER_START = '<!-- doflow:start — content below is managed by doflow install/update; edits here are overwritten on the next run -->';
  const MARKER_END = '<!-- doflow:end -->';
  const pointerMd = fs.readFileSync(path.join(REPO, 'core', 'shared', 'guidance', 'pointers', 'claude-gemini.md'), 'utf8').replace(/\s+$/, '');
  assert.strictEqual(content, `${MARKER_START}\n${pointerMd}\n${MARKER_END}\n`);
  assert.ok(fs.existsSync(path.join(project, '.doflow', 'guidance', 'DOFLOW_CORE.md')), 'canonical guidance mirror must exist under .doflow/');
  assert.ok(fs.existsSync(path.join(project, '.doflow', 'guidance', 'rules', 'RULE_01_SAFETY.md')));
  assert.ok(!fs.existsSync(path.join(project, '.claude', 'rules')), 'rules must no longer be duplicated into .claude/');

  const ledger = JSON.parse(fs.readFileSync(path.join(project, '.doflow', 'state', 'ledger.json'), 'utf8'));
  const owned = ledger.resources.filter((resource) => resource.harness === 'claude');
  assert.strictEqual(owned.length, ownedCount);
  const instructionResource = owned.find((resource) => resource.assetId === 'guidance.core');
  assert.strictEqual(instructionResource.target, claudeMd);
  // Spot-check that copy-tree and settings assets are genuinely ledger-owned now, not just the
  // instructions file — the actual point of this phase's migration.
  assert.ok(owned.some((resource) => resource.assetId === 'skills.doflow'), 'skills.doflow must be ledger-owned');
  assert.ok(owned.some((resource) => resource.assetId === 'claude.settings'), 'claude.settings must be ledger-owned');
  assert.ok(fs.existsSync(path.join(project, '.claude', 'skills', 'do-diagnose', 'SKILL.md')));
});

test('Gemini lifecycle: fresh install writes GEMINI.md (not AGENTS.md) and owns it in the neutral ledger', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  const r = run(['install', project, '--force', '--target', 'gemini'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // Gemini now owns its instructions asset plus five copy-tree assets (rules, skills, agents,
  // modes, references) under .agents/ (project scope) — well over 1, unlike before Phase C.
  assert.match(r.stdout, /\[INFO\] gemini: lifecycle verified \((\d+) owned resource\(s\)\)/);
  const ownedCount = Number(r.stdout.match(/lifecycle verified \((\d+) owned resource/)[1]);
  assert.ok(ownedCount > 30, `expected well over 30 owned Gemini resources once copy-tree assets are included, got ${ownedCount}`);

  const geminiMd = path.join(project, 'GEMINI.md');
  assert.ok(fs.existsSync(geminiMd), 'GEMINI.md must be written by the Gemini adapter');
  const content = fs.readFileSync(geminiMd, 'utf8');
  assert.match(content, /<!-- doflow:start -->/);
  assert.match(content, /<!-- doflow:end -->/);
  assert.ok(!fs.existsSync(path.join(project, 'AGENTS.md')), 'Gemini must no longer write AGENTS.md (mappings.conf mapping removed)');

  const ledger = JSON.parse(fs.readFileSync(path.join(project, '.doflow', 'state', 'ledger.json'), 'utf8'));
  const owned = ledger.resources.filter((resource) => resource.harness === 'gemini');
  assert.strictEqual(owned.length, ownedCount);
  const instructionResource = owned.find((resource) => resource.target === geminiMd);
  assert.ok(instructionResource, 'GEMINI.md must be ledger-owned');
  assert.ok(owned.some((resource) => resource.assetId === 'skills.doflow'), 'skills.doflow must be ledger-owned');
  assert.ok(owned.some((resource) => resource.assetId === 'agents.shared'), 'agents.shared must be ledger-owned');
  assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', 'do-diagnose', 'SKILL.md')));
  // Gemini CLI discovers a custom subagent as a flat <name>.md under .gemini/agents.
  assert.ok(fs.existsSync(path.join(project, '.gemini', 'agents', 'system-architect.md')));
});

test('Claude lifecycle: remove strips only the managed section from CLAUDE.md, preserves foreign content, and updates the ledger', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  let r = run(['install', project, '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const claudeMd = path.join(project, '.claude', 'CLAUDE.md');
  const managedOnly = fs.readFileSync(claudeMd, 'utf8');
  fs.writeFileSync(claudeMd, `# My own notes\n\n${managedOnly}`);

  r = run(['remove', project, '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const after = fs.readFileSync(claudeMd, 'utf8');
  assert.match(after, /# My own notes/, 'foreign content outside the marker span must survive remove');
  assert.ok(!after.includes('<!-- doflow:start'), 'the managed section must be gone after remove');

  const ledger = JSON.parse(fs.readFileSync(path.join(project, '.doflow', 'state', 'ledger.json'), 'utf8'));
  assert.ok(!ledger.resources.some((resource) => resource.harness === 'claude'), 'claude resource must be removed from the ledger');
});

test("Gemini lifecycle: remove deletes GEMINI.md per the adapter's own remove() semantics, updating the ledger", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  let r = run(['install', project, '--force', '--target', 'gemini'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const geminiMd = path.join(project, 'GEMINI.md');
  assert.ok(fs.existsSync(geminiMd));

  r = run(['remove', project, '--force', '--target', 'gemini'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // Unlike Claude's marker-only removal, the Gemini adapter's remove() deletes the whole
  // owned file — this test locks in that documented adapter behavior, not a section-only edit.
  assert.ok(!fs.existsSync(geminiMd), "Gemini's remove() deletes the whole managed file");

  const ledger = JSON.parse(fs.readFileSync(path.join(project, '.doflow', 'state', 'ledger.json'), 'utf8'));
  assert.ok(!ledger.resources.some((resource) => resource.harness === 'gemini'), 'gemini resource must be removed from the ledger');
});

test('mixed -t claude,codex,gemini: install, update, and remove all reconcile in one invocation without cross-harness interference', () => {
  // Global scope (matching the existing "already up to date" convergence tests): a project-scoped
  // Claude install also rewrites settings.json's hook paths to ${CLAUDE_PROJECT_DIR} after the
  // copy, which is an orthogonal, pre-existing legacy-path concern unrelated to this lifecycle
  // wiring — global scope keeps this test focused on the three harnesses' lifecycle convergence.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let r = run(['install', '-g', '--force', '--target', 'claude,codex,gemini'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  const geminiMd = path.join(home, '.gemini', 'GEMINI.md');
  const codexConfig = path.join(home, '.codex', 'config.toml');
  assert.ok(fs.existsSync(claudeMd));
  assert.ok(fs.existsSync(geminiMd));
  assert.ok(fs.existsSync(codexConfig));

  const ledgerFile = path.join(home, '.doflow', 'state', 'ledger.json');
  let ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  for (const harness of ['claude', 'codex', 'gemini']) {
    assert.ok(ledger.resources.some((resource) => resource.harness === harness), `${harness} resource missing after mixed install`);
  }

  // A second, immediate update has no upstream drift for any of the three harnesses — it must
  // converge to a true no-op, exactly like the single-harness "already up to date" contract.
  r = run(['update', '-g', '--force', '--target', 'claude,codex,gemini'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Already up to date/);

  r = run(['remove', '-g', '--force', '--target', 'claude,codex,gemini'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(geminiMd), 'gemini remove deletes its file');
  assert.ok(!fs.existsSync(claudeMd), 'a CLAUDE.md holding only the managed section is deleted, like GEMINI.md');
  ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.deepStrictEqual(ledger.resources, []);
  // Skills are lifecycle-owned for Codex too (Phase D), so remove correctly deletes them; every
  // doflow-shipped Codex asset is lifecycle-owned as of Phase E, so a genuinely foreign file (not
  // a doflow asset at all) is the durable "remove never broadly deletes" example.
  assert.ok(!fs.existsSync(path.join(home, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')));
});

test('doflow.lock pins resolved selections on install and clears on full removal', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const lockFile = path.join(home, '.doflow', 'doflow.lock');

  const r = run(['install', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /doflow\.lock: created/);
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  assert.strictEqual(lock.version, 1);
  assert.deepEqual(lock.targets.map((t) => t.harness), ['codex']);
  const skillRow = lock.assets.find((asset) => asset.id === 'skills.doflow');
  assert.ok(skillRow, 'skills selection must be pinned');
  assert.strictEqual(skillRow.nativeDir, '../.agents/skills');
  // No --mcp flag + non-interactive = the default empty selection, recorded as such.
  assert.deepEqual(lock.mcpSelections, { codex: [] }, 'a planned MCP-capable target records its selection, [] included');

  // A no-op update leaves the existing pin untouched (update short-circuits before re-pinning).
  const mtimeBefore = fs.statSync(lockFile).mtimeMs;
  const update = run(['update', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(update.status, 0, update.stderr);
  assert.match(update.stdout, /Already up to date/);
  assert.strictEqual(fs.statSync(lockFile).mtimeMs, mtimeBefore);

  // Full removal clears both the ownership ledger and the selection lock.
  const removal = run(['remove', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(removal.status, 0, removal.stderr);
  assert.match(removal.stdout, /doflow\.lock: cleared/);
  assert.ok(!fs.existsSync(lockFile), 'an empty scope has nothing left to pin');
});

test('reconcile reports drift, heals it onto the pin, and converges clean', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const install = run(['install', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(install.status, 0, install.stderr);

  // Simulate drift: a managed skill file is edited underneath DoFlow.
  const skillFile = path.join(home, '.agents', 'skills', 'do-execute-plan', 'SKILL.md');
  assert.ok(fs.existsSync(skillFile), 'skill tree must exist at the pinned destination');
  fs.writeFileSync(skillFile, '# tampered by something else\n');

  const dry = run(['reconcile', '-g', '--dry-run', '--target', 'codex'], { home });
  assert.strictEqual(dry.status, 1, 'a drifted dry-run check must fail loudly for CI');
  assert.match(dry.stdout, /codex: 1 drift\(s\) \(0 create, 1 update, 0 remove\)/);
  assert.strictEqual(fs.readFileSync(skillFile, 'utf8'), '# tampered by something else\n', 'dry-run writes nothing');

  const healed = run(['reconcile', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(healed.status, 0, healed.stderr);
  assert.match(healed.stdout, /Reconciliation complete/);
  assert.match(fs.readFileSync(skillFile, 'utf8'), /name: do-execute-plan/, 'managed bytes are restored');

  const converged = run(['reconcile', '-g', '--dry-run', '--target', 'codex'], { home });
  assert.strictEqual(converged.status, 0);
  assert.match(converged.stdout, /Observed state matches doflow\.lock/);

  // Reconcile without a lock has no desired state and says so instead of guessing.
  const bare = run(['reconcile', '-g', '--force'], { home: fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-')) });
  assert.strictEqual(bare.status, 0);
  assert.match(bare.stdout, /No doflow\.lock in this scope/);
});

test('Pi MCP: a global install merges into a hand-written ~/.pi/agent/mcp.json and remove leaves the user bytes untouched', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const mcpFile = path.join(home, '.pi', 'agent', 'mcp.json');
  fs.mkdirSync(path.dirname(mcpFile), { recursive: true });
  const handWritten = '{\n  "mcpServers": { "mine": { "command": "my-server" } },\n  "other": 1\n}\n';
  fs.writeFileSync(mcpFile, handWritten);

  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'pi', '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const installed = JSON.parse(fs.readFileSync(mcpFile, 'utf8'));
  assert.deepStrictEqual(Object.keys(installed.mcpServers).sort(), ['context7', 'mine', 'sequential-thinking']);
  assert.deepStrictEqual(installed.mcpServers.mine, { command: 'my-server' });
  assert.strictEqual(installed.other, 1);
  const installedText = fs.readFileSync(mcpFile, 'utf8');
  assert.ok(installedText.includes('"mine": { "command": "my-server" }') && installedText.includes('"other": 1'), 'install keeps the hand-written members byte for byte');

  r = run(['remove', '-g', '--force', '-t', 'pi'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(mcpFile, 'utf8'), handWritten, 'remove restores the user\'s bytes exactly');
});

test('Pi MCP: a project install writes <project>/.pi/mcp.json with both catalog servers and prints the trust notice', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  const r = run(['install', project, '--force', '--no-backup', '-t', 'pi', '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const mcpJson = JSON.parse(fs.readFileSync(path.join(project, '.pi', 'mcp.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(mcpJson.mcpServers).sort(), ['context7', 'sequential-thinking']);
  assert.ok(r.stdout.includes('MCP: Pi reads .pi/mcp.json only after this project is trusted (/trust or --approve); DoFlow does not grant trust.'), r.stdout);
});

test('Pi MCP: an update with a narrower --mcp selection drops the deselected server from Pi\'s mcp.json', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let r = run(['install', '-g', '--force', '-t', 'claude,pi', '--mcp', 'context7,sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const piMcp = path.join(home, '.pi', 'agent', 'mcp.json');
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(piMcp, 'utf8')).mcpServers).sort(), ['context7', 'sequential-thinking']);

  r = run(['update', '-g', '--force', '-t', 'claude,pi', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(piMcp, 'utf8')).mcpServers), ['context7']);
  assert.deepStrictEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers), ['context7']);
});

test('Pi MCP: PI_CODING_AGENT_DIR redirects mcp.json while skills stay under ~/.pi/agent', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-agentdir-'));
  const r = run(['install', '-g', '--force', '--no-backup', '-t', 'pi', '--mcp', 'all'], { home, env: { PI_CODING_AGENT_DIR: agentDir } });
  assert.strictEqual(r.status, 0, r.stderr);

  const mcpJson = JSON.parse(fs.readFileSync(path.join(agentDir, 'mcp.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(mcpJson.mcpServers).sort(), ['context7', 'sequential-thinking']);
  assert.ok(!fs.existsSync(path.join(home, '.pi', 'agent', 'mcp.json')), 'the default location must stay untouched');
  assert.ok(fs.existsSync(path.join(home, '.pi', 'agent', 'skills')), 'skills do not follow PI_CODING_AGENT_DIR');
  assert.ok(r.stdout.includes('PI_CODING_AGENT_DIR is set: Pi reads its whole agent dir from it, but DoFlow moves only mcp.json there; skills and AGENTS.md stay in ~/.pi/agent.'), r.stdout);
  assert.ok(r.stdout.includes('[INFO] MCP selection: pi: context7, sequential-thinking (--mcp)'), r.stdout);
});

// --- Per-harness MCP selection: each harness's server file holds exactly its own selection ----

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Where each MCP-capable harness keeps DoFlow's servers at global scope, and the member that holds them.
const GLOBAL_MCP_FILES = (home) => ({
  kiro: { file: path.join(home, '.kiro', 'settings', 'mcp.json'), key: 'mcpServers' },
  antigravity: { file: path.join(home, '.gemini', 'config', 'mcp_config.json'), key: 'mcpServers' },
  opencode: { file: path.join(home, '.config', 'opencode', 'opencode.json'), key: 'mcp' },
  copilot: { file: path.join(home, '.copilot', 'mcp-config.json'), key: 'mcpServers' },
  pi: { file: path.join(home, '.pi', 'agent', 'mcp.json'), key: 'mcpServers' },
});

test('E1: --mcp context7 leaves only context7 in Kiro, Antigravity, OpenCode, Copilot and Pi, and names it in the selection line', () => {
  const home = scratchHome();
  const r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro,antigravity,opencode,copilot,pi', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: kiro, antigravity, opencode, copilot, pi: context7 (--mcp)'), r.stdout);

  for (const [harness, { file, key }] of Object.entries(GLOBAL_MCP_FILES(home))) {
    assert.deepStrictEqual(Object.keys(readJson(file)[key]), ['context7'], `${harness} holds only the selected server`);
  }
});

test('E3: a non-interactive Pi install with no --mcp registers no server and says the selection is the default', () => {
  const home = scratchHome();
  const r = run(['install', '-g', '--force', '--no-backup', '-t', 'pi'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: pi: none (default)'), r.stdout);
  assert.match(r.stdout, /MCP: none selected by default/);
  const mcpFile = path.join(home, '.pi', 'agent', 'mcp.json');
  const servers = fs.existsSync(mcpFile) ? readJson(mcpFile).mcpServers ?? {} : {};
  assert.deepStrictEqual(Object.keys(servers), [], 'no DoFlow server is registered');
  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections, { pi: [] }, 'the lock records the empty selection');
});

test('E11: an update with a narrower --mcp drops the deselected server from every targeted harness', () => {
  const home = scratchHome();
  const targets = 'claude,codex,kiro,antigravity,opencode,copilot,pi';
  let r = run(['install', '-g', '--force', '--no-backup', '-t', targets, '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const files = GLOBAL_MCP_FILES(home);
  for (const [harness, { file, key }] of Object.entries(files)) {
    assert.deepStrictEqual(Object.keys(readJson(file)[key]).sort(), ['context7', 'sequential-thinking'], `${harness} starts with both`);
  }

  r = run(['update', '-g', '--force', '--no-backup', '-t', targets, '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  for (const [harness, { file, key }] of Object.entries(files)) {
    assert.deepStrictEqual(Object.keys(readJson(file)[key]), ['context7'], `${harness} drops sequential-thinking`);
  }
  assert.deepStrictEqual(Object.keys(readJson(path.join(home, '.claude.json')).mcpServers), ['context7']);
  const codexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.context7\]/);
  assert.doesNotMatch(codexConfig, /mcp_servers\.sequential-thinking/);
});

test('E4: Claude and Codex keep their own selections across installs, and a Claude install with no flag keeps its servers', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'claude', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['install', '-g', '--force', '--no-backup', '-t', 'codex', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['install', '-g', '--force', '--no-backup', '-t', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: claude: context7 (recorded)'), r.stdout);

  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections,
    { claude: ['context7'], codex: ['sequential-thinking'] });
  assert.deepStrictEqual(Object.keys(readJson(path.join(home, '.claude.json')).mcpServers), ['context7']);
  const codexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.sequential-thinking\]/);
  assert.doesNotMatch(codexConfig, /mcp_servers\.context7/);
});

// E5 and E6 share E4's first two installs, so each builds them itself.
function installClaudeAndCodexWithOwnSelections(home) {
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'claude', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['install', '-g', '--force', '--no-backup', '-t', 'codex', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
}

test('E5: reconcile --dry-run after a Claude and a Codex install with different selections finds no drift', () => {
  const home = scratchHome();
  installClaudeAndCodexWithOwnSelections(home);
  const r = run(['reconcile', '-g', '--dry-run'], { home });
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /Observed state matches doflow\.lock/);
  assert.doesNotMatch(r.stdout, /\[WARN\]/);
});

test('E6: reconcile re-creates a hand-deleted Claude server and gives Codex nothing from Claude\'s selection', () => {
  const home = scratchHome();
  installClaudeAndCodexWithOwnSelections(home);
  const claudeFile = path.join(home, '.claude.json');
  const claudeJson = readJson(claudeFile);
  delete claudeJson.mcpServers.context7;
  fs.writeFileSync(claudeFile, `${JSON.stringify(claudeJson, null, 2)}\n`);

  let r = run(['reconcile', '-g', '--dry-run'], { home });
  assert.strictEqual(r.status, 1, 'the deleted server is drift');
  r = run(['reconcile', '-g', '--force'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(readJson(claudeFile).mcpServers), ['context7']);
  const codexConfig = fs.readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
  assert.match(codexConfig, /\[mcp_servers\.sequential-thinking\]/);
  assert.doesNotMatch(codexConfig, /mcp_servers\.context7/, 'Claude\'s selection does not reach Codex');
  assert.deepStrictEqual(Object.keys(readJson(claudeFile).mcpServers).filter((id) => id === 'sequential-thinking'), [],
    'Codex\'s selection does not reach Claude');
});

/** Ledger rows of one kind for one harness, so a test can say which MCP rows a run left behind. */
function ledgerRows(home, harness, kind) {
  return readJson(path.join(home, '.doflow', 'state', 'ledger.json')).resources
    .filter((row) => row.harness === harness && row.kind === kind);
}

function addUserServer(file, key = 'mcpServers') {
  const doc = readJson(file);
  doc[key]['user-server'] = { command: 'user-cmd', args: ['--user-owned'] };
  fs.writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
}

test('E2: install --mcp none registers no DoFlow server and records an empty selection', () => {
  const home = scratchHome();
  const r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro', '--mcp', 'none'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: kiro: none (--mcp)'), r.stdout);
  const mcpFile = GLOBAL_MCP_FILES(home).kiro.file;
  const servers = fs.existsSync(mcpFile) ? readJson(mcpFile).mcpServers ?? {} : {};
  assert.deepStrictEqual(Object.keys(servers), [], 'no DoFlow server is registered');
  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections, { kiro: [] });
});

test('E7: removing Kiro deletes its servers and rows, keeps a user entry, and leaves Codex and the lock row of Codex alone', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro,codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const kiroFile = GLOBAL_MCP_FILES(home).kiro.file;
  addUserServer(kiroFile);
  const codexFile = path.join(home, '.codex', 'config.toml');
  const codexBefore = fs.readFileSync(codexFile, 'utf8');
  const codexRowsBefore = ledgerRows(home, 'codex', 'mcp-server');
  assert.ok(ledgerRows(home, 'kiro', 'mcp-server').length > 0, 'Kiro owns a server row before the removal');

  r = run(['remove', '-g', '--force', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(readJson(kiroFile).mcpServers), ['user-server'], 'only the user entry stays');
  assert.deepStrictEqual(ledgerRows(home, 'kiro', 'mcp-server'), [], 'Kiro server rows are released');
  assert.strictEqual(fs.readFileSync(codexFile, 'utf8'), codexBefore, 'Codex config is untouched');
  assert.deepStrictEqual(ledgerRows(home, 'codex', 'mcp-server'), codexRowsBefore, 'Codex rows are unchanged');
  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections, { codex: ['context7'] });
});

test('E8: removing Claude deletes the unedited server, keeps a hand-edited one, and keeps Codex\'s lock row', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'claude,codex', '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const claudeFile = path.join(home, '.claude.json');
  const claudeJson = readJson(claudeFile);
  claudeJson.mcpServers['sequential-thinking'].args.push('--edited');
  fs.writeFileSync(claudeFile, `${JSON.stringify(claudeJson, null, 2)}\n`);

  r = run(['remove', '-g', '--force', '-t', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(Object.keys(readJson(claudeFile).mcpServers), ['sequential-thinking'], 'only the edited entry stays');
  assert.ok(readJson(claudeFile).mcpServers['sequential-thinking'].args.includes('--edited'));
  assert.deepStrictEqual(readJson(path.join(home, '.doflow', 'doflow.lock')).mcpSelections,
    { codex: ['context7', 'sequential-thinking'] });
});

test('E9: removing the last harness removes the lock', () => {
  const home = scratchHome();
  const lockFile = path.join(home, '.doflow', 'doflow.lock');
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro,codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['remove', '-g', '--force', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(lockFile), 'Codex is still pinned');
  r = run(['remove', '-g', '--force', '-t', 'codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /doflow\.lock: cleared/);
  assert.ok(!fs.existsSync(lockFile), 'no harness is left to pin');
});

test('E10: reconcile names an installed harness the lock does not pin', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro,codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const lockFile = path.join(home, '.doflow', 'doflow.lock');
  const lock = readJson(lockFile);
  lock.targets = lock.targets.filter((entry) => entry.harness !== 'kiro');
  delete lock.mcpSelections.kiro;
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);

  r = run(['reconcile', '-g', '--dry-run'], { home });
  assert.match(r.stdout, /\[WARN\] kiro: installed \(ledger holds \d+ resource\(s\)\) but absent from doflow\.lock; reconcile does not converge it\./);
  assert.doesNotMatch(r.stdout, /\[WARN\] codex/);
  r = run(['reconcile', '-g', '--dry-run', '--json'], { home });
  const report = JSON.parse(r.stdout.slice(r.stdout.indexOf('\n{\n') + 1, r.stdout.lastIndexOf('\n}') + 2));
  assert.deepStrictEqual(report.unpinned, ['kiro']);
});

test('E12: a second install, update, reconcile and remove leaves config files, ledger and lock byte for byte', () => {
  const home = scratchHome();
  const watched = [
    path.join(home, '.doflow', 'state', 'ledger.json'),
    path.join(home, '.doflow', 'doflow.lock'),
    path.join(home, '.claude.json'),
    path.join(home, '.codex', 'config.toml'),
    ...Object.values(GLOBAL_MCP_FILES(home)).map(({ file }) => file),
  ];
  const snapshot = () => watched.map((file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null));
  const twice = (args, label) => {
    let r = run(args, { home });
    assert.strictEqual(r.status, 0, `${label}: ${r.stderr}`);
    const first = snapshot();
    r = run(args, { home });
    assert.deepStrictEqual(snapshot(), first, `${label}: the second run changes no watched file`);
    return r;
  };
  const targets = 'claude,codex,kiro,antigravity,opencode,copilot,pi';
  const base = ['-g', '--force', '--no-backup', '-t', targets];
  twice(['install', ...base, '--mcp', 'all'], 'install');
  twice(['update', ...base, '--mcp', 'context7'], 'update');

  const claudeFile = path.join(home, '.claude.json');
  const claudeJson = readJson(claudeFile);
  delete claudeJson.mcpServers.context7;
  fs.writeFileSync(claudeFile, `${JSON.stringify(claudeJson, null, 2)}\n`);
  twice(['reconcile', '-g', '--force'], 'reconcile');
  assert.deepStrictEqual(Object.keys(readJson(claudeFile).mcpServers), ['context7'], 'the first reconcile restored the server');

  let r = run(['remove', '-g', '--force', '--no-backup', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const afterRemove = snapshot();
  r = run(['remove', '-g', '--force', '--no-backup', '-t', 'kiro'], { home });
  // A remove with nothing left to remove refuses its empty plan and exits 1, as it did before this
  // feature; what this case pins is that it writes nothing.
  assert.strictEqual(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /Refusing to apply a lifecycle plan with no required native resources/);
  assert.deepStrictEqual(snapshot(), afterRemove, 'a second remove changes no watched file');
});

test('the selection line under --dry-run names a remembered selection, and --mcp with no harness to take it has no effect', () => {
  const home = scratchHome();
  // A 1.18.0 manifest list is what a harness with nothing recorded is offered.
  fs.mkdirSync(path.join(home, '.doflow'), { recursive: true });
  fs.writeFileSync(path.join(home, '.doflow', '.install-manifest.json'), `${JSON.stringify({ tools: {}, mcp_servers: ['context7'] })}\n`);
  let r = run(['install', '-g', '--dry-run', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[DRY] MCP selection: kiro: context7 (remembered)'), r.stdout);

  r = run(['install', '-g', '--dry-run', '-t', 'gemini', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[DRY] MCP: no targeted harness takes MCP servers; --mcp has no effect.'), r.stdout);
  assert.doesNotMatch(r.stdout, /MCP selection:/);
});

test('update with no native change records a selection missing from the lock without touching a file, and says so', () => {
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--no-backup', '-t', 'kiro', '--mcp', 'none'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // An installed harness the lock records no selection for, as after an upgrade from 1.18.0.
  const lockFile = path.join(home, '.doflow', 'doflow.lock');
  const lock = readJson(lockFile);
  delete lock.mcpSelections.kiro;
  fs.writeFileSync(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  const before = fs.readFileSync(lockFile, 'utf8');

  r = run(['update', '-g', '--force', '--no-backup', '--dry-run', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[DRY] MCP selection: kiro: none (kept)'), r.stdout);
  assert.ok(r.stdout.includes('[DRY]  Would update doflow.lock: 1 change(s)'), r.stdout);
  assert.strictEqual(fs.readFileSync(lockFile, 'utf8'), before, 'a dry run writes no lock');

  r = run(['update', '-g', '--force', '--no-backup', '-t', 'kiro'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('[INFO] MCP selection: kiro: none (kept)'), r.stdout);
  assert.ok(r.stdout.includes('[INFO] doflow.lock: 1 change(s)'), r.stdout);
  assert.ok(r.stdout.includes('[OK] Already up to date: no native changes; selections recorded in doflow.lock'), r.stdout);
  assert.deepStrictEqual(readJson(lockFile).mcpSelections, { kiro: [] });
});

test('T2: no source, doc or README line still says the selection narrows only when claude or codex is targeted', () => {
  const stale = 'narrows this only when claude or codex';
  const walk = (entry) => {
    if (fs.statSync(entry).isFile()) return [entry];
    return fs.readdirSync(entry).flatMap((name) => walk(path.join(entry, name)));
  };
  const files = [path.join(REPO, 'README.md'), ...walk(path.join(REPO, 'src')), ...walk(path.join(REPO, 'docs'))];
  const holders = files.filter((file) => fs.readFileSync(file, 'utf8').includes(stale));
  assert.deepStrictEqual(holders, []);
});
