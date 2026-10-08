'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { configPath, fingerprint, planCodexConfig, applyCodexConfig, reconcileCodexConfig } = require('../../../src/adapters/codex/config');

function scratch() { return fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-codex-config-')); }
function resource(value = true) { return { target: 'codex', scope: 'project', kind: 'configuration-entry', identity: 'features.hooks', value, sourceVersion: '2.4.4' }; }

test('creates a valid project config and records only the owned entry', () => {
  const projectRoot = scratch();
  const result = reconcileCodexConfig({ scope: 'project', projectRoot, desiredResources: [resource()] });
  assert.equal(result.applied, true);
  const file = configPath({ scope: 'project', projectRoot });
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\nhooks = true\n');
  assert.equal(result.managedResources[0].fingerprint, fingerprint(true));
});

test('merges without altering unknown TOML content', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  const before = '# personal\nmodel = "gpt-5"\n\n[providers.work]\nendpoint = "https://example.test"\n';
  fs.writeFileSync(file, before);
  reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  const after = fs.readFileSync(file, 'utf8');
  assert.match(after, /# personal\nmodel = "gpt-5"/);
  assert.match(after, /\[providers\.work\]\nendpoint = "https:\/\/example\.test"/);
  assert.match(after, /\[features\]\nhooks = true/);
});

test('deselect removes only a proven-owned key and leaves its table and neighbours intact', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\nhooks = true\nother = "keep"\n');
  const result = reconcileCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [] });
  assert.equal(result.applied, true);
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\n\nother = "keep"\n');
});

test('removing the only key of a table DoFlow appended restores the user file byte for byte', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  const before = '[profile]\nmodel = "mine"\n';
  fs.writeFileSync(file, before);
  const installed = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  assert.equal(fs.readFileSync(file, 'utf8'), `${before}\n[features]\nhooks = true\n`);
  reconcileCodexConfig({ file, scope: 'project', managedResources: installed.managedResources, desiredResources: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('removing the last owned key of a file DoFlow created deletes the file', () => {
  const projectRoot = scratch();
  const installed = reconcileCodexConfig({ scope: 'project', projectRoot, desiredResources: [resource()] });
  const result = reconcileCodexConfig({ scope: 'project', projectRoot, managedResources: installed.managedResources, desiredResources: [] });
  assert.equal(result.applied, true);
  assert.equal(fs.existsSync(configPath({ scope: 'project', projectRoot })), false);
});

test('an emptied table that still holds a user comment keeps its header', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\n# mine\nhooks = true\n');
  reconcileCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\n# mine\n\n');
});

test('an emptied table whose header carries a user comment keeps that header line', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[profile]\nmodel = "mine"\n\n[features] # note\nhooks = true\n');
  reconcileCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [] });
  assert.equal(fs.readFileSync(file, 'utf8'), '[profile]\nmodel = "mine"\n\n[features] # note\n\n');
});

test('a table that loses its last owned key but receives a new one keeps its header', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\nold = true\n');
  const owned = [{ target: 'codex', scope: 'project', kind: 'configuration-entry', identity: 'features.old', value: true, fingerprint: fingerprint(true) }];
  reconcileCodexConfig({ file, scope: 'project', managedResources: owned, desiredResources: [resource()] });
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\n\nhooks = true\n');
});

test('a config with a multi-line array is refused untouched by a removal', () => {
  // The scanner has no multi-line arrays and fails closed first, so no test can tell header records
  // from a line-based header scan; this pins only the refusal.
  const root = scratch(); const file = path.join(root, 'config.toml');
  const before = '[features]\nhooks = true\nlist = [\n  [1]]\n';
  fs.writeFileSync(file, before);
  const plan = planCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [] });
  assert.equal(plan.ok, false);
  assert.equal(applyCodexConfig(plan).applied, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('refuses a foreign resource with byte-for-byte preservation', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features]\nhooks = false\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  assert.equal(result.status, 'conflict'); assert.equal(result.applied, false);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('refuses malformed TOML without touching bytes', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features\nhooks = true\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  assert.equal(result.status, 'malformed'); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('refuses a user-modified owned entry', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features]\nhooks = false\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [resource()] });
  assert.equal(result.status, 'conflict'); assert.match(result.conflicts[0], /modified/); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('requires a recorded fingerprint before changing an existing owned identity', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features]\nhooks = true\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', managedResources: [resource()], desiredResources: [resource(false)] });
  assert.equal(result.status, 'conflict'); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('updates an owned value while preserving its user comment', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\n  hooks = true # local note\n');
  reconcileCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [resource(false)] });
  assert.match(fs.readFileSync(file, 'utf8'), /  hooks = false # local note/);
});

test('dry-run reports a change but never creates the file', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()], dryRun: true });
  assert.equal(result.status, 'change'); assert.equal(result.applied, false); assert.equal(fs.existsSync(file), false);
});

test('an atomic-write failure leaves the original file unchanged and cleans its temporary file', () => {
  const root = scratch(); const file = path.join(root, 'config.toml'); const before = '[features]\nhooks = true\n';
  fs.writeFileSync(file, before);
  const plan = planCodexConfig({ file, scope: 'project', managedResources: [{ ...resource(), fingerprint: fingerprint(true) }], desiredResources: [resource(false)] });
  const fsImpl = { ...fs, renameSync() { throw new Error('simulated rename failure'); } };
  assert.throws(() => applyCodexConfig(plan, { fsImpl }), /simulated/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(fs.readdirSync(root).filter((name) => name.endsWith('.tmp')).length, 0);
});

// --- file mode ----------------------------------------------------------------
const NO_MODE = process.platform === 'win32' && 'Windows has no POSIX mode bits';

test('a private config.toml keeps mode 0600 when DoFlow adds an entry', { skip: NO_MODE }, () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[profile]\nmodel = "m"\n');
  fs.chmodSync(file, 0o600);
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  assert.equal(result.applied, true);
  assert.match(fs.readFileSync(file, 'utf8'), /\[features\]\nhooks = true\n/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('a config.toml DoFlow creates gets the process default mode', { skip: NO_MODE }, () => {
  const projectRoot = scratch();
  reconcileCodexConfig({ scope: 'project', projectRoot, desiredResources: [resource()] });
  const file = configPath({ scope: 'project', projectRoot });
  const reference = path.join(path.dirname(file), 'reference');
  fs.writeFileSync(reference, '');
  assert.equal(fs.statSync(file).mode & 0o777, fs.statSync(reference).mode & 0o777);
});

// --- quoted TOML keys -------------------------------------------------------
// Quoted keys are ordinary TOML. The scanner previously matched bare keys only and threw on the
// whole file, so a single `[mcp_servers."my-server"]` made the entire config unreadable and
// blocked every Codex operation.
const { parseToml } = require('../../../src/helper/toml');

test('parses quoted table headers and quoted assignment keys', () => {
  for (const toml of [
    '[mcp_servers."my-server"]\ncommand = "uv"\n',
    "[mcp_servers.'my-server']\ncommand = 'uv'\n",
    '[plugins."scope@name"]\nx = 1\n',
    '[tui.nux]\n"gpt-5.5" = 4\n',        // a dot INSIDE a quoted key is legal
  ]) {
    assert.doesNotThrow(() => parseToml(toml), `must parse: ${toml.split('\n')[0]}`);
  }
});

test('still fails closed on genuinely unsupported table syntax', () => {
  for (const toml of ['[[a.b]]\nx = 1\n', '[a."b]\nx = 1\n', '[a.]\nx = 1\n', '[]\nx = 1\n']) {
    assert.throws(() => parseToml(toml), `must reject: ${toml.split('\n')[0]}`);
  }
});

test('a dot inside a quoted key cannot collide with a real path separator', () => {
  const entries = parseToml('[t]\n"a.b" = 1\n[t.a]\nb = 2\n').entries;
  assert.equal(entries.size, 2, 'the two distinct keys must not collapse into one');
  assert.notDeepEqual([...entries.keys()][0], [...entries.keys()][1]);
});

// --- new-key placement ------------------------------------------------------
// Regression: a new key whose table already existed was pushed at end-of-file, so it silently
// joined whichever table happened to trail the file. `features.hooks` written after an
// `[mcp_servers.x]` block became `mcp_servers.x.hooks` — the managed entry looked applied but
// landed under the wrong table entirely.
test('a new key is inserted into its own table, not appended after a trailing table', () => {
  const file = path.join(scratch(), 'config.toml');
  fs.writeFileSync(file, '[features]\nskills = true\n\n[mcp_servers.playwright]\ncommand = "npx"\n');
  const plan = planCodexConfig({ file, scope: 'user', managedResources: [], desiredResources: [{ identity: 'features.hooks', value: true }] });
  applyCodexConfig(plan);

  const entries = parseToml(fs.readFileSync(file, 'utf8')).entries;
  assert.equal(entries.get('features.hooks')?.value, true, 'must land in [features]');
  assert.equal(entries.get('mcp_servers.playwright.hooks'), undefined, 'must not leak into the trailing table');
});

test('several new keys for one absent table share a single header', () => {
  const file = path.join(scratch(), 'config.toml');
  fs.writeFileSync(file, '[other]\nz = 1\n');
  const plan = planCodexConfig({ file, scope: 'user', managedResources: [], desiredResources: [
    { identity: 'features.hooks', value: true }, { identity: 'features.skills', value: true }] });
  applyCodexConfig(plan);

  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split('[features]').length - 1, 1, 'exactly one [features] header');
  const entries = parseToml(text).entries;
  assert.equal(entries.get('features.hooks')?.value, true);
  assert.equal(entries.get('features.skills')?.value, true);
});

test('parseToml records each table header line, which is where table removal takes its spans from', () => {
  const { headers } = parseToml('top = 1\n[features] # note\nhooks = true\n\n[mcp_servers."a.b"]\ncommand = "x"\n');
  assert.deepEqual(headers, [{ line: 1, table: 'features' }, { line: 4, table: 'mcp_servers.a\\.b' }]);
});

// --- placement in the user's own table, and removal back to the exact bytes ------
const MARKED = 'hooks = true # DoFlow added this to your [features] table';

function installThenRemove(before) {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, before);
  const installed = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  const afterInstall = fs.readFileSync(file, 'utf8');
  reconcileCodexConfig({ file, scope: 'project', managedResources: installed.managedResources, desiredResources: [] });
  return { installed, afterInstall, afterRemove: fs.readFileSync(file, 'utf8') };
}

test('an empty [features] header receives a marked entry, and removal restores the header alone', () => {
  const { afterInstall, afterRemove } = installThenRemove('[features]\n');
  assert.equal(afterInstall, `[features]\n${MARKED}\n`);
  assert.equal(afterRemove, '[features]\n');
});

test('the marked entry goes right after the header, above a user comment, and removal restores the input', () => {
  const before = '[features]\n# note\n';
  const { afterInstall, afterRemove } = installThenRemove(before);
  assert.equal(afterInstall, `[features]\n${MARKED}\n# note\n`);
  assert.equal(afterRemove, before);
});

test('a table defined by root dotted keys receives a dotted entry, and removal restores the input', () => {
  const before = 'features.x = 1\n';
  const { afterInstall, afterRemove } = installThenRemove(before);
  assert.equal(afterInstall, 'features.x = 1\nfeatures.hooks = true\n');
  assert.equal(afterRemove, before);
});

test('a dotted entry goes after the last root dotted line, before the next table', () => {
  const { afterInstall } = installThenRemove('features.x = 1\n\n[profile]\nmodel = "m"\n');
  assert.equal(afterInstall, 'features.x = 1\nfeatures.hooks = true\n\n[profile]\nmodel = "m"\n');
});

test('features set as a value is refused with nothing written', () => {
  for (const [before, line] of [['features = { x = 1 }\n', 1], ['features = true\n', 1]]) {
    const root = scratch(); const file = path.join(root, 'config.toml');
    fs.writeFileSync(file, before);
    const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
    assert.equal(result.status, 'conflict');
    assert.deepEqual(result.conflicts, [`${file}: 'features' is set as a value on line ${line}, so DoFlow cannot add 'features.hooks' to it. Write it as a [features] table and run the command again. Nothing was written.`]);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('an output that would break a TOML table rule is refused with nothing written', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  const before = '[features.hooks]\nx = 1\n';
  fs.writeFileSync(file, before);
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  assert.equal(result.status, 'conflict');
  assert.match(result.conflicts[0], /DoFlow cannot write 'features\.hooks' without making the file invalid TOML \(table-and-value 'features\.hooks' on line \d+\)\. Nothing was written\.$/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('a [features] table with a user entry still gets the entry after it, unmarked', () => {
  const { afterInstall } = installThenRemove('[features]\nmine = true\n');
  assert.equal(afterInstall, '[features]\nmine = true\nhooks = true\n');
});

test('an update keeps the marker on the line it changes', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\n');
  const installed = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  reconcileCodexConfig({ file, scope: 'project', managedResources: installed.managedResources, desiredResources: [resource(false)] });
  assert.equal(fs.readFileSync(file, 'utf8'), '[features]\nhooks = false # DoFlow added this to your [features] table\n');
});

test('an input that already opens [features] twice is not refused for it', () => {
  const root = scratch(); const file = path.join(root, 'config.toml');
  fs.writeFileSync(file, '[features]\nmine = 1\n\n[features]\nother = 2\n');
  const result = reconcileCodexConfig({ file, scope: 'project', desiredResources: [resource()] });
  assert.equal(result.ok, true);
  assert.equal(result.applied, true);
});
