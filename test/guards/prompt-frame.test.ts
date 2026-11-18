'use strict';

// G85 — the common prompt frame's text stays vendor-neutral and its guide stays small (row 173, design §7.3).
// T7 holds the first check: no vendor or model name in the guide and the four guidance files that the frame's
// pointer edits touched. T8 extends this file with the fixture checks (sections, placeholders, reasoning request,
// guide parity) over the composed prompts.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..', '..');

/** Design §7.3 check 5: the vendor and model names no frame text may carry (word boundary, case-sensitive). */
const VENDOR_NAMES: readonly string[] = [
  'Anthropic', 'OpenAI', 'Google', 'Amazon', 'Claude', 'GPT', 'Gemini', 'Codex', 'Copilot', 'Kiro', 'OpenCode',
  'Antigravity', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'Mythos',
];
const VENDOR_PATTERN = new RegExp(`\\b(?:${VENDOR_NAMES.join('|')})\\b`, 'g');

/** The files the check covers, as repo-relative paths. */
const NEUTRAL_FILES: readonly string[] = [
  'core/shared/guidance/references/PROMPT_FRAME.md',
  'core/shared/guidance/references/ORCHESTRATION.md',
  'core/shared/guidance/references/MODEL_SELECTION.md',
  'core/shared/guidance/modes/MODE_Task_Management.md',
  'core/shared/agent-specs/delivery-lead.md',
];

/**
 * Every vendor or model name on a line of `text`.
 * @param {string} text
 * @returns {string[]} one `<line>: <name>` entry per hit
 */
function vendorHits(text: string): string[] {
  const hits: string[] = [];
  text.split('\n').forEach((line, i) => {
    for (const match of line.matchAll(VENDOR_PATTERN)) hits.push(`${i + 1}: ${match[0]}`);
  });
  return hits;
}

test('G85: the guide and the pointer-edited guidance files name no vendor or model', () => {
  const found: string[] = [];
  for (const rel of NEUTRAL_FILES) {
    const file = path.join(REPO, rel);
    assert.ok(fs.existsSync(file), `${rel} exists`);
    for (const hit of vendorHits(fs.readFileSync(file, 'utf8'))) found.push(`${rel}:${hit}`);
  }
  assert.deepEqual(found, []);
});

test('G85 control: the vendor check flags each listed name, by word and by case', () => {
  for (const name of VENDOR_NAMES) assert.deepEqual(vendorHits(`before\nuse ${name} here`), [`2: ${name}`], name);
  assert.deepEqual(vendorHits('a claude-free line, a Claudette, GPTs and an opus'), [], 'lower case and longer words pass');
});
