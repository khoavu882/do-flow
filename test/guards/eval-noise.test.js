'use strict';

// G60 — eval noise floor (feature 096, FR-001, FR-010).
//
// Four checks keep the verdict vocabulary and decision rule in one home:
//   (a) Every tracked JSON node with kind "bench-decision" passes validateDecision and recomputes from
//       its own inputs, cases, noise, thresholds and seed through bench/noise.ts. Model mismatch and
//       noise-unusable follow those recorded inputs, never today's config; source "none" means no band
//       in every scope. Every bench-noise node passes validateNoiseArtifact.
//   (b) No other tracked JSON under bench/ or test/ holds the values `gain-above-noise` or
//       `merge-candidate` (JSON values only: the README and bench/noise.ts name them legitimately).
//   (c) The vocabulary tables in bench/README.md equal the exports of bench/noise.ts, row for row.
//   (d) No other tracked bench JS file holds an array literal of two or more words of one vocabulary.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO } = require('./_shared');
const { tempDir } = require('../helper/tmp.ts');
const noise = require('../../bench/noise.ts');

const NOISE_MODULE = 'bench/noise.ts';
const README = 'bench/README.md';
const SECTION = 'Noise floor and verdicts';
const DECISION_WORDS = ['gain-above-noise', 'merge-candidate'];
const ROOTS = ['bench', 'test'];

const posix = (p) => p.split(path.sep).join('/');

function walk(dir, found = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, found); else found.push(full);
  }
  return found;
}

/** Tracked files under `bench/` and `test/` (`git ls-files -z`); a walk when the root is not a checkout. */
function listFiles(root) {
  const git = spawnSync('git', ['ls-files', '-z', '--', ...ROOTS], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (git.status === 0 && git.stdout) return git.stdout.split('\0').filter(Boolean);
  return ROOTS.flatMap((dir) => walk(path.join(root, dir))).map((f) => posix(path.relative(root, f)));
}

// ── (d) comment masker: blanks comments, keeps strings; G60 carries its own so it does not require G55 ──

function maskComments(text) {
  const out = text.split('');
  const length = text.length;
  const blank = (from, to) => { for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' '; };
  const regexAllowed = (before) => before === null || '(,=:[!&|?{};+-*%<>~^'.includes(before);
  let i = 0;
  let previous = null;
  while (i < length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const start = i;
      while (i < length && text[i] !== '\n') i += 1;
      blank(start, i);
    } else if (c === '/' && text[i + 1] === '*') {
      const start = i;
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? length : end + 2;
      blank(start, i);
    } else if (c === '/' && regexAllowed(previous)) {
      let inClass = false;
      i += 1;
      while (i < length && (text[i] !== '/' || inClass) && text[i] !== '\n') {
        if (text[i] === '\\') i += 1; else if (text[i] === '[') inClass = true; else if (text[i] === ']') inClass = false;
        i += 1;
      }
      i += 1;
      previous = ')';
    } else if (c === "'" || c === '"' || c === '`') {
      i += 1;
      while (i < length && text[i] !== c) { if (text[i] === '\\') i += 1; i += 1; }
      i += 1;
      previous = ')';
    } else {
      if (!/\s/.test(c)) previous = c;
      i += 1;
    }
  }
  return out.join('');
}

const VOCABULARIES = {
  'noise-check verdict': noise.NOISE_VERDICTS,
  'decision verdict': noise.DECISION_VERDICTS,
  recommendation: noise.RECOMMENDATIONS,
  'infra error class': noise.INFRA_CLASSES,
  'run status': noise.RUN_STATUSES,
  'noise method': noise.NOISE_METHODS,
  'exclusion mark': noise.EXCLUSION_MARKS,
};
const README_VOCABULARIES = {
  ...noise.VOCABULARY_LABELS,
  'Exclusion mark': noise.EXCLUSION_MARKS,
};

/** Words of one vocabulary inside every array literal of the masked source; two or more is a duplicate list. */
function duplicateLists(text) {
  const masked = maskComments(text);
  const found = [];
  for (const literal of masked.matchAll(/\[([^\[\]]*)\]/g)) {
    const words = new Set([...literal[1].matchAll(/'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\]*)`/g)].map((m) => m[1] ?? m[2] ?? m[3]));
    for (const [name, list] of Object.entries(VOCABULARIES)) {
      const shared = list.filter((word) => words.has(word));
      if (shared.length >= 2) found.push(`${name} words ${shared.join(', ')}`);
    }
  }
  return found;
}

// ── (a) decision recomputation ───────────────────────────────────────────────────────────────────

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Recomputes one scope from its own stored numbers; returns the problems. */
function recomputeScope(at, scope, decision, scopeName) {
  const problems = [];
  const t = decision.thresholds || {};
  let again;
  try {
    const cases = scope.cases;
    const baseline = Object.fromEntries(cases.map((c) => [c.key, [c.baseline]]));
    const candidate = Object.fromEntries(cases.map((c) => [c.key, [c.candidate]]));
    // decide gives gain, ci95, n and band from the case means and the stored seed; the infra share is
    // fed to ruleVerdict below exactly as stored.
    const measured = noise.decide({
      scope: scopeName, baseline, candidate, excluded: { baseline: { runs: 0, excluded: 0 }, candidate: { runs: 0, excluded: 0 } },
      noise: scope.noise, mde: t.mde, maxInfraShare: t.maxInfraShare, seed: t.seed, precondition: decision.precondition ?? null,
    });
    const rule = noise.ruleVerdict({
      precondition: decision.precondition ?? null, noise: scope.noise, mde: t.mde, maxInfraShare: t.maxInfraShare,
      infraShare: scope.infraShare || {}, n: measured.n, gain: measured.gain, ci95: measured.ci95,
    });
    again = { gain: measured.gain, ci95: measured.ci95, n: measured.n, band: measured.band, ...rule };
  } catch (error) {
    return [`${at}: cannot recompute: ${error.message}`];
  }
  for (const field of ['gain', 'ci95', 'n', 'band', 'verdict', 'recommendation', 'reason']) {
    if (!sameJson(scope[field], again[field])) {
      problems.push(`${at}: ${field} stored ${JSON.stringify(scope[field])} but the rule gives ${JSON.stringify(again[field])}`
        + (field === 'verdict' ? ` (${again.reason})` : ''));
    }
  }
  return problems;
}

function checkDecision(rel, pointer, decision) {
  const findings = [...validateFindings(rel, pointer, decision), ...sourceNoneFindings(rel, pointer, decision)];
  if (findings.length) return findings;
  const scopes = [['corpus', decision.corpus], ['splits.train', decision.splits.train], ['splits.heldout', decision.splits.heldout]];
  const out = [];
  for (const [name, scope] of scopes) {
    out.push(...recomputeScope(`${rel}: ${pointer}.${name}`, scope, decision, name.split('.').pop()));
  }
  const flag = noise.overfitFlag(decision.splits.train, decision.splits.heldout);
  if (decision.overfitSuspected !== flag) {
    out.push(`${rel}: ${pointer}.overfitSuspected: stored ${JSON.stringify(decision.overfitSuspected)} but the splits give ${JSON.stringify(flag)}`);
  }
  return out;
}

function sourceNoneFindings(rel, pointer, decision) {
  if (decision.inputs?.baseline?.source !== 'none') return [];
  const findings = [];
  if (decision.precondition !== null) {
    findings.push(`${rel}: ${pointer}.precondition: baseline source is "none", so precondition must be null`);
  }
  for (const [name, scope] of [['corpus', decision.corpus], ['train', decision.splits?.train], ['heldout', decision.splits?.heldout]]) {
    if (!scope || typeof scope !== 'object') continue;
    const at = `${pointer}.${name === 'corpus' ? 'corpus' : `splits.${name}`}`;
    if (scope.noise !== null) findings.push(`${rel}: ${at}.noise: baseline source is "none", so noise must be null`);
    if (scope.reason !== 'no-noise-band') findings.push(`${rel}: ${at}.reason: baseline source is "none", so reason must be "no-noise-band"`);
  }
  return findings;
}

function validateFindings(rel, pointer, decision) {
  return noise.validateDecision(decision).map((problem) => `${rel}: ${pointer}${problem.replace(/^\$/, '')}`);
}

/** Visits every node; `inDecision` is true inside a bench-decision subtree (validated by (a), skipped by (b)). */
function visit(node, pointer, onDecision, onNoiseArtifact, onValue, inDecision = false) {
  if (typeof node === 'string') { if (!inDecision) onValue(node, pointer); return; }
  if (node === null || typeof node !== 'object') return;
  const isDecision = !Array.isArray(node) && node.kind === 'bench-decision';
  const isNoiseArtifact = !Array.isArray(node) && node.kind === 'bench-noise';
  if (isDecision) { onDecision(node, pointer); }
  if (isNoiseArtifact) { onNoiseArtifact(node, pointer); }
  const inside = inDecision || isDecision;
  if (Array.isArray(node)) node.forEach((child, i) => visit(child, `${pointer}[${i}]`, onDecision, onNoiseArtifact, onValue, inside));
  else for (const [key, child] of Object.entries(node)) visit(child, `${pointer}.${key}`, onDecision, onNoiseArtifact, onValue, inside);
}

// ── (c) README tables ─────────────────────────────────────────────────────────────────────────────

function readmeFindings(readme) {
  const findings = [];
  const start = readme.search(new RegExp(`^## ${SECTION}\\s*$`, 'm'));
  if (start < 0) return [`${README}: section '## ${SECTION}' not found`];
  const rest = readme.slice(start + 1);
  const next = rest.search(/^## /m);
  const body = next < 0 ? rest : rest.slice(0, next);
  const rows = body.split('\n').filter((line) => /^\|/.test(line)).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()))
    .filter((cells) => cells.length === 2 && !/^-+$/.test(cells[0]) && cells[0] !== 'Vocabulary');
  const labels = rows.map((cells) => cells[0]);
  const expectedLabels = Object.keys(README_VOCABULARIES);
  if (!sameJson(labels, expectedLabels)) {
    findings.push(`${README}: table labels [${labels.join(', ')}] differ from [${expectedLabels.join(', ')}]`);
  }
  for (const [label, expected] of Object.entries(README_VOCABULARIES)) {
    const row = rows.find((cells) => cells[0] === label);
    if (!row) { findings.push(`${README}: no row for '${label}'`); continue; }
    const values = [...row[1].matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    if (!sameJson(values, expected)) findings.push(`${README}: row '${label}' is [${values.join(', ')}] but bench/noise.ts exports [${expected.join(', ')}]`);
  }
  return findings;
}

/**
 * Applies rules (a)-(d). `target` is a repo root (default this repo) or
 * `{ root, jsonFiles: Map<rel, text>, jsFiles: Map<rel, text>, readme: string }`; any part can be replaced.
 */
function checkEvalNoise(target = REPO) {
  const options = typeof target === 'string' ? { root: target } : target;
  const root = options.root || REPO;
  const files = options.jsonFiles && options.jsFiles ? [] : listFiles(root);
  const read = (rel) => { try { return fs.readFileSync(path.join(root, rel), 'utf8'); } catch { return null; } };
  const jsonFiles = options.jsonFiles || new Map(files.filter((rel) => rel.endsWith('.json')).map((rel) => [rel, read(rel)]));
  const jsFiles = options.jsFiles || new Map(files.filter((rel) => rel.startsWith('bench/') && (rel.endsWith('.js') || rel.endsWith('.ts'))).map((rel) => [rel, read(rel)]));
  const readme = options.readme !== undefined ? options.readme : read(README);
  const findings = [];
  let decisions = 0;
  let noiseArtifacts = 0;

  for (const [rel, text] of jsonFiles) {
    let parsed;
    try { parsed = JSON.parse(text); } catch { continue; }
    visit(parsed, '$', (decision, pointer) => { decisions += 1; findings.push(...checkDecision(rel, pointer, decision)); },
      (artifact, pointer) => {
        noiseArtifacts += 1;
        findings.push(...noise.validateNoiseArtifact(artifact).map((problem) => `${rel}: ${pointer}${problem.replace(/^\$/, '')}`));
      },
      (value, pointer) => {
        if (DECISION_WORDS.includes(value)) findings.push(`${rel}: ${pointer}: value '${value}' outside a valid bench-decision`);
      });
  }

  if (readme === null) findings.push(`${README}: cannot read`); else findings.push(...readmeFindings(readme));

  for (const [rel, text] of jsFiles) {
    if (rel === NOISE_MODULE || text === null) continue;
    for (const what of duplicateLists(text)) findings.push(`${rel}: array literal repeats the ${what}; import them from ${NOISE_MODULE}`);
  }
  return { findings, decisions, noiseArtifacts, json: jsonFiles.size, js: jsFiles.size, readme: readme ? readme.length : 0 };
}

const REAL = checkEvalNoise();

test('G60: bench decisions recompute, only valid decisions carry gain words, README tables and JS lists agree', () => {
  assert.deepEqual(REAL.findings, []);
});

test('G60: the scan reached bench JSON, JS and the README (it would otherwise pass on an empty scan)', () => {
  assert.ok(REAL.json > 0, 'tracked JSON was scanned');
  assert.ok(REAL.js > 1, 'tracked bench JS beyond noise.js was scanned');
  assert.ok(REAL.readme > 0, 'bench/README.md was read');
  assert.ok(fs.readFileSync(path.join(REPO, README), 'utf8').includes(`## ${SECTION}`), 'the README section exists');
});

// ── controls: each fault below turns the guard red ────────────────────────────────────────────────

const THRESHOLDS = { mde: 0.05, maxInfraShare: 0.1, headroom: 0.95, seed: 7, eps: noise.EPS, minPairedCases: noise.MIN_PAIRED_CASES };

function scopeOf(name, pairs) {
  const baseline = Object.fromEntries(pairs.map(([key, b]) => [key, [b]]));
  const candidate = Object.fromEntries(pairs.map(([key, , c]) => [key, [c]]));
  return noise.decide({
    scope: name, baseline, candidate, excluded: { baseline: { runs: 10, excluded: 0 }, candidate: { runs: 10, excluded: 0 } },
    noise: 0.02, mde: THRESHOLDS.mde, maxInfraShare: THRESHOLDS.maxInfraShare, seed: THRESHOLDS.seed,
  });
}

/** A valid bench-decision: `gain` pairs lift every case by 0.3, `flat` pairs by 0.001. */
function decisionOf(pairs) {
  const corpus = scopeOf('corpus', pairs);
  const train = scopeOf('train', pairs);
  const heldout = scopeOf('heldout', pairs);
  return {
    kind: 'bench-decision', schemaVersion: 1, thresholds: { ...THRESHOLDS }, precondition: null,
    inputs: {
      baseline: { source: 'noise-artifact', model: 'model-a' },
      baselineFile: { model: 'model-a' },
      candidate: { model: 'model-a' },
      noiseArtifact: { sha256: null, verdict: 'usable' },
    },
    infra: { baseline: {}, candidate: {} },
    corpus, splits: { train, heldout }, overfitSuspected: noise.overfitFlag(train, heldout),
    verdict: corpus.verdict, recommendation: corpus.recommendation,
  };
}
const GAIN = [['a', 0.2, 0.6], ['b', 0.4, 0.7], ['c', 0.5, 0.9], ['d', 0.6, 0.85]];
const FLAT = [['a', 0.5, 0.501], ['b', 0.6, 0.601], ['c', 0.7, 0.701], ['d', 0.4, 0.401]];

const realReadme = () => fs.readFileSync(path.join(REPO, README), 'utf8');
const validReadme = () => `## ${SECTION}\n\n| Vocabulary | Values |\n|---|---|\n${Object.entries(README_VOCABULARIES)
  .map(([label, values]) => `| ${label} | ${values.map((value) => `\`${value}\``).join(' · ')} |`).join('\n')}\n`;
const clean = (extra = {}) => ({
  root: REPO,
  jsonFiles: new Map([['bench/results/ok.json', JSON.stringify(decisionOf(GAIN))]]),
  jsFiles: new Map([['bench/ok.js', 'const a = 1;\n']]),
  readme: validReadme(),
  ...extra,
});
const decisionFile = (decision) => new Map([['bench/results/x.json', JSON.stringify(decision)]]);

function setDecisionNoiseAndRule(decision, precondition, scopeNoise) {
  decision.precondition = precondition;
  for (const [scope, name] of [[decision.corpus, 'corpus'], [decision.splits.train, 'train'], [decision.splits.heldout, 'heldout']]) {
    scope.noise = scopeNoise;
    scope.band = scopeNoise === null ? null : Math.max(scopeNoise, decision.thresholds.mde);
    Object.assign(scope, noise.ruleVerdict({
      precondition, noise: scopeNoise, mde: decision.thresholds.mde,
      maxInfraShare: decision.thresholds.maxInfraShare, infraShare: scope.infraShare,
      n: scope.n, gain: scope.gain, ci95: scope.ci95,
    }));
    scope.scope = name;
  }
  decision.verdict = decision.corpus.verdict;
  decision.recommendation = decision.corpus.recommendation;
  decision.overfitSuspected = noise.overfitFlag(decision.splits.train, decision.splits.heldout);
  return decision;
}

function noiseArtifactOf() {
  const config = { k: 2, mde: 0.05, headroom: 0.95, maxInfraShare: 0.1, seed: 7 };
  const repeats = [0.2, 0.21].map((passRate, index) => ({
    iteration: `rep-${index + 1}`, model: 'model-a', commit: 'abcdef0123456789',
    runs: { 'skill/1': { kind: 'triggering', split: 'train', passRate, excluded: null } },
  }));
  return noise.computeNoise({ repeats, config, graderRerun: { runs: 2, differing: [], stale: [] } });
}

test('G60 control: a valid gain decision and a valid flat decision stay green, and are counted', () => {
  const result = checkEvalNoise(clean({ jsonFiles: new Map([['bench/a.json', JSON.stringify(decisionOf(GAIN))], ['bench/b.json', JSON.stringify(decisionOf(FLAT))]]) }));
  assert.deepEqual(result.findings, []);
  assert.equal(result.decisions, 2);
  assert.equal(decisionOf(GAIN).verdict, 'gain-above-noise');
  assert.equal(decisionOf(FLAT).verdict, 'within-noise');
});

test('G60 control: gain inside the band stored as gain-above-noise turns the guard red', () => {
  const d = decisionOf(FLAT);
  Object.assign(d.corpus, { verdict: 'gain-above-noise', recommendation: 'merge-candidate', reason: 'above-band' });
  d.verdict = 'gain-above-noise';
  d.recommendation = 'merge-candidate';
  const { findings } = checkEvalNoise(clean({ jsonFiles: decisionFile(d) }));
  assert.ok(findings.some((f) => f.includes('$.corpus: verdict stored "gain-above-noise" but the rule gives "within-noise"')), findings.join('\n'));
});

test('G60 control: a tampered ci95 turns the guard red', () => {
  const d = decisionOf(GAIN);
  d.corpus.ci95 = [d.corpus.ci95[0] - 0.05, d.corpus.ci95[1]];
  const { findings } = checkEvalNoise(clean({ jsonFiles: decisionFile(d) }));
  assert.ok(findings.some((f) => f.includes('$.corpus: ci95 stored')), findings.join('\n'));
});

test('G60 control: required decision inputs, derived preconditions and source none stay consistent', () => {
  const missing = decisionOf(GAIN);
  delete missing.inputs;
  delete missing.infra;
  assert.ok(checkEvalNoise(clean({ jsonFiles: decisionFile(missing) })).findings.some((f) => f.includes('$.inputs: must be an object')));

  const modelMismatch = decisionOf(GAIN);
  modelMismatch.inputs.candidate.model = 'model-b';
  const modelFindings = checkEvalNoise(clean({ jsonFiles: decisionFile(modelMismatch) })).findings;
  assert.ok(modelFindings.some((f) => f.includes('model fields mismatch')), modelFindings.join('\n'));

  const unusable = decisionOf(GAIN);
  unusable.inputs.noiseArtifact.verdict = 'inconclusive';
  const unusableFindings = checkEvalNoise(clean({ jsonFiles: decisionFile(unusable) })).findings;
  assert.ok(unusableFindings.some((f) => f.includes('inputs.noiseArtifact.verdict')), unusableFindings.join('\n'));

  const noBand = decisionOf(GAIN);
  noBand.inputs.baseline = { source: 'none' };
  noBand.inputs.baselineFile = {};
  noBand.inputs.candidate = {};
  noBand.inputs.noiseArtifact = null;
  setDecisionNoiseAndRule(noBand, null, null);
  assert.deepEqual(checkEvalNoise(clean({ jsonFiles: decisionFile(noBand) })).findings, []);

  const forgedNoBand = setDecisionNoiseAndRule(structuredClone(noBand), 'noise-unusable', null);
  const noBandFindings = checkEvalNoise(clean({ jsonFiles: decisionFile(forgedNoBand) })).findings;
  assert.ok(noBandFindings.some((f) => f.includes('baseline source is "none", so precondition must be null')), noBandFindings.join('\n'));
  assert.ok(noBandFindings.some((f) => f.includes('baseline source is "none", so reason must be "no-noise-band"')), noBandFindings.join('\n'));
});

test('G60 control: bench-noise nodes are validated with the exported pure validator', () => {
  const valid = noiseArtifactOf();
  const cleanArtifact = checkEvalNoise(clean({ jsonFiles: new Map([['bench/noise.json', JSON.stringify(valid)]]) }));
  assert.deepEqual(cleanArtifact.findings, []);
  assert.equal(cleanArtifact.noiseArtifacts, 1);

  const forged = structuredClone(valid);
  forged.scopes.corpus.noise = 0;
  const result = checkEvalNoise(clean({ jsonFiles: new Map([['bench/noise.json', JSON.stringify(forged)]]) }));
  assert.equal(result.noiseArtifacts, 1);
  assert.ok(result.findings.some((f) => f.includes('$.scopes.corpus.noise: stored 0 does not match recomputed 0.01')), result.findings.join('\n'));
});

test('G60 control: n different from cases.length, a tampered gain and a wrong overfit flag turn the guard red', () => {
  const wrongN = decisionOf(GAIN);
  wrongN.splits.train.n = 3;
  assert.ok(checkEvalNoise(clean({ jsonFiles: decisionFile(wrongN) })).findings.some((f) => f.includes('$.splits.train.n')));
  const wrongGain = decisionOf(GAIN);
  wrongGain.splits.heldout.gain += 0.01;
  assert.ok(checkEvalNoise(clean({ jsonFiles: decisionFile(wrongGain) })).findings.some((f) => f.includes('$.splits.heldout: gain stored')));
  const wrongFlag = decisionOf(GAIN);
  wrongFlag.overfitSuspected = true;
  assert.ok(checkEvalNoise(clean({ jsonFiles: decisionFile(wrongFlag) })).findings.some((f) => f.includes('overfitSuspected')));
});

test('G60 control: a decision nested in a report JSON is validated, and not flagged by the value rule', () => {
  const good = { rows: [], decision: decisionOf(GAIN) };
  const ok = checkEvalNoise(clean({ jsonFiles: new Map([['bench/reports/r.json', JSON.stringify(good)]]) }));
  assert.deepEqual(ok.findings, []);
  assert.equal(ok.decisions, 1);
  const bad = { rows: [], decision: decisionOf(FLAT) };
  Object.assign(bad.decision.corpus, { verdict: 'gain-above-noise', recommendation: 'merge-candidate', reason: 'above-band' });
  Object.assign(bad.decision, { verdict: 'gain-above-noise', recommendation: 'merge-candidate' });
  const { findings } = checkEvalNoise(clean({ jsonFiles: new Map([['bench/reports/r.json', JSON.stringify(bad)]]) }));
  assert.ok(findings.some((f) => f.includes('$.decision.corpus: verdict stored')), findings.join('\n'));
  assert.ok(!findings.some((f) => f.includes('outside a valid bench-decision')), 'the nested decision is not flagged by the value rule');
});

test('G60 control: a stray gain-above-noise or merge-candidate value in another JSON turns the guard red, a key does not', () => {
  for (const word of DECISION_WORDS) {
    const stray = JSON.stringify({ verdict: word, list: ['x', word] });
    const { findings } = checkEvalNoise(clean({ jsonFiles: new Map([['bench/other.json', stray], ['test/fixtures/y.json', JSON.stringify({ [word]: 1, note: 'prose mentions it' })]]) }));
    assert.deepEqual(findings.map((f) => f.split(':')[0]), ['bench/other.json', 'bench/other.json'], findings.join('\n'));
    assert.ok(findings.every((f) => f.includes(`'${word}'`)));
  }
});

test('G60 control: a README row missing a value, an extra value, a reordered row and a missing row turn the guard red', () => {
  const real = realReadme();
  const row = (label) => real.split('\n').find((line) => line.startsWith(`| ${label} |`));
  assert.ok(row('Decision verdict'), 'the README carries the Decision verdict row');
  const mutate = (label, replace) => real.replace(row(label), replace(row(label)));
  const missing = mutate('Decision verdict', (line) => line.replace(' · `regression`', ''));
  assert.ok(checkEvalNoise(clean({ readme: missing })).findings.some((f) => f.includes("row 'Decision verdict'")));
  const extra = mutate('Run status', (line) => line.replace(/ \|$/, ' · `killed` |'));
  assert.ok(checkEvalNoise(clean({ readme: extra })).findings.some((f) => f.includes("row 'Run status'")));
  const reordered = mutate('Noise-check verdict', (line) => line.replace('`inconclusive` · `grader-unstable`', '`grader-unstable` · `inconclusive`'));
  assert.ok(checkEvalNoise(clean({ readme: reordered })).findings.some((f) => f.includes("row 'Noise-check verdict'")));
  const swapped = real.replace(row('Recommendation'), '@@R@@').replace(row('Infra error class'), row('Recommendation')).replace('@@R@@', row('Infra error class'));
  assert.ok(checkEvalNoise(clean({ readme: swapped })).findings.some((f) => f.includes('table labels')));
  const dropped = real.replace(`${row('Noise method')}\n`, '');
  assert.ok(checkEvalNoise(clean({ readme: dropped })).findings.some((f) => f.includes("no row for 'Noise method'")));
  assert.ok(row('Exclusion mark'), 'the README carries the exported exclusion-mark row');
  const missingMark = mutate('Exclusion mark', (line) => line.replace(' · `source-unverified`', ''));
  assert.ok(checkEvalNoise(clean({ readme: missingMark })).findings.some((f) => f.includes("row 'Exclusion mark'")));
  const droppedMark = real.replace(`${row('Exclusion mark')}\n`, '');
  assert.ok(checkEvalNoise(clean({ readme: droppedMark })).findings.some((f) => f.includes("no row for 'Exclusion mark'")));
  assert.ok(checkEvalNoise(clean({ readme: real.replace(`## ${SECTION}`, '## Something else') })).findings.some((f) => f.includes('not found')));
});

test('G60 control: a bench JS file holding a vocabulary list turns the guard red; one word, noise.js, comments stay green', () => {
  const red = ["const A = ['within-noise', 'regression'];", 'const B = ["timeout", "api-error"];', 'const C = [`completed`, `truncated`, `x`];'];
  for (const source of red) {
    const { findings } = checkEvalNoise(clean({ jsFiles: new Map([['bench/x.js', source]]) }));
    // timeout and api-error belong to two vocabularies, so such a list is found once per vocabulary
    assert.ok(findings.length >= 1, `no finding for: ${source}`);
    assert.ok(findings.every((f) => f.startsWith('bench/x.js:')));
  }
  const green = [
    "const A = ['within-noise'];", "if (['timeout', 'x'].length) {}", "// ['within-noise', 'regression']", "/* ['timeout', 'api-error'] */",
    "const s = 'within-noise regression'; const t = [s];",
  ].join('\n');
  assert.deepEqual(checkEvalNoise(clean({ jsFiles: new Map([['bench/x.js', green]]) })).findings, []);
  const own = checkEvalNoise(clean({ jsFiles: new Map([[NOISE_MODULE, "const A = ['within-noise', 'regression'];"]]) }));
  assert.deepEqual(own.findings, []);
});

test('G60 control: a scratch tree is found from the filesystem (not a git checkout), and the real tree is untouched', (t) => {
  const tmp = tempDir(t, 'doflow-g60-noise-');
  const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), text); };
  put(README, validReadme());
  put('bench/ok.json', JSON.stringify(decisionOf(GAIN)));
  put('bench/x.js', "const A = ['within-noise', 'regression'];\n");
  put('test/fixtures/stray.json', JSON.stringify({ recommendation: 'merge-candidate' }));
  const { findings, decisions } = checkEvalNoise(tmp);
  assert.equal(decisions, 1);
  assert.deepEqual(findings.map((f) => f.split(':')[0]).sort(), ['bench/x.js', 'test/fixtures/stray.json']);
});

test('G60: the comment masker keeps strings and blanks comments', () => {
  const masked = maskComments("const a = 'x // y'; // ['timeout','api-error']\n/* ['timeout','api-error'] */ const r = /['\"]/;");
  assert.ok(masked.includes("'x // y'"));
  assert.ok(!masked.includes('api-error'));
  assert.equal(masked.length, "const a = 'x // y'; // ['timeout','api-error']\n/* ['timeout','api-error'] */ const r = /['\"]/;".length);
});

module.exports = { checkEvalNoise, maskComments, duplicateLists, readmeFindings };
