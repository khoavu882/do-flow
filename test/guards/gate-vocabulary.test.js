'use strict';

// G55 — gate vocabulary (feature 108, FR-004, FR-008, NFR-003).
//
// Three things must stay equal, so the closed deny-reason list cannot drift from what runs:
//   1. The gate ids of core/registry/gates.json equal those of core/registry/workflows.json, per class.
//   2. Every reason code emitted by src/runtime/roadmap/** and by the decide-gate path
//      (decideGateByPolicy in src/runtime/workflow-orchestrator.ts) is in gates.json `denyReasons`.
//      A `:<x>` suffix is a parameter, not a new reason (design section 4). Row outcomes that are
//      not denies (blocked: budget|stuck, paused: quota, cleanup status) are named in ROW_OUTCOMES.
//   3. Every `denyReasons` entry appears in a test expectation. An entry no test mentions is a
//      finding; ALLOWED_GAPS lists such entries explicitly and may only shrink (an entry that a test
//      now mentions, or that is no longer in denyReasons, is itself a finding).
//
// Extraction is static and reads only reason sites (`reason:`, `reasons: [..]`, `reasons.push(..)`,
// `deny(..)`, `requireFact(.., ..)`, the ternary behind `const failure`, and `error.code ===` in the
// decide-gate path), never every string, so a source name or a skip code is not mistaken for a reason.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp');

const ROADMAP_DIR = 'src/runtime/roadmap';
const ORCHESTRATOR = 'src/runtime/workflow-orchestrator.ts';
const DECIDE_METHOD = 'decideGateByPolicy';
const GATES = 'core/registry/gates.json';
const WORKFLOWS = 'core/registry/workflows.json';
const SELF = 'test/guards/gate-vocabulary.test.js';
const EXTRA_EXPECTATIONS = ['test/fixtures/roadmap/g-l1/expected.json'];

/** Design section 4 "Row outcomes (not denies)": emitted as reasons, deliberately outside denyReasons. */
const ROW_OUTCOMES = new Set(['budget', 'stuck', 'quota', 'cleanup-kept']);

/** denyReasons entries no test expectation mentions. Empty today; it may only shrink. */
const ALLOWED_GAPS = [];

const REASON_SHAPE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/**
 * Splits source into `code` (comments blanked, strings intact) and `skeleton` (comments and string
 * contents blanked, quotes kept), both the length of the input so offsets line up.
 */
function scan(text) {
  const code = text.split('');
  const skeleton = text.split('');
  const length = text.length;
  let i = 0;
  const blank = (array, from, to) => { for (let k = from; k < to; k += 1) if (array[k] !== '\n') array[k] = ' '; };
  function readString(quote) {
    const start = i;
    i += 1;
    while (i < length && text[i] !== quote) { if (text[i] === '\\') i += 1; i += 1; }
    blank(skeleton, start + 1, i);
    i += 1;
  }
  function readTemplate() {
    i += 1;
    let contentStart = i;
    while (i < length && text[i] !== '`') {
      if (text[i] === '\\') { i += 2; continue; }
      if (text[i] === '$' && text[i + 1] === '{') {
        blank(skeleton, contentStart, i);
        i += 2;
        readCode(true);
        contentStart = i;
        continue;
      }
      i += 1;
    }
    blank(skeleton, contentStart, i);
    i += 1;
  }
  const regexAllowed = (before) => before === null || '(,=:[!&|?{};+-*%<>~^'.includes(before);
  function readCode(inExpression) {
    let depth = 0;
    let previous = null;
    while (i < length) {
      const c = text[i];
      if (c === '/' && text[i + 1] === '/') {
        const start = i;
        while (i < length && text[i] !== '\n') i += 1;
        blank(code, start, i); blank(skeleton, start, i);
        continue;
      }
      if (c === '/' && text[i + 1] === '*') {
        const start = i;
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? length : end + 2;
        blank(code, start, i); blank(skeleton, start, i);
        continue;
      }
      if (c === '/' && regexAllowed(previous)) {
        const start = i;
        let inClass = false;
        i += 1;
        while (i < length && (text[i] !== '/' || inClass) && text[i] !== '\n') {
          if (text[i] === '\\') i += 1;
          else if (text[i] === '[') inClass = true;
          else if (text[i] === ']') inClass = false;
          i += 1;
        }
        i += 1;
        blank(skeleton, start + 1, i - 1);
        previous = ')';
        continue;
      }
      if (c === "'" || c === '"') { readString(c); previous = ')'; continue; }
      if (c === '`') { readTemplate(); previous = ')'; continue; }
      if (!/\s/.test(c)) previous = c;
      if (inExpression && c === '{') depth += 1;
      if (inExpression && c === '}') { if (depth === 0) { i += 1; return; } depth -= 1; }
      i += 1;
    }
  }
  readCode(false);
  return { code: code.join(''), skeleton: skeleton.join('') };
}

/** The body of `name(...) { ... }` (its definition, not a call), or null. */
function methodBody(text, name) {
  const { code, skeleton } = scan(text);
  const definition = new RegExp(`(?:^|\\n)[ \\t]*${name}\\([^)]*\\)\\s*\\{`).exec(skeleton);
  if (!definition) return null;
  const open = definition.index + definition[0].length - 1;
  let depth = 0;
  for (let k = open; k < skeleton.length; k += 1) {
    if (skeleton[k] === '{') depth += 1;
    else if (skeleton[k] === '}') { depth -= 1; if (depth === 0) return code.slice(open, k + 1); }
  }
  return null;
}

const LITERAL = String.raw`(?:'([^'\\\n]*)'|"([^"\\\n]*)"|\`([^\`\\]*))`;
const literalOf = (match, from) => match.slice(from, from + 3).find((part) => part !== undefined);

/** Reason codes at the reason sites of one source text (the part before `:` or `${` of each literal). */
function reasonsIn(text, { errorCode = false } = {}) {
  const { code } = scan(text);
  const found = new Set();
  const add = (raw) => {
    if (raw === undefined) return;
    const id = raw.split(':')[0].split('${')[0];
    if (REASON_SHAPE.test(id)) found.add(id);
  };
  for (const m of code.matchAll(new RegExp(String.raw`\breason\s*:\s*${LITERAL}`, 'g'))) add(literalOf(m, 1));
  for (const m of code.matchAll(new RegExp(String.raw`\breasons\s*:\s*\[\s*${LITERAL}`, 'g'))) add(literalOf(m, 1));
  for (const m of code.matchAll(new RegExp(String.raw`\breasons\.push\(\s*${LITERAL}`, 'g'))) add(literalOf(m, 1));
  for (const m of code.matchAll(new RegExp(String.raw`\b(?:deny|denied)\(\s*${LITERAL}`, 'g'))) add(literalOf(m, 1));
  for (const m of code.matchAll(new RegExp(String.raw`\brequireFact\([^,()]*,\s*${LITERAL}`, 'g'))) add(literalOf(m, 1));
  for (const statement of code.matchAll(/\bconst failure\s*=\s*([^;]+);/g)) {
    for (const m of statement[1].matchAll(new RegExp(String.raw`\?\s*${LITERAL}\s*:\s*${LITERAL}`, 'g'))) { add(literalOf(m, 1)); add(literalOf(m, 4)); }
  }
  if (errorCode) for (const m of code.matchAll(new RegExp(String.raw`\berror\.code\s*===\s*${LITERAL}`, 'g'))) add(literalOf(m, 1));
  return found;
}

function readJson(root, rel, findings) {
  try { return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8')); } catch (error) { findings.push(`cannot read ${rel}: ${error.message}`); return null; }
}

function walk(dir, accept, found = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, found); else if (accept(full)) found.push(full);
  }
  return found;
}

/**
 * Reads the vocabulary inputs from `target` (a repo root, default this repo) and applies the three
 * rules. Any input can be replaced with an in-memory value for the controls:
 *   gates, workflows (parsed JSON), emitters (Map rel -> text), orchestrator (text),
 *   expectations (Map rel -> text), allowedGaps (array).
 */
function checkGateVocabulary(target = REPO) {
  const options = typeof target === 'string' ? { root: target } : target;
  const root = options.root || REPO;
  const findings = [];
  const gates = options.gates || readJson(root, GATES, findings);
  const workflows = options.workflows || readJson(root, WORKFLOWS, findings);
  const emitters = options.emitters || new Map(walk(path.join(root, ROADMAP_DIR), (f) => /\.(ts|js)$/.test(f))
    .map((f) => [path.relative(root, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf8')]));
  let orchestrator = options.orchestrator;
  if (orchestrator === undefined) {
    try { orchestrator = fs.readFileSync(path.join(root, ORCHESTRATOR), 'utf8'); } catch { orchestrator = null; }
  }
  const expectations = options.expectations || new Map([
    ...walk(path.join(root, 'test'), (f) => f.endsWith('.test.js')).map((f) => path.relative(root, f).split(path.sep).join('/')),
    ...EXTRA_EXPECTATIONS,
  ].filter((rel) => rel !== SELF).map((rel) => { try { return [rel, fs.readFileSync(path.join(root, rel), 'utf8')]; } catch { return [rel, '']; } }));
  const allowedGaps = options.allowedGaps || ALLOWED_GAPS;
  if (!gates || !workflows) return { findings, emitted: new Map(), gaps: [] };

  // 1. gate ids per class
  const policyClasses = gates.classes || {};
  const workflowClasses = workflows.classes || {};
  for (const cls of new Set([...Object.keys(policyClasses), ...Object.keys(workflowClasses)])) {
    if (!(cls in policyClasses)) { findings.push(`class '${cls}' is in workflows.json but not in gates.json`); continue; }
    if (!(cls in workflowClasses)) { findings.push(`class '${cls}' is in gates.json but not in workflows.json`); continue; }
    const fromPolicy = Object.keys(policyClasses[cls]).sort();
    const fromWorkflow = (workflowClasses[cls].gates || []).map((gate) => gate.id).sort();
    if (JSON.stringify(fromPolicy) !== JSON.stringify(fromWorkflow)) {
      findings.push(`gate ids differ for class '${cls}': gates.json [${fromPolicy}] workflows.json [${fromWorkflow}]`);
    }
  }

  // 2. emitted reasons are listed
  const listed = new Set(gates.denyReasons || []);
  for (const outcome of ROW_OUTCOMES) if (listed.has(outcome)) findings.push(`'${outcome}' is a row outcome and must not be in denyReasons`);
  const emitted = new Map();
  const note = (id, where) => { if (!emitted.has(id)) emitted.set(id, []); emitted.get(id).push(where); };
  for (const [rel, text] of emitters) for (const id of reasonsIn(text)) note(id, rel);
  if (orchestrator !== null) {
    const body = methodBody(orchestrator, DECIDE_METHOD);
    if (body === null) findings.push(`${ORCHESTRATOR}: ${DECIDE_METHOD} not found (the decide-gate path cannot be inspected)`);
    else for (const id of reasonsIn(body, { errorCode: true })) note(id, `${ORCHESTRATOR}#${DECIDE_METHOD}`);
  }
  for (const [id, where] of emitted) {
    if (!listed.has(id) && !ROW_OUTCOMES.has(id)) findings.push(`reason '${id}' emitted in ${where.join(', ')} is not in denyReasons`);
  }

  // 3. every listed reason has a test expectation; the allowed gaps may only shrink
  const referenced = (id) => {
    const quoted = new RegExp(String.raw`['"\`]${id}(?=['"\`:$])`);
    return [...expectations.values()].some((text) => quoted.test(text));
  };
  const gaps = [...listed].filter((id) => !referenced(id)).sort();
  for (const id of gaps) if (!allowedGaps.includes(id)) findings.push(`denyReasons entry '${id}' appears in no test expectation`);
  for (const id of allowedGaps) {
    if (!listed.has(id)) findings.push(`allowed gap '${id}' is not in denyReasons any more: remove it from ALLOWED_GAPS`);
    else if (!gaps.includes(id)) findings.push(`allowed gap '${id}' is now in a test expectation: remove it from ALLOWED_GAPS`);
  }
  return { findings, emitted, gaps };
}

const REAL = checkGateVocabulary();

test('G55: gate ids, emitted reasons and test expectations agree with gates.json and workflows.json', () => {
  assert.deepEqual(REAL.findings, []);
});

test('G55: the scan reaches the emitters (it would otherwise pass on an empty scan)', () => {
  for (const id of ['no-policy', 'verify-missing', 'blockers-open', 'lease-held', 'stage-not-performed', 'develop-dirty', 'head-moved', 'autopilot-disabled', 'seed-typed-status', 'unresolved-clarifications', 'markers-open', 'need-unmerged', 'capability-unreachable']) {
    assert.ok(REAL.emitted.has(id), `expected an emitter of '${id}'`);
  }
  assert.ok(REAL.emitted.get('autopilot-disabled').some((where) => where.includes(`#${DECIDE_METHOD}`)), 'the decide-gate path is inspected');
  for (const outcome of ROW_OUTCOMES) assert.ok(REAL.emitted.has(outcome), `row outcome '${outcome}' is emitted, so the exemption is live`);
});

test('G55: the allowed-gap list is empty today and names only real gaps', () => {
  assert.deepEqual(REAL.gaps, [...ALLOWED_GAPS].sort());
});

// ── controls: each fault below turns the guard red ─────────────────────────────────────────────────

const base = () => ({
  gates: JSON.parse(fs.readFileSync(path.join(REPO, GATES), 'utf8')),
  workflows: JSON.parse(fs.readFileSync(path.join(REPO, WORKFLOWS), 'utf8')),
  emitters: new Map(),
  orchestrator: null,
  expectations: new Map([['t.test.js', REAL_EXPECTATION_TEXT()]]),
});
function REAL_EXPECTATION_TEXT() {
  // Every listed reason quoted once, so a control isolates the fault it seeds.
  return JSON.parse(fs.readFileSync(path.join(REPO, GATES), 'utf8')).denyReasons.map((id) => `'${id}'`).join('\n');
}

test('G55 control: a scratch emitter of made-up-reason turns the guard red, at every reason site', () => {
  const sites = [
    "reasons.push('made-up-reason');",
    "return { decision: 'deny', reason: 'made-up-reason' };",
    "const x = { reasons: ['made-up-reason'] };",
    "return deny('made-up-reason');",
    'reasons.push(`made-up-reason:${file}`);',
    "requireFact('plan', 'made-up-reason');",
    "const failure = gateId === 'gate-0' ? 'made-up-reason' : 'markers-open';",
    "const failure = gateId === 'gate-0' ? 'markers-open' : 'made-up-reason';",
  ];
  for (const source of sites) {
    const { findings } = checkGateVocabulary({ ...base(), emitters: new Map([['src/runtime/roadmap/scratch.ts', source]]) });
    assert.ok(findings.some((f) => f.includes("'made-up-reason'") && f.includes('scratch.ts')), `no finding for: ${source}\n${findings.join('\n')}`);
  }
});

test('G55 control: listed reasons, parameters, comments and non-reason strings stay green', () => {
  const green = [
    "reasons.push('verify-missing');",
    'reasons.push(`protected-path:${file}`);',
    "return finish(ctx, { outcome: 'denied', reason: 'lease-held' });",
    "// reason: 'made-up-reason'",
    "/* reasons.push('made-up-reason') */",
    "const skips = { a: 'made-up-reason' }; const label = 'made-up-reason';",
    "return { skip: 'made-up-reason' };",
    "reasons.push(`${failure}:${source(name)}`);",
    "finish(ctx, { outcome: 'blocked', reason: 'budget' });",
  ].join('\n');
  const { findings } = checkGateVocabulary({ ...base(), emitters: new Map([['src/runtime/roadmap/scratch.ts', green]]) });
  assert.deepEqual(findings, []);
});

test('G55 control: the decide-gate path is inspected and nothing else in the orchestrator is', () => {
  const orchestrator = (inside, outside) => [
    `class O {`,
    `  other() { return { reason: '${outside}' }; }`,
    `  ${DECIDE_METHOD}(run: any, node: any) {`,
    `    const t = \`\${node.id}\`;`,
    `    ${inside}`,
    `  }`,
    `  after() { return { reason: '${outside}' }; }`,
    `}`,
  ].join('\n');
  const red = checkGateVocabulary({ ...base(), orchestrator: orchestrator("return { reason: 'made-up-reason', reasons: ['made-up-reason'] };", 'unrelated-reason') });
  assert.deepEqual(red.findings.map((f) => f.replace(/ emitted in .*? is not/, ' is not')), ["reason 'made-up-reason' is not in denyReasons"]);
  const codeCheck = checkGateVocabulary({ ...base(), orchestrator: orchestrator("if (error.code === 'made-up-reason') return null;", 'unrelated-reason') });
  assert.equal(codeCheck.findings.length, 1);
  const green = checkGateVocabulary({ ...base(), orchestrator: orchestrator("return { reason: 'no-policy' };", 'unrelated-reason') });
  assert.deepEqual(green.findings, []);
  const missing = checkGateVocabulary({ ...base(), orchestrator: 'class O { other() {} }' });
  assert.ok(missing.findings.some((f) => f.includes('not found')), 'a renamed decide-gate method fails closed');
});

test('G55 control: a row outcome moved into denyReasons, or an unlisted reason, turns the guard red', () => {
  const gates = base().gates;
  gates.denyReasons.push('budget');
  assert.ok(checkGateVocabulary({ ...base(), gates }).findings.some((f) => f.includes("'budget' is a row outcome")));
  const unlisted = base();
  unlisted.gates.denyReasons = unlisted.gates.denyReasons.filter((id) => id !== 'verify-missing');
  const { findings } = checkGateVocabulary({ ...unlisted, emitters: new Map([['src/runtime/roadmap/gates.ts', "reasons.push('verify-missing');"]]) });
  assert.ok(findings.some((f) => f.includes("reason 'verify-missing'") && f.includes('not in denyReasons')));
});

test('G55 control: gate ids that differ from workflows.json turn the guard red', () => {
  const dropped = base();
  dropped.workflows.classes.feature.gates = dropped.workflows.classes.feature.gates.filter((gate) => gate.id !== 'gate-b');
  assert.ok(checkGateVocabulary(dropped).findings.some((f) => f.includes("class 'feature'") && f.includes('gate-b')));
  const added = base();
  added.gates.classes.bug = { 'gate-x': { autopilot: 'approve', predicates: ['plan-parses'] } };
  assert.ok(checkGateVocabulary(added).findings.some((f) => f.includes("class 'bug'")));
  const missingClass = base();
  delete missingClass.gates.classes.operations;
  assert.ok(checkGateVocabulary(missingClass).findings.some((f) => f.includes("class 'operations' is in workflows.json but not in gates.json")));
});

test('G55 control: a listed reason no test mentions is a finding unless allowed, and an allowed gap may only shrink', () => {
  const none = checkGateVocabulary({ ...base(), expectations: new Map([['t.test.js', '']]) });
  assert.ok(none.findings.some((f) => f.includes("denyReasons entry 'no-policy' appears in no test expectation")));
  const partial = base();
  partial.expectations = new Map([['t.test.js', partial.gates.denyReasons.filter((id) => id !== 'policy-never').map((id) => `'${id}'`).join('\n')]]);
  assert.ok(checkGateVocabulary(partial).findings.some((f) => f.includes("'policy-never'")));
  assert.deepEqual(checkGateVocabulary({ ...partial, allowedGaps: ['policy-never'] }).findings, []);
  assert.ok(checkGateVocabulary({ ...base(), allowedGaps: ['policy-never'] }).findings.some((f) => f.includes("allowed gap 'policy-never' is now in a test expectation")));
  assert.ok(checkGateVocabulary({ ...base(), allowedGaps: ['not-a-reason'] }).findings.some((f) => f.includes("allowed gap 'not-a-reason' is not in denyReasons")));
  // a parameter suffix and a template head both count as a mention
  const forms = base();
  forms.expectations = new Map([['t.test.js', forms.gates.denyReasons.map((id, i) => (i % 2 ? `\`${id}:\${x}\`` : `"${id}:detail"`)).join('\n')]]);
  assert.deepEqual(checkGateVocabulary(forms).findings, []);
});

test('G55 control: a scratch tree with a made-up reason is found from the filesystem, and the real tree is untouched', (t) => {
  const tmp = tempDir(t, 'doflow-g55-vocabulary-');
  for (const rel of [GATES, WORKFLOWS]) {
    fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(tmp, rel));
  }
  fs.mkdirSync(path.join(tmp, ROADMAP_DIR), { recursive: true });
  fs.writeFileSync(path.join(tmp, ROADMAP_DIR, 'fault.ts'), "const deny = (r) => r;\nreturn deny('made-up-reason');\n");
  fs.mkdirSync(path.join(tmp, 'test'), { recursive: true });
  fs.writeFileSync(path.join(tmp, 'test/all.test.js'), REAL_EXPECTATION_TEXT());
  const { findings } = checkGateVocabulary(tmp);
  assert.deepEqual(findings, ["reason 'made-up-reason' emitted in src/runtime/roadmap/fault.ts is not in denyReasons"]);
});

test('G55: the scanner keeps comments, strings and templates apart on the shipped sources', () => {
  for (const rel of [ORCHESTRATOR, ...walk(path.join(REPO, ROADMAP_DIR), (f) => f.endsWith('.ts')).map((f) => path.relative(REPO, f))]) {
    const { skeleton } = scan(fs.readFileSync(path.join(REPO, rel), 'utf8'));
    const count = (char) => skeleton.split(char).length - 1;
    assert.equal(count('{'), count('}'), `${rel}: unbalanced braces after masking strings and comments`);
  }
});

module.exports = { checkGateVocabulary, reasonsIn, methodBody, scan };
