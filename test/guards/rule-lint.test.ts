'use strict';

// G70 — duplicate rule lint across the guidance tree (Feature 107-C, IC-004, FR-005).
//
// Rules defined under `core/shared/guidance/rules/` are the authoritative source of engineering
// invariants. Substantive rule statements (>50 characters) must never be defined verbatim in two
// always-loaded files (the rule files and PRINCIPLES.md), nor copied into skill files under
// `core/shared/skills/` without explicitly citing the canonical rule (e.g. RULE_01, RULE_02, etc.).
// A rule's tag is its `## RULE_NN` section heading in rules/RULES.md, else the file's RULE_NN prefix.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO, GUIDANCE, SKILLS } = require('./_shared.ts');
const { suiteTempDir } = require('../helper/tmp.ts');

const RULES_DIR = path.join(GUIDANCE, 'rules');
const SKILLS_DIR = SKILLS;
const PRINCIPLES_FILE = path.join(GUIDANCE, 'PRINCIPLES.md');
const MIN_STATEMENT_LENGTH = 50;

interface RuleStatement {
  file: string;
  ruleTag: string;
  text: string;
  line: number;
}

interface CrossRuleDuplicateFinding {
  statement: string;
  first: { file: string; line: number };
  duplicate: { file: string; line: number };
}

interface SkillRuleDuplicateFinding {
  skillFile: string;
  ruleFile: string;
  ruleTag: string;
  statement: string;
}

function cleanStatementText(text: string): string {
  return text
    .replace(/^[-*+]\s+/, '')
    .replace(/^\d+\.\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractSubstantiveStatements(content: string, filePath: string): RuleStatement[] {
  const lines = content.split(/\r?\n/);
  const statements: RuleStatement[] = [];
  const baseName = path.basename(filePath, '.md');
  const ruleTagMatch = baseName.match(/^(RULE_\d+)/);
  const fileTag = ruleTagMatch ? ruleTagMatch[1] : baseName;
  let ruleTag = fileTag;

  let inFence = false;
  let currentLines: string[] = [];
  let blockStartLine = 1;

  const flushBlock = () => {
    if (currentLines.length === 0) return;
    const rawText = currentLines.join(' ');
    currentLines = [];
    const cleaned = cleanStatementText(rawText);
    if (!cleaned) return;

    const seenInBlock = new Set<string>();

    if (cleaned.length > MIN_STATEMENT_LENGTH) {
      statements.push({
        file: filePath,
        ruleTag,
        text: cleaned,
        line: blockStartLine,
      });
      seenInBlock.add(cleaned);
    }

    const sentences = cleaned
      .split(/(?<=[.!?])\s+/)
      .map((s) => s.trim().replace(/^[-*+]\s+/, ''))
      .filter((s) => s.length > MIN_STATEMENT_LENGTH);

    for (const sentence of sentences) {
      if (!seenInBlock.has(sentence)) {
        statements.push({
          file: filePath,
          ruleTag,
          text: sentence,
          line: blockStartLine,
        });
        seenInBlock.add(sentence);
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      flushBlock();
      continue;
    }
    if (inFence) continue;

    const trimmed = line.trim();
    // A `## RULE_NN` section sets the tag; any other level-1 or level-2 heading ends it.
    const sectionTag = trimmed.match(/^#{1,6}\s+(RULE_\d+)\b/);
    if (sectionTag || /^#{1,2}\s+/.test(trimmed)) {
      flushBlock();
      ruleTag = sectionTag ? sectionTag[1] : fileTag;
      continue;
    }
    if (!trimmed || trimmed.startsWith('<') || trimmed.startsWith('<!--') || /^#{1,6}\s+/.test(trimmed)) {
      flushBlock();
      continue;
    }

    const isNewItem = /^[-*+]\s+/.test(trimmed) || /^\d+\.\s+/.test(trimmed) || /^\*\*[^*]+?\*\*:\s*/.test(trimmed);
    if (isNewItem && currentLines.length > 0) {
      flushBlock();
    }

    if (currentLines.length === 0) {
      blockStartLine = lineNum;
    }
    currentLines.push(trimmed);
  }

  flushBlock();
  return statements;
}

function findCrossRuleDuplicates(rulesDir: string, extraFiles: string[] = []): CrossRuleDuplicateFinding[] {
  let ruleFiles: string[] = [];
  try {
    ruleFiles = fs.readdirSync(rulesDir)
      .filter((name: string) => name.endsWith('.md'))
      .sort()
      .map((name: string) => path.join(rulesDir, name));
  } catch {
    return [];
  }

  const seenStatements = new Map<string, { file: string; line: number }>();
  const duplicates: CrossRuleDuplicateFinding[] = [];

  for (const fullPath of [...ruleFiles, ...extraFiles]) {
    const content = fs.readFileSync(fullPath, 'utf8');
    const statements = extractSubstantiveStatements(content, fullPath);

    for (const stmt of statements) {
      const key = stmt.text.replace(/[*`_]/g, '').toLowerCase();
      const existing = seenStatements.get(key);
      if (existing) {
        if (existing.file !== stmt.file) {
          duplicates.push({
            statement: stmt.text,
            first: existing,
            duplicate: { file: stmt.file, line: stmt.line },
          });
        }
      } else {
        seenStatements.set(key, { file: stmt.file, line: stmt.line });
      }
    }
  }

  return duplicates;
}

function skillCitesRule(skillContent: string, ruleTag: string): boolean {
  if (ruleTag && new RegExp(`\\b${ruleTag}\\b`, 'i').test(skillContent)) {
    return true;
  }
  if (/\bRULE_\d+\b/i.test(skillContent)) {
    return true;
  }
  return false;
}

function findSkillRuleDuplicates(rulesDir: string, skillsDir: string): SkillRuleDuplicateFinding[] {
  let ruleFiles: string[] = [];
  try {
    ruleFiles = fs.readdirSync(rulesDir)
      .filter((name: string) => name.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }

  const ruleStatements: RuleStatement[] = [];
  for (const name of ruleFiles) {
    const fullPath = path.join(rulesDir, name);
    const content = fs.readFileSync(fullPath, 'utf8');
    ruleStatements.push(...extractSubstantiveStatements(content, fullPath));
  }

  let skillDirs: string[] = [];
  try {
    skillDirs = fs.readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry: any) => entry.isDirectory())
      .map((entry: any) => entry.name)
      .sort();
  } catch {
    return [];
  }

  const findings: SkillRuleDuplicateFinding[] = [];

  for (const skillName of skillDirs) {
    const skillPath = path.join(skillsDir, skillName, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    const skillContent = fs.readFileSync(skillPath, 'utf8');
    const normalizedSkill = skillContent.replace(/\s+/g, ' ');

    for (const stmt of ruleStatements) {
      const plainStatement = stmt.text.replace(/[*`_]/g, '').trim();
      const verbatimMatch = normalizedSkill.includes(stmt.text) ||
        (plainStatement.length > MIN_STATEMENT_LENGTH && normalizedSkill.includes(plainStatement));

      if (verbatimMatch) {
        if (!skillCitesRule(skillContent, stmt.ruleTag)) {
          findings.push({
            skillFile: path.relative(REPO, skillPath).split(path.sep).join('/'),
            ruleFile: path.relative(REPO, stmt.file).split(path.sep).join('/'),
            ruleTag: stmt.ruleTag,
            statement: stmt.text,
          });
        }
      }
    }
  }

  return findings;
}

test('G70: no two core rule files (rules/ and PRINCIPLES.md) define the same rule statement verbatim', () => {
  const duplicates = findCrossRuleDuplicates(RULES_DIR, [PRINCIPLES_FILE]);
  assert.deepEqual(duplicates, [],
    `duplicate rule statements found across core rules:\n${JSON.stringify(duplicates, null, 2)}`);
});

test('G70: no skill file duplicates a core rule statement verbatim without citing the rule', () => {
  const duplicates = findSkillRuleDuplicates(RULES_DIR, SKILLS_DIR);
  assert.deepEqual(duplicates, [],
    `skill files duplicate core rule statements verbatim without citation:\n${JSON.stringify(duplicates, null, 2)}`);
});

describe('G70 negative controls', () => {
  test('detects verbatim duplicate rule statements across rule files', () => {
    const tempDir = suiteTempDir('doflow-rulelint-rule-ctrl-');
    const statement = 'Start it = Finish it. No partial features, TODO stubs, mocks, or "not implemented" throws.';

    fs.writeFileSync(path.join(tempDir, 'RULE_01_A.md'), `# Rule A\n\n- ${statement}\n`);
    fs.writeFileSync(path.join(tempDir, 'RULE_02_B.md'), `# Rule B\n\n- ${statement}\n`);

    const duplicates = findCrossRuleDuplicates(tempDir);
    assert.ok(duplicates.length >= 1);
    assert.match(duplicates[0].statement, /Start it = Finish it/);
  });

  test('detects un-cited rule duplication in skills while allowing cited duplication', () => {
    const tempDir = suiteTempDir('doflow-rulelint-skill-ctrl-');
    const rulesDir = path.join(tempDir, 'rules');
    const skillsDir = path.join(tempDir, 'skills');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });

    const statement = 'Read the date from the environment before any temporal claim; never infer it from your knowledge cutoff, and state its source.';
    fs.writeFileSync(path.join(rulesDir, 'RULE_01_SAFETY.md'), `# Safety\n\n- ${statement}\n`);

    const unCitedDir = path.join(skillsDir, 'do-uncited');
    fs.mkdirSync(unCitedDir, { recursive: true });
    fs.writeFileSync(path.join(unCitedDir, 'SKILL.md'), `# Uncited Skill\n\n- ${statement}\n`);

    const unCitedFindings = findSkillRuleDuplicates(rulesDir, skillsDir);
    assert.equal(unCitedFindings.length, 1);
    assert.equal(unCitedFindings[0].ruleTag, 'RULE_01');

    const citedDir = path.join(skillsDir, 'do-cited');
    fs.mkdirSync(citedDir, { recursive: true });
    fs.writeFileSync(path.join(citedDir, 'SKILL.md'), `# Cited Skill\n\nAs specified in RULE_01:\n- ${statement}\n`);

    const findingsWithBoth = findSkillRuleDuplicates(rulesDir, skillsDir);
    assert.equal(findingsWithBoth.length, 1);
    assert.match(findingsWithBoth[0].skillFile, /do-uncited/);
  });

  test('detects a rule statement repeated verbatim in PRINCIPLES.md', () => {
    const tempDir = suiteTempDir('doflow-rulelint-principles-ctrl-');
    const rulesDir = path.join(tempDir, 'rules');
    fs.mkdirSync(rulesDir, { recursive: true });
    const statement = 'Start it = Finish it. No partial features, TODO stubs, mocks, or "not implemented" throws.';
    fs.writeFileSync(path.join(rulesDir, 'RULES.md'), `# Rules\n\n## RULE_02 Workflow\n- ${statement}\n`);
    const principles = path.join(tempDir, 'PRINCIPLES.md');
    fs.writeFileSync(principles, `# Principles\n\n${statement}\n`);
    assert.deepEqual(findCrossRuleDuplicates(rulesDir), []);
    const duplicates = findCrossRuleDuplicates(rulesDir, [principles]);
    assert.equal(duplicates.length >= 1, true);
    assert.equal(duplicates[0].duplicate.file, principles);
  });

  test('a statement in one RULES.md takes its tag from its RULE_NN section heading', () => {
    const tempDir = suiteTempDir('doflow-rulelint-section-ctrl-');
    const rulesDir = path.join(tempDir, 'rules');
    const skillsDir = path.join(tempDir, 'skills', 'do-uncited');
    fs.mkdirSync(rulesDir, { recursive: true });
    fs.mkdirSync(skillsDir, { recursive: true });
    const statement = 'Read the date from the environment before any temporal claim; never infer it from your knowledge cutoff, and state its source.';
    fs.writeFileSync(path.join(rulesDir, 'RULES.md'), `# Rules\n\n## RULE_01 Safety\n- ${statement}\n\n## RULE_03 Quality\n- Short.\n`);
    fs.writeFileSync(path.join(skillsDir, 'SKILL.md'), `# Uncited Skill\n\nThese rules apply:\n- ${statement}\n`);
    const findings = findSkillRuleDuplicates(rulesDir, path.join(tempDir, 'skills'));
    assert.equal(findings.length, 1, 'the plain word "rules" is not a citation');
    assert.equal(findings[0].ruleTag, 'RULE_01');
  });

  test('ignores short statements (<= 50 characters)', () => {
    const tempDir = suiteTempDir('doflow-rulelint-short-ctrl-');
    const shortStmt = 'Short rule snippet.';
    fs.writeFileSync(path.join(tempDir, 'RULE_01_A.md'), `# Rule A\n\n- ${shortStmt}\n`);
    fs.writeFileSync(path.join(tempDir, 'RULE_02_B.md'), `# Rule B\n\n- ${shortStmt}\n`);

    const duplicates = findCrossRuleDuplicates(tempDir);
    assert.equal(duplicates.length, 0);
  });
});
