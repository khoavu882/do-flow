'use strict';

// G67 — primary harness, worker catalogue, model bindings and probe consistency (feature 120, design C12, D9).
//
// Asserts structural and registry truths across primary and worker subsystems:
//   (1) Every harness id in core/registry/harnesses.json passes workerIdFault, and exactly one
//       qualified-id definition exists across src/ (RK4).
//   (2) The closed list of workerGate call sites: only sanctioned gate locations under src/ invoke workerGate.
//   (3) active.ts, models.ts and context/primary.ts import no advice/ module (clean decoupling).
//   (4) Every model-id and worker-models key in core/registry/settings.json defaults to null.
//   (5) primaryProbe.model is 'payload' exactly where envelope.jq emits identity.model, and the
//       jq and TypeScript model grammars agree on a comprehensive fixture list (RK7).
//
// Controls: scratch copies with an extra workerGate bypass, an advice/ import, a vendor default,
// or a mismatched primaryProbe each turns it red; the shipped tree is green.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const { workerIdFault } = require(path.join(REPO, 'src', 'registry', 'worker-ids.ts'));
const { validateValue } = require(path.join(REPO, 'src', 'runtime', 'settings', 'files.ts'));

const HARNESSES_FILE = path.join(REPO, 'core', 'registry', 'harnesses.json');
const SETTINGS_FILE = path.join(REPO, 'core', 'registry', 'settings.json');
const ENVELOPE_JQ_FILE = path.join(REPO, 'core', 'harnesses', 'shared', 'hooks', 'bridge', 'envelope.jq');

const harnesses = JSON.parse(fs.readFileSync(HARNESSES_FILE, 'utf8'));
const settings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
const envelopeJq = fs.readFileSync(ENVELOPE_JQ_FILE, 'utf8');

function walkFiles(dir: string, filter: (name: string) => boolean = () => true): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(full, filter));
    } else if (filter(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** (1) Checks every harness id and counts qualified id definitions across a directory. */
function checkHarnessIdsAndQualifiedDefs(harnessList: any[], rootDir: string): string[] {
  const offenders: string[] = [];
  for (const h of harnessList) {
    const fault = workerIdFault(h.id);
    if (fault !== null) {
      offenders.push(`harness '${h.id}' failed workerIdFault: ${fault.reason}`);
    }
  }
  const files = walkFiles(path.join(rootDir, 'src'), (f) => /\.(ts|js)$/.test(f));
  let qualifiedDefs = 0;
  for (const file of files) {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const matches = text.match(/\bfunction\s+isQualifiedId\s*\(/g);
    if (matches) qualifiedDefs += matches.length;
  }
  if (qualifiedDefs !== 1) {
    offenders.push(`expected exactly 1 isQualifiedId definition, found ${qualifiedDefs}`);
  }
  return offenders;
}

/** Expected relative paths of files in src/ that call workerGate. */
const SANCTIONED_WORKERGATE_CALLERS = Object.freeze([
  'src/runtime/dispatch/command.ts',
  'src/runtime/dispatch/loop.ts',
  'src/runtime/worker/command.ts',
  'src/runtime/worker/readiness.ts',
]);

/** (2) Returns unexpected files calling workerGate or missing expected callers. */
function checkWorkerGateCallSites(rootDir: string, sanctionedList: readonly string[] = SANCTIONED_WORKERGATE_CALLERS): string[] {
  const offenders: string[] = [];
  const files = walkFiles(path.join(rootDir, 'src'), (f) => /\.(ts|js)$/.test(f));
  const callers = new Set<string>();

  for (const file of files) {
    const rel = path.relative(rootDir, file).split(path.sep).join('/');
    // Skip the definition module itself
    if (rel === 'src/runtime/worker/active.ts') continue;
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    // Match actual invocations of workerGate(...)
    if (/\bworkerGate\s*\(/.test(text)) {
      callers.add(rel);
    }
  }

  for (const caller of callers) {
    if (!sanctionedList.includes(caller)) {
      offenders.push(`unexpected workerGate call site in ${caller}`);
    }
  }
  for (const expected of sanctionedList) {
    if (!callers.has(expected)) {
      offenders.push(`missing expected workerGate call site in ${expected}`);
    }
  }
  return offenders;
}

/** (3) Checks that active.ts, models.ts and context/primary.ts import no advice/ module. */
const DECOUPLED_MODULES = Object.freeze([
  'src/runtime/worker/active.ts',
  'src/runtime/worker/models.ts',
  'src/runtime/context/primary.ts',
]);

function checkAdviceImports(rootDir: string, modules: readonly string[] = DECOUPLED_MODULES): string[] {
  const offenders: string[] = [];
  const adviceImportRe = /(?:require\s*\(|import\s+[^;]*?\bfrom\s+|import\s*\()\s*['"][^'"]*advice\/[^'"]*['"]/;
  for (const mod of modules) {
    const file = path.join(rootDir, mod);
    if (!fs.existsSync(file)) {
      offenders.push(`module not found: ${mod}`);
      continue;
    }
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    if (adviceImportRe.test(text)) {
      offenders.push(`${mod} imports advice module`);
    }
  }
  return offenders;
}

/** (4) Checks that every model-id and worker-models key defaults to null. */
function checkModelKeyDefaults(settingsDoc: any): string[] {
  const offenders: string[] = [];
  const keys = settingsDoc.keys || settingsDoc;
  for (const [key, spec] of Object.entries<any>(keys)) {
    if (spec.type === 'model-id' || spec.type === 'worker-models') {
      if (spec.default !== null) {
        offenders.push(`key '${key}' of type '${spec.type}' must default to null, got '${spec.default}'`);
      }
    }
  }
  return offenders;
}

/** (5a) Checks primaryProbe.model in harnesses.json agrees with envelope.jq decoder model emission. */
function checkPrimaryProbeModelAgreement(harnessesDoc: any, jqText: string): string[] {
  const offenders: string[] = [];
  // Find all decode_<harness> definitions in envelope.jq that call model_identity
  const jqModelDecoders = new Set<string>();
  const decoderBlocks = jqText.matchAll(/def\s+decode_([a-z0-9_-]+):([\s\S]*?)(?=def\s+decode_|\n#|\ndef\s+[a-z_])/g);
  for (const m of decoderBlocks) {
    const harness = m[1];
    const body = m[2];
    if (body.includes('model_identity(')) {
      jqModelDecoders.add(harness);
    }
  }

  for (const h of harnessesDoc.harnesses || []) {
    const hasPayloadProbe = h.primaryProbe?.model === 'payload';
    const jqEmitsModel = jqModelDecoders.has(h.id);
    if (hasPayloadProbe && !jqEmitsModel) {
      offenders.push(`harness '${h.id}' declares primaryProbe.model 'payload' but envelope.jq decoder does not emit model`);
    } else if (!hasPayloadProbe && jqEmitsModel) {
      offenders.push(`harness '${h.id}' envelope.jq decoder emits model but primaryProbe.model is '${h.primaryProbe?.model}'`);
    }
  }
  return offenders;
}

// Comprehensive model grammar fixtures (valid and invalid)
const MODEL_FIXTURES: readonly string[] = Object.freeze([
  // Valid model identifiers
  'claude-3-7-sonnet',
  'gpt-4o',
  'gemini-2.5-pro',
  'o3-mini',
  'model.with.dots',
  'model_with_underscores',
  'vendor/model:tag',
  'model@version',
  'model(flavor)',
  'model[variant]',
  'model#rev',
  'model+test',
  'model-with-dashes',
  'model with spaces',
  'a',
  '1',
  'A'.repeat(120),
  // Invalid model identifiers
  '',
  ' ',
  '   ',
  '-leading-dash',
  '.leading-dot',
  '/leading-slash',
  'trailing-space ',
  'model\nnewline',
  'model\ttab',
  'model$dollar',
  'model%percent',
  'model^caret',
  'model*asterisk',
  'model?question',
  'model!bang',
  'model~tilde',
  'model`backtick',
  'model"quote',
  "model'singlequote",
  'A'.repeat(121),
  ' leading-space',
]);

/** (5b) Evaluates model validity via jq's valid_model_id definition in envelope.jq. */
function evaluateJqModelValidity(validModelIdDef: string, fixture: string): boolean {
  const result = spawnSync('jq', ['-n', '--arg', 'v', fixture, `${validModelIdDef} valid_model_id($v)`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`jq evaluation failed for fixture '${fixture}': ${result.stderr}`);
  }
  return result.stdout.trim() === 'true';
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests: Shipped Tree Verification
// ─────────────────────────────────────────────────────────────────────────────

test('G67.1: every harness id passes workerIdFault and exactly one isQualifiedId definition exists (RK4)', () => {
  const offenders = checkHarnessIdsAndQualifiedDefs(harnesses.harnesses, REPO);
  assert.deepEqual(offenders, []);
});

test('G67.2: closed list of workerGate call sites is respected across src/', () => {
  const offenders = checkWorkerGateCallSites(REPO);
  assert.deepEqual(offenders, []);
});

test('G67.3: active.ts, models.ts and context/primary.ts import no advice/ module', () => {
  const offenders = checkAdviceImports(REPO);
  assert.deepEqual(offenders, []);
});

test('G67.4: every model-id and worker-models key in settings.json defaults to null', () => {
  const offenders = checkModelKeyDefaults(settings);
  assert.deepEqual(offenders, []);
});

test('G67.5: primaryProbe.model is payload exactly where envelope.jq emits identity.model, and grammars agree (RK7)', () => {
  const agreementOffenders = checkPrimaryProbeModelAgreement(harnesses, envelopeJq);
  assert.deepEqual(agreementOffenders, []);

  // Extract valid_model_id definition from envelope.jq
  const match = envelopeJq.match(/def\s+valid_model_id\(\$v\):[\s\S]*?;/);
  assert.ok(match, 'envelope.jq must define valid_model_id($v)');
  const validModelIdDef = match[0];

  for (const fixture of MODEL_FIXTURES) {
    const tsValid = validateValue({ type: 'model-id' }, fixture) === null;
    const jqValid = evaluateJqModelValidity(validModelIdDef, fixture);
    assert.equal(tsValid, jqValid, `TS and jq model grammars must agree on fixture '${fixture}'`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Negative Controls
// ─────────────────────────────────────────────────────────────────────────────

test('G67 controls: an extra workerGate bypass turns the guard red', () => {
  const scratchRoot = suiteTempDir('doflow-g67-bypass-');
  const bypassFile = path.join(scratchRoot, 'src', 'runtime', 'worker', 'unauthorized.ts');
  fs.mkdirSync(path.dirname(bypassFile), { recursive: true });
  fs.writeFileSync(bypassFile, 'const gate = workerGate(active, id);\n');

  // Copy real sanctioned callers into scratchRoot
  for (const sanctioned of SANCTIONED_WORKERGATE_CALLERS) {
    const dest = path.join(scratchRoot, sanctioned);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, sanctioned), dest);
  }

  const offenders = checkWorkerGateCallSites(scratchRoot);
  assert.ok(offenders.some((o) => o.includes('unexpected workerGate call site in src/runtime/worker/unauthorized.ts')));
});

test('G67 controls: an advice import turns the guard red', () => {
  const scratchRoot = suiteTempDir('doflow-g67-advice-');
  for (const mod of DECOUPLED_MODULES) {
    const dest = path.join(scratchRoot, mod);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(REPO, mod), dest);
  }
  // Plant advice import into active.ts
  const activePath = path.join(scratchRoot, 'src', 'runtime', 'worker', 'active.ts');
  fs.appendFileSync(activePath, "\nconst { adviceSeam } = require('../advice/seam.ts');\n");

  const offenders = checkAdviceImports(scratchRoot);
  assert.ok(offenders.some((o) => o.includes('src/runtime/worker/active.ts imports advice module')));
});

test('G67 controls: a vendor default for model keys turns the guard red', () => {
  const mutatedSettings = JSON.parse(JSON.stringify(settings));
  mutatedSettings.keys['primary.model'].default = 'claude-3-7-sonnet';

  const offenders = checkModelKeyDefaults(mutatedSettings);
  assert.ok(offenders.some((o) => o.includes("key 'primary.model' of type 'model-id' must default to null")));
});

test('G67 controls: a mismatched primaryProbe turns the guard red', () => {
  const mutatedHarnesses = JSON.parse(JSON.stringify(harnesses));
  const claudeEntry = mutatedHarnesses.harnesses.find((h: any) => h.id === 'claude');
  claudeEntry.primaryProbe.model = 'none';

  const offenders = checkPrimaryProbeModelAgreement(mutatedHarnesses, envelopeJq);
  assert.ok(offenders.some((o) => o.includes("harness 'claude' envelope.jq decoder emits model but primaryProbe.model is 'none'")));
});
