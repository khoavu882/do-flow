'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPiAdapter } = require('../../../src/adapters/pi');
const { createAdapterRegistry } = require('../../../src/adapters');
const { fingerprint } = require('../../../src/adapters/copy-tree');
const { SKELETON, renderNewDocument } = require('../../../src/adapters/pi/json-members');
const { declaredHarnessPaths, resolveHarnessPaths } = require('../../../src/helper/harness-paths');
const { loadRegistry, selectMcpServers, harnessFor } = require('../../../src/registry');
const { planLifecycle, applyLifecycle, removeLifecycle, updateLedger } = require('../../../src/lifecycle');
const { defaultLedger } = require('../../../src/state');

const REPO = path.resolve(__dirname, '../../..');
const registry = loadRegistry({ repoRoot: REPO });
const SERVERS = selectMcpServers(registry);
const ASSETS = [{ id: 'guidance.codex-pointer' }];
const ENTRY = Object.fromEntries(SERVERS.map((server) => [server.id, { command: server.command, args: server.args }]));
const NOTICE = {
  N1: 'MCP: stdio servers are registered in the mcpServers map of Pi\'s mcp.json for its built-in MCP (Pi 0.99.0 or later; project entries override user entries from Pi 1.0.1).',
  N2: 'MCP: an installed extension that registers /mcp, such as pi-mcp-adapter, replaces Pi\'s built-in MCP, and Pi then does not read mcp.json.',
  N3: 'MCP: Pi reads .pi/mcp.json only after this project is trusted (/trust or --approve); DoFlow does not grant trust.',
};

function scratch() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-pi-mcp-'))); }

function userFile(root) { return path.join(root, '.pi', 'agent', 'mcp.json'); }

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function mcpChanges(planned) { return planned.changes.filter((change) => change.projection?.renderer === 'pi-mcp'); }

function mcpRowsOf(ledger) { return ledger.resources.filter((row) => row.kind === 'mcp-server'); }

/** Plan one Pi adapter run the way the lifecycle does: discovery first, then plan from it. */
function planRun({ adapter = createPiAdapter({ env: {} }), scope = 'global', root, mcp = SERVERS, ledger, operation = 'apply', context = {} }) {
  const input = { scope, scopeRoot: root, assets: ASSETS, mcp, ledger: ledger ?? defaultLedger({ scope, scopeRoot: root }), context: { ...context, operation } };
  const discovery = adapter.discover(input);
  const planned = adapter.plan({ ...input, discovery });
  return { adapter, input, discovery, planned };
}

/** Plan, apply or remove, verify against the plan-time discovery, and fold the result into the
 * ledger through the lifecycle's own updateLedger. */
function run(options) {
  const { adapter, input, discovery, planned } = planRun(options);
  assert.deepEqual(planned.conflicts, []);
  const changes = planned.changes.map((change) => ({ ...change, harness: 'pi' }));
  adapter[input.context.operation === 'remove' ? 'remove' : 'apply']({ changes });
  const verification = adapter.verify({ ...input, discovery });
  const ledger = updateLedger({ ledger: input.ledger, scope: input.scope, scopeRoot: input.scopeRoot,
    verifications: [{ ...verification, harness: 'pi' }], changes, recoveryRef: 'test-run' });
  return { planned, verification, ledger };
}

/** A user's global mcp.json: four-space indent, two own servers, an unrelated key and a secret. */
const USER_TEXT = '{\n    "autoEnableCodemode": false,\n    "mcpServers": {\n        "mine": {\n            "command": "my-server",\n            "env": { "TOKEN": "SECRET-123" }\n        },\n        "other":   {"url": "https://example.test/mcp"}\n    }\n}\n';

test('P17 (paths): the Pi registry row declares per-scope paths.mcp', () => {
  const root = scratch();
  const home = scratch();
  const declared = declaredHarnessPaths().pi;
  assert.equal(resolveHarnessPaths(declared, { scope: 'project', scopeRoot: root }).mcp, path.join(root, '.pi', 'mcp.json'));
  assert.equal(resolveHarnessPaths(declared, { scope: 'user', scopeRoot: home, homeDir: home }).mcp, path.join(home, '.pi', 'agent', 'mcp.json'));
});

test('P2 (paths): nativePaths().mcp resolves per scope without an override', () => {
  const root = scratch();
  const adapter = createPiAdapter({ env: {} });
  assert.equal(adapter.nativePaths({ scope: 'project', scopeRoot: root }).mcp, path.join(root, '.pi', 'mcp.json'));
  assert.equal(adapter.nativePaths({ scope: 'global', scopeRoot: root }).mcp, path.join(root, '.pi', 'agent', 'mcp.json'));
  assert.equal(adapter.nativePaths({ scope: 'user', scopeRoot: root }).mcp, path.join(root, '.pi', 'agent', 'mcp.json'));
});

test('P2 (paths): PI_CODING_AGENT_DIR moves only the user-scope mcp.json', () => {
  const root = scratch();
  const agentDir = path.join(scratch(), 'agent-home');
  const adapter = createPiAdapter({ env: { PI_CODING_AGENT_DIR: agentDir } });
  const baseline = createPiAdapter({ env: {} });
  const user = adapter.nativePaths({ scope: 'global', scopeRoot: root });
  assert.equal(user.mcp, path.join(agentDir, 'mcp.json'));
  assert.equal(adapter.nativePaths({ scope: 'user', scopeRoot: root }).mcp, path.join(agentDir, 'mcp.json'));
  for (const key of ['root', 'configDir', 'settings', 'instruction']) {
    assert.equal(user[key], baseline.nativePaths({ scope: 'global', scopeRoot: root })[key], key);
  }
  assert.equal(adapter.nativePaths({ scope: 'project', scopeRoot: root }).mcp, path.join(root, '.pi', 'mcp.json'));
});

test('P2 (paths): an empty or whitespace PI_CODING_AGENT_DIR is ignored', () => {
  const root = scratch();
  for (const value of ['', '   ', '\t\n']) {
    const adapter = createPiAdapter({ env: { PI_CODING_AGENT_DIR: value } });
    assert.equal(adapter.nativePaths({ scope: 'global', scopeRoot: root }).mcp, path.join(root, '.pi', 'agent', 'mcp.json'));
  }
});

test('P2 (paths): a relative PI_CODING_AGENT_DIR resolves against the working directory and ~ is not expanded', () => {
  const root = scratch();
  const relative = createPiAdapter({ env: { PI_CODING_AGENT_DIR: 'rel/agent' } });
  assert.equal(relative.nativePaths({ scope: 'global', scopeRoot: root }).mcp, path.join(path.resolve('rel/agent'), 'mcp.json'));
  const tilde = createPiAdapter({ env: { PI_CODING_AGENT_DIR: '~/agent' } });
  assert.equal(tilde.nativePaths({ scope: 'global', scopeRoot: root }).mcp, path.join(path.resolve('~/agent'), 'mcp.json'));
});

test('P1: a global install with no file writes the new document in catalog order and verifies one resource per server', () => {
  const root = scratch();
  const { verification, ledger } = run({ root });
  const file = userFile(root);
  assert.equal(fs.readFileSync(file, 'utf8'), renderNewDocument(SERVERS.map((server) => [server.id, ENTRY[server.id]])));
  const resources = verification.resources.filter((resource) => resource.kind === 'mcp-server');
  assert.deepEqual(resources, SERVERS.map((server) => ({
    assetId: 'guidance.codex-pointer', target: file, ownershipIdentity: `doflow:pi:mcp-server:${server.id}`,
    kind: 'mcp-server', identity: server.id, fingerprint: fingerprint(ENTRY[server.id]), sourceVersion: 'registry-v1',
    projection: { renderer: 'pi-mcp' },
  })));
  assert.equal(mcpRowsOf(ledger).length, SERVERS.length);
  assert.ok(verification.statuses.filter((status) => status.capability === 'mcp').every((status) => status.status === 'managed'));
});

test('P2 (writes): PI_CODING_AGENT_DIR receives the file; an empty or whitespace value writes the declared path', () => {
  const root = scratch();
  const agentDir = path.join(scratch(), 'agent');
  run({ root, adapter: createPiAdapter({ env: { PI_CODING_AGENT_DIR: agentDir } }) });
  assert.ok(fs.existsSync(path.join(agentDir, 'mcp.json')));
  assert.equal(fs.existsSync(userFile(root)), false);
  for (const value of ['', '  ']) {
    const other = scratch();
    run({ root: other, adapter: createPiAdapter({ env: { PI_CODING_AGENT_DIR: value } }) });
    assert.ok(fs.existsSync(userFile(other)), JSON.stringify(value));
  }
});

test('P3: a project plan writes .pi/mcp.json and adds the trust notice; a global plan does not', () => {
  const root = scratch();
  const { planned } = run({ root, scope: 'project' });
  assert.ok(fs.existsSync(path.join(root, '.pi', 'mcp.json')));
  assert.deepEqual(planned.notices, [NOTICE.N1, NOTICE.N2, NOTICE.N3]);
  const global = planRun({ root: scratch() }).planned;
  assert.deepEqual(global.notices, [NOTICE.N1, NOTICE.N2]);
  for (const notice of Object.values(NOTICE)) assert.ok(notice.length <= 200);
});

test('P4: every byte of a user file survives install, update and remove; no change carries file text', () => {
  const root = scratch();
  const file = userFile(root);
  writeFile(file, USER_TEXT);
  const insertionPoint = USER_TEXT.indexOf('}', USER_TEXT.indexOf('"other"')) + 1;
  const keepsUserBytes = (text) => {
    assert.equal(text.slice(0, insertionPoint), USER_TEXT.slice(0, insertionPoint));
    assert.equal(text.slice(text.length - (USER_TEXT.length - insertionPoint)), USER_TEXT.slice(insertionPoint));
  };

  const install = run({ root });
  assert.ok(!JSON.stringify(install.planned.changes).includes('SECRET-123'), 'a plan change copied the user file');
  const installed = fs.readFileSync(file, 'utf8');
  keepsUserBytes(installed);
  assert.deepEqual(JSON.parse(installed).mcpServers.context7, ENTRY.context7);
  assert.ok(installed.includes('\n        "context7": {\n            "command": "npx",'), 'the inserted member follows the four-space layout');

  const changed = SERVERS.map((server) => (server.id === 'context7' ? { ...server, args: ['-y', '@upstash/context7-mcp@2'] } : server));
  const update = run({ root, mcp: changed, ledger: install.ledger });
  assert.deepEqual(mcpChanges(update.planned).map((change) => change.operation), ['update']);
  assert.ok(!JSON.stringify(update.planned.changes).includes('SECRET-123'));
  keepsUserBytes(fs.readFileSync(file, 'utf8'));

  const removal = run({ root, mcp: [], ledger: update.ledger, operation: 'remove' });
  assert.ok(!JSON.stringify(removal.planned.changes).includes('SECRET-123'));
  assert.equal(fs.readFileSync(file, 'utf8'), USER_TEXT);
  assert.deepEqual(mcpRowsOf(removal.ledger), []);
});

test('P5: a user entry with a DoFlow name, or the same name with _ for -, is kept, reported and never owned', () => {
  const root = scratch();
  const file = userFile(root);
  const text = '{"mcpServers": {"context7": {"command": "mine"}, "sequential_thinking": {"command": "also-mine"}}}';
  writeFile(file, text);
  const { planned, verification, ledger } = run({ root });
  assert.deepEqual(mcpChanges(planned), []);
  assert.ok(planned.notices.includes('MCP: kept your own entry \'context7\' and did not register DoFlow\'s \'context7\'; rename or remove yours to let DoFlow manage it.'));
  assert.ok(planned.notices.includes('MCP: kept your own entry \'sequential_thinking\' and did not register DoFlow\'s \'sequential-thinking\'; rename or remove yours to let DoFlow manage it.'));
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(verification.resources.filter((resource) => resource.kind === 'mcp-server'), []);
  assert.deepEqual(mcpRowsOf(ledger), []);
  assert.deepEqual(verification.statuses.filter((status) => status.capability === 'mcp').map((status) => status.status), ['not-managed', 'not-managed']);
});

test('P6: an unparseable mcp.json is a plan conflict with no MCP change, no write and no temp file', () => {
  const root = scratch();
  const file = userFile(root);
  writeFile(file, '{"mcpServers": {,}');
  const { adapter, planned } = planRun({ root });
  assert.equal(planned.conflicts.length, 1);
  assert.match(planned.conflicts[0], new RegExp(`^Pi MCP: ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: invalid JSON( at line \\d+ column \\d+)?; DoFlow did not change the file$`));
  assert.deepEqual(mcpChanges(planned), []);
  adapter.apply({ changes: planned.changes });
  assert.equal(fs.readFileSync(file, 'utf8'), '{"mcpServers": {,}');
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp.json']);
});

test('P6: a malformed file holding a secret never puts it in a conflict, notice, thrown error or recovery record', () => {
  // V8 quotes only a few characters around the error, so the check is for the token's prefix.
  const secret = 'SECRET';
  const malformed = `{"mcpServers": {"mine": {"command": "x", "env": {"TOKEN": ${secret}-TOKEN-4242}}}}`;
  const root = scratch();
  const file = userFile(root);
  writeFile(file, malformed);
  const adapters = createAdapterRegistry({ pi: createPiAdapter({ env: {} }) });
  const context = { repoRoot: REPO, projectRoot: root, homeDir: root, sourceVersion: 'test' };
  const plan = planLifecycle({ registry, adapters, scope: 'global', scopeRoot: root, targets: ['pi'], ledger: defaultLedger({ scope: 'global', scopeRoot: root }), context });
  assert.equal(plan.safe, false);
  assert.ok(!JSON.stringify(plan.conflicts).includes(secret) && !JSON.stringify(plan.notices).includes(secret));

  // Verification re-reads the file: one that turns malformed after apply fails the run, and the
  // failure lands in the recovery record and the thrown error.
  fs.rmSync(file);
  const pi = createPiAdapter({ env: {} });
  const corrupting = createAdapterRegistry({ pi: { ...pi, apply(input) { const result = pi.apply(input); fs.writeFileSync(file, malformed); return result; } } });
  const clean = planLifecycle({ registry, adapters: corrupting, scope: 'global', scopeRoot: root, targets: ['pi'], ledger: defaultLedger({ scope: 'global', scopeRoot: root }), context });
  const stateRoot = scratch();
  assert.throws(() => applyLifecycle({ plan: clean, registry, adapters: corrupting, stateRoot, ledger: clean.ledger }),
    (error) => !error.message.includes(secret));
  const records = fs.readdirSync(path.join(stateRoot, 'recovery')).map((name) => fs.readFileSync(path.join(stateRoot, 'recovery', name), 'utf8'));
  assert.ok(records.some((record) => record.includes('Pi MCP:')), 'the verification conflict must be recorded');
  assert.ok(records.every((record) => !record.includes(secret)), 'a recovery record copied the secret');
});

test('P7: a top-level array and a non-object mcpServers are conflicts with no write', () => {
  for (const [text, reason] of [['[]', 'top level is not an object'], ['{"mcpServers": ["x"]}', 'mcpServers is not an object']]) {
    const root = scratch();
    const file = userFile(root);
    writeFile(file, text);
    const { adapter, planned } = planRun({ root });
    assert.deepEqual(planned.conflicts, [`Pi MCP: ${file}: ${reason}; DoFlow did not change the file`]);
    assert.deepEqual(mcpChanges(planned), []);
    adapter.apply({ changes: planned.changes });
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('P8: re-planning a completed install changes nothing and leaves the ledger rows as they were', () => {
  const root = scratch();
  writeFile(userFile(root), USER_TEXT);
  const first = run({ root });
  const bytes = fs.readFileSync(userFile(root), 'utf8');
  const second = run({ root, ledger: first.ledger });
  assert.deepEqual(mcpChanges(second.planned), []);
  assert.equal(fs.readFileSync(userFile(root), 'utf8'), bytes);
  assert.deepEqual(mcpRowsOf(second.ledger), mcpRowsOf(first.ledger));
});

test('P9: deselecting an owned server removes only its entry', () => {
  const root = scratch();
  writeFile(userFile(root), USER_TEXT);
  const first = run({ root });
  const second = run({ root, mcp: SERVERS.filter((server) => server.id === 'context7'), ledger: first.ledger });
  assert.deepEqual(mcpChanges(second.planned).map((change) => [change.operation, change.identity, Boolean(change.release)]),
    [['remove', 'sequential-thinking', false]]);
  const value = JSON.parse(fs.readFileSync(userFile(root), 'utf8'));
  assert.deepEqual(Object.keys(value.mcpServers), ['mine', 'other', 'context7']);
  assert.equal(value.autoEnableCodemode, false);
  assert.deepEqual(mcpRowsOf(second.ledger).map((row) => row.identity), ['context7']);
});

test('P10: an owned entry the user edited is released with N5 and survives update and remove', () => {
  const root = scratch();
  const file = userFile(root);
  const first = run({ root });
  const edited = fs.readFileSync(file, 'utf8').replace('"command": "npx",\n      "args": [\n        "-y",\n        "@upstash/context7-mcp"\n      ]',
    '"command": "npx",\n      "args": [\n        "-y",\n        "@upstash/context7-mcp"\n      ],\n      "enabled": false');
  assert.notEqual(edited, fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, edited);

  const update = run({ root, ledger: first.ledger });
  assert.deepEqual(mcpChanges(update.planned).map((change) => [change.operation, change.identity, change.release]), [['remove', 'context7', true]]);
  assert.ok(update.planned.notices.includes('MCP: entry \'context7\' was changed outside DoFlow; it is yours now and DoFlow no longer updates or removes it.'));
  assert.equal(fs.readFileSync(file, 'utf8'), edited);
  assert.deepEqual(mcpRowsOf(update.ledger).map((row) => row.identity), ['sequential-thinking']);

  const removal = run({ root, mcp: [], ledger: update.ledger, operation: 'remove' });
  assert.equal(removal.verification.statuses.find((status) => status.identity === 'context7'), undefined);
  const left = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(left.mcpServers, { context7: { ...ENTRY.context7, enabled: false } });
  assert.deepEqual(mcpRowsOf(removal.ledger), []);
});

test('P10: an owned entry edited before a remove is released by the remove and left in place', () => {
  const root = scratch();
  const file = userFile(root);
  const first = run({ root });
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.mcpServers.context7.args.push('--verbose');
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const removal = run({ root, mcp: [], ledger: first.ledger, operation: 'remove' });
  assert.deepEqual(mcpChanges(removal.planned).map((change) => [change.operation, change.identity, Boolean(change.release)]),
    [['remove', 'context7', true], ['remove', 'sequential-thinking', false]]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers, { context7: value.mcpServers.context7 });
  assert.deepEqual(mcpRowsOf(removal.ledger), []);
});

test('P11: an empty selection with owned rows changes nothing, keeps the rows and prints no MCP notice', () => {
  const root = scratch();
  const first = run({ root });
  const bytes = fs.readFileSync(userFile(root), 'utf8');
  const second = run({ root, mcp: [], ledger: first.ledger });
  assert.deepEqual(mcpChanges(second.planned), []);
  assert.deepEqual(second.planned.notices.filter((notice) => notice.startsWith('MCP:')), []);
  assert.equal(fs.readFileSync(userFile(root), 'utf8'), bytes);
  assert.deepEqual(mcpRowsOf(second.ledger), mcpRowsOf(first.ledger));
});

test('P11: with no selection and no rows the plan does not read mcp.json at all', () => {
  const root = scratch();
  writeFile(userFile(root), 'not json');
  const { planned, discovery } = planRun({ root, mcp: [] });
  assert.deepEqual(planned.conflicts, []);
  assert.deepEqual(discovery.mcp, {});
});

test('P12: remove deletes owned entries, deletes a file left as the skeleton, and keeps user content', () => {
  const root = scratch();
  const first = run({ root });
  run({ root, mcp: [], ledger: first.ledger, operation: 'remove' });
  assert.equal(fs.existsSync(userFile(root)), false, 'a file DoFlow created and emptied is deleted');

  const project = scratch();
  const file = path.join(project, '.pi', 'mcp.json');
  const text = '{\n  "mcpServers": {\n    "mine": {"command": "x"}\n  }\n}\n';
  writeFile(file, text);
  const installed = run({ root: project, scope: 'project' });
  const removed = run({ root: project, scope: 'project', mcp: [], ledger: installed.ledger, operation: 'remove' });
  assert.equal(fs.readFileSync(file, 'utf8'), text);
  assert.deepEqual(removed.verification.statuses.filter((status) => status.capability === 'mcp').map((status) => status.status), ['absent', 'absent']);
});

test('P12: remove touches only what the ledger owns, even an entry named like a catalog server', () => {
  const root = scratch();
  const file = userFile(root);
  const text = '{"mcpServers": {"context7": {"command": "npx", "args": ["-y", "@upstash/context7-mcp"]}}}';
  writeFile(file, text);
  const { planned } = run({ root, mcp: [], operation: 'remove' });
  assert.deepEqual(mcpChanges(planned), []);
  assert.equal(fs.readFileSync(file, 'utf8'), text);
});

test('P13: an owned entry the user deleted is re-created on install', () => {
  const root = scratch();
  const first = run({ root });
  const file = userFile(root);
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete value.mcpServers['sequential-thinking'];
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  const second = run({ root, ledger: first.ledger });
  assert.deepEqual(mcpChanges(second.planned).map((change) => [change.operation, change.identity]), [['create', 'sequential-thinking']]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers['sequential-thinking'], ENTRY['sequential-thinking']);
});

test('P14: a file that changes between plan and apply refuses the apply and keeps the changed bytes', () => {
  const root = scratch();
  const file = userFile(root);
  writeFile(file, USER_TEXT);
  const { adapter, planned } = planRun({ root });
  const changed = USER_TEXT.replace('"autoEnableCodemode": false', '"autoEnableCodemode": true');
  fs.writeFileSync(file, changed);
  assert.throws(() => adapter.apply({ changes: planned.changes }), { message: `Pi MCP: ${file} changed after planning; nothing was written, re-run the command` });
  assert.equal(fs.readFileSync(file, 'utf8'), changed);

  const absentRoot = scratch();
  const late = planRun({ root: absentRoot });
  writeFile(userFile(absentRoot), '{}');
  assert.throws(() => late.adapter.apply({ changes: late.planned.changes }), /changed after planning/);
  assert.equal(fs.readFileSync(userFile(absentRoot), 'utf8'), '{}');
});

test('P15: a failing rename leaves the original bytes and no temp file', () => {
  const root = scratch();
  const file = userFile(root);
  writeFile(file, USER_TEXT);
  const { adapter, planned } = planRun({ root });
  const fsImpl = { ...fs, renameSync() { throw new Error('rename refused'); } };
  assert.throws(() => adapter.apply({ changes: planned.changes, fsImpl }), /rename refused/);
  assert.equal(fs.readFileSync(file, 'utf8'), USER_TEXT);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['mcp.json']);
});

test('P16: an owned row whose file moved is removed from the old file and created in the new one', () => {
  const root = scratch();
  const oldDir = path.join(scratch(), 'old-agent');
  const oldFile = path.join(oldDir, 'mcp.json');
  writeFile(oldFile, '{\n  "mcpServers": {\n    "mine": {"command": "x"}\n  }\n}\n');
  const first = run({ root, adapter: createPiAdapter({ env: { PI_CODING_AGENT_DIR: oldDir } }) });
  assert.ok(mcpRowsOf(first.ledger).every((row) => row.target === oldFile));

  const second = run({ root, ledger: first.ledger });
  assert.deepEqual(mcpChanges(second.planned).map((change) => [change.operation, change.target]), [
    ['create', userFile(root)], ['create', userFile(root)], ['remove', oldFile], ['remove', oldFile],
  ]);
  assert.equal(fs.readFileSync(oldFile, 'utf8'), '{\n  "mcpServers": {\n    "mine": {"command": "x"}\n  }\n}\n');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(userFile(root), 'utf8')).mcpServers), SERVERS.map((server) => server.id));
  assert.ok(mcpRowsOf(second.ledger).every((row) => row.target === userFile(root)));
  assert.equal(mcpRowsOf(second.ledger).length, SERVERS.length);
});

test('P17 (capability): Pi declares MCP supported with its MCP pages and .pi/mcp.json as the native target', () => {
  const pi = harnessFor(registry, 'pi');
  assert.equal(pi.capabilities.mcp.status, 'supported');
  for (const url of ['https://pi.dev/docs/latest/mcp', 'https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/mcp.md']) {
    assert.ok(pi.capabilities.mcp.evidence.includes(url), url);
  }
  assert.equal(pi.nativeTargets.mcp, '.pi/mcp.json');
});

test('P18: the lifecycle installs and removes Pi MCP rows on the real registry at both scopes', () => {
  for (const scope of ['global', 'project']) {
    const root = scratch();
    const stateRoot = scratch();
    const adapters = createAdapterRegistry({ pi: createPiAdapter({ env: {} }) });
    const context = { repoRoot: REPO, projectRoot: root, homeDir: root, sourceVersion: 'test' };
    const plan = planLifecycle({ registry, adapters, scope, scopeRoot: root, targets: ['pi'], ledger: defaultLedger({ scope, scopeRoot: root }), context });
    assert.equal(plan.safe, true, JSON.stringify(plan.conflicts));
    const installed = applyLifecycle({ plan, registry, adapters, stateRoot, ledger: plan.ledger });
    const file = scope === 'global' ? userFile(root) : path.join(root, '.pi', 'mcp.json');
    assert.deepEqual(mcpRowsOf(installed.ledger), SERVERS.map((server) => ({
      assetId: 'guidance.codex-pointer', target: file, ownershipIdentity: `doflow:pi:mcp-server:${server.id}`,
      kind: 'mcp-server', identity: server.id, fingerprint: fingerprint(ENTRY[server.id]), sourceVersion: 'registry-v1',
      projection: { renderer: 'pi-mcp' }, harness: 'pi', scope, recoveryRef: installed.recovery.id,
    })), scope);

    const removed = removeLifecycle({ registry, adapters, scope, scopeRoot: root, targets: ['pi'], mcpIds: [], stateRoot, ledger: installed.ledger, context });
    assert.equal(removed.verification.ok, true, scope);
    assert.deepEqual(mcpRowsOf(removed.ledger), [], scope);
    assert.equal(fs.existsSync(file), false, scope);
  }
});

test('P19: --force and --adopt never take a user entry or re-own an edited one', () => {
  const context = { force: true, adopt: true };
  const root = scratch();
  const file = userFile(root);
  const first = run({ root });
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  value.mcpServers['sequential-thinking'].enabled = false;
  const edited = `${JSON.stringify(value, null, 2)}\n`;
  fs.writeFileSync(file, edited);
  const update = run({ root, ledger: first.ledger, context });
  assert.deepEqual(mcpChanges(update.planned).map((change) => [change.operation, change.identity, change.release]), [['remove', 'sequential-thinking', true]]);
  assert.equal(fs.readFileSync(file, 'utf8'), edited);

  const other = scratch();
  const userText = '{"mcpServers": {"context7": {"command": "mine"}}}';
  writeFile(userFile(other), userText);
  const collided = run({ root: other, context });
  assert.deepEqual(mcpChanges(collided.planned).map((change) => [change.operation, change.identity]), [['create', 'sequential-thinking']]);
  const after = fs.readFileSync(userFile(other), 'utf8');
  assert.ok(after.startsWith('{"mcpServers": {"context7": {"command": "mine"}'), after);
  assert.deepEqual(JSON.parse(after).mcpServers.context7, { command: 'mine' });
});

test('P20: a non-stdio server and an invalid server name are refused', () => {
  const root = scratch();
  const remote = { id: 'remote', transport: 'http', url: 'https://example.test/mcp' };
  const badName = { id: 'bad name', transport: 'stdio', command: 'x' };
  const { planned } = planRun({ root, mcp: [remote, badName, SERVERS[0]] });
  assert.deepEqual(planned.conflicts, [
    'Pi MCP: server \'remote\' is not a stdio server; DoFlow writes only stdio entries for Pi',
    'Pi MCP: server id \'bad name\' is not a valid Pi server name',
  ]);
  assert.deepEqual(mcpChanges(planned).map((change) => change.identity), [SERVERS[0].id]);
});
