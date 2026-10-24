'use strict';

// Feature 122 B.2 (IC-008, IC-009, PN-1): the person grant reader, the DoFlow-written state file and the
// doctor listing. Every test uses a scratch HOME and XDG_CONFIG_HOME; DoFlow never writes grants.jsonl, so
// the tests stand in for the person by appending the lines themselves. The system temp dir is an injected seam
// (`tmpDir`) because a scratch directory made with mkdtemp lies under the real one, where IC-008 ignores grants.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { tempDir } = require('../helper/tmp');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { readGrants } = require('../../src/runtime/packages/grants.ts');
const state = require('../../src/runtime/packages/state.ts');
const { buildHealthReport, handleDoctorCommand } = require('../../src/runtime/health.ts');

const NO_TMP = path.join(path.parse(__dirname).root, 'doflow-no-such-system-tmp');
const D1 = 'a'.repeat(64);
const D2 = 'b'.repeat(64);
const AT = '2026-10-24T09:12:03Z';
const trust = (extra = {}) => ({ grant: 'trust', package: 'acme', version: '1.2.0', contentDigest: D1, capabilityDigest: D2, policy: 1, at: AT, ...extra });
const exempt = (extra = {}) => ({ grant: 'exempt', package: 'acme', version: '1.2.0', contentDigest: D1, host: '2.1.0', acceptRisk: true, at: AT, ...extra });
const fetchGrant = (extra = {}) => ({ grant: 'fetch', source: { type: 'git', url: 'https://example.org/acme.git', ref: 'v1.2.0' }, at: AT, ...extra });
const text = (...lines) => `${lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n')}\n`;

/** A scratch world: config home, home, project root, all siblings. The grants file is written by the test as the person. */
function world(t, content) {
  const root = tempDir(t, 'doflow-b2-');
  const w = { root, cfg: path.join(root, 'cfg'), home: path.join(root, 'home'), project: path.join(root, 'project') };
  for (const d of [w.cfg, w.home, w.project]) fs.mkdirSync(d, { recursive: true });
  w.env = { HOME: w.home, XDG_CONFIG_HOME: w.cfg };
  w.file = path.join(w.cfg, 'doflow', 'packages', 'grants.jsonl');
  if (content !== undefined) { fs.mkdirSync(path.dirname(w.file), { recursive: true }); fs.writeFileSync(w.file, content); }
  w.read = (extra = {}) => readGrants({ env: w.env, projectRoot: w.project, tmpDir: NO_TMP, ...extra });
  return w;
}

test('a valid trust line parses, with comments, blank lines, exempt, fetch and PN-1 rebind', (t) => {
  const w = world(t, text('# annotated by the person', '', trust({ rebind: ['acme.worker'] }), exempt({ package: 'beta' }), fetchGrant()));
  const read = w.read();
  assert.deepEqual(read.findings, []);
  assert.equal(read.path, w.file);
  assert.equal(read.exists, true);
  assert.equal(read.mtime, new Date(fs.statSync(w.file).mtimeMs).toISOString());
  assert.deepEqual(read.grants.map((g) => [g.line, g.grant, g.state]), [[3, 'trust', 'valid'], [4, 'exempt', 'valid'], [5, 'fetch', 'valid']]);
  const [first] = read.grants;
  assert.equal(first.package, 'acme');
  assert.equal(first.contentDigest, D1);
  assert.deepEqual(first.rebind, ['acme.worker']);
});

test('negative control: no grants file, or no config home, means no grants and no finding', (t) => {
  const w = world(t);
  const none = w.read();
  assert.deepEqual([none.exists, none.mtime, none.grants, none.entries, none.findings, none.noConfigHome], [false, null, [], [], [], false]);
  assert.ok(none.path.endsWith(path.join('packages', 'grants.jsonl')));
  const noHome = readGrants({ env: {}, projectRoot: w.project, tmpDir: NO_TMP });
  assert.deepEqual([noHome.path, noHome.noConfigHome, noHome.grants, noHome.findings], [null, true, [], []]);
});

test('an unknown key, unknown kind, duplicate, malformed or oversized line voids the whole file, naming the line number only', (t) => {
  const SECRET = 'leaky-marker-xyz';
  const long = trust({ package: 'zeta', version: '9.9.9' });
  const cases = {
    'unknown key': text(trust(), { ...exempt({ package: 'beta' }), [SECRET]: 1 }),
    'unknown kind': text(trust(), { grant: SECRET, package: 'beta' }),
    'duplicate (grant, package, version)': text(trust(), trust({ contentDigest: D2 })),
    'duplicate key on a line': text(trust(), `{"grant":"fetch","grant":"trust","note":"${SECRET}"}`),
    'not JSON': text(trust(), `{ ${SECRET}`),
    'bad digest': text(trust(), trust({ package: 'beta', contentDigest: SECRET })),
    'acceptRisk not true': text(trust(), exempt({ package: 'beta', acceptRisk: false })),
    '3 KiB line': text(trust(), `# ${SECRET.repeat(Math.ceil(3 * 1024 / SECRET.length))}`),
    'more than 1000 lines': `${'# c\n'.repeat(1000)}${JSON.stringify(long)}\n`,
  };
  for (const [name, content] of Object.entries(cases)) {
    const w = world(t, content);
    const read = w.read();
    assert.deepEqual(read.grants, [], name);
    assert.deepEqual(read.entries.filter((e) => e.state !== 'void'), [], `${name}: every parsed line is void`);
    assert.equal(read.findings.length, 1, name);
    const [finding] = read.findings;
    assert.equal(finding.code, 'state-unreadable', name);
    assert.equal(finding.severity, 'error', name);
    assert.match(finding.message, /line \d+/, name);
    assert.equal(JSON.stringify(finding).includes(SECRET), false, `${name}: the finding never quotes the line`);
  }
  const w = world(t, text(trust(), trust({ package: 'beta', unknownKey: 1 })));
  assert.match(w.read().findings[0].message, /line 2 /, 'the finding names the offending line');
  // a 2 KiB line and exactly 1000 lines are inside the caps; 2049 bytes is one over
  const comment = (bytes) => `# ${'x'.repeat(bytes - 2)}`;
  assert.equal(world(t, text(trust(), comment(2048))).read().grants.length, 1);
  assert.equal(world(t, text(trust(), comment(2049))).read().grants.length, 0);
  assert.equal(world(t, `${'# c\n'.repeat(999)}${JSON.stringify(trust())}\n`).read().grants.length, 1);
});

test('an unreadable grants file (a directory in its place) voids with state-unreadable', (t) => {
  const w = world(t);
  fs.mkdirSync(w.file, { recursive: true });
  const read = w.read();
  assert.deepEqual(read.grants, []);
  assert.equal(read.findings[0].code, 'state-unreadable');
});

test('XDG_CONFIG_HOME inside the project, a dispatch worktree or the system temp dir is ignored with grants-file-location', (t) => {
  const project = tempDir(t, 'doflow-b2-project-');
  const inProject = path.join(project, 'x');
  const wt = tempDir(t, 'doflow-b2-wt-');
  const inWorktree = path.join(wt, '.doflow', 'state', 'dispatch-worktrees', 'run1', 'x');
  const line = text(trust());
  const put = (cfg) => { const file = path.join(cfg, 'doflow', 'packages', 'grants.jsonl'); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, line); };
  for (const [name, cfg, tmpDir] of [['project root', inProject, NO_TMP], ['dispatch worktree', inWorktree, NO_TMP], ['system temp dir', path.join(tempDir(t, 'doflow-b2-tmp-'), 'x'), undefined]]) {
    put(cfg);
    const read = readGrants({ env: { HOME: '/nonexistent-home', XDG_CONFIG_HOME: cfg }, projectRoot: project, tmpDir });
    assert.deepEqual(read.grants, [], name);
    assert.deepEqual(read.entries.map((e) => [e.state, e.reason]), [['ignored', 'grants-file-location']], name);
    assert.equal(read.findings.length, 1, name);
    assert.equal(read.findings[0].code, 'grant-invalid', name);
    assert.equal(read.findings[0].reason, 'grants-file-location', name);
  }
  // a symlink out of the project into a project-owned target is judged on its realpath
  const outside = world(t);
  const target = path.join(project, 'real.jsonl');
  fs.writeFileSync(target, line);
  fs.mkdirSync(path.dirname(outside.file), { recursive: true });
  fs.symlinkSync(target, outside.file);
  const linked = outside.read({ projectRoot: project });
  assert.equal(linked.findings[0]?.reason, 'grants-file-location');
  // the same file outside all three is valid
  assert.equal(world(t, line).read().grants.length, 1);
});

test('state: a missing file is empty, writes are atomic 0600, and the audit keeps the latest 64', (t) => {
  const home = tempDir(t, 'doflow-b2-home-');
  const o = { homeDir: home };
  const empty = state.readState(o);
  assert.deepEqual([empty.exists, empty.unreadable, empty.findings], [false, false, []]);
  assert.deepEqual(empty.state, { state: 1, revoked: [], suspended: [], audit: [], removed: [] });
  assert.equal(state.statePath(home), path.join(home, '.doflow', 'packages', 'state.json'));

  state.recordRevocation(o, { packageId: 'acme', contentDigest: D1, at: '2026-10-24T10:00:00Z' });
  state.recordSuspension(o, { packageId: 'acme', reason: 'content-changed', projected: true, since: '2026-10-24T10:01:00Z' });
  state.recordSuspension(o, { packageId: 'acme', reason: 'collision-builtin', projected: false, since: '2026-10-24T10:02:00Z' });
  state.recordTombstone(o, { packageId: 'acme', qualifiedIds: ['acme.worker'], at: '2026-10-24T10:03:00Z' });
  for (let i = 0; i < 70; i++) state.appendAudit(o, { verb: 'enable', packageId: 'acme', result: `ok-${i}`, at: '2026-10-24T10:04:00Z' });
  const read = state.readState(o);
  assert.equal(read.unreadable, false);
  assert.deepEqual(read.state.revoked, [{ package: 'acme', contentDigest: D1, at: '2026-10-24T10:00:00Z' }]);
  assert.deepEqual(read.state.suspended, [{ package: 'acme', reason: 'collision-builtin', since: '2026-10-24T10:02:00Z', projected: false }]);
  assert.deepEqual(read.state.removed, [{ package: 'acme', qualifiedIds: ['acme.worker'], at: '2026-10-24T10:03:00Z' }]);
  assert.equal(read.state.audit.length, 64);
  assert.equal(read.state.audit[63].result, 'ok-69');
  assert.equal(read.state.audit[0].result, 'ok-6');
  state.clearSuspension(o, { packageId: 'acme' });
  assert.deepEqual(state.readState(o).state.suspended, []);
  assert.equal(fs.statSync(read.path).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(read.path)), ['state.json'], 'no temp file is left behind');
});

test('state: a malformed file counts as every package revoked and refuses an incremental write', (t) => {
  const home = tempDir(t, 'doflow-b2-home-');
  const o = { homeDir: home };
  fs.mkdirSync(path.dirname(state.statePath(home)), { recursive: true });
  for (const bad of ['{ nope', '[]', JSON.stringify({ state: 2 }), JSON.stringify({ state: 1, extra: [] }), JSON.stringify({ state: 1, revoked: [{ package: 'acme' }] })]) {
    fs.writeFileSync(state.statePath(home), bad);
    const read = state.readState(o);
    assert.equal(read.unreadable, true, bad);
    assert.equal(read.findings[0].code, 'state-unreadable', bad);
    assert.equal(state.grantRevoked(read, trust()), true, bad);
    assert.throws(() => state.appendAudit(o, { verb: 'enable', packageId: 'acme', result: 'ok' }), /unreadable/);
  }
});

test('state: a revocation covers a trust grant only when the grant is not later, and only for the same digest', () => {
  const read = { unreadable: false, state: { revoked: [{ package: 'acme', contentDigest: D1, at: '2026-10-24T10:00:00Z' }] } };
  assert.equal(state.grantRevoked(read, trust({ at: '2026-10-24T09:59:59Z' })), true);
  assert.equal(state.grantRevoked(read, trust({ at: '2026-10-24T10:00:00Z' })), true);
  assert.equal(state.grantRevoked(read, trust({ at: '2026-10-24T10:00:01Z' })), false);
  assert.equal(state.grantRevoked(read, trust({ contentDigest: D2, at: AT })), false);
  assert.equal(state.grantRevoked(read, trust({ package: 'beta' })), false);
});

test('state repair writes one revocation per grant line present and never widens', (t) => {
  const w = world(t, text(trust(), trust({ package: 'beta', contentDigest: D2 }), exempt({ package: 'gamma' }), fetchGrant()));
  fs.mkdirSync(path.dirname(state.statePath(w.home)), { recursive: true });
  fs.writeFileSync(state.statePath(w.home), '{ broken');
  const o = { homeDir: w.home };
  const repairAt = '2026-10-25T00:00:00Z';
  const written = state.repairState(o, { grantEntries: w.read().entries, at: repairAt });
  assert.deepEqual(written.revoked.map((r) => [r.package, r.contentDigest, r.at]), [['acme', D1, repairAt], ['beta', D2, repairAt], ['gamma', D1, repairAt]]);
  const read = state.readState(o);
  assert.equal(read.unreadable, false);
  assert.equal(fs.statSync(read.path).mode & 0o777, 0o600);
  assert.equal(read.state.audit.length, 1);
  // every grant read before the repair stays void; a line printed after it counts
  for (const entry of w.read().grants.filter((g) => g.grant !== 'fetch')) assert.equal(state.grantRevoked(read, entry), true, `line ${entry.line}`);
  assert.equal(state.grantRevoked(read, trust({ at: '2026-10-25T00:00:01Z' })), false);
  // repair with no grants file at all writes an empty revoked list
  assert.deepEqual(state.repairState({ homeDir: tempDir(t, 'doflow-b2-home-') }, { at: repairAt }).revoked, []);
});

test('doctor lists every grant with its state, the file path and its mtime', async (t) => {
  const w = world(t, text(trust(), exempt({ package: 'beta' }), fetchGrant()));
  state.recordRevocation({ homeDir: w.home }, { packageId: 'acme', contentDigest: D1, at: '2026-10-25T00:00:00Z' });
  const stub = () => { const error = new Error('not found'); error.code = 'ENOENT'; throw error; };
  const options = { repoRoot: REPO_ROOT, projectRoot: w.project, execFileImpl: stub, env: w.env, homeDir: w.home, tmpDir: NO_TMP };
  const report = buildHealthReport(options);
  assert.equal(report.packages.grants.path, path.join(w.cfg, 'doflow', 'packages', 'grants.jsonl'));
  assert.equal(report.packages.grants.mtime, new Date(fs.statSync(w.file).mtimeMs).toISOString());
  assert.deepEqual(report.packages.grants.rows.map((r) => [r.line, r.grant, r.target, r.state]), [
    [1, 'trust', 'acme@1.2.0', 'revoked'], [2, 'exempt', 'beta@1.2.0', 'valid'], [3, 'fetch', 'https://example.org/acme.git', 'valid'],
  ]);
  assert.deepEqual([report.packages.state.revoked, report.packages.state.unreadable], [1, false]);
  assert.equal(report.findings.some((f) => /grant|package/.test(f.kind)), false, 'grants never become blocking findings');

  const lines = [];
  const log = console.log;
  const code = process.exitCode;
  console.log = (...args) => lines.push(args.join(' '));
  try { await handleDoctorCommand(options); } finally { console.log = log; process.exitCode = code; }
  const out = lines.join('\n');
  assert.ok(out.includes('[Packages]'), out);
  assert.ok(out.includes(report.packages.grants.path), 'prints the path');
  assert.ok(out.includes(report.packages.grants.mtime), 'prints the mtime');
  assert.match(out, /line 1\s+trust\s+acme@1\.2\.0\s+revoked/);
  assert.match(out, /line 2\s+exempt\s+beta@1\.2\.0\s+valid/);

  // a world with no grants file and no state prints no [Packages] section
  const quiet = world(t);
  const quietLines = [];
  console.log = (...args) => quietLines.push(args.join(' '));
  try { await handleDoctorCommand({ ...options, projectRoot: quiet.project, env: quiet.env, homeDir: quiet.home }); } finally { console.log = log; process.exitCode = code; }
  assert.equal(quietLines.join('\n').includes('[Packages]'), false);
});

// DoFlow never writes grants.jsonl (IC-008). A src file that names it (the file name, or the exported path
// constant) and calls a write API is an offender. The detector is proven on synthetic sources first.
const WRITE_API = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|atomicJsonWrite|renameSync|rename|createWriteStream|copyFileSync|truncateSync|unlinkSync|rmSync)\s*\(|\bopenSync\([^)]*['"][wa]\+?['"]/;
const NAMES_GRANTS = /grants\.jsonl|\bGRANTS_FILE\b/;
const writersOf = (sources) => Object.entries(sources).filter(([, source]) => NAMES_GRANTS.test(source) && WRITE_API.test(source)).map(([file]) => file);

function srcFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return srcFiles(full);
    return /\.(?:ts|js|mjs|cjs)$/.test(entry.name) ? [full] : [];
  });
}

test('grep guard: the detector flags every write API on a file that names grants.jsonl', () => {
  const named = "const f = path.join(dir, 'packages', 'grants.jsonl');\n";
  for (const call of ['fs.writeFileSync(f, x)', 'fs.appendFileSync(f, x)', 'atomicJsonWrite(f, x)', 'fs.renameSync(a, f)', "fs.openSync(f, 'w')", "fs.openSync(f, 'a')", 'fs.promises.writeFile(f, x)']) {
    assert.deepEqual(writersOf({ bad: named + call }), ['bad'], call);
  }
  assert.deepEqual(writersOf({ viaConstant: 'const { GRANTS_FILE } = grants;\nfs.writeFileSync(GRANTS_FILE, x)' }), ['viaConstant']);
  assert.deepEqual(writersOf({ reader: `${named}fs.readFileSync(f, 'utf8'); fs.openSync(f, 'r');` }), []);
  assert.deepEqual(writersOf({ other: 'fs.writeFileSync(other, x)' }), []);
});

test('no src file that names grants.jsonl writes, renames or deletes', () => {
  const sources = Object.fromEntries(srcFiles(path.join(REPO_ROOT, 'src')).map((file) => [path.relative(REPO_ROOT, file), fs.readFileSync(file, 'utf8')]));
  assert.ok(sources['src/runtime/packages/grants.ts'], 'the reader is scanned');
  assert.deepEqual(writersOf(sources), []);
});
