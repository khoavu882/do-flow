'use strict';
// lifecycle-loop-install-facts.e2e.test.js: an installed runtime reads the git facts the lifecycle verbs need, and
// release, report, goal and failure run from the installed runtime. Helpers: lifecycle-loop-install.shared.js.
const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  CLI, SKIP, scratch, homeFor, envFor, install, run, filesUnder, makeRepo, featureBranch,
} = require('./lifecycle-loop-install.shared.ts');

after(() => scratch.remove());

// The installed Node runtime carries only bin/, src/ and core/registry/, so the git facts helper is the
// one projected beside it (`<install>/.doflow/scripts/doflow/bash/do-git-state.sh`), not the checkout's.
describe('An installed runtime reads the git facts the lifecycle verbs need (global and project-local shapes)', { skip: SKIP }, () => {
  /** The facts every installed runtime must derive in a fresh scratch repository on develop. */
  function assertGitFacts(h: any, dispatcher: any, label: any) {
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

// The lifecycle code paths F.1 never ran installed: release, report, goal and failure, through the
// codex-projected dispatcher against a scratch repository with develop, a tag and a merged feature.
describe('Codex target: release, report, goal and failure run from the installed runtime', { skip: SKIP }, () => {
  const h = homeFor('codex-verbs');
  const locator = path.join(h.home, '.codex', 'bin', 'doflow-run');
  const repo = makeRepo(scratch, 'codex-verbs-project');
  repo.dir = fs.realpathSync(repo.dir);
  const slug = '080-shipped';
  const ok = (args: any, options?: any) => {
    const r = run(h, repo.dir, locator, [...args, '--json'], options);
    assert.equal(r.status, 0, `${args.join(' ')} -> ${r.status}\n${r.stdout}\n${r.stderr}`);
    assert.ok(r.json, `${args.join(' ')} printed no JSON: ${r.stdout}`);
    return r.json;
  };
  const eventTypes = () => {
    const dir = path.join(repo.dir, '.doflow', 'state', 'lifecycle', 'events');
    return fs.readdirSync(dir).sort().map((name: any) => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')));
  };

  test('setup: install, an earlier tag, a tracked feature merged after tracking', () => {
    install(h, 'codex');
    repo.tag('v1.0.0');
    fs.mkdirSync(path.join(repo.dir, 'agent-docs', 'doflow', slug), { recursive: true });
    assert.equal(ok(['lifecycle', '--action', 'init', '--slug', slug]).tracked, 'new');
    const trackedAt = eventTypes().find((e: any) => e.type === 'feature.tracked').at;
    repo.at(new Date(Date.parse(trackedAt) + 10 * 60000).toISOString());
    repo.mergeNoFf(featureBranch(repo, slug, 1));
    assert.deepEqual(ok(['lifecycle', '--action', 'status', '--slug', slug]).status, 'awaiting-release');
  });

  test('lifecycle --action release previews the merged feature, writes nothing to git, and --confirm records it', () => {
    const head = repo.git('rev-parse', 'HEAD');
    const eventsBefore = eventTypes().length;
    const preview = ok(['lifecycle', '--action', 'release', '--tag', 'v1.1.0']);
    assert.equal(preview.recorded, false);
    assert.deepEqual(preview.candidates.map((c: any) => [c.slug, c.evidence]), [[slug, 'branch']]);
    assert.equal(eventTypes().length, eventsBefore, 'the preview writes nothing');
    assert.deepEqual([repo.git('rev-parse', 'HEAD'), repo.git('tag'), repo.git('status', '--porcelain', '--', '.', ':!.doflow')], [head, 'v1.0.0', '']);

    // Confirming needs the tag to exist (the verb never creates one), so the user cuts it first.
    repo.tag('v1.1.0');
    const refs = repo.git('for-each-ref');
    const recorded = ok(['lifecycle', '--action', 'release', '--tag', 'v1.1.0', '--confirm']);
    assert.equal(recorded.recorded, true);
    const records = eventTypes().filter((e: any) => e.type === 'release.recorded');
    assert.equal(records.length, 1);
    assert.deepEqual([records[0].data.tag, records[0].data.features.map((f: any) => f.slug)], ['v1.1.0', [slug]]);
    assert.deepEqual([repo.git('rev-parse', 'HEAD'), repo.git('for-each-ref')], [head, refs], 'recording a release makes no commit and moves no ref');
    assert.equal(repo.git('diff', '--cached', '--name-only'), '');
  });

  test('followup --action report --stdin keeps a machine-local body under the scratch XDG', () => {
    const filed = ok(['followup', '--action', 'report', '--statement', 'Smoke: crash reported through the installed runtime', '--stdin', '--release', 'v1.1.0'],
      { input: 'TypeError: smoke\n    at cartTotal (cart.js:88)\n' });
    const [item] = filed.created;
    assert.deepEqual([item.state, item.body, item.source.kind], ['open', 'on-this-machine', 'report']);
    const reports = path.join(h.xdg, 'doflow', 'reports');
    const bodies = filesUnder(reports).filter((f: any) => f.endsWith('.txt'));
    assert.equal(bodies.length, 1, `one body under ${reports}`);
    assert.match(fs.readFileSync(path.join(reports, bodies[0]), 'utf8'), /TypeError: smoke/);
    assert.ok(item.excerptBytes > 0, 'the event carries the bounded excerpt, the body stays here');
  });

  test('goal add, item, check, link, list and done --channel question give the IC-022 results', () => {
    const goal = 'public-api-v2';
    const added = ok(['goal', '--action', 'add', '--goal', goal, '--statement', 'Clients can migrate to v2', '--item', 'v2 endpoints published']);
    assert.deepEqual([added.ok, added.items.map((i: any) => i.id)], [true, ['C1']]);
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
