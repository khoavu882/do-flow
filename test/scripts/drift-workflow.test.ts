'use strict';
const JQ_B = process.platform === 'win32' ? ['-b'] : []; // native jq.exe ends lines with CRLF unless -b

// The comment text .github/workflows/drift.yml builds from the drift report. The jq program is read
// out of the workflow itself and run on fixture reports, so the shipped text is what is tested.
// Skipped when jq is not installed (GitHub's runners have it; a bare machine may not).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const WORKFLOW = path.join(__dirname, '..', '..', '.github', 'workflows', 'drift.yml');
const HAS_JQ = spawnSync('jq', ['--version']).status === 0;

function program() {
  const m = /jq -r(?: --argjson budget \d+)? '([\s\S]*?)' drift-report\.json/.exec(fs.readFileSync(WORKFLOW, 'utf8'));
  assert.ok(m, 'drift.yml no longer has a `jq -r ... drift-report.json` step this test can read');
  return m![1];
}

function comment(t: any, results: any, budget = 60000) {
  const dir = tempDir(t, 'doflow-driftwf-');
  const report = path.join(dir, 'drift-report.json');
  fs.writeFileSync(report, JSON.stringify({ results }));
  const run = spawnSync('jq', [...JQ_B, '-r', '--argjson', 'budget', String(budget), program(), report], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout;
}

const row = (url: any, diff: any, status = 'DRIFTED') => ({ url, status, claims: ['c'], diff });

test('a diff holding a backtick run is fenced with a longer one', { skip: !HAS_JQ && 'jq not installed' }, (t) => {
  const diff = '--- baseline\n+++ current\n@@ -1,2 +1,2 @@\n ````\n-old\n+new';
  const out = comment(t, [row('https://x.test/a', diff)]);
  const lines = out.split('\n');
  const open = lines.findIndex((l: any) => /^`{3,}diff$/.test(l));
  assert.ok(open >= 0, out);
  const fence = lines[open].slice(0, -'diff'.length);
  assert.ok(fence.length >= 5, `fence ${fence} must outrun the four-backtick line in the diff`);
  assert.equal(lines.indexOf(fence), open + 1 + diff.split('\n').length, 'the closing fence follows the whole diff');
  assert.equal(lines.filter((l: any) => l.startsWith(fence)).length, 2);
});

test('a plain diff keeps a three-backtick fence', { skip: !HAS_JQ && 'jq not installed' }, (t) => {
  const out = comment(t, [row('https://x.test/a', '--- baseline\n+++ current\n-a\n+b')]);
  assert.match(out, /^```diff$/m);
});

test('an empty diff is described as no visible diff', { skip: !HAS_JQ && 'jq not installed' }, (t) => {
  const out = comment(t, [row('https://x.test/a', '')]);
  assert.match(out, /no visible diff: change is beyond the snapshot cap or only in redacted paths/);
  assert.doesNotMatch(out, /change lies beyond/);
});

test('a missing snapshot is described as such', { skip: !HAS_JQ && 'jq not installed' }, (t) => {
  assert.match(comment(t, [row('https://x.test/a', null)]), /no snapshot to diff against/);
});

test('past the budget, whole rows are dropped and counted, never cut in the middle of a fence', { skip: !HAS_JQ && 'jq not installed' }, (t) => {
  const diff = ['--- baseline', '+++ current', '@@ -1,1 +1,1 @@', '-\u00e9\u00e9 old line', '+\u00e9\u00e9 new line'].join('\n');
  const rows = Array.from({ length: 6 }, (_, i) => row(`https://x.test/${i}`, diff));
  const whole = comment(t, rows);
  const oneRow = Buffer.byteLength(comment(t, rows.slice(0, 1)));
  const budget = oneRow * 3 + 10;
  const out = comment(t, rows, budget);
  assert.ok(Buffer.byteLength(out) <= budget + 80, 'output stays near the budget');
  assert.equal(out.split('\n').filter((l: any) => l === '```diff').length, 3, 'three whole rows kept');
  assert.equal(out.split('\n').filter((l: any) => l === '```').length, 3, 'every kept fence is closed');
  assert.match(out, /\(3 more rows truncated\)\n$/);
  assert.doesNotMatch(whole, /truncated/, 'a report under the budget is untouched');
  assert.doesNotMatch(out, /\uFFFD/, 'no UTF-8 character is cut');
});

test('STUB rows are listed with their note, beside the DRIFTED ones', { skip: !HAS_JQ && 'jq not installed' }, (t) => {
  const stub = { url: 'https://x.test/stub', status: 'STUB', claims: ['c'], diff: null, note: 'redirect stub: Redirecting to: /docs/mcp?tab=cli' };
  const out = comment(t, [stub, row('https://x.test/ok', null, 'OK'), row('https://x.test/d', '--- baseline\n+++ current\n-a\n+b')]);
  assert.match(out, /https:\/\/x\.test\/stub`\n {2}claims: c\n {2}\(redirect stub: Redirecting to: \/docs\/mcp\?tab=cli\)/);
  assert.match(out, /https:\/\/x\.test\/d`/);
  assert.doesNotMatch(out, /x\.test\/ok/);
});

test('the report is written by running the script directly, not through npm (npm prints a banner ahead of the JSON and jq exits 5)', () => {
  const src = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(src, /^\s*node scripts\/check-format-drift\.js --json > drift-report\.json$/m);
  assert.doesNotMatch(src, /npm run drift[^\n]*> drift-report\.json/);
});
