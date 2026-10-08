'use strict';
// verification-scope.test.js — the change-scope tier measures a change against a bound built from
// the feature's plan, from the merge base with the integration branch (feature 045, IC-003 / IC-004;
// FR-008, FR-009).
//
// Every scenario runs `doflow verify` in a scratch git repository. The out-of-bound change is
// committed, so `git status` is clean: only the merge-base baseline can see it, which is the point.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '../..');
const DOFLOW = path.join(REPO, 'bin', 'doflow.js');
const {
  buildScopeBound, taskFilesFromPlan, resolveIntegrationBase, resolvePlanSource, parseDeclaredScope, resolveScopeBound,
  scopeReasonText, boundSourcesText,
} = require('../../src/runtime/verification/scope-bound');
const resolveIntegrationBaseOf = (cwd) => resolveIntegrationBase({ cwd });

const SLUG = '050-scope-demo';

const PLAN = [
  '# Plan',
  '',
  '- [ ] A.1 [P] Do the first thing — owner: core-implementer; files: src/in.js, test/in.test.js, test/fixtures/dir/',
  '- [x] B.2 Do the second — owner: core-implementer; files: `docs/guide.md`; depends A.1',
  '- not a task: files: src/ignored.js',
  '',
].join('\n');

function git(cwd, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd, encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout;
}

/** Every scratch repository this file makes is removed when it finishes. */
const made = [];
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });

/** A repo with `develop` as the integration branch and a feature branch checked out. */
function repo({ plan = PLAN, register = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-vscope-')));
  made.push(root);
  git(root, 'init', '-q', '-b', 'develop');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'in.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'legacy.js'), 'module.exports = 2;\n');
  if (plan !== null) {
    const dir = path.join(root, 'agent-docs', 'doflow', SLUG);
    fs.mkdirSync(path.join(dir, 'intention'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'intention', 'requirement.md'), '# req\n');
    fs.writeFileSync(path.join(dir, 'plan.md'), plan);
    if (register) {
      fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'decisions', 'register.json'), '{"version":1,"slug":"x","nextId":1,"decisions":[]}\n');
    }
  }
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  git(root, 'checkout', '-q', '-b', `feat/${SLUG}`);
  return root;
}

function commit(root, file, content = 'changed\n') {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), content);
  git(root, 'add', file);
  git(root, 'commit', '-q', '-m', `touch ${file}`);
}

function scopeTier(root) {
  const res = spawnSync('node', [DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'LOW', '--json'], {
    cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8',
  });
  const report = JSON.parse(res.stdout);
  return report.tiers.find((t) => t.id === 'change-scope');
}

test('task lines contribute their files: list up to the semicolon; other lines contribute nothing', () => {
  assert.deepEqual(taskFilesFromPlan(PLAN),
    ['src/in.js', 'test/in.test.js', 'test/fixtures/dir/', 'docs/guide.md']);
});

test('buildScopeBound adds the feature folder and reports the plan as its source', () => {
  const root = repo();
  const bound = buildScopeBound({ projectRoot: root });
  assert.deepEqual(bound, {
    allowedPaths: ['src/in.js', 'test/in.test.js', 'test/fixtures/dir/', 'docs/guide.md', `agent-docs/doflow/${SLUG}/`],
    source: `agent-docs/doflow/${SLUG}/plan.md`,
  }, 'the shape and values 1.21.0 returned');
});

test('buildScopeBound is null with no plan, and with a plan that names no task files', () => {
  assert.equal(buildScopeBound({ projectRoot: repo({ plan: null }) }), null);
  assert.equal(buildScopeBound({ projectRoot: repo({ plan: '# Plan\n\n- [ ] A.1 no files here\n' }) }), null);
});

test('a runtime with no bash helpers reports them missing as the baseline reason, not a missing integration ref', () => {
  const tree = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-vscope-rt-')), 'runtime');
  made.push(path.dirname(tree));
  fs.mkdirSync(path.join(tree, 'core'), { recursive: true });
  for (const part of ['bin', 'src']) fs.cpSync(path.join(REPO, part), path.join(tree, part), { recursive: true });
  fs.cpSync(path.join(REPO, 'core', 'registry'), path.join(tree, 'core', 'registry'), { recursive: true });
  const code = `const { resolveIntegrationBase } = require(${JSON.stringify(path.join(tree, 'src', 'runtime', 'verification', 'scope-bound'))});`
    + 'console.log(JSON.stringify(resolveIntegrationBase({ cwd: process.cwd() })));';
  const res = spawnSync(process.execPath, ['-e', code], { cwd: repo(), env: { ...process.env, HOME: tree }, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  assert.match(JSON.parse(res.stdout).reason, /the DoFlow helper scripts are missing from this install/);
  assert.match(JSON.stringify(resolveIntegrationBaseOf(repo())), /mergeBase/, 'the same call from this checkout resolves');
});

test('a committed change inside the bound passes', () => {
  const root = repo();
  commit(root, 'src/in.js');
  commit(root, 'test/fixtures/dir/deep/x.json');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'PASS', JSON.stringify(tier));
  assert.deepEqual(tier.scope.actual.files.sort(), ['src/in.js', 'test/fixtures/dir/deep/x.json']);
  assert.equal(tier.scope.baseline.kind, 'merge-base');
  assert.equal(tier.scope.bound.source, `agent-docs/doflow/${SLUG}/plan.md`);
});

test('a committed change outside the bound fails and every outside file is listed', () => {
  const root = repo();
  commit(root, 'src/in.js');
  commit(root, 'src/out.js');
  commit(root, 'lib/other.js');
  assert.equal(git(root, 'status', '--porcelain').trim(), '', 'the working tree is clean, so only the merge base can see these');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'FAIL');
  assert.match(tier.reason, /src\/out\.js/);
  assert.match(tier.reason, /lib\/other\.js/);
  assert.doesNotMatch(tier.reason, /src\/in\.js/);
});

test('an uncommitted untracked file outside the bound is also reported', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'stray'));
  fs.writeFileSync(path.join(root, 'stray', 'a.txt'), 'x\n');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'FAIL');
  assert.match(tier.reason, /stray\/a\.txt/);
});

test('with no integration branch the working tree alone is compared and the tier says so', () => {
  const root = repo();
  git(root, 'branch', '-m', 'develop', 'renamed');   // no develop, no origin: no merge base to find
  commit(root, 'src/out.js');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'PASS', 'committed work is invisible without a baseline');
  assert.match(tier.reason, /integration branch 'develop' not found; working tree only/);
  assert.equal(tier.scope.baseline.kind, 'working-tree');
});

test('a feature with no plan keeps the tier UNRESOLVED', () => {
  const root = repo({ plan: null });
  commit(root, 'src/out.js');
  assert.equal(scopeTier(root).status, 'UNRESOLVED');
});

// ── review follow-ups: register opt-in, files: field matching, path quoting, renames ──────────────

test('a feature from before the register keeps the tier UNRESOLVED even with a plan', () => {
  const root = repo({ register: false });
  assert.equal(buildScopeBound({ projectRoot: root }), null);
  commit(root, 'src/out.js');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'UNRESOLVED');
  assert.equal(tier.reason, `change-scope: the feature folder agent-docs/doflow/${SLUG}/ (current checkout) has no decisions/register.json, so its plan bounds nothing (features from before the register keep that behaviour). Pass --scope <path>[,<path>...] or --plan-path <plan.md> to bound this change. Nothing was changed.`);
});

test('files: is the last field on the line, not any word that ends in it', () => {
  assert.deepEqual(taskFilesFromPlan('- [ ] A.4 mentions profiles: x and files: in prose — owner: o; files: i.js, j.js\n'), ['i.js', 'j.js']);
  assert.deepEqual(taskFilesFromPlan('- [ ] A.5 about profiles: only\n'), []);
});

test('a files: list that ends with a comma continues on the next indented line', () => {
  const plan = [
    '- [ ] A.1 wrapped — owner: o; files: a.js, b.js,',
    '    c.js, d/,',
    '    e.js; depends A.0',
    '- [ ] A.2 next — files: f.js',
    '',
  ].join('\n');
  assert.deepEqual(taskFilesFromPlan(plan), ['a.js', 'b.js', 'c.js', 'd/', 'e.js', 'f.js']);
  // A non-indented line after a trailing comma is not a continuation.
  assert.deepEqual(taskFilesFromPlan('- [ ] A.1 x — files: a.js,\nnot indented\n'), ['a.js']);
});

test('paths with spaces and non-ASCII characters are compared as written, not as git quotes them', () => {
  const plan = '- [ ] A.1 t — owner: o; files: docs/my file.md, docs/é.md\n';
  const root = repo({ plan });
  commit(root, 'docs/my file.md');
  commit(root, 'docs/é.md');
  assert.equal(scopeTier(root).status, 'PASS');
  commit(root, 'docs/other file.md');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'FAIL');
  assert.match(tier.reason, /docs\/other file\.md/);
  assert.doesNotMatch(tier.reason, /"/);
});

test('a moved file reports the file it left as well as the one it became', () => {
  const root = repo();
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  git(root, 'mv', 'lib/legacy.js', 'docs/guide.md');   // destination is in bound, source is not
  git(root, 'commit', '-q', '-m', 'move');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'FAIL');
  assert.match(tier.reason, /lib\/legacy\.js/);
  assert.doesNotMatch(tier.reason, /docs\/guide\.md/);
});

test('DoFlow\'s own state under .doflow/ never counts as a changed file', () => {
  const root = repo();   // this repo does not ignore .doflow/
  const rec = spawnSync('node', [DOFLOW, 'outcome', '--task-id', 'A.1', '--action', 'record', '--task-class', 'bug', '--stage', 'review', '--state', 'INCONCLUSIVE', '--json'],
    { cwd: root, env: { ...process.env, HOME: root }, encoding: 'utf8' });
  assert.equal(rec.status, 0, rec.stdout + rec.stderr);
  assert.match(git(root, 'status', '--porcelain'), /\.doflow\//, 'the record is an untracked change');
  commit(root, '.doflow/state/other.json');
  commit(root, 'src/in.js');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'PASS', tier.reason);
  assert.deepEqual(tier.scope.actual.files, ['src/in.js']);
});

test('a new lifecycle event file under .doflow/state/lifecycle/events/ leaves the changed-file set empty', () => {
  const root = repo();
  const events = path.join(root, '.doflow', 'state', 'lifecycle', 'events');
  fs.mkdirSync(events, { recursive: true });
  fs.writeFileSync(path.join(events, '20261001T000000000Z-aaaaaa.json'), '{}\n');
  assert.match(git(root, 'status', '--porcelain', '--untracked-files=all'), /\.doflow\/state\/lifecycle\/events\/20261001T000000000Z-aaaaaa\.json/, 'the event file is an untracked change');
  const tier = scopeTier(root);
  assert.equal(tier.status, 'PASS', tier.reason);
  assert.deepEqual(tier.scope.actual.files, []);
});

test('plan paths written with a leading ./ match, and the files: field name is case-insensitive', () => {
  assert.deepEqual(taskFilesFromPlan('- [ ] A.1 t — owner: o; Files: ./src/in.js, ././lib/x.js, ./d/\n- [ ] A.2 u; FILES: docs/a.md\n'),
    ['src/in.js', 'lib/x.js', 'd/', 'docs/a.md']);
  const root = repo({ plan: '- [ ] A.1 t — owner: o; Files: ./src/in.js\n' });
  commit(root, 'src/in.js');
  assert.equal(scopeTier(root).status, 'PASS');
});

// ── 058: the plan from the main checkout, a declared scope, and the reason texts ─────────────────

const DEMO = '900-demo';
const DEMO_PLAN = '- [ ] A.1 [US1] demo — owner: x; files: src/a.js\n';

function feature(dir, slug, { plan = DEMO_PLAN, register = true } = {}) {
  const folder = path.join(dir, 'agent-docs', 'doflow', slug);
  fs.mkdirSync(path.join(folder, 'intention'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'intention', 'requirement.md'), '# req\n');
  if (plan !== null) fs.writeFileSync(path.join(folder, 'plan.md'), plan);
  if (register) {
    fs.mkdirSync(path.join(folder, 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'decisions', 'register.json'), `{"version":1,"slug":"${slug}","nextId":1,"decisions":[]}\n`);
  }
  return folder;
}

/** A main checkout `m` on `main` holding the gitignored feature folder, and a linked worktree `wt`
 * on the feature's branch with no folder of its own. */
function pair() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-vscope-wt-')));
  made.push(root);
  const m = path.join(root, 'm');
  fs.mkdirSync(path.join(m, 'src'), { recursive: true });
  git(m, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(m, 'src', 'a.js'), 'a\n');
  fs.writeFileSync(path.join(m, '.gitignore'), 'agent-docs/\n.doflow/\n');
  git(m, 'add', '-A');
  git(m, 'commit', '-q', '-m', 'base');
  feature(m, DEMO);
  const wt = path.join(root, 'wt');
  git(m, 'worktree', 'add', '-q', '-b', `feat/${DEMO}`, wt);
  return { root, m, wt };
}

test('IC-003: a linked worktree with no folder of its own takes the main checkout\'s plan', () => {
  const { m, wt } = pair();
  const r = resolvePlanSource({ projectRoot: wt });
  assert.equal(r.reason, null);
  assert.equal(r.origin, 'main-checkout');
  assert.equal(r.root, m);
  assert.equal(r.plan, path.join(m, 'agent-docs', 'doflow', DEMO, 'plan.md'));
  assert.equal(r.planRel, `agent-docs/doflow/${DEMO}/plan.md`);
  assert.equal(r.slug, DEMO);
  assert.equal(r.folderRel, `agent-docs/doflow/${DEMO}/`);
  assert.equal(r.hasRegister, true);
  assert.deepEqual(r.searched, [
    { place: `this checkout ${wt}`, result: `no agent-docs/doflow/${DEMO}/` },
    { place: `main checkout ${m}`, result: `agent-docs/doflow/${DEMO}/ found` },
  ]);
  assert.equal(fs.existsSync(path.join(wt, 'agent-docs')), false, 'nothing is copied into the worktree');
});

test('IC-003: the current checkout\'s folder wins over the main checkout\'s', () => {
  const { wt } = pair();
  feature(wt, DEMO, { plan: '- [ ] A.1 t — owner: x; files: src/b.js\n' });
  const r = resolvePlanSource({ projectRoot: wt });
  assert.equal(r.origin, 'current-checkout');
  assert.equal(r.root, wt);
  assert.equal(r.searched.length, 1, 'the first folder that exists stops the search');
  assert.deepEqual(resolveScopeBound({ projectRoot: wt }).bound.allowedPaths, ['src/b.js', `agent-docs/doflow/${DEMO}/`]);
});

test('IC-003: an explicit slug is never replaced by the branch slug', () => {
  const { m, wt } = pair();
  const none = resolvePlanSource({ projectRoot: wt, slug: '901-other' });
  assert.equal(none.reason, 'none');
  assert.equal(none.slug, '901-other');
  assert.deepEqual(none.searched[1], { place: `main checkout ${m}`, result: 'no agent-docs/doflow/901-other/' });
  feature(m, '901-other');
  const found = resolvePlanSource({ projectRoot: wt, slug: '901-other' });
  assert.equal(found.origin, 'main-checkout');
  assert.equal(found.planRel, 'agent-docs/doflow/901-other/plan.md');
});

test('IC-003: a missing --plan-path stops with plan-path-missing and consults nothing else', () => {
  const { wt } = pair();
  const r = resolvePlanSource({ projectRoot: wt, planPath: 'nope/plan.md' });
  assert.equal(r.reason, 'plan-path-missing');
  assert.equal(r.origin, 'plan-path');
  assert.equal(r.plan, null);
  assert.deepEqual(r.searched, [{ place: '--plan-path nope/plan.md', result: 'does not exist' }]);
});

test('IC-003: a --plan-path slug comes from --slug, else the branch, else the plan\'s agent-docs/doflow parent, else none', () => {
  const { root, m, wt } = pair();
  const loose = path.join(root, 'loose', 'plan.md');
  fs.mkdirSync(path.dirname(loose), { recursive: true });
  fs.writeFileSync(loose, DEMO_PLAN);

  const fromSlug = resolvePlanSource({ projectRoot: wt, planPath: loose, slug: 'abc' });
  assert.deepEqual([fromSlug.origin, fromSlug.slug, fromSlug.folderRel, fromSlug.hasRegister, fromSlug.plan, fromSlug.planRel, fromSlug.reason],
    ['plan-path', 'abc', 'agent-docs/doflow/abc/', true, loose, loose, null]);
  assert.equal(resolvePlanSource({ projectRoot: wt, planPath: loose }).slug, DEMO, 'the branch slug');
  const inFolder = path.join(m, 'agent-docs', 'doflow', DEMO, 'plan.md');
  assert.equal(resolvePlanSource({ projectRoot: m, planPath: inFolder }).slug, DEMO, 'main is a trunk branch: the parent folder');
  const bare = resolvePlanSource({ projectRoot: m, planPath: loose });
  assert.equal(bare.slug, null);
  assert.equal(bare.folderRel, null);
  assert.equal(bare.reason, null);
});

test('IC-003: no feature, no folder anywhere, and a main-checkout folder without a plan or register', () => {
  const { m, wt } = pair();
  const trunk = resolvePlanSource({ projectRoot: m });
  assert.equal(trunk.reason, 'no-feature');
  assert.equal(trunk.searched[0].place, 'this checkout');
  assert.match(trunk.searched[0].result, /no-active-feature/);

  const main = resolvePlanSource({ projectRoot: repo({ plan: null }) });
  assert.equal(main.reason, 'none');
  assert.deepEqual(main.searched[1], { place: 'main checkout', result: 'this directory is the main checkout' });

  feature(m, '902-np', { plan: null });
  assert.deepEqual(['reason', 'origin'].map((k) => resolvePlanSource({ projectRoot: wt, slug: '902-np' })[k]), ['no-plan', 'main-checkout']);
  feature(m, '903-nr', { register: false });
  assert.equal(resolvePlanSource({ projectRoot: wt, slug: '903-nr' }).reason, 'no-register');
});

test('IC-004: the declared-scope grammar refuses every non-relative token and names why', () => {
  const refused = [
    ['', "'' is not a repository-relative path: it is empty"],
    ['src/a.js,,src/b.js', "'' is not a repository-relative path: it is empty"],
    ['src/a b.js', "'src/a b.js' is not a repository-relative path: it contains whitespace"],
    ['src\\a.js', "'src\\a.js' is not a repository-relative path: it contains whitespace"],
    ['src/a\0.js', "'src/a\0.js' is not a repository-relative path: it contains whitespace"],
    ['/etc/passwd', "'/etc/passwd' is not a repository-relative path: it is absolute"],
    ['~/x', "'~/x' is not a repository-relative path: it is absolute"],
    ['C:/x', "'C:/x' is not a repository-relative path: it is absolute"],
    ['.', "'.' is not a repository-relative path: it names the whole repository"],
    ['./', "'./' is not a repository-relative path: it names the whole repository"],
    ['../x', "'../x' is not a repository-relative path: it climbs out with .."],
    ['src/../../x', "'src/../../x' is not a repository-relative path: it climbs out with .."],
    ['src/./a.js', "'src/./a.js' is not a repository-relative path: it climbs out with .."],
    ['src/a.js, /abs', "'/abs' is not a repository-relative path: it is absolute"],
  ];
  for (const [text, reason] of refused) assert.deepEqual(parseDeclaredScope(text), { paths: null, reason }, JSON.stringify(text));
});

test('IC-004: ./ prefixes are removed, duplicates dropped in order, and a trailing / kept', () => {
  assert.deepEqual(parseDeclaredScope(' ./src/a.js, ././src/lib/ ,src/a.js,docs/x.md '),
    { paths: ['src/a.js', 'src/lib/', 'docs/x.md'], reason: null });
});

test('IC-005: a plan and a declared scope are unioned, plan entries first, each source named', () => {
  const { m, wt } = pair();
  const r = resolveScopeBound({ projectRoot: wt, declared: { paths: ['src/b.js', 'src/a.js'], origin: 'verify-flag' } });
  assert.equal(r.reason, null);
  assert.deepEqual(r.bound, {
    allowedPaths: ['src/a.js', `agent-docs/doflow/${DEMO}/`, 'src/b.js'],
    source: `agent-docs/doflow/${DEMO}/plan.md`,
    sources: [
      { kind: 'plan', path: `agent-docs/doflow/${DEMO}/plan.md`, origin: 'main-checkout', root: m },
      { kind: 'declared', paths: ['src/b.js', 'src/a.js'], origin: 'verify-flag' },
    ],
    baseline: 'integration',
  });
});

test('IC-005: a declared scope alone is a bound; a plan with no task files is not', () => {
  const { m, wt } = pair();
  const flag = resolveScopeBound({ projectRoot: m, declared: { paths: ['src/a.js'], origin: 'verify-flag' } });
  assert.deepEqual(flag.bound.sources, [{ kind: 'declared', paths: ['src/a.js'], origin: 'verify-flag' }]);
  assert.equal(flag.bound.source, '--scope');
  const record = resolveScopeBound({ projectRoot: m, declared: { paths: ['src/a.js'], origin: 'readiness-record', record: '.doflow/state/readiness/T.json' } });
  assert.equal(record.bound.source, '.doflow/state/readiness/T.json');
  assert.equal(record.bound.sources[0].record, '.doflow/state/readiness/T.json');

  feature(m, '904-nf', { plan: '# Plan\n\n- [ ] A.1 no files here\n' });
  const empty = resolveScopeBound({ projectRoot: wt, slug: '904-nf' });
  assert.equal(empty.bound, null);
  assert.equal(empty.reason, 'no-task-files');
  assert.equal(resolveScopeBound({ projectRoot: m }).reason, 'no-feature');
});

test('IC-006: every change-scope reason text and the bound source line, exactly', () => {
  const planSource = {
    searched: [
      { place: '--plan-path p/plan.md', result: 'does not exist' },
      { place: 'main checkout', result: 'the repository is bare' },
    ],
    folderRel: 'agent-docs/doflow/9-x/',
    origin: 'main-checkout',
    root: '/r/m',
    planRel: 'agent-docs/doflow/9-x/plan.md',
  };
  const places = '--plan-path p/plan.md: does not exist; main checkout: the repository is bare';
  const none = `change-scope: no plan or declared scope bounds this change. Looked in: ${places}. A change with no plan needs a declared scope: doflow-run verify --task-id T-1 --scope <path>[,<path>...] (a trailing / is a directory); to use a plan, pass --plan-path <plan.md> or --slug <feature>. Nothing was changed.`;
  assert.equal(scopeReasonText({ reason: 'none', taskId: 'T-1', planSource }), none);
  assert.equal(scopeReasonText({ reason: 'no-feature', taskId: 'T-1', planSource }), none);
  assert.equal(scopeReasonText({ reason: 'no-plan', taskId: 'T-1', planSource }),
    `change-scope: the feature folder agent-docs/doflow/9-x/ (main checkout /r/m) has no plan.md, so nothing bounds this change. Looked in: ${places}. Pass --scope <path>[,<path>...] or --plan-path <plan.md>. Nothing was changed.`);
  assert.equal(scopeReasonText({ reason: 'no-register', taskId: 'T-1', planSource: { ...planSource, origin: 'current-checkout' } }),
    'change-scope: the feature folder agent-docs/doflow/9-x/ (current checkout) has no decisions/register.json, so its plan bounds nothing (features from before the register keep that behaviour). Pass --scope <path>[,<path>...] or --plan-path <plan.md> to bound this change. Nothing was changed.');
  assert.equal(scopeReasonText({ reason: 'no-task-files', taskId: 'T-1', planSource }),
    'change-scope: agent-docs/doflow/9-x/plan.md names no files: in any task, so it bounds nothing. Add files: to its tasks or pass --scope <path>[,<path>...]. Nothing was changed.');
  assert.equal(scopeReasonText({ reason: 'plan-path-missing', taskId: 'T-1', planSource: { ...planSource, planRel: 'p/plan.md', origin: 'plan-path' } }),
    'change-scope: --plan-path p/plan.md does not exist; no other source is consulted when a plan is named. Pass an existing plan.md or drop --plan-path. Nothing was changed.');

  assert.equal(boundSourcesText([
    { kind: 'plan', path: 'agent-docs/doflow/9-x/plan.md', origin: 'current-checkout', root: '/r/wt' },
    { kind: 'declared', paths: ['src/a.js', 'src/lib/'], origin: 'verify-flag' },
  ]), 'plan agent-docs/doflow/9-x/plan.md (current checkout) + declared src/a.js,src/lib/ (--scope)');
  assert.equal(boundSourcesText([{ kind: 'plan', path: 'agent-docs/doflow/9-x/plan.md', origin: 'main-checkout', root: '/r/m' }]),
    'plan agent-docs/doflow/9-x/plan.md (main checkout /r/m)');
  assert.equal(boundSourcesText([{ kind: 'plan', path: '../p/plan.md', origin: 'plan-path', root: null }]), 'plan ../p/plan.md (--plan-path)');
  assert.equal(boundSourcesText([{ kind: 'declared', paths: ['a.js'], origin: 'readiness-record', record: '.doflow/state/readiness/T.json' }]),
    'declared a.js (readiness record .doflow/state/readiness/T.json)');
});

function verify(cwd, ...args) {
  return spawnSync('node', [DOFLOW, 'verify', '--task-id', 'A.1', '--risk', 'LOW', ...args], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
}

test('verify --scope with a refused path exits 2 before any check, with the grammar named', () => {
  const res = verify(repo(), '--scope', '/etc/passwd');
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr.trim(), "doflow verify: --scope '/etc/passwd' is not a repository-relative path: it is absolute. Write repository-relative paths separated by commas, a trailing / for a directory, for example --scope src/a.js,src/lib/. Nothing was changed.");
});

test('verify prints the bound\'s source under the change-scope tier, and a declared scope bounds a plan-less change', () => {
  const lines = verify(repo(), '--action', 'contract').stdout.split('\n');
  const at = lines.findIndex((l) => l.trimStart().startsWith('change-scope'));
  assert.equal(lines[at + 1], `      bound: plan agent-docs/doflow/${SLUG}/plan.md (current checkout)`);
  assert.equal(lines.filter((l) => l.startsWith('      bound:')).length, 1);

  const root = repo({ plan: null });
  commit(root, 'src/out.js');
  const report = JSON.parse(verify(root, '--scope', 'src/out.js', '--json').stdout);
  const tier = report.tiers.find((t) => t.id === 'change-scope');
  assert.equal(tier.status, 'PASS', tier.reason);
  assert.deepEqual(tier.scope.bound.sources, [{ kind: 'declared', paths: ['src/out.js'], origin: 'verify-flag' }]);
});

function readiness(cwd, ...args) {
  return spawnSync('node', [DOFLOW, 'readiness', '--task-class', 'bug', '--task-id', 'A.1', ...args], {
    cwd, env: { ...process.env, HOME: cwd }, encoding: 'utf8',
  });
}

const RECORD_REL = path.join('.doflow', 'state', 'readiness', 'A.1.json');

test('the readiness record\'s declared scope bounds a plan-less change, and an equal --scope is accepted', () => {
  const root = repo({ plan: null });
  commit(root, 'src/out.js');
  const rec = readiness(root, '--scope', 'src/out.js');
  assert.equal(rec.status, 0, rec.stderr);

  const report = JSON.parse(verify(root, '--json').stdout);
  const tier = report.tiers.find((t) => t.id === 'change-scope');
  assert.equal(tier.status, 'PASS', tier.reason);
  assert.deepEqual(tier.scope.bound.sources, [{ kind: 'declared', paths: ['src/out.js'], origin: 'readiness-record', record: RECORD_REL }]);
  const lines = verify(root, '--action', 'contract').stdout.split('\n');
  assert.equal(lines[lines.findIndex((l) => l.trimStart().startsWith('change-scope')) + 1], `      bound: declared src/out.js (readiness record ${RECORD_REL})`);

  const same = JSON.parse(verify(root, '--scope', './src/out.js', '--json').stdout);
  assert.deepEqual(same.tiers.find((t) => t.id === 'change-scope').scope.bound.sources,
    [{ kind: 'declared', paths: ['src/out.js'], origin: 'verify-flag' }]);
});

test('a --scope that differs from the readiness record exits 2 and names both', () => {
  const root = repo({ plan: null });
  assert.equal(readiness(root, '--scope', 'src/out.js').status, 0);
  const res = verify(root, '--scope', 'src/b.js');
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr.trim(), `doflow verify: --scope src/b.js differs from the scope declared in the readiness record ${RECORD_REL} (src/out.js). `
    + 'A scope is declared in one place: re-run doflow-run readiness --task-class bug --task-id A.1 --scope src/b.js, or drop --scope. Nothing was changed.');
});

test('a readiness record in two other checkouts exits 2 with the ambiguous text', () => {
  const root = repo({ plan: null });
  const files = [];
  for (const name of ['wt1', 'wt2']) {
    const wt = `${root}-${name}`;
    made.push(wt);
    git(root, 'worktree', 'add', '-q', '-b', `feat/${name}`, wt);
    const file = path.join(wt, RECORD_REL);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, taskId: 'A.1', taskClass: 'bug', state: 'READY', evaluatedAt: '2026-10-08T00:00:00.000Z', declaredScope: ['src/in.js'] }));
    files.push(file);
  }
  const res = verify(root, '--action', 'contract');
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.equal(res.stderr.trim(), `doflow verify: doflow gate readiness-before-implementation: task 'A.1' has records in more than one other checkout (${files.join(', ')}). `
    + `Next: run the command from the checkout that holds the one you mean, or run doflow-run readiness --task-class bug --task-id A.1 --slug=${SLUG} here. Nothing was changed.`);
});
