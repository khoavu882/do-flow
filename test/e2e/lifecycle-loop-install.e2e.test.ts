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
// This file: the Codex-projected dispatcher, the bash helpers, and the no-install case. Siblings:
// lifecycle-loop-install-facts / lifecycle-loop-install-store. Helpers: lifecycle-loop-install.shared.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  REPO, CLI, SKIP, scratch, homeFor, envFor, install, run, installedSkill, resolverOf, makeRepo,
} = require('./lifecycle-loop-install.shared.ts');

after(() => scratch.remove());

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
    for (const rel of [['.doflow', 'state', 'lifecycle'], ['agent-docs', 'lifecycle']]) {
      assert.equal(fs.existsSync(path.join(project.dir, ...rel)), false, `reading wrote no ${rel.join('/')}`);
    }
  });

  test('a follow-up added through the codex dispatcher is listed by it, as an event file in the project', () => {
    const added = run(h, project.dir, locator, ['followup', '--action', 'add', '--stage', 'review', '--slug', '046-codex-smoke', '--statement', 'Smoke: recorded through the codex locator', '--json']);
    assert.equal(added.status, 0, added.stderr);
    const [item] = added.json.created;
    const list = run(h, project.dir, locator, ['followup', '--action', 'list', '--json']);
    assert.deepEqual(list.json.items.map((i: any) => [i.id, i.statement, i.state]), [[item.id, 'Smoke: recorded through the codex locator', 'open']]);
    assert.equal(fs.readdirSync(path.join(project.dir, '.doflow', 'state', 'lifecycle', 'events')).length, 1);
    assert.equal(project.git('diff', '--cached', '--name-only'), '', 'nothing is staged');
  });

  test("the installed do skill's resolver finds that same dispatcher", () => {
    const resolver = resolverOf(installedSkill(h, 'do'));
    const r = spawnSync('bash', ['-c', `${resolver}\nprintf '%s' "$DOFLOW"`], { cwd: project.dir, encoding: 'utf8', env: envFor(h) });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.realpathSync(r.stdout), fs.realpathSync(path.join(h.home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run')));
  });
});

// The handoff line and the change-scope tier read two bash helpers (do-paths.sh, do-git-state.sh). The
// installed runtime carries neither inside itself, so both come from `<install>/.doflow/scripts`
// (FR-004, DEC-048). The handoff line is run word for word as WORKFLOW_HANDOFF.md prints it, with no --slug.
describe('An installed runtime finds its bash helpers: the handoff line and the change-scope tier', { skip: SKIP }, () => {
  const FEATURE = '060-thing';
  const PLAN = `# Plan\n\n- [ ] A.1 Do it - owner: core-implementer; files: src/in.js\n`;

  /** A scratch repository on `feat/060-thing` whose feature folder exists; `withPlan` adds the plan and register. */
  function featureRepo(label: any, { withPlan = false } = {}) {
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
  function assertHandoffLine(h: any, dispatcher: any, label: any) {
    const repo = featureRepo(label);
    const r = run(h, repo.dir, dispatcher, ['followup', '--action', 'add', '--stage', 'review', '--statement', 'x', '--json']);
    assert.equal(r.status, 0, `${label}: ${r.stdout}${r.stderr}`);
    assert.deepEqual(r.json.created.map((i: any) => [i.source.kind, i.source.feature, i.source.stage]), [['stage', FEATURE, 'review']], label);
  }

  /** `verify` reaches the change-scope tier: the plan bound (do-paths.sh) and the merge base (do-git-state.sh). */
  function assertChangeScope(h: any, dispatcher: any, label: any) {
    const repo = featureRepo(`${label}-scope`, { withPlan: true });
    fs.writeFileSync(path.join(repo.dir, 'src', 'in.js'), 'module.exports = 2;\n');
    repo.git('add', 'src/in.js');
    repo.git('commit', '-q', '-m', 'change');
    const r = run(h, repo.dir, dispatcher, ['verify', '--task-id', 'A.1', '--risk', 'LOW', '--json']);
    const tier = r.json && r.json.tiers.find((t: any) => t.id === 'change-scope');
    assert.ok(tier, `${label}: ${r.stdout}${r.stderr}`);
    assert.equal(tier.status, 'PASS', `${label}: ${JSON.stringify(tier)}`);
    assert.equal(tier.scope.baseline.kind, 'merge-base', label);
    assert.equal(tier.scope.bound.source, `agent-docs/doflow/${FEATURE}/plan.md`, label);
  }

  for (const target of ['claude', 'codex']) {
    const dispatcherOf = (h: any) => path.join(h.home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run');
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
    assert.equal(fs.existsSync(path.join(project.dir, '.doflow', 'state', 'lifecycle')), false, 'and nothing was written');
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
