'use strict';

// A cross-project isolation check, not a regression test for any one lock fix (the lock fixes have their own
// forced-interleave tests beside their code). Several projects run DoFlow verbs at the same moment on one
// machine and one HOME. Every record each verb wrote must land in its own project (and only there), every
// state file must still parse, and no temporary or lock file may be left. The projects also run
// `config set --layer user` together, which puts the shared user settings lock on the path: the final file must hold every key. Projects: two with the same folder name under different parents,
// one reached through a symlink, and one main checkout with a linked worktree. HOME and
// XDG_CONFIG_HOME are scratch, so nothing here touches a real home.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { suiteTempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { GIT_NULL_CONFIG } = require('../helper/git-null-config.ts');

const CLI = path.resolve(__dirname, '../../bin/doflow.js');
const POOL = 6;
const ROUNDS = 2;
const VERBS: any = {
  followup: (m: string) => ['followup', '--action', 'add', '--stage', 'review', '--slug', '001-demo', '--statement', m, '--json'],
  decision: (m: string) => ['decision', '--action', 'add', '--slug', '001-demo', '--topic', `t-${m.toLowerCase().replace(/^mk-/, '')}`, '--statement', m, '--channel', 'question', '--stage', 'design', '--rationale', 'r', '--json'],
  claim: (m: string) => ['claim', '--action', 'add', '--task-id', 't1', '--statement', m, '--json'],
  evidence: (m: string) => ['evidence', '--action', 'add', '--task-id', 't1', '--stage', 'plan', '--kind', 'documentation', '--provenance', 'asserted', '--locator', 'README', '--content', m, '--provider', 'semble', '--capability', 'code-search', '--json'],
};

let scratch: string;
let env: any;
// tag -> directories the verbs run in, and the roots that hold that project's state
const projects: any = {};

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, env, stdio: 'ignore' });
}
function makeRepo(dir: string, text: string) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'develop');
  fs.writeFileSync(path.join(dir, 'README'), `${text}\n`);
  git(dir, 'add', 'README');
  git(dir, 'commit', '-q', '-m', 'init');
}

before(() => {
  scratch = suiteTempDir('doflow-conc-');
  env = {
    PATH: process.env.PATH, TMPDIR: process.env.TMPDIR,
    HOME: path.join(scratch, 'home'), XDG_CONFIG_HOME: path.join(scratch, 'xdg'),
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG, GIT_CONFIG_NOSYSTEM: '1', ...GIT_NO_MAINTENANCE_ENV,
    GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@e.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@e.com',
    DOFLOW_TELEMETRY: 'off',
  };
  fs.mkdirSync(env.HOME, { recursive: true });
  fs.mkdirSync(path.join(env.XDG_CONFIG_HOME, 'doflow'), { recursive: true });
  const repos = path.join(scratch, 'repos');
  makeRepo(path.join(repos, 'p1/app'), 'one');
  makeRepo(path.join(repos, 'p2/app'), 'two');
  makeRepo(path.join(repos, 'p3/svc'), 'three');
  fs.symlinkSync(path.join(repos, 'p3/svc'), path.join(repos, 'link3'));
  makeRepo(path.join(repos, 'p4/main'), 'four');
  git(path.join(repos, 'p4/main'), 'worktree', 'add', '-q', '-b', 'wt-branch', path.join(repos, 'p4/linked'));
  projects.p1 = { cwds: [path.join(repos, 'p1/app')], roots: [path.join(repos, 'p1/app')] };
  projects.p2 = { cwds: [path.join(repos, 'p2/app')], roots: [path.join(repos, 'p2/app')] };
  projects.p3 = { cwds: [path.join(repos, 'link3'), path.join(repos, 'p3/svc')], roots: [path.join(repos, 'p3/svc')] };
  projects.p4 = { cwds: [path.join(repos, 'p4/main'), path.join(repos, 'p4/linked')], roots: [path.join(repos, 'p4/main'), path.join(repos, 'p4/linked')] };
  // The decision verb needs its register to exist; each checkout holds its own.
  for (const root of Object.values<any>(projects).flatMap((info) => info.roots)) {
    fs.mkdirSync(path.join(root, 'agent-docs/doflow/001-demo'), { recursive: true });
    execFileSync(process.execPath, [CLI, 'decision', '--action', 'init', '--slug', '001-demo', '--json'], { cwd: root, env: { ...env, PWD: root }, stdio: 'ignore' });
  }
});

function run(job: any): Promise<any> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...job.args], { cwd: job.cwd, env: { ...env, PWD: job.cwd }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (d: any) => { output += d; });
    child.stderr.on('data', (d: any) => { output += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 45_000);
    child.on('close', (code: any) => { clearTimeout(timer); resolve({ ...job, code, output: output.slice(0, 300) }); });
  });
}

async function runPool(jobs: any[]): Promise<any[]> {
  const results: any[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: POOL }, async () => {
    while (next < jobs.length) results.push(await run(jobs[next++]));
  }));
  return results;
}

function walk(dir: string, found: any[] = []): any[] {
  let entries: any[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return found; }
  for (const entry of entries) {
    if (entry.name === '.git') continue;
    const file = path.join(dir, entry.name);
    found.push({ file, directory: entry.isDirectory() });
    if (entry.isDirectory()) walk(file, found);
  }
  return found;
}

// One user-layer setting per project, each set to a non-default value.
const USER_SETTINGS: any = { p1: ['storage.prune', 'off'], p2: ['failure.capture', 'off'], p3: ['dispatch.fallback', 'off'], p4: ['review.rounds', 2] };

test('isolation: verbs run in parallel across projects each keep exactly their own records, the shared user settings keep every key, and nothing is left behind', { timeout: 120_000 }, async () => {
  // Round r runs every verb of every project at once; a project's cwds alternate so the symlink and the linked worktree are used.
  const jobs: any[] = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    for (const [proj, info] of Object.entries<any>(projects)) {
      Object.keys(VERBS).forEach((verb, w) => {
        const marker = `MK-${proj}-${verb}-${round}-${w}`;
        jobs.push({ proj, verb, marker, cwd: info.cwds[(round + w) % info.cwds.length], args: VERBS[verb](marker) });
      });
    }
  }
  for (const [proj, info] of Object.entries<any>(projects)) {
    jobs.push({ proj, verb: 'config', marker: null, cwd: info.cwds[0], args: ['config', 'set', USER_SETTINGS[proj][0], JSON.stringify(USER_SETTINGS[proj][1]), '--layer', 'user', '--json'] });
  }
  const results = await runPool(jobs);
  for (const r of results) assert.equal(r.code, 0, `${r.proj}/${r.verb} exited ${r.code}: ${r.output}`);

  const seen: Record<string, Set<string>> = {};
  const broken: string[] = [];
  const left: string[] = [];
  const scanRoots = [...Object.entries<any>(projects).flatMap(([proj, info]) => info.roots.map((root: string) => [proj, root])), ['shared', env.HOME], ['shared', env.XDG_CONFIG_HOME]];
  for (const [owner, root] of scanRoots) {
    for (const { file, directory } of walk(root)) {
      if (/(\.tmp|\.lock)$|\.lock\.d$|\.claim\./.test(path.basename(file)) || /\.tmp-/.test(path.basename(file))) left.push(file);
      if (directory) continue;
      const text = fs.readFileSync(file, 'utf8');
      try {
        if (file.endsWith('.json')) JSON.parse(text);
        if (file.endsWith('.jsonl')) text.split('\n').filter(Boolean).forEach((line: any) => JSON.parse(line));
      } catch { broken.push(file); }
      for (const m of text.matchAll(/MK-p\d-[a-z]+-\d+-\d+/g)) (seen[m[0]] ||= new Set()).add(owner);
    }
  }
  assert.deepEqual(broken, [], 'every state file parses');
  assert.deepEqual(left, [], 'no temporary, lock or claim file is left');
  for (const r of results.filter((job) => job.marker)) {
    assert.deepEqual([...(seen[r.marker] || [])], [r.proj], `${r.marker} is in its own project and nowhere else`);
  }
  // Per project and verb the number of records found equals the number written.
  for (const proj of Object.keys(projects)) {
    for (const verb of Object.keys(VERBS)) {
      const written = results.filter((r) => r.proj === proj && r.verb === verb).length;
      const found = Object.keys(seen).filter((m) => m.startsWith(`MK-${proj}-${verb}-`)).length;
      assert.equal(found, written, `${proj}/${verb}: ${written} written, ${found} found`);
    }
  }
  const userFile = path.join(env.XDG_CONFIG_HOME, 'doflow', 'settings.json');
  const user = JSON.parse(fs.readFileSync(userFile, 'utf8'));
  for (const [key, value] of Object.values<any>(USER_SETTINGS)) assert.equal(user[key], value, `${key} is in the shared user settings`);
});
