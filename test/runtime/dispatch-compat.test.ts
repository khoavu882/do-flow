'use strict';

// Feature 082 D.5 (NFR-001, NFR-002, NFR-003, IC-022 static gate, IC-040 sandbox, DEC-052, DEC-056):
// compatibility, no-real-binary and zero-dependency obligations.
//
// - NFR-001: package.json declares no dependency key; every require/import in src/runtime/dispatch/*.ts
//   names a `node:` built-in or a relative path that resolves inside src/.
// - NFR-003: of the seven real harnesses only codex is `isolatedEdit` supported (109 IC-008) and
//   the other six keep it unknown (IC-013).
// - NFR-002 / DEC-052: `dispatch start` and `step` over the real registry, under `--mode auto`, in a
//   sandbox whose scratch bin/ also holds a logging wrapper named after every binary
//   core/registry/harnesses.json declares. The static gate refuses every harness from its declared
//   worker block, so no binary is looked up (a lookup that found a wrapper would run its
//   `versionArgv`) or started: the wrapper log stays empty, the step records mode `sequential`, and
//   the dispatch's selection names each harness's gap.
//
// Every child's PATH is the sandbox's scratch bin/ alone; dirname(process.execPath) is never on it
// (DEC-056). The five DOFLOW_* identity variables are set in every child env by the sandbox.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { makeDispatchSandbox } = require('../helper/dispatch-sandbox.ts');
const { IDENTITY_VARS } = require('../helper/fake-harness-cli.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { storeFileFor } = require('../../src/runtime/dispatch/store.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const SLUG = '082-dispatch-compat';
const SKIP = process.platform === 'win32' ? 'tree cleanup is unverified on win32 (NFR-005)' : false;
const HARNESSES = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'harnesses.json'), 'utf8')).harnesses;
const REAL_IDS = Object.freeze(['claude', 'codex', 'opencode', 'pi', 'copilot', 'kiro', 'antigravity']);

// ── NFR-001: zero dependency ─────────────────────────────────────────────────────────────────────

test('NFR-001: package.json declares no dependencies, devDependencies or optionalDependencies key', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const key of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    assert.ok(!Object.hasOwn(pkg, key), `package.json has a '${key}' key`);
  }
});

test('NFR-001: every require and import in src/runtime/dispatch/*.ts names a node: built-in or a relative src/ path', () => {
  const dir = path.join(REPO_ROOT, 'src', 'runtime', 'dispatch');
  const srcRoot = path.join(REPO_ROOT, 'src') + path.sep;
  const files = fs.readdirSync(dir).filter((name: any) => name.endsWith('.ts')).sort();
  assert.ok(files.length >= 10, `dispatch modules found: ${files.join(', ')}`);
  const pattern = /\brequire\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;
  let seen = 0;
  for (const name of files) {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    // A computed require or an ES import would escape the scan; the modules are CommonJS.
    assert.doesNotMatch(text, /\brequire\s*\(\s*[^'"`\s)]/, `${name}: a require of a computed name`);
    assert.doesNotMatch(text, /^\s*import\s|\bimport\s*\(/m, `${name}: an ES import`);
    for (const m of text.matchAll(pattern)) {
      const spec = m[2];
      seen += 1;
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('./') || spec.startsWith('../'), `${name}: '${spec}' is neither node: nor relative`);
      const resolved = path.resolve(dir, spec);
      assert.ok(resolved.startsWith(srcRoot), `${name}: '${spec}' resolves outside src/ (${resolved})`);
      assert.ok(fs.existsSync(resolved), `${name}: '${spec}' does not exist`);
    }
  }
  assert.ok(seen > 0, 'the scan read at least one require');
});

test('NFR-003 / IC-013 / 109 IC-008: codex is isolatedEdit supported on its recorded evidence, the other six keep it unknown, so auto runs sequential', () => {
  assert.deepEqual(HARNESSES.map((h: any) => h.id).sort(), [...REAL_IDS].sort());
  for (const h of HARNESSES) {
    assert.ok(h.worker && h.worker.isolatedEdit, `${h.id} declares a worker isolatedEdit block`);
    const want = h.id === 'codex' ? 'supported' : 'unknown';
    assert.equal(h.worker.isolatedEdit.status, want, `${h.id}: isolatedEdit is ${h.worker.isolatedEdit.status}`);
    if (h.id !== 'codex') assert.deepEqual(h.worker.isolatedEdit.evidence, [], `${h.id}: nothing recorded`);
  }
  const codex = HARNESSES.find((h: any) => h.id === 'codex');
  assert.ok(codex.worker.isolatedEdit.evidence.every((item: any) => fs.existsSync(path.join(REPO_ROOT, item))), 'codex cites a record that exists');
});

// ── NFR-002 / DEC-052: the static gate starts no harness binary ──────────────────────────────────

/** Every binary core/registry/harnesses.json declares for a worker CLI. */
function declaredBinaries() {
  const names = HARNESSES.map((h: any) => h.worker && h.worker.cli && h.worker.cli.binary).filter(Boolean);
  return [...new Set(names)].sort();
}

/**
 * A logging wrapper per declared binary in the sandbox bin/: an executable whose shebang is the
 * absolute node path (no PATH lookup), which appends `{ name, argv }` to `log` and exits 0 with a
 * version line, so a version probe that reached it would succeed and be recorded.
 */
function writeWrappers(bin: any, log: any, names: any) {
  for (const name of names) {
    const file = path.join(bin, name);
    assert.ok(!fs.existsSync(file), `sandbox bin/ already holds '${name}'`);
    const body = [
      `#!${process.execPath}`,
      "'use strict';",
      `require('node:fs').appendFileSync(${JSON.stringify(log)}, JSON.stringify({ name: ${JSON.stringify(name)}, argv: process.argv.slice(2) }) + '\\n');`,
      `process.stdout.write(${JSON.stringify(`${name} 0.0.0-wrapper\n`)});`,
      '',
    ].join('\n');
    fs.writeFileSync(file, body, { mode: 0o755 });
  }
}

test('NFR-002 / DEC-052: a real-registry dispatch start and step under auto start no harness binary and look up only codex', { skip: SKIP }, (t) => {
  const box = makeDispatchSandbox(t, { plan: 'dependent', slug: SLUG });
  const binaries = declaredBinaries();
  assert.deepEqual(binaries, ['agy', 'claude', 'codex', 'copilot', 'kiro-cli', 'opencode', 'pi']);
  const wrapperLog = path.join(box.dir, 'wrapper-log.jsonl');
  writeWrappers(box.bin, wrapperLog, binaries);

  // The child PATH is the scratch bin/ alone; the node install directory is never on it (DEC-056).
  assert.equal(box.env.PATH, box.bin);
  assert.ok(!box.env.PATH.split(path.delimiter).includes(path.dirname(process.execPath)));
  for (const key of IDENTITY_VARS) assert.ok(Object.hasOwn(box.env, key), `child env sets ${key}`);

  // A wrapper is reachable by bare name on the child PATH and logs when run: the probe the static
  // gate must prevent would be seen. The check runs before the dispatch, then the log is reset.
  const probe = spawnSync('claude', ['--version'], { cwd: box.root, env: box.env, encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.match(probe.stdout, /^claude 0\.0\.0-wrapper/);
  assert.equal(fs.readFileSync(wrapperLog, 'utf8').trim().split('\n').length, 1);
  fs.rmSync(wrapperLog);

  const cli = (...args: any[]) => {
    const r = spawnSync(process.execPath, [CLI, ...args], { cwd: box.root, env: box.env, encoding: 'utf8' });
    let data = null;
    try { data = JSON.parse(r.stdout); } catch { /* no JSON on stdout */ }
    return { status: r.status, stdout: r.stdout, stderr: r.stderr, data };
  };

  const started = cli('dispatch', '--action', 'start', '--slug', SLUG, '--by', 'tester', '--mode', 'auto',
    '--verify-argv', JSON.stringify(box.verifyArgv), '--json');
  assert.equal(started.status, 0, started.stderr || started.stdout);
  assert.equal(started.data?.mode, 'auto', started.stdout);

  const stepped = cli('dispatch', '--action', 'step', '--slug', SLUG, '--by', 'tester', '--json');
  assert.equal(stepped.status, 0, stepped.stderr || stepped.stdout);
  assert.equal(stepped.data?.disposition, 'stepped', stepped.stdout);

  // Only codex passes the static gate (109 IC-008), so only codex may be looked up, and only for its
  // `--version`: no other wrapper ran and nothing was launched.
  const ran = fs.existsSync(wrapperLog) ? fs.readFileSync(wrapperLog, 'utf8').trim().split('\n').filter(Boolean).map((line: any) => JSON.parse(line)) : [];
  for (const entry of ran) assert.deepEqual(entry, { name: 'codex', argv: ['--version'] }, `a harness binary ran beyond the codex version lookup: ${JSON.stringify(ran)}`);
  // The sandbox's fake-CLI log is empty too: no fake harness ran either.
  assert.ok(!fs.existsSync(box.log) || fs.readFileSync(box.log, 'utf8') === '', 'no fake harness ran');

  // The admitted dispatches run sequential, each naming every real harness and its static gaps.
  const store = JSON.parse(fs.readFileSync(storeFileFor(box.root, SLUG), 'utf8'));
  const dispatches = Object.values(store.dispatches);
  assert.ok(dispatches.length >= 1, `a dispatch was admitted: ${JSON.stringify(store)}`);
  for (const d of dispatches) {
    assert.equal(d.mode, 'sequential', JSON.stringify(d));
    assert.equal(d.selection.policy, 'auto');
    assert.equal(d.selection.chosen, 'sequential');
    assert.deepEqual(d.selection.candidates.map((c: any) => c.harness), REAL_IDS);
    for (const c of d.selection.candidates) {
      assert.equal(c.eligible, false, `${c.harness} is ineligible`);
      if (c.harness === 'codex') {
        // No static gap: what is left is the discover-time lookup that has not been probed.
        assert.deepEqual(c.gaps.map((g: any) => g.requirement), ['installed', 'runnable'], JSON.stringify(c.gaps));
        continue;
      }
      const gap = c.gaps.find((g: any) => g.requirement === 'isolated-edit');
      assert.ok(gap, `${c.harness} names its isolated-edit gap: ${JSON.stringify(c.gaps)}`);
      assert.equal(gap.result, 'unknown', `${c.harness}: ${JSON.stringify(gap)}`);
      // Static gaps only: a discover-time reason would mean a lookup happened.
      for (const g of c.gaps) assert.ok(['cli', 'one-shot', 'structured-output', 'isolated-edit', 'spawn-denial'].includes(g.requirement), `${c.harness}: non-static gap ${JSON.stringify(g)}`);
    }
  }
});
