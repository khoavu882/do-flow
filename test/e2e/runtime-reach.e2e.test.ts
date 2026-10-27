'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

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
const { resolverOf, filesUnder } = require('../helper/skill-resolver.ts');
const { IS_WIN } = require('../helper-platform.ts');
const { suiteTempDir } = require('../helper/tmp.ts');
const { ALL_HARNESS_IDS } = require('../helper/scratch-env.ts');

// A developer's PI_CODING_AGENT_DIR would send this file's global Pi MCP writes outside the scratch home.
delete process.env.PI_CODING_AGENT_DIR;

const REPO = path.resolve(__dirname, '..', '..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const SKIP = IS_WIN ? 'the projected locator and the skill resolver are POSIX shell' : false;
const LEGACY_TAG = 'v1.14.2';
const HINT = /doflow: no runtime found in any \.doflow\/ above .*nor at .*Run: npx @khoavu882\/doflow install -t <harness>$/m;

/** Where each harness puts the `do-git` skill and the locator shim, relative to the scope root. */
const PLACEMENT: any = {
  claude: { project: ['.claude/skills', '.claude/bin'], global: ['.claude/skills', '.claude/bin'] },
  codex: { project: ['.agents/skills', '.codex/bin'], global: ['.agents/skills', '.codex/bin'] },
  opencode: { project: ['.opencode/skills', '.opencode/bin'], global: ['.config/opencode/skills', '.config/opencode/bin'] },
  pi: { project: ['.pi/skills', '.pi/bin'], global: ['.pi/agent/skills', '.pi/agent/bin'] },
  copilot: { project: ['.agents/skills', '.agents/bin'], global: ['.agents/skills', '.agents/bin'] },
  kiro: { project: ['.kiro/skills', '.kiro/bin'], global: ['.kiro/skills', '.kiro/bin'] },
  antigravity: { project: ['.agents/skills', '.agents/bin'], global: ['.gemini/config/skills', '.gemini/config/bin'] },
};

/** Harness and scope pairs whose install carries the guidance tree under `<root>/.doflow/guidance`. */
const GUIDANCE: any = new Set(['pi:project', 'opencode:project', 'copilot:project', 'pi:global', 'opencode:global']);

const READ_VERBS: any = [
  ['lifecycle', '--action', 'overview', '--json'],
  ['followup', '--action', 'list', '--json'],
  ['goal', '--action', 'list', '--json'],
  ['failure', '--action', 'list', '--json'],
];

const base = suiteTempDir('doflow-runtime-reach-e2e-');

let counter = 0;

/** Fresh `home/`, `xdg/`, `proj/sub/` and `elsewhere/` for one cell. */
function newCell(name: any) {
  const dir = path.join(base, `${name.replace(/[^a-z0-9]+/gi, '-')}-${(counter += 1)}`);
  const cell: any = { dir, home: path.join(dir, 'home'), xdg: path.join(dir, 'xdg'), proj: path.join(dir, 'proj'), elsewhere: path.join(dir, 'elsewhere') };
  for (const d of [cell.home, cell.xdg, path.join(cell.proj, 'sub'), cell.elsewhere]) fs.mkdirSync(d, { recursive: true });
  // Every harness in the hook tier (maint-hooks): these cells reach each harness's hooks, Pi's included.
  fs.mkdirSync(path.join(cell.xdg, 'doflow'));
  fs.writeFileSync(path.join(cell.xdg, 'doflow', 'settings.json'), JSON.stringify({ schema: 1, 'hooks.harnesses': ALL_HARNESS_IDS }));
  return cell;
}

/** An environment built from scratch: nothing is inherited from the developer's shell. */
function emptyEnv(cell: any) {
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
function spawn(cell: any, file: any, args: any, cwd: any, input: any = '\n') {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(file, args, { cwd, env: emptyEnv(cell) });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: any) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: any) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (status: any) => resolve({ status, stdout, stderr }));
    child.stdin.end(input);
  });
}

/** `install [proj | -g] -f --no-backup -t <targets>` with the cell directory as the working directory. */
function install(cell: any, scope: any, targets: any, cli: any = CLI) {
  return spawn(cell, process.execPath, [cli, 'install', ...(scope === 'global' ? ['-g'] : ['proj']), '-f', '--no-backup', '-t', targets], cell.dir);
}

/** `<verb...>` through the resolver block, run with `cwd`; stdout is the verb's output. */
function viaResolver(cell: any, resolver: any, cwd: any, verb: any) {
  const quoted = verb.map((arg: any) => `'${arg}'`).join(' ');
  return spawn(cell, 'bash', ['-c', `${resolver}\n"$DOFLOW" ${quoted}`], cwd);
}

function parseJson(text: any) {
  try { return JSON.parse(text); } catch { return null; }
}

const real = fs.realpathSync;

/** Files under `<root>/.doflow/runtime` this checkout's source no longer produces, relative to the runtime root. */
function runtimeOrphans(root: any) {
  return ['bin', 'src', path.join('core', 'registry')].flatMap((tree) => {
    const dir = path.join(root, '.doflow', 'runtime', tree);
    return fs.existsSync(dir) ? filesUnder(dir).filter((rel: any) => !fs.existsSync(path.join(REPO, tree, rel))).map((rel: any) => path.join(tree, rel)) : [];
  });
}

function ancestorWithDoflow(start: any) {
  for (let dir = start; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.doflow'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The notice an update names when the shared hooks tree moved under a harness it did not name (IC-037). */
const CLAUDE_REFRESH = 'refreshed claude hook front doors to match the shared hooks tree';

/** A scratch git repo on a feature branch with requirement.md and plan.md but no design.md. */
function noDesignProject(cell: any) {
  const root = path.join(cell.dir, 'no-design');
  fs.mkdirSync(path.join(root, 'agent-docs', 'doflow', '077-reach', 'intention'), { recursive: true });
  fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', '077-reach', 'intention', 'requirement.md'), '# requirement\n');
  fs.writeFileSync(path.join(root, 'agent-docs', 'doflow', '077-reach', 'plan.md'), '- [ ] C.1 [US1] reach \u2014 owner: test; files: src/a.js\n');
  const git = (...args: any[]) => spawnSync('git', ['-c', 'user.name=reach', '-c', 'user.email=reach@example.invalid', ...args], { cwd: root, env: { ...emptyEnv(cell), PATH: process.env.PATH }, encoding: 'utf8' });
  for (const args of [['init', '-q', '-b', 'feat/077-reach'], ['add', '-A'], ['commit', '-q', '-m', 'seed']]) assert.equal(git(...args).status, 0, `git ${args.join(' ')}`);
  return root;
}

describe('Runtime reach after a standalone install', { skip: SKIP, concurrency: 4 }, () => {
  before(() => {
    const parent = path.dirname(base);
    const found = ancestorWithDoflow(parent);
    assert.equal(found, null, `an ancestor of ${base} holds .doflow (${found}); the resolver would find it and the cells would not test a standalone install. Set TMPDIR to a directory with no .doflow above it`);
  });

  for (const [harness, placement] of Object.entries(PLACEMENT)) {
    for (const scope of ['project', 'global']) {
      const rows: any = placement[scope];
      if (!rows) continue;
      test(`${harness}, ${scope}: the installed skill and shim reach the runtime verbs`, async () => {
        const cell = newCell(`${harness}-${scope}`);
        const root = scope === 'project' ? cell.proj : cell.home;
        const cwd = scope === 'project' ? path.join(cell.proj, 'sub') : cell.elsewhere;
        const [skillsRel, binRel] = rows;

        const installed: any = await install(cell, scope, harness);
        assert.equal(installed.status, 0, `install: ${installed.stderr}`);
        assert.ok(!installed.stderr.includes('[ERROR]'), installed.stderr);

        const skill = path.join(root, skillsRel, 'do-git', 'SKILL.md');
        assert.ok(fs.existsSync(skill), `no do-git skill at ${skill}`);
        const resolver = resolverOf(skill);

        const reached: any = await spawn(cell, 'bash', ['-c', `${resolver}; printf "%s\\n" "$DOFLOW"; "$DOFLOW" --help >/dev/null`], cwd);
        assert.equal(reached.status, 0, `resolver: ${reached.stderr}`);
        assert.equal(real(reached.stdout.trim()), real(path.join(root, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run')));

        for (const verb of READ_VERBS) {
          const r: any = await viaResolver(cell, resolver, cwd, verb);
          assert.equal(r.status, 0, `${verb.join(' ')}: ${r.stdout}${r.stderr}`);
          assert.equal(parseJson(r.stdout)?.ok, true, `${verb.join(' ')}: ${r.stdout}`);
        }

        assert.ok(fs.existsSync(path.join(root, '.doflow', 'runtime', 'bin', 'doflow.js')), 'the Node runtime is projected');

        const shim = path.join(root, binRel, 'doflow-run');
        const shimRun: any = await spawn(cell, 'sh', [shim, '--help'], cwd);
        assert.equal(shimRun.status, 0, `shim: ${shimRun.stderr}`);

        if (GUIDANCE.has(`${harness}:${scope}`)) {
          assert.ok(fs.existsSync(path.join(root, '.doflow', 'guidance', 'DOFLOW_CORE.md')), 'the guidance tree is projected');
        }

        if (harness === 'pi' && scope === 'project') await assertDoctorJudgesReach(cell);
      });
    }
  }

  /** Doctor pinned to the install root: REACHED, then a finding once the runtime is gone. */
  async function assertDoctorJudgesReach(cell: any) {
    const doctor = () => spawn(cell, process.execPath, [CLI, 'doctor', cell.proj, '--json'], cell.dir);
    const ok: any = await doctor();
    assert.equal(ok.status, 0, `${ok.stdout}${ok.stderr}`);
    const row = parseJson(ok.stdout).harnesses.find((h: any) => h.id === 'pi').reach.find((r: any) => r.scope === 'project');
    assert.equal(row?.state, 'REACHED');
    assert.equal(real(row.root), real(path.join(cell.proj, '.doflow')));

    fs.rmSync(path.join(cell.proj, '.doflow', 'runtime'), { recursive: true, force: true });
    const broken: any = await doctor();
    assert.equal(broken.status, 1, `${broken.stdout}${broken.stderr}`);
    const finding = parseJson(broken.stdout).findings.find((f: any) => f.kind === 'runtime-no-reach' && f.subject === 'pi:project');
    assert.ok(finding, broken.stdout);
    assert.ok(finding.detail.includes(`npx @khoavu882/doflow install ${real(cell.proj)} -t pi`), finding.detail);
  }

  test('antigravity, global: skills and runtime are installed under ~/.gemini/config/skills and ~/.doflow', async () => {
    const cell = newCell('antigravity-global');
    const installed: any = await install(cell, 'global', 'antigravity');
    assert.equal(installed.status, 0, installed.stderr);
    assert.equal(fs.existsSync(path.join(cell.home, '.gemini', 'config', 'skills')), true);
    assert.equal(fs.existsSync(path.join(cell.home, '.doflow', 'runtime')), true);
  });

  test('the no-runtime hint, followed to its remedy, reaches the dispatcher', async () => {
    const cell = newCell('hint-remedy');
    const resolver = resolverOf(path.join(REPO, 'core', 'shared', 'skills', 'do-git', 'SKILL.md'));
    const sub = path.join(cell.proj, 'sub');

    const stopped: any = await spawn(cell, 'bash', ['-c', resolver], sub);
    assert.equal(stopped.status, 2, `${stopped.stdout}${stopped.stderr}`);
    assert.match(stopped.stderr, HINT);

    const shim: any = await spawn(cell, 'sh', [path.join(REPO, 'core', 'harnesses', 'shared', 'locator', 'doflow-run'), 'lifecycle'], sub);
    assert.equal(shim.status, 2, shim.stderr);
    assert.ok(shim.stderr.includes('npx @khoavu882/doflow install -t <harness>      # project-local, creates ./.doflow'), shim.stderr);
    assert.ok(shim.stderr.includes('npx @khoavu882/doflow install -t <harness> -g   # global, creates $HOME/.doflow'), shim.stderr);

    const installed: any = await install(cell, 'project', 'pi');
    assert.equal(installed.status, 0, installed.stderr);
    const answered: any = await viaResolver(cell, resolver, sub, ['lifecycle', '--action', 'overview', '--json']);
    assert.equal(answered.status, 0, `${answered.stdout}${answered.stderr}`);
    assert.equal(parseJson(answered.stdout)?.ok, true, answered.stdout);
  });

  const tagSkip = (tag: any) => (!IS_WIN && spawnSync('git', ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}`], { cwd: REPO }).status === 0
    ? false
    : `the ${tag} tag is absent from this clone, so the mixed-version update did not run (git fetch --tags)`);
  // v1.14.1 predates Pi's guidance tree, so its Pi install recorded no guidance rows and its guidance
  // bytes differ from this checkout's: the update has to accept them from Claude's rows, with no source edit.
  const OLDER_TAG = 'v1.14.1';

  // `guidanceDiffers` is for a tag whose guidance bytes differ from this checkout's, which makes the
  // cell prove the guidance acceptance without editing any guidance file.
  const mixedVersion = (LEGACY_TAG: any, guidanceDiffers: any) => async () => {
    const cell = newCell('mixed-version');
    const legacy = path.join(cell.dir, 'legacy');
    fs.mkdirSync(legacy);
    const archive = spawnSync('git', ['archive', '--format=tar', '-o', path.join(cell.dir, 'legacy.tar'), LEGACY_TAG], { cwd: REPO, encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    const extract = spawnSync('tar', ['-x', '-f', path.join(cell.dir, 'legacy.tar'), '-C', legacy], { encoding: 'utf8' });
    assert.equal(extract.status, 0, extract.stderr);

    const older: any = await install(cell, 'project', 'claude,pi', path.join(legacy, 'bin', 'doflow.js'));
    assert.equal(older.status, 0, `${LEGACY_TAG} install: ${older.stderr}`);

    const guidanceDir = path.join(cell.proj, '.doflow', 'guidance');
    const guidanceSource = path.join(REPO, 'core', 'shared', 'guidance');
    const guidanceDiffer = (rel: any) => !fs.existsSync(path.join(guidanceDir, rel)) || !fs.existsSync(path.join(guidanceSource, rel))
      || !fs.readFileSync(path.join(guidanceDir, rel)).equals(fs.readFileSync(path.join(guidanceSource, rel)));
    const allGuidance = () => new Set([...filesUnder(guidanceDir), ...filesUnder(guidanceSource)]);
    if (guidanceDiffers) {
      assert.ok([...allGuidance()].some(guidanceDiffer), `the ${LEGACY_TAG} guidance equals this checkout's; this cell proves nothing about guidance`);
    }

    const mirror = path.join(cell.proj, '.doflow', 'runtime', 'src');
    const differs = (rel: any) => !fs.existsSync(path.join(mirror, rel)) || !fs.existsSync(path.join(REPO, 'src', rel))
      || !fs.readFileSync(path.join(mirror, rel)).equals(fs.readFileSync(path.join(REPO, 'src', rel)));
    assert.ok([...filesUnder(mirror), ...filesUnder(path.join(REPO, 'src'))].some(differs), `the ${LEGACY_TAG} runtime equals this checkout's; the mixed-version cell proves nothing`);

    // `update` runs without -f: force would make every file known-good and hide the sibling-fingerprint
    // acceptance this cell exists to prove. The confirmation prompt is answered on stdin. A null
    // harness is a bare `update`, which targets claude alone.
    const step = async (verb: any, harness: any) => {
      const r: any = await spawn(cell, process.execPath, [CLI, verb, 'proj', ...(verb === 'update' ? [] : ['-f']), ...(harness ? ['-t', harness] : [])], cell.dir, 'y\n');
      assert.equal(r.status, 0, `${verb} -t ${harness}: ${r.stdout}${r.stderr}`);
      assert.ok(!/modified outside DoFlow/.test(r.stdout + r.stderr), `${verb} -t ${harness}: ${r.stdout}${r.stderr}`);
      return r;
    };

    const retired = runtimeOrphans(cell.proj);
    assert.ok(retired.length > 0, `the ${LEGACY_TAG} runtime ships nothing this checkout dropped; the prune is not exercised`);
    const updated: any = await step('update', 'pi');
    const notices = `${updated.stdout}\n${updated.stderr}`.split('\n').filter((line) => line.includes('replaced shared files'));
    assert.deepEqual(notices, ['[INFO] pi: replaced shared files written by claude; reinstall that harness to restore them'], `${updated.stdout}${updated.stderr}`);
    // IC-037: the run named pi, but the shared hooks tree moved, so claude's front doors came along.
    assert.ok(updated.stdout.includes(`[INFO] claude: ${CLAUDE_REFRESH}`), updated.stdout);
    const door = path.join(cell.proj, '.claude', 'hooks', 'pre-implement-gate.sh');
    assert.ok(fs.readFileSync(door).equals(fs.readFileSync(path.join(REPO, 'core', 'harnesses', 'claude', 'hooks', 'pre-implement-gate.sh'))), 'the claude gate door equals the source after `update -t pi`');
    // And the refreshed door works against the refreshed tree: a source edit with no design.md is denied natively.
    const gated = noDesignProject(cell);
    const gate = spawnSync(bashPath(), [door], { cwd: gated, encoding: 'utf8',
      env: { ...emptyEnv(cell), PATH: process.env.PATH, DOFLOW_PROJECT_DIR: gated, DOFLOW_AGENT: 'claude', CLAUDE_CONFIG_DIR: '', CLAUDE_PROJECT_DIR: '' },
      input: `${JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'reach', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } })}\n` });
    assert.equal(gate.status, 0, gate.stderr);
    assert.equal(JSON.parse(gate.stdout).hookSpecificOutput.permissionDecision, 'deny', gate.stdout);
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
    const older: any = await install(cell, 'project', 'claude,pi', path.join(legacy, 'bin', 'doflow.js'));
    assert.equal(older.status, 0, older.stderr);

    const runtime = path.join(cell.proj, '.doflow', 'runtime');
    const shown = (rel: any) => `.doflow/runtime/${rel.split(path.sep).join('/')}`;
    const retired = runtimeOrphans(cell.proj);
    assert.ok(retired.length > 1, 'the fixture needs at least two retired runtime files');
    const [edited, ...pristine] = retired;
    fs.appendFileSync(path.join(runtime, edited), '// a local fix\n');
    const editedBytes = fs.readFileSync(path.join(runtime, edited));
    const userFile = path.join('src', 'my-notes.js');
    fs.writeFileSync(path.join(runtime, userFile), 'mine\n');
    const cli = (args: any) => spawn(cell, process.execPath, [CLI, ...args], cell.dir, 'y\n');

    const dry: any = await cli(['update', 'proj', '-t', 'pi', '--dry-run']);
    assert.equal(dry.status, 0, `${dry.stdout}${dry.stderr}`);
    for (const rel of pristine) assert.ok(dry.stdout.includes(`[DRY]   pi: prune ${shown(rel)}: no longer shipped, unchanged since DoFlow wrote it`), `${rel} not listed`);
    assert.ok(dry.stdout.includes(`[DRY]   pi: kept hand-edited ${shown(edited)}; DoFlow no longer manages it`), dry.stdout);
    assert.ok(dry.stdout.includes(`[DRY]   pi: kept ${shown(userFile)}: not shipped by this version and not recorded as DoFlow's`), dry.stdout);
    assert.deepEqual(runtimeOrphans(cell.proj).sort(), [...retired, userFile].sort(), '--dry-run deletes nothing');

    const real: any = await cli(['update', 'proj', '-t', 'pi']);
    assert.equal(real.status, 0, `${real.stdout}${real.stderr}`);
    assert.ok(!/modified outside DoFlow/.test(real.stdout + real.stderr), real.stdout + real.stderr);
    assert.ok(real.stdout.includes(`[INFO] pi: kept hand-edited ${shown(edited)}; DoFlow no longer manages it`), real.stdout);
    assert.ok(real.stdout.includes(`[INFO] pi: kept ${shown(userFile)}: not shipped by this version and not recorded as DoFlow's`), real.stdout);
    assert.deepEqual(runtimeOrphans(cell.proj).sort(), [edited, userFile].sort(), 'only the edited and the unrecorded file remain');
    assert.ok(fs.readFileSync(path.join(runtime, edited)).equals(editedBytes));

    const bare: any = await cli(['update', 'proj']);
    assert.equal(bare.status, 0, `${bare.stdout}${bare.stderr}`);
    assert.ok(bare.stdout.includes(`[INFO] claude: kept hand-edited ${shown(edited)}; DoFlow no longer manages it`), bare.stdout);
    assert.deepEqual(runtimeOrphans(cell.proj).sort(), [edited, userFile].sort());
    assert.equal(fs.readFileSync(path.join(runtime, userFile), 'utf8'), 'mine\n');
  });

  // 073 T5: a rollback restores the ledger rows of the files it restores, so the install it leaves can be
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
    const older: any = await install(cell, 'project', 'claude,pi', path.join(legacy, 'bin', 'doflow.js'));
    assert.equal(older.status, 0, older.stderr);

    const mirror = path.join(cell.proj, '.doflow', 'runtime', 'src');
    const ledgerFile = path.join(cell.proj, '.doflow', 'state', 'ledger.json');
    const retired = filesUnder(mirror).filter((rel: any) => !fs.existsSync(path.join(REPO, 'src', rel)));
    assert.ok(retired.length > 0, `the ${ROLLBACK_TAG} runtime ships nothing this checkout dropped; the cell proves nothing`);
    const before: any = new Map(retired.map((rel: any) => [rel, fs.readFileSync(path.join(mirror, rel))]));
    const ledgerBefore = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));

    const cli = (args: any, cwd: any = cell.dir) => spawn(cell, process.execPath, [CLI, ...args], cwd, 'y\n');
    const ok = (r: any, what: any) => {
      assert.equal(r.status, 0, `${what}: ${r.stdout}${r.stderr}`);
      assert.ok(!/modified outside DoFlow/.test(r.stdout + r.stderr), `${what}: ${r.stdout}${r.stderr}`);
      return r;
    };
    const updated = ok(await cli(['update', 'proj', '-t', 'pi']), 'update -t pi');
    assert.deepEqual(retired.filter((rel: any) => fs.existsSync(path.join(mirror, rel))), [], 'the update prunes every retired runtime file');
    const bid = (updated.stdout + updated.stderr).match(/Backup created: (\S+)/)?.[1];
    assert.ok(bid, `no backup id in: ${updated.stdout}${updated.stderr}`);

    ok(await cli(['rollback', bid, '-f'], cell.proj), 'rollback');
    for (const [rel, bytes] of before) assert.ok(fs.readFileSync(path.join(mirror, rel)).equals(bytes), `${rel} is not restored byte-identical`);
    // The rows of the files it restores come back as they were; rows of files it left in place stay (073 B1).
    const rowsAt = (ledger: any, file: any) => JSON.stringify(ledger.resources.filter((r: any) => r.target === file));
    const ledgerAfter = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    for (const rel of retired) {
      const file = path.join(mirror, rel);
      assert.equal(rowsAt(ledgerAfter, file), rowsAt(ledgerBefore, file), `the rows of ${rel} are not restored`);
    }

    ok(await cli(['update', 'proj']), 'update after rollback');
    ok(await cli(['update', 'proj', '-t', 'pi']), 'update -t pi after rollback');
    assert.deepEqual(retired.filter((rel: any) => fs.existsSync(path.join(mirror, rel))), []);
    ok(await cli(['remove', 'proj', '-f', '-t', 'claude,pi']), 'remove after rollback');
    assert.equal(fs.existsSync(path.join(cell.proj, '.doflow', 'runtime')), false);
  });

  // IC-037: a claude door edited by hand makes `update -t pi` refuse the whole plan rather than leave the doors behind the tree.
  // Must name a release OLDER than this checkout: pinning the tag being released makes the install identical to HEAD.
  const DOORS_TAG = 'v2.0.0-beta.4';
  test(`a ${DOORS_TAG} install with one claude door edited: \`update -t pi\` refuses and leaves the tree and every door unchanged`, { skip: tagSkip(DOORS_TAG) }, async () => {
    const cell = newCell('edited-door');
    const legacy = path.join(cell.dir, 'legacy');
    fs.mkdirSync(legacy);
    const archive = spawnSync('git', ['archive', '--format=tar', '-o', path.join(cell.dir, 'legacy.tar'), DOORS_TAG], { cwd: REPO, encoding: 'utf8' });
    assert.equal(archive.status, 0, archive.stderr);
    assert.equal(spawnSync('tar', ['-x', '-f', path.join(cell.dir, 'legacy.tar'), '-C', legacy]).status, 0);
    const older: any = await install(cell, 'project', 'claude,pi', path.join(legacy, 'bin', 'doflow.js'));
    assert.equal(older.status, 0, `${DOORS_TAG} install: ${older.stderr}`);

    fs.appendFileSync(path.join(cell.proj, '.claude', 'hooks', 'pre-implement-gate.sh'), '# edited by hand\n');
    const guarded = () => ['.claude/hooks', '.doflow/shared/hooks', '.pi'].map((dir) => filesUnder(path.join(cell.proj, dir)).sort().map((rel: any) => `${dir}/${rel}:${fs.readFileSync(path.join(cell.proj, dir, rel)).toString('base64')}`));
    const before = guarded();

    const refused: any = await spawn(cell, process.execPath, [CLI, 'update', 'proj', '-t', 'pi'], cell.dir, 'y\n');
    assert.equal(refused.status, 1, `${refused.stdout}${refused.stderr}`);
    assert.ok(refused.stderr.includes('claude hook front doors must move with the shared hooks tree; run: doflow update -t pi,claude (add -f to overwrite edited doors)'), refused.stderr);
    assert.deepEqual(guarded(), before, 'a refused plan changes neither the tree nor a door');
  });

  test(`mixed versions: a ${LEGACY_TAG} install updates to this checkout's runtime and is removed cleanly`, { skip: tagSkip(LEGACY_TAG) }, mixedVersion(LEGACY_TAG, false));
  test(`mixed versions: a ${OLDER_TAG} install, whose guidance differs from this checkout's, updates with no source edit`, { skip: tagSkip(OLDER_TAG) }, mixedVersion(OLDER_TAG, true));
});
