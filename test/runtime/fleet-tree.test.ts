'use strict';

// Row 093 V.5 (IC-020): `doflow fleet --action tree` builds one project's agent hierarchy from DoFlow records and
// the harnesses' own sub-agent records, with no write. Scratch HOME and config home hold V.2's synthetic
// transcript fixtures (copied to where each harness keeps them), real git repositories, hand-written
// hook observations and run stores. Nodes merge only on a shared key; every edge names its record.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { V8_ROOT, LOCATION_ROOTS } = require('../fixtures/transcripts/v8/scan.ts');
const { cwdHash } = require('../../src/runtime/context/identity.ts');
const { clearCheckoutCache } = require('../../src/runtime/checkouts.ts');
const { buildTree } = require('../../src/runtime/fleet/tree.ts');
const { handleFleetCommand } = require('../../src/runtime/fleet/command.ts');

const REPO = path.resolve(__dirname, '../..');
const CLI = path.join(REPO, 'bin', 'doflow.js');
const ID = 'fa000000-0000-4000-8000-00000000';
const sha16 = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const AK = (harness: string, ...rest: string[]) => sha16([harness, ...rest].join(':'));

function git(cwd: string, ...args: string[]) {
  const r = spawnSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV },
  });
  assert.equal(r.status, 0, r.stderr);
}

function repo(dir: string) {
  fs.mkdirSync(path.join(dir, '.doflow', 'state'), { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'first');
}

// Windows: PATH is already the runner's (node and Git for Windows are on it) and uses ';', os.homedir() reads USERPROFILE,
// the temp folder comes from TEMP/TMP rather than TMPDIR, and a spawn with a stripped environment still needs SystemRoot.
const WIN = process.platform === 'win32';
const winEnv = (home: string, tmp?: string): any => (WIN ? { USERPROFILE: home, SystemRoot: process.env.SystemRoot, windir: process.env.windir, ...(tmp ? { TEMP: tmp, TMP: tmp } : {}) } : {});

function env(f: any): any {
  return {
    HOME: f.home, ...winEnv(f.home), XDG_CONFIG_HOME: f.config, PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    DOFLOW_FAILURE_CAPTURE: 'off', DOFLOW_TELEMETRY: 'off', CLAUDE_CONFIG_DIR: '', CODEX_HOME: '', COPILOT_HOME: '', PI_CODING_AGENT_SESSION_DIR: '',
  };
}

/** A session as the hooks leave it: a model observation at the checkout and a session directory with its git context. */
function session(f: any, harness: string, rawId: string, cwd: string, model = `${harness}-fixture-1`) {
  const top = fs.realpathSync(cwd);
  const dir = path.join(f.store, 'primary', cwdHash(top), harness);
  fs.mkdirSync(dir, { recursive: true });
  const observedAt = new Date(Date.now() - 60000).toISOString();
  fs.writeFileSync(path.join(dir, `${sha16(rawId)}.json`), JSON.stringify({ schema: 1, harness, model, event: 'SessionStart', observedAt, session: sha16(rawId) }));
  const sdir = path.join(f.store, 'sessions', rawId);
  fs.mkdirSync(sdir, { recursive: true });
  fs.writeFileSync(path.join(sdir, 'git-context.json'), JSON.stringify({ cwd: top, captured_at: observedAt, branch: 'main' }));
}

function writeStore(f: any, dir: string, slug: string, data: any) {
  const d = path.join(f.main, '.doflow', 'state', dir);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, `${slug}.json`), JSON.stringify(data));
}

function world(t: any, { fixtures = true } = {}) {
  clearCheckoutCache();
  const root = tempDir(t, 'doflow-fleet-tree-');
  const f: any = { root, home: path.join(root, 'home'), config: path.join(root, 'config'), main: path.join(root, 'proj'), other: path.join(root, 'other') };
  f.store = path.join(f.config, 'doflow', 'session-env');
  fs.mkdirSync(f.home);
  fs.mkdirSync(f.store, { recursive: true });
  repo(f.main);
  repo(f.other);
  if (fixtures) {
    for (const [harness, parts] of Object.entries(LOCATION_ROOTS) as Array<[string, string[]]>) {
      const target = path.join(f.home, ...parts);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(V8_ROOT, harness), target, { recursive: true });
    }
    // Pi keeps its files under the encoded cwd: move the fixture directory to this project's.
    const piRoot = path.join(f.home, ...LOCATION_ROOTS.pi);
    fs.renameSync(path.join(piRoot, '--work-fixture-project--'), path.join(piRoot, `--${fs.realpathSync(f.main).replace(/^[\\/]/, '').replace(/[\\/:]/g, '-')}--`));
  }
  return f;
}

/** The sessions of the main scenario: one per harness, a missing transcript, a second project's session. */
function scenario(f: any) {
  session(f, 'claude', `${ID}c001`, f.main);
  session(f, 'codex', `${ID}d001`, f.main);
  session(f, 'pi', `${ID}a001`, f.main);
  session(f, 'kiro', `${ID}e001`, f.main);
  session(f, 'copilot', `${ID}f001`, f.main);
  session(f, 'antigravity', `${ID}b001`, f.main);
  session(f, 'opencode', `${ID}0c00`, f.main);
  session(f, 'claude', `${ID}c0aa`, f.main); // no file anywhere
  session(f, 'claude', `${ID}c0f2`, f.other); // the second project's session (its transcript fixture exists)
}

function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = path.join(dir, name);
      const info = fs.lstatSync(file, { bigint: true });
      const rel = path.relative(root, file);
      if (info.isDirectory()) { out[rel] = `dir ${info.mtimeNs}`; visit(file); } else out[rel] = `${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')} ${info.mtimeNs}`;
    }
  };
  visit(root);
  return out;
}

const tree = (f: any, opts: any = {}) => {
  clearCheckoutCache();
  const built = buildTree({ env: env(f), cwd: f.main, ...opts });
  assert.equal(built.ok, true);
  return built.body;
};
const byKey = (body: any, key: string) => body.nodes.find((n: any) => n.agentKey === key);
const edgesOf = (body: any, basis: string) => body.edges.filter((e: any) => e.basis === basis);

test('every harness gives its main session and its sub-agents, joined by session id, with edges named by record', (t) => {
  const f = world(t);
  scenario(f);
  const body = tree(f);
  assert.deepEqual(Object.keys(body), ['v', 'projectKey', 'nodes', 'edges', 'limits', 'unreadable']);
  assert.equal(body.projectKey, cwdHash(fs.realpathSync(f.main)));
  const claude = byKey(body, AK('claude', `${ID}c001`));
  const [afx1, afx2] = ['afx1', 'afx2'].map((id) => byKey(body, AK('claude', `${ID}c001`, id)));
  assert.deepEqual([claude.kind, claude.label, claude.depth, claude.model, claude.modelBasis], ['main-session', null, 0, 'claude-fixture-1', 'hook-observation']);
  assert.deepEqual([afx1.kind, afx1.label, afx1.depth, afx1.modelBasis], ['harness-subagent', 'fixture-explorer', 1, 'harness-record']);
  assert.deepEqual([afx2.label, afx2.depth], ['fixture-reviewer', 2]);
  const edges = edgesOf(body, 'harness-subagent-record').map((e: any) => `${e.from}>${e.to}`);
  assert.ok(edges.includes(`${claude.agentKey}>${afx1.agentKey}`) && edges.includes(`${afx1.agentKey}>${afx2.agentKey}`), 'depth 2 hangs under the depth-1 file that holds its tool_use id');
  const codexSub = byKey(body, AK('codex', `${ID}d002`));
  assert.deepEqual([codexSub.kind, codexSub.label, codexSub.depth], ['harness-subagent', 'fixture-worker', 1]);
  assert.ok(edges.includes(`${AK('codex', `${ID}d001`)}>${codexSub.agentKey}`));
  const piChild = byKey(body, AK('pi', `${ID}a002`));
  assert.equal(piChild.kind, 'harness-subagent');
  assert.ok(edges.includes(`${AK('pi', `${ID}a001`)}>${piChild.agentKey}`));
  const copilotSub = byKey(body, AK('copilot', `${ID}f001`, 'agent-fx-1'));
  assert.deepEqual([copilotSub.label, copilotSub.depth], ['fixture-agent', 1]);
  assert.ok(edges.includes(`${AK('copilot', `${ID}f001`)}>${copilotSub.agentKey}`));
  assert.equal(edges.length, 5, 'claude 2, codex 1, pi 1, copilot 1');
  assert.ok(body.edges.every((e: any) => ['harness-subagent-record', 'worker-caller', 'worker-childOf', 'attempt-runKey', 'dispatch-claim'].includes(e.basis)));
  // Kiro: a main session whose companion names no parent.
  assert.equal(byKey(body, AK('kiro', `${ID}e001`)).transcript.linked, true);
  assert.equal(body.nodes.length, 13);
  assert.equal(body.unreadable, 0);
});

test('transcript reasons: linked, no-reader, not-linked, not-found', (t) => {
  const f = world(t);
  scenario(f);
  const body = tree(f);
  const tr = (harness: string, id: string) => byKey(body, AK(harness, id)).transcript;
  assert.deepEqual(tr('claude', `${ID}c001`), { reader: 'claude-jsonl', linked: true, reason: null });
  assert.deepEqual(tr('claude', `${ID}c0aa`), { reader: 'claude-jsonl', linked: false, reason: 'not-found' });
  assert.deepEqual(tr('antigravity', `${ID}b001`), { reader: null, linked: false, reason: 'not-linked' });
  assert.deepEqual(tr('opencode', `${ID}0c00`), { reader: null, linked: false, reason: 'no-reader' });
  for (const [h, id, reader] of [['codex', 'd001', 'codex-rollout'], ['pi', 'a001', 'pi-jsonl'], ['kiro', 'e001', 'kiro-jsonl'], ['copilot', 'f001', 'copilot-events']]) {
    assert.deepEqual(tr(h, `${ID}${id}`), { reader, linked: true, reason: null }, h);
  }
});

test('labels come only from records: no lead, no invented role', (t) => {
  const f = world(t);
  scenario(f);
  const body = tree(f);
  const labels = body.nodes.map((n: any) => n.label).filter(Boolean).sort();
  assert.deepEqual(labels, ['fixture-agent', 'fixture-explorer', 'fixture-reviewer', 'fixture-worker']);
  assert.ok(!JSON.stringify(body).toLowerCase().includes('lead'));
  assert.ok(body.nodes.filter((n: any) => n.kind === 'main-session').every((n: any) => n.label === null));
});

test('a second project\'s session and every raw id, path and transcript text stay out of the body', (t) => {
  const f = world(t);
  scenario(f);
  const body = tree(f);
  assert.equal(byKey(body, AK('claude', `${ID}c0f2`)), undefined);
  const json = JSON.stringify(body);
  for (const needle of ['fa000000', f.root, '/work/fixture-project', 'FIXTURE-', 'fx-Secret', 'example.invalid', 'c0f2']) assert.ok(!json.includes(needle), needle);
  for (const n of body.nodes) assert.match(n.agentKey, /^[0-9a-f]{16}$/);
});

function workers(f: any) {
  const base = { task: 'A.1', seq: 1, startedAt: '2026-01-01T00:00:00.000Z', caller: { runKey: 'wk1/run1/lin1', run: 'run1', lineage: 'lin1' } };
  writeStore(f, 'worker-runs', 'feat', {
    slug: 'feat', runs: {
      'w-aaaaaaaaaaaa': { ...base, runId: 'w-aaaaaaaaaaaa', token: 1, harness: 'codex', phase: 'ended', binding: { model: 'gpt-fixture-1' }, end: { state: 'exited', at: '2026-01-01T00:05:00.000Z' }, childOf: null },
      'w-bbbbbbbbbbbb': { ...base, runId: 'w-bbbbbbbbbbbb', token: 1, harness: 'codex', phase: 'running', binding: { model: 'gpt-fixture-1' }, startedAt: '2026-01-01T00:06:00.000Z', childOf: 'w-aaaaaaaaaaaa', supervisor: { pid: 1, start: 'x' } },
      'w-cccccccccccc': { ...base, runId: 'w-cccccccccccc', token: 2, harness: 'codex', phase: 'running', binding: { model: 'gpt-fixture-1' }, startedAt: '2026-01-01T00:07:00.000Z', childOf: null, supervisor: { pid: 2, start: 'x' } },
    },
  });
  writeStore(f, 'task-attempts', 'feat', {
    slug: 'feat', tasks: { 'A.1': { attempts: [{ token: 1, owner: 'fixture-owner', mode: 'sequential', state: 'active', startedAt: '2026-01-01T00:00:00.000Z', runKey: 'wk1/run1/lin1' }] } },
  });
}

test('worker runs: caller and childOf edges, ended, the process check, runs merged only on their key', (t) => {
  const f = world(t);
  scenario(f);
  workers(f);
  const probed: number[] = [];
  const body = tree(f, { alive: (proc: any) => { if (!proc) return 'unknown'; probed.push(proc.pid); return proc.pid === 1; } });
  const w = (id: string) => byKey(body, sha16(`worker:${id}`));
  const [a, b, c] = ['w-aaaaaaaaaaaa', 'w-bbbbbbbbbbbb', 'w-cccccccccccc'].map(w);
  assert.deepEqual([a.kind, b.kind, c.kind], ['worker-run', 'child-worker-run', 'worker-run']);
  assert.deepEqual(a.ended, { at: '2026-01-01T00:05:00.000Z', result: 'exited' });
  assert.equal(b.ended, null);
  assert.deepEqual([a.model, a.modelBasis, a.harness], ['gpt-fixture-1', 'worker-binding', 'codex']);
  const run = byKey(body, sha16('doflow:wk1/run1/lin1'));
  assert.deepEqual([run.kind, run.label, run.depth], ['doflow-run', 'fixture-owner', 0]);
  assert.deepEqual(edgesOf(body, 'worker-childOf'), [{ from: a.agentKey, to: b.agentKey, basis: 'worker-childOf' }]);
  assert.deepEqual(edgesOf(body, 'worker-caller').map((e: any) => `${e.from}>${e.to}`).sort(), [`${run.agentKey}>${a.agentKey}`, `${run.agentKey}>${c.agentKey}`].sort());
  assert.deepEqual([a.liveness, b.liveness, c.liveness], ['not-checked', 'process-seen', 'not-checked'], 'ended runs are not checked; one false and one unknown stays unchecked');
  assert.deepEqual(probed.sort(), [1, 2], 'only the not-ended runs were probed (supervisor; the missing worker process is unknown)');
  // No-merge: three runs of one harness and one model are three nodes, and two attempts' runs stay one node per runKey.
  assert.equal(body.nodes.filter((n: any) => n.kind === 'worker-run' || n.kind === 'child-worker-run').length, 3);
  assert.equal(body.nodes.filter((n: any) => n.kind === 'doflow-run').length, 1);
  assert.ok(!JSON.stringify(body).includes('w-aaaa') && !JSON.stringify(body).includes('wk1/run1'));
});

test('no-merge: sessions and runs of one harness and model stay separate nodes', (t) => {
  const f = world(t, { fixtures: false });
  session(f, 'claude', `${ID}c001`, f.main, 'same-model-1');
  session(f, 'claude', `${ID}c002`, f.main, 'same-model-1');
  workers(f);
  const body = tree(f);
  const mains = body.nodes.filter((n: any) => n.kind === 'main-session');
  assert.equal(mains.length, 2);
  assert.notEqual(mains[0].agentKey, mains[1].agentKey);
  assert.deepEqual(mains.map((n: any) => n.model), ['same-model-1', 'same-model-1']);
  assert.equal(body.nodes.filter((n: any) => n.harness === 'codex').length, 3);
});

test('the dispatch snapshot gives the run its harness and model and a dispatch-claim edge to the dispatched worker', (t) => {
  const f = world(t, { fixtures: false });
  workers(f);
  writeStore(f, 'dispatch', 'feat', { slug: 'feat', dispatches: { 'd-aaaaaaaaaaaa': { task: 'A.1', token: 2, phase: 'claimed', parentRunKey: 'wk1/run1/lin1', primary: { harness: 'claude', model: 'lead-model-1', state: 'observed' } } } });
  const body = tree(f, { alive: () => 'unknown' });
  const run = byKey(body, sha16('doflow:wk1/run1/lin1'));
  assert.deepEqual([run.harness, run.model, run.modelBasis], ['claude', 'lead-model-1', 'dispatch-snapshot']);
  assert.deepEqual(edgesOf(body, 'dispatch-claim'), [{ from: run.agentKey, to: sha16('worker:w-cccccccccccc'), basis: 'dispatch-claim' }]);
});

test('bounds: 64 sessions, 256 nodes and 16 process checks, the rest counted in notChecked', (t) => {
  const f = world(t, { fixtures: false });
  for (let i = 0; i < 70; i++) session(f, 'claude', `bound-session-${String(i).padStart(3, '0')}`, f.main);
  const body = tree(f);
  assert.equal(body.nodes.filter((n: any) => n.kind === 'main-session').length, 64);
  assert.equal(body.limits.notChecked, 6);
  assert.equal(body.limits.nodes, 256);

  const g = world(t, { fixtures: false });
  const runs: any = {};
  for (let i = 0; i < 300; i++) {
    const id = `w-${i.toString(16).padStart(12, '0')}`;
    runs[id] = { runId: id, task: 'A.1', token: i + 1, seq: 1, harness: 'codex', phase: i < 20 ? 'running' : 'ended', startedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 300 - i)).toISOString(), childOf: null, supervisor: { pid: 10 + i, start: 'x' } };
  }
  writeStore(g, 'worker-runs', 'big', { slug: 'big', runs });
  let probes = 0;
  const big = tree(g, { alive: () => { probes += 1; return 'unknown'; } });
  assert.equal(big.nodes.length, 256);
  assert.ok(probes <= 16 * 2, `at most 16 runs probed, saw ${probes} calls`);
  assert.equal(big.limits.notChecked, 44 + 4, '44 nodes past the cap and 4 running runs past the 16 process checks');
});

test('a torn store is counted in unreadable and does not stop the tree', (t) => {
  const f = world(t, { fixtures: false });
  session(f, 'claude', `${ID}c001`, f.main);
  fs.mkdirSync(path.join(f.main, '.doflow', 'state', 'worker-runs'), { recursive: true });
  fs.writeFileSync(path.join(f.main, '.doflow', 'state', 'worker-runs', 'torn.json'), '{"runs":');
  const body = tree(f);
  assert.equal(body.unreadable, 1);
  assert.equal(body.nodes.length, 1);
});

test('the read set is byte-identical after the tree (verb and module), and the CLI shape holds', (t) => {
  const f = world(t);
  scenario(f);
  workers(f);
  const before = snapshot(f.root);
  tree(f);
  const lines: string[] = [];
  assert.equal(handleFleetCommand({ action: 'tree', json: false, flags: [], env: env(f), cwd: f.main, out: (l: string) => lines.push(l) }), 0);
  assert.ok(lines[0].startsWith('project ') && lines.some((l) => l.startsWith('edge ')) && lines.every((l) => !l.includes(f.root)));
  const run = (args: string[]) => spawnSync(process.execPath, [CLI, 'fleet', ...args], { cwd: f.main, env: env(f), encoding: 'utf8' });
  const ok = run(['--action', 'tree', '--json']);
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.nodes.length, tree(f).nodes.length);
  for (const needle of ['fa000000', f.root, 'FIXTURE-']) assert.ok(!ok.stdout.includes(needle), needle);
  assert.equal(run(['--action', 'tree', '--bogus']).status, 2);
  assert.equal(run(['--action', 'nope']).status, 2);
  assert.deepEqual(snapshot(f.root), before, 'projects, sessions, harness homes and the config home are untouched, upkeep included');
});
