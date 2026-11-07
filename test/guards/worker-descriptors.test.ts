'use strict';

// G41 — worker descriptors (081 IC-031, DEC-013; 109 IC-009; 142 IC-013). Five checks, each a pure function over an
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
//         a live-run record counts only when its run succeeded, its result was offered and its
//         run.argvShape equals the shape the registry recipe assembles (read-only or edit order), and a
//         read-only run's worktree check was clean. The supported keys of each harness are pinned to the
//         literal ACCEPTED_KEYS, and each structuredOutput parser to the literal PARSER_BY_HARNESS (142 IC-013)
//   G41.5 outside codex, each supported readOnly and spawnDenial entry cites a live-run record that
//         passes the G41.4 test for that key (a cli-check alone is not enough)
//
// validateWorker() (src/registry/index.ts) checks shape; this guard checks meaning.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared.ts');
const registryModule = require('../../src/registry/index.ts');
const { PARSERS } = require('../../src/runtime/worker/parsers.ts');
const { argvShape } = require('../../src/runtime/worker/launch.ts');
const { tempDir } = require('../helper/tmp.ts');

const HARNESS_COUNT = 7;
const WORKER_ERROR = " worker '";

// ── Checks ──────────────────────────────────────────────────────────────────────────────────────

/** G41.1: validator errors about a worker block, plus any harness with no block at all. */
function workerBlockFindings(registry: any, errors: any) {
  const findings = errors.filter((message: any) => message.includes(WORKER_ERROR));
  for (const harness of registry.harnesses) {
    const reported = findings.some((message: any) => message.includes(`harness '${harness.id}'`));
    if (!Object.hasOwn(harness, 'worker') && !reported) findings.push(`harness '${harness.id}': has no worker block`);
  }
  return findings;
}

/** True when `item` contains an https:// URL or a whitespace token that is an existing path inside
 * the repository (relative, no escape through `..`). */
function evidenceNamesSource(item: any, repoRoot: any) {
  if (/\bhttps:\/\/\S+/.test(item)) return true;
  return item.split(/\s+/).some((raw: any) => {
    const token = raw.replace(/^[("'`]+|[)"'`,.;:]+$/g, '');
    if (!token || path.isAbsolute(token) || !/[/.]/.test(token)) return false;
    const resolved = path.resolve(repoRoot, token);
    if (resolved !== repoRoot && !resolved.startsWith(repoRoot + path.sep)) return false;
    return fs.existsSync(resolved);
  });
}

/** G41.2: every supported entry cites a repository path or an https:// URL. */
function supportedEvidenceFindings(registry: any, repoRoot: any) {
  const findings: any = [];
  for (const harness of registry.harnesses) {
    for (const [key, entry] of Object.entries(harness.worker || {})) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry) || entry.status !== 'supported') continue;
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      if (!evidence.some((item: any) => typeof item === 'string' && evidenceNamesSource(item, repoRoot))) {
        findings.push(`harness '${harness.id}' worker '${key}': supported entry has no evidence naming an existing repository path or an https:// URL`);
      }
    }
  }
  return findings;
}

/** G41.3: every declared structuredOutput.parser is registered in PARSERS. */
function parserFindings(registry: any, parsers: any) {
  const findings: any = [];
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
const NOT_CAPABILITIES: any = new Set(['cli', 'profile', 'modelChecks']);

/** The checks file a record is bound to: core/worker-evidence/<harness>/checks.json. */
function checksFile(harnessId: any, repoRoot: any) {
  try {
    const spec = JSON.parse(fs.readFileSync(path.resolve(repoRoot, 'core', 'worker-evidence', harnessId, 'checks.json'), 'utf8'));
    return spec && Array.isArray(spec.checks) ? spec : null;
  } catch { return null; }
}

const checksSpec = (harnessId: any, repoRoot: any) => checksFile(harnessId, repoRoot)?.checks ?? null;

/** True when `cliVersion` matches the harness's own `version.expect` from its checks.json (a hand-typed
 * 'x' or another harness's version line does not). */
function cliVersionMatches(cliVersion: any, harnessId: any, repoRoot: any) {
  const expect = checksFile(harnessId, repoRoot)?.version?.expect;
  if (typeof expect !== 'string') return false;
  try { return new RegExp(expect).test(cliVersion); } catch { return false; }
}

const sameJson = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);

/** True when every check of a cli-check record equals its checks.json entry (id, argv, expect,
 * establishes) and `key` is established by a check that passed: result pass, exit 0, matched lines. */
function checksEstablish(record: any, harnessId: any, key: any, repoRoot: any) {
  if (!Array.isArray(record.checks) || record.checks.length === 0) return false;
  const spec = checksSpec(harnessId, repoRoot);
  if (!spec) return false;
  for (const check of record.checks) {
    const bound = spec.find((entry: any) => entry.id === check?.id);
    if (!bound || !sameJson(check.argv, bound.argv) || !sameJson(check.expect, bound.expect) || !sameJson(check.establishes, bound.establishes)) return false;
  }
  const recomputed: any = new Set(record.checks
    .filter((check: any) => check.result === 'pass' && check.exit === 0 && Array.isArray(check.matched) && check.matched.length > 0)
    .flatMap((check: any) => check.establishes));
  return recomputed.has(key);
}

/** The prompt element is a per-run hash, so both shapes are compared with it written `<prompt>`. */
function withoutPromptHash(shape: any) {
  return Array.isArray(shape) ? shape.map((value) => (/^<prompt .*>$/.test(value) ? '<prompt>' : value)) : shape;
}

/** True when a live-run record's argvShape equals the recipe's own shape, in the order its run kind
 * uses (edit: isolatedEdit first). A readOnly record must be a read-only run, an isolatedEdit one an edit run. */
function shapeMatchesRecipe(record: any, key: any, worker: any) {
  const edit = record.run?.edit === true;
  if ((key === 'readOnly' && edit) || (key === 'isolatedEdit' && !edit)) return false;
  let expected;
  try { expected = argvShape(worker, '', edit); } catch { return false; }
  return sameJson(withoutPromptHash(record.run?.argvShape), withoutPromptHash(expected));
}

/** True when `item` is a repository path under core/worker-evidence/<harness>/ whose file parses as a
 * record for that harness and establishes `key`: a cli-check record through its own passing checks
 * (run is null), a live-run record only when its run succeeded, its result was offered and its
 * argvShape matches the recipe in `worker`. */
function recordEstablishes(item: any, harnessId: any, key: any, repoRoot: any, worker: any) {
  if (typeof item !== 'string') return false;
  const dir = path.resolve(repoRoot, 'core', 'worker-evidence', harnessId);
  const file = path.resolve(repoRoot, item);
  if (path.dirname(file) !== dir || path.extname(file) !== '.json') return false;
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!record || record.schema !== EVIDENCE_SCHEMA || record.harness !== harnessId) return false;
  if (typeof record.cliVersion !== 'string' || !cliVersionMatches(record.cliVersion, harnessId, repoRoot)) return false;
  if (!Array.isArray(record.establishes) || !record.establishes.includes(key)) return false;
  if (record.kind === 'live-run') {
    // A read-only run counts only when the worktree check afterwards was clean (142 IC-013 rule 3).
    const worktreeOk = record.run?.edit === true || record.run?.readOnly?.status === 'clean';
    return record.run?.report?.status === 'success' && record.run?.resultOffered === true && worktreeOk && shapeMatchesRecipe(record, key, worker);
  }
  if (record.kind !== 'cli-check' || record.run !== null) return false;
  return checksEstablish(record, harnessId, key, repoRoot);
}

/** G41.4: every supported capability entry cites a record that establishes it. */
function establishingRecordFindings(registry: any, repoRoot: any) {
  const findings: any = [];
  for (const harness of registry.harnesses) {
    for (const [key, entry] of Object.entries(harness.worker || {})) {
      if (NOT_CAPABILITIES.has(key) || entry === null || typeof entry !== 'object' || Array.isArray(entry) || entry.status !== 'supported') continue;
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      if (!evidence.some((item: any) => recordEstablishes(item, harness.id, key, repoRoot, harness.worker))) {
        findings.push(`G41.4: harness '${harness.id}' worker '${key}': supported without a recorded evidence file that establishes it`);
      }
    }
  }
  return findings;
}

/** The capability keys (not cli/profile/modelChecks) a harness declares `supported`, sorted. */
function supportedKeys(harness: any) {
  return Object.entries(harness.worker || {})
    .filter(([key, entry]: any) => !NOT_CAPABILITIES.has(key) && entry?.status === 'supported')
    .map(([key]) => key).sort();
}

/** G41.4 pin: supportedKeys(h) equals accepted[h] (a harness not in the map accepts nothing), and
 * every accepted harness id names a registry harness. */
function acceptedKeyFindings(registry: any, accepted: any) {
  const findings: any = [];
  const ids = registry.harnesses.map((harness: any) => harness.id);
  for (const id of Object.keys(accepted)) {
    if (!ids.includes(id)) findings.push(`G41.4: ACCEPTED_KEYS has an entry for '${id}', which is not a registry harness`);
  }
  for (const harness of registry.harnesses) {
    const listed: any = Object.hasOwn(accepted, harness.id) ? accepted[harness.id] : [];
    const actual = supportedKeys(harness);
    for (const key of actual) {
      if (!listed.includes(key)) findings.push(`G41.4: harness '${harness.id}' worker '${key}' is supported but not in ACCEPTED_KEYS`);
    }
    for (const key of listed) {
      if (!actual.includes(key)) findings.push(`G41.4: ACCEPTED_KEYS lists '${key}' for harness '${harness.id}', which has no such supported registry key`);
    }
  }
  return findings;
}

/** G41.3 map: a supported structuredOutput declares exactly its mapped parser (a harness with no
 * mapping may not be supported); one that is not supported declares none; every mapped id is a key
 * of `parsers`. */
function parserMapFindings(registry: any, map: any, parsers: any) {
  const findings: any = [];
  for (const [id, parser] of Object.entries(map)) {
    if (!Object.hasOwn(parsers, parser as any)) findings.push(`G41.3: PARSER_BY_HARNESS maps '${id}' to ${JSON.stringify(parser)}, which is not a key of PARSERS`);
  }
  for (const harness of registry.harnesses) {
    const entry = harness.worker?.structuredOutput;
    if (!entry) continue;
    const declared = Object.hasOwn(entry, 'parser');
    if (entry.status === 'supported') {
      if (!Object.hasOwn(map, harness.id)) findings.push(`G41.3: harness '${harness.id}' has a supported structuredOutput but no entry in PARSER_BY_HARNESS`);
      else if (entry.parser !== map[harness.id]) findings.push(`G41.3: harness '${harness.id}' declares parser ${JSON.stringify(entry.parser)}, expected ${JSON.stringify(map[harness.id])}`);
    } else if (declared) {
      findings.push(`G41.3: harness '${harness.id}' declares a parser on a structuredOutput that is not supported`);
    }
  }
  return findings;
}

/** G41.5: outside codex, each supported readOnly and spawnDenial entry cites a `live-run` record that
 * passes recordEstablishes for that key. */
function liveRecordFindings(registry: any, repoRoot: any) {
  const findings: any = [];
  for (const harness of registry.harnesses) {
    if (harness.id === 'codex') continue; // its records predate the rule
    for (const key of ['readOnly', 'spawnDenial']) {
      const entry = harness.worker?.[key];
      if (entry?.status !== 'supported') continue;
      const evidence = Array.isArray(entry.evidence) ? entry.evidence : [];
      const live = evidence.some((item: any) => {
        if (!recordEstablishes(item, harness.id, key, repoRoot, harness.worker)) return false;
        try { return JSON.parse(fs.readFileSync(path.resolve(repoRoot, item), 'utf8')).kind === 'live-run'; } catch { return false; }
      });
      if (!live) findings.push(`G41.5: harness '${harness.id}' worker '${key}': supported without a live-run record that establishes it`);
    }
  }
  return findings;
}

function allFindings(registry: any, errors: any, repoRoot: any) {
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
  } catch (error: any) {
    if (!error.validation) throw error;
    return { registry: null, errors: error.validation.errors };
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────────────────────────

test('G41.1: all seven harnesses carry a worker block and loadRegistry reports no worker error', () => {
  const { registry, errors } = shipped();
  assert.deepEqual(errors.filter((message: any) => message.includes(WORKER_ERROR)), []);
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
  // claude is a harness whose readOnly is unknown, so argv on it is a validator finding.
  const [dropped, unknownArgv, badParser]: any = [registry.harnesses[1], registry.harnesses.find((h: any) => h.id === 'claude'), registry.harnesses[3]];
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

// Literal pins (142 IC-013). Neither is derived from the registry: a new `supported` key or parser
// fails here until a person edits the lists below in the same change that adds its record.
const PARSER_BY_HARNESS: any = {
  codex: 'codex-exec-json-v1',
  claude: 'claude-stream-json-v1',
  opencode: 'opencode-run-json-v1',
  copilot: 'copilot-json-v1',
  kiro: 'kiro-stream-json-v1',
  pi: 'pi-json-v1',
  antigravity: 'agy-stream-json-v1',
};

const ACCEPTED_KEYS: any = {
  codex: ['isolatedEdit', 'model', 'oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput'],
  opencode: ['model', 'oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput'],
  claude: ['model'],
  copilot: ['model', 'oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput'],
  pi: ['model', 'oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput'],
  kiro: ['model', 'oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput'],
  antigravity: ['oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput'],
};

test('G41.3: PARSER_BY_HARNESS names every parser-bearing harness, each id a key of PARSERS', () => {
  assert.deepEqual(Object.keys(PARSER_BY_HARNESS).sort(), ['antigravity', 'claude', 'codex', 'copilot', 'kiro', 'opencode', 'pi']);
  for (const [id, parser] of Object.entries(PARSER_BY_HARNESS)) assert.ok(Object.hasOwn(PARSERS, parser as any), `${id}: ${parser}`);
});

test('G41.3: a harness with a supported structuredOutput declares exactly its mapped parser, the others declare none', () => {
  const { registry } = shipped();
  assert.deepEqual(parserMapFindings(registry, PARSER_BY_HARNESS, PARSERS), []);
  const claude = registry.harnesses.find((h: any) => h.id === 'claude');
  assert.ok(!Object.hasOwn(claude.worker.structuredOutput, 'parser'));
});

test('G41.3 control: a mapped id outside PARSERS, a wrong parser, a parser on a non-supported entry and a supported entry with no mapping are each reported', () => {
  const registry = structuredClone(shipped().registry);
  const byId = (id: any) => registry.harnesses.find((h: any) => h.id === id);
  const outside = parserMapFindings(registry, { ...PARSER_BY_HARNESS, claude: 'not-a-registered-parser' }, PARSERS);
  assert.equal(outside.length, 1);
  assert.match(outside[0], /maps 'claude' to "not-a-registered-parser".*not a key of PARSERS/);
  assert.equal(parserMapFindings(registry, { ...PARSER_BY_HARNESS, opencode: 'codex-exec-json-v1' }, PARSERS).length, 1, 'wrong parser for opencode');
  byId('claude').worker.structuredOutput.parser = 'codex-exec-json-v1';
  assert.match(parserMapFindings(registry, PARSER_BY_HARNESS, PARSERS).join('\n'), /harness 'claude' declares a parser on a structuredOutput that is not supported/);
  delete byId('claude').worker.structuredOutput.parser;
  const { antigravity: _, ...withoutAgy } = PARSER_BY_HARNESS;
  assert.match(parserMapFindings(registry, withoutAgy, PARSERS).join('\n'), /harness 'antigravity' has a supported structuredOutput but no entry in PARSER_BY_HARNESS/);
});

test('G41.4: every supported worker entry cites a recorded evidence file that establishes it', () => {
  const { registry } = shipped();
  assert.deepEqual(establishingRecordFindings(registry, REPO), []);
  // The guard is not vacuous: each harness holds exactly the supported capability entries in ACCEPTED_KEYS.
  for (const harness of registry.harnesses) {
    assert.deepEqual(supportedKeys(harness), Object.hasOwn(ACCEPTED_KEYS, harness.id) ? ACCEPTED_KEYS[harness.id] : [], harness.id);
  }
  assert.deepEqual(acceptedKeyFindings(registry, ACCEPTED_KEYS), []);
  for (const [id, keys] of Object.entries(ACCEPTED_KEYS)) assert.deepEqual(keys, [...(keys as any)].sort(), `${id} keys are sorted`);
  assert.deepEqual(supportedKeys({ worker: { oneShot: { status: 'supported' } } }), ['oneShot']);
});

test('G41.4 control: an ACCEPTED_KEYS entry with no registry key, one for no harness, and a registry key with no map entry are each reported', () => {
  const registry = structuredClone(shipped().registry);
  const extraKey = acceptedKeyFindings(registry, { ...ACCEPTED_KEYS, claude: ['model', 'oneShot'] });
  assert.equal(extraKey.length, 1);
  assert.match(extraKey[0], /ACCEPTED_KEYS lists 'oneShot' for harness 'claude'/);
  const extraHarness = acceptedKeyFindings(registry, { ...ACCEPTED_KEYS, nonesuch: [] });
  assert.equal(extraHarness.length, 1);
  assert.match(extraHarness[0], /entry for 'nonesuch', which is not a registry harness/);
  const { opencode, ...withoutOpencode } = ACCEPTED_KEYS;
  const missing = acceptedKeyFindings(registry, withoutOpencode);
  assert.deepEqual(missing.map((f: any) => /worker '(\w+)'/.exec(f)![1]).sort(), [...opencode]);
  assert.ok(missing.every((f: any) => f.includes("harness 'opencode'") && f.includes('not in ACCEPTED_KEYS')));
});

test('G41.4 control: a supported key added to claude without a map entry fails', () => {
  for (const id of ['claude']) {
    const registry = structuredClone(shipped().registry);
    const harness = registry.harnesses.find((h: any) => h.id === id);
    assert.deepEqual(supportedKeys(harness), ['model'], `${id}: control precondition`);
    harness.worker.oneShot = { status: 'supported', evidence: ['https://example.invalid/one-shot'], verification: 'control fixture', verifiedOn: '2026-01-01' };
    assert.deepEqual(acceptedKeyFindings(registry, ACCEPTED_KEYS), [`G41.4: harness '${id}' worker 'oneShot' is supported but not in ACCEPTED_KEYS`], id);
  }
});

test('G41.5: outside codex, each supported readOnly and spawnDenial entry cites a live-run record that establishes it', () => {
  const { registry } = shipped();
  assert.deepEqual(liveRecordFindings(registry, REPO), []);
  // Not vacuous: opencode is the harness that must be checked, and it cites such a record for both keys.
  const opencode = registry.harnesses.find((h: any) => h.id === 'opencode');
  for (const key of ['readOnly', 'spawnDenial']) {
    assert.equal(opencode.worker[key].status, 'supported', key);
    assert.ok(opencode.worker[key].evidence.some((item: any) => /-live-run-/.test(item) && recordEstablishes(item, 'opencode', key, REPO, opencode.worker)), key);
  }
});

test('G41.5 control: removing the live-run citation gives exactly one finding per key and G41.4 still holds on the cli-check', () => {
  const registry = structuredClone(shipped().registry);
  const opencode = registry.harnesses.find((h: any) => h.id === 'opencode');
  for (const key of ['readOnly', 'spawnDenial']) {
    opencode.worker[key].evidence = opencode.worker[key].evidence.filter((item: any) => !/-live-run-/.test(item));
    assert.ok(opencode.worker[key].evidence.length > 0, `${key}: a cli-check is still cited`);
  }
  assert.deepEqual(establishingRecordFindings(registry, REPO), []);
  assert.deepEqual(liveRecordFindings(registry, REPO), [
    "G41.5: harness 'opencode' worker 'readOnly': supported without a live-run record that establishes it",
    "G41.5: harness 'opencode' worker 'spawnDenial': supported without a live-run record that establishes it",
  ]);
});

test('G41.5 control: codex is exempt, and a cited live-run record that fails recordEstablishes does not count', (t) => {
  const registry = structuredClone(shipped().registry);
  const codex = registry.harnesses.find((h: any) => h.id === 'codex');
  codex.worker.readOnly.evidence = codex.worker.readOnly.evidence.filter((item: any) => !/-live-run-/.test(item));
  assert.deepEqual(liveRecordFindings(registry, REPO), [], 'codex needs no live-run citation');
  // kiro's real live-run records live in the repository, not in the opencode scratch root; its entries are not under test here.
  const kiro = registry.harnesses.find((h: any) => h.id === 'kiro');
  for (const key of ['readOnly', 'spawnDenial']) kiro.worker[key].status = 'unknown';
  const copilot = registry.harnesses.find((h: any) => h.id === 'copilot');
  for (const key of ['readOnly', 'spawnDenial']) copilot.worker[key].status = 'unknown';
  const pi = registry.harnesses.find((h: any) => h.id === 'pi');
  for (const key of ['readOnly', 'spawnDenial']) pi.worker[key].status = 'unknown';
  const antigravity = registry.harnesses.find((h: any) => h.id === 'antigravity');
  for (const key of ['readOnly', 'spawnDenial']) antigravity.worker[key].status = 'unknown';
  const { root, copy } = opencodeScratch(t);
  const opencode = registry.harnesses.find((h: any) => h.id === 'opencode');
  const failed = copy('2026-11-07-live-run-read-only.json', 'failed.json', (r: any) => { r.run.report.status = 'failure'; });
  opencode.worker.readOnly.evidence = [failed];
  opencode.worker.spawnDenial.evidence = [failed];
  assert.deepEqual(liveRecordFindings(registry, root), [
    "G41.5: harness 'opencode' worker 'readOnly': supported without a live-run record that establishes it",
    "G41.5: harness 'opencode' worker 'spawnDenial': supported without a live-run record that establishes it",
  ]);
});

/** A scratch root holding copies of opencode's records, mutated in memory before they are written. */
function opencodeScratch(t: any) {
  const root = tempDir(t, 'doflow-g415-');
  const dir = path.join(root, 'core', 'worker-evidence', 'opencode');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'core', 'worker-evidence', 'opencode', 'checks.json'), path.join(dir, 'checks.json'));
  const copy = (source: any, name: any, mutate: any) => {
    const record = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'worker-evidence', 'opencode', source), 'utf8'));
    mutate(record);
    fs.writeFileSync(path.join(dir, name), JSON.stringify(record));
    return `core/worker-evidence/opencode/${name}`;
  };
  return { root, copy };
}

test('G41.5 control: a hand-edited live-run record (failed report, non-clean readOnly status, forged establishes) is not accepted by recordEstablishes', (t) => {
  const opencode = structuredClone(shipped().registry.harnesses.find((h: any) => h.id === 'opencode'));
  const { root, copy } = opencodeScratch(t);
  const accepted = (item: any, key: any) => recordEstablishes(item, 'opencode', key, root, opencode.worker);
  for (const source of ['2026-11-07-live-run-read-only.json', '2026-11-07-live-run-spawn.json']) {
    for (const key of ['readOnly', 'spawnDenial']) {
      assert.equal(accepted(copy(source, 'ok.json', () => {}), key), true, `${source}: an intact copy establishes ${key}`);
      assert.equal(accepted(copy(source, 'failed.json', (r: any) => { r.run.report.status = 'failure'; }), key), false, `${source}: report failure, ${key}`);
      for (const status of ['violated', 'dirty', '', null, undefined]) {
        assert.equal(accepted(copy(source, 'ro.json', (r: any) => { r.run.readOnly.status = status; }), key), false, `${source}: readOnly.status ${String(status)}, ${key}`);
      }
      assert.equal(accepted(copy(source, 'no-ro.json', (r: any) => { delete r.run.readOnly; }), key), false, `${source}: no readOnly block, ${key}`);
      assert.equal(accepted(copy(source, 'dropped.json', (r: any) => { r.establishes = r.establishes.filter((k: any) => k !== key); }), key), false, `${source}: establishes without ${key}`);
    }
  }
  // Forged establishes on a cli-check: opencode's checks never established isolatedEdit, and a relabelled kind has no run.
  const cliCheck = '2026-11-07-cli-check.json';
  assert.equal(accepted(copy(cliCheck, 'cli.json', () => {}), 'readOnly'), true, 'an intact cli-check establishes readOnly');
  assert.equal(accepted(copy(cliCheck, 'forged.json', (r: any) => { r.establishes = [...r.establishes, 'isolatedEdit']; }), 'isolatedEdit'), false, 'forged establishes on a cli-check');
  assert.equal(accepted(copy(cliCheck, 'relabelled.json', (r: any) => { r.kind = 'live-run'; }), 'readOnly'), false, 'a cli-check relabelled live-run');
});

/** G41.4 / 120 IC-011: isolate codex and bind its seven capabilities to its latest free-check record. */
function scratchRecordRoot(t: any, mutate: any) {
  const root = tempDir(t, 'doflow-g414-');
  const registry = structuredClone(shipped().registry);
  const codex = registry.harnesses.find((h: any) => h.id === 'codex');
  registry.harnesses = [codex];
  const cited = codex.worker.model.evidence[0];
  for (const [key, entry] of Object.entries(codex.worker)) {
    if (!NOT_CAPABILITIES.has(key) && entry?.status === 'supported') entry.evidence = [cited];
  }
  const record = JSON.parse(fs.readFileSync(path.join(REPO, cited), 'utf8'));
  mutate(record);
  const dir = path.join(root, path.dirname(cited));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(root, cited), JSON.stringify(record));
  fs.copyFileSync(path.join(REPO, path.dirname(cited), 'checks.json'), path.join(dir, 'checks.json'));
  return { root, registry, cited };
}

test('G41.4 C control: the older codex record cannot establish model', () => {
  const registry = structuredClone(shipped().registry);
  const codex = registry.harnesses.find((h: any) => h.id === 'codex');
  codex.worker.model = {
    status: 'supported',
    argv: ['-m', '{model}'],
    evidence: ['core/worker-evidence/codex/2026-10-18-cli-check.json'],
    verification: 'control fixture',
    verifiedOn: '2026-10-24',
  };
  assert.deepEqual(establishingRecordFindings(registry, REPO), [
    "G41.4: harness 'codex' worker 'model': supported without a recorded evidence file that establishes it",
  ]);
});

test('G41.4 control: a record that no longer establishes structuredOutput gives exactly that one finding', (t) => {
  const { root, registry, cited } = scratchRecordRoot(t, (record: any) => {
    record.establishes = record.establishes.filter((key: any) => key !== 'structuredOutput');
  });
  assert.deepEqual(establishingRecordFindings(registry, root), [
    "G41.4: harness 'codex' worker 'structuredOutput': supported without a recorded evidence file that establishes it",
  ]);
  // The unmutated record satisfies the same entries, so the finding comes from the dropped key alone.
  fs.writeFileSync(path.join(root, cited), fs.readFileSync(path.join(REPO, cited)));
  assert.deepEqual(establishingRecordFindings(registry, root), []);
});

test('G41.4 control: a failing spawn-denial check with establishes kept withdraws spawnDenial and nothing else', (t) => {
  const { root, registry } = scratchRecordRoot(t, (record: any) => {
    const check = record.checks.find((c: any) => c.id === 'spawn-denial');
    Object.assign(check, { result: 'fail', exit: 1, matched: [] });
  });
  assert.deepEqual(establishingRecordFindings(registry, root), [
    "G41.4: harness 'codex' worker 'spawnDenial': supported without a recorded evidence file that establishes it",
  ]);
});

test('G41.4 control: a check with exit 0 but no matched lines, or exit 1 despite pass, establishes nothing', (t) => {
  const noMatch = scratchRecordRoot(t, (record: any) => { record.checks.find((c: any) => c.id === 'spawn-denial').matched = []; });
  assert.equal(establishingRecordFindings(noMatch.registry, noMatch.root).length, 1, 'empty matched');
  const badExit = scratchRecordRoot(t, (record: any) => { record.checks.find((c: any) => c.id === 'spawn-denial').exit = 1; });
  assert.equal(establishingRecordFindings(badExit.registry, badExit.root).length, 1, 'exit 1 with result pass');
});

test('G41.4 control: a hand-written record with no checks that claims every capability establishes none', (t) => {
  const { root, registry } = scratchRecordRoot(t, (record: any) => { record.checks = []; });
  assert.deepEqual(establishingRecordFindings(registry, root).map((f: any) => /worker '(\w+)'/.exec(f)![1]).sort(),
    ['isolatedEdit', 'model', 'oneShot', 'readOnly', 'runnableProbe', 'spawnDenial', 'structuredOutput']);
});

test('G41.4 control: a check altered against checks.json (argv, expect or establishes) breaks the record', (t) => {
  const alterations: any = {
    argv: (check: any) => { check.argv = ['exec', '--version']; },
    expect: (check: any) => { check.expect = ['.']; },
    establishes: (check: any) => { check.establishes = [...check.establishes, 'readOnly']; },
  };
  for (const [what, alter] of Object.entries(alterations)) {
    const { root, registry } = scratchRecordRoot(t, (record: any) => { alter(record.checks.find((c: any) => c.id === 'exec-sandbox')); });
    assert.ok(establishingRecordFindings(registry, root).length > 0, `an altered ${what} must be caught`);
  }
});

test('G41.4 control: a cli-check record with a run, or without a checks.json beside it, establishes nothing', (t) => {
  const withRun = scratchRecordRoot(t, (record: any) => { record.run = { resultOffered: true, report: { status: 'success' } }; });
  assert.equal(establishingRecordFindings(withRun.registry, withRun.root).length, 7, 'run must be null for a cli-check');
  const lonely = scratchRecordRoot(t, () => {});
  fs.rmSync(path.join(lonely.root, 'core', 'worker-evidence', 'codex', 'checks.json'));
  assert.equal(establishingRecordFindings(lonely.registry, lonely.root).length, 7, 'no checks.json');
});

test('G41.4 control: a live-run record whose result was not offered or whose run failed, a missing file and another harness\'s record do not count', (t) => {
  const root = tempDir(t, 'doflow-g414-');
  const registry = structuredClone(shipped().registry);
  const codex = registry.harnesses.find((h: any) => h.id === 'codex');
  registry.harnesses = [codex]; // scratch root holds codex records only; other harnesses' findings are not under test here
  const dir = path.join(root, 'core', 'worker-evidence', 'codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'core', 'worker-evidence', 'codex', 'checks.json'), path.join(dir, 'checks.json')); // the version pattern a record is checked against
  const shape = argvShape(codex.worker, '', false);
  const live = (name: any, extra: any) => {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({
      schema: EVIDENCE_SCHEMA, harness: 'codex', kind: 'live-run', cliVersion: 'codex-cli 0.0.0',
      establishes: ['oneShot'], checks: [], ...extra, run: { edit: false, argvShape: shape, readOnly: { status: 'clean' }, ...extra.run },
    }));
    return `core/worker-evidence/codex/${name}`;
  };
  codex.worker.oneShot.evidence = [live('2026-10-18-live-run.json', { run: { resultOffered: false, report: { status: 'success' } } })];
  const oneShot = () => establishingRecordFindings(registry, root).filter((f: any) => f.includes("'oneShot'"));
  assert.equal(oneShot().length, 1, 'resultOffered false does not establish');
  codex.worker.oneShot.evidence = [live('2026-10-18-live-run-c.json', { run: { resultOffered: true, report: { status: 'failure' } } })];
  assert.equal(oneShot().length, 1, 'a run whose report is not success does not establish');
  codex.worker.oneShot.evidence = [live('2026-10-18-live-run-b.json', { run: { resultOffered: true, report: { status: 'success' } } })];
  assert.deepEqual(oneShot(), [], 'a successful run with its result offered does');
  codex.worker.oneShot.evidence = ['core/worker-evidence/codex/2026-10-18-missing.json'];
  assert.equal(oneShot().length, 1, 'a missing file does not establish');
  codex.worker.oneShot.evidence = ['core/worker-evidence/antigravity/2026-10-18-cli-check.json'];
  assert.equal(oneShot().length, 1, 'another harness directory does not establish');
});

test('G41.4 control: the shipped live-run records count, and a copy of either with a failed report or an unoffered result does not', (t) => {
  const root = tempDir(t, 'doflow-g414-real-');
  const registry = structuredClone(shipped().registry);
  const codex = registry.harnesses.find((h: any) => h.id === 'codex');
  registry.harnesses = [codex]; // scratch root holds codex records only; other harnesses' findings are not under test here
  const dir = path.join(root, 'core', 'worker-evidence', 'codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'core', 'worker-evidence', 'codex', 'checks.json'), path.join(dir, 'checks.json')); // the version pattern a record is checked against
  const copy = (source: any, name: any, mutate: any) => {
    const record = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'worker-evidence', 'codex', source), 'utf8'));
    mutate(record);
    fs.writeFileSync(path.join(dir, name), JSON.stringify(record));
    return `core/worker-evidence/codex/${name}`;
  };
  const findingsFor = (key: any, evidence: any) => {
    codex.worker[key].evidence = evidence;
    return establishingRecordFindings(registry, root).filter((f: any) => f.includes(`'${key}'`));
  };
  const intact = (record: any) => record;
  for (const [source, key] of [['2026-10-18-live-run-read-only.json', 'readOnly'], ['2026-10-18-live-run-edit.json', 'isolatedEdit']]) {
    assert.equal(shipped().registry.harnesses.find((h: any) => h.id === 'codex').worker[key].evidence.includes(`core/worker-evidence/codex/${source}`), true, `${key} cites ${source}`);
    assert.deepEqual(findingsFor(key, [copy(source, `ok-${key}.json`, intact)]), [], `an intact copy establishes ${key}`);
    assert.equal(findingsFor(key, [copy(source, `failed-${key}.json`, (r: any) => { r.run.report.status = 'failure'; })]).length, 1, `status failure does not establish ${key}`);
    assert.equal(findingsFor(key, [copy(source, `unoffered-${key}.json`, (r: any) => { r.run.resultOffered = false; })]).length, 1, `resultOffered false does not establish ${key}`);
  }
});

test('G41.4 control: a live-run record whose argvShape contradicts the recipe it is cited for does not establish', (t) => {
  const root = tempDir(t, 'doflow-g414-shape-');
  const registry = structuredClone(shipped().registry);
  const codex = registry.harnesses.find((h: any) => h.id === 'codex');
  registry.harnesses = [codex]; // scratch root holds codex records only; other harnesses' findings are not under test here
  const dir = path.join(root, 'core', 'worker-evidence', 'codex');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(REPO, 'core', 'worker-evidence', 'codex', 'checks.json'), path.join(dir, 'checks.json')); // the version pattern a record is checked against
  const copy = (source: any, name: any, mutate: any) => {
    const record = JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'worker-evidence', 'codex', source), 'utf8'));
    mutate(record);
    fs.writeFileSync(path.join(dir, name), JSON.stringify(record));
    return `core/worker-evidence/codex/${name}`;
  };
  const findingsFor = (key: any, evidence: any) => {
    codex.worker[key].evidence = evidence;
    return establishingRecordFindings(registry, root).filter((f: any) => f.includes(`'${key}'`));
  };
  const source: any = { readOnly: '2026-10-18-live-run-read-only.json', isolatedEdit: '2026-10-18-live-run-edit.json' };
  for (const key of ['readOnly', 'isolatedEdit']) {
    const shapeOf: any = (name: any, mutate: any) => copy(source[key], name, (r: any) => mutate(r.run.argvShape, r));
    assert.deepEqual(findingsFor(key, [shapeOf(`ok-${key}.json`, () => {})]), [], `an intact copy establishes ${key}`);
    assert.equal(findingsFor(key, [shapeOf(`sandbox-${key}.json`, (shape: any) => { shape[2] = 'danger-full-access'; })]).length, 1, `a different sandbox does not establish ${key}`);
    assert.equal(findingsFor(key, [shapeOf(`extra-${key}.json`, (shape: any) => { shape.push('--extra'); })]).length, 1, `an extra element does not establish ${key}`);
    assert.equal(findingsFor(key, [shapeOf(`kind-${key}.json`, (shape: any, r: any) => { r.run.edit = key === 'readOnly'; })]).length, 1, `the other run kind does not establish ${key}`);
  }
});

test('G41.4 control: a hand-edited cliVersion that does not match the harness version pattern establishes nothing', (t) => {
  // 'x', a blank, another harness's version line and a non-string fail; the shipped line passes.
  for (const bad of ['x', '', 'opencode v2.2.5', 'codex-cli', 'v0.163.0', 7, null]) {
    const { root, registry } = scratchRecordRoot(t, (record: any) => { record.cliVersion = bad; });
    assert.equal(establishingRecordFindings(registry, root).length, 7, `cliVersion ${JSON.stringify(bad)} must withdraw all seven codex keys`);
  }
  const ok = scratchRecordRoot(t, (record: any) => { record.cliVersion = 'codex-cli 9.9.9'; });
  assert.equal(establishingRecordFindings(ok.registry, ok.root).length, 0, 'a well-formed version line is accepted (the pattern checks the shape, not the number)');
  // the same rule holds for a live-run record
  const { root, copy } = opencodeScratch(t);
  const opencode = structuredClone(shipped().registry.harnesses.find((h: any) => h.id === 'opencode'));
  for (const bad of ['x', 'opencode v9']) {
    opencode.worker.readOnly.evidence = [copy('2026-11-07-live-run-read-only.json', 'bad-version.json', (r: any) => { r.cliVersion = bad; })];
    assert.equal(establishingRecordFindings({ harnesses: [opencode] }, root).filter((f: any) => f.includes("'readOnly'")).length, 1, `live-run cliVersion ${bad}`);
  }
  opencode.worker.readOnly.evidence = [copy('2026-11-07-live-run-read-only.json', 'ok-version.json', () => {})];
  assert.deepEqual(establishingRecordFindings({ harnesses: [opencode] }, root).filter((f: any) => f.includes("'readOnly'")), []);
  // a missing or version-less checks.json leaves nothing to match against
  fs.rmSync(path.join(root, 'core', 'worker-evidence', 'opencode', 'checks.json'));
  assert.equal(establishingRecordFindings({ harnesses: [opencode] }, root).filter((f: any) => f.includes("'readOnly'")).length, 1);
});
