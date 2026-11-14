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
const { writeReviewPack, buildRoadmapReport, handleRoadmapReportCommand } = require('../../src/runtime/review-pack.ts');

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
  git(root, 'init', '-q', '-b', 'main');
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
  assert.match(three, /gate-0: approve by person at 2026-11-14T10:00:00.000Z; note: looks fine/);
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
  const runId = 'rl-20261114-ABCD';
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
  assert.match(report.text, /\| 001 \| Alpha \\\| the first \| feature \|/);
  assert.match(report.text, /\| 002 \| Beta \| bug \| none recorded \| held \(gate\): markers-nonzero \| 0 \| 1 \| agent-docs\/doflow\/002-beta\/review-pack\.md \|/);
  assert.equal(report.file, path.join(root, '.doflow/state/roadmap/runs', `${runId}.report.md`));
});

test('roadmap report writes beside the run record, and refuses an unknown run', (t) => {
  const { root } = fixture(t);
  const runId = 'rl-20261114-ABCD';
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
  assert.equal(out.path, path.join(root, '.doflow/state/roadmap/runs', `${runId}.report.md`));
  assert.match(fs.readFileSync(out.path, 'utf8'), /Rows: none recorded/);
  assert.equal(buildRoadmapReport({ cwd: root, runId: 'rl-20261114-ZZZZ', now: NOW }).ok, false);
});
