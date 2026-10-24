'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadStorageRegistry, validateStorageRegistry, renderSourcePattern, formatBound } = require('../../src/runtime/storage/registry.ts');

const REPO = path.resolve(__dirname, '../..');

function validRegistry() { return structuredClone(loadStorageRegistry({ repoRoot: REPO })); }
function rejects(label: any, change: any, pattern: any) {
  test(`IC-001 refuses the whole registry: ${label}`, () => {
    const registry = validRegistry();
    change(registry);
    const result = validateStorageRegistry(registry);
    assert.equal(result.ok, false);
    assert.match(result.errors.join('\n'), pattern);
  });
}

test('IC-001: shipped storage registry loads', () => {
  const registry = loadStorageRegistry({ repoRoot: REPO });
  assert.equal(registry.version, 1);
  assert.ok(registry.stores.length > 0);
});

rejects('duplicate id', (r: any) => { r.stores[1].id = r.stores[0].id; }, /duplicate id/);
rejects('invalid id', (r: any) => { r.stores[0].id = 'Bad_id'; }, /id/);
rejects('unknown root', (r: any) => { r.stores[0].root = 'nowhere'; }, /root/);
rejects('parent path', (r: any) => { r.stores[0].path = '../outside'; }, /path/);
rejects('absolute path', (r: any) => { r.stores[0].path = '/outside'; }, /path/);
rejects('unknown entry', (r: any) => { r.stores[0].entry = 'link'; }, /entry/);
rejects('non-compiling match', (r: any) => { r.stores[0].match = '['; }, /match/);
rejects('unanchored match', (r: any) => { r.stores[0].match = 'log'; }, /anchored/);
rejects('unknown rule', (r: any) => { r.stores[0].rule = 'forever'; }, /rule/);
rejects('missing rule bound', (r: any) => { delete r.stores[0].bound.keepNewest; }, /bound/);
rejects('non-positive integer', (r: any) => { r.stores[0].bound.keepNewest = 0; }, /positive/);
rejects('existing without source', (r: any) => { delete r.stores.find((s: any) => s.rule === 'existing').source; }, /source/);
rejects('empty writers outside control and user settings', (r: any) => { r.stores[0].writers = []; }, /writers/);
rejects('external writer with empty reason', (r: any) => { r.externalWriters[0].reason = ''; }, /reason/);
rejects('non-boolean bound.either', (r: any) => { r.stores.find((s: any) => s.id === 'verification-reuse').bound.either = 'yes'; }, /either/);
rejects('unknown bound key', (r: any) => { r.stores[0].bound.unknownKey = 1; }, /unknown key/);
rejects('bound.either on non-count-and-age rule', (r: any) => { r.stores.find((s: any) => s.id === 'verification-runs').bound.either = true; }, /unknown key/);

test('IC-001: user-settings declares the settings writer', () => {
  const registry = validRegistry();
  const stores = registry.stores.filter((item: any) => item.id.startsWith('user-settings-'));
  assert.equal(stores.length, 2);
  for (const store of stores) assert.deepEqual(store.writers, ['src/runtime/settings/write.ts']);
  assert.equal(validateStorageRegistry(registry).ok, true);
});

test('IC-001: existing source patterns accept literals and require values only for templates', () => {
  const literal = validRegistry().stores.find((store: any) => store.id === 'install-ledger-user-state');
  assert.equal(literal.bound.value, undefined);
  assert.equal(renderSourcePattern(literal), 'LEDGER_FILE');
  assert.equal(validateStorageRegistry(validRegistry()).ok, true);

  const templateMissingValue = validRegistry();
  const templated = templateMissingValue.stores.find((store: any) => store.id === 'installer-backups-user-doflow');
  delete templated.bound.value;
  assert.equal(validateStorageRegistry(templateMissingValue).ok, false);

  const template = validRegistry().stores.find((store: any) => store.id === 'installer-backups-user-doflow');
  assert.equal(renderSourcePattern(template), 'DEFAULT_BACKUP_RETENTION = 3');
});

test('IC-001: formatBound uses the canonical text for every rule', () => {
  const cases: any = [
    [{ rule: 'count-and-age', bound: { keepNewest: 40, maxAgeDays: 30 } }, 'keep newest 40; prune entries older than 30 days'],
    [{ rule: 'work', bound: { finishedDays: 30 } }, 'prune finished work after 30 days'],
    [{ rule: 'date-partition', bound: { maxAgeDays: 180 } }, 'prune partitions older than 180 days'],
    [{ rule: 'recovery', bound: { keepNewest: 3 } }, 'keep newest 3, plus the snapshot named by the ledger'],
    [{ rule: 'lifecycle-settled', bound: { defaultHours: 4320 } }, 'retain settled events for 4320 hours'],
    [{ rule: 'report-orphan', bound: { orphanGraceHours: 24, foreignMaxAgeDays: 180 } }, 'prune orphan bodies after 24 hours; foreign folders after 180 days'],
    [{ rule: 'age', bound: { maxAgeDays: 30 } }, 'prune inactive directories after 30 days'],
    [{ rule: 'existing', bound: { value: 3, text: 'keep 3' } }, 'keep 3'],
    [{ rule: 'control', bound: { text: 'self-cleaning' } }, 'self-cleaning'],
  ];
  for (const [store, expected] of cases) assert.equal(formatBound(store), expected);
});

test('IC-002: every shipped declaration has its approved id, root, path, rule, and bound', () => {
  const stores = loadStorageRegistry({ repoRoot: REPO }).stores;
  const actual = stores.map(({ id, root, path: storePath, rule, bound }: any) => ({ id, root, path: storePath, rule, bound }));
  const recordMatch = '^[A-Za-z0-9][A-Za-z0-9._-]*\\.json$';
  const expected = [
    ['verification-logs', 'project-state', 'verification/logs', 'count-and-age', { keepNewest: 40, maxAgeDays: 30 }],
    ['verification-runs', 'project-state', 'verification/runs', 'work', { finishedDays: 30 }],
    ['verification-v0', 'project-state', 'verification/v0', 'count-and-age', { keepNewest: 40, maxAgeDays: 7 }],
    ['verification-reuse', 'project-state', 'verification/reuse', 'count-and-age', { keepNewest: 400, maxAgeDays: 2, either: true }],
    ['task-evidence', 'project-state', 'evidence', 'work', { finishedDays: 30 }], ['task-delivery', 'project-state', 'delivery', 'work', { finishedDays: 30 }], ['task-readiness', 'project-state', 'readiness', 'work', { finishedDays: 30 }], ['task-research', 'project-state', 'research', 'work', { finishedDays: 30 }], ['task-outcome', 'project-state', 'outcome', 'work', { finishedDays: 30 }], ['task-retrieval', 'project-state', 'retrieval', 'work', { finishedDays: 30 }], ['task-attempts', 'project-state', 'task-attempts', 'work', { finishedDays: 30 }], ['worker-runs', 'project-state', 'worker-runs', 'work', { finishedDays: 30 }], ['worker-probes', 'project-state', 'worker-probes', 'count-and-age', { keepNewest: 16, maxAgeDays: 30 }], ['worker-output', 'project-state', 'worker-output', 'count-and-age', { keepNewest: 200, maxAgeDays: 30 }], ['dispatch', 'project-state', 'dispatch', 'work', { finishedDays: 30 }], ['roadmap', 'project-state', 'roadmap', 'work', { finishedDays: 30 }], ['dispatch-envelopes', 'project-state', 'dispatch-envelopes', 'count-and-age', { keepNewest: 400, maxAgeDays: 30 }], ['dispatch-worktrees', 'project-state', 'dispatch-worktrees', 'existing', { text: 'attempt worktrees removed by dispatch cleanup; the integration worktree stays for the user to merge' }], ['task-orchestration', 'project-state', 'orchestration', 'work', { finishedDays: 30 }],
    ['runs-project', 'project-state', 'runs', 'date-partition', { maxAgeDays: 180 }], ['runs-telemetry', 'project-state', 'runs/telemetry', 'date-partition', { maxAgeDays: 180 }], ['runs-user', 'user-state', 'runs', 'date-partition', { maxAgeDays: 180 }], ['advice-picks-project', 'project-state', 'advice/picks', 'date-partition', { maxAgeDays: 90 }], ['advice-picks-user', 'user-state', 'advice/picks', 'date-partition', { maxAgeDays: 90 }], ['slots-user', 'user-state', 'slots', 'count-and-age', { keepNewest: 64, maxAgeDays: 30 }], ['recovery-user', 'user-state', 'recovery', 'recovery', { keepNewest: 3 }], ['recovery-project', 'project-state', 'recovery', 'recovery', { keepNewest: 3 }], ['lifecycle-events', 'project-state', 'lifecycle/events', 'lifecycle-settled', { defaultHours: 4320 }], ['report-bodies', 'config-home', 'reports', 'report-orphan', { orphanGraceHours: 24, foreignMaxAgeDays: 180 }], ['session-dirs', 'config-home', 'session-env/sessions', 'age', { maxAgeDays: 30 }], ['project-dirs', 'config-home', 'session-env/projects', 'age', { maxAgeDays: 90 }], ['summary-scopes', 'config-home', 'session-env/summaries', 'age', { maxAgeDays: 90 }], ['summary-grants', 'config-home', 'session-env/grants', 'age', { maxAgeDays: 90 }],
    ['installer-backups-user-doflow', 'user-doflow', 'backups', 'existing', { value: 3, text: 'keep 3' }], ['installer-backups-project-doflow', 'project-doflow', 'backups', 'existing', { value: 3, text: 'keep 3' }], ['nudge-markers', 'config-home', 'session-env/nudge', 'existing', { value: 30, text: 'prune after 30 days' }], ['sessions-log', 'config-home', 'sessions.log', 'existing', { value: 500, text: 'keep last 500 lines' }], ['failure-events', 'config-home', 'failures', 'existing', { value: 4, text: 'keep 4 rotated files' }], ['autopilot-switch', 'config-home', 'autopilot', 'existing', { text: 'one sentinel file; only a person removes it' }], ['roadmap-audit', 'project-state', 'roadmap/audit.jsonl', 'existing', { value: 10000, text: 'keep the last 10000 gate, merge, render and cleanup entries' }], ['install-ledger-user-state', 'user-state', 'ledger.json', 'existing', { text: 'one file, overwritten' }], ['install-ledger-project-state', 'project-state', 'ledger.json', 'existing', { text: 'one file, overwritten' }], ['lifecycle-control', 'project-state', 'lifecycle', 'existing', { text: 'self-cleaning' }], ['task-locks-project-state', 'project-state', '', 'existing', { value: 10000, text: 'removed on release; a stale lock is reclaimed in place' }], ['install-projections-user-doflow', 'user-doflow', '', 'existing', { text: 'owned by the install ledger' }], ['install-projections-project-doflow', 'project-doflow', '', 'existing', { text: 'owned by the install ledger' }], ['knowledge-index-user-doflow', 'user-doflow', 'index', 'existing', { text: 'rewritten atomically, sha-keyed' }], ['knowledge-index-project-doflow', 'project-doflow', 'index', 'existing', { text: 'rewritten atomically, sha-keyed' }], ['bench-worktrees', 'project-doflow', 'worktrees', 'existing', { text: 'removed per case by the bench runner, not shipped' }], ['user-settings-project-doflow', 'project-doflow', '', 'existing', { text: 'prompt-nudge and prune are one line each; decision-model.json, settings.json and settings.local.json are JSON objects; settings.json files are written atomically by settings writers' }], ['user-settings-config-home', 'config-home', '', 'existing', { text: 'prompt-nudge and prune are one line each; decision-model.json and settings.json are JSON objects; settings.json is written atomically by settings writers' }], ['settings-writer-project-doflow', 'project-doflow', '', 'existing', { text: "a settings writer holds the file's .lock for one read-merge-rename and removes it; a lock is never removed automatically: a held lock of any age refuses the write, and a person removes the lock file when no writer is running; config set and unset keep the bytes they replace in one .config.bak beside the file, replaced on each write" }], ['settings-writer-config-home', 'config-home', '', 'existing', { text: "a settings writer holds the file's .lock for one read-merge-rename and removes it; a lock is never removed automatically: a held lock of any age refuses the write, and a person removes the lock file when no writer is running; config set and unset keep the bytes they replace in one .config.bak beside the file, replaced on each write" }],
    ['state-ignore-project-state', 'project-state', '.gitignore', 'control', { text: 'state ignore file' }], ['state-ignore-user-state', 'user-state', '.gitignore', 'control', { text: 'state ignore file' }], ['upkeep-marker-project-state', 'project-state', 'upkeep-due', 'control', { text: 'daily upkeep marker' }], ['upkeep-marker-user-state', 'user-state', 'upkeep-due', 'control', { text: 'daily upkeep marker' }], ['upkeep-marker-config-home', 'config-home', 'upkeep-due', 'control', { text: 'daily upkeep marker' }], ['upkeep-lock-project-state', 'project-state', 'upkeep.lock', 'control', { text: 'upkeep pass lock' }], ['upkeep-lock-user-state', 'user-state', 'upkeep.lock', 'control', { text: 'upkeep pass lock' }], ['upkeep-lock-config-home', 'config-home', 'upkeep.lock', 'control', { text: 'upkeep pass lock' }], ['upkeep-roots', 'user-state', 'upkeep-roots', 'control', { text: 'project upkeep roots index' }], ['run-lock-project-state', 'project-state', '', 'control', { text: 'self-cleaning run lock and orphan sweep' }], ['run-lock-user-state', 'user-state', '', 'control', { text: 'self-cleaning run lock and orphan sweep' }],
    ['code-semantic-project', 'project-doflow', 'index/code', 'existing', { text: 'Explicit bounded local semantic lifecycle; corpus/model manifests, ordinary mirror copies, provider cache, operation lock, in-progress marker and staging; query temporary stats/ sink capped at 64 KiB and library/ (provider grammar and library cache) capped at 128 MiB (libraryBytes), both removed in finally or on the next explicit operation; sourceReadBytes is an over-count of provider reads under Semble 0.7.0.' }],
    ['packages-store', 'user-doflow', 'packages/store', 'existing', { text: 'one directory per package id, kept until the package is removed' }],
    ['packages-plans', 'user-doflow', 'packages/plans', 'count-and-age', { keepNewest: 256, maxAgeDays: 1, either: true }],
    ['packages-staging', 'user-doflow', 'packages/store', 'age', { maxAgeDays: 1 }],
    ['packages-fetched', 'user-doflow', 'packages/fetched', 'count-and-age', { keepNewest: 256, maxAgeDays: 1, either: true }],
    ['packages-fetch-staging', 'user-doflow', 'packages/fetched', 'age', { maxAgeDays: 1 }],
    ['packages-state', 'user-doflow', 'packages/state.json', 'existing', { text: 'narrowing facts only, rewritten atomically with mode 0600 and kept' }],
    ['authored-packages-project-doflow', 'project-doflow', 'package', 'existing', { text: "the person's authored package source: DoFlow never prunes, moves or removes it" }],
    ['authored-packages-staging-project-doflow', 'project-doflow', 'package', 'existing', { text: 'removed by the scaffold itself after 24 hours' }],
  ].map(([id, root, storePath, rule, bound]) => ({ id, root, path: storePath, rule, bound }));
  assert.deepEqual(actual, expected);
  const reuse = stores.find((s: any) => s.id === 'verification-reuse');
  assert.equal(reuse.entry, 'file');
  assert.equal(reuse.match, '^reuse-[0-9a-f]{16}\\.json$|^reuse-[0-9a-f]{16}\\.[0-9a-f]{32}\\.tmp$');
  assert.equal(reuse.protect, null);
  assert.deepEqual(reuse.moments, ['verify', 'verb']);
  assert.deepEqual(reuse.writers, ['src/runtime/verification/reuse.ts']);
  assert.equal(stores.find((s: any) => s.id === 'task-evidence').match, recordMatch);
});
