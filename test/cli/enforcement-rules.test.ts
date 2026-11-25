'use strict';

// Row 181 J.3, IC-020: `doflow enforcement --rules`. The counting runs on temp-dir fixture trees through
// `ruleReport`; the verb itself runs on the real tree (its exit code is not asserted there: the real ledger
// is completed by a later task).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { createScratch, childEnv } = require('../helper/scratch-env.ts');
const { ruleReport, renderRuleReport } = require('../../src/runtime/guidance/rule-ledger.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');

const SKILL = 'core/shared/skills/do-x/SKILL.md';
const SKILL_EXTRA = 'core/shared/skills/do-x/references/notes.md';
const GUIDE = 'core/shared/guidance/RULES.md';

const row = (id: string, statement: string, sourceFile: string, extra: any = {}) => ({
  id, tag: 'x', statement, sourceFile, category: 'workflow', enforcement: 'judgement-only', enforcementRef: null,
  reason: 'prose only', neverAblate: false, ablationCandidate: false, ...extra,
});

/** A fixture tree: three markdown files with two rule lines in the skill, one in its reference, one in the guide. */
function fixture(scratch: any, rules: any[], files: Record<string, string> = {}) {
  const root = path.join(scratch.dir, 'tree');
  const tree: Record<string, string> = {
    [SKILL]: 'Intro line.\nNever skip the gate.\nMiddle.\nYou MUST run the check.\n',
    [SKILL_EXTRA]: 'Do not guess the path.\n',
    [GUIDE]: 'Always read first.\nPlain line.\n',
    'src/guard.test.ts': '// a guard\n',
    ...files,
  };
  for (const [rel, text] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  fs.mkdirSync(path.join(root, 'core/registry'), { recursive: true });
  fs.writeFileSync(path.join(root, 'core/registry/rules.json'), JSON.stringify({ version: 2, description: 'fixture', rules }));
  return root;
}

const full = () => [
  row('gate', 'Never skip the gate.', SKILL, { enforcement: 'check', enforcementRef: 'src/guard.test.ts', reason: null }),
  row('run', 'You MUST run the check.', SKILL),
  row('guess', 'Do not guess the path.', SKILL_EXTRA, { enforcement: 'not-a-rule', reason: 'a heading, not an instruction' }),
  row('read', 'Always read first.', GUIDE),
];

describe('ruleReport on a fixture tree', () => {
  test('a fully covered ledger counts per enforcement value and per file, and neither is 0', () => {
    const scratch = createScratch('doflow-rules-');
    try {
      const report = ruleReport(fixture(scratch, full()));
      assert.deepEqual({ ...report, files: undefined }, { total: 4, check: 1, judgementOnly: 2, notARule: 1, neither: 0, files: undefined, uncovered: [] });
      assert.deepEqual(report.files, [
        { path: GUIDE, check: 0, judgementOnly: 1, notARule: 0, neither: 0 },
        { path: SKILL, check: 1, judgementOnly: 1, notARule: 0, neither: 0 },
        { path: SKILL_EXTRA, check: 0, judgementOnly: 0, notARule: 1, neither: 0 },
      ]);
    } finally { scratch.remove(); }
  });

  test('a planted rule line no row covers counts under neither and is listed with its path and line', () => {
    const scratch = createScratch('doflow-rules-');
    try {
      const report = ruleReport(fixture(scratch, full(), { [GUIDE]: 'Always read first.\nNever plant this.\n' }));
      assert.equal(report.neither, 1);
      assert.deepEqual(report.uncovered, [{ path: GUIDE, line: 2 }]);
      assert.equal(report.check + report.judgementOnly + report.notARule + report.neither, report.total + report.uncovered.length, 'the counts sum to total plus uncovered hits');
      assert.equal(report.files.find((f: any) => f.path === GUIDE).neither, 1);
    } finally { scratch.remove(); }
  });

  test('a row with no valid enforcement counts under neither: a check naming a missing file, a judgement-only row with no reason', () => {
    const scratch = createScratch('doflow-rules-');
    try {
      const rules = full();
      rules[0] = row('gate', 'Never skip the gate.', SKILL, { enforcement: 'check', enforcementRef: 'src/missing.test.ts', reason: null });
      rules[1] = row('run', 'You MUST run the check.', SKILL, { reason: null });
      const report = ruleReport(fixture(scratch, rules));
      assert.equal(report.neither, 2);
      assert.equal(report.check, 0);
      assert.equal(report.judgementOnly, 1);
      assert.equal(report.files.find((f: any) => f.path === SKILL).neither, 2);
    } finally { scratch.remove(); }
  });

  test('a line two rows both span is neither too, and a file with only uncovered hits is in the breakdown', () => {
    const scratch = createScratch('doflow-rules-');
    try {
      const rules = [...full(), row('gate-again', 'Never skip the gate.', SKILL)];
      const report = ruleReport(fixture(scratch, rules, { 'core/shared/guidance/EXTRA.md': 'Never forget.\n' }));
      assert.deepEqual(report.uncovered, [{ path: 'core/shared/guidance/EXTRA.md', line: 1 }, { path: SKILL, line: 2 }]);
      assert.equal(report.neither, 2);
      assert.ok(report.files.some((f: any) => f.path === 'core/shared/guidance/EXTRA.md' && f.neither === 1));
    } finally { scratch.remove(); }
  });

  test('two runs over the same tree give the same text', () => {
    const scratch = createScratch('doflow-rules-');
    try {
      const root = fixture(scratch, full());
      assert.equal(renderRuleReport(ruleReport(root)).join('\n'), renderRuleReport(ruleReport(root)).join('\n'));
      assert.deepEqual(renderRuleReport(ruleReport(root)).slice(0, 4), ['check 1', 'judgement-only 2', 'not-a-rule 1', 'neither 0']);
    } finally { scratch.remove(); }
  });
});

describe('doflow enforcement --rules', () => {
  function run(...args: string[]) {
    const scratch = createScratch('doflow-rules-cli-');
    try { return cp.spawnSync(process.execPath, [CLI, 'enforcement', ...args], { cwd: scratch.dir, env: childEnv(scratch), encoding: 'utf8' }); } finally { scratch.remove(); }
  }

  test('on the real tree the text names every enforcement value and each ledger file, byte-identical across two runs', () => {
    const first = run('--rules');
    assert.ok(first.status === 0 || first.status === 1, first.stdout + first.stderr);
    const lines = first.stdout.trimEnd().split('\n');
    assert.match(lines[0], /^check \d+$/);
    assert.match(lines[1], /^judgement-only \d+$/);
    assert.match(lines[2], /^not-a-rule \d+$/);
    assert.match(lines[3], /^neither \d+$/);
    assert.match(lines[4], /^core\/shared\/guidance\/.*: check \d+, judgement-only \d+, not-a-rule \d+, neither \d+$/);
    const ledger = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../core/registry/rules.json'), 'utf8'));
    for (const file of new Set(ledger.rules.map((r: any) => r.sourceFile))) assert.ok(first.stdout.includes(`${file}: `), `${file} is in the breakdown`);
    const second = run('--rules');
    assert.equal(second.stdout, first.stdout);
    assert.equal(second.status, first.status);
  });

  test('--json prints ok, the counts and the breakdown; the four counts sum to total plus uncovered', () => {
    const result = run('--rules', '--json');
    const { ok, rules } = JSON.parse(result.stdout);
    assert.equal(ok, rules.neither === 0);
    assert.equal(result.status, ok ? 0 : 1);
    assert.equal(rules.check + rules.judgementOnly + rules.notARule + rules.neither, rules.total + rules.uncovered.length);
    assert.ok(rules.files.length > 0);
  });

  for (const extra of [['--harness', 'claude'], ['--policy', 'mcp-tool-guard'], ['--profile', 'x']]) {
    test(`--rules with ${extra[0]} is a usage error (exit 2)`, () => {
      const result = run('--rules', ...extra);
      assert.equal(result.status, 2, result.stdout + result.stderr);
      assert.match(result.stderr, /--rules cannot be combined with/);
    });
  }

  test('without --rules the verb still asks for --harness and --policy, and --rules is unknown on another verb', () => {
    const bare = run();
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /requires --harness <id> --policy <id>/);
    const scratch = createScratch('doflow-rules-cli-');
    try {
      const other = cp.spawnSync(process.execPath, [CLI, 'capabilities', '--rules'], { cwd: scratch.dir, env: childEnv(scratch), encoding: 'utf8' });
      assert.notEqual(other.status, 0);
      assert.match(other.stderr, /unknown flag '--rules'/);
    } finally { scratch.remove(); }
  });
});
