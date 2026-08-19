'use strict';

// install-shapes.test.js — real installs into temp directories, driving the real bin/doflow.js and
// then executing the real projected locator and dispatcher. No mocks: the defects this file exists
// to catch are all "the pieces are individually correct and do not join up", which a mock cannot
// express.
//
// Three shapes matter and behave differently:
//   source checkout  — the dispatcher sits in this repo, beside its helpers and a package.json
//   project-local    — <project>/.doflow/, reached by walking up from the working directory
//   global           — $HOME/.doflow/, reached only after the walk-up finds nothing
// The global shape is the one that was broken: `doflow.sh` derived its root with
// `$SCRIPT_DIR/../../../..`, which from ~/.doflow/scripts/doflow/ resolves to /Users, and every
// Node-backed verb died with "Cannot find module '/Users/bin/doflow.js'". Symmetry between the
// shapes is therefore asserted, not assumed (plan RK7).
//
// Serves FR-001, FR-002, FR-003, NFR-001, NFR-002, NFR-005, NFR-007.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SOURCE_DISPATCHER = path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const ALL_HARNESSES = ['claude', 'codex', 'gemini', 'opencode', 'pi', 'copilot', 'kiro'];

function scratch(tag) { return fs.mkdtempSync(path.join(os.tmpdir(), `doflow-shape-${tag}-`)); }

/** Run the installer CLI. `home` is always a scratch directory so a global install can never touch
 *  the developer's real ~/.doflow. */
function cli(args, { home, cwd = REPO, env = {} } = {}) {
  return spawnSync('node', [CLI, ...args], {
    cwd, encoding: 'utf8', input: '\n',
    env: { ...process.env, HOME: home, ...env },
  });
}

/** Execute a locator or the dispatcher itself, exactly as a skill would. */
function runtime(exe, args, { home, cwd, env = {} } = {}) {
  return spawnSync(exe, args, {
    cwd, encoding: 'utf8',
    // A developer's own exported DOFLOW_CONFIG_DIR / DOFLOW_CLI would silently redirect the
    // resolution these tests exist to exercise, so they are cleared unless a case sets them.
    env: { ...process.env, DOFLOW_CONFIG_DIR: undefined, DOFLOW_CLI: undefined, HOME: home, ...env },
  });
}

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function ledgerOf(root) {
  return JSON.parse(fs.readFileSync(path.join(root, '.doflow', 'state', 'ledger.json'), 'utf8'));
}

// A PATH built by mirroring the real one minus the optional providers, rather than a hand-picked
// minimal PATH: stripping PATH down to a few entries removes coreutils too, so every bash helper
// fails with 127 and the run proves nothing about python3's absence specifically.
let sanitizedPath;
function pathWithout(names) {
  const deny = new RegExp(`^(${names.join('|')})$`);
  const dir = scratch('nopath');
  for (const entry of (process.env.PATH || '').split(path.delimiter)) {
    let files;
    try { files = fs.readdirSync(entry); } catch { continue; }
    for (const file of files) {
      if (deny.test(file)) continue;
      const link = path.join(dir, file);
      if (fs.existsSync(link)) continue;
      try { fs.symlinkSync(path.join(entry, file), link); } catch { /* unreadable entry */ }
    }
  }
  return dir;
}

// ------------------------------------------------------------------ FR-001: the three shapes

test('FR-001: the dispatcher answers from the source checkout', () => {
  const cwd = scratch('src');
  const r = runtime(SOURCE_DISPATCHER, ['paths', '--json'], { home: scratch('srch'), cwd });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).repo_root, fs.realpathSync(cwd));
});

test('FR-001/FR-002: harness locator -> dispatcher -> shell verb works in a project-local install', () => {
  const root = scratch('proj');
  const home = path.join(root, 'home');
  const installed = cli(['install', root, '-f', '--no-backup', '-t', ALL_HARNESSES.join(',')], { home });
  assert.equal(installed.status, 0, installed.stderr);

  // Every harness's own locator must reach the one dispatcher — this is the only asset that reaches
  // opencode, pi, copilot and kiro at all, so all seven are exercised rather than claude alone.
  for (const locator of walk(root).filter((f) => path.basename(f) === 'doflow-run' && !f.includes(`${path.sep}.doflow${path.sep}`))) {
    const r = runtime(locator, ['paths', '--json'], { home, cwd: root });
    assert.equal(r.status, 0, `${path.relative(root, locator)}: ${r.stderr}`);
    assert.equal(JSON.parse(r.stdout).repo_root, fs.realpathSync(root));
  }
});

test('FR-001: a global install answers from a working directory that has no project install', () => {
  const home = scratch('globalhome');
  const installed = cli(['install', '-g', '-f', '--no-backup', '-t', ALL_HARNESSES.join(',')], { home });
  assert.equal(installed.status, 0, installed.stderr);

  // Deliberately outside $HOME: inside it, the walk-up would find ~/.doflow at resolution step 2
  // and the global fallback (step 3) would never be exercised.
  const cwd = scratch('elsewhere');
  const locator = path.join(home, '.claude', 'bin', 'doflow-run');
  const r = runtime(locator, ['paths', '--json'], { home, cwd });
  assert.equal(r.status, 0, `global locator failed: ${r.stderr}`);
  assert.equal(JSON.parse(r.stdout).repo_root, fs.realpathSync(cwd));

  // The old `doflow.sh` computed its root as /Users here. State proves where the dispatcher decided
  // it lives: the run record must land under the global install, not under a truncated path.
  const runs = path.join(home, '.doflow', 'state', 'runs');
  const records = walk(runs);
  assert.ok(records.length > 0, `no run record under ${runs} — the dispatcher resolved a different root`);
  const record = JSON.parse(fs.readFileSync(records[0], 'utf8').trim().split('\n')[0]);
  assert.equal(record.verb, 'paths');
  assert.equal(record.exit_code, 0);
});

// ---------------------------------------------------------------- FR-003: the uniform contract

test('FR-003: exit codes and --json hold at the dispatcher boundary in an installed shape', () => {
  const home = scratch('contract');
  assert.equal(cli(['install', '-g', '-f', '--no-backup', '-t', 'claude'], { home }).status, 0);
  const cwd = scratch('contractcwd');
  const locator = path.join(home, '.claude', 'bin', 'doflow-run');

  const help = runtime(locator, ['--help'], { home, cwd });
  assert.equal(help.status, 0, help.stderr);

  const unknown = runtime(locator, ['not-a-verb', '--json'], { home, cwd });
  assert.equal(unknown.status, 2, 'an unknown verb is a resolution error, not a finding');
  assert.equal(JSON.parse(unknown.stderr).error, 'unknown-verb');

  // A Node-backed verb must WORK here. This block previously asserted the opposite — that such a
  // verb "is the one case that cannot be served" — and so encoded a defect as intended design:
  // after `npx @khoavu882/doflow install`, npx leaves no package, the install is not inside a
  // checkout, and nothing lands on PATH, so eleven verbs (readiness, evidence, claim, verify,
  // classify, workflow, scaffold, route, trace, capabilities, discover) answered `cli-not-found`
  // for every real user while every test passed. Tests run inside a checkout; users do not.
  // The `runtime.*` assets project bin/, src/ and core/registry/ into `.doflow/runtime/`, and this
  // is the assertion that keeps them projected.
  const noPath = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}` };
  const served = runtime(locator, ['capabilities', '--json'], { home, cwd, env: noPath });
  assert.equal(served.status, 0,
    `a Node-backed verb must be served by the projected runtime with no package on PATH: ${served.stderr}`);
  assert.ok(JSON.parse(served.stdout).capabilities, 'capabilities answered but returned no capability list');

  // The unservable case still has to answer in the caller's shape rather than emit a raw
  // "Cannot find module" from node. Provoked by removing the projected runtime, which is now the
  // only way to reach it — that is the point.
  const projected = path.join(home, '.doflow', 'runtime');
  assert.ok(fs.existsSync(projected), `install did not project the runtime to ${projected}`);
  fs.renameSync(projected, `${projected}.moved`);
  try {
    const noCli = runtime(locator, ['capabilities', '--json'], { home, cwd, env: noPath });
    assert.equal(noCli.status, 2);
    const reported = JSON.parse(noCli.stderr);
    assert.equal(reported.error, 'cli-not-found');
    assert.match(reported.message, /DOFLOW_CLI/);

    // ...and the documented escape hatch works, so the exit 2 above is a resolution result rather
    // than a broken verb.
    const withCli = runtime(locator, ['capabilities', '--json'], { home, cwd, env: { ...noPath, DOFLOW_CLI: CLI } });
    assert.equal(withCli.status, 0, withCli.stderr);
    assert.ok(JSON.parse(withCli.stdout));
  } finally {
    fs.renameSync(`${projected}.moved`, projected);
  }
});

// ------------------------------- 009-unlinked-checkout: resolution fallbacks & diagnostics
//
// Feature 009 (agent-docs/doflow/009-unlinked-checkout-cli-resolution). CH3 in that feature's
// plan.md names these five assertions exactly; the naming below is prefixed `009-unlinked-checkout`
// rather than reusing this file's own `FR-00x` numbers, which already belong to a different,
// unrelated feature's requirements. Every scenario here uses an *installed* locator whose own
// $SCRIPT_DIR sits outside any checkout (as FR-001's global-install test above does) — the source
// dispatcher would always resolve via its own $SCRIPT_DIR walk-up first and never exercise these
// fallbacks (design.md R4).

test('009-unlinked-checkout: assertion 1 — a partial local .doflow/ resolves a Node verb via the new $PWD walk-up', () => {
  const cwd = scratch('pwd-walkup');
  // A minimal but genuinely working checkout: the same bin/ + src/ + core/registry/ content the
  // `runtime.*` assets project (copied directly, not produced by an install) plus a package.json
  // naming doflow — together exactly what `is_package_root` requires.
  fs.cpSync(path.join(REPO, 'bin'), path.join(cwd, 'bin'), { recursive: true });
  fs.cpSync(path.join(REPO, 'src'), path.join(cwd, 'src'), { recursive: true });
  fs.mkdirSync(path.join(cwd, 'core', 'registry'), { recursive: true });
  fs.cpSync(path.join(REPO, 'core', 'registry'), path.join(cwd, 'core', 'registry'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ name: '@khoavu882/doflow' }));
  // A partial local `.doflow/`: only state/ and worktrees/ — no scripts/, no runtime/ — proves the
  // new $PWD walk-up resolves the checkout itself rather than depending on a runtime/ projection
  // existing at this same location.
  fs.mkdirSync(path.join(cwd, '.doflow', 'state'), { recursive: true });
  fs.mkdirSync(path.join(cwd, '.doflow', 'worktrees'), { recursive: true });

  const home = scratch('pwd-walkup-home');
  assert.equal(cli(['install', '-g', '-f', '--no-backup', '-t', 'claude'], { home }).status, 0);
  const locator = path.join(home, '.claude', 'bin', 'doflow-run');

  const noPath = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}` };
  const r = runtime(locator, ['capabilities', '--json'], { home, cwd, env: noPath });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).capabilities, 'capabilities answered but returned no capability list');
});

test('009-unlinked-checkout: assertion 2 — a partial local .doflow/ with no own checkout falls back to $HOME/.doflow/runtime', () => {
  const cwd = scratch('global-fallback-cwd');
  // No bin/doflow.js and no package.json anywhere in `cwd` — the $PWD walk-up cannot resolve — but
  // a `.doflow/state/` exists, so CONFIG_DIR resolves to `cwd/.doflow`, which is NOT the same path
  // as `$HOME/.doflow`. This is what forces resolution past the existing `$CONFIG_DIR/runtime`
  // check (which has nothing to find here) into the new `$HOME/.doflow/runtime` fallback.
  fs.mkdirSync(path.join(cwd, '.doflow', 'state'), { recursive: true });

  const home = scratch('global-fallback-home');
  assert.equal(cli(['install', '-g', '-f', '--no-backup', '-t', 'claude'], { home }).status, 0);
  const locator = path.join(home, '.claude', 'bin', 'doflow-run');

  const noPath = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}` };
  const r = runtime(locator, ['capabilities', '--json'], { home, cwd, env: noPath });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(JSON.parse(r.stdout).capabilities, 'capabilities answered but returned no capability list');

  // Proves CONFIG_DIR really did resolve to `cwd/.doflow` (not `home/.doflow`), i.e. that the run
  // above genuinely reached the new fallback rather than the pre-existing `$CONFIG_DIR/runtime`
  // check happening to already point at the same place.
  const runsUnderCwd = walk(path.join(cwd, '.doflow', 'state', 'runs'));
  assert.ok(runsUnderCwd.length > 0, 'the run record must land under cwd/.doflow, proving CONFIG_DIR resolved there');
});

test('009-unlinked-checkout: assertion 3 — a runtime/-sourced Node verb that hits the registry validator reports stale-runtime', () => {
  // `doctor` is the one Node-backed verb reachable through the dispatcher that calls the full,
  // validated `loadRegistry` (src/runtime/health.js) rather than reading one or two registry files
  // directly — so it is the one verb that can actually throw the registry loader's
  // `Invalid DoFlow registry:` error. The projected `runtime/` tree carries only bin/, src/ and
  // core/registry/ (not the full core/ tree assets.yaml's own entries point at), so running doctor
  // straight against it is a real, unmodified reproduction of "this registry is mismatched relative
  // to what validation expects" — nothing here is artificially corrupted.
  const cwd = scratch('stale-runtime-cwd');
  const home = scratch('stale-runtime-home');
  assert.equal(cli(['install', '-g', '-f', '--no-backup', '-t', 'claude'], { home }).status, 0);
  const locator = path.join(home, '.claude', 'bin', 'doflow-run');

  const noPath = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}` };
  const r = runtime(locator, ['doctor', '--json'], { home, cwd, env: noPath });
  assert.equal(r.status, 2, `expected a resolution-class failure, got stdout: ${r.stdout}`);
  const reported = JSON.parse(r.stderr);
  assert.equal(reported.error, 'stale-runtime');
  assert.match(reported.message, /runtime[\\/]bin[\\/]doflow\.js/, 'message must name the resolved runtime path');
  assert.doesNotMatch(reported.message, /^\[ERROR\]/, 'the raw CLI error text must be replaced, not merely echoed');
});

test('009-unlinked-checkout: assertion 4 — a bare bin/doflow.js with no package.json reports unlinked-checkout, naming npm link', () => {
  const cwd = scratch('unlinked-checkout-cwd');
  fs.mkdirSync(path.join(cwd, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(cwd, 'bin', 'doflow.js'), '// not a real package — no package.json anywhere near this file\n');

  // A global install first (for a working locator), then its projected runtime/ is removed — the
  // marker heuristic must be the ONLY thing that fires, not the `$HOME/.doflow/runtime` fallback.
  const home = scratch('unlinked-checkout-home');
  assert.equal(cli(['install', '-g', '-f', '--no-backup', '-t', 'claude'], { home }).status, 0);
  const locator = path.join(home, '.claude', 'bin', 'doflow-run');
  fs.rmSync(path.join(home, '.doflow', 'runtime'), { recursive: true, force: true });

  const noPath = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}` };
  const r = runtime(locator, ['capabilities', '--json'], { home, cwd, env: noPath });
  assert.equal(r.status, 2, `expected a resolution-class failure, got stdout: ${r.stdout}`);
  const reported = JSON.parse(r.stderr);
  assert.equal(reported.error, 'unlinked-checkout');
  assert.match(reported.message, /npm link/);
  assert.match(reported.message, /bin[\\/]doflow\.js/, 'message must name the detected marker path');
});

test('009-unlinked-checkout: assertion 5 — the generic cli-not-found diagnosis is unchanged when no marker and no runtime resolve', () => {
  // This is the exact case test/install-shapes.test.js's own `FR-003` block above already pins
  // (scratch cwd outside any checkout, projected runtime removed) — repeated here, independently,
  // under this feature's own name, specifically to confirm CH2's new marker check does not widen
  // `cli-not-found`'s firing conditions (design.md §4, FR-005). If this ever needs to change, that
  // `FR-003` assertion needs to change with it.
  const cwd = scratch('cli-not-found-cwd');
  const home = scratch('cli-not-found-home');
  assert.equal(cli(['install', '-g', '-f', '--no-backup', '-t', 'claude'], { home }).status, 0);
  const locator = path.join(home, '.claude', 'bin', 'doflow-run');
  fs.rmSync(path.join(home, '.doflow', 'runtime'), { recursive: true, force: true });

  const noPath = { PATH: `/usr/bin:/bin:${path.dirname(process.execPath)}` };
  const r = runtime(locator, ['capabilities', '--json'], { home, cwd, env: noPath });
  assert.equal(r.status, 2, `expected a resolution-class failure, got stdout: ${r.stdout}`);
  const reported = JSON.parse(r.stderr);
  assert.equal(reported.error, 'cli-not-found');
  assert.match(reported.message, /DOFLOW_CLI/);
});

// -------------------------------------------------------------------- NFR-007: remove reclaims

test('NFR-007: remove reclaims the locator on every harness and leaves user files untouched', () => {
  const root = scratch('reclaim');
  const home = path.join(root, 'home');
  const mine = path.join(root, 'notes.md');
  fs.writeFileSync(mine, '# mine\n');

  assert.equal(cli(['install', root, '-f', '--no-backup', '-t', ALL_HARNESSES.join(',')], { home }).status, 0);
  const projected = walk(root)
    .filter((f) => path.basename(f) === 'doflow-run' && !f.startsWith(path.join(root, 'home')));
  assert.ok(projected.length >= 2, 'the install must have projected locators to reclaim');
  const claimed = ledgerOf(root).resources.filter((r) => r.assetId === 'locator.doflow');
  assert.equal(claimed.length, ALL_HARNESSES.length, 'every harness must record ownership of its locator');

  const removed = cli(['remove', root, '-f', '-t', ALL_HARNESSES.join(',')], { home });
  assert.equal(removed.status, 0, removed.stderr);

  const leftover = walk(root)
    .filter((f) => path.basename(f) === 'doflow-run' && !f.startsWith(path.join(root, 'home')))
    .map((f) => path.relative(root, f));
  assert.deepEqual(leftover, [], `remove left runtime entrypoints behind: ${leftover.join(', ')}`);
  assert.deepEqual(ledgerOf(root).resources.filter((r) => r.assetId === 'locator.doflow'), [],
    'a reclaimed file that is still recorded as owned makes the next update believe it exists');
  assert.equal(fs.readFileSync(mine, 'utf8'), '# mine\n', 'remove must never touch user-owned content');
});

// ------------------------------------------------------- NFR-005: ownership survives the upgrade

test('NFR-005: an ownership ledger written before this feature updates without losing track', () => {
  const root = scratch('upgrade');
  const home = path.join(root, 'home');
  const targets = ALL_HARNESSES.join(',');
  assert.equal(cli(['install', root, '-f', '--no-backup', '-t', targets], { home }).status, 0);

  // Rewind the install to its pre-008 shape: the locator asset did not exist, so neither its files
  // nor its ownership records did. Everything else — 675-odd resources across seven harnesses — is
  // exactly what a real pre-feature install carries, which is why this rewinds a real ledger rather
  // than hand-building a fixture (test/state-ledger.test.js already covers hand-built legacy
  // imports; the risk here is the opposite one, a large real ledger being reset).
  const ledgerFile = path.join(root, '.doflow', 'state', 'ledger.json');
  const before = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
  const preFeature = before.resources.filter((r) => r.assetId !== 'locator.doflow');
  for (const r of before.resources) {
    if (r.assetId === 'locator.doflow') fs.rmSync(r.target, { force: true });
  }
  fs.writeFileSync(ledgerFile, JSON.stringify({ ...before, resources: preFeature }, null, 2));

  // A narrow update first, targeting one harness. This is the discriminating case: the other six
  // harnesses' ownership is carried forward by merge, not by re-verification, so a lifecycle that
  // rebuilt the ledger from the current run instead of merging into it would silently drop them —
  // and `remove` would then leave those six harnesses' files behind forever.
  const narrow = cli(['update', root, '-f', '--no-backup', '-t', 'claude'], { home });
  assert.equal(narrow.status, 0, narrow.stderr);

  const key = (r) => `${r.harness}|${r.assetId}|${r.target}`;
  const kept = new Set(ledgerOf(root).resources.map(key));
  const lost = preFeature.filter((r) => !kept.has(key(r))).map(key);
  assert.deepEqual(lost, [],
    `update dropped ownership of pre-existing resources — remove and rollback can no longer reclaim them:\n  ${lost.slice(0, 10).join('\n  ')}`);

  // Then the full upgrade: the new asset has to actually arrive and be recorded on all seven.
  const full = cli(['update', root, '-f', '--no-backup', '-t', targets], { home });
  assert.equal(full.status, 0, full.stderr);
  const after = ledgerOf(root);
  assert.equal(after.resources.filter((r) => r.assetId === 'locator.doflow').length, ALL_HARNESSES.length,
    'the upgrade must also add and record the new locator on every harness');
  const stillLost = preFeature.filter((r) => !new Set(after.resources.map(key)).has(key(r))).map(key);
  assert.deepEqual(stillLost, [], 'the full upgrade must not drop what the narrow one preserved');
});

// --------------------------------------------- NFR-001 / NFR-002: no python3, no optional tools

test('NFR-001/NFR-002: install and dispatch succeed with python3 and every optional provider absent', () => {
  sanitizedPath ??= pathWithout(['python', 'python3', 'python3\\.[0-9]+', 'semble', 'graphify', 'rtk', 'uv', 'uvx']);
  const env = { PATH: sanitizedPath };

  // Prove the sanitation actually bit; otherwise this test passes for the wrong reason on a machine
  // that never had the tools in the first place.
  for (const tool of ['python3', 'semble', 'graphify', 'rtk']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { env: { ...process.env, ...env }, encoding: 'utf8' });
    assert.notEqual(found.status, 0, `${tool} is still reachable — the sanitized PATH is not sanitizing`);
  }

  const root = scratch('nopy');
  const home = path.join(root, 'home');
  const installed = cli(['install', root, '-f', '--no-backup', '-t', ALL_HARNESSES.join(',')], { home, env });
  assert.equal(installed.status, 0, installed.stderr);

  const locator = path.join(root, '.claude', 'bin', 'doflow-run');
  for (const verb of ['paths', 'git-state']) {
    const r = runtime(locator, [verb, '--json'], { home, cwd: root, env });
    assert.equal(r.status, 0, `${verb} under a python-less PATH: ${r.stderr}`);
  }
  // A Node verb too: capability routing must degrade to what is present, not fail because a
  // preferred provider is missing (NFR-002).
  const routed = runtime(locator, ['capabilities', '--json'], { home, cwd: root, env: { ...env, DOFLOW_CLI: CLI } });
  assert.equal(routed.status, 0, routed.stderr);

  const doctor = cli(['doctor'], { home, env });
  assert.equal(doctor.status, 0, `doctor must report degraded capability, not exit non-zero:\n${doctor.stderr}`);
});
