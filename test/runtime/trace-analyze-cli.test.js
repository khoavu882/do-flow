'use strict';

// Feature 091 C.2 (IC-001, IC-004, IC-005; FR-001, FR-005, FR-007, FR-008, NFR-009): `trace analyze`
// is a view of the existing `trace` verb, loaded lazily. Through `bin/doflow.js` on seeded temp
// projects: exit codes 0, 1 and 2; `--emit evidence` piped into the real `evidence --action add
// --batch -`; `--emit followups --task-id` citing those ids, written to a file and passed to the real
// `followup --action add --batch <file>`. Every write lands in the temp project's own store (HOME is a
// temp dir too); the linked-worktree case reads the main checkout's ledger the evidence verb wrote.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp');

const REPO = path.resolve(__dirname, '..', '..');
const BIN = path.join(REPO, 'bin', 'doflow.js');
const ANALYZE_FILE = path.join(REPO, 'src', 'runtime', 'trace', 'analyze.ts');
const DAY = '2026-09-01';
const at = (s) => `${DAY}T10:00:${String(s).padStart(2, '0')}.000Z`;
const hex16 = (n) => n.toString(16).padStart(16, '0');

/** A latency-hotspot (p95 = 4x p50, 1500 ms tail) and a redundant-verification finding (two PASS on one key). */
const FINDINGS = [
  ...[500, 500, 500, 500, 2000].map((dur, i) => ({ timestamp: at(i), kind: 'verify.check', verify_id: hex16(i + 1), tier: 'targeted-tests', status: 'PASS', duration_ms: dur })),
  ...[6, 7].map((s) => ({ timestamp: at(s), kind: 'verify.check', verify_id: hex16(s + 100), tier: 'targeted-tests', status: 'PASS', duration_ms: null, check_key: 'c0ffee00c0ffee00' })),
];
/** Steady durations and one keyed PASS: both detectors CLEAR, no finding. */
const CLEAN = [
  ...[500, 500, 500, 500, 500].map((dur, i) => ({ timestamp: at(i), kind: 'verify.check', verify_id: hex16(i + 1), tier: 'targeted-tests', status: 'PASS', duration_ms: dur })),
  { timestamp: at(6), kind: 'verify.check', verify_id: hex16(106), tier: 'targeted-tests', status: 'PASS', duration_ms: null, check_key: 'c0ffee00c0ffee00' },
];

function writeTelemetry(dir, lines) {
  const file = path.join(dir, '.doflow', 'state', 'runs', 'telemetry', `${DAY}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}

/** A plain temp project (not a git checkout, so no 115 redirect applies) and its own HOME. */
function seed(t, lines = FINDINGS) {
  const dir = tempDir(t, 'doflow-trace-analyze-cli-');
  writeTelemetry(dir, lines);
  return { dir, home: tempDir(t, 'doflow-trace-analyze-cli-home-') };
}

function env(home) {
  return { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || '/tmp', FORCE_COLOR: '0', GIT_CONFIG_NOSYSTEM: '1' };
}

/** `node bin/doflow.js ...args` with cwd and HOME in temp dirs; `input` goes to stdin. */
function cli({ dir, home }, args, { input, pre = [] } = {}) {
  return spawnSync(process.execPath, [...pre, BIN, ...args], { cwd: dir, encoding: 'utf8', input, env: env(home) });
}

/** Every file path under `root`, relative and sorted. */
function files(root) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d).sort()) {
      const file = path.join(d, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else out.push(path.relative(root, file));
    }
  };
  walk(root);
  return out;
}

const findingIds = (batch) => batch.map((item) => /finding ([0-9a-f]{16})/.exec(item.content)[1]);

test('CLI exit codes: 0 with no finding, 1 with findings, 2 on usage errors', (t) => {
  const clean = seed(t, CLEAN);
  const r0 = cli(clean, ['trace', 'analyze', clean.dir]);
  assert.equal(r0.status, 0, r0.stderr);
  assert.match(r0.stdout, /^latency-hotspots CLEAR findings 0$/m);
  assert.match(r0.stdout, /^redundant-verification CLEAR findings 0$/m);
  const j0 = cli(clean, ['trace', 'analyze', '--json', clean.dir]);
  assert.equal(j0.status, 0, j0.stderr);
  assert.ok(Array.isArray(JSON.parse(j0.stdout).detectors));
  const e0 = cli(clean, ['trace', 'analyze', '--emit', 'evidence', clean.dir]);
  assert.equal(e0.status, 0, e0.stderr);
  assert.deepEqual(JSON.parse(e0.stdout), []);

  const p = seed(t);
  const r1 = cli(p, ['trace', 'analyze', p.dir]);
  assert.equal(r1.status, 1, r1.stderr);
  assert.match(r1.stdout, /^latency-hotspots FINDING findings 1$/m);
  assert.match(r1.stdout, /^redundant-verification FINDING findings 1$/m);
  // The project resolves from cwd when the positional is left out.
  assert.equal(cli(p, ['trace', 'analyze']).status, 1);

  for (const args of [['--emit', 'bogus'], ['--task-id', 'T1'], ['--task-id', 'T1', '--emit', 'evidence'], ['--run', 'has space'], [p.dir, 'extra']]) {
    const r = cli(p, ['trace', 'analyze', ...args, ...(args.includes(p.dir) ? [] : [p.dir])]);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
  }
  const bad = cli(p, ['trace', 'analyze', '--emit', 'bogus', p.dir]);
  assert.deepEqual(JSON.parse(bad.stdout), { error: 'usage', detail: '--emit expects evidence or followups' });
  const lone = cli(p, ['trace', 'analyze', '--task-id', 'T1', p.dir]);
  assert.match(lone.stderr, /--task-id needs --emit followups/);
  // A read and a usage error record nothing.
  assert.deepEqual(files(p.dir).filter((f) => /state\/(evidence|lifecycle)\//.test(f)), []);
});

test('--emit evidence piped into the real `evidence --action add --batch -`, then --emit followups into `followup --action add --batch <file>`', (t) => {
  const p = seed(t);
  const ev = cli(p, ['trace', 'analyze', '--emit', 'evidence', p.dir]);
  assert.equal(ev.status, 1, ev.stderr); // the exit rule holds under --emit, so a pipe sees the findings
  const batch = JSON.parse(ev.stdout);
  assert.equal(batch.length, 2);
  const ids = findingIds(batch);

  const add = cli(p, ['evidence', '--task-id', 'T1', '--action', 'add', '--batch', '-', '--json', p.dir], { input: ev.stdout });
  assert.equal(add.status, 0, add.stdout + add.stderr);
  const ledgerFile = path.join(p.dir, '.doflow', 'state', 'evidence', 'T1.json');
  assert.ok(fs.existsSync(ledgerFile), 'the temp project holds the evidence it wrote');
  const list = cli(p, ['evidence', '--task-id', 'T1', '--action', 'list', '--json', p.dir]);
  assert.equal(list.status, 0, list.stderr);
  const raw = JSON.parse(list.stdout);
  const stored = (Array.isArray(raw) ? raw : raw.items || raw.evidence).filter((it) => /^trace-analyze finding /.test(it.content));
  assert.equal(stored.length, batch.length, 'one evidence item per finding');
  for (const id of ids) assert.equal(stored.filter((it) => it.content.includes(`finding ${id}`)).length, 1);
  assert.ok(stored.every((it) => it.kind === 'runtime-observation' && it.source.capability === 'trace.analyze'));

  const fu = cli(p, ['trace', 'analyze', '--emit', 'followups', '--task-id', 'T1', p.dir]);
  assert.equal(fu.status, 1, fu.stderr);
  const proposals = JSON.parse(fu.stdout);
  assert.equal(proposals.length, ids.length);
  for (const id of ids) {
    const evId = stored.find((it) => it.content.includes(`finding ${id}`)).id;
    const statement = proposals.map((x) => x.statement).find((s) => s.includes(`finding ${id};`));
    assert.ok(statement, `a proposal names finding ${id}`);
    assert.match(statement, new RegExp(`; evidence ${evId}; verify: `), 'the proposal cites the evidence the verb wrote');
  }
  // Without --task-id the same findings cite nothing.
  const bare = JSON.parse(cli(p, ['trace', 'analyze', '--emit', 'followups', p.dir]).stdout);
  assert.ok(bare.every((x) => x.statement.includes('; evidence unrecorded; ')));

  const batchFile = path.join(tempDir(t, 'doflow-trace-analyze-cli-batch-'), 'followups.json');
  fs.writeFileSync(batchFile, fu.stdout);
  const fadd = cli(p, ['followup', '--action', 'add', '--batch', batchFile, '--json', p.dir]);
  assert.equal(fadd.status, 0, fadd.stdout + fadd.stderr);
  const open = JSON.parse(cli(p, ['followup', '--action', 'list', '--json', p.dir]).stdout);
  assert.equal(open.count, proposals.length, 'one followup per finding');
  assert.deepEqual(open.items.map((x) => x.statement).sort(), proposals.map((x) => x.statement).sort(), 'statements round-trip byte-identical');
  assert.ok(files(p.dir).some((f) => f.startsWith('.doflow/state/lifecycle/')), 'the temp project holds the followups it wrote');
  assert.deepEqual(files(p.home).filter((f) => /evidence|lifecycle/.test(f)), [], 'nothing is written to HOME');
});

test('--slug: the ledger read uses the record slug the evidence verb wrote under', (t) => {
  const p = seed(t);
  const ev = cli(p, ['trace', 'analyze', '--emit', 'evidence', p.dir]);
  const add = cli(p, ['evidence', '--task-id', 'T1', '--action', 'add', '--batch', '-', '--slug', 'feat-a', '--json', p.dir], { input: ev.stdout });
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.ok(fs.existsSync(path.join(p.dir, '.doflow', 'state', 'evidence', 'feat-a', 'T1.json')));
  const cited = JSON.parse(cli(p, ['trace', 'analyze', '--emit', 'followups', '--task-id', 'T1', '--slug', 'feat-a', p.dir]).stdout);
  assert.ok(cited.every((x) => /; evidence ev_[a-z0-9_]+; /.test(x.statement)), cited.map((x) => x.statement).join('\n'));
  // Another slug names another namespace, so nothing is cited.
  const other = JSON.parse(cli(p, ['trace', 'analyze', '--emit', 'followups', '--task-id', 'T1', '--slug', 'feat-b', p.dir]).stdout);
  assert.ok(other.every((x) => x.statement.includes('; evidence unrecorded; ')));
});

const GIT = spawnSync('git', ['--version']).status === 0;

test('a linked worktree reads the main checkout\'s namespaced ledger the evidence verb wrote (115 IC-004)', { skip: !GIT && 'git is not installed' }, (t) => {
  const root = tempDir(t, 'doflow-trace-analyze-cli-git-');
  const home = tempDir(t, 'doflow-trace-analyze-cli-home-');
  const main = path.join(root, 'main');
  const wt = path.join(root, 'wt');
  const git = (cwd, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf8', env: env(home) });
    assert.equal(r.status, 0, r.stderr);
  };
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(main, 'worktree', 'add', '-q', '-b', 'feat/x', wt);
  writeTelemetry(wt, FINDINGS);
  const p = { dir: wt, home };

  const ev = cli(p, ['trace', 'analyze', '--emit', 'evidence', wt]);
  assert.equal(ev.status, 1, ev.stderr);
  const add = cli(p, ['evidence', '--task-id', 'T1', '--action', 'add', '--batch', '-', '--json', wt], { input: ev.stdout });
  assert.equal(add.status, 0, add.stdout + add.stderr);
  assert.ok(fs.existsSync(path.join(main, '.doflow', 'state', 'evidence', 'x', 'T1.json')), 'the evidence verb wrote to the main checkout under the branch slug');

  const fu = cli(p, ['trace', 'analyze', '--emit', 'followups', '--task-id', 'T1', wt]);
  assert.equal(fu.status, 1, fu.stderr);
  const proposals = JSON.parse(fu.stdout);
  assert.equal(proposals.length, 2);
  assert.ok(proposals.every((x) => /; evidence ev_[a-z0-9_]+; /.test(x.statement)), proposals.map((x) => x.statement).join('\n'));
});

test('`trace`, `stats` and `--help` never load analyze.ts; `trace analyze` does; no new verb', (t) => {
  const p = seed(t);
  const probe = path.join(tempDir(t, 'doflow-trace-analyze-cli-probe-'), 'probe.js');
  fs.writeFileSync(probe, `process.on('exit', () => { process.stderr.write('ANALYZE_LOADED=' + Object.keys(require.cache).includes(${JSON.stringify(ANALYZE_FILE)}) + '\\n'); });\n`);
  for (const args of [['trace', '--json', p.dir], ['stats', '--json', p.dir], ['trace', 'spans', p.dir], ['--help']]) {
    const r = cli(p, args, { pre: ['-r', probe] });
    assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    assert.match(r.stderr, /ANALYZE_LOADED=false/, args.join(' '));
  }
  // Positive control: the analyze view loads it, so the probe can see a load.
  assert.match(cli(p, ['trace', 'analyze', p.dir], { pre: ['-r', probe] }).stderr, /ANALYZE_LOADED=true/);

  const help = cli(p, ['--help']).stdout;
  assert.match(help, /trace analyze/);
  assert.match(help, /--emit evidence\|followups/);
  assert.doesNotMatch(help, /^ {2}analyze\s/m, 'analyze is a trace view, not a verb');
  const run = fs.readFileSync(path.join(REPO, 'core', 'shared', 'scripts', 'doflow', 'bin', 'doflow-run'), 'utf8');
  assert.match(run, /^ {2}trace\s{2,}.*trace analyze/m);
  assert.doesNotMatch(run, /\|analyze\|/);
});
