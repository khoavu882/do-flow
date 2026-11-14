'use strict';

// FU-w9j11f 11b: the verbs the first concurrent-projects check did not cover (`intake`, `events`,
// `roadmap --action status`, `orchestrate --action status|list`, `dispatch --action inspect`) run at the
// same moment in four projects on one machine and one HOME. Each project keeps exactly its own records,
// no lock or temporary file is left, and the whole round ends well inside a hang guard. HOME and
// XDG_CONFIG_HOME are scratch, so nothing here touches a real home.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { suiteTempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { GIT_NULL_CONFIG } = require('../helper/git-null-config.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');
const POOL = 12;
const PROMPTS = 3; // concurrent `intake --action file-prompt` calls per project
const WALL_MS = 30_000;
const NAMES = ['p1', 'p2', 'p3', 'p4'];
const SEED = {
  schema: 1,
  layout: { worktree: '{mainParent}/{mainName}-{id}', branch: 'feat/{slug}' },
  rows: [{ id: '201', slug: '201-alpha', title: 'Alpha', class: 'feature', needs: [] }],
};

let scratch: string;
let env: any;
const roots: any = {};

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, env, stdio: 'ignore' });
}

before(() => {
  scratch = suiteTempDir('doflow-conc-verbs-');
  env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'xdg'),
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG, GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
    DOFLOW_TELEMETRY: 'off',
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'doflow'), { recursive: true });
  for (const name of NAMES) {
    const dir = path.join(scratch, 'repos', name, 'app'); // the same folder name under different parents
    fs.mkdirSync(path.join(dir, 'agent-docs', 'roadmap'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agent-docs', 'doflow', '001-demo'), { recursive: true });
    git(dir, 'init', '-q', '-b', 'develop');
    fs.writeFileSync(path.join(dir, 'README'), `${name}\n`);
    fs.writeFileSync(path.join(dir, 'agent-docs', 'roadmap', 'rows.json'), JSON.stringify(SEED));
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    roots[name] = dir;
  }
});

function run(job: any): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...job.args], { cwd: job.cwd, env: { ...env, PWD: job.cwd }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let done = false;
    const finish = (code: any) => { if (!done) { done = true; clearTimeout(timer); resolve({ ...job, code, out, err: err.slice(0, 300) }); } };
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.stdout.on('data', (d: any) => {
      out += d;
      // `events --follow` never ends by itself: its first frame is the answer, then it is stopped.
      if (job.firstLine && out.includes('\n')) child.kill('SIGTERM');
    });
    child.stderr.on('data', (d: any) => { err += d; });
    child.on('close', finish);
  });
}

async function pool(jobs: any[]): Promise<any[]> {
  const results: any[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (next < jobs.length) results.push(await run(jobs[next++]));
  }));
  return results;
}

/** A temporary, lock, claim or moved-aside name no finished run leaves behind. */
function leftovers(dir: string, found: string[] = []): string[] {
  let entries: any[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const file = path.join(dir, entry.name);
    if (/(\.tmp|\.lock)$|\.lock\.d$|\.claim\.|\.gone$|\.tmp-/.test(entry.name) || /\.(tmp|lock)\./.test(entry.name)) found.push(file);
    if (entry.isDirectory()) leftovers(file, found);
  }
  return found;
}

const json = (job: any): any => JSON.parse(job.out);

test('verbs run in parallel across four projects each keep exactly their own records, and nothing is left behind', { timeout: 120_000 }, async () => {
  // Phase 1: each project starts its own orchestration run, all at once.
  const started = await pool(NAMES.map((name) => ({
    name, cwd: roots[name], args: ['orchestrate', '--action', 'start', '--task-id', `T-${name}`, '--task-class', 'trivial-edit', '--json'],
  })));
  for (const job of started) assert.equal(job.code, 0, `${job.name} start: ${job.out}${job.err}`);

  // Phase 2: every verb of every project at once, including three prompts filed into one feature folder per project.
  const jobs: any[] = [];
  for (const name of NAMES) {
    const cwd = roots[name];
    for (let i = 0; i < PROMPTS; i += 1) {
      const file = path.join(scratch, `${name}-prompt-${i}.txt`);
      fs.writeFileSync(file, `prompt ${name} ${i}\n`);
      jobs.push({ name, verb: 'file-prompt', i, cwd, args: ['intake', '--action', 'file-prompt', '--file', file, '--slug', '001-demo', '--json'] });
    }
    jobs.push({ name, verb: 'intake-list', cwd, args: ['intake', '--action', 'list', '--slug', '001-demo', '--json'] });
    jobs.push({ name, verb: 'events', cwd, firstLine: true, args: ['events', '--follow', '--channels', 'now', '--json'] });
    jobs.push({ name, verb: 'roadmap-status', cwd, args: ['roadmap', '--action', 'status', '--json'] });
    jobs.push({ name, verb: 'orchestrate-status', cwd, args: ['orchestrate', '--action', 'status', '--task-id', `T-${name}`, '--json'] });
    jobs.push({ name, verb: 'orchestrate-list', cwd, args: ['orchestrate', '--action', 'list', '--json'] });
    jobs.push({ name, verb: 'dispatch-inspect', cwd, args: ['dispatch', '--action', 'inspect', '--slug', '001-demo', '--json'] });
  }
  const began = Date.now();
  const results = await pool(jobs);
  const wall = Date.now() - began;
  assert.ok(wall < WALL_MS, `the round took ${wall} ms`);
  const of = (name: string, verb: string) => results.filter((job: any) => job.name === name && job.verb === verb);

  for (const name of NAMES) {
    for (const job of of(name, 'file-prompt')) assert.equal(job.code, 0, `${name} file-prompt: ${job.out}${job.err}`);
    const filed = of(name, 'file-prompt').map(json);
    assert.equal(new Set(filed.map((r: any) => r.path)).size, PROMPTS, `${name}: every prompt got its own file`);
    assert.equal(new Set(filed.map((r: any) => r.runId)).size, PROMPTS, `${name}: every prompt got its own run id`);
    const context = path.join(roots[name], 'agent-docs', 'doflow', '001-demo', 'additional-context');
    const texts = filed.map((r: any) => fs.readFileSync(path.join(context, r.path), 'utf8')).sort();
    assert.deepEqual(texts, [0, 1, 2].map((i) => `prompt ${name} ${i}\n`), `${name}: no prompt lost or overwritten`);
    assert.equal(JSON.parse(fs.readFileSync(path.join(context, '.intake', 'manifest.json'), 'utf8')).runs.length, PROMPTS, `${name}: the manifest holds every run`);

    const [list, roadmap, status, orch, inspect, events] = ['intake-list', 'roadmap-status', 'orchestrate-status', 'orchestrate-list', 'dispatch-inspect', 'events']
      .map((verb) => of(name, verb)[0]);
    assert.equal(list.code, 0, `${name} intake list: ${list.out}${list.err}`);
    assert.equal(roadmap.code, 0, `${name} roadmap status: ${roadmap.out}${roadmap.err}`);
    assert.deepEqual(Object.keys(json(roadmap).rowStatus), ['201']);
    assert.equal(status.code, 0, `${name} orchestrate status: ${status.out}${status.err}`);
    assert.equal(json(status).taskId, `T-${name}`);
    assert.equal(orch.code, 0, `${name} orchestrate list: ${orch.out}${orch.err}`);
    assert.deepEqual(json(orch).runs.map((run: any) => run.taskId), [`T-${name}`], `${name}: only its own run is listed`);
    assert.equal(json(inspect).disposition, 'refused', `${name} dispatch inspect: ${inspect.out}${inspect.err}`);
    const frame = JSON.parse(events.out.split('\n')[0]);
    assert.equal(frame.ch, 'now', `${name} events: ${events.out}${events.err}`);
    assert.equal(frame.type, 'snapshot');

    assert.deepEqual(leftovers(roots[name]), [], `${name}: no lock or temporary file is left`);
  }
  assert.deepEqual([...leftovers(env.HOME), ...leftovers(env.XDG_CONFIG_HOME)], [], 'no lock or temporary file is left in the shared home');
});
