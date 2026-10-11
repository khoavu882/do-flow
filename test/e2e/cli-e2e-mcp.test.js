'use strict';
// cli-e2e-mcp.test.js — bin/doflow.js against scratch $HOMEs: prompts, --prune, --mcp selection, harness lifecycle,
// lock and reconcile. Runners live in cli-e2e.shared.js.
const { test, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const {
  REPO, tempDir, scratchHome, run, cleanup,
} = require('./cli-e2e.shared');

after(cleanup);

test('rollback with no id argument prompts interactively and accepts a typed backup id', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const listed = run(['list-backups', '-g'], { home });
  const bid = /install_[\d_-]+/.exec(listed.stdout)?.[0];
  assert.ok(bid, `expected an install_* backup id:\n${listed.stdout}`);

  const r = run(['rollback', '-g', '--force'], { home, input: `${bid}\n` });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /Rollback to .* complete/);
});

test('rollback with no id argument and empty stdin aborts instead of restoring', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  run(['install', '-g', '--force', '--target', 'claude'], { home });
  const r = run(['rollback', '-g', '--force'], { home, input: '' });
  // Exit 1: a declined prompt is a decision, not a completed run. This asserted 0 until the D.4
  // sweep found that `doflow install <path>` in a script printed "Aborted.", wrote nothing, and
  // reported success — the assertion had pinned the observed value rather than the stated intent,
  // which is "waits on confirm and aborts".
  assert.strictEqual(r.status, 1, r.stderr);
  assert.match(r.stderr, /Aborted/);
});

test('update without --force waits on confirm and aborts when stdin is empty', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('rollback with an explicit id but no --force aborts on an empty confirm answer, without restoring', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('--prune keeps only the N most recent backups on both install and update', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const claudeMd = path.join(home, '.claude', 'CLAUDE.md');
  // Each install changes a file, so each one makes a backup: two exist before the pruning run.
  for (const prune of [[], [], ['--prune', '1']]) {
    if (fs.existsSync(claudeMd)) fs.writeFileSync(claudeMd, 'mutated\n');
    const r = run(['install', '-g', '--force', '--target', 'claude', ...prune], { home });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stderr, /Backup created: install_/);
    if (prune.length) assert.match(r.stderr, /Backups: kept 1, removed 2 \(--prune 1\)/);
  }
  let listed = run(['list-backups', '-g'], { home });
  assert.strictEqual((listed.stdout.match(/install_[\d_-]+/g) || []).length, 1, 'install --prune 1 must keep exactly one backup');

  fs.writeFileSync(claudeMd, 'mutated\n');
  fs.utimesSync(claudeMd, new Date('2000-01-01T00:00:00Z'), new Date('2000-01-01T00:00:00Z'));
  const r = run(['update', '-g', '--force', '--target', 'claude', '--prune', '1'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stderr, /Backups: kept 1, removed \d+ \(--prune 1\)/);

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

test('--mcp <list> on global install merges only the selected servers into ~/.claude.json, not .claude/.mcp.json', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'context7,sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['context7', 'sequential-thinking']);
  assert.ok(!fs.existsSync(path.join(home, '.claude', '.mcp.json')), 'Claude Code never reads .claude/.mcp.json — it must not be written there');
});

test('--mcp <list> on project-scoped install writes <projectRoot>/.mcp.json, not <projectRoot>/.claude/.mcp.json', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const projectDir = tempDir(t, 'doflow-cli-e2e-project-');
  const r = run(['install', projectDir, '--force', '--no-backup', '--target', 'claude', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const mcpJson = JSON.parse(fs.readFileSync(path.join(projectDir, '.mcp.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(mcpJson.mcpServers), ['sequential-thinking']);
  assert.ok(!fs.existsSync(path.join(projectDir, '.claude', '.mcp.json')));
});

test('an install with no --mcp flag (non-interactive, piped stdin) selects none — safe by default', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /MCP: none selected by default/);
  // An empty selection with nothing owned leaves ~/.claude.json unwritten.
  const file = path.join(home, '.claude.json');
  const claudeJson = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers ?? {}).sort(), [], 'third-party servers are opt-in');
});

test('--mcp all adopts the full catalog; the notice is absent when a selection is explicit', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'all'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /MCP: none selected by default/);
  const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers).sort(), ['context7', 'sequential-thinking']);
});

test('update with no --mcp flag remembers the prior install\'s selection instead of reverting to all servers', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'context7'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['update', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  const claudeJson = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
  assert.deepStrictEqual(Object.keys(claudeJson.mcpServers), ['context7'], 'update must not silently re-add servers a prior install deliberately excluded');
});

test('update with an explicit --mcp overrides and re-persists the remembered selection', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('update --dry-run for an MCP-only change claims a backup exactly when the real run creates one', (t) => {
  // Regression test: the dry-run branch used to claim a backup whenever
  // --no-backup was absent, regardless of whether the real run would back anything up.
  const home = tempDir(t, 'doflow-cli-e2e-');
  let r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude'], { home });
  assert.strictEqual(r.status, 0, r.stderr);

  r = run(['update', '-g', '--force', '--dry-run', '--target', 'claude', '--mcp', 'sequential-thinking'], { home });
  assert.strictEqual(r.status, 0, r.stderr);
  const claimed = /Would back up \d+ file\(s\)/.test(r.stdout);

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

test('--mcp on install rejects an unknown server name with a clear message', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const r = run(['install', '-g', '--force', '--no-backup', '--target', 'claude', '--mcp', 'not-a-real-server'], { home });
  assert.notStrictEqual(r.status, 0);
  assert.match(r.stderr, /Unknown MCP server\(s\): not-a-real-server/);
});

test('doflow status reports the persisted MCP server selection', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('Claude lifecycle: fresh install owns the instructions asset in the neutral ledger with unchanged CLAUDE.md bytes', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
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

test('Gemini lifecycle: fresh install writes GEMINI.md (not AGENTS.md) and owns it in the neutral ledger', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
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

test('Claude lifecycle: remove strips only the managed section from CLAUDE.md, preserves foreign content, and updates the ledger', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
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

test("Gemini lifecycle: remove deletes GEMINI.md per the adapter's own remove() semantics, updating the ledger", (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
  const project = tempDir(t, 'doflow-cli-e2e-project-');
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

test('mixed -t claude,codex,gemini: install, update, and remove all reconcile in one invocation without cross-harness interference', (t) => {
  // Global scope (matching the existing "already up to date" convergence tests): a project-scoped
  // Claude install also rewrites settings.json's hook paths to ${CLAUDE_PROJECT_DIR} after the
  // copy, which is an orthogonal, pre-existing legacy-path concern unrelated to this lifecycle
  // wiring — global scope keeps this test focused on the three harnesses' lifecycle convergence.
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('doflow.lock pins resolved selections on install and clears on full removal', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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

test('reconcile reports drift, heals it onto the pin, and converges clean', (t) => {
  const home = tempDir(t, 'doflow-cli-e2e-');
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
  const bare = run(['reconcile', '-g', '--force'], { home: tempDir(t, 'doflow-cli-e2e-') });
  assert.strictEqual(bare.status, 0);
  assert.match(bare.stdout, /No doflow\.lock in this scope/);
});

