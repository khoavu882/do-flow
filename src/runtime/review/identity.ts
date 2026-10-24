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

type AuthorIdentityRow = {
  kind: 'record' | 'subagent' | 'sequential' | 'primary';
  harness: string;
  model: string;
  channel: 'observed' | 'claim';
};

/**
 * 120 D.1 (IC-015, IC-016): extracts the read-only authoring identities of a slug.
 * Returns flat identity rows from:
 * 1. The record's `author` (channel 'claim').
 * 2. Every dispatch of the slug's dispatch runs that reached submit:
 *    - subagent: requested (channel 'observed' when descriptor model status is 'supported', else 'claim')
 *      and served (channel 'observed').
 *    - sequential: harness from primary snapshot, model from requested binding or 'unknown' (channel 'claim').
 * 3. The primary when author.harness equals the primary harness (channel 'observed' when confirmed, else 'claim').
 */
function authoringIdentities({
  slug,
  cwd = process.cwd(),
  env = process.env,
  record = null,
  registry = null,
  primary: primaryOverride = null,
  fsImpl = fs,
}: {
  slug?: string;
  cwd?: string;
  env?: Env;
  record?: any;
  registry?: any;
  primary?: any;
  fsImpl?: any;
} = {}): AuthorIdentityRow[] {
  const rows: AuthorIdentityRow[] = [];

  // 1. Record's author
  if (record?.author && typeof record.author === 'object') {
    const authorHarness = typeof record.author.harness === 'string' && record.author.harness.length > 0 ? record.author.harness : null;
    const authorModel = typeof record.author.model === 'string' && record.author.model.length > 0 ? record.author.model : 'unknown';
    if (authorHarness !== null) {
      rows.push({
        kind: 'record',
        harness: authorHarness,
        model: authorModel,
        channel: 'claim',
      });

      // 3. Primary joins when record's author names primary
      try {
        let primary = primaryOverride;
        if (!primary) {
          const { resolvePrimary } = require('../context/primary.ts');
          primary = resolvePrimary({ cwd, env, registry });
        }
        if (primary && primary.harness && primary.harness === authorHarness) {
          rows.push({
            kind: 'primary',
            harness: primary.harness,
            model: typeof primary.model === 'string' && primary.model.length > 0 ? primary.model : 'unknown',
            channel: primary.state === 'confirmed' ? 'observed' : 'claim',
          });
        }
      } catch {}
    }
  }

  // 2. Dispatches in dispatch store
  if (slug && typeof slug === 'string') {
    try {
      const { projectRoot } = require('../lifecycle/root.ts');
      const { storeFileFor, readDispatch } = require('../dispatch/store.ts');
      const root = projectRoot(cwd);
      const file = storeFileFor(root, slug);
      if (fsImpl.existsSync(file)) {
        const store = readDispatch(file, fsImpl);
        const dispatches = store?.dispatches && typeof store.dispatches === 'object' ? Object.values(store.dispatches) : [];

        // Descriptor model status lookup
        let descriptors: Record<string, any> = {};
        try {
          const { loadRegistry } = require('../../registry/index.ts');
          const reg = registry || loadRegistry({ repoRoot: REPO_ROOT });
          for (const h of reg.harnesses || []) {
            if (h.worker && typeof h.worker === 'object') {
              descriptors[h.id] = h.worker;
            }
          }
        } catch {}

        for (const d of dispatches as any[]) {
          if (!d || typeof d !== 'object') continue;
          const reachedSubmit = Boolean(
            d.collectedAt ||
            d.phase === 'collected' ||
            d.phase === 'integrating' ||
            (d.phase === 'ended' && (d.commit || d.report || d.collectedAt))
          );
          if (!reachedSubmit) continue;

          if (d.mode === 'subagent') {
            const harness = typeof d.harness === 'string' && d.harness.length > 0 ? d.harness : 'unknown';
            const desc = descriptors[harness];
            const isSupported = desc?.model?.status === 'supported' && Array.isArray(desc.model?.argv);

            if (typeof d.model?.served === 'string' && d.model.served.length > 0) {
              rows.push({
                kind: 'subagent',
                harness,
                model: d.model.served,
                channel: 'observed',
              });
            }

            if (typeof d.model?.requested === 'string' && d.model.requested.length > 0) {
              rows.push({
                kind: 'subagent',
                harness,
                model: d.model.requested,
                channel: isSupported ? 'observed' : 'claim',
              });
            }

            if (!d.model?.served && !d.model?.requested) {
              rows.push({
                kind: 'subagent',
                harness,
                model: 'unknown',
                channel: 'claim',
              });
            }
          } else if (d.mode === 'sequential') {
            const harness = d.primary?.harness ?? (typeof d.harness === 'string' && d.harness.length > 0 ? d.harness : 'unknown');
            const model = typeof d.model?.requested === 'string' && d.model.requested.length > 0 ? d.model.requested : 'unknown';
            rows.push({
              kind: 'sequential',
              harness,
              model,
              channel: 'claim',
            });
          }
        }
      }
    } catch {}
  }

  // Deduplicate preserving order
  const seen = new Set<string>();
  const deduped: AuthorIdentityRow[] = [];
  for (const row of rows) {
    const key = `${row.kind}:${row.harness}:${row.model}:${row.channel}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(row);
    }
  }
  return deduped;
}

module.exports = { crossCheckAuthor, authoringIdentities };
