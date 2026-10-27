'use strict';

// Feature 108 F.1: the G-L1 driver. Each scenario of the frozen oracle (test/fixtures/roadmap/g-l1/
// scenarios.json, written from the requirement and the public vocabulary only) is built into a scratch
// repository with the real orchestrator, gate policy, merge plumbing and loop, and every call's
// outcome, step, row, reason (and skips, where the oracle states them) is compared with expected.json.
//
// The oracle files are never edited and never special-cased: a difference between the loop and the
// oracle is a FINDING. Findings are listed in KNOWN_MISMATCHES below with the exact differences. The
// driver is red when a scenario outside the list differs, when a listed scenario now matches, or when a
// listed scenario differs in any other way, so the list can only shrink.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { createHash } = require('node:crypto');
const { shPath } = require('../helper/tool-stub.ts');
const { systemPath } = require('../helper/system-path.ts');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { repoFromTemplate } = require('../helper/repo-template.ts');
const { next, handleRoadmapCommand } = require('../../src/runtime/roadmap/loop.ts');
const { mergeRoadmapRow } = require('../../src/runtime/roadmap/merge.ts');
const { WorkflowOrchestrator } = require('../../src/runtime/workflow-orchestrator.ts');
const { initRegister, addDecisions } = require('../../src/runtime/decision-register.ts');

const REPO = path.resolve(__dirname, '../..');
const { verificationRunsRoot, verificationRunRecordFile } = require('../../src/runtime/verification/engine.ts');
/** Where the real verify verb appends the IC-007 run records of a checkout (the writer's own rule). */
const runRecordFile = (checkout: any, slug: any) => verificationRunRecordFile(verificationRunsRoot(checkout), slug);
const FIXTURES = path.join(__dirname, '../fixtures/roadmap/g-l1');
const SCENARIOS_FILE = path.join(FIXTURES, 'scenarios.json');
const EXPECTED_FILE = path.join(FIXTURES, 'expected.json');
// Recorded by the orchestrator when the oracle was frozen (A.2, sha256.txt).
const ORACLE_SHA256: any = {
  scenarios: 'c2cb4c9d1055be1ab0d0dd537725360a3dfa738f456377f4fe23027d26b480ef',
  expected: 'c0980181bb2708a8ed75e526111c6c1653f432e3827b7e5e47ea977b50011d2f',
};
const sha256 = (bytes: any) => createHash('sha256').update(bytes).digest('hex');
const SWITCH_ENV = 'DOFLOW_AUTOPILOT_ENABLED'; // orchestrator ruling: the oracle says DOFLOW_AUTOPILOT
const SKILL_OF_STAGE: any = { discovery: 'do-brainstorm', design: 'do-design', planning: 'do-plan', implementation: 'do-execute-plan', verification: 'do-test', review: 'do-code-review' };

// ── known mismatches (findings) ──────────────────────────────────────────────────────────────────
// id -> { diffs: exactly what the driver reports, reading: the one-line view of whether the oracle or
// the loop is wrong }. The orchestrator owns the final decision on each. An entry is removed when its
// scenario matches; an entry is never added to make the driver green, and the oracle is never edited.
// Ruling groups (decision C11), one sentence each; S8-TAIL, CLEANUP-NOTE and SEED-REJECTED are C12.
const GROUPS: any = {
  "HELD": "C11: IC-013 skips a held row with held:<reason> until its inputs digest changes; the oracle repeats the deny.",
  "DENY-ORDER": "C11: findings-valid fires first (validateFindings rejects a refuted finding without evidence); the specific reason is still in reasons.",
  "POLICY-LEVEL": "C11: a missing, invalid or widened policy denies at loop level before any row step (row null, step null); the widen parameter is the full key path.",
  "ORPHAN": "C11: a run or branch with no seed row is never visited; there is no row to gate.",
  "DEVELOP-WT": "C11: the develop worktree is the one whose branch is develop; with none the deny is no-develop-worktree.",
  "STATUS-3": "C11: status is three-valued from git; blocked and paused live in the run record and holdReason; S57's budget-vs-stuck depends on the driver's dispatch fixture.",
  "TRAILER-ROW": "C11: the oracle's default history has a DoFlow-Row 101 merge for a row its seed subsets lack, and IC-003 makes that a finding.",
  "S8-TAIL": "C12: merge.ts runs ff-done to rendered to cleaned inside one next call; step reports cleanup with annotations.rendered.",
  "CLEANUP-NOTE": "C12: the kept state is annotations.cleanup; reason stays null.",
  "USER-ACCEPTED": "C13: autopilot denies every user-accepted disposition (a question-channel register entry can be written by any session, review defect C5); a person-decided gate-b still accepts it.",
  "SEED-REJECTED": "C12: status fails closed on a seed the loop rejected.",
};
const known: any = (tags: any, diffs: any) => ({ tags, reading: tags.map((tag: any) => GROUPS[tag]).join(' '), diffs });
const KNOWN_MISMATCHES: any = {
  "S01-happy-path-full-cycle": known(["S8-TAIL"], [
    "call 12 step: expected \"render\" actual \"cleanup\"",
    "call 13 step: expected \"cleanup\" actual \"pick\"",
    "call 13 row: expected \"110\" actual \"112\"",
    "call 14 outcome: expected \"acted\" actual \"perform\"",
    "call 14 step: expected \"pick\" actual null",
  ]),
  "S06-gate0-marker-deny-then-pass": known(["HELD"], [
    "call 2 outcome: expected \"denied\" actual \"idle\"",
    "call 2 step: expected \"gate\" actual null",
    "call 2 row: expected \"110\" actual null",
    "call 2 reason: expected \"unresolved-clarifications\" actual null",
  ]),
  "S22-gateb-refuted-without-evidence": known(["DENY-ORDER"], [
    "call 1 reason: expected \"refuted-without-evidence:C3\" actual \"findings-invalid\"",
  ]),
  "S27-gateb-pass-two-seats": known(["USER-ACCEPTED"], [
    "call 1 outcome: expected \"acted\" actual \"denied\"",
    "call 1 reason: expected null actual \"user-accepted-needs-person:C9\"",
  ]),
  "S28-policy-absent": known(["POLICY-LEVEL"], [
    "call 1 step: expected \"gate\" actual null",
    "call 1 row: expected \"110\" actual null",
  ]),
  "S29-policy-invalid": known(["POLICY-LEVEL"], [
    "call 1 step: expected \"gate\" actual null",
    "call 1 row: expected \"110\" actual null",
  ]),
  "S30-policy-override-widens": known(["POLICY-LEVEL"], [
    "call 1 step: expected \"gate\" actual null",
    "call 1 row: expected \"110\" actual null",
    "call 1 reason: expected \"policy-override-widens:minSeats\" actual \"policy-override-widens:classes.feature.gate-b.minSeats\"",
  ]),
  "S33-policy-row-unknown": known(["ORPHAN"], [
    "call 1 outcome: expected \"denied\" actual \"acted\"",
    "call 1 step: expected \"gate\" actual \"pick\"",
    "call 1 row: expected null actual \"110\"",
    "call 1 reason: expected \"row-unknown\" actual null",
  ]),
  "S35-merge-develop-wrong-branch": known(["DEVELOP-WT"], [
    "call 1 reason: expected \"develop-wrong-branch\" actual \"no-develop-worktree\"",
  ]),
  "S41-crash-cp1-after-intent": known(["S8-TAIL"], [
    "call 2 step: expected \"render\" actual \"cleanup\"",
    "call 3 step: expected \"cleanup\" actual \"pick\"",
    "call 3 row: expected \"110\" actual \"112\"",
  ]),
  "S42-crash-cp2-after-commit-tree": known(["S8-TAIL"], [
    "call 2 step: expected \"render\" actual \"cleanup\"",
    "call 3 step: expected \"cleanup\" actual \"pick\"",
    "call 3 row: expected \"110\" actual \"112\"",
  ]),
  "S43-crash-cp3-after-ff": known(["S8-TAIL"], [
    "call 1 step: expected \"render\" actual \"cleanup\"",
    "call 2 step: expected \"cleanup\" actual \"pick\"",
    "call 2 row: expected \"110\" actual \"112\"",
  ]),
  "S46-cleanup-dirty-feature-worktree": known(["CLEANUP-NOTE"], [
    "call 1 reason: expected \"cleanup-kept\" actual null",
  ]),
  "S56-budget-iteration-cap": known(["STATUS-3"], [
    "final rowStatus.110: expected \"blocked: budget\" actual \"in-flight\"",
  ]),
  "S57-budget-attempts-exhausted": known(["STATUS-3"], [
    "call 1 reason: expected \"budget\" actual \"stuck\"",
    "final rowStatus.110: expected \"blocked: budget\" actual \"in-flight\"",
  ]),
  "S58-stuck-dispatch-blocked": known(["STATUS-3"], [
    "final rowStatus.110: expected \"blocked: stuck\" actual \"in-flight\"",
  ]),
  "S59-stuck-repeated-failure-class": known(["STATUS-3"], [
    "final rowStatus.110: expected \"blocked: stuck\" actual \"in-flight\"",
  ]),
  "S60-quota-paused": known(["STATUS-3"], [
    "final rowStatus.110: expected \"paused: quota\" actual \"in-flight\"",
  ]),
  "S66-seed-typed-status": known(["SEED-REJECTED"], [
    "final rowStatus.118: expected \"not-started\" actual null",
  ]),
  "S67-status-derived-from-git": known(["TRAILER-ROW"], [
    "call 5 exit: expected 0 actual 1",
  ]),
  "S68-check-unresolved-need-and-duplicate-id": known(["TRAILER-ROW"], [
    "call 1 offendingRowIds: expected [\"110\",\"119\"] actual [\"119\",\"110\",\"101\"]",
  ]),
  "S69-check-duplicate-merge": known(["TRAILER-ROW"], [
    "call 1 offendingRowIds: expected [\"110\"] actual [\"110\",\"101\"]",
  ]),
  "S70-check-trailer-unknown-row": known(["TRAILER-ROW"], [
    "call 1 offendingRowIds: expected [\"999\"] actual [\"999\",\"101\"]",
  ]),
  "S71-check-commit-claimed-twice": known(["TRAILER-ROW"], [
    "call 1 offendingRowIds: expected [\"096\",\"102\"] actual [\"101\",\"096\",\"102\"]",
  ]),
  "S73-check-pointer-not-merge": known(["TRAILER-ROW"], [
    "call 1 offendingRowIds: expected [\"096\"] actual [\"101\",\"096\"]",
  ]),
  "S75-no-forbidden-verbs-with-remote": known(["S8-TAIL"], [
    "call 2 step: expected \"render\" actual \"cleanup\"",
    "call 3 outcome: expected \"acted\" actual \"idle\"",
    "call 3 step: expected \"cleanup\" actual null",
    "call 3 row: expected \"110\" actual null",
  ]),
};

// ── fixture helpers ─────────────────────────────────────────────────────────────────────────────

function which(binary: any) {
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
    for (const ext of process.platform === 'win32' ? ['.exe', ''] : ['']) {
      const file = path.join(dir, binary + ext);
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
    }
  }
  throw new Error(`${binary} not found on PATH`);
}
const REAL_GIT = which('git');
const write = (file: any, bytes: any) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes); };
const fakeSha = (name: any) => createHash('sha1').update(`g-l1:${name}`).digest('hex');
const digestOf = (text: any) => `sha256:${sha256(text)}`;
const MARKER = '[NEEDS CLARIFICATION: open question]';
const DEFAULT_MERGES: any = [{ sha: 'M096', parents: 2, trailers: {} }, { sha: 'M101', parents: 2, trailers: { 'DoFlow-Row': '101' } }];

class CrashInjected extends Error {}

async function withPath(bin: any, fn: any) {
  const saved = process.env.PATH;
  process.env.PATH = bin;
  try { return await fn(); } finally { process.env.PATH = saved; }
}

function capture(fn: any): any {
  const lines: any = [];
  const log = console.log;
  const exitCode = process.exitCode;
  console.log = (...args) => lines.push(args.join(' '));
  try { const code = fn(); return { code, out: lines.join('\n') }; } finally { console.log = log; process.exitCode = exitCode; }
}

/** Builds the scenario's initial state into a scratch main checkout, develop worktree and config home. */
async function build(t: any, sc: any) {
  const init = sc.initial;
  const dir = tempDir(t, 'doflow-g-l1-');
  const root = path.join(dir, 'main');
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  const developDir = path.join(dir, 'fx-dev');
  for (const d of [root, home, bin]) fs.mkdirSync(d, { recursive: true });
  const gitVersion = init.git?.version;
  write(path.join(bin, 'git'), `#!/bin/sh\n${gitVersion ? `if [ "$1" = "--version" ]; then echo "git version ${gitVersion}"; exit 0; fi\n` : ''}exec "${shPath(REAL_GIT)}" "$@"\n`);
  fs.chmodSync(path.join(bin, 'git'), 0o755);
  // The feature resolver is a bash script: link the shell and the coreutils it needs, and nothing that
  // could answer a capability probe (no rg, no semble unless the scenario says a provider is healthy).
  // win32 cannot spawn a symlink named without .exe: the sandbox is the stubs plus Git for Windows' own tools (no rg, no semble).
  if (process.platform !== 'win32') for (const tool of ['bash', 'sh', 'env', 'cat', 'sed', 'awk', 'grep', 'dirname', 'basename', 'ls', 'tr', 'head', 'tail', 'sort', 'date', 'mkdir', 'readlink', 'realpath', 'cut', 'wc', 'uname', 'pwd', 'rm', 'mktemp', 'cp', 'mv', 'tee', 'xargs', 'find', 'printf', 'expr', 'id', 'whoami', 'hostname', 'jq', 'sleep', 'true', 'false', 'test', 'touch', 'chmod', 'stat', 'od', 'uniq', 'diff']) {
    try { fs.symlinkSync(which(tool), path.join(bin, tool)); } catch { /* absent on this system */ }
  }
  const probe = init.capabilitiesRegistry?.['code.semantic-search'];
  if (probe?.healthyProvider) { write(path.join(bin, 'semble'), '#!/bin/sh\nexit 0\n'); fs.chmodSync(path.join(bin, 'semble'), 0o755); }

  const toolPath = process.platform === 'win32' ? systemPath(bin) : bin;
  const env: any = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), FORCE_COLOR: '', PATH: toolPath,
    GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV, GIT_CONFIG_GLOBAL: os.devNull, GIT_AUTHOR_NAME: 'Fixture Owner', GIT_AUTHOR_EMAIL: 'owner@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture Owner', GIT_COMMITTER_EMAIL: 'owner@example.invalid', GIT_AUTHOR_DATE: '1792400000 +0000',
    GIT_COMMITTER_DATE: '1792400000 +0000', DOFLOW_FIXTURE_CANARY: 'canary-7f3a9-do-not-log' };
  delete env[SWITCH_ENV];
  const git = (cwd: any, ...args: any[]) => cp.execFileSync(REAL_GIT, ['-C', cwd, ...args], { env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  let clock = Date.parse('2026-10-19T00:00:00.000Z');
  const w: any = { dir, root, home, bin: toolPath, env, git, sc, sym: {}, fw: {}, dispatch: {}, lastPerform: null, lastCode: null,
    tick: () => new Date(clock += 1000), developDir, seedBefore: null };
  const sym = (name: any) => {
    if (name === undefined || name === null) return null;
    if (!w.sym[name]) w.sym[name] = fakeSha(name);
    return w.sym[name];
  };
  w.S = sym;
  w.runNext = (extra: any) => runNext(w, extra);

  // base commit: policy at develop's head (or absent / invalid), a package.json, files two rows can touch
  const policyBytes = fs.readFileSync(path.join(REPO, 'core/registry/gates.json'), 'utf8');
  const mergeMessage = (name: any, trailers: any) => [`merge ${name}`, ...(Object.keys(trailers || {}).length ? [Object.entries(trailers).map(([k, v]: any) => `${k}: ${v}`).join('\n')] : [])];
  // The base commit and the develop history are the same for every scenario that states the same policy
  // file, merges and commits, so they are built once per process and copied (test/helper/repo-template.ts).
  // A commit id is a function of its content, the fixed identity and the fixed date, so the copy is the
  // repository the build made, and the symbolic names map to the same ids in every scenario.
  const policy = init.policy;
  const policyKind = policy && policy.presentAtDevelopHead === false ? 'absent' : policy && policy.schemaValid === false ? 'invalid' : 'valid';
  const merges = init.git?.developFirstParentMerges ?? DEFAULT_MERGES;
  const commits = init.git?.commits ?? [];
  const history = repoFromTemplate(`g-l1:${JSON.stringify([policyKind, merges, commits])}`, root, (base: any) => {
    git(base, 'init', '-q', '-b', 'main');
    git(base, 'config', 'user.name', 'Fixture Owner');
    git(base, 'config', 'user.email', 'owner@example.invalid');
    git(base, 'config', 'core.hooksPath', '/dev/null');
    write(path.join(base, '.gitignore'), '.doflow/\nagent-docs/\n');
    write(path.join(base, 'package.json'), '{"name":"fixture","version":"1.0.0","scripts":{"test":"node --test"}}\n');
    write(path.join(base, 'shared.txt'), 'base\n');
    write(path.join(base, 'src/alpha/a.js'), 'base\n');
    write(path.join(base, 'notes/owner-wip.md'), 'owner notes\n');
    if (policyKind !== 'absent') write(path.join(base, 'core/registry/gates.json'), policyKind === 'invalid' ? '{"schema":1}\n' : policyBytes);
    git(base, 'add', '.');
    git(base, 'commit', '-qm', 'base');
    const baseTree = git(base, 'rev-parse', 'HEAD^{tree}');
    const make = (parents: any, ...messages: any[]) => git(base, 'commit-tree', baseTree, ...parents.flatMap((p: any) => ['-p', p]), ...messages.flatMap((m) => ['-m', m]));
    const syms: any = {};
    let tip = git(base, 'rev-parse', 'HEAD');
    for (const merge of merges) {
      const side = make([tip], `side of ${merge.sha}`);
      tip = make([tip, side], ...mergeMessage(merge.sha, merge.trailers));
      syms[merge.sha] = tip;
    }
    for (const commit of commits) {
      tip = make([tip], `commit ${commit.sha}`);
      syms[commit.sha] = tip;
    }
    git(base, 'update-ref', 'refs/heads/develop', tip);
    return { tree: baseTree, head: tip, syms };
  });
  const tree = history.tree;
  const commitTree = (parents: any, ...messages: any[]) => git(root, 'commit-tree', tree, ...parents.flatMap((p: any) => ['-p', p]), ...messages.flatMap((m) => ['-m', m]));
  Object.assign(w.sym, history.syms);
  const head = history.head;
  w.sym.D0 = head;
  const remote = init.git?.remote;
  if (remote && remote.url) git(root, 'remote', 'add', remote.name || 'origin', remote.url);
  if (init.git?.developWorktree !== null) {
    git(root, 'worktree', 'add', '-q', developDir, 'develop');
    const wanted = init.git?.developWorktree?.branch;
    if (wanted && wanted !== 'develop') {
      git(developDir, 'checkout', '-q', '-b', wanted);
      write(path.join(developDir, 'other.txt'), 'other\n');
      git(developDir, 'add', 'other.txt');
      git(developDir, 'commit', '-qm', 'other');
      w.sym[init.git.developWorktree.head] = git(developDir, 'rev-parse', 'HEAD');
    }
  }

  // seed (symbolic merge commits mapped to real ones; an in-flight hold becomes the seed hold)
  const holds: any = new Map((init.inFlight ?? []).filter((f: any) => f.hold).map((f: any) => [f.row, `${f.hold.state}: ${f.hold.reason}`]));
  w.seed = { schema: init.seed.schema, layout: init.seed.layout, rows: init.seed.rows.map((row: any) => {
    const copy: any = { ...row };
    if (copy.mergeCommit) copy.mergeCommit = sym(copy.mergeCommit);
    if (holds.has(copy.id)) copy.hold = holds.get(copy.id);
    return copy;
  }) };
  w.writeSeed = () => write(path.join(root, 'agent-docs/roadmap/rows.json'), JSON.stringify(w.seed));
  w.writeSeed();

  // kill switch layers
  const sw: any = { ...{
    env: init.store?.killSwitch?.['env.DOFLOW_AUTOPILOT'] ?? null,
    settings: init.store?.killSwitch ? init.store.killSwitch['settings.autopilot.enabled'] : true,
    sentinel: init.store?.killSwitch?.['sentinel.autopilot/off'] ?? false } };
  w.setSwitch = (name: any, value: any) => {
    const config = path.join(home, '.config/doflow');
    fs.mkdirSync(config, { recursive: true });
    if (name === 'env.DOFLOW_AUTOPILOT') { if (value === null) delete env[SWITCH_ENV]; else env[SWITCH_ENV] = String(value); }
    else if (name === 'settings.autopilot.enabled') {
      if (value === 'absent') fs.rmSync(path.join(config, 'settings.json'), { force: true });
      else write(path.join(config, 'settings.json'), JSON.stringify({ schema: 1, 'autopilot.enabled': value === true ? 'on' : 'off' }));
    } else if (name === 'sentinel.autopilot/off') {
      if (value) write(path.join(config, 'autopilot/off'), ''); else fs.rmSync(path.join(config, 'autopilot/off'), { force: true });
    } else throw new Error(`unmapped switch ${name}`);
  };
  w.setSwitch('env.DOFLOW_AUTOPILOT', sw.env);
  w.setSwitch('settings.autopilot.enabled', sw.settings);
  w.setSwitch('sentinel.autopilot/off', sw.sentinel);

  // policy override (plus the run record's step cap, which the loop reads from the policy)
  const override = policy?.override ? JSON.parse(JSON.stringify(policy.override)) : null;
  const cap = init.store?.runRecord?.maxSteps;
  const merged = cap ? { ...(override || {}), loop: { maxSteps: cap } } : override;
  if (merged) write(path.join(root, '.doflow/gates.override.json'), JSON.stringify(merged));

  // lease
  const lease = init.store?.lease;
  w.alive = undefined;
  if (lease) {
    write(path.join(root, '.doflow/state/roadmap/lease.json'), JSON.stringify({ schema: 1, pid: lease.pid, start: null,
      host: lease.host === 'this-host' ? require('node:os').hostname() : `${lease.host}.example`, runId: lease.runId.toLowerCase(), acquiredAt: '2026-10-19T00:00:00Z' }));
    const verdict = lease.liveness === 'alive' ? true : lease.liveness === 'dead' ? false : 'unknown';
    w.alive = () => verdict;
  }

  const orchFor = (entry: any) => new WorkflowOrchestrator({ repoRoot: REPO, projectRoot: entry.wt,
    stateDir: path.join(entry.wt, '.doflow/state/orchestration'), featureSlug: entry.slug, env, readinessEvaluate: () => 'READY' });
  w.orchFor = orchFor;
  w.featureDir = (entry: any) => path.join(entry.wt, 'agent-docs/doflow', entry.slug);
  w.handoff = (entry: any, skill: any) => orchFor(entry).handoff({ taskId: entry.slug, callingSkill: skill, note: 'stage work recorded', now: w.tick() });

  // in-flight rows: branch + worktree from D0, feature commit(s), artifacts, run position
  const featureCommit = (entry: any, name: any) => {
    const changes = (init.git?.featureChanges ?? []).map((c: any) => c.path);
    for (const file of changes.length ? changes : [`feature-${entry.id}.txt`]) write(path.join(entry.wt, file), `feature ${name}\n`);
    git(entry.wt, 'add', '-A');
    git(entry.wt, 'commit', '-qm', `feature ${name}`);
    w.sym[name] = git(entry.wt, 'rev-parse', 'HEAD');
  };
  w.featureCommit = featureCommit;
  for (const f of init.inFlight ?? []) {
    const slug = f.slug || f.branch.replace(/^feat\//, '');
    const id = f.row || slug.slice(0, 3);
    const entry: any = { id, slug, wt: path.join(dir, `main-${id}`), spec: f };
    w.fw[id] = entry;
    git(root, 'worktree', 'add', '-q', '-b', `feat/${slug}`, entry.wt, w.sym.D0);
    const first = f.gateBApprovedAtHead || f.featureHead;
    if (f.featureHead) featureCommit(entry, first);
  }
  const writeArtifacts = (entry: any): any => {
    const f = entry.spec;
    const a = f.artifacts;
    const row: any = w.seed.rows.find((r: any) => r.id === entry.id) || { writeSet: [] };
    const dirOf: any = w.featureDir(entry);
    if (!a) return;
    initRegister({ featureDir: dirOf, slug: entry.slug });
    const markers = (n: any) => Array.from({ length: n }, () => MARKER).join('\n');
    write(path.join(dirOf, 'intention/requirement.md'), `# Requirement\n${markers(a.requirementMarkers)}\n`);
    write(path.join(dirOf, 'design/design.md'), `# Design\n${markers(a.designMarkers)}\n${init.artifactExtras?.['design.md'] ? `\`\`\`\n${MARKER}\n\`\`\`\n` : ''}`);
    const first = row.writeSet?.[0] || 'x.txt';
    const file = first.endsWith('/') ? `${first}a.md` : first;
    write(path.join(dirOf, 'plan.md'), a.planParses
      ? `## Tasks\n- [ ] A.1 Build — owner: core-implementer; files: ${file}\n${markers(a.planMarkers)}\n`
      : '## Tasks\n- [ ] A.1 X — files: src/x.ts; depends-on: A.2\n- [ ] A.2 Y — files: src/y.ts; depends-on: A.1\n');
    if (f.verifyLog) {
      write(runRecordFile(entry.wt, entry.slug),
        f.verifyLog.map((line: any) => `${JSON.stringify({ schema: 1, taskId: entry.slug, head: sym(line.head), clean: line.clean, verdict: line.verdict, at: '2026-10-19T00:00:00Z' })}\n`).join(''));
    }
    if (f.findings && f.findings.present !== false) {
      const data = f.findings;
      const severity = (s: any) => (s === 'minor' ? 'note' : s);
      const decisions: any = [];
      const orphan = () => { if (!w.sym.__orphan) { const empty = git(root, 'hash-object', '-t', 'tree', '-w', '--stdin'); w.sym.__orphan = git(root, 'commit-tree', empty, '-m', 'unrelated'); } return w.sym.__orphan; };
      const body: any = { schema: 1, row: data.row, slug: data.slug, reviewedHead: sym(data.reviewedHead),
        seats: data.seats.map((s: any) => ({ id: s.seat, findings: s.findings.map((x: any) => ({ id: x.id, severity: severity(x.severity), locator: 'src/alpha/a.js:1', summary: 'finding' })) })),
        converged: data.converged.map((c: any) => {
          const out: any = { id: c.id, from: c.from, severity: severity(c.severity), status: c.disposition, locator: 'src/alpha/a.js:1' };
          if (c.disposition === 'fixed') out.fixedIn = c.fixedIn === 'ancestor-of-F110' ? w.sym.D0 : orphan();
          if (c.disposition === 'refuted' && c.evidence) out.evidence = c.evidence;
          if (c.disposition === 'user-accepted') {
            const m: any = /^DEC-\w+?-?(\d+) \(channel (\w+)\)$/.exec(c.userDecision || '');
            out.decision = `DEC-${m[1].padStart(3, '0')}`;
            decisions.push({ number: Number(m[1]), channel: m[2] === 'user' ? 'question' : 'default' });
          }
          return out;
        }) };
      if (data.schemaValid === false) delete body.seats[0].id;
      write(path.join(dirOf, 'review/findings.json'), JSON.stringify(body));
      for (const d of decisions) {
        for (let n = 1; n <= d.number; n += 1) {
          addDecisions({ featureDir: dirOf, slug: entry.slug, items: [{ topic: `fixture-${n}`, statement: `Fixture decision ${n}.`,
            channel: n === d.number ? d.channel : 'default', stage: 'review', rationale: 'fixture' }] });
        }
      }
    }
  };
  const positionRun = (entry: any) => {
    const o = entry.spec.orchestration;
    if (!o) return;
    const orch = orchFor(entry);
    orch.start({ taskId: entry.slug, taskClass: 'feature', now: w.tick() });
    const nodeId = o.gate || o.stage;
    const run = orch.readRun(entry.slug);
    run.cursor = run.program.findIndex((n: any) => n.id === nodeId);
    for (const node of run.program.slice(0, run.cursor)) node.status = node.type === 'gate' ? 'approved' : 'completed';
    run.state = run.program[run.cursor].type === 'gate' ? 'AWAITING_GATE' : 'RUNNING';
    orch.writeRun(run, w.tick());
  };
  // Out-of-band develop work lands before any gate decision, so a gate-b approval binds the heads it merges.
  if (init.git?.developChanges) {
    for (const c of init.git.developChanges) write(path.join(developDir, c.path), 'develop version\n');
    git(developDir, 'add', '-A');
    git(developDir, 'commit', '-qm', 'out of band');
  }
  for (const entry of Object.values(w.fw)) {
    writeArtifacts(entry);
    positionRun(entry);
    if (entry.spec.orchestration?.state === 'GATE_APPROVED') {
      const result = await withPath(bin, () => orchFor(entry).decideGate({ taskId: entry.slug, gateId: entry.spec.orchestration.gate, policy: entry.spec.orchestration.gate, now: w.tick() }));
      if (result.decision !== 'pass') throw new Error(`fixture: ${entry.spec.orchestration.gate} not approvable for ${entry.slug}: ${result.reasons}`);
    }
    if (entry.spec.gateBApprovedAtHead && entry.spec.featureHead) featureCommit(entry, entry.spec.featureHead);
    if (entry.spec.dispatch) w.dispatch[entry.slug] = { ...entry.spec.dispatch };
  }

  // merge crash: the open intent is made by the real merge being killed at the named phase
  const crash: any = init.crashPoint ? ({ CP1: 'intent', CP2: 'built', CP3: 'ff-done', CP4: 'rendered', CP5: 'rendered' } as any)[init.crashPoint]
    : init.store?.intent ? ({ intent: 'intent', committed: 'built' } as any)[init.store.intent.phase] : null;
  if (crash) {
    const mergeImpl = (o: any) => mergeRoadmapRow({ ...o, isEnabled: () => ({ enabled: true }), postMergeCheck: () => ({ ok: true }),
      onPhase: (phase: any) => { if (phase === crash) throw new CrashInjected(); } });
    try { await w.runNext({ mergeImpl }); throw new Error(`fixture: no merge reached phase ${crash}`); }
    catch (error) { if (!(error instanceof CrashInjected)) throw error; }
    const open = fs.readdirSync(path.join(root, '.doflow/state/roadmap/intents')).map((n: any) => JSON.parse(fs.readFileSync(path.join(root, '.doflow/state/roadmap/intents', n), 'utf8')));
    for (const intent of open) if (intent.commit) w.sym[init.store?.intent?.mergeCommit || `MX${intent.row}`] = intent.commit;
    if (init.crashPoint === 'CP5') git(root, 'worktree', 'remove', Object.values(w.fw)[0].wt);
  }

  // develop-side state
  const dw = init.git?.developWorktree;
  if (dw?.head && /^D\d+$/.test(dw.head) && dw.head !== 'D0') {
    write(path.join(developDir, `${dw.head}.txt`), 'advance\n');
    git(developDir, 'add', '-A');
    git(developDir, 'commit', '-qm', `advance ${dw.head}`);
    w.sym[dw.head] = git(developDir, 'rev-parse', 'HEAD');
  }
  if (!crash || !init.crashPoint) {
    for (const add of init.git?.developFirstParentMergesAdd ?? []) {
      if (crash) break;
      const current = git(root, 'rev-parse', 'refs/heads/develop');
      const rowId = add.trailers?.['DoFlow-Row'];
      const second: any = w.fw[rowId] ? git(root, 'rev-parse', `refs/heads/feat/${w.fw[rowId].slug}`) : commitTree([current], `side of ${add.sha}`);
      const created = commitTree([current, second], ...mergeMessage(add.sha, add.trailers));
      if (init.git?.developWorktree === null) git(root, 'update-ref', 'refs/heads/develop', created); else git(developDir, 'merge', '--ff-only', '-q', created);
      w.sym[add.sha] = created;
    }
  }
  for (const d of dw?.dirt ?? []) {
    if (d.state === 'modified') write(path.join(developDir, d.path), 'owner notes\nedited by the owner\n');
    else write(path.join(developDir, d.path), 'untracked\n');
  }
  for (const entry of Object.values(w.fw)) {
    for (const d of entry.spec.featureWorktreeDirt ?? []) write(path.join(entry.wt, d.path), 'wip\n');
  }
  // One for-each-ref answers every head the comparison reads: develop (which must exist) and each feature branch (null once gone).
  const headRefs = () => new Map(git(root, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads/').split('\n').filter(Boolean).map((line: any) => line.split(' ')));
  w.heads = () => {
    const refs = headRefs();
    if (!refs.has('refs/heads/develop')) throw new Error('fixture: refs/heads/develop is gone');
    return { develop: refs.get('refs/heads/develop'),
      features: Object.fromEntries(Object.values(w.fw).map((e) => [e.id, refs.get(`refs/heads/feat/${e.slug}`) ?? null])) };
  };
  w.branches = () => [...headRefs().keys()].map((ref: any) => ref.slice('refs/heads/'.length));
  w.before = w.heads();
  w.branchesBefore = w.branches();
  const developStatus = () => { try { return git(developDir, 'status', '--porcelain', '--untracked-files=all'); } catch { return null; } };
  w.developStatus = developStatus;
  w.statusBefore = developStatus();
  w.intentState = () => {
    const intents = path.join(root, '.doflow/state/roadmap/intents');
    return fs.existsSync(intents) ? fs.readdirSync(intents).sort().map((n: any) => `${n}:${fs.readFileSync(path.join(intents, n), 'utf8')}`).join('\n') : '';
  };
  w.intentsBefore = w.intentState();
  w.seedBefore = fs.readFileSync(path.join(root, 'agent-docs/roadmap/rows.json'), 'utf8');
  return w;
}

// ── dispatch facts and the loop call ────────────────────────────────────────────────────────────

/** The dispatch store reduced to the facts the loop reads (the dispatchFacts seam, as the E.3 tests use it). */
function dispatchFactsOf(d: any) {
  if (!d) return { state: 'none', pause: null };
  if (d.outcome === 'paused' || d.pausedBy === 'user') return { state: 'running', pause: { by: d.pausedBy ?? 'user', reason: d.reason ?? 'paused' } };
  if (d.outcome === 'resume-required') return { state: 'resume-required', pause: null };
  if (d.outcome === 'blocked') return { state: 'blocked', cause: null, repeated: false, pause: null };
  if (d.outcome === 'finished' && /repeated$/.test(d.finish || '')) return { state: 'blocked', cause: d.finish, repeated: true, pause: null };
  if (d.lastOutcome === 'failed' && d.attemptsUsed >= d.attemptBudget) return { state: 'blocked', cause: 'attempts-exhausted', repeated: false, pause: null };
  if (d.outcome === 'completed') return { state: 'completed', pause: null };
  return { state: 'none', pause: null };
}

async function runNext(w: any, extra: any = {}) {
  const out = await withPath(w.bin, () => next({ root: w.root, env: w.env, now: w.tick, alive: w.alive,
    dispatchFacts: (slug: any) => dispatchFactsOf(w.dispatch[slug]),
    resumeDigest: (slug: any) => ({ digest: digestOf(String(w.dispatch[slug]?.report ?? '')) }), ...extra }));
  w.lastCode = out.code;
  if (out.result.perform) w.lastPerform = out.result.perform;
  return out;
}

async function applyEvent(w: any, event: any) {
  const rowOfSlug = (slug: any) => {
    const known = Object.values(w.fw).find((e) => e.slug === slug);
    if (known) return known;
    const row = w.seed.rows.find((r: any) => r.slug === slug);
    return { id: row.id, slug, wt: path.join(w.dir, `main-${row.id}`), spec: {} };
  };
  switch (event.event) {
    case 'session-performs': {
      const perform = w.lastPerform;
      if (!perform || perform.stage !== event.stage) throw new Error(`fixture: no pending ${event.stage} perform (last: ${perform?.stage})`);
      const entry = rowOfSlug(perform.slug);
      const dirOf = perform.artifactRoot;
      const row = w.seed.rows.find((r: any) => r.id === entry.id);
      const first = row.writeSet?.[0] || 'x.txt';
      const featureHead = w.git(w.root, 'rev-parse', `refs/heads/feat/${entry.slug}`);
      if (event.stage === 'discovery') { initRegister({ featureDir: dirOf, slug: entry.slug }); write(path.join(dirOf, 'intention/requirement.md'), '# Requirement\nwritten\n'); }
      else if (event.stage === 'design') write(path.join(dirOf, 'design/design.md'), '# Design\nwritten\n');
      else if (event.stage === 'planning') write(path.join(dirOf, 'plan.md'), `## Tasks\n- [ ] A.1 Build — owner: core-implementer; files: ${first.endsWith('/') ? `${first}a.md` : first}\n`);
      else if (event.stage === 'verification') write(runRecordFile(entry.wt, entry.slug),
        `${JSON.stringify({ schema: 1, taskId: entry.slug, head: featureHead, clean: true, verdict: 'PASS', at: w.tick().toISOString() })}\n`);
      else if (event.stage === 'review') write(path.join(dirOf, 'review/findings.json'), JSON.stringify({ schema: 1, row: entry.id, slug: entry.slug, reviewedHead: featureHead,
        seats: [{ id: 'backend-expert', findings: [] }, { id: 'principle-software-engineer', findings: [] }], converged: [] }));
      else throw new Error(`fixture: unmapped stage ${event.stage}`);
      w.handoff(entry, perform.skill || SKILL_OF_STAGE[event.stage]);
      return;
    }
    case 'dispatch-finishes': {
      const entry = rowOfSlug(event.slug);
      w.featureCommit(entry, event.featureHead);
      delete w.dispatch[event.slug];
      w.handoff(entry, 'do-execute-plan');
      return;
    }
    case 'owner-edits': {
      const entry = Object.values(w.fw)[0];
      write(path.join(w.featureDir(entry), 'intention/requirement.md'), '# Requirement\nresolved\n');
      return;
    }
    case 'hold-row': {
      const row = w.seed.rows.find((r: any) => r.id === event.row);
      row.hold = `${event.hold.state}: ${event.hold.reason}`;
      w.writeSeed();
      return;
    }
    case 'set-switch': w.setSwitch(event.switch, event.value); return;
    case 'clear-switch': w.setSwitch(event.switch, event.switch.startsWith('settings') ? true : event.switch.startsWith('env') ? null : false); return;
    case 'report-edited': { const slug = Object.keys(w.dispatch)[0]; w.dispatch[slug].report = event.report; return; }
    case 'session-does-nothing': return;
    case 'owner-merges': {
      const current = w.git(w.root, 'rev-parse', 'refs/heads/develop');
      const rowId = event.trailers?.['DoFlow-Row'];
      const entry = w.fw[rowId];
      const second = entry ? w.git(w.root, 'rev-parse', `refs/heads/feat/${entry.slug}`) : current;
      const created = w.git(w.root, 'commit-tree', w.git(w.root, 'rev-parse', `${current}^{tree}`), '-p', current, '-p', second, '-m', `merge ${event.sha}`, '-m', `DoFlow-Row: ${rowId}`);
      w.git(w.developDir, 'merge', '--ff-only', '-q', created);
      w.sym[event.sha] = created;
      return;
    }
    default: throw new Error(`fixture: unmapped event ${event.event}`);
  }
}

// ── running a scenario and comparing ────────────────────────────────────────────────────────────

const show = (value: any) => JSON.stringify(value === undefined ? null : value);

/** Runs the scenario and returns the list of differences from the expected entry (empty: matches). */
async function runScenario(t: any, sc: any, expected: any) {
  const w: any = await build(t, sc);
  const diffs: any = [];
  const calls: any = [];
  let previousRender = null;
  for (const [index, step] of sc.steps.entries()) {
    for (const event of step.before ?? []) await applyEvent(w, event);
    const want = expected.calls[index];
    const action = step.action || 'next';
    const label = `call ${index + 1}`;
    if (action === 'next') {
      const extra = step.inject ? { mergeImpl: (o: any) => mergeRoadmapRow({ ...o, onPhase: (phase: any) => { if (phase === 'built') w.setSwitch(step.inject.switch, step.inject.value); } }) } : {};
      let { result } = await runNext(w, extra);
      // The oracle predates amendment P1 (post-merge verification): answer that perform as the session
      // would, with the PASS line the loop reads back, and call again without using an expected call.
      for (let guard = 0; result.outcome === 'perform' && result.perform.purpose === 'post-merge' && guard < 3; guard += 1) {
        write(runRecordFile(result.perform.worktree, result.perform.slug),
          `${JSON.stringify({ schema: 1, taskId: result.perform.slug, head: result.perform.head, clean: true, verdict: 'PASS', at: w.tick().toISOString(), reportSha256: `sha256:${'e'.repeat(64)}` })}\n`);
        ({ result } = await runNext(w));
      }
      calls.push(result);
      for (const field of ['outcome', 'step', 'row', 'reason']) {
        if (want[field] !== result[field]) diffs.push(`${label} ${field}: expected ${show(want[field])} actual ${show(result[field])}`);
      }
      if (want.skips !== undefined) {
        // expected.json: skips are a map of not-started row id -> skip reason, so the loop's entries for merged, held or in-flight rows are out of scope.
        const { out } = await withPath(w.bin, () => capture(() => handleRoadmapCommand({ action: 'status', json: true, root: w.root })));
        const status = JSON.parse(out).rowStatus || {};
        const actual = sortKeys(Object.fromEntries(Object.entries(result.skips ?? {}).filter(([id]: any) => status[id] === 'not-started')));
        if (JSON.stringify(sortKeys(want.skips)) !== JSON.stringify(actual)) diffs.push(`${label} skips: expected ${show(sortKeys(want.skips))} actual ${show(actual)}`);
      }
    } else {
      const flags = action === 'render --check' ? { action: 'render', check: true } : { action };
      const { code, out } = await withPath(w.bin, () => capture(() => handleRoadmapCommand({ ...flags, json: true, root: w.root })));
      let json: any = {};
      try { json = JSON.parse(out); } catch { /* reported below */ }
      if (action === 'status') {
        for (const [id, status] of Object.entries(want.rowStatus ?? {})) {
          if (json.rowStatus?.[id] !== status) diffs.push(`${label} rowStatus.${id}: expected ${show(status)} actual ${show(json.rowStatus?.[id])}`);
        }
      }
      if (want.fileWrites !== undefined && json.fileWrites !== want.fileWrites) diffs.push(`${label} fileWrites: expected ${show(want.fileWrites)} actual ${show(json.fileWrites)}`);
      if (want.exit !== undefined && code !== want.exit) diffs.push(`${label} exit: expected ${show(want.exit)} actual ${show(code)}`);
      if (want.offendingRowIds !== undefined && JSON.stringify([...(json.offendingRowIds ?? [])].sort()) !== JSON.stringify([...want.offendingRowIds].sort())) {
        diffs.push(`${label} offendingRowIds: expected ${show(want.offendingRowIds)} actual ${show(json.offendingRowIds)}`);
      }
      if (want.outputByteEqualToPrevious) {
        const same = previousRender !== null && out.replace(/"fileWrites":\d/, '') === previousRender.replace(/"fileWrites":\d/, '');
        if (!same) diffs.push(`${label} outputByteEqualToPrevious: expected true actual false`);
      }
      if (action === 'render') previousRender = out;
      calls.push({ action, json, code });
    }
  }
  diffs.push(...(await finalDiffs(w, expected.final ?? {}, calls)));
  return diffs;
}

function sortKeys(object: any) {
  return Object.fromEntries(Object.entries(object).sort(([a]: any, [b]: any) => (a < b ? -1 : 1)));
}

/** Final facts the driver can check mechanically; the keys it cannot are counted in UNREACHED_FINAL. */
const UNREACHED_FINAL: any = new Set();
async function finalDiffs(w: any, final: any, calls: any): Promise<any> {
  const diffs: any = [];
  const check = (key: any, expected: any, actual: any) => { if (JSON.stringify(expected) !== JSON.stringify(actual)) diffs.push(`final ${key}: expected ${show(expected)} actual ${show(actual)}`); };
  const heads = w.heads();
  const commit = (sha: any) => w.git(w.root, 'cat-file', '-p', sha);
  for (const [key, value] of Object.entries(final)) {
    switch (key) {
      case 'rowStatus': {
        const { out } = await withPath(w.bin, () => capture(() => handleRoadmapCommand({ action: 'status', json: true, root: w.root })));
        const rows = JSON.parse(out).rowStatus || {};
        for (const [id, status] of Object.entries(value)) check(`rowStatus.${id}`, status, rows[id]);
        break;
      }
      case 'developHead': {
        if (typeof value === 'string') { check('developHead', w.sym[value] ?? `unmapped:${value}`, heads.develop); break; }
        const body = commit(heads.develop);
        const parents = [...body.matchAll(/^parent (\w+)$/gm)].map((m) => m[1]);
        check('developHead.parents', value.parents, parents.length);
        if (value.firstParent) check('developHead.firstParent', value.firstParent === 'D0' ? w.sym.D0 : w.S(value.firstParent), parents[0]);
        if (value.secondParent) check('developHead.secondParent', w.sym[value.secondParent], parents[1]);
        if (value.trailers) check('developHead.trailers', value.trailers, Object.fromEntries([...body.matchAll(/^(DoFlow-Row): (.+)$/gm)].map((m) => [m[1], m[2]])));
        const person = (kind: any) => (new RegExp(`^${kind} (.+?) \\d+ [+-]\\d{4}$`, 'm').exec(body) || [])[1];
        if (value.author) check('developHead.author', value.author, person('author'));
        if (value.committer) check('developHead.committer', value.committer, person('committer'));
        break;
      }
      case 'developHeadParents': check('developHeadParents', value, [...commit(heads.develop).matchAll(/^parent /gm)].length); break;
      case 'mergesWithTrailer110': check('mergesWithTrailer110', value, Number(w.git(w.root, 'rev-list', '--first-parent', '--merges', '--grep=^DoFlow-Row: 110$', '--count', 'refs/heads/develop'))); break;
      case 'developHeadBeforeEqualsAfter': check('developHeadBeforeEqualsAfter', value, w.before.develop === heads.develop); break;
      case 'featureHeadBeforeEqualsAfter': check('featureHeadBeforeEqualsAfter', value, JSON.stringify(w.before.features) === JSON.stringify(heads.features)); break;
      case 'branchesCreated': check('branchesCreated', value, w.branches().filter((b: any) => !w.branchesBefore.includes(b)).length); break;
      case 'merges': check('merges', value, Number(w.git(w.root, 'rev-list', '--first-parent', '--merges', '--count', 'refs/heads/develop')) - 2); break;
      case 'tagsCreated': check('tagsCreated', value, w.git(w.root, 'tag', '--list').split('\n').filter(Boolean).length); break;
      case 'seedFileEdits': check('seedFileEdits', value, fs.readFileSync(path.join(w.root, 'agent-docs/roadmap/rows.json'), 'utf8') === w.seedBefore ? 0 : 1); break;
      case 'developWorktreeStatusByteEqual': check('developWorktreeStatusByteEqual', value, w.statusBefore === w.developStatus()); break;
      case 'MERGE_HEAD': check('MERGE_HEAD', value, fs.existsSync(w.developDir) && fs.existsSync(w.git(w.developDir, 'rev-parse', '--git-path', 'MERGE_HEAD')) ? 'present' : 'absent'); break;
      case 'mergeStarted': { // started = an intent at ff-started or later (intent and built have moved nothing)
        const dirI = path.join(w.root, '.doflow/state/roadmap/intents');
        const late = fs.existsSync(dirI) && fs.readdirSync(dirI).some((n: any) => ['ff-started', 'ff-done', 'rendered', 'cleaned'].includes(JSON.parse(fs.readFileSync(path.join(dirI, n), 'utf8')).phase));
        check('mergeStarted', value, late || w.before.develop !== heads.develop);
        break;
      }
      case 'tableWritten': check('tableWritten', value, fs.existsSync(path.join(w.root, 'agent-docs/roadmap/ROADMAP.md'))); break;
      case 'exitCode': check('exitCode', value, w.lastCode); break;
      case 'remoteRefsChanged': case 'pushes': case 'publishes': case 'globalInstalls': case 'permissionRuleEdits': case 'settingsWrites':
        // The loop spawns only allow-listed git verbs (G53); no push or remote ref exists to change here.
        UNREACHED_FINAL.add(key); break;
      default: UNREACHED_FINAL.add(key);
    }
  }
  return diffs;
}

// ── the driver ──────────────────────────────────────────────────────────────────────────────────

const oracle: any = {
  scenarios: JSON.parse(fs.readFileSync(SCENARIOS_FILE, 'utf8')).scenarios,
  expected: JSON.parse(fs.readFileSync(EXPECTED_FILE, 'utf8')).scenarios,
};

test('the oracle files are byte-identical to the frozen A.2 copies (sha256.txt)', () => {
  assert.equal(sha256(fs.readFileSync(SCENARIOS_FILE)), ORACLE_SHA256.scenarios);
  assert.equal(sha256(fs.readFileSync(EXPECTED_FILE)), ORACLE_SHA256.expected);
});

test('every scenario has an expected entry with one call per step, and every known mismatch names a real scenario', () => {
  const ids = oracle.scenarios.map((s: any) => s.id);
  assert.deepEqual(Object.keys(oracle.expected), ids);
  for (const sc of oracle.scenarios) assert.equal(oracle.expected[sc.id].calls.length, sc.steps.length, sc.id);
  for (const [id, entry] of Object.entries(KNOWN_MISMATCHES)) {
    assert.ok(ids.includes(id), `known mismatch ${id} is not a scenario`);
    assert.ok(Array.isArray(entry.diffs) && entry.diffs.length > 0 && entry.tags.length > 0 && entry.tags.every((tag: any) => tag in GROUPS), `${id} needs diffs and a ruling group`);
  }
});

for (const sc of oracle.scenarios) {
  test(`G-L1 ${sc.id}`, async (t) => {
    const diffs = await runScenario(t, sc, oracle.expected[sc.id]);
    const known: any = KNOWN_MISMATCHES[sc.id];
    if (!known) { assert.deepEqual(diffs, [], `${sc.id} differs from the oracle; report it as a finding, never edit the oracle`); return; }
    assert.notDeepEqual(diffs, [], `${sc.id} now matches the oracle: remove it from KNOWN_MISMATCHES`);
    assert.deepEqual(diffs, known.diffs, `${sc.id} differs from its recorded finding`);
  });
}

test('control: one changed byte in a scratch copy of expected.json turns the driver red', async (t) => {
  const bytes = fs.readFileSync(EXPECTED_FILE, 'utf8');
  assert.equal(sha256(bytes), ORACLE_SHA256.expected);
  const scratch = bytes.replace('"reason": null', '"reason": nulL');
  assert.notEqual(scratch, bytes);
  assert.notEqual(sha256(scratch), ORACLE_SHA256.expected, 'the byte check sees the change');
  const sc: any = oracle.scenarios.find((s: any) => !KNOWN_MISMATCHES[s.id]);
  assert.ok(sc, 'at least one scenario matches the oracle');
  const copy = JSON.parse(JSON.stringify(oracle.expected[sc.id]));
  assert.deepEqual(await runScenario(t, sc, copy), []);
  copy.calls[0].outcome = `${copy.calls[0].outcome}!`;
  assert.notDeepEqual(await runScenario(t, sc, copy), [], 'a changed expectation is a difference the driver reports');
});

test('diagnostic: final-state keys the driver cannot check mechanically are reported as unreached', (t) => {
  t.diagnostic(`unreached final keys: ${[...UNREACHED_FINAL].sort().join(', ')}`);
});
