'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * 119 C.1 (IC-002, D-5, FR-007): the IO half of reviewer independence. `crossCheckAuthor` reads the reviewed head's
 * `Co-Authored-By` trailers and the slug's task-attempt owners and reports where they contradict the record's
 * `author` claim. The author is a claim (design R5): this catches mistakes and contradictions, not an adversary.
 * Never throws; every failure to read is an `author-unchecked:*` advisory.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

type Env = Record<string, string | undefined>;
type GitOutput = (args: string[], cwd: string, env: Env) => { status: number | null; stdout?: string };

// Inherited location variables would point the check at another repository (C-8); same set as command.ts.
const GIT_LOCATION_KEYS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

function defaultGit(args: string[], cwd: string, env: Env): { status: number | null; stdout?: string } {
  const gitEnv = { ...env };
  for (const key of GIT_LOCATION_KEYS) delete gitEnv[key];
  return spawnSync('git', ['-C', cwd, ...args], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

/** The known (non-`unknown`) model families of core/registry/models.json; `null` when the registry cannot be read. */
function knownFamilies(): string[] | null {
  try {
    const models = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'models.json'), 'utf8'));
    return [...new Set<string>(models.providers.flatMap((provider: any) => provider.families))].filter((family) => family !== 'unknown');
  } catch { return null; }
}

/** A trailer value mapped to a known family it names (`Claude Sonnet 5.5 <...>` -> `claude`), else `unknown`. */
function trailerFamily(value: string, families: string[]): string {
  return families.find((family) => new RegExp(`(?<![a-z0-9])${family}(?![a-z0-9])`, 'i').test(value)) ?? 'unknown';
}

function trailerAdvisories(record: any, cwd: string, env: Env, git: GitOutput): string[] {
  const families = knownFamilies();
  let values: string[];
  try {
    const run = git(['log', '-1', '--format=%(trailers:key=Co-Authored-By,valueonly)', record.reviewedHead], cwd, env);
    if (run?.status !== 0 || typeof run.stdout !== 'string') return ['author-unchecked:trailers'];
    values = run.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  } catch { return ['author-unchecked:trailers']; }
  if (values.length === 0 || record.author.family === 'unknown') return [];
  if (families === null) return ['author-unchecked:trailers'];
  const claimsClaude = values.some((value) => trailerFamily(value, families) === 'claude');
  return claimsClaude !== (record.author.family === 'claude') ? ['author-trailer-contradiction'] : [];
}

function attemptAdvisories(record: any, cwd: string, readFile: (file: string) => string): string[] {
  let text: string;
  try {
    const { projectRoot } = require('../lifecycle/root.ts');
    const { storeFile } = require('../task-attempts.ts');
    text = readFile(storeFile(projectRoot(cwd), record.slug));
  } catch (error: any) {
    return error?.code === 'ENOENT' ? [] : ['author-unchecked:attempts'];
  }
  let owners: string[];
  try {
    const tasks = JSON.parse(text).tasks;
    if (tasks === null || typeof tasks !== 'object' || Array.isArray(tasks)) return ['author-unchecked:attempts'];
    owners = [];
    for (const task of Object.values<any>(tasks)) {
      if (!Array.isArray(task?.attempts)) return ['author-unchecked:attempts'];
      for (const attempt of task.attempts) {
        if (typeof attempt?.owner !== 'string') return ['author-unchecked:attempts'];
        owners.push(attempt.owner);
      }
    }
  } catch { return ['author-unchecked:attempts']; }
  return owners.length > 0 && !owners.includes(record.author.agent) ? ['author-attempt-contradiction'] : [];
}

/**
 * Advisories contradicting a valid record's `author` claim, sorted. `git` and `readFile` are injectable for tests.
 * @param record a record that passed validateFindings and holds `author`
 */
function crossCheckAuthor({ record, cwd, env = process.env, git = defaultGit, readFile = (file: string) => fs.readFileSync(file, 'utf8') }: any): string[] {
  try {
    return [...trailerAdvisories(record, cwd, env, git), ...attemptAdvisories(record, cwd, readFile)].sort();
  } catch {
    return ['author-unchecked:attempts', 'author-unchecked:trailers'];
  }
}

module.exports = { crossCheckAuthor };
