'use strict';
// cli-e2e.test.js — spawns the real bin/doflow.js CLI against scratch $HOMEs. Complements the
// unit tests (which exercise src/* modules directly) by covering the actual command wiring in
// bin/doflow.js: flag parsing, dispatch, and the full install -> update -> rollback lifecycle.
// This file: tools, backup/rollback, status, Codex lifecycle. Siblings: cli-e2e-mcp / cli-e2e-harness.
// Runners live in cli-e2e.shared.js.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  expectExecutable, tempDir, scratchHome, run, fakeBin, toolEnv, runInteractive, skipToolsOnWin, cleanup,
} = require('./cli-e2e.shared.ts');

after(cleanup);

test('tools status selects both registered tools and returns one JSON result per tool', (t) => {
  if (!skipToolsOnWin(t)) return;
  const bin = fakeBin(t, {
    rtk: 'case "$1" in --version|gain) exit 0;; *) exit 1;; esac',
    graphify: 'test "$1" = "--version"',
    uv: 'test "$1" = "--version"',
  });
  const r = run(['tools', '--tool', 'rtk,graphify', '--json'], { env: toolEnv(bin) });
  assert.strictEqual(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.action, 'status');
  assert.deepStrictEqual(result.results.map((item: any) => item.tool), ['rtk', 'graphify']);
  assert.deepStrictEqual(result.results.map((item: any) => item.result.status), ['skipped', 'skipped']);
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
  const bin = fakeBin(t, {
    uv: 'test "$1" = "--version"',
  });
  const r = run(['tools', '--tool', 'rtk,graphify', '--action', 'install', '--dry-run', '--json'], { env: toolEnv(bin) });
  assert.strictEqual(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.strictEqual(result.dryRun, true);
  assert.deepStrictEqual(result.results.map((item: any) => item.result.status), ['not-attempted', 'not-attempted']);
  assert.deepStrictEqual(result.results.map((item: any) => item.result.command), [
    ['cargo', 'install', '--git', 'https://github.com/rtk-ai/rtk', '--branch', 'master', 'rtk'],
    ['uv', 'tool', 'install', 'graphifyy'],
  ]);
});

test('tools reports a declined lifecycle action without executing it', (t) => {
  if (!skipToolsOnWin(t)) return;
  const bin = fakeBin(t, {});
  const r = run(['tools', '--tool', 'rtk', '--action', 'install'], { env: toolEnv(bin), input: 'n\n' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /RTK \(Rust Token Killer\): "cargo" "install"/);
  assert.match(r.stdout, /rtk: declined/);
});

test('tools continues independently when one confirmed lifecycle command fails', async (t) => {
  if (!skipToolsOnWin(t)) return;
  const bin = fakeBin(t, {
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

test('--no-backup without --force is a hard error (exit 1), for install and update alike', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r1 = run(['install', '--no-backup', '-g', '--target', 'claude'], { home });
  assert.strictEqual(r1.status, 1);
  assert.match(r1.stderr, /--no-backup skips all backup protection and requires --force/);

  const r2 = run(['update', '--no-backup', '-g', '--target', 'claude'], { home });
  assert.strictEqual(r2.status, 1);
});

test('--no-backup without --force is now a hard error for every command, not just install/update', (t) => {
  // Regression test: the check used to only run inside cmdInstall/cmdUpdate; sync.sh's
  // validate_env() runs it once before dispatching to any operation, including --status.
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r = run(['status', '--no-backup', '-g'], { home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /--no-backup skips all backup protection and requires --force/);
});

test('--target and --prune reject a following flag as their value instead of silently swallowing it', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r1 = run(['install', '--target', '--no-backup', '-g', '--force'], { home });
  assert.strictEqual(r1.status, 1);
  assert.match(r1.stderr, /--target requires a value/);

  const r2 = run(['install', '--prune', '--force', '-g'], { home });
  assert.strictEqual(r2.status, 1);
  assert.match(r2.stderr, /--prune requires a number/);
});

test('rollback with no --target names and records only the harnesses the backup restored', () => {
  // With no --target a per-file backup restores every harness it holds, so the banner and the
  // install manifest must name those harnesses, not the default target.
  const home = scratchHome();
  let r = run(['install', '-g', '--force', '--mcp', 'none', '--target', 'codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  fs.writeFileSync(path.join(home, '.agents', 'skills', 'do-brainstorm', 'SKILL.md'), 'edited codex\n');
  r = run(['update', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const bid = /Backup created: (update_[\d_-]+)/.exec(r.stderr)?.[1];
  assert.ok(bid, r.stderr);

  r = run(['rollback', bid, '-g', '--force'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /targets {7}: codex\n/);
  assert.doesNotMatch(r.stderr, /claude ->/);
  const recorded = JSON.parse(fs.readFileSync(path.join(home, '.doflow', '.install-manifest.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(recorded.tools), ['codex'], 'a rollback that restored only Codex files must not record Claude as installed');
});

test("rollback --target restores only that harness's files from a backup that holds several harnesses", (t) => {
  // A backup holds the files one update changed for every harness it touched. Restoring it with
  // --target claude must put back the Claude file and leave every Codex file as it is now.
  const home = tempDir(t, 'doflow-cli-e2e-');
  let r = run(['install', '-g', '--force', '--target', 'claude,codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  const codexFile = path.join(home, '.agents', 'skills', 'do-brainstorm', 'SKILL.md');
  fs.writeFileSync(claudeMd, 'edited claude\n');
  fs.writeFileSync(codexFile, 'edited codex\n');
  r = run(['update', '-g', '--force', '--target', 'claude,codex'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const bid = /Backup created: (update_[\d_-]+)/.exec(r.stderr)?.[1];
  assert.ok(bid, `the update names its backup:\n${r.stderr}`);
  assert.notStrictEqual(fs.readFileSync(claudeMd, 'utf8'), 'edited claude\n', 'the update replaced the Claude edit');
  assert.notStrictEqual(fs.readFileSync(codexFile, 'utf8'), 'edited codex\n', 'the update replaced the Codex edit');
  fs.writeFileSync(codexFile, 'mutated codex content');

  r = run(['rollback', bid, '-g', '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /Skipped \d+ file\(s\) of harnesses not in --target/);
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), 'edited claude\n', 'rollback --target claude restores the Claude file');
  assert.strictEqual(fs.readFileSync(codexFile, 'utf8'), 'mutated codex content', 'rollback --target claude must not touch codex, even though the backup holds a codex file');
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

test('project-scoped install (no -g, no path) resolves under cwd, not $HOME', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const projectDir = tempDir(t, 'doflow-cli-e2e-project-');
  const r = run(['install', projectDir, '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(projectDir, '.claude', 'CLAUDE.md')));
  assert.ok(fs.existsSync(path.join(projectDir, '.doflow', '.install-manifest.json')));
  assert.ok(!fs.existsSync(path.join(projectDir, '.claude', '.install-manifest.json')));
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'must not also write to $HOME');
});

test('Codex install merges AGENTS.md and installs reusable skills', (t) => {  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('full lifecycle: install -> mutate -> update -> rollback restores the pre-update dst content', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('status --json emits parseable JSON with the manifest', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['status', '-g', '--json'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.strictEqual(parsed.manifest.operation, 'install');
  assert.strictEqual(parsed.context.scope, 'global');
});

test('status reports a harness the ledger owns nothing of as not-installed, in JSON and text', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const parsed = JSON.parse(run(['status', '-g', '--json', '--target', 'claude,codex'], { home }).stdout);
  assert.strictEqual(parsed.context.claude.status, 'verified');
  assert.strictEqual(parsed.context.codex.status, 'not-installed');
  assert.deepStrictEqual(parsed.context.codex.resources, []);
  const text = run(['status', '-g', '--target', 'claude,codex'], { home });
  assert.match(text.stdout, /Codex verification:\s+not-installed/);
  assert.match(text.stdout, /Claude verification:\s+verified/);
});

test('status keeps a conflict ahead of not-installed: a user-owned file in the way, or ledger rows lost over edited files', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('rollback with an unknown id fails cleanly (exit 1, no crash)', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['rollback', 'no_such_backup', '-g', '--force'], { home });
  assert.strictEqual(r.status, 1);
  assert.match(r.stderr, /Backup not found/);
});

test('install --dry-run previews files and writes nothing', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r = run(['install', '-g', '--dry-run', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // Every Claude asset is registry-owned as of Phase E — the legacy copier's per-file preview
  // lines are gone; the registry lifecycle's own preview line is the real signal now.
  assert.match(r.stdout, /\[DRY\] Registry lifecycle: \d+ native change\(s\)/);
  assert.match(r.stdout, /Dry run complete/);
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'dry-run must not create any files');
});

test('update --dry-run previews changed files and writes nothing', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('update --dry-run when already up to date reports so and exits before the dry-run branch', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['update', '-g', '--dry-run', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Already up to date/);
});

test('a second update with no upstream change is a true no-op for CLAUDE.md (idempotent merge)', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  const bytesAfterInstall = fs.readFileSync(claudeMd, 'utf8');

  const r = run(['update', '-g', '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Already up to date/, 'nothing changed, including CLAUDE.md\'s marked section, so this must not run the write/backup path');
  assert.strictEqual(fs.readFileSync(claudeMd, 'utf8'), bytesAfterInstall, 'CLAUDE.md bytes must be untouched by a no-op update');
});

test('status (text, no --json) prints the resolved context and install status table', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['status', '-g'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /\[CONTEXT\] Resolved install context/);
  assert.match(r.stdout, /Install Status/);
  assert.match(r.stdout, /Last operation:\s+install/);
  assert.match(r.stdout, /claude\s+installed/);
});

test('status (text, no --json) before any install warns no manifest found', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r = run(['status', '-g'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /No install manifest found/);
});

test('list-backups with none present reports "No backups found" instead of an empty table', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r = run(['list-backups', '-g'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /No backups found/);
});

test('rollback --dry-run (no --force) does not block on the confirm prompt', (t) => {
  // Regression test: cmdRollback used to call confirm() unconditionally, even under --dry-run,
  // unlike install/update (which skip the prompt entirely when previewing). That meant a
  // non-interactive `rollback <id> --dry-run` would abort as if the user answered "no" (or hang
  // waiting on a TTY), instead of behaving like a no-op preview. Feeding empty stdin here proves
  // the dry-run path no longer depends on an answer to that prompt.
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const listed = run(['list-backups', '-g'], { home });
  const bid = /install_[\d_-]+/.exec(listed.stdout)?.[0];
  assert.ok(bid, `expected an install_* backup id:\n${listed.stdout}`);

  const r = run(['rollback', bid, '-g', '--dry-run'], { home, input: '' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Dry run complete/);
  assert.ok(!/Aborted/.test(r.stderr), 'dry-run rollback must not be treated as aborted by an empty confirm answer');
});

test('Codex-native lifecycle supports isolated project dry-run, selected MCP update, and verifiable ownership', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');

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
  assert.ok(status.codex.resources.some((resource: any) => resource.kind === 'mcp-server' && resource.identity === 'sequential-thinking'));
});

test('status --json reports the general per-harness hook-wiring status for claude, codex, and kiro', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');

  let r = run(['install', project, '--force', '--target', 'claude,codex,kiro', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['status', project, '--target', 'claude,codex,kiro', '--json'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);

  assert.deepStrictEqual(status.context.claude.hooks, { status: 'active', prerequisites: [] });
  assert.deepStrictEqual(status.context.kiro.hooks, { status: 'active', prerequisites: [] });
  assert.strictEqual(status.codex.hooks.status, 'installed-pending');
  assert.deepStrictEqual(status.codex.hooks.prerequisites, ['trusted-project', 'hook-review']);
});

test('Codex reconciliation preserves foreign config and fails closed on a conflicting managed key', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('Codex dry-run and status expose the non-mutating registry lifecycle and neutral state location', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
  const dry = run(['install', project, '--dry-run', '--target', 'codex', '--mcp', 'context7'], { home });
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /Registry lifecycle: \d+ native change\(s\), 0 conflict\(s\)/);
  // The CLI echoes the state root joined with native separators (path.join in src/lifecycle/view.ts),
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

test('Codex remove clears only lifecycle-owned native resources and retains compatibility assets', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
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

test('Codex remove with a duplicated span in AGENTS.md is refused before anything is removed', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
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

test('Codex project install and remove rooted at HOME are refused and leave every global file', (t) => {
  // A project rooted at $HOME would share ~/.codex, ~/.agents and the one ledger with the global install.
  const home = tempDir(t, 'doflow-cli-e2e-');
  let result = run(['install', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(result.status, 0, result.stderr);
  const globalOwned = ['hooks.json', 'config.toml', path.join('hooks', 'session-start.sh'), path.join('bin', 'doflow-run')]
    .map((rel) => path.join(home, '.codex', rel))
    .concat(path.join(home, '.doflow', 'state', 'ledger.json'));
  const before = globalOwned.map((file) => fs.readFileSync(file, 'utf8'));
  for (const command of ['install', 'remove']) {
    result = run([command, home, '--force', '--target', 'codex'], { home });
    assert.strictEqual(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`is your home directory: a project ${command} there .*Nothing was changed\\. Run: doflow ${command} -g -t codex`));
    assert.deepStrictEqual(globalOwned.map((file) => fs.readFileSync(file, 'utf8')), before, `a refused ${command} changes no global file`);
  }
  assert.ok(fs.existsSync(path.join(home, '.agents', 'skills', 'do-execute-plan', 'SKILL.md')), 'global skills survive');
  assert.ok(!fs.existsSync(path.join(home, 'AGENTS.md')), 'no project AGENTS.md is written at HOME');
});

test('Codex remove keeps a user hook script, AGENTS.md line and config.toml table byte for byte', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
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

