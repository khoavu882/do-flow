'use strict';
// cli-e2e.test.js — spawns the real bin/doflow.js CLI against scratch $HOMEs. Complements the
// unit tests (which exercise src/* modules directly) by covering the actual command wiring in
// bin/doflow.js: flag parsing, dispatch, and the full install -> update -> rollback lifecycle.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');

function run(args, { home, input } = {}) {
  return spawnSync('node', [DOFLOW, ...args], {
    cwd: REPO,
    env: { ...process.env, HOME: home ?? fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-')) },
    // Reply "no" explicitly for prompt-abort cases. An empty input can leave the test worker's
    // non-blocking pseudo-TTY attached and make the CLI retry EAGAIN as if a user were typing.
    input: input || '\n',
    encoding: 'utf8',
  });
}

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
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /Aborted/);
});

test('project-scoped install (no -g, no path) resolves under cwd, not $HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-project-'));
  const r = run(['install', projectDir, '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(projectDir, '.claude', 'CLAUDE.md')));
  assert.ok(!fs.existsSync(path.join(home, '.claude')), 'must not also write to $HOME');
});

test('Codex install merges AGENTS.md and installs reusable skills', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
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
  assert.ok(fs.existsSync(path.join(codexDir, 'skills', 'do-implement', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexDir, 'scripts', 'doflow', 'bash', 'do-paths.sh')));
  assert.ok(fs.existsSync(path.join(codexDir, 'templates', 'doflow', 'plan-template.md')));

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
  // content yet) — see src/marker-merge.js.
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
  // separator-normalization rule (src/marker-merge.js) adds exactly one more before the
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
  assert.match(r.stdout, /codex hooks trust: review-required \(review required in Codex\)/);
  assert.ok(!fs.existsSync(path.join(project, '.codex')), 'Codex dry-run must not create project config');

  r = run(['install', project, '--force', '--target', 'codex', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const config = path.join(project, '.codex', 'config.toml');
  assert.match(fs.readFileSync(config, 'utf8'), /\[features\]\nhooks = true/);
  assert.match(fs.readFileSync(config, 'utf8'), /\[mcp_servers\.context7\]/);
  assert.ok(fs.statSync(path.join(project, '.codex', 'hooks', 'session-start.sh')).mode & 0o111);
  assert.ok(fs.existsSync(path.join(project, '.codex', 'agents', 'backend-architect.toml')));

  r = run(['update', project, '--force', '--target', 'codex', '--mcp', 'playwright'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const updated = fs.readFileSync(config, 'utf8');
  assert.doesNotMatch(updated, /mcp_servers\.context7/);
  assert.match(updated, /mcp_servers\.playwright/);

  r = run(['status', project, '--target', 'codex', '--json'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  assert.strictEqual(status.codex.status, 'verified');
  assert.strictEqual(status.codex.hooksTrust.status, 'review-required');
  assert.ok(status.codex.resources.some((resource) => resource.kind === 'mcp-server' && resource.identity === 'playwright'));
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
  assert.match(dry.stdout, new RegExp(`Neutral state: ${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.doflow/state`));
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
  assert.ok(!fs.existsSync(path.join(project, '.codex', 'skills', 'do-implement', 'SKILL.md')), 'skills are lifecycle-owned and must be removed');
  assert.equal(fs.readFileSync(foreignFile, 'utf8'), 'my own notes\n', 'a foreign file never owned by doflow must survive remove untouched');
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
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /Aborted/);
});

test('update without --force waits on confirm and aborts when stdin is empty', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claudeMd, 'mutated\n');
  fs.utimesSync(claudeMd, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));

  const r = run(['update', '-g', '--target', 'claude'], { home, input: '' });
  assert.strictEqual(r.status, 0, r.stderr);
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
  assert.strictEqual(r.status, 0, r.stderr);
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
// test/registry.test.js's "rejects projections to unavailable capabilities and missing source
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
  const r = run(['install', projectDir, '--force', '--no-backup', '--target', 'claude', '--mcp', 'playwright'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const mcpJson = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(mcpJson.mcpServers), ['playwright']);
  assert.ok(!fs.existsSync(path.join(projectDir, '.claude', '.mcp.json')));
});

test('an install with no --mcp flag (non-interactive, piped stdin) defaults to all servers', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['chrome-devtools', 'context7', 'playwright', 'sequential-thinking']);
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

  r = run(['update', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'playwright,chrome-devtools'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  let claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['chrome-devtools', 'playwright']);

  // A later update with no --mcp must now remember THIS selection, not the original install's.
  r = run(['update', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['chrome-devtools', 'playwright']);
});

test('update --dry-run for an MCP-only change never claims a backup will be created, matching the real run', () => {
  // Regression test: the dry-run branch used to print "Would create partial backup" whenever
  // --no-backup was absent, regardless of whether anything backup-worthy (a native/lifecycle
  // change) was actually pending — an MCP-only selection change never triggers a backup on the
  // real run (MCP files live outside the tool dir), so the preview must not claim otherwise.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['update', '-g', '--force', '--dry-run', '--target', 'claude', '--mcp', 'playwright'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!/Would create partial backup/.test(r.stdout), `dry-run must not claim a backup for an MCP-only change:\n${r.stdout}`);

  r = run(['update', '-g', '--force', '--target', 'claude', '--mcp', 'playwright'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const listed = run(['list-backups', '-g'], { home });
  assert.ok(!/update_/.test(listed.stdout), `the real run must not have created an update backup either:\n${listed.stdout}`);
});

test('--mcp on install rejects an unknown server name with a clear message', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'not-a-real-server'], { home });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Unknown MCP server\(s\): not-a-real-server/);
});

test('doflow status reports the persisted MCP server selection', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'context7,playwright'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  r = run(['status', '-g', '--json'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const status = JSON.parse(r.stdout);
  assert.deepStrictEqual(status.manifest.mcpServers.sort(), ['context7', 'playwright']);
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
  assert.ok(ownedCount > 100, `expected well over 100 owned Claude resources once copy-tree/settings assets are included, got ${ownedCount}`);

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
  assert.ok(fs.existsSync(path.join(project, '.claude', 'skills', 'do-analyze', 'SKILL.md')));
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
  assert.ok(ownedCount > 50, `expected well over 50 owned Gemini resources once copy-tree assets are included, got ${ownedCount}`);

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
  assert.ok(fs.existsSync(path.join(project, '.agents', 'skills', 'do-analyze', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(project, '.agents', 'agents', 'backend-architect.md')));
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
  assert.ok(!fs.readFileSync(claudeMd, 'utf8').includes('<!-- doflow:start'), 'claude remove strips only its managed section; the file remains');
  ledger = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  assert.deepStrictEqual(ledger.resources, []);
  // Skills are lifecycle-owned for Codex too (Phase D), so remove correctly deletes them; every
  // doflow-shipped Codex asset is lifecycle-owned as of Phase E, so a genuinely foreign file (not
  // a doflow asset at all) is the durable "remove never broadly deletes" example.
  assert.ok(!fs.existsSync(path.join(home, '.codex', 'skills', 'do-implement', 'SKILL.md')));
});
