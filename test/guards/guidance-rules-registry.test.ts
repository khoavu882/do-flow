'use strict';

// G71 — guidance rules registry schema, completeness, and safety invariants (Feature 102, IC-001, IC-002).
//
// `core/registry/rules.json` is the authoritative ledger of all always-loaded guidance rules.
// This guard verifies:
// 1. Schema conformance to IC-001 and IC-018 (version 2, types, categories, enforcement values and their reasons).
// 2. Completeness and bidirectional synchronization with markdown rule statements in
//    `core/shared/guidance/rules/` and `core/shared/guidance/PRINCIPLES.md`.
// 3. Mandatory safety rules carry `neverAblate: true` and `ablationCandidate: false`.
// 4. Disjoint invariant: `neverAblate` and `ablationCandidate` are mutually exclusive on every rule.
// 5. Coverage (row 181, FR-007, FR-008, IC-019): every rule line of the 13 skill directories and
//    `core/shared/guidance/**` lies in exactly one row's statement, found by `coverRuleLines`.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, GUIDANCE } = require('./_shared.ts');
const { coverRuleLines, ruleSourceFiles } = require('../../src/runtime/guidance/rule-ledger.ts');
const { tempDir } = require('../helper/tmp.ts');

const RULES_REGISTRY_FILE = path.join(REPO, 'core', 'registry', 'rules.json');
const RULES_DIR = path.join(GUIDANCE, 'rules');
const PRINCIPLES_FILE = path.join(GUIDANCE, 'PRINCIPLES.md');

const MANDATORY_SAFETY_RULES = Object.freeze([
  'rule-safety-conflict-order',
  'rule-safety-temporal-awareness',
  'rule-principles-retrieved-content-data',
  'rule-quality-no-invented-sources',
  'rule-quality-admit-unknowns',
  'rule-questions-noninteractive-fallback',
  'rule-questions-noninteractive-halt-on-blocker',
]);

const ALLOWED_CATEGORIES = new Set(['safety', 'workflow', 'quality', 'questions', 'principles', 'skill', 'mcp', 'mode', 'reference']);
const ALLOWED_ENFORCEMENTS = new Set(['check', 'judgement-only', 'not-a-rule']);
const ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

interface ValidationResult {
  ok: boolean;
  errors: string[];
}

/** Pure validator for core/registry/rules.json shape and invariant constraints. */
function validateRulesRegistry(ledger: any, repoRoot: string = REPO): ValidationResult {
  const errors: string[] = [];
  const at = (location: string, message: string) => errors.push(`${location}: ${message}`);

  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    at('rules.json', 'must be a top-level JSON object');
    return { ok: false, errors };
  }

  if (ledger.version !== 2) {
    at('rules.json.version', `must be 2, got ${JSON.stringify(ledger.version)}`);
  }

  if (typeof ledger.description !== 'string' || !ledger.description.trim()) {
    at('rules.json.description', 'must be a non-empty string');
  }

  if (!Array.isArray(ledger.rules) || ledger.rules.length === 0) {
    at('rules.json.rules', 'must be a non-empty array of rule entries');
    return { ok: false, errors };
  }

  const seenIds = new Set<string>();
  // A check ref must ship: the package carries only the package.json `files` entries, so `doflow enforcement --rules` run from an install sees no other file.
  const shipped: string[] = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).files;

  ledger.rules.forEach((rule: any, i: number) => {
    const loc = `rules[${i}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      at(loc, 'must be an object');
      return;
    }

    // ID validation
    if (typeof rule.id !== 'string' || !ID_PATTERN.test(rule.id)) {
      at(`${loc}.id`, `must be kebab-case matching ${ID_PATTERN}, got ${JSON.stringify(rule.id)}`);
    } else if (seenIds.has(rule.id)) {
      at(`${loc}.id`, `duplicate rule id '${rule.id}'`);
    } else {
      seenIds.add(rule.id);
    }

    // Required string fields
    if (typeof rule.tag !== 'string' || !rule.tag.trim()) {
      at(`${loc}.tag`, 'must be a non-empty string');
    }
    if (typeof rule.statement !== 'string' || !rule.statement.trim()) {
      at(`${loc}.statement`, 'must be a non-empty string');
    }

    // Category validation
    if (!ALLOWED_CATEGORIES.has(rule.category)) {
      at(`${loc}.category`, `must be one of [${[...ALLOWED_CATEGORIES].join(', ')}], got ${JSON.stringify(rule.category)}`);
    }

    // Enforcement validation
    if (!ALLOWED_ENFORCEMENTS.has(rule.enforcement)) {
      at(`${loc}.enforcement`, `rule '${rule.id}': must be one of [${[...ALLOWED_ENFORCEMENTS].join(', ')}], got ${JSON.stringify(rule.enforcement)}`);
    }

    if (rule.enforcement === 'check') {
      if (typeof rule.enforcementRef !== 'string' || !rule.enforcementRef.trim()) {
        at(`${loc}.enforcementRef`, `rule '${rule.id}': a check row must name an enforcement file`);
      } else if (!fs.existsSync(path.join(repoRoot, rule.enforcementRef))) {
        at(`${loc}.enforcementRef`, `rule '${rule.id}': referenced enforcement file does not exist: '${rule.enforcementRef}'`);
      } else if (!shipped.some((entry: string) => rule.enforcementRef === entry.replace(/\/$/, '') || rule.enforcementRef.startsWith(entry.replace(/\/?$/, '/')))) {
        at(`${loc}.enforcementRef`, `rule '${rule.id}': enforcement file '${rule.enforcementRef}' is not under a package.json files entry, so an installed doflow cannot see it`);
      }
      if (rule.reason !== null) {
        at(`${loc}.reason`, `rule '${rule.id}': a check row must have reason: null`);
      }
    } else if (ALLOWED_ENFORCEMENTS.has(rule.enforcement)) {
      if (rule.enforcementRef !== null) {
        at(`${loc}.enforcementRef`, `rule '${rule.id}': a ${rule.enforcement} row must have enforcementRef: null`);
      }
      if (typeof rule.reason !== 'string' || !rule.reason.trim() || /[\r\n]/.test(rule.reason)) {
        at(`${loc}.reason`, `rule '${rule.id}': a ${rule.enforcement} row needs a one-line reason`);
      }
    }

    // Boolean invariant flags
    if (typeof rule.neverAblate !== 'boolean') {
      at(`${loc}.neverAblate`, 'must be a boolean');
    }
    if (typeof rule.ablationCandidate !== 'boolean') {
      at(`${loc}.ablationCandidate`, 'must be a boolean');
    }

    // Disjoint invariant
    if (rule.neverAblate === true && rule.ablationCandidate === true) {
      at(`${loc}`, `rule '${rule.id}': neverAblate and ablationCandidate cannot both be true (must be mutually exclusive)`);
    }

    // Source file validation & statement synchronization
    if (typeof rule.sourceFile !== 'string' || !rule.sourceFile.trim()) {
      at(`${loc}.sourceFile`, 'must be a non-empty string path');
    } else {
      const fullSource = path.join(repoRoot, rule.sourceFile);
      if (!fs.existsSync(fullSource)) {
        at(`${loc}.sourceFile`, `declared sourceFile does not exist: '${rule.sourceFile}'`);
      } else {
        const sourceText = fs.readFileSync(fullSource, 'utf8');
        const cleanSource = sourceText.replace(/[*#`_:]/g, ' ').replace(/\s+/g, ' ').toLowerCase();
        const cleanStmt = rule.statement.replace(/[*#`_:]/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim();
        const snippet = cleanStmt.slice(0, 35);
        if (!cleanSource.includes(snippet)) {
          // Fallback: if rule has "header: body", check if body is in cleanSource
          const parts = rule.statement.split(':');
          const body = parts.length > 1
            ? parts.slice(1).join(':').replace(/[*#`_:]/g, ' ').replace(/\s+/g, ' ').toLowerCase().trim().slice(0, 35)
            : '';
          if (!body || !cleanSource.includes(body)) {
            at(`${loc}.statement`, `rule statement for '${rule.id}' not found in sourceFile '${rule.sourceFile}'`);
          }
        }
      }
    }
  });

  // Verify all mandatory safety rules are registered and protected
  for (const safetyId of MANDATORY_SAFETY_RULES) {
    const entry = ledger.rules.find((r: any) => r && r.id === safetyId);
    if (!entry) {
      at('rules.json', `mandatory safety rule '${safetyId}' is missing from registry`);
    } else {
      if (entry.neverAblate !== true) {
        at(`rules.json['${safetyId}']`, `mandatory safety rule must have neverAblate: true`);
      }
      if (entry.ablationCandidate !== false) {
        at(`rules.json['${safetyId}']`, `mandatory safety rule must have ablationCandidate: false`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

describe('Guard G71: Guidance Rules Registry Validation', () => {
  test('core/registry/rules.json exists, is valid JSON, and satisfies IC-001 schema', () => {
    assert.ok(fs.existsSync(RULES_REGISTRY_FILE), "core/registry/rules.json must exist");
    const raw = fs.readFileSync(RULES_REGISTRY_FILE, 'utf8');
    let ledger: any;
    assert.doesNotThrow(() => {
      ledger = JSON.parse(raw);
    }, 'rules.json must parse cleanly as JSON');

    const result = validateRulesRegistry(ledger, REPO);
    assert.equal(result.ok, true, `rules.json validation errors:\n  ${result.errors.join('\n  ')}`);
  });

  test('all markdown rule files under core/shared/guidance/ are referenced by rules.json', () => {
    const ledger = JSON.parse(fs.readFileSync(RULES_REGISTRY_FILE, 'utf8'));
    const registeredSources = new Set(ledger.rules.map((r: any) => r.sourceFile));

    // Derived from the tree, so a rule file added later cannot go unregistered.
    const expectedFiles = [
      ...fs.readdirSync(RULES_DIR).filter((name: string) => name.endsWith('.md')).sort()
        .map((name: string) => `core/shared/guidance/rules/${name}`),
      'core/shared/guidance/PRINCIPLES.md',
    ];
    assert.ok(expectedFiles.length > 1, 'no rule file found under core/shared/guidance/rules/');

    for (const relFile of expectedFiles) {
      assert.ok(
        registeredSources.has(relFile),
        `Guidance file '${relFile}' must be referenced by at least one rule in core/registry/rules.json`
      );
    }
  });

  test('all 7 mandatory safety invariants carry neverAblate: true and ablationCandidate: false', () => {
    const ledger = JSON.parse(fs.readFileSync(RULES_REGISTRY_FILE, 'utf8'));
    for (const safetyId of MANDATORY_SAFETY_RULES) {
      const rule = ledger.rules.find((r: any) => r.id === safetyId);
      assert.ok(rule, `Mandatory safety rule '${safetyId}' must exist in rules.json`);
      assert.equal(rule.neverAblate, true, `Safety rule '${safetyId}' must have neverAblate === true`);
      assert.equal(rule.ablationCandidate, false, `Safety rule '${safetyId}' must have ablationCandidate === false`);
    }
  });

  test('disjoint invariant: zero rules have both neverAblate === true and ablationCandidate === true', () => {
    const ledger = JSON.parse(fs.readFileSync(RULES_REGISTRY_FILE, 'utf8'));
    for (const rule of ledger.rules) {
      assert.equal(
        rule.neverAblate && rule.ablationCandidate,
        false,
        `Rule '${rule.id}' violates disjoint invariant: cannot have both neverAblate: true and ablationCandidate: true`
      );
    }
  });
});

/** The cover findings of a ledger over a tree, as `path:line` locators with the covering row ids. */
function coverFindings(ledger: any, repoRoot: string = REPO): string[] {
  const files = ruleSourceFiles(repoRoot).map((p: string) => ({ path: p, text: fs.readFileSync(path.join(repoRoot, p), 'utf8') }));
  return coverRuleLines(files, ledger).map((f: any) => `${f.path}:${f.line} ${f.kind}${f.rows.length ? ` (${f.rows.join(', ')})` : ''}`);
}

describe('Guard G71 coverage: every rule line lies in exactly one ledger row', () => {
  test('the 13 skill directories and core/shared/guidance have no uncovered or double-covered rule line', () => {
    const ledger = JSON.parse(fs.readFileSync(RULES_REGISTRY_FILE, 'utf8'));
    const sources = ruleSourceFiles(REPO);
    assert.ok(sources.some((p: string) => p.startsWith('core/shared/skills/')) && sources.some((p: string) => p.startsWith('core/shared/guidance/')), 'both trees are scanned');
    assert.deepEqual(coverFindings(ledger), []);
  });

  test('control: a rule line planted in a temp copy of a skill is reported at its path:line, and removing its row elsewhere is too', (t: any) => {
    const tmp = tempDir(t, 'doflow-g71-cover-');
    for (const rel of ruleSourceFiles(REPO)) {
      fs.mkdirSync(path.join(tmp, path.dirname(rel)), { recursive: true });
      fs.copyFileSync(path.join(REPO, rel), path.join(tmp, rel));
    }
    const ledger = JSON.parse(fs.readFileSync(RULES_REGISTRY_FILE, 'utf8'));
    assert.deepEqual(coverFindings(ledger, tmp), [], 'the unplanted copy is clean');
    const target = 'core/shared/skills/do-test/SKILL.md';
    const before = fs.readFileSync(path.join(tmp, target), 'utf8');
    fs.writeFileSync(path.join(tmp, target), `${before.trimEnd()}\n\nNever plant an unmarked rule in a skill.\n`);
    const line = fs.readFileSync(path.join(tmp, target), 'utf8').split('\n').findIndex((l: string) => l.startsWith('Never plant')) + 1;
    assert.deepEqual(coverFindings(ledger, tmp), [`${target}:${line} uncovered`]);

    // A row dropped from the ledger leaves its own line uncovered, named by path:line.
    const dropped = ledger.rules.find((r: any) => r.id === 'rule-safety-temporal-awareness');
    const fewer = { ...ledger, rules: ledger.rules.filter((r: any) => r.id !== dropped.id) };
    assert.ok(coverFindings(fewer, REPO).some((f: string) => f.startsWith('core/shared/guidance/rules/RULES.md:')), 'a dropped row is reported');
  });

  test('control: a planted row with neither a valid check nor a reason is reported naming its rule id', () => {
    const ledger = JSON.parse(fs.readFileSync(RULES_REGISTRY_FILE, 'utf8'));
    const planted = { ...ledger.rules.find((r: any) => r.enforcement === 'judgement-only'), id: 'rule-planted-unmarked', enforcementRef: null, reason: null };
    const res = validateRulesRegistry({ ...ledger, rules: [...ledger.rules, planted] });
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /rule 'rule-planted-unmarked': a judgement-only row needs a one-line reason/);
  });
});

describe('Guard G71 Negative Controls (Planted Invariant Failures)', () => {
  const validLedger = () => JSON.parse(fs.readFileSync(RULES_REGISTRY_FILE, 'utf8'));

  test('rejects ledger with version !== 2', () => {
    const ledger = validLedger();
    ledger.version = 1;
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /must be 2/);
  });

  test('rejects a rule left at the version 1 value advisory, naming the rule id', () => {
    const ledger = validLedger();
    ledger.rules[0].enforcement = 'advisory';
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /must be one of \[check, judgement-only, not-a-rule\]/);
    assert.match(res.errors.join('\n'), new RegExp(`rule '${ledger.rules[0].id}': must be one of`));
  });

  test('rejects a judgement-only row with no reason and a check row naming a missing file', () => {
    const ledger = validLedger();
    const judgement = ledger.rules.find((r: any) => r.enforcement === 'judgement-only');
    const check = ledger.rules.find((r: any) => r.enforcement === 'check');
    judgement.reason = null;
    check.enforcementRef = 'src/runtime/no-such-enforcer.ts';
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), new RegExp(`rule '${judgement.id}': a judgement-only row needs a one-line reason`));
    assert.match(res.errors.join('\n'), new RegExp(`rule '${check.id}': referenced enforcement file does not exist`));
  });

  test('rejects a check row whose enforcement file exists but is not under a package.json files entry', () => {
    const ledger = validLedger();
    const check = ledger.rules.find((r: any) => r.enforcement === 'check');
    check.enforcementRef = 'test/guards/scaffold.test.ts';
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), new RegExp(`rule '${check.id}': enforcement file 'test/guards/scaffold.test.ts' is not under a package.json files entry`));
  });

  test('rejects ledger with invalid rule ID format', () => {
    const ledger = validLedger();
    ledger.rules[0].id = 'Invalid_CamelCase_Rule';
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /must be kebab-case/);
  });

  test('rejects ledger with duplicate rule IDs', () => {
    const ledger = validLedger();
    ledger.rules.push({ ...ledger.rules[0] });
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /duplicate rule id/);
  });

  test('rejects ledger with unknown rule category', () => {
    const ledger = validLedger();
    ledger.rules[0].category = 'unsupported-category';
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /must be one of/);
  });

  test('rejects ledger violating disjoint invariant (neverAblate && ablationCandidate both true)', () => {
    const ledger = validLedger();
    // Find a non-safety candidate and set both to true
    const candidate = ledger.rules.find((r: any) => !r.neverAblate);
    assert.ok(candidate, 'Must find a candidate rule');
    candidate.neverAblate = true;
    candidate.ablationCandidate = true;
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /neverAblate and ablationCandidate cannot both be true/);
  });

  test('rejects ledger where a mandatory safety rule has neverAblate === false', () => {
    const ledger = validLedger();
    const safety = ledger.rules.find((r: any) => r.id === 'rule-safety-temporal-awareness');
    assert.ok(safety, 'Must find temporal awareness safety rule');
    safety.neverAblate = false;
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /mandatory safety rule must have neverAblate: true/);
  });

  test('rejects ledger when statement is missing from declared sourceFile', () => {
    const ledger = validLedger();
    ledger.rules[0].statement = 'This completely invented text does not exist anywhere in the guidance source file.';
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /not found in sourceFile/);
  });

  test('rejects ledger when declared sourceFile does not exist on disk', () => {
    const ledger = validLedger();
    ledger.rules[0].sourceFile = 'core/shared/guidance/rules/NON_EXISTENT_RULE.md';
    const res = validateRulesRegistry(ledger);
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /declared sourceFile does not exist/);
  });
});
