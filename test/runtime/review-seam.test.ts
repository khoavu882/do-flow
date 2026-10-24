'use strict';

// Feature 095 C-5 (IC-003, NFR-002): `review --action check` through the doflow-run seam. The only
// writes allowed are IC-004's telemetry line (never when telemetry is off, never on a usage error)
// and the seam's own metadata-only run-ledger line, exactly one per call, holding no record content.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const CLI = path.join(REPO_ROOT, 'bin', 'doflow.js');
const RUN = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'roadmap', 'findings', 'schema-1.json');
const CANARY = 'cnryC5seam7f3a9b';
const LEDGER_KEYS: any = new Set(['timestamp', 'verb', 'exit_code', 'duration_ms', 'arg_count', 'run', 'lineage', 'attempt']);

/** Every regular file under `root`, as relative path -> content. */
function snapshot(root: any, base: any = root, out: any = {}) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) snapshot(full, base, out);
    else out[path.relative(base, full)] = fs.readFileSync(full, 'utf8');
  }
  return out;
}

function seam(t: any, { telemetry, record, args }: any) {
  const dir = tempDir(t, 'doflow-review-seam-');
  const home = path.join(dir, 'home');
  const project = path.join(dir, 'work');
  fs.mkdirSync(home);
  fs.mkdirSync(path.join(project, '.doflow', 'state', 'runs'), { recursive: true });
  const env: any = {
    ...process.env,
    HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'),
    GIT_CONFIG_GLOBAL: path.join(home, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    FORCE_COLOR: '', DOFLOW_CLI: CLI, DOFLOW_CONFIG_DIR: path.join(project, '.doflow'),
  };
  for (const key of Object.keys(env)) if (/^DOFLOW_(TELEMETRY|RUN_ID|LINEAGE_ID|ATTEMPT|FAILURE_CAPTURE)$/.test(key)) delete env[key];
  if (!telemetry) env.DOFLOW_TELEMETRY = 'off';
  const name = `findings-${CANARY}.json`;
  fs.writeFileSync(path.join(project, name), JSON.stringify(record));
  const before = snapshot(dir);
  const res = spawnSync('/bin/bash', [RUN, 'review', ...args(name)], { cwd: project, env, encoding: 'utf8' });
  const after = snapshot(dir);
  const added = Object.keys(after).filter((rel) => !(rel in before)).sort();
  const changed: any = Object.keys(after).filter((rel) => rel in before && before[rel] !== after[rel]);
  const removed = Object.keys(before).filter((rel) => !(rel in after));
  return { res, after, added, changed, removed };
}

/** A canary-bearing record: its slug, seat, finding ids and summary all carry CANARY. */
function canaryRecord({ valid }: any) {
  const data = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  data.seats[0].id = `seat-${CANARY}`;
  data.seats[0].findings[0].summary = `summary ${CANARY}`;
  if (!valid) data.slug = `x-${CANARY}`;
  return data;
}

function assertWrites(t: any, s: any, { status, telemetry }: any) {
  assert.equal(s.res.status, status, s.res.stdout + s.res.stderr);
  assert.deepEqual(s.changed, [], 'no existing file changed');
  assert.deepEqual(s.removed, [], 'no file removed');
  const runsPrefix = path.join('work', '.doflow', 'state', 'runs');
  const ledger = s.added.filter((rel: any) => path.dirname(rel) === runsPrefix && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(path.basename(rel)));
  const partitions = s.added.filter((rel: any) => path.dirname(rel) === path.join(runsPrefix, 'telemetry') && rel.endsWith('.jsonl'));
  assert.deepEqual(s.added, [...ledger, ...partitions].sort(), 'only the ledger and the telemetry partition are added');
  assert.equal(ledger.length, 1, 'exactly one run-ledger file');
  const lines = s.after[ledger[0]].trim().split('\n');
  assert.equal(lines.length, 1, 'exactly one run-ledger line');
  const entry = JSON.parse(lines[0]);
  assert.ok(Object.keys(entry).every((key) => LEDGER_KEYS.has(key)), `ledger keys: ${Object.keys(entry).join(',')}`);
  assert.equal(entry.verb, 'review');
  assert.equal(entry.exit_code, status);
  assert.equal(lines[0].includes(CANARY), false, 'the ledger line holds no record content');
  assert.equal(partitions.length, telemetry ? 1 : 0, telemetry ? 'one telemetry partition' : 'no telemetry partition');
  if (telemetry) {
    const text = s.after[partitions[0]];
    assert.equal(text.trim().split('\n').length, 1);
    assert.equal(JSON.parse(text).kind, 'review.run');
    assert.equal(text.includes(CANARY), false, 'the telemetry line holds no record content');
  }
}

const check = (name: any) => ['--action', 'check', '--path', name, '--json'];

test('seam: a valid record writes one telemetry line and one metadata-only ledger line', (t) => {
  assertWrites(t, seam(t, { telemetry: true, record: canaryRecord({ valid: true }), args: check }), { status: 0, telemetry: true });
});

test('seam: an invalid record writes one telemetry line and one metadata-only ledger line', (t) => {
  assertWrites(t, seam(t, { telemetry: true, record: canaryRecord({ valid: false }), args: check }), { status: 1, telemetry: true });
});

test('seam: a usage error writes no telemetry line, only the ledger line', (t) => {
  const args = (name: any) => ['--action', 'lint', '--path', name, '--json'];
  assertWrites(t, seam(t, { telemetry: true, record: canaryRecord({ valid: true }), args }), { status: 2, telemetry: false });
});

test('seam: DOFLOW_TELEMETRY=off writes no telemetry line, only the ledger line', (t) => {
  assertWrites(t, seam(t, { telemetry: false, record: canaryRecord({ valid: true }), args: check }), { status: 0, telemetry: false });
});
