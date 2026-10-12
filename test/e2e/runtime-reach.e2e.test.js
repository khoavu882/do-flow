'use strict';

// runtime-reach.e2e.test.js: after a standalone install, every harness reaches the runtime verbs.
//
// Each cell is a real install into fresh directories, run under an environment built from scratch so
// a `doflow` on PATH, DOFLOW_CLI or DOFLOW_CONFIG_DIR cannot stand in for a runtime the install did
// not project. The resolver block of the installed `do-git` skill and the projected locator shim are
// then run from a directory outside any DoFlow checkout. No harness binary is invoked, and there is
// no network, model call or login.

const { test, describe, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn: spawnProcess, spawnSync } = require('node:child_process');
const { resolverOf, filesUnder } = require('../helper/skill-resolver');
const { IS_WIN } = require('../helper-platform');
const { suiteTempDir } = require('../helper/tmp');

// A developer's PI_CODING_AGENT_DIR would send this file's global Pi MCP writes outside the scratch home.
delete process.env.PI_CODING_AGENT_DIR;

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
  antigravity: { project: ['.agents/skills', '.agents/bin'], global: ['.gemini/config/skills', '.gemini/config/bin'] },
};

/** Harness and scope pairs whose install carries the guidance tree under `<root>/.doflow/guidance`. */
const GUIDANCE = new Set(['pi:project', 'opencode:project', 'copilot:project', 'pi:global', 'opencode:global']);

const READ_VERBS = [
  ['lifecycle', '--action', 'overview', '--json'],
  ['followup', '--action', 'list', '--json'],
  ['goal', '--action', 'list', '--json'],
  ['failure', '--action', 'list', '--json'],
];

const base = suiteTempDir('doflow-runtime-reach-e2e-');

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

/** Files under `<root>/.doflow/runtime` this checkout's source no longer produces, relative to the runtime root. */
function runtimeOrphans(root) {
  return ['bin', 'src', path.join('core', 'registry')].flatMap((tree) => {
    const dir = path.join(root, '.doflow', 'runtime', tree);
    return fs.existsSync(dir) ? filesUnder(dir).filter((rel) => !fs.existsSync(path.join(REPO, tree, rel))).map((rel) => path.join(tree, rel)) : [];
  });
}

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

  test('antigravity, global: skills and runtime are installed under ~/.gemini/config/skills and ~/.doflow', async () => {
    const cell = newCell('antigravity-global');
    const installed = await install(cell, 'global', 'antigravity');
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(fs.existsSync(path.join(cell.home, '.gemini', 'config', 'skills')), true);
    assert.equal(fs.existsSync(path.join(cell.home, '.doflow', 'runtime')), true);
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

  const tagSkip = (tag) => (!IS_WIN && spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: REPO }).status === 0
    ? false
    : `the ${tag} tag is absent from this clone, so the mixed-version update did not run (git fetch --tags)`);
  // v1.14.1 predates Pi's guidance tree, so its Pi install recorded no guidance rows and its guidance
  // bytes differ from this checkout's: the update has to accept them from Claude's rows, with no source edit.
  const OLDER_TAG = 'v1.14.1';

  // `guidanceDiffers` is for a tag whose guidance bytes differ from this checkout's, which makes the
  // cell prove the guidance acceptance without editing any guidance file.
  const mixedVersion = (LEGACY_TAG, guidanceDiffers) => async () => {
    const cell = newCell('mixed-version');
    const legacy = path.join(cell.dir, 'legacy');
    fs.mkdirSync(legacy);
    const archive = spawnSync('git', ['archive', '--format=tar', '-o', path.join(cell.dir, 'legacy.tar'), LEGACY_TAG], { cwd: REPO, encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    const extract = spawnSync('tar', ['-x', '-f', path.join(cell.dir, 'legacy.tar'), '-C', legacy], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);

    const older = await install(cell, 'project', 'claude,pi', path.join(legacy, 'bin', 'doflow.js'));
    assert.equal(older.status, 0, `${LEGACY_TAG} install: ${older.stderr}`);

    const guidanceDir = path.join(cell.proj, '.doflow', 'guidance');
    const guidanceSource = path.join(REPO, 'core', 'shared', 'guidance');
    const guidanceDiffer = (rel) => !fs.existsSync(path.join(guidanceDir, rel)) || !fs.existsSync(path.join(guidanceSource, rel))
      || !fs.readFileSync(path.join(guidanceDir, rel)).equals(fs.readFileSync(path.join(guidanceSource, rel)));
    const allGuidance = () => new Set([...filesUnder(guidanceDir), ...filesUnder(guidanceSource)]);
    if (guidanceDiffers) {
      assert.ok([...allGuidance()].some(guidanceDiffer), `the ${LEGACY_TAG} guidance equals this checkout's; this cell proves nothing about guidance`);
    }

    const mirror = path.join(cell.proj, '.doflow', 'runtime', 'src');
    const differs = (rel) => !fs.existsSync(path.join(mirror, rel)) || !fs.existsSync(path.join(REPO, 'src', rel))
      || !fs.readFileSync(path.join(mirror, rel)).equals(fs.readFileSync(path.join(REPO, 'src', rel)));
    assert.ok([...filesUnder(mirror), ...filesUnder(path.join(REPO, 'src'))].some(differs), `the ${LEGACY_TAG} runtime equals this checkout's; the mixed-version cell proves nothing`);

    // `update` runs without -f: force would make every file known-good and hide the sibling-fingerprint
    // acceptance this cell exists to prove. The confirmation prompt is answered on stdin. A null
    // harness is a bare `update`, which targets claude alone.
    const step = async (verb, harness) => {
      const r = await spawn(cell, process.execPath, [CLI, verb, 'proj', ...(verb === 'update' ? [] : ['-f']), ...(harness ? ['-t', harness] : [])], cell.dir, 'y\n');
      assert.equal(r.status, 0, `${verb} -t ${harness}: ${r.stdout}${r.stderr}`);
      assert.ok(!/modified outside DoFlow/.test(r.stdout + r.stderr), `${verb} -t ${harness}: ${r.stdout}${r.stderr}`);
      return r;
    };

    const retired = runtimeOrphans(cell.proj);
    assert.ok(retired.length > 0, `the ${LEGACY_TAG} runtime ships nothing this checkout dropped; the prune is not exercised`);
    const updated = await step('update', 'pi');
    const notices = `${updated.stdout}\n${updated.stderr}`.split('\n').filter((line) => line.includes('replaced shared files'));
    assert.deepEqual(notices, ['[INFO] pi: replaced shared files written by claude; reinstall that harness to restore them'], `${updated.stdout}${updated.stderr}`);
    // Every file THIS checkout's source produces is present and byte-correct in the mirror after
    // the update — the reconciliation this cell exists to prove.
    for (const rel of filesUnder(path.join(REPO, 'src'))) {
      assert.ok(!differs(rel), `${rel} differs from this checkout after the update`);
    }
    // And nothing it no longer ships is left (073 T4). The legacy files renamed away since the tag
    // (the TypeScript migration's .js -> .ts) carry the ledger rows the legacy claude install wrote,
    // so their bytes prove DoFlow wrote them; they used to survive only because claude's rows
    // retained them while this run updated pi alone. Pi's update now prunes them and releases
    // claude's rows, and names each one.
    assert.deepEqual(runtimeOrphans(cell.proj), [], 'an update of pi alone leaves no retired runtime file behind');
    for (const rel of retired) {
      assert.ok(updated.stdout.includes(`[INFO] pi: prune .doflow/runtime/${rel.split(path.sep).join('/')}: no longer shipped, unchanged since DoFlow wrote it`), `${rel} pruned but not named`);
    }
    if (guidanceDiffers) {
      for (const rel of allGuidance()) assert.ok(!guidanceDiffer(rel), `guidance ${rel} differs from this checkout after the update`);
    }
    await step('update', null);
    assert.deepEqual(runtimeOrphans(cell.proj), [], 'nor does the bare update that follows');
    await step('remove', 'pi');
    await step('remove', 'claude');
    assert.equal(fs.existsSync(path.join(cell.proj, '.doflow', 'runtime')), false);
  };

  // 073 T4 negative controls on a real legacy install: what the prune must keep, it keeps and names,
  // and --dry-run lists every prune and keep without deleting anything.
  test('v1.24.1 orphans: --dry-run lists without deleting; an edited orphan and an unrecorded file are kept and named', { skip: tagSkip('v1.24.1') }, async () => {
    const cell = newCell('prune-controls');
    const legacy = path.join(cell.dir, 'legacy');
    fs.mkdirSync(legacy);
    const archive = spawnSync('git', ['archive', '--format=tar', '-o', path.join(cell.dir, 'legacy.tar'), 'v1.24.1'], { cwd: REPO, encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    assert.equal(spawnSync('tar', ['-x', '-f', path.join(cell.dir, 'legacy.tar'), '-C', legacy]).status, 0);
    const older = await install(cell, 'project', 'claude,pi', path.join(legacy, 'bin', 'doflow.js'));
    assert.equal(older.status, 0, older.stderr);

    const runtime = path.join(cell.proj, '.doflow', 'runtime');
    const shown = (rel) => `.doflow/runtime/${rel.split(path.sep).join('/')}`;
    const retired = runtimeOrphans(cell.proj);
    assert.ok(retired.length > 1, 'the fixture needs at least two retired runtime files');
    const [edited, ...pristine] = retired;
    fs.appendFileSync(path.join(runtime, edited), '// a local fix\n');
    const editedBytes = fs.readFileSync(path.join(runtime, edited));
    const userFile = path.join('src', 'my-notes.js');
    fs.writeFileSync(path.join(runtime, userFile), 'mine\n');
    const cli = (args) => spawn(cell, process.execPath, [CLI, ...args], cell.dir, 'y\n');

    const dry = await cli(['update', 'proj', '-t', 'pi', '--dry-run']);
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    for (const rel of pristine) assert.ok(dry.stdout.includes(`[DRY]   pi: prune ${shown(rel)}: no longer shipped, unchanged since DoFlow wrote it`), `${rel} not listed`);
    assert.ok(dry.stdout.includes(`[DRY]   pi: kept hand-edited ${shown(edited)}; DoFlow no longer manages it`), dry.stdout);
    assert.ok(dry.stdout.includes(`[DRY]   pi: kept ${shown(userFile)}: not shipped by this version and not recorded as DoFlow's`), dry.stdout);
    assert.deepEqual(runtimeOrphans(cell.proj).sort(), [...retired, userFile].sort(), '--dry-run deletes nothing');

    const real = await cli(['update', 'proj', '-t', 'pi']);
    assert.equal(real.status, 0, `${real.stdout}${real.stderr}`);
    assert.ok(!/modified outside DoFlow/.test(real.stdout + real.stderr), real.stdout + real.stderr);
    assert.ok(real.stdout.includes(`[INFO] pi: kept hand-edited ${shown(edited)}; DoFlow no longer manages it`), real.stdout);
    assert.ok(real.stdout.includes(`[INFO] pi: kept ${shown(userFile)}: not shipped by this version and not recorded as DoFlow's`), real.stdout);
    assert.deepEqual(runtimeOrphans(cell.proj).sort(), [edited, userFile].sort(), 'only the edited and the unrecorded file remain');
    assert.ok(fs.readFileSync(path.join(runtime, edited)).equals(editedBytes));

    const bare = await cli(['update', 'proj']);
    assert.equal(bare.status, 0, `${bare.stdout}${bare.stderr}`);
    assert.ok(bare.stdout.includes(`[INFO] claude: kept hand-edited ${shown(edited)}; DoFlow no longer manages it`), bare.stdout);
    assert.deepEqual(runtimeOrphans(cell.proj).sort(), [edited, userFile].sort());
    assert.equal(fs.readFileSync(path.join(runtime, userFile), 'utf8'), 'mine\n');
  });

  // 073 T5: a rollback restores the ownership ledger with the files, so the install it leaves can be
  // updated and removed again. Before, the ledger kept the update's rows while the files went back,
  // and the next update and remove both refused dozens of files as modified outside DoFlow.
  const ROLLBACK_TAG = 'v1.24.1';
  test(`rollback of a ${ROLLBACK_TAG} -> this checkout update restores pruned files and the ledger; update and remove then succeed`, { skip: tagSkip(ROLLBACK_TAG) }, async () => {
    const cell = newCell('rollback-ledger');
    const legacy = path.join(cell.dir, 'legacy');
    fs.mkdirSync(legacy);
    const archive = spawnSync('git', ['archive', '--format=tar', '-o', path.join(cell.dir, 'legacy.tar'), ROLLBACK_TAG], { cwd: REPO, encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    assert.equal(spawnSync('tar', ['-x', '-f', path.join(cell.dir, 'legacy.tar'), '-C', legacy]).status, 0);
    const older = await install(cell, 'project', 'claude,pi', path.join(legacy, 'bin', 'doflow.js'));
    assert.equal(older.status, 0, older.stderr);

    const mirror = path.join(cell.proj, '.doflow', 'runtime', 'src');
    const ledgerFile = path.join(cell.proj, '.doflow', 'state', 'ledger.json');
    const retired = filesUnder(mirror).filter((rel) => !fs.existsSync(path.join(REPO, 'src', rel)));
    assert.ok(retired.length > 0, `the ${ROLLBACK_TAG} runtime ships nothing this checkout dropped; the cell proves nothing`);
    const before = new Map(retired.map((rel) => [rel, fs.readFileSync(path.join(mirror, rel))]));
    const ledgerBefore = fs.readFileSync(ledgerFile);

    const cli = (args, cwd = cell.dir) => spawn(cell, process.execPath, [CLI, ...args], cwd, 'y\n');
    const ok = (r, what) => {
      assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
      assert.ok(!/modified outside DoFlow/.test(r.stdout + r.stderr), `${what}: ${r.stdout}${r.stderr}`);
      return r;
    };
    const updated = ok(await cli(['update', 'proj', '-t', 'pi']), 'update -t pi');
    assert.deepEqual(retired.filter((rel) => fs.existsSync(path.join(mirror, rel))), [], 'the update prunes every retired runtime file');
    const bid = (updated.stdout + updated.stderr).match(/Backup created: (\S+)/)?.[1];
    assert.ok(bid, `no backup id in: ${updated.stdout}${updated.stderr}`);

    ok(await cli(['rollback', bid, '-f'], cell.proj), 'rollback');
    for (const [rel, bytes] of before) assert.ok(fs.readFileSync(path.join(mirror, rel)).equals(bytes), `${rel} is not restored byte-identical`);
    assert.ok(fs.readFileSync(ledgerFile).equals(ledgerBefore), 'the rollback restores the ledger the files belong to');

    ok(await cli(['update', 'proj']), 'update after rollback');
    ok(await cli(['update', 'proj', '-t', 'pi']), 'update -t pi after rollback');
    assert.deepEqual(retired.filter((rel) => fs.existsSync(path.join(mirror, rel))), []);
    ok(await cli(['remove', 'proj', '-f', '-t', 'claude,pi']), 'remove after rollback');
    assert.equal(fs.existsSync(path.join(cell.proj, '.doflow', 'runtime')), false);
  });

  test(`mixed versions: a ${LEGACY_TAG} install updates to this checkout's runtime and is removed cleanly`, { skip: tagSkip(LEGACY_TAG) }, mixedVersion(LEGACY_TAG, false));
  test(`mixed versions: a ${OLDER_TAG} install, whose guidance differs from this checkout's, updates with no source edit`, { skip: tagSkip(OLDER_TAG) }, mixedVersion(OLDER_TAG, true));
});
