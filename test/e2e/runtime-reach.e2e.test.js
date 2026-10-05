'use strict';

// runtime-reach.e2e.test.js: after a standalone install, every harness reaches the runtime verbs.
//
// Each cell is a real install into fresh directories, run under an environment built from scratch so
// a `doflow` on PATH, DOFLOW_CLI or DOFLOW_CONFIG_DIR cannot stand in for a runtime the install did
// not project. The resolver block of the installed `do-git` skill and the projected locator shim are
// then run from a directory outside any DoFlow checkout. No harness binary is invoked, and there is
// no network, model call or login.

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn: spawnProcess, spawnSync } = require('node:child_process');
const { resolverOf, filesUnder } = require('../helper/skill-resolver');
const { IS_WIN } = require('../helper-platform');

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SKIP = IS_WIN ? 'the projected locator and the skill resolver are POSIX shell' : false;
const LEGACY_TAG = 'v1.14.2';
const HINT = /doflow: no runtime found in any \.doflow\/ above .*nor at .*Run: npx @khoavu882\/doflow install -t <harness>$/m;

/** Where each harness puts the `do-git` skill and the locator shim, relative to the scope root. */
const PLACEMENT = {
  claude: { project: ['.claude/skills', '.claude/bin'], global: ['.claude/skills', '.claude/bin'] },
  codex: { project: ['.agents/skills', '.codex/bin'], global: ['.agents/skills', '.codex/bin'] },
  gemini: { project: ['.agents/skills', '.agents/bin'], global: ['.gemini/config/skills', '.gemini/config/bin'] },
  opencode: { project: ['.opencode/skills', '.opencode/bin'], global: ['.config/opencode/skills', '.config/opencode/bin'] },
  pi: { project: ['.pi/skills', '.pi/bin'], global: ['.pi/agent/skills', '.pi/agent/bin'] },
  copilot: { project: ['.agents/skills', '.agents/bin'], global: ['.agents/skills', '.agents/bin'] },
  kiro: { project: ['.kiro/skills', '.kiro/bin'], global: ['.kiro/skills', '.kiro/bin'] },
  antigravity: { project: ['.agents/skills', '.agents/bin'], global: null },
};

/** Harness and scope pairs whose install carries the guidance tree under `<root>/.doflow/guidance`. */
const GUIDANCE = new Set(['pi:project', 'opencode:project', 'copilot:project', 'pi:global', 'opencode:global']);

const READ_VERBS = [
  ['lifecycle', '--action', 'overview', '--json'],
  ['followup', '--action', 'list', '--json'],
  ['goal', '--action', 'list', '--json'],
  ['failure', '--action', 'list', '--json'],
];

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-reach-')));
after(() => fs.rmSync(base, { recursive: true, force: true }));

let counter = 0;

/** Fresh `home/`, `xdg/`, `proj/sub/` and `elsewhere/` for one cell. */
function newCell(name) {
  const dir = path.join(base, `${name.replace(/[^a-z0-9]+/gi, '-')}-${(counter += 1)}`);
  const cell = { dir, home: path.join(dir, 'home'), xdg: path.join(dir, 'xdg'), proj: path.join(dir, 'proj'), elsewhere: path.join(dir, 'elsewhere') };
  for (const d of [cell.home, cell.xdg, path.join(cell.proj, 'sub'), cell.elsewhere]) fs.mkdirSync(d, { recursive: true });
  return cell;
}

/** An environment built from scratch: nothing is inherited from the developer's shell. */
function emptyEnv(cell) {
  return {
    HOME: cell.home,
    USERPROFILE: cell.home,
    XDG_CONFIG_HOME: cell.xdg,
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    GIT_CONFIG_GLOBAL: '/dev/null',
    DOFLOW_FAILURE_CAPTURE: 'off',
  };
}

/** Resolves with `{status, stdout, stderr}`; async so the cells of one describe overlap. `input` is what the child reads on stdin. */
function spawn(cell, file, args, cwd, input = '\n') {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(file, args, { cwd, env: emptyEnv(cell) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** `install [proj | -g] -f --no-backup -t <targets>` with the cell directory as the working directory. */
function install(cell, scope, targets, cli = CLI) {
  return spawn(cell, process.execPath, [cli, 'install', ...(scope === 'global' ? ['-g'] : ['proj']), '-f', '--no-backup', '-t', targets], cell.dir);
}

/** `<verb...>` through the resolver block, run with `cwd`; stdout is the verb's output. */
function viaResolver(cell, resolver, cwd, verb) {
  const quoted = verb.map((arg) => `'${arg}'`).join(' ');
  return spawn(cell, 'bash', ['-c', `${resolver}\n"$DOFLOW" ${quoted}`], cwd);
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const real = fs.realpathSync;

function ancestorWithDoflow(start) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.doflow'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

describe('Runtime reach after a standalone install', { skip: SKIP, concurrency: 4 }, () => {
  before(() => {
    const parent = path.dirname(base);
    const found = ancestorWithDoflow(parent);
    assert.equal(found, null, `an ancestor of ${base} holds .doflow (${found}); the resolver would find it and the cells would not test a standalone install. Set TMPDIR to a directory with no .doflow above it`);
  });

  for (const [harness, placement] of Object.entries(PLACEMENT)) {
    for (const scope of ['project', 'global']) {
      const rows = placement[scope];
      if (!rows) continue;
      test(`${harness}, ${scope}: the installed skill and shim reach the runtime verbs`, async () => {
        const cell = newCell(`${harness}-${scope}`);
        const root = scope === 'project' ? cell.proj : cell.home;
        const cwd = scope === 'project' ? path.join(cell.proj, 'sub') : cell.elsewhere;
        const [skillsRel, binRel] = rows;

        const installed = await install(cell, scope, harness);
        assert.equal(installed.status, 0, `install: ${installed.stderr}`);
        assert.ok(!installed.stderr.includes('[ERROR]'), installed.stderr);

        const skill = path.join(root, skillsRel, 'do-git', 'SKILL.md');
        assert.ok(fs.existsSync(skill), `no do-git skill at ${skill}`);
        const resolver = resolverOf(skill);

        const reached = await spawn(cell, 'bash', ['-c', `${resolver}; printf "%s\\n" "$DOFLOW"; "$DOFLOW" --help >/dev/null`], cwd);
        assert.equal(reached.status, 0, `resolver: ${reached.stderr}`);
        assert.equal(real(reached.stdout.trim()), real(path.join(root, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run')));

        for (const verb of READ_VERBS) {
          const r = await viaResolver(cell, resolver, cwd, verb);
          assert.equal(r.status, 0, `${verb.join(' ')}: ${r.stdout}${r.stderr}`);
          assert.equal(parseJson(r.stdout)?.ok, true, `${verb.join(' ')}: ${r.stdout}`);
        }

        assert.ok(fs.existsSync(path.join(root, '.doflow', 'runtime', 'bin', 'doflow.js')), 'the Node runtime is projected');

        const shim = path.join(root, binRel, 'doflow-run');
        const shimRun = await spawn(cell, 'sh', [shim, '--help'], cwd);
        assert.equal(shimRun.status, 0, `shim: ${shimRun.stderr}`);

        if (GUIDANCE.has(`${harness}:${scope}`)) {
          assert.ok(fs.existsSync(path.join(root, '.doflow', 'guidance', 'DOFLOW_CORE.md')), 'the guidance tree is projected');
        }

        if (harness === 'pi' && scope === 'project') await assertDoctorJudgesReach(cell);
      });
    }
  }

  /** Doctor pinned to the install root: REACHED, then a finding once the runtime is gone. */
  async function assertDoctorJudgesReach(cell) {
    const doctor = () => spawn(cell, process.execPath, [CLI, 'doctor', cell.proj, '--json'], cell.dir);
    const ok = await doctor();
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    const row = parseJson(ok.stdout).harnesses.find((h) => h.id === 'pi').reach.find((r) => r.scope === 'project');
    assert.equal(row?.state, 'REACHED');
    assert.equal(real(row.root), real(path.join(cell.proj, '.doflow')));

    fs.rmSync(path.join(cell.proj, '.doflow', 'runtime'), { recursive: true, force: true });
    const broken = await doctor();
    assert.equal(broken.status, 1, `${broken.stdout}${broken.stderr}`);
    const finding = parseJson(broken.stdout).findings.find((f) => f.kind === 'runtime-no-reach' && f.subject === 'pi:project');
    assert.ok(finding, broken.stdout);
    assert.ok(finding.detail.includes(`npx @khoavu882/doflow install ${real(cell.proj)} -t pi`), finding.detail);
  }

  test('antigravity, global: no skills and no runtime are installed, and the notice says so', async () => {
    const cell = newCell('antigravity-global');
    const installed = await install(cell, 'global', 'antigravity');
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout + installed.stderr, /antigravity: no skills at global scope \(the user-scope skills location is unresolved\), so DoFlow skills and runtime are not installed here; install per project with: npx @khoavu882\/doflow install -t antigravity/);
    // The skills directories of data-model §1: `.agents/skills` (project) and the user config dir's `skills`.
    for (const skills of [path.join(cell.home, '.agents', 'skills'), path.join(cell.home, '.gemini', 'config', 'skills'), path.join(cell.proj, '.agents', 'skills')]) {
      assert.equal(fs.existsSync(skills), false, `${skills} exists`);
    }
    assert.equal(fs.existsSync(path.join(cell.home, '.doflow', 'runtime')), false);
  });

  test('the no-runtime hint, followed to its remedy, reaches the dispatcher', async () => {
    const cell = newCell('hint-remedy');
    const resolver = resolverOf(path.join(REPO, 'core', 'shared', 'skills', 'do-git', 'SKILL.md'));
    const sub = path.join(cell.proj, 'sub');

    const stopped = await spawn(cell, 'bash', ['-c', resolver], sub);
    assert.equal(stopped.status, 2, `${stopped.stdout}${stopped.stderr}`);
    assert.match(stopped.stderr, HINT);

    const shim = await spawn(cell, 'sh', [path.join(REPO, 'core', 'harnesses', 'shared', 'locator', 'doflow-run'), 'lifecycle'], sub);
    assert.equal(shim.status, 2, shim.stderr);
    assert.ok(shim.stderr.includes('npx @khoavu882/doflow install -t <harness>      # project-local, creates ./.doflow'), shim.stderr);
    assert.ok(shim.stderr.includes('npx @khoavu882/doflow install -t <harness> -g   # global, creates $HOME/.doflow'), shim.stderr);

    const installed = await install(cell, 'project', 'pi');
    assert.equal(installed.status, 0, installed.stderr);
    const answered = await viaResolver(cell, resolver, sub, ['lifecycle', '--action', 'overview', '--json']);
    assert.equal(answered.status, 0, `${answered.stdout}${answered.stderr}`);
    assert.equal(parseJson(answered.stdout)?.ok, true, answered.stdout);
  });

  const tagPresent = !IS_WIN && spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${LEGACY_TAG}`], { cwd: REPO }).status === 0;
  const TAG_SKIP = tagPresent ? false : `the ${LEGACY_TAG} tag is absent from this clone, so the mixed-version update did not run (git fetch --tags)`;

  test(`mixed versions: a ${LEGACY_TAG} install updates to this checkout's runtime and is removed cleanly`, { skip: TAG_SKIP }, async () => {
    const cell = newCell('mixed-version');
    const legacy = path.join(cell.dir, 'legacy');
    fs.mkdirSync(legacy);
    const archive = spawnSync('git', ['archive', '--format=tar', '-o', path.join(cell.dir, 'legacy.tar'), LEGACY_TAG], { cwd: REPO, encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    const extract = spawnSync('tar', ['-x', '-f', path.join(cell.dir, 'legacy.tar'), '-C', legacy], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);

    const older = await install(cell, 'project', 'claude,pi', path.join(legacy, 'bin', 'doflow.js'));
    assert.equal(older.status, 0, `${LEGACY_TAG} install: ${older.stderr}`);

    const mirror = path.join(cell.proj, '.doflow', 'runtime', 'src');
    const differs = (rel) => !fs.existsSync(path.join(mirror, rel)) || !fs.existsSync(path.join(REPO, 'src', rel))
      || !fs.readFileSync(path.join(mirror, rel)).equals(fs.readFileSync(path.join(REPO, 'src', rel)));
    assert.ok([...filesUnder(mirror), ...filesUnder(path.join(REPO, 'src'))].some(differs), `the ${LEGACY_TAG} runtime equals this checkout's; the mixed-version cell proves nothing`);

    // `update` runs without -f: force would make every file known-good and hide the sibling-fingerprint
    // acceptance this cell exists to prove. The confirmation prompt is answered on stdin.
    const step = async (verb, harness) => {
      const r = await spawn(cell, process.execPath, [CLI, verb, 'proj', ...(verb === 'update' ? [] : ['-f']), '-t', harness], cell.dir, 'y\n');
      assert.equal(r.status, 0, `${verb} -t ${harness}: ${r.stdout}${r.stderr}`);
      assert.ok(!/modified outside DoFlow/.test(r.stdout + r.stderr), `${verb} -t ${harness}: ${r.stdout}${r.stderr}`);
    };

    await step('update', 'pi');
    for (const rel of new Set([...filesUnder(mirror), ...filesUnder(path.join(REPO, 'src'))])) {
      assert.ok(!differs(rel), `${rel} differs from this checkout after the update`);
    }
    await step('update', 'claude');
    await step('remove', 'pi');
    await step('remove', 'claude');
    assert.equal(fs.existsSync(path.join(cell.proj, '.doflow', 'runtime')), false);
  });
});
