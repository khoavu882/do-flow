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
    input: input ?? '',
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
  assert.match(agents, /# Core Framework/);
  assert.ok(fs.existsSync(path.join(codexDir, 'skills', 'do-implement', 'SKILL.md')));

  fs.writeFileSync(path.join(codexDir, 'AGENTS.md'), agents.replace('# Core Framework', 'stale managed instructions'));
  const update = run(['update', '-g', '--force', '--target', 'codex'], { home });
  assert.strictEqual(update.status, 0, update.stderr);
  const updatedAgents = fs.readFileSync(path.join(codexDir, 'AGENTS.md'), 'utf8');
  assert.match(updatedAgents, /Preserve this content\./);
  assert.match(updatedAgents, /# Core Framework/);
});

test('full lifecycle: install -> mutate -> update -> rollback restores the pre-update dst content', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');

  let r = run(['install', '-g', '--force', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  // A fresh install's CLAUDE.md is already exactly doflow's marked section, verbatim (no user
  // content yet) — see src/claude-md-merge.js.
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
  // separator-normalization rule (src/claude-md-merge.js) adds exactly one more before the
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
  assert.match(r.stdout, /\[DRY\]\s+claude\/CLAUDE\.md/);
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

test('a missing bin/mappings.conf fails every command cleanly instead of an ENOENT stack trace', () => {
  const mappingsFile = path.join(REPO, 'bin', 'mappings.conf');
  const movedAside = `${mappingsFile}.e2e-test-backup`;
  fs.renameSync(mappingsFile, movedAside);
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
    const r = run(['install', '-g', '--force', '--target', 'claude'], { home });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /mappings\.conf not found/);
    assert.ok(!/at Object\.readFileSync/.test(r.stderr), 'must not leak a raw Node stack trace');
  } finally {
    fs.renameSync(movedAside, mappingsFile);
  }
});

test('update rejects a traversing CLAUDE.md destination just like install does, instead of writing outside the install root', () => {
  // Regression test: cmdUpdate's CLAUDE.md resolution used to build its destination path with a
  // raw path.join and no assertWithinRoot call, unlike every other write path in this codebase
  // (installTool and resolveFilePairs both guard every mapping before writing). Simulate a
  // corrupted mappings.conf the same way the "missing mappings.conf" test above does: mutate the
  // real file on disk temporarily, restore it in finally.
  const mappingsFile = path.join(REPO, 'bin', 'mappings.conf');
  const original = fs.readFileSync(mappingsFile, 'utf8');
  const mutated = original.replace(
    /^core\/CLAUDE\.md\s*:\s*CLAUDE\.md$/m,
    'core/CLAUDE.md        : ../../outside.md'
  );
  assert.notStrictEqual(mutated, original, 'expected to find and rewrite the CLAUDE.md mapping line');
  fs.writeFileSync(mappingsFile, mutated);
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
    const r = run(['update', '-g', '--force', '--target', 'claude'], { home });
    assert.strictEqual(r.status, 1);
    assert.match(r.stderr, /outside install root/);
    assert.ok(!fs.existsSync(path.join(home, 'outside.md')), 'the traversing path must never be written');
  } finally {
    fs.writeFileSync(mappingsFile, original);
  }
});

test('update skips a missing CLAUDE.md source gracefully instead of crashing with a raw ENOENT', () => {
  // Regression test: cmdUpdate's CLAUDE.md resolution used to call mergeMarkedSection
  // unconditionally once the mapping was found, without checking the source file exists first —
  // unlike every other mapping (resolveFilePairs/installTool both skip a missing source silently).
  const mappingsFile = path.join(REPO, 'bin', 'mappings.conf');
  const original = fs.readFileSync(mappingsFile, 'utf8');
  const mutated = original.replace(
    /^core\/CLAUDE\.md\s*:\s*CLAUDE\.md$/m,
    'core/no-such-file.md  : CLAUDE.md'
  );
  assert.notStrictEqual(mutated, original, 'expected to find and rewrite the CLAUDE.md mapping line');
  fs.writeFileSync(mappingsFile, mutated);
  try {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-cli-e2e-'));
    const r = run(['update', '-g', '--force', '--target', 'claude'], { home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.ok(!/ENOENT/.test(r.stderr), 'a missing CLAUDE.md source must not surface a raw ENOENT');
  } finally {
    fs.writeFileSync(mappingsFile, original);
  }
});

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
