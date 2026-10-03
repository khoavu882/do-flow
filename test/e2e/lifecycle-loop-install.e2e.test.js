'use strict';

// lifecycle-loop-install.e2e.test.js: the 046 lifecycle verbs reached the way a Codex user reaches
// them, and the documented behaviour on a harness the runtime is not projected to (DEC-024, NFR-004).
//
// The runtime is projected to claude, codex and gemini; the other five harnesses get skills and a
// locator but no `.doflow/scripts`, so their installed skill prose stops at its own resolver.
// Both halves are real installs into scratch homes, executed through the projected locator and the
// resolver block the installed skill carries. The Codex CLI itself is never invoked: the harness
// only matters here as the place the files are projected to. No network and no model call.
//
// Every spawn runs under a scratch HOME and XDG_CONFIG_HOME and with no global git config (DEC-041).

const { test, describe, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createScratch } = require('../helper/scratch-env');
const { makeRepo } = require('../helper/lifecycle-git-fixtures');
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

function run(h, cwd, locator, args) {
  const r = spawnSync('bash', [locator, ...args], { cwd, encoding: 'utf8', env: envFor(h) });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch { /* human output */ }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json };
}

/** The skill file a harness installed, found by walking its home. */
function installedSkill(h, name) {
  const hit = fs.readdirSync(h.home, { recursive: true }).find((f) => f.split(path.sep).slice(-3).join('/') === `skills/${name}/SKILL.md`);
  assert.ok(hit, `no installed ${name} skill under ${h.home}`);
  return path.join(h.home, hit);
}

/** The runtime resolver block of an installed skill: the fenced bash block that ends in the "no runtime found" exit. */
function resolverOf(skillFile) {
  const blocks = fs.readFileSync(skillFile, 'utf8').split('```bash\n').slice(1).map((b) => b.split('\n```')[0]);
  const block = blocks.find((b) => b.includes('no runtime found'));
  assert.ok(block, `${skillFile} carries no runtime resolver`);
  return block;
}

describe('Codex target: the lifecycle verbs run through the codex-projected dispatcher (DEC-024, NFR-004)', { skip: SKIP }, () => {
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

describe('A harness without the runtime: the skill stops at its resolver, before any lifecycle verb (DEC-024)', { skip: SKIP }, () => {
  // opencode is one of the five harnesses that do not get the runtime; the behaviour is the same for each.
  const h = homeFor('opencode');
  const project = makeRepo(scratch, 'opencode-project');

  test('the opencode install carries the skill and a locator but no runtime', () => {
    install(h, 'opencode');
    assert.ok(installedSkill(h, 'do'));
    assert.equal(fs.existsSync(path.join(h.home, '.doflow', 'scripts')), false, 'no dispatcher is projected');
    assert.equal(fs.existsSync(path.join(h.home, '.doflow', 'runtime')), false, 'no Node runtime is projected');
  });

  test('the installed skill resolver finds no runtime, prints the install hint and exits 2 before a lifecycle verb runs', () => {
    const resolver = resolverOf(installedSkill(h, 'do'));
    // What the skill does after its resolver: the lifecycle verb. It must never be reached.
    const script = `${resolver}\necho VERB-REACHED\n"$DOFLOW" lifecycle --action overview --json\n`;
    const r = spawnSync('bash', ['-c', script], { cwd: project.dir, encoding: 'utf8', env: envFor(h) });
    assert.equal(r.status, 2, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /doflow: no runtime found in any \.doflow\/ above .*nor at .*Run: npx @khoavu882\/doflow install/);
    assert.equal(r.stdout, '', 'no verb ran, so nothing was printed');
    assert.equal(fs.existsSync(path.join(project.dir, 'agent-docs')), false, 'and nothing was written');
  });

  test("the harness's own locator reports the same missing runtime instead of running a verb", () => {
    const locator = path.join(h.home, '.config', 'opencode', 'bin', 'doflow-run');
    const r = run(h, project.dir, locator, ['lifecycle', '--action', 'overview', '--json']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no DoFlow runtime found/);
    assert.match(r.stderr, /npx @khoavu882\/doflow install/);
    assert.equal(r.stdout, '');
  });
});
