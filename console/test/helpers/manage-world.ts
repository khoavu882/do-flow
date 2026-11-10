'use strict';

// Feature 151 B.6 (IC-023; FR-004, FR-008, FR-010 to FR-012, FR-020, NFR-002; plan D5, D7, D8): the management
// world, added to a project made by helpers/core-fixture.ts (`buildFixture`) so the read contract and the fixture
// Console's `--manage` mode read the same world. Every DoFlow record is written by the real core or by its own
// writers; the build runs every core call with DOFLOW_UPKEEP=off, so the fixture's back-dated `upkeep-due` files
// still give a later call without the switch upkeep to do (the read contract's vacuity control).
//
// What it adds:
//   settings   the config home's user file (`<XDG_CONFIG_HOME>/doflow/settings.json`, the config home the runner
//              passes through) sets `advice.enabled` true with no `advice.model`, so the cross-key rule of
//              `core/registry/settings.json` fires and `config list` exits 1 (D7); `workers.enabled` to two workers
//              ending in `primary`; one `workers.models` binding; an unknown key whose name holds the planted email.
//              The project file (`<project>/.doflow/settings.json`) sets `advice.kinds.task-class` to `shadow` and
//              `workers.enabled`, which the user file also sets. The local file (`settings.local.json`) does not parse.
//   follow-ups 62 through the real `followup --action add --batch`, their statements holding the planted secret,
//              email, IP, a path inside the fixture home and one inside the project (the core masks the first four on
//              write, so the project path is the one the records keep); one then taken, one dismissed, 60 left open
//   goal       one through the real `goal` verb, both items checked met, so `proposeDone` is true
//   features   two tracked with the real `lifecycle --action init`; their git steps (D5) are the scripted
//              repository of test/helper/lifecycle-git-fixtures.ts (`makeRepo`, `featureBranch`, `mergeNoFf`, `tag`)
//              with its clock moved past the tracking instant, fetched into the project as `develop` and its tags:
//              the first merged and inside `v1.0.0` (finished), the second merged after it (awaiting release)
//   doctor     D8: a global install ledger in the fixture HOME that records Claude's `settings.json` (`defaultLedger`
//              and `writeLedger`, src/state/index.ts) and a `<HOME>/.claude/settings.json` whose own
//              `permissions.allow` lacks the shipped entries, so doctor warns `claude-permissions-user-array` with the
//              absolute file path in its subject
//   advice     helpers/advice-world.ts
//
// Before it returns, the world checks its premises against the real core and throws when one does not hold:
// `config list` exits 1 with the local file `invalid` `unparseable`, the unknown key's note, and `advice.enabled`
// resolved `via: 'fail-safe'` from the local layer; `config list -g` exits 1 with `advice.enabled` resolved
// `via: 'cross-key'` (D7's rule is a global-view rule, and in the project view the unparseable local file trips the
// fail-safe first, so the resolver never reaches the `requires` check there); `lifecycle --action overview` lists the
// goal with `proposeDone`, 60 open follow-ups and one feature in each of `finished` and `awaitingRelease`; raw
// `doctor --json` holds the fixture home path in a warning subject; the raw pick records hold the planted text, and
// the raw follow-up records hold the project path.
//
// This module touches no test-runner global, so console/scripts can import it.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { buildAdviceWorld } = require('./advice-world.ts');

const REPO = path.resolve(__dirname, '..', '..', '..');
const { makeRepo, featureBranch } = require(path.join(REPO, 'test', 'helper', 'lifecycle-git-fixtures.ts'));

const MANAGE_PLANTED = Object.freeze({
  secret: 'fx-Manage-Secret-71d0a3',
  email: 'manage.person@example.invalid',
  ip: '10.71.72.73',
  marker: 'MANAGE-WORLD-MARKER-3c6f',
});
const OPEN_FOLLOWUPS = 60;
const GOAL = 'manage-goal';
const FEATURES = Object.freeze({ finished: 'manage-shipped', awaitingRelease: 'manage-waiting' });
const WORKERS_ENABLED = Object.freeze(['codex', 'claude', 'primary']);
const PROJECT_WORKERS = Object.freeze(['codex', 'primary']);
const WORKER_MODELS = Object.freeze({ codex: Object.freeze({ standard: 'gpt-5-codex' }) });
const DOCTOR_KIND = 'claude-permissions-user-array';

type FixtureLike = { dir: string, main: string, env: Record<string, string>, roots: Record<string, string> };
type ManageOptions = {
  fixture: FixtureLike;
  /** The checkout's `bin/doflow.js` (default: this checkout's). */
  core?: string;
};
type CoreAnswer = { exit: number | null, json: any, stdout: string, stderr: string };

function fail(what: string, answer?: CoreAnswer): never {
  const tail = answer ? `\nexit ${answer.exit}\n${answer.stdout.slice(0, 2000)}${answer.stderr.slice(0, 2000)}` : '';
  throw new Error(`manage world: ${what}${tail}`);
}

/**
 * Adds the management world to `fixture` (a `buildFixture` result). Returns the files it wrote, the follow-up ids by
 * state, the goal and feature slugs, the doctor subject, the advice world, the planted values, the extra roots to
 * snapshot (`project-layers`, the project's `.doflow`; `claude-home`, `<HOME>/.claude`) and the core's raw answers
 * the premises were checked on.
 */
function buildManageWorld(options: ManageOptions) {
  const { fixture } = options;
  const core = options.core ?? path.join(REPO, 'bin', 'doflow.js');
  const { main, env } = fixture;
  const home = env.HOME;
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new TypeError('manage world: the fixture env has no absolute HOME');
  if (typeof env.XDG_CONFIG_HOME !== 'string' || !path.isAbsolute(env.XDG_CONFIG_HOME)) throw new TypeError('manage world: the fixture env has no absolute XDG_CONFIG_HOME');
  const build = { ...env, DOFLOW_UPKEEP: 'off' };
  const checkout = path.dirname(path.dirname(core));
  const call = (args: string[], expect: readonly number[] = [0]): CoreAnswer => {
    const result = spawnSync(process.execPath, [core, ...args, '--json'], { cwd: main, env: build, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000 });
    let json: any = null;
    try { json = JSON.parse(result.stdout); } catch { /* checked below */ }
    const answer = { exit: result.status, json, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    if (!expect.includes(result.status as number) || json === null) fail(`doflow ${args.join(' ')} answered unexpectedly`, answer);
    return answer;
  };
  const { secret, email, ip, marker } = MANAGE_PLANTED;
  const homePath = path.join(home, 'notes', 'manage-world-7d3b.md');
  // The core masks a statement on write (src/runtime/lifecycle/followup.ts `oneLine`, `maskLine`): the secret, email,
  // IP and home path never reach the store. A path inside the project is kept as it is, so it is the live planted
  // value of the follow-up records; the Console must place it.
  const projectPath = path.join(main, 'docs', 'manage-world-notes.md');
  const text = (n: number) => `follow-up ${n}: password=${secret} mail ${email} host ${ip} file ${homePath} see ${projectPath}`;

  // ---- Settings layers (D7) ----
  const configHome = path.join(env.XDG_CONFIG_HOME, 'doflow');
  const layers = path.join(main, '.doflow');
  const files = {
    user: path.join(configHome, 'settings.json'),
    project: path.join(layers, 'settings.json'),
    local: path.join(layers, 'settings.local.json'),
  };
  const unknownKey = `contact.${email}`;
  fs.mkdirSync(configHome, { recursive: true });
  fs.mkdirSync(layers, { recursive: true });
  for (const file of Object.values(files)) if (fs.existsSync(file)) fail(`${file} exists already`);
  fs.writeFileSync(files.user, `${JSON.stringify({ 'advice.enabled': true, 'workers.enabled': WORKERS_ENABLED, 'workers.models': WORKER_MODELS, [unknownKey]: true }, null, 2)}\n`);
  fs.writeFileSync(files.project, `${JSON.stringify({ 'advice.kinds.task-class': 'shadow', 'workers.enabled': PROJECT_WORKERS }, null, 2)}\n`);
  fs.writeFileSync(files.local, `{ "advice.kinds.tier": "shadow", "${marker}": \n`);

  // ---- Follow-ups: 62 added through the real verb, one taken, one dismissed ----
  const batch = path.join(fixture.dir, 'manage-followups.json');
  fs.writeFileSync(batch, JSON.stringify(Array.from({ length: OPEN_FOLLOWUPS + 2 }, (_, i) => ({ statement: text(i + 1) }))));
  const added = call(['followup', '--action', 'add', '--batch', batch, '--source', 'manual']).json;
  const ids: string[] = (added.created ?? []).map((item: any) => item.id);
  if (ids.length !== OPEN_FOLLOWUPS + 2 || ids.some((id) => !/^FU-[0-9a-hjkmnp-tv-z]{6}$/.test(id))) fail(`followup add returned ${JSON.stringify(added).slice(0, 400)}`);
  fs.rmSync(batch);

  // ---- Goal, both items met (proposeDone) ----
  call(['goal', '--action', 'add', '--goal', GOAL, '--statement', 'The management screens read every store', '--item', 'settings screen', '--item', 'health screen']);
  for (const item of ['C1', 'C2']) call(['goal', '--action', 'check', '--goal', GOAL, '--item', item, '--evidence', `checked ${item}`]);

  // ---- Features (D5): tracked by the real init, merged and tagged by the scripted repository, fetched in ----
  for (const slug of Object.values(FEATURES)) {
    fs.mkdirSync(path.join(main, 'agent-docs', 'doflow', slug), { recursive: true });
    fs.writeFileSync(path.join(main, 'agent-docs', 'doflow', slug, 'requirement.md'), `# ${slug}\n`);
    call(['lifecycle', '--action', 'init', '--slug', slug, '--goal', GOAL]);
  }
  const [taken, dismissed] = ids.slice(OPEN_FOLLOWUPS);
  call(['followup', '--action', 'take', '--ids', taken, '--slug', FEATURES.awaitingRelease]);
  call(['followup', '--action', 'settle', '--ids', dismissed, '--as', 'dismissed', '--reason', 'out of scope for the world']);
  const gitDir = path.join(fixture.dir, 'manage-git');
  fs.mkdirSync(gitDir, { recursive: true });
  const identity = { GIT_AUTHOR_NAME: 'DoFlow UI Fixture', GIT_AUTHOR_EMAIL: 'doflow-ui-fixture@example.test', GIT_COMMITTER_NAME: 'DoFlow UI Fixture', GIT_COMMITTER_EMAIL: 'doflow-ui-fixture@example.test' };
  const scratch = { dir: gitDir, env: (extra: Record<string, string> = {}) => ({ ...env, ...identity, ...extra }) };
  const repo = makeRepo(scratch, 'manage-releases');
  // The tracking instant is the init's own (now); the lower bound of merge evidence is that second, so the
  // scripted clock starts a minute after it.
  repo.at(new Date(Date.now() + 60_000).toISOString());
  repo.mergeNoFf(featureBranch(repo, FEATURES.finished, 1));
  repo.tag('v1.0.0');
  repo.mergeNoFf(featureBranch(repo, FEATURES.awaitingRelease, 1));
  execFileSync('git', ['-C', main, 'fetch', '-q', '--no-tags', repo.dir, 'refs/heads/*:refs/heads/*', 'refs/tags/*:refs/tags/*'], { env, stdio: 'ignore' });

  // ---- Doctor warning (D8) ----
  const { defaultLedger, writeLedger, stateRoot } = require(path.join(checkout, 'src', 'state', 'index.ts'));
  const claudeSettings = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true });
  fs.writeFileSync(claudeSettings, `${JSON.stringify({ permissions: { allow: ['Bash(ls:*)'] } }, null, 2)}\n`);
  writeLedger(stateRoot({ scope: 'global', homeDir: home }), {
    ...defaultLedger({ scope: 'global', scopeRoot: home }),
    resources: [{ harness: 'claude', assetId: 'claude.settings', kind: 'settings-file', identity: 'settings.json' }],
  });
  const doctorSubject = `${claudeSettings}: permissions.allow`;

  // ---- Advice picks ----
  const advice = buildAdviceWorld({ core, projectRoot: main, env });

  // ---- Premises, against the real core ----
  // D7's rule is a global-view rule, and the resolver checks it only for a key no fail-safe tripped first
  // (src/runtime/settings/resolve.ts, `requires` after the gate loop). In the project view the unparseable local
  // file trips every security-relevant key to its fail-safe, so there `config list` exits 1 with `advice.enabled`
  // `via: 'fail-safe'`; in the global view (user layer, no local file) it exits 1 with `via: 'cross-key'`.
  const configList = call(['config', 'list'], [1]);
  const projectEnabled = configList.json.keys?.['advice.enabled'];
  if (projectEnabled?.origin?.via !== 'fail-safe' || projectEnabled.origin.layer !== 'local') fail(`config list: advice.enabled is not fail-safe from the local layer: ${JSON.stringify(projectEnabled?.origin)}`);
  const globalList = call(['config', 'list', '-g'], [1]);
  const globalEnabled = globalList.json.keys?.['advice.enabled'];
  if (globalEnabled?.origin?.via !== 'cross-key' || !(globalList.json.errors ?? []).some((e: any) => e.key === 'advice.enabled' && e.code === 'cross-key')) {
    fail(`config list -g: advice.enabled is not resolved via cross-key: ${JSON.stringify(globalEnabled?.origin)}`);
  }
  if (!(configList.json.notes ?? []).some((note: any) => note.code === 'unknown-key' && note.key === unknownKey)) fail('config list: no unknown-key note names the planted key');
  if (!(configList.json.files ?? []).some((file: any) => file.layer === 'local' && file.status === 'invalid' && file.code === 'unparseable')) fail('config list: the local file is not invalid unparseable');
  const overview = call(['lifecycle', '--action', 'overview']);
  const goal = (overview.json.goals ?? []).find((g: any) => g.goal === GOAL);
  if (!goal || goal.proposeDone !== true) fail(`overview: goal ${GOAL} is not proposeDone: ${JSON.stringify(goal)}`);
  const buckets = overview.json.features ?? {};
  if (JSON.stringify(buckets.finished) !== JSON.stringify([FEATURES.finished]) || JSON.stringify(buckets.awaitingRelease) !== JSON.stringify([FEATURES.awaitingRelease])) {
    fail(`overview: features are ${JSON.stringify(buckets)}`);
  }
  if (overview.json.followups?.open !== OPEN_FOLLOWUPS) fail(`overview: ${overview.json.followups?.open} open follow-ups`);
  const doctor = call(['doctor'], [0, 1]);
  const warning = (doctor.json.warnings ?? []).find((w: any) => w.kind === DOCTOR_KIND);
  if (!warning || warning.subject !== doctorSubject || !warning.subject.includes(home)) fail(`doctor: no ${DOCTOR_KIND} warning naming ${doctorSubject}: ${JSON.stringify(doctor.json.warnings)}`);
  const pickText = advice.files.map((file: string) => fs.readFileSync(file, 'utf8')).join('');
  for (const value of [advice.planted.secret, advice.planted.marker]) if (!pickText.includes(value)) fail(`the pick records do not hold ${value}`);
  const records = call(['followup', '--action', 'list', '--state', 'all', '--view', 'full']).json;
  const statements = JSON.stringify(records);
  if (!statements.includes(projectPath) || !statements.includes('password=<masked>')) fail('the follow-up records do not hold the project path and the core\'s own mask');

  return {
    home, configHome, homePath, projectPath, files: Object.freeze(files), unknownKey,
    followups: Object.freeze({ open: Object.freeze(ids.slice(0, OPEN_FOLLOWUPS)), taken, dismissed }),
    goal: GOAL, features: FEATURES, workersEnabled: WORKERS_ENABLED,
    doctor: Object.freeze({ kind: DOCTOR_KIND, subject: doctorSubject, settingsFile: claudeSettings }),
    advice,
    planted: Object.freeze({ ...MANAGE_PLANTED, homePath, projectPath, advice: advice.planted }),
    roots: Object.freeze({ 'project-layers': layers, 'claude-home': path.dirname(claudeSettings) }),
    raw: Object.freeze({ configList: configList.json, globalList: globalList.json, overview: overview.json, doctor: doctor.json }),
  };
}

module.exports = { FEATURES, GOAL, MANAGE_PLANTED, OPEN_FOLLOWUPS, buildManageWorld };
