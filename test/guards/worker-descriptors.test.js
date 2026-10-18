'use strict';

// G41 — worker descriptors (081 IC-031, DEC-013; 109 IC-009). Four checks, each a pure function over an
// injected registry, run once on the shipped tree and once on an in-memory copy seeded with one
// violation per check.
//
//   G41.1 every harness carries a `worker` block and the registry validator reports no error
//         containing " worker '" (validateWorker's message prefix, IC-001)
//   G41.2 every `supported` worker entry has evidence naming a repository path that exists or an
//         https:// URL
//   G41.3 every declared `structuredOutput.parser` is a key of PARSERS (checked here, beside the
//         parser table, because validateWorker deliberately does not require a runtime module)
//   G41.4 every `supported` worker entry other than cli/profile/modelChecks cites a recorded
//         evidence file under core/worker-evidence/<harness>/ that establishes that capability
//         (109 IC-009, DEC-003) and whose content holds up: a cli-check record has checks, every one
//         equal (id, argv, expect, establishes) to core/worker-evidence/<harness>/checks.json, and the
//         capability is recomputed from the checks that passed (result pass, exit 0, matched lines);
//         a live-run record counts only when its run succeeded and its result was offered
//
// validateWorker() (src/registry/index.ts) checks shape; this guard checks meaning.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const registryModule = require('../../src/registry/index.ts');
const { PARSERS } = require('../../src/runtime/worker/parsers.ts');
const { tempDir } = require('../helper/tmp');

const HARNESS_COUNT = 8;
const WORKER_ERROR = " worker '";

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────

/** G41.1: validator errors about a worker block, plus any harness with no block at all. */
function workerBlockFindings(registry, errors) {
  const findings = errors.filter((message) => message.includes(WORKER_ERROR));
  for (const harness of registry.harnesses) {
    const reported = findings.some((message) => message.includes(`harness '${harness.id}'`));
    if (!Object.hasOwn(harness, 'worker') && !reported) findings.push(`harness '${harness.id}': has no worker block`);
  }
  return findings;
}

/** True when `item` contains an https:// URL or a whitespace token that is an existing path inside
 * the repository (relative, no escape through `..`). */
function evidenceNamesSource(item, repoRoot) {
  if (/\bhttps:\/\/\S+/.test(item)) return true;
  return item.split(/\s+/).some((raw) => {
    const token = raw.replace(/^[("'`]+|[)"'`,.;:]+$/g, '');
    if (!token || path.isAbsolute(token) || !/[/.]/.test(token)) return false;
    const resolved = path.resolve(repoRoot, token);
    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) return false;
    return fs.existsSync(resolved);
  });
}

/** G41.2: every supported entry cites a repository path or an https:// URL. */
function supportedEvidenceFindings(registry, repoRoot) {
  const findings = [];
  for (const harness of registry.harnesses) {
    for (const [key, entry] of Object.entries(harness.worker || {})) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || entry.status !== 'supported') continue;
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      if (!evidence.some((item) => typeof item === 'string' && evidenceNamesSource(item, repoRoot))) {
        findings.push(`harness '${harness.id}' worker '${key}': supported entry has no evidence naming an existing repository path or an https:// URL`);
      }
    }
  }
  return findings;
}

/** G41.3: every declared structuredOutput.parser is registered in PARSERS. */
function parserFindings(registry, parsers) {
  const findings = [];
  for (const harness of registry.harnesses) {
    const entry = harness.worker?.structuredOutput;
    if (!entry || !Object.hasOwn(entry, 'parser')) continue;
    if (!Object.prototype.hasOwnProperty.call(parsers, entry.parser)) {
      findings.push(`harness '${harness.id}' worker 'structuredOutput': parser ${JSON.stringify(entry.parser)} is not a key of PARSERS (${Object.keys(parsers).join(', ')})`);
    }
  }
  return findings;
}

const EVIDENCE_SCHEMA = 'doflow-worker-evidence-v1';
const NOT_CAPABILITIES = new Set(['cli', 'profile', 'modelChecks']);

/** The checks file a cli-check record is bound to: core/worker-evidence/<harness>/checks.json. */
function checksSpec(harnessId, repoRoot) {
  try {
    const spec = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'core', 'worker-evidence', harnessId, 'checks.json'), 'utf8'));
    return spec && Array.isArray(spec.checks) ? spec.checks : null;
  } catch { return null; }
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** True when every check of a cli-check record equals its checks.json entry (id, argv, expect,
 * establishes) and `key` is established by a check that passed: result pass, exit 0, matched lines. */
function checksEstablish(record, harnessId, key, repoRoot) {
  if (!Array.isArray(record.checks) || record.checks.length === 0) return false;
  const spec = checksSpec(harnessId, repoRoot);
  if (!spec) return false;
  for (const check of record.checks) {
    const bound = spec.find((entry) => entry.id === check?.id);
    if (!bound || !sameJson(check.argv, bound.argv) || !sameJson(check.expect, bound.expect) || !sameJson(check.establishes, bound.establishes)) return false;
  }
  const recomputed = new Set(record.checks
    .filter((check) => check.result === 'pass' && check.exit === 0 && Array.isArray(check.matched) && check.matched.length > 0)
    .flatMap((check) => check.establishes));
  return recomputed.has(key);
}

/** True when `item` is a repository path under core/worker-evidence/<harness>/ whose file parses as a
 * record for that harness and establishes `key`: a cli-check record through its own passing checks
 * (run is null), a live-run record only when its run succeeded and its result was offered. */
function recordEstablishes(item, harnessId, key, repoRoot) {
  if (typeof item !== 'string') return false;
  const dir = path.resolve(repoRoot, 'core', 'worker-evidence', harnessId);
  const file = path.resolve(repoRoot, item);
  if (path.dirname(file) !== dir || path.extname(file) !== '.json') return false;
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!record || record.schema !== EVIDENCE_SCHEMA || record.harness !== harnessId) return false;
  if (typeof record.cliVersion !== 'string' || record.cliVersion === '') return false;
  if (!Array.isArray(record.establishes) || !record.establishes.includes(key)) return false;
  if (record.kind === 'live-run') return record.run?.report?.status === 'success' && record.run?.resultOffered === true;
  if (record.kind !== 'cli-check' || record.run !== null) return false;
  return checksEstablish(record, harnessId, key, repoRoot);
}

/** G41.4: every supported capability entry cites a record that establishes it. */
function establishingRecordFindings(registry, repoRoot) {
  const findings = [];
  for (const harness of registry.harnesses) {
    for (const [key, entry] of Object.entries(harness.worker || {})) {
      if (NOT_CAPABILITIES.has(key) || entry === null || typeof entry !== 'object' || Array.isArray(entry) || entry.status !== 'supported') continue;
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      if (!evidence.some((item) => recordEstablishes(item, harness.id, key, repoRoot))) {
        findings.push(`G41.4: harness '${harness.id}' worker '${key}': supported without a recorded evidence file that establishes it`);
      }
    }
  }
  return findings;
}

function allFindings(registry, errors, repoRoot) {
  return [
    ...workerBlockFindings(registry, errors),
    ...supportedEvidenceFindings(registry, repoRoot),
    ...parserFindings(registry, PARSERS),
  ];
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────

/** The shipped registry and its validator errors. loadRegistry throws on any error, so a failed
 * load is read back from the thrown validation rather than lost. */
function shipped() {
  try {
    const registry = registryModule.loadRegistry({ repoRoot: REPO });
    return { registry, errors: registry.validation.errors };
  } catch (error) {
    if (!error.validation) throw error;
    return { registry: null, errors: error.validation.errors };
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

test('G41.1: all eight harnesses carry a worker block and loadRegistry reports no worker error', () => {
  const { registry, errors } = shipped();
  assert.deepEqual(errors.filter((message) => message.includes(WORKER_ERROR)), []);
  assert.ok(registry, `registry failed to load:\n- ${errors.join('\n- ')}`);
  assert.equal(registry.harnesses.length, HARNESS_COUNT);
  assert.deepEqual(workerBlockFindings(registry, errors), []);
});

test('G41.2: every supported worker entry cites an existing repository path or an https:// URL', () => {
  const { registry } = shipped();
  assert.deepEqual(supportedEvidenceFindings(registry, REPO), []);
});

test('G41.3: every declared structuredOutput.parser is a key of PARSERS', () => {
  const { registry } = shipped();
  assert.deepEqual(parserFindings(registry, PARSERS), []);
});

test('G41 control: a dropped block, argv on an unknown entry and an unregistered parser give three named findings', () => {
  const registry = structuredClone(shipped().registry);
  const [dropped, unknownArgv, badParser] = [registry.harnesses[1], registry.harnesses[2], registry.harnesses[3]];
  delete dropped.worker;
  assert.equal(unknownArgv.worker.readOnly.status, 'unknown', 'control precondition: readOnly is unknown');
  unknownArgv.worker.readOnly.argv = ['--read-only'];
  badParser.worker.structuredOutput = {
    status: 'supported',
    evidence: ['https://example.invalid/structured-output'],
    verification: 'control fixture',
    verifiedOn: '2026-01-01',
    parser: 'not-a-registered-parser',
  };

  const errors = registryModule.validateRegistry(registry, { repoRoot: REPO }).errors;
  const findings = allFindings(registry, errors, REPO);
  assert.equal(findings.length, 3, `expected three findings, got:\n- ${findings.join('\n- ')}`);
  assert.match(findings.find((f) => f.includes(`harness '${dropped.id}'`)) ?? '', /worker block is required/);
  assert.match(findings.find((f) => f.includes(`harness '${unknownArgv.id}'`)) ?? '', /worker 'readOnly'.*recipe field 'argv' is allowed only when status is supported/);
  assert.match(findings.find((f) => f.includes(`harness '${badParser.id}'`)) ?? '', /parser "not-a-registered-parser" is not a key of PARSERS/);
});

test('G41.2 control: supported evidence with neither an existing path nor an https:// URL is reported', () => {
  const registry = structuredClone(shipped().registry);
  const harness = registry.harnesses[0];
  harness.worker.cli.evidence = ['bench/inventory/no-such-file.json → claimed', 'http://example.invalid/plain-http'];
  assert.deepEqual(supportedEvidenceFindings(registry, REPO), [
    `harness '${harness.id}' worker 'cli': supported entry has no evidence naming an existing repository path or an https:// URL`,
  ]);
});

test('G41.3: codex declares the codex-exec-json-v1 parser and the seven other harnesses declare none', () => {
  const { registry } = shipped();
  for (const harness of registry.harnesses) {
    const entry = harness.worker.structuredOutput;
    if (harness.id === 'codex') {
      assert.equal(entry.status, 'supported');
      assert.equal(entry.parser, 'codex-exec-json-v1');
    } else {
      assert.equal(entry.status, 'unknown', harness.id);
      assert.ok(!Object.hasOwn(entry, 'parser'), harness.id);
    }
  }
});

test('G41.4: every supported worker entry cites a recorded evidence file that establishes it', () => {
  const { registry } = shipped();
  assert.deepEqual(establishingRecordFindings(registry, REPO), []);
  // The guard is not vacuous: codex holds six supported capability entries, the seven others none.
  const supportedKeys = (harness) => Object.entries(harness.worker)
    .filter(([key, entry]) => !NOT_CAPABILITIES.has(key) && entry?.status === 'supported').map(([key]) => key).sort();
  for (const harness of registry.harnesses) {
    assert.deepEqual(supportedKeys(harness), harness.id === 'codex'
      ? ['isolatedEdit', 'oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput']
      : [], harness.id);
  }
});

/** A scratch repo root holding a mutated copy of codex's cited record next to the real checks.json. */
function scratchRecordRoot(t, mutate) {
  const root = tempDir(t, 'doflow-g414-');
  const registry = structuredClone(shipped().registry);
  const cited = registry.harnesses.find((h) => h.id === 'codex').worker.structuredOutput.evidence[0];
  const record = JSON.parse(fs.readFileSync(path.join(REPO, cited), 'utf8'));
  mutate(record);
  const dir = path.join(root, path.dirname(cited));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, cited), JSON.stringify(record));
  fs.copyFileSync(path.join(REPO, path.dirname(cited), 'checks.json'), path.join(dir, 'checks.json'));
  return { root, registry, cited };
}

test('G41.4 control: a record that no longer establishes structuredOutput gives exactly that one finding', (t) => {
  const { root, registry, cited } = scratchRecordRoot(t, (record) => {
    record.establishes = record.establishes.filter((key) => key !== 'structuredOutput');
  });
  assert.deepEqual(establishingRecordFindings(registry, root), [
    "G41.4: harness 'codex' worker 'structuredOutput': supported without a recorded evidence file that establishes it",
  ]);
  // The unmutated record satisfies the same entries, so the finding comes from the dropped key alone.
  fs.writeFileSync(path.join(root, cited), fs.readFileSync(path.join(REPO, cited)));
  assert.deepEqual(establishingRecordFindings(registry, root), []);
});

test('G41.4 control: a failing spawn-denial check with establishes kept withdraws spawnDenial and nothing else', (t) => {
  const { root, registry } = scratchRecordRoot(t, (record) => {
    const check = record.checks.find((c) => c.id === 'spawn-denial');
    Object.assign(check, { result: 'fail', exit: 1, matched: [] });
  });
  assert.deepEqual(establishingRecordFindings(registry, root), [
    "G41.4: harness 'codex' worker 'spawnDenial': supported without a recorded evidence file that establishes it",
  ]);
});

test('G41.4 control: a check with exit 0 but no matched lines, or exit 1 despite pass, establishes nothing', (t) => {
  const noMatch = scratchRecordRoot(t, (record) => { record.checks.find((c) => c.id === 'spawn-denial').matched = []; });
  assert.equal(establishingRecordFindings(noMatch.registry, noMatch.root).length, 1, 'empty matched');
  const badExit = scratchRecordRoot(t, (record) => { record.checks.find((c) => c.id === 'spawn-denial').exit = 1; });
  assert.equal(establishingRecordFindings(badExit.registry, badExit.root).length, 1, 'exit 1 with result pass');
});

test('G41.4 control: a hand-written record with no checks that claims every capability establishes none', (t) => {
  const { root, registry } = scratchRecordRoot(t, (record) => { record.checks = []; });
  assert.deepEqual(establishingRecordFindings(registry, root).map((f) => /worker '(\w+)'/.exec(f)[1]).sort(),
    ['isolatedEdit', 'oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput']);
});

test('G41.4 control: a check altered against checks.json (argv, expect or establishes) breaks the record', (t) => {
  const alterations = {
    argv: (check) => { check.argv = ['exec', '--version']; },
    expect: (check) => { check.expect = ['.']; },
    establishes: (check) => { check.establishes = [...check.establishes, 'readOnly']; },
  };
  for (const [what, alter] of Object.entries(alterations)) {
    const { root, registry } = scratchRecordRoot(t, (record) => { alter(record.checks.find((c) => c.id === 'exec-sandbox')); });
    assert.ok(establishingRecordFindings(registry, root).length > 0, `an altered ${what} must be caught`);
  }
});

test('G41.4 control: a cli-check record with a run, or without a checks.json beside it, establishes nothing', (t) => {
  const withRun = scratchRecordRoot(t, (record) => { record.run = { resultOffered: true, report: { status: 'success' } }; });
  assert.equal(establishingRecordFindings(withRun.registry, withRun.root).length, 6, 'run must be null for a cli-check');
  const lonely = scratchRecordRoot(t, () => {});
  fs.rmSync(path.join(lonely.root, 'core', 'worker-evidence', 'codex', 'checks.json'));
  assert.equal(establishingRecordFindings(lonely.registry, lonely.root).length, 6, 'no checks.json');
});

test('G41.4 control: a live-run record whose result was not offered or whose run failed, a missing file and another harness\'s record do not count', (t) => {
  const root = tempDir(t, 'doflow-g414-');
  const registry = structuredClone(shipped().registry);
  const codex = registry.harnesses.find((h) => h.id === 'codex');
  const dir = path.join(root, 'core', 'worker-evidence', 'codex');
  fs.mkdirSync(dir, { recursive: true });
  const live = (name, extra) => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({
      schema: EVIDENCE_SCHEMA, harness: 'codex', kind: 'live-run', cliVersion: 'codex-cli 0.0.0',
      establishes: ['oneShot'], checks: [], ...extra,
    }));
    return `core/worker-evidence/codex/${name}`;
  };
  codex.worker.oneShot.evidence = [live('2026-10-18-live-run.json', { run: { resultOffered: false, report: { status: 'success' } } })];
  const oneShot = () => establishingRecordFindings(registry, root).filter((f) => f.includes("'oneShot'"));
  assert.equal(oneShot().length, 1, 'resultOffered false does not establish');
  codex.worker.oneShot.evidence = [live('2026-10-18-live-run-c.json', { run: { resultOffered: true, report: { status: 'failure' } } })];
  assert.equal(oneShot().length, 1, 'a run whose report is not success does not establish');
  codex.worker.oneShot.evidence = [live('2026-10-18-live-run-b.json', { run: { resultOffered: true, report: { status: 'success' } } })];
  assert.deepEqual(oneShot(), [], 'a successful run with its result offered does');
  codex.worker.oneShot.evidence = ['core/worker-evidence/codex/2026-10-18-missing.json'];
  assert.equal(oneShot().length, 1, 'a missing file does not establish');
  codex.worker.oneShot.evidence = ['core/worker-evidence/gemini/2026-10-18-cli-check.json'];
  assert.equal(oneShot().length, 1, 'another harness directory does not establish');
});
