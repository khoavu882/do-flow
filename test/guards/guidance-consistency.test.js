'use strict';

// G47 — guidance statements whose wording must stay aligned across the shared corpus.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '../..');
const GUIDANCE = 'core/shared/guidance';
const POLICIES = 'core/harnesses/shared/hooks/policies';
const BASELINE_THRESHOLD = '- **3+ files**: Auto-suggest parallel processing';
const FIXED_THRESHOLD = '- **>3 files**: Auto-suggest parallel processing';
const BASELINE_ENFORCEMENT = '3. BLOCK assumption-based configuration changes';
const FIXED_ENFORCEMENT = 'Do not change configuration on an assumption; verify it against the official documentation first';

function walkMarkdown(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walkMarkdown(rel, out);
    else if (entry.isFile() && rel.endsWith('.md')) out.push(rel);
  }
  return out;
}

const readGuidance = () => walkMarkdown(GUIDANCE).sort().map((rel) => ({
  rel,
  text: fs.readFileSync(path.join(REPO, rel), 'utf8'),
}));

const readPolicyScripts = () => new Set(fs.readdirSync(path.join(REPO, POLICIES), { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith('.sh'))
  .map((entry) => entry.name));

function thresholdMinimum(match) {
  if (match[2] !== undefined) return Number(match[2]) + 1; // >N
  if (match[3] !== undefined) return Number(match[3]); // N+
  if (match[4] !== undefined) return Number(match[4]) + 1; // more than N
  if (match[5] !== undefined) return Number(match[5]) + 1; // past N
  if (match[6] !== undefined) return Number(match[6]) + 1; // over N
  return Number(match[7]); // at least N
}

function checkThresholds(files) {
  if (!files.length) return ['G47.1: no guidance source files supplied'];

  const thresholds = new Map();
  const pattern = /(>\s*(\d+)|(\d+)\s*\+|more than\s+(\d+)|past\s+(\d+)|over\s+(\d+)|at least\s+(\d+))\s+(files|steps|tasks|directories)\b/gi;
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        const rawUnit = match[8].toLowerCase();
        const unit = rawUnit === 'steps' || rawUnit === 'tasks' ? 'steps/tasks' : rawUnit;
        if (!thresholds.has(unit)) thresholds.set(unit, []);
        thresholds.get(unit).push({ minimum: thresholdMinimum(match), rel, line: index + 1, phrase: match[0] });
      }
    });
  }

  if (!thresholds.size) return ['G47.1: found no threshold anchor'];
  const findings = [];
  for (const [unit, entries] of thresholds) {
    const minimums = [...new Set(entries.map(({ minimum }) => minimum))].sort((a, b) => a - b);
    if (minimums.length > 1) {
      const evidence = entries.map(({ rel, line, phrase }) => `${rel}:${line} "${phrase}"`).join(', ');
      findings.push(`G47.1 ${unit}: thresholds imply minimums ${minimums.join(' and ')} (${evidence})`);
    }
  }
  return findings;
}

function checkEnforcementWords(files, policyScripts) {
  if (!files.length) return ['G47.2: no guidance source files supplied'];
  if (!policyScripts.size) return ['G47.2: no shared policy scripts supplied'];

  const findings = [];
  const pattern = /\b(BLOCK|BLOCKS|BLOCKED|ENFORCED)\b/g;
  for (const { rel, text } of files) {
    text.split('\n').forEach((line, index) => {
      const words = [...line.matchAll(pattern)].map(([word]) => word);
      if (!words.length) return;
      const scripts = [...line.matchAll(/`([^`\s]+\.sh)`/g)].map(([, token]) => token);
      if (scripts.some((script) => policyScripts.has(script))) return;
      findings.push(`G47.2 ${rel}:${index + 1}: ${words.join(', ')} has no matching shared policy script`);
    });
  }
  return findings;
}

const guidanceFiles = readGuidance();
const policyScripts = readPolicyScripts();
const orchestrationRel = `${GUIDANCE}/modes/MODE_Orchestration.md`;
const replaceOnce = (text, from, to) => {
  assert.equal(text.split(from).length - 1, 1, `expected exactly one ${JSON.stringify(from)} anchor`);
  return text.replace(from, to);
};

test('G47.1: thresholds agree on the minimum for each unit', () => {
  assert.ok(guidanceFiles.length > 0, 'no shared guidance files read');
  assert.deepEqual(checkThresholds(guidanceFiles), []);
});

test('G47.1: re-seeding the baseline threshold reports the mismatch', () => {
  const seeded = guidanceFiles.map((file) => file.rel === orchestrationRel
    ? { ...file, text: replaceOnce(file.text, FIXED_THRESHOLD, BASELINE_THRESHOLD) }
    : file);
  const findings = checkThresholds(seeded);
  assert.equal(findings.length, 1);
  assert.match(findings[0], /G47\.1 files:.*minimums 3 and 4/);
  assert.match(findings[0], /3\+ files/);
});

test('G47.1: removing every threshold anchor is reported as vacuous', () => {
  assert.deepEqual(checkThresholds([{ rel: 'fixture.md', text: 'Ordinary guidance with no threshold.' }]), [
    'G47.1: found no threshold anchor',
  ]);
});

test('G47.2: enforcement words name an existing shared policy script on the same line', () => {
  assert.deepEqual(checkEnforcementWords(guidanceFiles, policyScripts), []);
});

test('G47.2: re-seeding the baseline enforcement word reports the ungrounded claim', () => {
  const seeded = guidanceFiles.map((file) => file.rel === orchestrationRel
    ? { ...file, text: replaceOnce(file.text, FIXED_ENFORCEMENT, BASELINE_ENFORCEMENT) }
    : file);
  const findings = checkEnforcementWords(seeded, policyScripts);
  assert.equal(findings.length, 1);
  assert.match(findings[0], new RegExp(`${orchestrationRel}:47`));
  assert.match(findings[0], /G47\.2 .*BLOCK has no matching shared policy script/);
});

test('G47.2: an existing backticked policy script exempts the same-line enforcement word', () => {
  assert.ok(policyScripts.size > 0, 'no shared policy scripts read');
  const script = [...policyScripts][0];
  assert.deepEqual(checkEnforcementWords([{
    rel: orchestrationRel,
    text: `${BASELINE_ENFORCEMENT} \`${script}\``,
  }], policyScripts), []);
});
