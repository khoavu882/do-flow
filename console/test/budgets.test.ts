'use strict';

// Byte budget of the Console stylesheet (row 180, FR-B5). web/app.css is held to APP_CSS_BUDGET bytes, and
// DESIGN-v2.md section 11 states the same number with the size measured, the date, the commit and the reason
// it is above 128 KiB. A planted over-budget copy and a section 11 number that differs from the constant are
// both reported, so the guard cannot pass by reading the wrong file or the wrong sentence.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CONSOLE_ROOT = path.join(__dirname, '..');
const APP_FILE = path.join(CONSOLE_ROOT, 'web', 'app.css');
const DESIGN_V2_FILE = path.join(CONSOLE_ROOT, 'DESIGN-v2.md');

/** The budget of web/app.css in bytes; DESIGN-v2.md section 11 states the same number. */
const APP_CSS_BUDGET = 155648;

/** Why a stylesheet is over its budget, or null when it fits; bytes on disk, so a multi-byte character counts as its encoded length. */
function overBudget(file: string, budget: number): string | null {
  const bytes = fs.statSync(file).size;
  return bytes <= budget ? null : `${path.basename(file)} is ${bytes} bytes, over its budget of ${budget}`;
}

/** The `app.css` budget section 11 of DESIGN-v2.md states, in bytes, or null when the section states none. */
function section11Budget(markdown: string): number | null {
  const start = markdown.search(/^## 11\./m);
  if (start === -1) return null;
  const rest = markdown.slice(start + 1);
  const next = rest.search(/^## /m);
  const section = next === -1 ? rest : rest.slice(0, next);
  const match = section.match(/`app\.css` budget:\s*\*\*([\d,]+) bytes\*\*/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

test('web/app.css stays within APP_CSS_BUDGET bytes', () => {
  assert.equal(overBudget(APP_FILE, APP_CSS_BUDGET), null);
});

test('DESIGN-v2.md section 11 states the same budget as APP_CSS_BUDGET', () => {
  assert.equal(section11Budget(fs.readFileSync(DESIGN_V2_FILE, 'utf8')), APP_CSS_BUDGET);
});

test('control: a planted copy one byte over the budget is reported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'console-budget-'));
  try {
    const planted = path.join(dir, 'app.css');
    const css: string = fs.readFileSync(APP_FILE, 'utf8');
    fs.writeFileSync(planted, css + ' '.repeat(Math.max(1, APP_CSS_BUDGET + 1 - Buffer.byteLength(css))));
    assert.match(overBudget(planted, APP_CSS_BUDGET) ?? '', /^app\.css is \d+ bytes, over its budget of \d+$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('control: a section 11 number that differs from the constant, or no number, is reported', () => {
  const text: string = fs.readFileSync(DESIGN_V2_FILE, 'utf8');
  const planted = text.replace(/(`app\.css` budget:\s*\*\*)[\d,]+( bytes\*\*)/, `$1${APP_CSS_BUDGET + 4096}$2`);
  assert.ok(planted !== text, 'the mutation applied');
  assert.notEqual(section11Budget(planted), APP_CSS_BUDGET);
  assert.equal(section11Budget(text.replace(/`app\.css` budget:/g, 'the stylesheet budget:')), null);
  assert.equal(section11Budget('# Title\n\n## 10. Other\n\n`app.css` budget: **1 bytes**\n'), null, 'a number outside section 11 does not count');
});
