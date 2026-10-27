'use strict';
// verification-input.test.js — IC-022 / DEC-035: verified check inputs, truthful linked successor,
// and honest chronology for verification compilation and execution.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { suiteTempDir } = require('../helper/tmp.ts');
const { createScratch } = require('../helper/scratch-env.ts');
const { VerificationEngine, validateVerificationInput } = require('../../src/runtime/verification/engine.ts');

const scratch = createScratch('doflow-vinput-env-');
scratch.apply();
after(() => {
  scratch.restore();
  scratch.remove();
});

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const SLUG = '063-verify-test';

const PLAN = [
  '# Plan',
  '',
  '- [ ] A.1 Code task — owner: core-implementer; files: src/app.js, package.json',
  '',
].join('\n');

function git(cwd: any, ...args: any[]) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

function makeRepo() {
  const root = suiteTempDir('doflow-verification-input-');
  git(root, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'test-app', scripts: { test: 'node -e "process.exit(0)"' } }, null, 2) + '\n');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'app.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, '.gitignore'), '*.json\n.npm/\n');

  const dir = path.join(root, 'agent-docs', 'doflow', SLUG);
  fs.mkdirSync(path.join(dir, 'intention'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'intention', 'requirement.md'), '# req\n');
  fs.writeFileSync(path.join(dir, 'plan.md'), PLAN);
  fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'decisions', 'register.json'), '{"version":1,"slug":"x","nextId":1,"decisions":[]}\n');

  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial');
  git(root, 'checkout', '-q', '-b', `feat/${SLUG}`);
  return root;
}

function writeJson(filePath: any, data: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function digestOf(filePath: any) {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

test('validateVerificationInput rejects non-existent, unreadable or non-JSON manifests', () => {
  const root = makeRepo();
  const missing = validateVerificationInput({ cwd: root, verificationInput: 'nonexistent.json' });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /could not be read/);

  const notJsonPath = path.join(root, 'bad.json');
  fs.writeFileSync(notJsonPath, 'not json at all');
  const notJson = validateVerificationInput({ cwd: root, verificationInput: notJsonPath });
  assert.equal(notJson.ok, false);
  assert.match(notJson.message, /is not valid JSON/);

  const arrayPath = path.join(root, 'array.json');
  fs.writeFileSync(arrayPath, '[]');
  const arrayVal = validateVerificationInput({ cwd: root, verificationInput: arrayPath });
  assert.equal(arrayVal.ok, false);
  assert.match(arrayVal.message, /must be a JSON object/);
});

test('validateVerificationInput rejects unknown top-level keys', () => {
  const root = makeRepo();
  const file = path.join(root, 'extra.json');
  writeJson(file, { structuralChecks: [], extraKey: 'forbidden' });
  const res = validateVerificationInput({ cwd: root, verificationInput: file });
  assert.equal(res.ok, false);
  assert.match(res.message, /contains unknown field 'extraKey'/);
});

test('validateVerificationInput validates originalContractPath and digest co-dependence and match', () => {
  const root = makeRepo();
  const origFile = path.join(root, 'orig.json');
  writeJson(origFile, { contract: true });
  const origDigest = digestOf(origFile);

  const onlyPath = path.join(root, 'only-path.json');
  writeJson(onlyPath, { originalContractPath: origFile });
  assert.equal(validateVerificationInput({ cwd: root, verificationInput: onlyPath }).ok, false);

  const onlyDigest = path.join(root, 'only-digest.json');
  writeJson(onlyDigest, { originalContractDigest: origDigest });
  assert.equal(validateVerificationInput({ cwd: root, verificationInput: onlyDigest }).ok, false);

  const badDigest = path.join(root, 'bad-digest.json');
  writeJson(badDigest, {
    originalContractPath: origFile,
    originalContractDigest: 'sha256:' + '0'.repeat(64),
  });
  const resBad = validateVerificationInput({ cwd: root, verificationInput: badDigest });
  assert.equal(resBad.ok, false);
  assert.match(resBad.message, /originalContractDigest mismatch/);

  const good = path.join(root, 'good-orig.json');
  writeJson(good, {
    originalContractPath: origFile,
    originalContractDigest: origDigest,
  });
  const resGood = validateVerificationInput({ cwd: root, verificationInput: good });
  assert.equal(resGood.ok, true);
  assert.equal(resGood.provenance.originalContractPath, origFile);
  assert.equal(resGood.provenance.originalContractDigest, origDigest);
});

test('validateVerificationInput rejects malformed structuralChecks and requirements', () => {
  const root = makeRepo();

  // Duplicate structural check name
  const dupStruct = path.join(root, 'dup-struct.json');
  writeJson(dupStruct, {
    structuralChecks: [
      { name: 'chk1', command: 'true' },
      { name: 'chk1', command: 'true' },
    ],
  });
  const resDupStruct = validateVerificationInput({ cwd: root, verificationInput: dupStruct });
  assert.equal(resDupStruct.ok, false);
  assert.match(resDupStruct.message, /duplicate structural check name 'chk1'/);

  // Empty structural command
  const emptyCmd = path.join(root, 'empty-cmd.json');
  writeJson(emptyCmd, {
    structuralChecks: [{ name: 'chk1', command: '   ' }],
  });
  assert.equal(validateVerificationInput({ cwd: root, verificationInput: emptyCmd }).ok, false);

  // Invalid timeoutMs
  const badTimeout = path.join(root, 'bad-timeout.json');
  writeJson(badTimeout, {
    structuralChecks: [{ name: 'chk1', command: 'true', timeoutMs: -50 }],
  });
  assert.equal(validateVerificationInput({ cwd: root, verificationInput: badTimeout }).ok, false);

  // Duplicate requirement id
  const dupReq = path.join(root, 'dup-req.json');
  writeJson(dupReq, {
    requirements: [
      { id: 'FR-001', command: 'true' },
      { id: 'FR-001', command: 'true' },
    ],
  });
  const resDupReq = validateVerificationInput({ cwd: root, verificationInput: dupReq });
  assert.equal(resDupReq.ok, false);
  assert.match(resDupReq.message, /duplicate requirement id 'FR-001'/);
});

test('CLI verify refuses malformed verification input and invalid phases with usage error', () => {
  const root = makeRepo();
  const resInput = spawnSync('node', [DOFLOW, 'verify', '--task-id', 'A.1', '--verification-input', 'nonexistent.json'], {
    cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8',
  });
  assert.equal(resInput.status, 2);
  assert.match(resInput.stderr, /could not be read/);

  const resPhase = spawnSync('node', [DOFLOW, 'verify', '--task-id', 'A.1', '--verification-phase', 'invalid_phase'], {
    cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8',
  });
  assert.equal(resPhase.status, 2);
  assert.match(resPhase.stderr, /unknown --verification-phase/);
});

test('valid execution runs structural checks and requirements and preserves immutable linked original', () => {
  const root = makeRepo();
  const origFile = path.join(root, 'orig-contract.json');
  writeJson(origFile, { original: 'data', timestamp: 123456 });
  const origDigest = digestOf(origFile);
  const origContentBefore = fs.readFileSync(origFile, 'utf8');

  const manifestPath = path.join(root, 'manifest.json');
  writeJson(manifestPath, {
    structuralChecks: [
      { name: 'guards', command: 'node -e "process.exit(0)"', timeoutMs: 10000 },
    ],
    requirements: [
      { id: 'FR-001', description: 'feature on', command: 'node -e "process.exit(0)"' },
      { id: 'FR-002', description: 'override', command: 'node -e "process.exit(0)"' },
    ],
    originalContractPath: origFile,
    originalContractDigest: origDigest,
  });

  const res = spawnSync('node', [
    DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'HIGH',
    '--verification-input', manifestPath,
    '--verification-phase', 'postimplementation',
    '--json',
  ], {
    cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8',
  });

  assert.equal(res.status, 0, res.stderr);
  const report = JSON.parse(res.stdout);
  assert.equal(report.status, 'PASS');

  // Verify tiers passed
  const structTier = report.tiers.find((t: any) => t.id === 'structural-invariants');
  assert.equal(structTier.status, 'PASS');
  assert.equal(structTier.checks.length, 1);

  const reqTier = report.tiers.find((t: any) => t.id === 'requirement-satisfaction');
  assert.equal(reqTier.status, 'PASS');
  assert.equal(reqTier.checks.length, 2);

  // Provenance and chronology
  assert.equal(report.contract.phase, 'postimplementation');
  assert.equal(report.contract.compiledBeforeImplementation, false);
  assert.equal(report.contract.provenance.manifestPath, manifestPath);
  assert.equal(report.contract.provenance.manifestDigest, digestOf(manifestPath));
  assert.equal(report.contract.provenance.originalContractPath, origFile);
  assert.equal(report.contract.provenance.originalContractDigest, origDigest);

  // Original contract is byte-identical
  const origContentAfter = fs.readFileSync(origFile, 'utf8');
  assert.equal(origContentAfter, origContentBefore);
});

test('missing or failed structural checks or requirements leave tiers unresolved or fail', () => {
  const root = makeRepo();

  // Missing structural checks at HIGH risk -> UNRESOLVED structural-invariants -> INCONCLUSIVE
  const noStruct = path.join(root, 'no-struct.json');
  writeJson(noStruct, {
    requirements: [{ id: 'FR-001', command: 'true' }],
  });
  const resNoStruct = spawnSync('node', [
    DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'HIGH',
    '--verification-input', noStruct, '--json',
  ], { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
  assert.equal(resNoStruct.status, 1);
  const repNoStruct = JSON.parse(resNoStruct.stdout);
  assert.equal(repNoStruct.status, 'INCONCLUSIVE');
  const stTier = repNoStruct.tiers.find((t: any) => t.id === 'structural-invariants');
  assert.equal(stTier.status, 'UNRESOLVED');

  // Failing requirement check -> FAIL
  const failReq = path.join(root, 'fail-req.json');
  writeJson(failReq, {
    structuralChecks: [{ name: 'st', command: 'true' }],
    requirements: [{ id: 'FR-001', command: 'node -e "process.exit(1)"' }],
  });
  const resFailReq = spawnSync('node', [
    DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'HIGH',
    '--verification-input', failReq, '--json',
  ], { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
  assert.equal(resFailReq.status, 1);
  const repFailReq = JSON.parse(resFailReq.stdout);
  assert.equal(repFailReq.status, 'FAIL');

  // Requirement with description but no command -> unevaluated -> UNRESOLVED -> INCONCLUSIVE
  const unverifiedReq = path.join(root, 'unverified-req.json');
  writeJson(unverifiedReq, {
    structuralChecks: [{ name: 'st', command: 'true' }],
    requirements: [
      { id: 'FR-001', command: 'true' },
      { id: 'FR-002', description: 'no executable command supplied' },
    ],
  });
  const resUnverified = spawnSync('node', [
    DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'HIGH',
    '--verification-input', unverifiedReq, '--json',
  ], { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
  assert.equal(resUnverified.status, 1);
  const repUnverified = JSON.parse(resUnverified.stdout);
  assert.equal(repUnverified.status, 'INCONCLUSIVE');
  const reqTier = repUnverified.tiers.find((t: any) => t.id === 'requirement-satisfaction');
  assert.equal(reqTier.status, 'UNRESOLVED');
  assert.ok(reqTier.unevaluatedRequirements.some((r: any) => r.id === 'FR-002'));
});

test('unknown chronology defaults to compiledBeforeImplementation: null', () => {
  const root = makeRepo();
  const manifest = path.join(root, 'manifest.json');
  writeJson(manifest, {
    structuralChecks: [{ name: 'st', command: 'true' }],
    requirements: [{ id: 'FR-001', command: 'true' }],
  });

  const res = spawnSync('node', [
    DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'HIGH',
    '--verification-input', manifest, '--action', 'contract', '--json',
  ], { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
  assert.equal(res.status, 0);
  const contract = JSON.parse(res.stdout);
  assert.equal(contract.phase, 'unknown');
  assert.equal(contract.compiledBeforeImplementation, null);
});

test('advisory model review cannot establish PASS on missing deterministic tiers', () => {
  const root = makeRepo();
  const engine: any = new VerificationEngine({ cwd: root, repoRoot: REPO });

  // Compile contract at HIGH risk with no structural or requirement checks
  const contract = engine.compileContract({
    taskId: 'A.1',
    riskLevel: 'HIGH',
    scope: { allowedPaths: ['src/app.js'] },
  });

  // Supply modelReview saying PASS
  const report = engine.runContract(contract, {
    modelReview: { status: 'PASS', reviewer: 'external-model' },
  });

  // Overall status MUST NOT be PASS
  assert.notEqual(report.status, 'PASS');
  assert.equal(report.status, 'INCONCLUSIVE');
  assert.equal(report.modelReview.primaryProof, false);
});
