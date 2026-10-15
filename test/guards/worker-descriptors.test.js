'use strict';

// G41 — worker descriptors (081 IC-031, DEC-013). Three checks, each a pure function over an
// injected registry, run once on the shipped tree and once on an in-memory copy seeded with one
// violation per check.
//
//   G41.1 every harness carries a `worker` block and the registry validator reports no error
//         containing " worker '" (validateWorker's message prefix, IC-001)
//   G41.2 every `supported` worker entry has evidence naming a repository path that exists or an
//         https:// URL
//   G41.3 every declared `structuredOutput.parser` is a key of PARSERS (checked here, beside the
//         parser table, because validateWorker deliberately does not require a runtime module)
//
// validateWorker() (src/registry/index.ts) checks shape; this guard checks meaning.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const registryModule = require('../../src/registry/index.ts');
const { PARSERS } = require('../../src/runtime/worker/parsers.ts');

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
