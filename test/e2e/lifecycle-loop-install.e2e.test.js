'use strict';

// lifecycle-loop-install.e2e.test.js: the lifecycle verbs reached the way a Codex user reaches
// them, and the documented behaviour when nothing is installed.
//
// Every harness projects the runtime wherever it projects skills, so a skill's resolver reaches the
// dispatcher after an install. The first halves are real installs into scratch homes, executed
// through the projected locator and the resolver block the installed skill carries; the last half
// runs the checkout's own resolver and locator with nothing installed, where the skill stops. The
// Codex CLI itself is never invoked: the harness only matters here as the place the files are
// projected to. No network and no model call.
//
// Every spawn runs under a scratch HOME and XDG_CONFIG_HOME and with no global git config (DEC-041).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { resolverOf, filesUnder } = require('../helper/skill-resolver');
const { makeRepo, featureBranch } = require('../helper/lifecycle-git-fixtures');
const { IS_WIN } = require('../helper-platform');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SKIP = IS_WIN ? 'the projected locator and the skill resolver are POSIX shell' : false;

const scratch = createScratch('doflow-loop-install-');
after(() => scratch.remove());

let counter = 0;

/** A scratch home of its own, so one harness's install never leaks into the next one's resolution. */
function homeFor(name) {
  const dir = path.join(scratch.dir, `${name}-${(counter += 1)}`);
  const home = path.join(dir, 'home');
  const xdg = path.join(dir, 'xdg');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  return { dir, home, xdg };
}

const envFor = (h, extra = {}) => scratch.env({
  HOME: h.home, USERPROFILE: h.home, XDG_CONFIG_HOME: h.xdg,
  DOFLOW_CONFIG_DIR: '', DOFLOW_CLI: '', DOFLOW_AGENT: '', DOFLOW_FAILURE_CAPTURE: '',
  ...extra,
});

/** `doflow install -g` for one target into the scratch home. */
function install(h, target) {
  const r = spawnSync(process.execPath, [CLI, 'install', '-g', '-f', '--no-backup', '-t', target], {
    cwd: h.dir, encoding: 'utf8', input: '\n', env: envFor(h),
  });
  assert.equal(r.status, 0, `install -t ${target}: ${r.stderr}`);
}

function run(h, cwd, locator, args, { input = '' } = {}) {
  const r = spawnSync('bash', [locator, ...args], { cwd, input, encoding: 'utf8', env: envFor(h) });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** The skill file a harness installed, found by walking its home. */
function installedSkill(h, name) {
  const hit = filesUnder(h.home).find((f) => f.split(path.sep).slice(-3).join('/') === `skills/${name}/SKILL.md`);
  assert.ok(hit, `no installed ${name} skill under ${h.home}`);
  return path.join(h.home, hit);
}

describe('Codex target: the lifecycle verbs run through the codex-projected dispatcher', { skip: SKIP }, () => {
  const h = homeFor('codex');
  const project = makeRepo(scratch, 'codex-project');
  const locator = path.join(h.home, '.codex', 'bin', 'doflow-run');

  test('the codex install projects the locator and the runtime the verbs need', () => {
    install(h, 'codex');
    assert.ok(fs.existsSync(locator), 'the codex locator is projected');
    assert.ok(fs.existsSync(path.join(h.home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run')), 'the dispatcher is projected');
    assert.ok(fs.existsSync(path.join(h.home, '.doflow', 'runtime', 'bin', 'doflow.js')), 'the Node runtime is projected');
  });

  test('lifecycle --action overview and followup --action list answer from a scratch repository', () => {
    const overview = run(h, project.dir, locator, ['lifecycle', '--action', 'overview', '--json']);
    assert.equal(overview.status, 0, overview.stderr);
    assert.deepEqual([overview.json.ok, overview.json.mode], [true, 'discovery']);
    assert.deepEqual([overview.json.releaseMode, overview.json.integrationRef], ['untagged', 'develop'], 'the installed runtime read the git facts');
    assert.deepEqual(overview.json.followups, { open: 0, shown: 0, items: [] });

    const list = run(h, project.dir, locator, ['followup', '--action', 'list', '--json']);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual([list.json.ok, list.json.count, list.json.items], [true, 0, []]);
    assert.equal(fs.existsSync(path.join(project.dir, 'agent-docs', 'lifecycle')), false, 'reading wrote no lifecycle store');
  });

  test('a follow-up added through the codex dispatcher is listed by it, as an event file in the project', () => {
    const added = run(h, project.dir, locator, ['followup', '--action', 'add', '--stage', 'review', '--slug', '046-codex-smoke', '--statement', 'Smoke: recorded through the codex locator', '--json']);
    assert.equal(added.status, 0, added.stderr);
    const [item] = added.json.created;
    const list = run(h, project.dir, locator, ['followup', '--action', 'list', '--json']);
    assert.deepEqual(list.json.items.map((i) => [i.id, i.statement, i.state]), [[item.id, 'Smoke: recorded through the codex locator', 'open']]);
    assert.equal(fs.readdirSync(path.join(project.dir, 'agent-docs', 'lifecycle', 'events')).length, 1);
    assert.equal(project.git('diff', '--cached', '--name-only'), '', 'nothing is staged');
  });

  test("the installed do skill's resolver finds that same dispatcher", () => {
    const resolver = resolverOf(installedSkill(h, 'do'));
    const r = spawnSync('bash', ['-c', `${resolver}\nprintf '%s' "$DOFLOW"`], { cwd: project.dir, encoding: 'utf8', env: envFor(h) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.realpathSync(r.stdout), fs.realpathSync(path.join(h.home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run')));
  });
});

// The installed Node runtime carries only bin/, src/ and core/registry/, so the git facts helper is the
// one projected beside it (`<install>/.doflow/scripts/doflow/bash/do-git-state.sh`), not the checkout's.
describe('An installed runtime reads the git facts the lifecycle verbs need (global and project-local shapes)', { skip: SKIP }, () => {
  /** The facts every installed runtime must derive in a fresh scratch repository on develop. */
  function assertGitFacts(h, dispatcher, label) {
    const repo = makeRepo(scratch, `facts-${label}`);
    const overview = run(h, repo.dir, dispatcher, ['lifecycle', '--action', 'overview', '--json']);
    assert.equal(overview.status, 0, overview.stderr);
    assert.deepEqual([overview.json.releaseMode, overview.json.integrationRef], ['untagged', 'develop'], `${label}: ${overview.stdout}`);
    const release = run(h, repo.dir, dispatcher, ['lifecycle', '--action', 'release', '--tag', 'v1.0.0', '--json']);
    assert.notEqual(release.json && release.json.finding, 'no-integration-ref', `${label}: ${release.stdout}`);
    assert.equal(release.status, 0, `${label}: ${release.stdout}${release.stderr}`);
  }

  for (const target of ['claude', 'codex', 'gemini']) {
    test(`${target}, global: the projected dispatcher derives the release mode and the integration ref`, () => {
      const h = homeFor(`facts-${target}`);
      install(h, target);
      assertGitFacts(h, path.join(h.home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run'), target);
    });
  }

  test('claude, project-local: <project>/.doflow derives the same facts', () => {
    const h = homeFor('facts-local');
    const projectRoot = path.join(h.dir, 'install-root');
    fs.mkdirSync(projectRoot);
    const r = spawnSync(process.execPath, [CLI, 'install', projectRoot, '-f', '--no-backup', '-t', 'claude'], { cwd: h.dir, encoding: 'utf8', input: '\n', env: envFor(h) });
    assert.equal(r.status, 0, r.stderr);
    assertGitFacts(h, path.join(projectRoot, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run'), 'project-local');
  });
});

// The handoff line and the change-scope tier read two bash helpers (do-paths.sh, do-git-state.sh). The
// installed runtime carries neither inside itself, so both come from `<install>/.doflow/scripts`
// (FR-004, DEC-048). The handoff line is run word for word as WORKFLOW_HANDOFF.md prints it, with no --slug.
describe('An installed runtime finds its bash helpers: the handoff line and the change-scope tier', { skip: SKIP }, () => {
  const FEATURE = '060-thing';
  const PLAN = `# Plan\n\n- [ ] A.1 Do it - owner: core-implementer; files: src/in.js\n`;

  /** A scratch repository on `feat/060-thing` whose feature folder exists; `withPlan` adds the plan and register. */
  function featureRepo(label, { withPlan = false } = {}) {
    const repo = makeRepo(scratch, `handoff-${label}`);
    repo.dir = fs.realpathSync(repo.dir);
    const dir = path.join(repo.dir, 'agent-docs', 'doflow', FEATURE);
    fs.mkdirSync(path.join(dir, 'intention'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'intention', 'requirement.md'), '# req\n');
    if (withPlan) {
      fs.writeFileSync(path.join(dir, 'plan.md'), PLAN);
      fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'decisions', 'register.json'), '{"version":1,"slug":"x","nextId":1,"decisions":[]}\n');
      fs.mkdirSync(path.join(repo.dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(repo.dir, 'src', 'in.js'), 'module.exports = 1;\n');
    }
    repo.git('add', '-A');
    repo.git('commit', '-q', '-m', 'feature folder');
    repo.checkout('-b', `feat/${FEATURE}`);
    return repo;
  }

  /** The handoff line, verbatim, through the projected dispatcher; no --slug. */
  function assertHandoffLine(h, dispatcher, label) {
    const repo = featureRepo(label);
    const r = run(h, repo.dir, dispatcher, ['followup', '--action', 'add', '--stage', 'review', '--statement', 'x', '--json']);
    assert.equal(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(r.json.created.map((i) => [i.source.kind, i.source.feature, i.source.stage]), [['stage', FEATURE, 'review']], label);
  }

  /** `verify` reaches the change-scope tier: the plan bound (do-paths.sh) and the merge base (do-git-state.sh). */
  function assertChangeScope(h, dispatcher, label) {
    const repo = featureRepo(`${label}-scope`, { withPlan: true });
    fs.writeFileSync(path.join(repo.dir, 'src', 'in.js'), 'module.exports = 2;\n');
    repo.git('add', 'src/in.js');
    repo.git('commit', '-q', '-m', 'change');
    const r = run(h, repo.dir, dispatcher, ['verify', '--task-id', 'A.1', '--risk', 'LOW', '--json']);
    const tier = r.json && r.json.tiers.find((t) => t.id === 'change-scope');
    assert.ok(tier, `${label}: ${r.stdout}${r.stderr}`);
    assert.equal(tier.status, 'PASS', `${label}: ${JSON.stringify(tier)}`);
    assert.equal(tier.scope.baseline.kind, 'merge-base', label);
    assert.equal(tier.scope.bound.source, `agent-docs/doflow/${FEATURE}/plan.md`, label);
  }

  for (const target of ['claude', 'codex', 'gemini']) {
    const dispatcherOf = (h) => path.join(h.home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run');
    test(`${target}, global: the handoff line records a stage item for the branch's feature`, () => {
      const h = homeFor(`handoff-${target}`);
      install(h, target);
      assertHandoffLine(h, dispatcherOf(h), target);
    });
    test(`${target}, global: verify finds the plan bound and the merge base`, () => {
      const h = homeFor(`scope-${target}`);
      install(h, target);
      assertChangeScope(h, dispatcherOf(h), target);
    });
  }

  test('claude, project-local: <project>/.doflow does the same for both', () => {
    const h = homeFor('handoff-local');
    const projectRoot = path.join(h.dir, 'install-root');
    fs.mkdirSync(projectRoot);
    const r = spawnSync(process.execPath, [CLI, 'install', projectRoot, '-f', '--no-backup', '-t', 'claude'], { cwd: h.dir, encoding: 'utf8', input: '\n', env: envFor(h) });
    assert.equal(r.status, 0, r.stderr);
    const dispatcher = path.join(projectRoot, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run');
    assertHandoffLine(h, dispatcher, 'project-local');
    assertChangeScope(h, dispatcher, 'project-local');
  });
});

// The lifecycle code paths F.1 never ran installed: release, report, goal and failure, through the
// codex-projected dispatcher against a scratch repository with develop, a tag and a merged feature.
describe('Codex target: release, report, goal and failure run from the installed runtime', { skip: SKIP }, () => {
  const h = homeFor('codex-verbs');
  const locator = path.join(h.home, '.codex', 'bin', 'doflow-run');
  const repo = makeRepo(scratch, 'codex-verbs-project');
  repo.dir = fs.realpathSync(repo.dir);
  const slug = '080-shipped';
  const ok = (args, options) => {
    const r = run(h, repo.dir, locator, [...args, '--json'], options);
    assert.equal(r.status, 0, `${args.join(' ')} -> ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.json, `${args.join(' ')} printed no JSON: ${r.stdout}`);
    return r.json;
  };
  const eventTypes = () => {
    const dir = path.join(repo.dir, 'agent-docs', 'lifecycle', 'events');
    return fs.readdirSync(dir).sort().map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  };

  test('setup: install, an earlier tag, a tracked feature merged after tracking', () => {
    install(h, 'codex');
    repo.tag('v1.0.0');
    fs.mkdirSync(path.join(repo.dir, 'agent-docs', 'doflow', slug), { recursive: true });
    assert.equal(ok(['lifecycle', '--action', 'init', '--slug', slug]).tracked, 'new');
    const trackedAt = eventTypes().find((e) => e.type === 'feature.tracked').at;
    repo.at(new Date(Date.parse(trackedAt) + 10 * 60000).toISOString());
    repo.mergeNoFf(featureBranch(repo, slug, 1));
    assert.deepEqual(ok(['lifecycle', '--action', 'status', '--slug', slug]).status, 'awaiting-release');
  });

  test('lifecycle --action release previews the merged feature, writes nothing to git, and --confirm records it', () => {
    const head = repo.git('rev-parse', 'HEAD');
    const eventsBefore = eventTypes().length;
    const preview = ok(['lifecycle', '--action', 'release', '--tag', 'v1.1.0']);
    assert.equal(preview.recorded, false);
    assert.deepEqual(preview.candidates.map((c) => [c.slug, c.evidence]), [[slug, 'branch']]);
    assert.equal(eventTypes().length, eventsBefore, 'the preview writes nothing');
    assert.deepEqual([repo.git('rev-parse', 'HEAD'), repo.git('tag'), repo.git('status', '--porcelain', '--', '.', ':!agent-docs')], [head, 'v1.0.0', '']);

    // Confirming needs the tag to exist (the verb never creates one), so the user cuts it first.
    repo.tag('v1.1.0');
    const refs = repo.git('for-each-ref');
    const recorded = ok(['lifecycle', '--action', 'release', '--tag', 'v1.1.0', '--confirm']);
    assert.equal(recorded.recorded, true);
    const records = eventTypes().filter((e) => e.type === 'release.recorded');
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].data.tag, records[0].data.features.map((f) => f.slug)], ['v1.1.0', [slug]]);
    assert.deepEqual([repo.git('rev-parse', 'HEAD'), repo.git('for-each-ref')], [head, refs], 'recording a release makes no commit and moves no ref');
    assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  });

  test('followup --action report --stdin keeps a machine-local body under the scratch XDG', () => {
    const filed = ok(['followup', '--action', 'report', '--statement', 'Smoke: crash reported through the installed runtime', '--stdin', '--release', 'v1.1.0'],
      { input: 'TypeError: smoke\n    at cartTotal (cart.js:88)\n' });
    const [item] = filed.created;
    assert.deepEqual([item.state, item.body, item.source.kind], ['open', 'on-this-machine', 'report']);
    const reports = path.join(h.xdg, 'doflow', 'reports');
    const bodies = filesUnder(reports).filter((f) => f.endsWith('.txt'));
    assert.equal(bodies.length, 1, `one body under ${reports}`);
    assert.match(fs.readFileSync(path.join(reports, bodies[0]), 'utf8'), /TypeError: smoke/);
    assert.ok(item.excerptBytes > 0, 'the event carries the bounded excerpt, the body stays here');
  });

  test('goal add, item, check, link, list and done --channel question give the IC-022 results', () => {
    const goal = 'public-api-v2';
    const added = ok(['goal', '--action', 'add', '--goal', goal, '--statement', 'Clients can migrate to v2', '--item', 'v2 endpoints published']);
    assert.deepEqual([added.ok, added.items.map((i) => i.id)], [true, ['C1']]);
    const item = ok(['goal', '--action', 'item', '--goal', goal, '--text', 'Migration guide published']);
    assert.equal(item.item.id, 'C2');
    const linked = ok(['goal', '--action', 'link', '--goal', goal, '--slug', slug]);
    assert.deepEqual([linked.linked, linked.replaced], ['new', null]);
    const checked = ok(['goal', '--action', 'check', '--goal', goal, '--item', 'C1', '--evidence', slug]);
    assert.deepEqual([checked.met, checked.progress, checked.proposeDone], [true, { met: 1, total: 2 }, false]);
    const listed = ok(['goal', '--action', 'list', '--goal', goal]).goals[0];
    assert.deepEqual([listed.status, listed.progress.met, listed.features.awaitingRelease.length + listed.features.finished.length], ['open', 1, 1], 'the linked feature is grouped under the goal');
    const refused = run(h, repo.dir, locator, ['goal', '--action', 'done', '--goal', goal, '--json']);
    assert.deepEqual([refused.status, refused.json.finding], [1, 'not-user']);
    ok(['goal', '--action', 'done', '--goal', goal, '--channel', 'question', '--reason', 'smoke']);
    assert.equal(ok(['goal', '--action', 'list', '--goal', goal]).goals[0].status, 'done');
  });

  test('failure --action list answers from the scratch machine-wide home', () => {
    const list = ok(['failure', '--action', 'list']);
    assert.deepEqual([list.ok, list.entries], [true, []]);
  });
});

describe('No install anywhere: the skill stops at its resolver, before any lifecycle verb', { skip: SKIP }, () => {
  // A fresh home and project with nothing installed. The skill text and the locator are the
  // checkout's own copies, because there is no install to take them from.
  const h = homeFor('no-install');
  const project = makeRepo(scratch, 'no-install-project');

  test('the skill resolver finds no runtime, prints the install hint and exits 2 before a lifecycle verb runs', () => {
    const resolver = resolverOf(path.join(REPO, 'core', 'shared', 'skills', 'do', 'SKILL.md'));
    // What the skill does after its resolver: the lifecycle verb. It must never be reached.
    const script = `${resolver}\necho VERB-REACHED\n"$DOFLOW" lifecycle --action overview --json\n`;
    const r = spawnSync('bash', ['-c', script], { cwd: project.dir, encoding: 'utf8', env: envFor(h) });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /doflow: no runtime found in any \.doflow\/ above .*nor at .*Run: npx @khoavu882\/doflow install -t <harness>$/m);
    assert.equal(r.stdout, '', 'no verb ran, so nothing was printed');
    assert.equal(fs.existsSync(path.join(project.dir, 'agent-docs')), false, 'and nothing was written');
  });

  test('the locator reports the same missing runtime instead of running a verb', () => {
    const locator = path.join(REPO, 'core', 'harnesses', 'shared', 'locator', 'doflow-run');
    const r = run(h, project.dir, locator, ['lifecycle', '--action', 'overview', '--json']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no DoFlow runtime found/);
    assert.ok(r.stderr.includes('npx @khoavu882/doflow install -t <harness>      # project-local, creates ./.doflow'), r.stderr);
    assert.ok(r.stderr.includes('npx @khoavu882/doflow install -t <harness> -g   # global, creates $HOME/.doflow'), r.stderr);
    assert.equal(r.stdout, '');
  });
});
