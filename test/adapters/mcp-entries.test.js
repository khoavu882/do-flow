'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  entryFingerprint, readMcpFiles, planMcpEntries, applyMcpEntries, verifyMcpEntries, ownedMcpIds, writeMcpJson, writeMcpEntries,
} = require('../../src/adapters/mcp-entries');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-mcp-entries-')); }

const A = { id: 'alpha', entry: { command: 'npx', args: ['alpha'] } };
const B = { id: 'beta', entry: { command: 'npx', args: ['beta'] } };
const USER = { command: 'mine', env: { TOKEN: 'secret-value' } };
const CONTAINER = 'mcpServers';

const identityFor = (id) => `doflow:test:mcp-server:${id}`;
const row = (file, server, fingerprint = entryFingerprint(server.entry)) => (
  { identity: server.id, target: file, fingerprint, ownershipIdentity: identityFor(server.id), legacy: false });

/** One harness's MCP inputs over a real file. */
function setup(doc) {
  const root = scratch();
  const file = path.join(root, 'mcp.json');
  if (doc !== undefined) fs.writeFileSync(file, typeof doc === 'string' ? doc : `${JSON.stringify(doc, null, 2)}\n`);
  const base = { file, identityFor, assetId: 'asset.one', renderer: 'test-mcp', label: 'Test MCP', harness: 'test' };
  const files = (ownRows = []) => readMcpFiles({ file, ownRows, container: CONTAINER });
  const plan = (options = {}) => planMcpEntries({ ...base, files: files(options.ownRows), ...options });
  /** Plan, write, verify: the whole run for one harness. */
  const run = (options = {}) => {
    const snapshot = files(options.ownRows);
    const planned = planMcpEntries({ ...base, files: snapshot, ...options });
    const written = writeMcpEntries(planned.changes, { container: CONTAINER });
    const verified = verifyMcpEntries({ ...base, files: files(options.ownRows), snapshot, ...options });
    return { planned, written, verified };
  };
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { root, file, plan, run, read, files };
}

test('M1: creates into an absent file and container, and verify returns one row per server', () => {
  const { file, run, read } = setup();
  const { planned, verified } = run({ selected: [A, B] });
  assert.deepEqual(planned.changes.map((change) => [change.operation, change.identity, change.before, change.ownershipIdentity]),
    [['create', 'alpha', null, identityFor('alpha')], ['create', 'beta', null, identityFor('beta')]]);
  assert.deepEqual(read(), { mcpServers: { alpha: A.entry, beta: B.entry } });
  assert.deepEqual(verified.resources, [A, B].map((server) => ({
    assetId: 'asset.one', target: file, ownershipIdentity: identityFor(server.id), kind: 'mcp-server', identity: server.id,
    fingerprint: entryFingerprint(server.entry), sourceVersion: 'unknown', projection: { renderer: 'test-mcp' },
  })));
  assert.deepEqual(verified.statuses.map((status) => status.status), ['managed', 'managed']);
  assert.equal(verified.statuses[0].harness, 'test');
});

test('M2: a same-named user entry is left alone with the collision notice and reported not-managed', () => {
  const { file, run } = setup({ mcpServers: { alpha: USER } });
  const before = fs.readFileSync(file);
  const { planned, written, verified } = run({ selected: [A] });
  assert.deepEqual(planned.changes, []);
  assert.equal(written, 0);
  assert.deepEqual(planned.notices, ["MCP: kept your own entry 'alpha' in mcp.json and did not register DoFlow's; rename or remove yours to let DoFlow manage it."]);
  assert.deepEqual(verified.statuses.map((status) => status.status), ['not-managed']);
  assert.deepEqual(verified.resources, []);
  assert.deepEqual(fs.readFileSync(file), before);
});

test('M3: deselecting an owned entry removes it; deselecting an edited one releases it', () => {
  const edited = { ...B.entry, args: ['edited'] };
  const { file, run, read } = setup({ mcpServers: { alpha: A.entry, beta: edited, other: USER } });
  const ownRows = [row(file, A), row(file, B)];
  const { planned, verified } = run({ selected: [], ownRows });
  assert.deepEqual(planned.changes.map((change) => [change.identity, change.operation, change.release ?? false]),
    [['alpha', 'remove', false], ['beta', 'remove', true]]);
  assert.deepEqual(planned.notices, ["MCP: entry 'beta' in mcp.json was changed outside DoFlow; it is yours now and DoFlow no longer updates or removes it."]);
  assert.deepEqual(read(), { mcpServers: { beta: edited, other: USER } });
  assert.deepEqual(verified.statuses.map((status) => [status.identity, status.status]), [['alpha', 'absent'], ['beta', 'not-managed']]);
});

test('M4: a selected owned entry the user edited is released and left byte for byte', () => {
  const edited = { ...A.entry, env: { KEY: 'x' } };
  const { file, run } = setup({ mcpServers: { alpha: edited } });
  const before = fs.readFileSync(file);
  const { planned, verified } = run({ selected: [A], ownRows: [row(file, A)] });
  assert.deepEqual(planned.changes.map((change) => [change.identity, change.release]), [['alpha', true]]);
  assert.match(planned.notices[0], /^MCP: entry 'alpha' in mcp\.json was changed outside DoFlow/);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(verified.statuses.map((status) => status.status), ['not-managed']);
  assert.deepEqual(verified.resources, []);
});

test('M5: adoption takes an equal entry with no write, never an unequal one, and closes once a row exists', () => {
  const { file, run, plan } = setup({ mcpServers: { alpha: A.entry, beta: { command: 'other' } } });
  const before = fs.readFileSync(file);
  const { planned, verified } = run({ selected: [A, B], adoptable: [A, B] });
  assert.deepEqual(planned.changes, []);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(verified.resources.map((resource) => resource.identity), ['alpha']);
  assert.deepEqual(verified.statuses.map((status) => [status.identity, status.status]), [['alpha', 'managed'], ['beta', 'not-managed']]);

  const closed = plan({ selected: [A], adoptable: [A], ownRows: [row(file, B)] });
  assert.match(closed.notices.join('\n'), /kept your own entry 'alpha'/);
  assert.ok(!closed.changes.some((change) => change.identity === 'alpha'));
});

test('M6: an equal entry another harness\'s row claims is co-owned with no write', () => {
  const { file, run } = setup({ mcpServers: { alpha: A.entry } });
  const before = fs.readFileSync(file);
  const { planned, verified } = run({ selected: [A], ownRows: [], foreignRows: [{ harness: 'other', identity: 'alpha', target: file }] });
  assert.deepEqual(planned.changes, []);
  assert.deepEqual(planned.notices, []);
  assert.deepEqual(fs.readFileSync(file), before);
  assert.deepEqual(verified.resources.map((resource) => resource.identity), ['alpha']);
});

test('M7: removing deletes owned and equal adoptable entries, releases edited ones and an unparseable file', () => {
  const edited = { ...B.entry, args: ['edited'] };
  const owned = setup({ mcpServers: { alpha: A.entry, beta: edited, other: USER } });
  const removal = owned.run({ removing: true, ownRows: [row(owned.file, A), row(owned.file, B)] });
  assert.deepEqual(removal.planned.changes.map((change) => [change.identity, change.release ?? false]), [['alpha', false], ['beta', true]]);
  assert.deepEqual(owned.read(), { mcpServers: { beta: edited, other: USER } });
  assert.deepEqual(removal.verified.statuses.map((status) => [status.identity, status.status]), [['alpha', 'absent'], ['beta', 'not-managed']]);

  const adopted = setup({ mcpServers: { alpha: A.entry, beta: { command: 'other' } } });
  const adoption = adopted.run({ removing: true, adoptable: [A, B] });
  assert.deepEqual(adoption.planned.changes.map((change) => [change.identity, change.operation, change.ownershipIdentity]),
    [['alpha', 'remove', identityFor('alpha')]]);
  assert.deepEqual(adopted.read(), { mcpServers: { beta: { command: 'other' } } });
  assert.deepEqual(adoption.verified.statuses.map((status) => [status.identity, status.status]), [['alpha', 'absent']]);

  const broken = setup('{ not json');
  const release = broken.run({ removing: true, ownRows: [row(broken.file, A)] });
  assert.deepEqual(release.planned.changes.map((change) => [change.identity, change.release]), [['alpha', true]]);
  assert.deepEqual(release.planned.conflicts, []);
  assert.match(release.planned.notices[0], /^MCP: left .*mcp\.json untouched because it cannot be edited safely; DoFlow no longer manages the entries in it\.$/);
  assert.equal(release.written, 0);
  assert.equal(fs.readFileSync(broken.file, 'utf8'), '{ not json');
  assert.deepEqual(release.verified.statuses.map((status) => status.status), ['not-managed']);
});

test('M8: re-planning after apply gives no change', () => {
  const { file, run, plan } = setup({ mcpServers: { other: USER } });
  const { verified } = run({ selected: [A, B] });
  const ownRows = verified.resources.map((resource) => ({ ...resource, legacy: false }));
  assert.deepEqual(plan({ selected: [A, B], ownRows }), { changes: [], conflicts: [], notices: [] });
  assert.deepEqual(ownedMcpIds({ file, files: readMcpFiles({ file, ownRows, container: CONTAINER }), selected: [A, B], ownRows }), ['alpha', 'beta']);
});

test('M9: apply refuses a changed entry without naming its value, ignores other members, and accepts a settled end state', () => {
  const create = { target: '/x/mcp.json', operation: 'create', identity: 'alpha', before: null, entry: A.entry };
  assert.throws(() => applyMcpEntries({ alpha: USER }, [create]), (error) => {
    assert.equal(error.message, 'MCP: /x/mcp.json changed after planning; nothing was written, re-run the command');
    return true;
  });
  assert.deepEqual(applyMcpEntries({ other: USER }, [create]), { other: USER, alpha: A.entry });
  assert.deepEqual(applyMcpEntries({ alpha: A.entry }, [create]), { alpha: A.entry }, 'a create already in place passes');
  const remove = { target: '/x/mcp.json', operation: 'remove', identity: 'alpha', before: entryFingerprint(A.entry) };
  assert.deepEqual(applyMcpEntries({ other: USER }, [remove]), { other: USER }, 'a remove already done passes');
  assert.throws(() => applyMcpEntries({ alpha: USER }, [remove]), /changed after planning/);
  assert.deepEqual(applyMcpEntries({ alpha: USER }, [{ ...remove, release: true }]), { alpha: USER });
});

test('M10: no change carries file text, and a secret in a malformed file reaches no conflict or notice', () => {
  const broken = setup('{ "mcpServers": { "secret-value": ');
  const planned = broken.plan({ selected: [A] });
  assert.deepEqual(planned.conflicts, [`Test MCP: ${broken.file}: invalid JSON; DoFlow did not change the file`]);
  assert.ok(!JSON.stringify(planned).includes('secret-value'));

  const healthy = setup({ mcpServers: { other: USER } }).plan({ selected: [A] });
  assert.equal(healthy.changes.length, 1);
  assert.ok(!JSON.stringify(healthy.changes).includes('secret-value'), 'changes carry DoFlow\'s entry, never the file');

  for (const [text, reason] of [['[]', 'top-level value is not an object'], ['{"mcpServers": []}', 'server container is not an object']]) {
    assert.match(setup(text).plan({ selected: [A] }).conflicts[0], new RegExp(`: ${reason}; DoFlow did not change the file$`));
  }
});

test('M11: a null-fingerprint row is owned only while its value equals the rendering; retired ids are removed or released', () => {
  const { file, plan, files } = setup({ mcpServers: { alpha: A.entry, beta: { command: 'edited' }, gone: { command: 'old' }, legacy: { command: 'old' } } });
  const nullRow = (server) => ({ ...row(file, server), fingerprint: null });
  const ownRows = [nullRow(A), nullRow(B),
    { identity: 'gone', target: file, fingerprint: entryFingerprint({ command: 'old' }), ownershipIdentity: identityFor('gone'), legacy: false },
    { identity: 'legacy', target: file, fingerprint: null, ownershipIdentity: identityFor('legacy'), legacy: false }];
  assert.deepEqual(ownedMcpIds({ file, files: files(ownRows), adoptable: [A, B], ownRows }), ['alpha', 'gone']);

  const planned = plan({ selected: [A, B], adoptable: [A, B], ownRows });
  assert.deepEqual(planned.changes.map((change) => [change.identity, change.release ?? false]),
    [['beta', true], ['gone', false], ['legacy', true]]);
});

test('a legacy row consumed by a selection is released so the row verify records replaces it', () => {
  const { file, plan } = setup({ mcpServers: { alpha: A.entry } });
  const legacy = { ...row(file, A), ownershipIdentity: 'test:mcp:alpha', legacy: true };
  const planned = plan({ selected: [A], ownRows: [legacy] });
  assert.deepEqual(planned.changes.map((change) => [change.ownershipIdentity, change.release]), [['test:mcp:alpha', true]]);
});

test('writeMcpJson keeps the file mode and writes through a symlink without replacing it', { skip: process.platform === 'win32' }, () => {
  const root = scratch();
  const real = path.join(root, 'real.json');
  const link = path.join(root, 'link.json');
  fs.writeFileSync(real, '{}\n', { mode: 0o600 });
  fs.chmodSync(real, 0o600);
  fs.symlinkSync(real, link);
  writeMcpJson(link, { mcpServers: { alpha: A.entry } });
  assert.ok(fs.lstatSync(link).isSymbolicLink());
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(real, 'utf8')), { mcpServers: { alpha: A.entry } });
  assert.deepEqual(fs.readdirSync(root).sort(), ['link.json', 'real.json']);
});

test('writeMcpEntries keeps every other key and keeps or deletes an emptied container as asked', () => {
  const kept = setup({ other: 1, mcpServers: { alpha: A.entry } });
  const removal = [{ kind: 'mcp-server', target: kept.file, operation: 'remove', identity: 'alpha', before: entryFingerprint(A.entry) }];
  writeMcpEntries(removal, { container: CONTAINER, keepEmptyContainer: true });
  assert.deepEqual(kept.read(), { other: 1, mcpServers: {} });

  const deleted = setup({ other: 1, mcpServers: { alpha: A.entry } });
  writeMcpEntries(removal.map((change) => ({ ...change, target: deleted.file })), { container: CONTAINER });
  assert.deepEqual(deleted.read(), { other: 1 });
});
