'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');
const { initRegister, addDecisions } = require('../../src/runtime/decision-register.ts');
const { addFollowups } = require('../../src/runtime/lifecycle/followup.ts');
const { projectRoot: lifecycleProjectRoot } = require('../../src/runtime/lifecycle/root.ts');
const { writeReviewPack, buildRoadmapReport, handleRoadmapReportCommand, handleReviewPackCommand, renderPack, gatherFacts } = require('../../src/runtime/review-pack.ts');
const { RUN_ID } = require('../../src/runtime/roadmap/loop.ts');

const SLUG = '001-alpha';
const OTHER = '002-beta';
const NOW: any = new Date('2026-11-14T12:00:00.000Z');
const HEAD_OLD = 'a'.repeat(40);

function git(cwd: any, ...args: any[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}
const write = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };
const item = (over: any = {}) => ({ topic: 't', statement: 'S.', channel: 'question', stage: 'design', rationale: 'R.', ...over });

/** A repo with two seed rows, branches feat/<slug>, and one fully recorded feature (SLUG) and one bare (OTHER). */
function fixture(t: any, { full = true }: any = {}) {
  const root = tempDir(t, 'doflow-review-pack-');
  git(root, 'init', '-q', '-b', 'develop');
  write(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify({ schema: 1, rows: [
    { id: '001', slug: SLUG, title: 'Alpha | the first', class: 'feature', needs: [], mergeCommit: 'b'.repeat(40) },
    { id: '002', slug: OTHER, title: 'Beta', class: 'bug', needs: [] },
  ] }));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'branch', `feat/${SLUG}`);
  git(root, 'branch', `feat/${OTHER}`);
  const featureDir = path.join(root, 'agent-docs', 'doflow', SLUG);
  fs.mkdirSync(featureDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', OTHER), { recursive: true });
  if (!full) return { root, featureDir };
  initRegister({ featureDir, slug: SLUG });
  const added = addDecisions({ featureDir, slug: SLUG, now: NOW, items: [
    item({ topic: 'wire-id', statement: 'The wire carries the UUID.', channel: 'default', rationale: 'unattended:recommended-option', undo: 'Supersede DEC-001 with the old id.' }),
    item({ topic: 'scope', statement: 'Scope is the runtime.', channel: 'question' }),
    item({ topic: 'gate-a', statement: 'gate-a approved by policy p@d (3 inputs).', channel: 'policy', stage: 'planning', rationale: 'Every predicate of gate-a passed on the inputs digest sha256:abc123def456.' }),
    item({ topic: 'naming', statement: 'Named it X.', channel: 'resolution', stage: 'implementation', rationale: 'Matches the neighbours.' }),
  ] });
  assert.equal(added.added.length, 4);
  write(path.join(featureDir, 'requirement.md'), 'Open: [NEEDS CLARIFICATION: which id?] and `[NEEDS CLARIFICATION: in code]`.\n');
  write(path.join(featureDir, 'review/findings.json'), JSON.stringify({
    schema: 1, row: '001', slug: SLUG, reviewedHead: 'c'.repeat(40), rounds: 2,
    seats: [{ id: 'seat-a', findings: [{ id: 'a-1', severity: 'should-fix', locator: 'x.ts:1', summary: 's' }, { id: 'a-2', severity: 'note', locator: 'y.ts:2', summary: 'n' }] }, { id: 'seat-b', findings: [] }],
    converged: [
      { id: 'C-1', from: ['a-1'], severity: 'should-fix', locator: 'x.ts:1', summary: 'fixed one', status: 'fixed', fixedIn: 'd'.repeat(40) },
      { id: 'C-2', from: ['a-2'], severity: 'note', locator: 'y.ts:2', summary: 'kept as it is', status: 'user-accepted', acceptedAs: 'not-worth-fixing', decision: 'DEC-002' },
    ],
  }));
  const run = {
    version: 1, taskId: SLUG, taskClass: 'feature', workflowName: 'feature', state: 'AWAITING_GATE', cursor: 5,
    program: [
      { type: 'stage', id: 'discovery', status: 'completed' }, { type: 'gate', id: 'gate-0', status: 'approved' },
      { type: 'stage', id: 'planning', status: 'completed' }, { type: 'gate', id: 'gate-a', status: 'approved' },
      { type: 'stage', id: 'implementation', status: 'completed' }, { type: 'gate', id: 'gate-b', status: 'pending' },
    ],
    history: [
      { at: '2026-11-14T10:00:00.000Z', action: 'decide-gate', node: 'gate-0', detail: 'approve', note: 'looks fine', forced: false },
      { at: '2026-11-14T10:05:00.000Z', action: 'decide-gate', node: 'gate-a', detail: 'approve', by: 'autopilot', policy: { id: 'gate-a', digest: 'sha256:0123456789abcdef0123' }, inputs: [{}, {}, {}], note: 'approved by policy', forced: false },
    ],
  };
  write(path.join(root, '.doflow/state/orchestration', `${SLUG}.json`), JSON.stringify(run));
  write(path.join(root, '.doflow/state/verification/runs', `${SLUG}.jsonl`),
    `${JSON.stringify({ schema: 1, taskId: SLUG, head: HEAD_OLD, clean: true, verdict: 'PASS', risk: 'MEDIUM', at: '2026-11-14T09:00:00.000Z', reportSha256: `sha256:${'e'.repeat(64)}` })}\n`);
  const followups = addFollowups({ root: lifecycleProjectRoot(root), cwd: root, items: [{ statement: 'Rename the helper later.', stage: 'review' }], defaults: { slug: SLUG }, channel: 'default', now: NOW });
  assert.equal(followups.ok, true);
  return { root, featureDir };
}

const section = (text: string, n: number): string => {
  const start = text.indexOf(`## ${n}. `);
  const next = text.indexOf(`\n## ${n + 1}. `);
  return text.slice(start, next === -1 ? undefined : next);
};

test('the pack has the seven sections in order, each built from records', (t) => {
  const { root, featureDir } = fixture(t);
  const result = writeReviewPack({ cwd: root, slug: SLUG, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(featureDir, 'review-pack.md'));
  const text = fs.readFileSync(result.path, 'utf8');
  const titles = [...text.matchAll(/^## (\d)\. (.+)$/gm)].map((m) => `${m[1]} ${m[2]}`);
  assert.deepEqual(titles, ['1 Result', '2 Decisions taken for you', '3 Gates', '4 Verification', '5 Review', '6 Open items', '7 Not verified']);
  assert.match(text, /^Generated at: 2026-11-14T12:00:00.000Z$/m);

  const one = section(text, 1);
  assert.match(one, /Task class: feature/);
  assert.match(one, /Branch: feat\/001-alpha/);
  assert.match(one, new RegExp(`Head commit: ${git(root, 'rev-parse', `feat/${SLUG}`)}`));
  assert.match(one, /Merge commit: b{40}/);
  assert.match(one, /Run state: AWAITING_GATE, at gate gate-b \(5 of 6 steps done\)/);
  assert.match(one, /Stage reached: implementation/);

  const two = section(text, 2);
  assert.match(two, /DEC-001 · design · wire-id · by agent/);
  assert.match(two, /Decision: The wire carries the UUID\./);
  assert.match(two, /Reason: unattended:recommended-option/);
  assert.match(two, /Undo: Supersede DEC-001 with the old id\./);
  assert.match(two, /DEC-003 · planning · gate-a · by autopilot/);
  assert.match(two, /DEC-004 · implementation · naming · by agent[\s\S]*Undo: none recorded/);
  assert.doesNotMatch(two, /DEC-002/);
  assert.match(two, /Decisions by the user: 1/);

  const three = section(text, 3);
  assert.match(three, /gate-0: approve not by policy \(actor not recorded\) at 2026-11-14T10:00:00.000Z; note: looks fine/);
  assert.match(three, /gate-a: approve by policy at 2026-11-14T10:05:00.000Z; policy gate-a@sha256:0123456789abcdef0123; 3 inputs; inputs digest sha256:abc123def456/);
  assert.match(three, /gate-b: no decision recorded/);
});

test('verification names the commit each run ran on and says when the latest is not on the head', (t) => {
  const { root } = fixture(t);
  const text = fs.readFileSync(writeReviewPack({ cwd: root, slug: SLUG, now: NOW }).path, 'utf8');
  const four = section(text, 4);
  assert.match(four, /2026-11-14T09:00:00.000Z · PASS · risk MEDIUM · commit aaaaaaaa · tree clean · report eeeeeeee/);
  assert.match(four, /The latest run is not on the head commit: it ran on aaaaaaaa, the head is [0-9a-f]{8}\./);
  assert.match(section(text, 7), /keeps the verdict, risk, commit, tree state and a digest of the report, not the commands/);
});

test('review shows seats, rounds, findings by severity and what was accepted without a fix', (t) => {
  const { root } = fixture(t);
  const five = section(fs.readFileSync(writeReviewPack({ cwd: root, slug: SLUG, now: NOW }).path, 'utf8'), 5);
  assert.match(five, /Seats: 2 \(seat-a, seat-b\)/);
  assert.match(five, /Rounds: 2/);
  assert.match(five, /Seat findings: 2 \(blocker 0, should-fix 1, note 1\)/);
  assert.match(five, /Converged findings: 2 \(blocker 0, should-fix 1, note 1\); fixed 1, refuted 0, user-accepted 1, open 0/);
  assert.match(five, /C-2 · note · y\.ts:2 · kept as it is · not-worth-fixing · DEC-002/);
});

test('open items list the follow-up filed for the feature and the unresolved marker, not the one in code', (t) => {
  const { root } = fixture(t);
  const six = section(fs.readFileSync(writeReviewPack({ cwd: root, slug: SLUG, now: NOW }).path, 'utf8'), 6);
  assert.match(six, /FU-[A-Za-z0-9]{6} · open · review · Rename the helper later\./);
  assert.match(six, /Holds: none recorded/);
  assert.match(six, /requirement\.md: 1/);
});

test('a feature with no records gets "none recorded" in every section and a Not verified list', (t) => {
  const { root } = fixture(t, { full: false });
  const text = fs.readFileSync(writeReviewPack({ cwd: root, slug: SLUG, now: NOW }).path, 'utf8');
  for (const n of [2, 3, 4, 5]) assert.match(section(text, n), /none recorded/, `section ${n}`);
  assert.match(section(text, 1), /Stage reached: none recorded/);
  assert.match(section(text, 6), /Follow-ups: none recorded[\s\S]*Holds: none recorded[\s\S]*markers: none recorded/);
  const seven = section(text, 7);
  assert.match(seven, /No decision register/);
  assert.match(seven, /No orchestration run on record/);
  assert.match(seven, /No verify run on record/);
  assert.match(seven, /No review on record/);
});

test('the same records give the same bytes except the generated-at line', (t) => {
  const { root } = fixture(t);
  const body = (now: Date) => fs.readFileSync(writeReviewPack({ cwd: root, slug: SLUG, now }).path, 'utf8').replace(/^Generated at: .*$/m, '');
  assert.equal(body(NOW), body(new Date('2027-01-01T00:00:00.000Z')));
});

test('a record cannot add a heading or open a comment through a line it states', (t) => {
  const { root, featureDir } = fixture(t, { full: false });
  initRegister({ featureDir, slug: SLUG });
  addDecisions({ featureDir, slug: SLUG, now: NOW, items: [item({ channel: 'default', rationale: 'first <!-- hide\n## 9. Forged', undo: 'u' })] });
  const text = fs.readFileSync(writeReviewPack({ cwd: root, slug: SLUG, now: NOW }).path, 'utf8');
  assert.doesNotMatch(text, /^## 9\./m);
  assert.match(text, /first \\<!-- hide ## 9\. Forged/);
});

test('an unknown feature is refused without writing', (t) => {
  const { root } = fixture(t);
  const result = writeReviewPack({ cwd: root, slug: '999-nothing', now: NOW });
  assert.equal(result.ok, false);
});

test('roadmap report: one table over the run\'s rows, a held row says why, a missing pack is generated', (t) => {
  const { root } = fixture(t);
  const runId = 'rl-20261114-abcd';
  write(path.join(root, '.doflow/state/roadmap/runs', `${runId}.json`), JSON.stringify({
    schema: 1, runId, createdAt: '2026-11-14T08:00:00.000Z', closedAt: '2026-11-14T11:00:00.000Z', maxSteps: null, steps: 7, n: 7, log: [],
    rows: { '001': { done: true }, '002': { held: { kind: 'gate', reason: 'markers-nonzero', inputsDigest: 'sha256:x' } } },
  }));
  assert.equal(fs.existsSync(path.join(root, 'agent-docs/doflow', OTHER, 'review-pack.md')), false);
  const report = buildRoadmapReport({ cwd: root, runId, now: NOW });
  assert.equal(report.ok, true);
  const [a, b] = report.rows;
  assert.deepEqual([a.row, a.title, a.class, a.held, a.decisions, a.pack], ['001', 'Alpha | the first', 'feature', null, 3, 'agent-docs/doflow/001-alpha/review-pack.md']);
  assert.equal(a.openItems, 2); // the follow-up and the marker
  assert.deepEqual([b.row, b.class, b.held, b.decisions, b.openItems, b.pack], ['002', 'bug', 'held (gate): markers-nonzero', 0, 1, 'agent-docs/doflow/002-beta/review-pack.md']);
  assert.equal(fs.existsSync(path.join(root, 'agent-docs/doflow', OTHER, 'review-pack.md')), true);
  assert.match(report.text, /\| 001 \| Alpha \\\| the first \| feature \| in-flight \|/);
  assert.match(report.text, /\| 002 \| Beta \| bug \| in-flight \| held \(gate\): markers-nonzero \| 0 \| 1 \| agent-docs\/doflow\/002-beta\/review-pack\.md \|/);
  assert.equal(report.file, path.join(root, 'agent-docs/roadmap/roadmap-report.md'));
});

test('roadmap report writes one file beside ROADMAP.md with the run id in its heading', (t) => {
  const { root } = fixture(t);
  const runId = 'rl-20261114-abcd';
  write(path.join(root, '.doflow/state/roadmap/runs', `${runId}.json`), JSON.stringify({ schema: 1, runId, createdAt: '2026-11-14T08:00:00.000Z', closedAt: null, steps: 0, n: 0, log: [], rows: {} }));
  const lines: string[] = [];
  const real = console.log;
  console.log = (line: any) => { lines.push(String(line)); };
  const written = fs.writeSync;
  try {
    assert.equal(handleRoadmapReportCommand({ cwd: root, json: true, now: NOW }), 0);
  } finally { console.log = real; process.exitCode = 0; }
  void written;
  const out = JSON.parse(lines.join('\n'));
  assert.equal(out.runId, runId);
  assert.equal(out.path, path.join(root, 'agent-docs/roadmap/roadmap-report.md'));
  const body = fs.readFileSync(out.path, 'utf8');
  assert.match(body, /^# Roadmap run report: rl-20261114-abcd$/m);
  assert.match(body, /Rows: none recorded/);
  assert.equal(fs.existsSync(path.join(root, '.doflow/state/roadmap/runs', `${runId}.report.md`)), false);
  assert.equal(buildRoadmapReport({ cwd: root, runId: 'rl-20261114-zzzz', now: NOW }).ok, false);
});

// ── the review findings: every mutation of what a section states fails one of these ───────────────

const RUNS_DIR = '.doflow/state/roadmap/runs';
const runRecord = (runId: string, over: any = {}) => ({ schema: 1, runId, createdAt: '2026-11-14T08:00:00.000Z', closedAt: null, steps: 1, n: 1, log: [], rows: {}, ...over });
const writeRun = (root: string, runId: string, over: any = {}) => write(path.join(root, RUNS_DIR, `${runId}.json`), JSON.stringify(runRecord(runId, over)));
const packOf = (root: string, slug = SLUG) => fs.readFileSync(writeReviewPack({ cwd: root, slug, now: NOW }).path, 'utf8');
const captured = (fn: () => number) => {
  const out: string[] = []; const err: string[] = [];
  const log = console.log; const error = console.error; const write = process.stdout.write;
  console.log = (line: any) => { out.push(String(line)); };
  console.error = (line: any) => { err.push(String(line)); };
  (process.stdout as any).write = (chunk: any) => { out.push(String(chunk)); return true; };
  let code: number;
  try { code = fn(); } finally { console.log = log; console.error = error; (process.stdout as any).write = write; process.exitCode = 0; }
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('the run id pattern is the loop\'s: a lower-case id is accepted, an upper-case one is not', () => {
  assert.equal(RUN_ID.test('rl-20261114-abcd'), true);
  assert.equal(RUN_ID.test('rl-20261114-ABCD'), false);
});

test('a hold of the newest run that has the row shows in section 6, a paused one says paused, the older run is not used', (t) => {
  const { root } = fixture(t);
  writeRun(root, 'rl-20261113-aaaa', { createdAt: '2026-11-13T08:00:00.000Z', rows: { '001': { held: { kind: 'gate', reason: 'old reason' } } } });
  writeRun(root, 'rl-20261114-bbbb', { rows: { '001': { paused: { reason: 'waiting for the person' } } } });
  const six = section(packOf(root), 6);
  assert.match(six, /paused in rl-20261114-bbbb: waiting for the person/);
  assert.doesNotMatch(six, /old reason/);
  writeRun(root, 'rl-20261114-cccc', { createdAt: '2026-11-14T09:00:00.000Z', rows: { '001': { held: { kind: 'gate', reason: 'markers-nonzero' } } } });
  assert.match(section(packOf(root), 6), /held \(gate\) in rl-20261114-cccc: markers-nonzero/);
});

test('a rejected run shows as a hold', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, '.doflow/state/orchestration', `${SLUG}.json`);
  write(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), state: 'REJECTED' }));
  assert.match(section(packOf(root), 6), /rejected: the run journal records a rejected gate/);
});

test('section 1 takes the run record\'s branch first, then a current branch ending /<slug>, then feat/<slug>; none says not determined', (t) => {
  const { root } = fixture(t);
  git(root, 'branch', 'work/001-alpha');
  git(root, 'branch', 'recorded/branch');
  const runFile = path.join(root, '.doflow/state/orchestration', `${SLUG}.json`);
  const run = JSON.parse(fs.readFileSync(runFile, 'utf8'));
  // current branch ends /<slug>: it wins over feat/<slug>
  git(root, 'checkout', '-q', 'work/001-alpha');
  assert.match(section(packOf(root), 1), /Branch: work\/001-alpha\n/);
  // the run record names one: it wins over both
  write(runFile, JSON.stringify({ ...run, commit: { branch: 'recorded/branch' } }));
  assert.match(section(packOf(root), 1), /Branch: recorded\/branch\n/);
  // nothing resolves
  git(root, 'checkout', '-q', 'develop');
  git(root, 'branch', '-D', `feat/${SLUG}`);
  git(root, 'branch', '-D', 'work/001-alpha');
  write(runFile, JSON.stringify(run));
  const text = packOf(root);
  assert.match(section(text, 1), /Branch: not determined\n- Head commit: not determined/);
  assert.match(section(text, 7), /No branch was determined/);
  assert.doesNotMatch(section(text, 1), /no branch/i);
});

test('section 2 says what a decision was superseded by; section 3 marks a forced gate and does not call every actor a policy', (t) => {
  const { root, featureDir } = fixture(t);
  addDecisions({ featureDir, slug: SLUG, now: NOW, items: [item({ topic: 'wire-id', statement: 'Use the long id.', channel: 'default', rationale: 'simplest', supersedes: ['DEC-001'] })] });
  assert.match(section(packOf(root), 2), /DEC-001 · design · wire-id · by agent · superseded by DEC-005/);
  const file = path.join(root, '.doflow/state/orchestration', `${SLUG}.json`);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  run.history[0].forced = true;
  write(file, JSON.stringify(run));
  const three = section(packOf(root), 3);
  assert.match(three, /gate-0: approve not by policy \(actor not recorded\) \(forced\) at /);
  assert.doesNotMatch(three, /gate-0: approve by policy/);
  assert.doesNotMatch(three.split('\n').find((l) => l.startsWith('- gate-a')) as string, /forced/);
  assert.doesNotMatch(three, /by person/);
});

test('section 3 names an actor the journal records and treats only autopilot as the policy', (t) => {
  const { root } = fixture(t);
  const file = path.join(root, '.doflow/state/orchestration', `${SLUG}.json`);
  const run = JSON.parse(fs.readFileSync(file, 'utf8'));
  run.history[0].by = 'alice';
  write(file, JSON.stringify(run));
  const three = section(packOf(root), 3);
  assert.match(three, /gate-0: approve by alice at /);
  assert.doesNotMatch(three, /gate-0: approve by policy|actor not recorded\) at 2026-11-14T10:00/);
});

test('section 4 compares the LAST run with the head, and counts an unreadable line', (t) => {
  const { root } = fixture(t);
  const head = git(root, 'rev-parse', `feat/${SLUG}`);
  const line = (h: string, at: string) => JSON.stringify({ schema: 1, taskId: SLUG, head: h, clean: false, verdict: 'FAIL', risk: 'HIGH', at, reportSha256: 'f'.repeat(64) });
  write(path.join(root, '.doflow/state/verification/runs', `${SLUG}.jsonl`), `${line(head, '2026-11-14T08:00:00.000Z')}\n{ torn\n${line(HEAD_OLD, '2026-11-14T09:00:00.000Z')}\n`);
  const text = packOf(root);
  const four = section(text, 4);
  assert.match(four, /The latest run is not on the head commit: it ran on aaaaaaaa/);
  assert.match(four, /tree dirty/);
  assert.match(four, /1 verify record line\(s\) could not be read/);
  assert.match(section(text, 7), /1 line\(s\) of the verify record could not be read/);
  write(path.join(root, '.doflow/state/verification/runs', `${SLUG}.jsonl`), `${line(HEAD_OLD, '2026-11-14T08:00:00.000Z')}\n${line(head, '2026-11-14T09:00:00.000Z')}\n`);
  assert.match(section(packOf(root), 4), /The latest run is on the head commit/);
});

test('section 5 counts blockers, refuted and open findings from a valid record', (t) => {
  const { root, featureDir } = fixture(t);
  write(path.join(featureDir, 'review/findings.json'), JSON.stringify({
    schema: 1, row: '001', slug: SLUG, reviewedHead: 'c'.repeat(40), rounds: 3,
    seats: [{ id: 'seat-a', findings: [{ id: 'a-1', severity: 'blocker', locator: 'x.ts:1', summary: 's' }, { id: 'a-2', severity: 'blocker', locator: 'y.ts:2', summary: 'n' }, { id: 'a-3', severity: 'note', locator: 'z.ts:3', summary: 'o' }] }],
    converged: [
      { id: 'C-1', from: ['a-1'], severity: 'blocker', locator: 'x.ts:1', summary: 'one', status: 'refuted', evidence: 'test/x.test.ts:4' },
      { id: 'C-2', from: ['a-2'], severity: 'blocker', locator: 'y.ts:2', summary: 'two', status: 'open' },
      { id: 'C-3', from: ['a-3'], severity: 'note', locator: 'z.ts:3', summary: 'three', status: 'open' },
    ],
  }));
  const five = section(packOf(root), 5);
  assert.match(five, /Seat findings: 3 \(blocker 2, should-fix 0, note 1\)/);
  assert.match(five, /Converged findings: 3 \(blocker 2, should-fix 0, note 1\); fixed 0, refuted 1, user-accepted 0, open 2/);
});

test('section 7 names a register, findings or verify record that exists and cannot be read, with its file', (t) => {
  const { root, featureDir } = fixture(t);
  write(path.join(featureDir, 'decisions/register.json'), '{ "version": 1, "decisions": [');
  write(path.join(featureDir, 'review/findings.json'), '{ "seats": [');
  fs.rmSync(path.join(root, '.doflow/state/verification/runs', `${SLUG}.jsonl`));
  fs.mkdirSync(path.join(root, '.doflow/state/verification/runs', `${SLUG}.jsonl`));
  const seven = section(packOf(root), 7);
  assert.match(seven, /The decision register could not be read: [^\n]*register\.json is not valid JSON/);
  assert.match(seven, /The review record could not be read: findings\.json is not valid JSON/);
  assert.match(seven, /The verify record could not be read: [^\n]*\.jsonl/);
  assert.doesNotMatch(seven, /No decision register|No review on record|No verify run on record/);
  // an invalid (well-formed JSON, wrong shape) review record is named as invalid, never shown
  write(path.join(featureDir, 'review/findings.json'), JSON.stringify({ schema: 1, seats: [] }));
  const text = packOf(root);
  assert.match(section(text, 7), /review\/findings\.json is not a valid review record \(/);
  assert.match(section(text, 5), /none recorded/);
});

test('section 7 says when the follow-up store cannot be read', (t) => {
  const { root } = fixture(t);
  const lifecycle = path.join(root, '.doflow', 'state', 'lifecycle');
  const broken: any = { ...fs, readdirSync: (p: any, ...rest: any[]) => { if (String(p).startsWith(lifecycle)) throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' }); return (fs as any).readdirSync(p, ...rest); } };
  const feature = { featureRoot: root, featureFolder: path.join(root, 'agent-docs/doflow', SLUG) };
  const text = renderPack(gatherFacts({ cwd: root, slug: SLUG, feature, fsImpl: broken }), NOW);
  assert.match(section(text, 7), /The follow-up store could not be read: [^\n]*denied; follow-ups are not shown/);
});

test('a run record that cannot be read is named in section 7 and in the report', (t) => {
  const { root } = fixture(t);
  write(path.join(root, RUNS_DIR, 'rl-20261114-dddd.json'), '{ torn');
  assert.match(section(packOf(root), 7), /Roadmap run record\(s\) could not be read: rl-20261114-dddd\.json/);
  writeRun(root, 'rl-20261114-abcd');
  assert.match(buildRoadmapReport({ cwd: root, now: NOW }).text, /Run record\(s\) that could not be read: rl-20261114-dddd\.json/);
});

test('every string a record holds is one line in the pack: no heading, no comment, no control character', (t) => {
  const PAYLOAD = 'x\n## 6. Open items\n<!--\u001b[31m \\<!-- \u2028## 5. Review';
  const { root } = fixture(t);
  writeRun(root, 'rl-20261114-abcd', { rows: { '001': { held: { kind: PAYLOAD, reason: PAYLOAD } } } });
  const feature = { featureRoot: root, featureDir: path.join(root, 'agent-docs/doflow', SLUG), featureFolder: path.join(root, 'agent-docs/doflow', SLUG) };
  const facts = gatherFacts({ cwd: root, slug: SLUG, feature });
  const taint = (value: any, keep: Set<string>, key = ''): any => {
    if (typeof value === 'string') return keep.has(key) ? value : PAYLOAD;
    if (typeof value === 'number') return value;
    if (Array.isArray(value)) return value.map((v) => taint(v, keep, key));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, taint(v, keep, k)]));
    return value;
  };
  const control = new Set(['decidedBy', 'status', 'channel', 'state', 'decided', 'type', 'action', 'node', 'kind']);
  const verdict = (text: string) => {
    assert.equal((text.match(/^## /gm) || []).length, 7, 'seven headings');
    assert.equal((text.match(/^# /gm) || []).length, 1);
    assert.doesNotMatch(text, /^\s*<!--/m);
    assert.doesNotMatch(text, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/);
    for (const m of text.matchAll(/<!--/g)) {
      let slashes = 0;
      for (let i = (m.index as number) - 1; i >= 0 && text[i] === '\\'; i -= 1) slashes += 1;
      assert.equal(slashes % 2, 1, 'every "<" is escaped by an odd run of backslashes');
    }
  };
  const withControl = renderPack(taint(facts, control), NOW);
  verdict(withControl);
  assert.match(withControl, /x ## 6\. Open items \\<!--/); // the payload is on one line, so the heading cannot form
  verdict(renderPack(taint(facts, new Set()), NOW));
  // and from files: a register, a verify record and a review record carrying the payload
  const { featureDir } = { featureDir: facts.featureDir };
  const reg = JSON.parse(fs.readFileSync(path.join(featureDir, 'decisions/register.json'), 'utf8'));
  reg.decisions = reg.decisions.map((d: any) => ({ ...d, topic: PAYLOAD, statement: PAYLOAD, rationale: PAYLOAD, undo: PAYLOAD, stage: PAYLOAD }));
  write(path.join(featureDir, 'decisions/register.json'), JSON.stringify(reg));
  write(path.join(root, '.doflow/state/verification/runs', `${SLUG}.jsonl`), `${JSON.stringify({ at: PAYLOAD, verdict: PAYLOAD, risk: PAYLOAD, head: PAYLOAD, clean: true, reportSha256: PAYLOAD })}\n`);
  const findings = JSON.parse(fs.readFileSync(path.join(featureDir, 'review/findings.json'), 'utf8'));
  findings.converged[1].summary = PAYLOAD;
  findings.converged[1].locator = PAYLOAD;
  findings.seats[0].id = PAYLOAD;
  findings.seats[0].findings.forEach((f: any) => { f.summary = PAYLOAD; });
  write(path.join(featureDir, 'review/findings.json'), JSON.stringify(findings));
  verdict(packOf(root));
  // a record that is not valid is refused whole, and its rounds and head are never printed
  findings.reviewedHead = PAYLOAD; findings.rounds = PAYLOAD;
  write(path.join(featureDir, 'review/findings.json'), JSON.stringify(findings));
  const invalid = packOf(root);
  verdict(invalid);
  assert.match(section(invalid, 7), /is not a valid review record/);
});

test('a backslash before "<" cannot cancel the escape', (t) => {
  const { root, featureDir } = fixture(t, { full: false });
  initRegister({ featureDir, slug: SLUG });
  addDecisions({ featureDir, slug: SLUG, now: NOW, items: [item({ channel: 'default', rationale: 'a \\<!-- b', undo: 'u' })] });
  assert.match(packOf(root), /Reason: a \\\\\\<!-- b/);
});

test('a task id that echoes control characters is refused without printing them', () => {
  const shown = captured(() => handleReviewPackCommand({ taskId: 'bad\u001b[31m\nslug', cwd: process.cwd() }));
  assert.equal(shown.code, 2);
  assert.doesNotMatch(shown.err, /\u001b/);
  assert.equal(shown.err.split('\n').length, 1);
});

test('the pack is read from and written to the one feature root, even from a linked worktree', (t) => {
  const { root, featureDir } = fixture(t);
  const linked = path.join(path.dirname(root), `${path.basename(root)}-linked`);
  git(root, 'worktree', 'add', '-q', '-b', 'scratch', linked);
  t.after(() => { try { git(root, 'worktree', 'remove', '--force', linked); } catch { /* gone */ } });
  const result = writeReviewPack({ cwd: linked, slug: SLUG, now: NOW });
  assert.equal(result.ok, true);
  assert.equal(fs.realpathSync(result.path), fs.realpathSync(path.join(featureDir, 'review-pack.md')));
  assert.equal(fs.existsSync(path.join(linked, 'agent-docs/doflow', SLUG, 'review-pack.md')), false);
  assert.match(section(fs.readFileSync(result.path, 'utf8'), 2), /DEC-001/);
});

test('a feature folder that is a link to outside the checkout is refused and nothing is written', (t) => {
  const { root, featureDir } = fixture(t);
  const outside = tempDir(t, 'doflow-review-pack-outside-');
  fs.rmSync(featureDir, { recursive: true });
  fs.symlinkSync(outside, featureDir);
  const result = writeReviewPack({ cwd: root, slug: SLUG, now: NOW });
  assert.equal(result.ok, false);
  assert.match(result.message, /outside its checkout/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('the temp file name is unpredictable and no temp file is left behind', (t) => {
  const { root, featureDir } = fixture(t);
  const names: string[] = [];
  const spy: any = { ...fs, writeFileSync: (file: any, ...rest: any[]) => { names.push(String(file)); return (fs as any).writeFileSync(file, ...rest); } };
  writeReviewPack({ cwd: root, slug: SLUG, now: NOW, fsImpl: spy });
  writeReviewPack({ cwd: root, slug: SLUG, now: NOW, fsImpl: spy });
  const temps = names.filter((n: string) => n.endsWith('.tmp'));
  assert.equal(temps.length, 2);
  assert.notEqual(temps[0], temps[1]);
  assert.match(path.basename(temps[0]), /^review-pack\.md\.[0-9a-f]{16}\.tmp$/);
  assert.deepEqual(fs.readdirSync(featureDir).filter((n: string) => n.endsWith('.tmp')), []);
});

// ── the roadmap report ───────────────────────────────────────────────────────────────────────────

test('roadmap report with no --run takes the NEWEST run record, and a paused row says paused', (t) => {
  const { root } = fixture(t);
  writeRun(root, 'rl-20261113-aaaa', { createdAt: '2026-11-13T08:00:00.000Z', rows: { '001': { held: { kind: 'gate', reason: 'old' } } } });
  writeRun(root, 'rl-20261114-bbbb', { rows: { '002': { paused: { reason: 'person away' } } } });
  const report = buildRoadmapReport({ cwd: root, now: NOW });
  assert.equal(report.runId, 'rl-20261114-bbbb');
  assert.deepEqual(report.rows.map((r: any) => [r.row, r.held]), [['002', 'paused: person away']]);
  assert.match(report.text, /\| 002 \| Beta \| bug \| in-flight \| paused: person away \|/);
  assert.equal(buildRoadmapReport({ cwd: root, runId: 'rl-20261113-aaaa', now: NOW }).rows[0].held, 'held (gate): old');
});

test('roadmap report prints "none recorded" for a status it cannot know', (t) => {
  const { root } = fixture(t);
  writeRun(root, 'rl-20261114-abcd', { rows: { '001': {} } });
  git(root, 'branch', '-m', 'develop', 'trunk'); // no develop branch: git facts are not readable
  const report = buildRoadmapReport({ cwd: root, now: NOW });
  assert.equal(report.rows[0].status, null);
  assert.match(report.text, /\| 001 \| Alpha \\\| the first \| feature \| none recorded \|/);
});

test('roadmap report validates --run, exits 1 on no run record and 2 on a malformed id', (t) => {
  const { root } = fixture(t);
  const none = captured(() => handleRoadmapReportCommand({ cwd: root, json: false, now: NOW }));
  assert.equal(none.code, 1);
  assert.match(none.err, /no roadmap run record/);
  const unknown = captured(() => handleRoadmapReportCommand({ runId: 'rl-20261114-zzzz', cwd: root, now: NOW }));
  assert.equal(unknown.code, 1);
  for (const bad of ['rl-20261114-ABCD', 'nonsense', '../../x', '']) {
    const run = captured(() => handleRoadmapReportCommand({ runId: bad, cwd: root, now: NOW }));
    assert.equal(run.code, 2, JSON.stringify(bad));
    assert.match(run.err, /--run must be rl-/);
  }
});

test('roadmap report regenerates a pack that already exists, never links a stale one', (t) => {
  const { root, featureDir } = fixture(t);
  writeRun(root, 'rl-20261114-abcd', { rows: { '001': {} } });
  write(path.join(featureDir, 'review-pack.md'), 'STALE\n');
  buildRoadmapReport({ cwd: root, now: NOW });
  const body = fs.readFileSync(path.join(featureDir, 'review-pack.md'), 'utf8');
  assert.doesNotMatch(body, /STALE/);
  assert.match(body, /^# Review pack: 001-alpha$/m);
});

test('roadmap report overwrites its one file on each run and names the run in the heading', (t) => {
  const { root } = fixture(t);
  writeRun(root, 'rl-20261113-aaaa', { createdAt: '2026-11-13T08:00:00.000Z' });
  handleRoadmapReportCommand({ cwd: root, json: true, now: NOW }); process.exitCode = 0;
  writeRun(root, 'rl-20261114-bbbb');
  captured(() => handleRoadmapReportCommand({ cwd: root, json: true, now: NOW }));
  const dir = path.join(root, 'agent-docs/roadmap');
  assert.deepEqual(fs.readdirSync(dir).filter((n: string) => n.includes('report')), ['roadmap-report.md']);
  assert.match(fs.readFileSync(path.join(dir, 'roadmap-report.md'), 'utf8'), /^# Roadmap run report: rl-20261114-bbbb$/m);
});

test('roadmap report row with a record that carries control characters stays a one-line table cell', (t) => {
  const { root } = fixture(t);
  writeRun(root, 'rl-20261114-abcd', { rows: { '001': { held: { kind: 'gate', reason: 'a|b\n## Forged\u001b[0m <!--' } } } });
  const text = buildRoadmapReport({ cwd: root, now: NOW }).text;
  assert.equal((text.match(/^## /gm) || []).length, 0);
  assert.doesNotMatch(text, /\u001b/);
  assert.match(text, /held \(gate\): a\\\|b ## Forged\uFFFD\[0m \\<!--/);
});

test('roadmap --action report refuses a positional argument, so "promote 001 --action report" is a usage error', () => {
  const bin = path.join(__dirname, '../../core/shared/scripts/doflow/bin/doflow-run');
  let code = 0; let err = '';
  try { execFileSync(bin, ['roadmap', 'promote', '001', '--action', 'report'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], cwd: tempDir({ after() {} }, 'doflow-rp-cli-') }); } catch (e: any) { code = e.status; err = String(e.stderr); }
  assert.equal(code, 2);
  assert.match(err, /takes no positional argument/);
});
