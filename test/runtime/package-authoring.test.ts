'use strict';
const { bashPath } = require('../helper/bash-locator.ts');

// F.3 / IC-027: the idea-to-package loop through a real global claude install.
// Only the test, standing in for the person, writes the printed grant lines.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { IS_WIN } = require('../helper-platform.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const SKIP = IS_WIN ? 'the doflow-run shim is POSIX shell' : false;
const SKILL = '---\nname: author-skill-triage\ndescription: Triage incoming reports by severity.\n---\n\n# Triage\n\nSort incoming reports by severity and name the next step.\n';

test('idea to package through the installed front door', { skip: SKIP }, async (t: any) => {
  const root = tempDir(t, 'doflow-package-authoring-');
  const home = path.join(root, 'home');
  const xdg = path.join(home, '.config');
  const project = path.join(root, 'project');
  const tmp = path.join(root, 'tmp');
  for (const dir of [home, xdg, project, tmp]) fs.mkdirSync(dir, { recursive: true });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (name.startsWith('DOFLOW_') || name === 'PI_CODING_AGENT_DIR') delete env[name];
  }
  Object.assign(env, {
    HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: xdg, TMPDIR: tmp,
    PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH,
    DOFLOW_TELEMETRY: 'off', DOFLOW_UPKEEP: 'off', DOFLOW_FAILURE_CAPTURE: 'off',
    GIT_CONFIG_GLOBAL: path.join(root, 'no-gitconfig'), GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
  });
  const shim = path.join(home, '.doflow', 'scripts', 'doflow', 'bin', 'doflow-run');
  const grants = path.join(xdg, 'doflow', 'packages', 'grants.jsonl');

  t.before(() => {
    const git = spawnSync('git', ['init', '-q'], { cwd: project, env, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stdout + git.stderr);
    const installed = spawnSync(process.execPath, [
      path.join(REPO_ROOT, 'bin', 'doflow.js'), 'install', '-g', '-f', '--no-backup', '-t', 'claude',
    ], { cwd: project, env, encoding: 'utf8', input: '\n', timeout: 60000 });
    assert.equal(installed.status, 0, installed.stdout + installed.stderr);
    assert.equal(fs.existsSync(shim), true);
    const installedSkill = fs.readFileSync(path.join(home, '.claude', 'skills', 'do', 'SKILL.md'), 'utf8');
    assert.ok(installedSkill.includes('package --action new'), 'the installed dispatcher carries the authoring route');
  });

  const run = (args: string[]): string => {
    const result = spawnSync(bashPath(), [shim, ...args], {
      cwd: project, env, encoding: 'utf8', input: '', timeout: 60000,
    });
    assert.equal(result.status, 0, args.join(' ') + '\n' + result.stdout + result.stderr);
    return result.stdout;
  };
  const pkg = (action: string, args: string[] = []): any => JSON.parse(run(['package', '--action', action, ...args, '--json']));
  const check = (dir: string): any => {
    const checked = pkg('check', ['--path', dir]);
    assert.equal(checked.ok, true, JSON.stringify(checked.findings));
    return checked;
  };
  const state = (id: string, expected: string, reasons: string[] = []): any => {
    const shown = pkg('show', ['--id', id]);
    assert.equal(shown.state, expected, JSON.stringify(shown));
    assert.deepEqual(shown.reasons, reasons);
    return shown;
  };
  const appendUnlessLast = (line: string) => {
    fs.mkdirSync(path.dirname(grants), { recursive: true });
    const text = fs.existsSync(grants) ? fs.readFileSync(grants, 'utf8') : '';
    if (text.trimEnd().split('\n').at(-1) !== line) fs.appendFileSync(grants, line + '\n');
  };

  await t.test('inert scaffold resolves as a user preset and stays active after an edit without a grant', () => {
    const id = 'author-review';
    const made = pkg('new', ['--id', id, '--points', 'review-preset']);
    assert.equal(made.ok, true);
    assert.equal(made.dir, path.join(project, '.doflow', 'package', id));
    assert.deepEqual(made.next.map((step: any) => step.step), ['edit', 'check', 'add', 'apply', 'enable', 'iterate']);
    check(made.dir);
    const { plan } = pkg('add', ['--source', made.dir]);
    assert.deepEqual(plan.grantLines, {});
    assert.equal(pkg('add', ['--plan', plan.planId]).ok, true);
    assert.equal(pkg('enable', ['--id', id]).state, 'active');
    state(id, 'active');

    run(['config', 'set', 'review.preset', JSON.stringify(id + '.review-preset'), '--layer', 'user']);
    const resolved = JSON.parse(run(['protocol', '--action', 'resolve', '--kind', 'review', '--json']));
    assert.equal(resolved.ok, true);
    assert.equal(resolved.protocol.id, id + '.review-preset');

    const presetFile = path.join(made.dir, 'presets', 'review-preset.json');
    const preset = JSON.parse(fs.readFileSync(presetFile, 'utf8'));
    preset.rounds.default = 3;
    fs.writeFileSync(presetFile, JSON.stringify(preset, null, 2) + '\n');
    const edited = check(made.dir);
    assert.notEqual(edited.contentDigest, made.contentDigest);
    const update = pkg('update', ['--id', id]).plan;
    assert.deepEqual(update.grantLines, {});
    const applied = pkg('update', ['--plan', update.planId]);
    assert.equal(applied.ok, true);
    assert.equal(applied.contentDigest, edited.contentDigest);
    assert.equal(Object.hasOwn(applied, 'grantLines'), false);
    state(id, 'active');
    assert.equal(fs.existsSync(grants), false, 'an inert package never needed a grant');
  });

  await t.test('skill authoring requires trust, unprojects on edit, rejects old trust and reactivates on fresh trust', () => {
    const id = 'author-skill';
    const dir = path.join(project, 'authored-skill');
    const made = pkg('new', ['--id', id, '--points', 'skill:triage', '--dir', dir]);
    assert.equal(made.ok, true);
    assert.equal(made.dir, dir);
    assert.deepEqual(made.next.map((step: any) => step.step), ['edit', 'check', 'add', 'apply', 'enable', 'trust', 'iterate']);
    const sourceSkill = path.join(dir, 'skills', id + '-triage', 'SKILL.md');
    const projected = path.join(home, '.claude', 'skills', id + '-triage', 'SKILL.md');
    fs.writeFileSync(sourceSkill, SKILL);
    check(dir);
    const { plan } = pkg('add', ['--source', dir]);
    assert.ok(plan.grantLines.trust);
    assert.equal(pkg('add', ['--plan', plan.planId]).ok, true);
    assert.equal(pkg('enable', ['--id', id]).state, 'needs-trust');
    state(id, 'needs-trust', ['grant-missing']);
    assert.equal(fs.existsSync(projected), false);
    const printed = pkg('trust', ['--id', id]);
    assert.equal(printed.grantFile, grants);
    assert.equal(fs.existsSync(grants), false, 'trust prints a line without writing it');
    const oldTrust = printed.grantLines.trust;
    appendUnlessLast(oldTrust);
    assert.equal(pkg('enable', ['--id', id]).state, 'active');
    state(id, 'active');
    assert.equal(fs.readFileSync(projected, 'utf8'), SKILL);

    const editedSkill = SKILL + '\nInclude reproduction steps in each report.\n';
    fs.writeFileSync(sourceSkill, editedSkill);
    const edited = check(dir);
    const update = pkg('update', ['--id', id]).plan;
    assert.equal(update.contentDigest, edited.contentDigest);
    assert.notEqual(update.contentDigest, plan.contentDigest);
    const applied = pkg('update', ['--plan', update.planId]);
    assert.equal(applied.ok, true);
    assert.equal(applied.grantFile, grants);
    assert.match(applied.note, /acts again only after a person adds that line/);
    assert.ok(applied.grantLines.trust);
    assert.notEqual(applied.grantLines.trust, oldTrust);
    assert.equal(JSON.parse(applied.grantLines.trust).contentDigest, edited.contentDigest);
    state(id, 'needs-trust', ['content-changed']);
    assert.equal(fs.existsSync(projected), false);

    // Negative control: avoid a duplicate line, which would test an invalid file instead of stale trust.
    appendUnlessLast(oldTrust);
    assert.equal(pkg('enable', ['--id', id]).state, 'needs-trust');
    state(id, 'needs-trust', ['content-changed']);
    assert.equal(fs.existsSync(projected), false);

    // Same version: the person appends the printed fresh line after the old one, which stays and grants nothing.
    appendUnlessLast(applied.grantLines.trust);
    assert.ok(fs.readFileSync(grants, 'utf8').split('\n').includes(oldTrust), 'the old trust line is still in the file');
    assert.equal(pkg('enable', ['--id', id]).state, 'active');
    state(id, 'active');
    assert.equal(fs.readFileSync(projected, 'utf8'), editedSkill);
  });
});

test('the do authoring route fits IC-027 and names no new reference file', () => {
  const text = fs.readFileSync(path.join(REPO_ROOT, 'core', 'shared', 'skills', 'do', 'SKILL.md'), 'utf8');
  const step1 = text.split('2. **Multi-Part / Ambiguous Request Routing')[0];
  const routes = step1.split('\n').filter((line: string) => line.startsWith('   - ') && line.includes('/do package <idea>'));
  assert.equal(routes.length, 1);
  const route = routes[0];
  assert.ok(Buffer.byteLength(route + '\n', 'utf8') <= 420);
  assert.doesNotMatch(route, /[^\x00-\x7f]/);
  assert.ok(step1.indexOf(route) > step1.indexOf('/do program <goal>'));
  assert.match(route, /make this a DoFlow extension\/package\/plugin/);
  assert.match(route, /"\$DOFLOW" package --action points --json/);
  assert.match(route, /stop if a needed point is not open/);
  assert.match(route, /up to 3 questions.*question tool/);
  assert.match(route, /"\$DOFLOW" package --action new --id <id> --points <point\[:local\],\.\.\.>/);
  assert.match(route, /follow.*next.*lines/);
  assert.match(route, /No evidence batch/);
  assert.match(route, /never write.*grants\.jsonl.*add remote sources.*create a feature folder/);
  const references = [...new Set([...text.matchAll(/references\/([A-Za-z0-9_./-]+\.md)/g)].map((match) => match[1]))].sort();
  // Row 131 (G75, one hop): SKILL.md names the guidance references pm_routing.md and program_mode.md
  // point at, and do-document's deep_research.md; none is a new reference file.
  assert.deepEqual(references, ['EVIDENCE_LEDGER.md', 'MODEL_SELECTION.md', 'ORCHESTRATION.md', 'advice_calls.md', 'deep_research.md', 'estimation.md', 'pm_routing.md', 'program_mode.md', 'tool_matrix.md']);
});
