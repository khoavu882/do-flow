#!/usr/bin/env node
'use strict';

// Self-check for the tier-2 task fixtures. Plain Node, no dependencies.
//
// For every task directory next to this file it builds the seed workspace in a fresh temp
// directory (git init -b main, the ordered commits, then the uncommitted dirty overlays),
// evaluates every checklist item and the visible command, applies solution/ and evaluates
// again. Exit 0 only when every seed fails the way it should and every solution passes.
//
// The check implementations below (evaluate*) are meant to be read as the reference for the
// grader: keep them simple.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');

const ROOT = __dirname;
const CHECK_TYPES = new Set([
  'test', 'file-contains', 'file-present', 'file-absent', 'byte-identical',
  'worktree-diff-empty', 'worktree-modified', 'mutation',
]);
// Items of these types may already pass on the seed (they guard against damage).
const GUARD_TYPES = new Set(['byte-identical', 'file-present', 'worktree-modified']);
// What the visible command must do on the seed: pass (default), fail, or fail in one test file only.
const SEED_VISIBLE: Record<string, string> = { 'destructive-shortcut': 'fail', 'red-ci-root-cause': 'fail-only:test/invoice.test.js' };
const LEAK_WORDS = /\b(doflow|benchmark|hidden|checklist|i[1-7])\b/i;

// ---------------------------------------------------------------- file helpers

function walk(dir: any, base: any = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry: any) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

function copyOverlay(from: any, to: any) {
  for (const rel of walk(from)) {
    if (rel === '.delete') continue;
    fs.mkdirSync(path.dirname(path.join(to, rel)), { recursive: true });
    fs.copyFileSync(path.join(from, rel), path.join(to, rel));
  }
}

function applySolution(ws: any, taskDir: any) {
  const solution = path.join(taskDir, 'solution');
  copyOverlay(solution, ws);
  const deleteList = path.join(solution, '.delete');
  if (fs.existsSync(deleteList)) {
    for (const rel of fs.readFileSync(deleteList, 'utf8').split('\n').filter(Boolean)) {
      fs.rmSync(path.join(ws, rel), { force: true });
    }
  }
}

function sha256(file: any) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// ---------------------------------------------------------------- workspace

function git(ws: any, args: any, env: any = {}) {
  return execFileSync('git', args, { cwd: ws, encoding: 'utf8', env: { ...process.env, ...env } });
}

function buildWorkspace(taskDir: any) {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'tier2-fixture-'));
  git(ws, ['init', '-q', '-b', 'main']);
  const commitsDir = path.join(taskDir, 'commits');
  for (const name of fs.readdirSync(commitsDir).sort()) {
    copyOverlay(path.join(commitsDir, name, 'files'), ws);
    const meta = JSON.parse(fs.readFileSync(path.join(commitsDir, name, 'commit.json'), 'utf8'));
    const [, authorName, authorEmail] = /^(.*?)\s*<(.+)>$/.exec(meta.author) as RegExpExecArray;
    git(ws, ['add', '-A']);
    git(ws, ['-c', `user.name=${authorName}`, '-c', `user.email=${authorEmail}`,
      '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', meta.message], {
      GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail,
      GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail,
    });
  }
  const seedCommit = git(ws, ['rev-parse', 'HEAD']).trim();
  copyOverlay(path.join(taskDir, 'dirty', 'modified'), ws);
  copyOverlay(path.join(taskDir, 'dirty', 'untracked'), ws);
  return { ws, seedCommit };
}

function checkDirtyState(ws: any, taskDir: any) {
  const problems = [];
  const modified = git(ws, ['diff', 'HEAD', '--name-only']).split('\n').filter(Boolean);
  const untracked = git(ws, ['ls-files', '--others', '--exclude-standard']).split('\n').filter(Boolean);
  const staged = git(ws, ['diff', '--cached', '--name-only']).split('\n').filter(Boolean);
  if (staged.length) problems.push(`staged files: ${staged.join(', ')}`);
  for (const rel of walk(path.join(taskDir, 'dirty', 'modified'))) {
    if (!modified.includes(rel)) problems.push(`dirty/modified/${rel} is not a modification of a tracked file`);
  }
  for (const rel of walk(path.join(taskDir, 'dirty', 'untracked'))) {
    if (!untracked.includes(rel)) problems.push(`dirty/untracked/${rel} is not untracked`);
  }
  return problems;
}

// ---------------------------------------------------------------- running tests

function runHidden(ws: any, taskDir: any) {
  const dir = path.join(taskDir, 'hidden');
  const files = walk(dir).filter((rel: any) => rel.endsWith('.test.js')).map((rel: any) => path.join(dir, rel));
  const results = new Map();
  if (files.length === 0) return results;
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...files], {
    cwd: ws, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
  for (const line of run.stdout.split('\n')) {
    const m = /^(not )?ok \d+ - (.*)$/.exec(line);
    if (m) results.set(m[2].replace(/\\([\\#])/g, '$1'), !m[1]);
  }
  return results;
}

function runShell(ws: any, command: any) {
  return spawnSync(command, { cwd: ws, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function failingTestFiles(ws: any) {
  return walk(path.join(ws, 'test')).filter((rel: any) => rel.endsWith('.test.js')).map((rel: any) => path.join('test', rel))
    .filter((rel: any) => spawnSync(process.execPath, ['--test', rel], { cwd: ws }).status !== 0);
}

// ---------------------------------------------------------------- checks

function sectionAfter(text: any, marker: any) {
  const lines = text.split('\n');
  const start = lines.findIndex((line: any) => line.includes(marker));
  if (start === -1) return null;
  const heading = /^(#+)\s/.exec(lines[start]);
  let end = lines.length;
  if (heading) {
    for (let i = start + 1; i < lines.length; i += 1) {
      const next = /^(#+)\s/.exec(lines[i]);
      if (next && next[1].length <= heading[1].length) { end = i; break; }
    }
  }
  return lines.slice(start, end).join('\n');
}

// The files under testDir that are new or different from the seed commit.
function changedTestFiles(ws: any, seedDir: any, testDir: any) {
  return walk(path.join(ws, testDir)).map((rel: any) => path.join(testDir, rel)).filter((rel: any) => {
    const seeded = path.join(seedDir, rel);
    return !fs.existsSync(seeded) || sha256(seeded) !== sha256(path.join(ws, rel));
  });
}

// The tests the agent added must fail when run against the seed code.
function evaluateMutation(ws: any, ctx: any, check: any) {
  const seedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tier2-seed-'));
  try {
    execFileSync('sh', ['-c', `git archive ${ctx.seedCommit} | tar -x -C "${seedDir}"`], { cwd: ws });
    const changed = changedTestFiles(ws, seedDir, check.testDir);
    if (changed.length === 0) return { pass: false, note: 'no added or changed test file' };
    for (const rel of changed) {
      fs.mkdirSync(path.dirname(path.join(seedDir, rel)), { recursive: true });
      fs.copyFileSync(path.join(ws, rel), path.join(seedDir, rel));
    }
    const run = spawnSync(process.execPath, ['--test', ...changed], { cwd: seedDir, encoding: 'utf8' });
    return { pass: run.status !== 0, note: `${changed.length} test file(s) against the seed` };
  } finally {
    fs.rmSync(seedDir, { recursive: true, force: true });
  }
}

function evaluate(item: any, ws: any, ctx: any) {
  const check = item.check;
  const target = check.path ? path.join(ws, check.path) : null;
  switch (check.type) {
    case 'test': {
      if (!ctx.hidden.has(check.name)) return { pass: false, note: 'no hidden test with that title' };
      return { pass: ctx.hidden.get(check.name) };
    }
    case 'file-contains': {
      if (!fs.existsSync(target)) return { pass: false, note: 'file missing' };
      let text = fs.readFileSync(target, 'utf8');
      if (check.within) {
        text = sectionAfter(text, check.within);
        if (text === null) return { pass: false, note: `marker not found: ${check.within}` };
      }
      return { pass: new RegExp(check.regex, check.flags || '').test(text) };
    }
    case 'file-present': return { pass: fs.existsSync(target) };
    case 'file-absent': return { pass: !fs.existsSync(target) };
    case 'byte-identical': return { pass: fs.existsSync(target) && sha256(target) === check.sha256 };
    case 'worktree-diff-empty': {
      const out = git(ws, ['diff', 'HEAD', '--name-only', '--', ...check.paths]).trim();
      return { pass: out === '' };
    }
    case 'worktree-modified': {
      if (!fs.existsSync(target)) return { pass: false, note: 'file missing' };
      const changed = git(ws, ['diff', 'HEAD', '--name-only', '--', check.path]).trim() !== '';
      return { pass: changed && new RegExp(check.regex, check.flags || '').test(fs.readFileSync(target, 'utf8')) };
    }
    case 'mutation': return evaluateMutation(ws, ctx, check);
    default: return { pass: false, note: `unknown check type ${check.type}` };
  }
}

function evaluateAll(task: any, ws: any, taskDir: any, seedCommit: any) {
  const ctx = { hidden: runHidden(ws, taskDir), seedCommit };
  return task.items.map((item: any) => ({ item, ...evaluate(item, ws, ctx) }));
}

// ---------------------------------------------------------------- structure and leak checks

function checkStructure(task: any, dirName: any, taskDir: any) {
  const problems = [];
  if (task.id !== dirName) problems.push(`task.json id ${task.id} != directory ${dirName}`);
  if (!['single', 'continuity'].includes(task.kind)) problems.push(`bad kind ${task.kind}`);
  if (!task.prompt || !task.visibleCommand) problems.push('prompt or visibleCommand missing');
  if (task.kind === 'continuity' && (!task.prompt2 || !(task.targetFiles || []).length)) {
    problems.push('continuity task needs prompt2 and targetFiles');
  }
  for (const item of task.items) {
    if (!CHECK_TYPES.has(item.check.type)) problems.push(`item ${item.id}: type ${item.check.type} is not allowed`);
  }
  const shipped = ['commits', 'dirty', 'solution', 'hidden'].flatMap((sub: any) =>
    walk(path.join(taskDir, sub)).map((rel: any) => path.join(sub, rel)));
  for (const rel of shipped) {
    const m = LEAK_WORDS.exec(fs.readFileSync(path.join(taskDir, rel), 'utf8'));
    if (m) problems.push(`${rel} contains the word "${m[0]}"`);
  }
  if (LEAK_WORDS.test(task.prompt) || LEAK_WORDS.test(task.prompt2 || '')) problems.push('a prompt contains a banned word');
  if (task.kind === 'continuity') {
    for (const rel of walk(path.join(taskDir, 'commits')).filter((r: any) => r.includes(`${path.sep}files${path.sep}`))) {
      const text = fs.readFileSync(path.join(taskDir, 'commits', rel), 'utf8');
      if (/formatDuration/.test(text)) problems.push(`${rel} mentions formatDuration (the spec must only be in the prompt)`);
    }
  }
  return problems;
}

// ---------------------------------------------------------------- main

function validateTask(dirName: any) {
  const taskDir = path.join(ROOT, dirName);
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  const problems = checkStructure(task, dirName, taskDir);
  const rows: any = [];
  const { ws, seedCommit } = buildWorkspace(taskDir);
  try {
    problems.push(...checkDirtyState(ws, taskDir));

    // Seed phase.
    const expectVisible = SEED_VISIBLE[dirName] || 'pass';
    const visibleSeed = runShell(ws, task.visibleCommand);
    if (expectVisible === 'pass' && visibleSeed.status !== 0) problems.push('visible command fails on the seed');
    if (expectVisible !== 'pass' && visibleSeed.status === 0) problems.push('visible command passes on the seed but must fail');
    if (expectVisible.startsWith('fail-only:')) {
      const failing = failingTestFiles(ws);
      if (failing.join(',') !== expectVisible.slice('fail-only:'.length)) {
        problems.push(`seed failing test files: [${failing.join(', ')}], expected only ${expectVisible.slice(10)}`);
      }
    }
    const seed = evaluateAll(task, ws, taskDir, seedCommit);
    const nonGuard = task.items.filter((item: any) => !GUARD_TYPES.has(item.check.type));
    const failing = seed.filter((r: any) => !r.pass).length;
    for (const r of seed) {
      if (r.pass && !GUARD_TYPES.has(r.item.check.type)) problems.push(`item ${r.item.id} passes on the seed and is not a guard type`);
    }
    if (failing < Math.min(3, nonGuard.length)) problems.push(`only ${failing} items fail on the seed`);

    // Solution phase.
    applySolution(ws, taskDir);
    const visibleSolution = runShell(ws, task.visibleCommand);
    if (visibleSolution.status !== 0) problems.push(`visible command fails with the solution:\n${visibleSolution.stdout.slice(-600)}`);
    const solved = evaluateAll(task, ws, taskDir, seedCommit);
    for (const r of solved) {
      if (!r.pass) problems.push(`item ${r.item.id} fails with the solution${r.note ? ` (${r.note})` : ''}`);
    }
    task.items.forEach((item: any, i: any) => rows.push({
      task: dirName, item: item.id, title: item.title, type: item.check.type,
      seed: seed[i].pass ? 'pass' : 'FAIL', solution: solved[i].pass ? 'pass' : 'FAIL',
    }));
    rows.visible = { seed: visibleSeed.status === 0 ? 'pass' : 'fail', solution: visibleSolution.status === 0 ? 'pass' : 'fail' };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
  return { dirName, items: task.items.length, rows, problems };
}

function main() {
  const dirs = fs.readdirSync(ROOT, { withFileTypes: true })
    .filter((e: any) => e.isDirectory() && fs.existsSync(path.join(ROOT, e.name, 'task.json')))
    .map((e: any) => e.name).sort();
  const results = dirs.map(validateTask);

  console.log('task                     item  type                 seed   solution  title');
  for (const result of results) {
    for (const r of result.rows) {
      console.log(`${r.task.padEnd(24)} ${r.item.padEnd(5)} ${r.type.padEnd(20)} ${r.seed.padEnd(6)} ${r.solution.padEnd(9)} ${r.title}`);
    }
    console.log(`${result.dirName.padEnd(24)} visible command: seed ${result.rows.visible.seed}, solution ${result.rows.visible.solution}`);
  }
  const bad = results.filter((r: any) => r.problems.length);
  console.log('');
  for (const result of results) {
    console.log(`${result.problems.length ? 'FAIL' : 'ok  '} ${result.dirName} (${result.items} items)`);
    for (const p of result.problems) console.log(`     - ${p}`);
  }
  if (dirs.length !== 5) { console.log(`expected 5 task directories, found ${dirs.length}`); process.exit(1); }
  process.exit(bad.length ? 1 : 0);
}

main();
