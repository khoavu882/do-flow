'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadStorageRegistry, validateStorageRegistry, renderSourcePattern, formatBound } = require('../../src/runtime/storage/registry');

const REPO = path.resolve(__dirname, '../..');

function validRegistry() { return structuredClone(loadStorageRegistry({ repoRoot: REPO })); }
function rejects(label, change, pattern) {
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

rejects('duplicate id', (r) => { r.stores[1].id = r.stores[0].id; }, /duplicate id/);
rejects('invalid id', (r) => { r.stores[0].id = 'Bad_id'; }, /id/);
rejects('unknown root', (r) => { r.stores[0].root = 'nowhere'; }, /root/);
rejects('parent path', (r) => { r.stores[0].path = '../outside'; }, /path/);
rejects('absolute path', (r) => { r.stores[0].path = '/outside'; }, /path/);
rejects('unknown entry', (r) => { r.stores[0].entry = 'link'; }, /entry/);
rejects('non-compiling match', (r) => { r.stores[0].match = '['; }, /match/);
rejects('unanchored match', (r) => { r.stores[0].match = 'log'; }, /anchored/);
rejects('unknown rule', (r) => { r.stores[0].rule = 'forever'; }, /rule/);
rejects('missing rule bound', (r) => { delete r.stores[0].bound.keepNewest; }, /bound/);
rejects('non-positive integer', (r) => { r.stores[0].bound.keepNewest = 0; }, /positive/);
rejects('existing without source', (r) => { delete r.stores.find((s) => s.rule === 'existing').source; }, /source/);
rejects('empty writers outside control and user settings', (r) => { r.stores[0].writers = []; }, /writers/);
rejects('external writer with empty reason', (r) => { r.externalWriters[0].reason = ''; }, /reason/);

test('IC-001: user-settings permits empty writers', () => {
  const registry = validRegistry();
  const store = registry.stores.find((item) => item.id === 'user-settings-project-doflow');
  assert.deepEqual(store.writers, []);
  assert.equal(validateStorageRegistry(registry).ok, true);
});

test('IC-001: existing source patterns accept literals and require values only for templates', () => {
  const literal = validRegistry().stores.find((store) => store.id === 'install-ledger-user-state');
  assert.equal(literal.bound.value, undefined);
  assert.equal(renderSourcePattern(literal), 'LEDGER_FILE');
  assert.equal(validateStorageRegistry(validRegistry()).ok, true);

  const templateMissingValue = validRegistry();
  const templated = templateMissingValue.stores.find((store) => store.id === 'installer-backups-user-doflow');
  delete templated.bound.value;
  assert.equal(validateStorageRegistry(templateMissingValue).ok, false);

  const template = validRegistry().stores.find((store) => store.id === 'installer-backups-user-doflow');
  assert.equal(renderSourcePattern(template), 'DEFAULT_BACKUP_RETENTION = 3');
});

test('IC-001: formatBound uses the canonical text for every rule', () => {
  const cases = [
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
  const actual = stores.map(({ id, root, path: storePath, rule, bound }) => ({ id, root, path: storePath, rule, bound }));
  const recordMatch = '^[A-Za-z0-9][A-Za-z0-9._-]*\\.json$';
  const expected = [
    ['verification-logs', 'project-state', 'verification/logs', 'count-and-age', { keepNewest: 40, maxAgeDays: 30 }],
    ['task-evidence', 'project-state', 'evidence', 'work', { finishedDays: 30 }], ['task-readiness', 'project-state', 'readiness', 'work', { finishedDays: 30 }], ['task-research', 'project-state', 'research', 'work', { finishedDays: 30 }], ['task-outcome', 'project-state', 'outcome', 'work', { finishedDays: 30 }], ['task-retrieval', 'project-state', 'retrieval', 'work', { finishedDays: 30 }], ['task-orchestration', 'project-state', 'orchestration', 'work', { finishedDays: 30 }],
    ['runs-project', 'project-state', 'runs', 'date-partition', { maxAgeDays: 180 }], ['runs-user', 'user-state', 'runs', 'date-partition', { maxAgeDays: 180 }], ['recovery-user', 'user-state', 'recovery', 'recovery', { keepNewest: 3 }], ['recovery-project', 'project-state', 'recovery', 'recovery', { keepNewest: 3 }], ['lifecycle-events', 'project-state', 'lifecycle/events', 'lifecycle-settled', { defaultHours: 4320 }], ['report-bodies', 'config-home', 'reports', 'report-orphan', { orphanGraceHours: 24, foreignMaxAgeDays: 180 }], ['session-dirs', 'config-home', 'session-env/sessions', 'age', { maxAgeDays: 30 }], ['project-dirs', 'config-home', 'session-env/projects', 'age', { maxAgeDays: 90 }],
    ['installer-backups-user-doflow', 'user-doflow', 'backups', 'existing', { value: 3, text: 'keep 3' }], ['installer-backups-project-doflow', 'project-doflow', 'backups', 'existing', { value: 3, text: 'keep 3' }], ['nudge-markers', 'config-home', 'session-env/nudge', 'existing', { value: 30, text: 'prune after 30 days' }], ['sessions-log', 'config-home', 'sessions.log', 'existing', { value: 500, text: 'keep last 500 lines' }], ['failure-events', 'config-home', 'failures', 'existing', { value: 4, text: 'keep 4 rotated files' }], ['install-ledger-user-state', 'user-state', 'ledger.json', 'existing', { text: 'one file, overwritten' }], ['install-ledger-project-state', 'project-state', 'ledger.json', 'existing', { text: 'one file, overwritten' }], ['lifecycle-control', 'project-state', 'lifecycle', 'existing', { text: 'self-cleaning' }], ['task-locks-project-state', 'project-state', '', 'existing', { value: 10000, text: 'removed on release; stale locks are broken' }], ['install-projections-user-doflow', 'user-doflow', '', 'existing', { text: 'owned by the install ledger' }], ['install-projections-project-doflow', 'project-doflow', '', 'existing', { text: 'owned by the install ledger' }], ['knowledge-index-user-doflow', 'user-doflow', 'index', 'existing', { text: 'rewritten atomically, sha-keyed' }], ['knowledge-index-project-doflow', 'project-doflow', 'index', 'existing', { text: 'rewritten atomically, sha-keyed' }], ['bench-worktrees', 'project-doflow', 'worktrees', 'existing', { text: 'removed per case by the bench runner, not shipped' }], ['user-settings-project-doflow', 'project-doflow', '', 'existing', { text: 'one line each, user-authored' }], ['user-settings-config-home', 'config-home', '', 'existing', { text: 'one line each, user-authored' }],
    ['state-ignore-project-state', 'project-state', '.gitignore', 'control', { text: 'state ignore file' }], ['state-ignore-user-state', 'user-state', '.gitignore', 'control', { text: 'state ignore file' }], ['upkeep-marker-project-state', 'project-state', 'upkeep-due', 'control', { text: 'daily upkeep marker' }], ['upkeep-marker-user-state', 'user-state', 'upkeep-due', 'control', { text: 'daily upkeep marker' }], ['upkeep-marker-config-home', 'config-home', 'upkeep-due', 'control', { text: 'daily upkeep marker' }], ['upkeep-lock-project-state', 'project-state', 'upkeep.lock', 'control', { text: 'upkeep pass lock' }], ['upkeep-lock-user-state', 'user-state', 'upkeep.lock', 'control', { text: 'upkeep pass lock' }], ['upkeep-lock-config-home', 'config-home', 'upkeep.lock', 'control', { text: 'upkeep pass lock' }], ['upkeep-roots', 'user-state', 'upkeep-roots', 'control', { text: 'project upkeep roots index' }], ['run-lock-project-state', 'project-state', '', 'control', { text: 'self-cleaning run lock and orphan sweep' }], ['run-lock-user-state', 'user-state', '', 'control', { text: 'self-cleaning run lock and orphan sweep' }],
  ].map(([id, root, storePath, rule, bound]) => ({ id, root, path: storePath, rule, bound }));
  assert.deepEqual(actual, expected);
  assert.equal(stores.find((s) => s.id === 'task-evidence').match, recordMatch);
});
