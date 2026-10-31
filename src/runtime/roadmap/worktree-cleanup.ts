'use strict';

/**
 * `doflow-run worktree --action cleanup --slug <slug>` (autonomy plan section 7c): remove one merged
 * feature's worktree and branch with merge.ts's non-force `cleanupFeature`, after copying the
 * worktree's gitignored `agent-docs/doflow/<slug>` back to the main checkout. It refuses, with the
 * reason printed and exit 1, whenever `cleanupFeature` keeps the feature (`report.kept`), the roadmap
 * lease is held (`lease-held`), the row has no `DoFlow-Row` trailer merge on develop (`not-merged`, the
 * evidence the loop requires; a tip merely contained in develop is not enough) or the caller stands
 * inside the worktree (`cwd-inside-worktree`). There is no `--force` (G53). This module is not part of the
 * person-only set and must not import attendance.ts (attendance-scope guard).
 *
 * Exit: 0 `cleaned`, 1 `kept` or `denied` (reason in the output), 2 usage.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync: defaultExecFileSync } = require('node:child_process');
const { acquireLease, releaseLease, resolveMainRoot, noPsAlive } = require('./loop.ts');
const { cleanupFeature } = require('./merge.ts');
const { parseSeed, deriveStatus } = require('./rows.ts');
const { gatherGitFacts } = require('./facts.ts');

/** A row slug is `<id>-<words>`; the pattern keeps a path separator and `..` out of every join below. */
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const ALLOWED_FLAGS = new Set(['--action', '--slug', '--json']);

function execOptionsFor(root: string, env: any): any {
  const environment = { ...env };
  for (const key of Object.keys(environment)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+)$/.test(key)) delete environment[key];
  return { cwd: root, encoding: 'utf8', env: environment, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 };
}

/** Branch ref to worktree path, as `git worktree list` reports them. */
function listWorktrees(root: string, execFileSync: any, execOptions: any): Map<string, string> {
  const out = String(execFileSync('git', ['-C', root, 'worktree', 'list', '--porcelain', '-z'], execOptions));
  const map = new Map<string, string>();
  for (const block of out.split('\0\0').filter(Boolean)) {
    const fields = block.split('\0');
    const listed = fields.find((s) => s.startsWith('worktree '))?.slice(9);
    const worktree = listed === undefined ? listed : path.resolve(listed);
    const branch = fields.find((s) => s.startsWith('branch '))?.slice(7);
    if (worktree && branch) map.set(branch, worktree);
  }
  return map;
}

/** True when the seed row for `slug` has a `DoFlow-Row` trailer merge on develop (deriveStatus, as the loop reads it). */
function mergeEvidence({ root, slug, fsImpl }: any): { merged?: boolean; error?: string; unreadable?: string[] } {
  let rows: any[];
  try { rows = parseSeed(fsImpl.readFileSync(path.join(root, 'agent-docs', 'roadmap', 'rows.json'), 'utf8')).rows; }
  catch { return { error: 'facts-unreadable', unreadable: ['seed'] }; }
  const row = rows.find((entry: any) => entry && entry.slug === slug);
  if (!row) return { error: 'row-unknown' };
  const facts = gatherGitFacts({ root });
  if (facts.unreadable?.length) return { error: 'facts-unreadable', unreadable: facts.unreadable };
  const info = deriveStatus([row], facts).statuses.get(row.id);
  return { merged: info?.status === 'merged' && info.evidence?.kind === 'trailer' };
}

/** True when `cwd` is the worktree or inside it (real paths, so a symlinked temp folder cannot hide it). */
function callerInside(worktree: string | null, cwd: string, fsImpl: any): boolean {
  if (!worktree) return false;
  const real = (value: string): string => { try { return fsImpl.realpathSync(value); } catch { return path.resolve(value); } };
  const relative = path.relative(real(worktree), real(cwd));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * @returns {{code: number, result: object}} the exit code and the JSON body; never throws for a refusal.
 */
function cleanupWorktree(options: any = {}): { code: number; result: any } {
  const fsImpl = options.fsImpl || fs;
  const env = options.env || process.env;
  const execFileSync = options.execFileSync || defaultExecFileSync;
  const slug = options.slug;
  const body = (outcome: string, extra: any = {}) => ({ schema: 1, action: 'cleanup', outcome, slug, ...extra });
  if (typeof slug !== 'string' || !SLUG.test(slug) || slug.includes('..')) {
    return { code: 2, result: { schema: 1, action: 'cleanup', error: 'usage', detail: '--slug <row slug> is required (letters, digits, dot, underscore, hyphen)' } };
  }
  const root = options.root || resolveMainRoot(options.cwd || process.cwd());
  const execOptions = execOptionsFor(root, env);
  const dir = path.join(root, '.doflow', 'state', 'roadmap');
  const me = { schema: 1, pid: options.pid ?? process.pid, start: new Date(Date.now() - (process as any).uptime() * 1000).toISOString(),
    host: options.host ?? os.hostname(), runId: null, acquiredAt: new Date().toISOString() };
  const lease = acquireLease(dir, me, options.alive || noPsAlive, fsImpl);
  if (!lease.ok) {
    const holder = lease.holder && typeof lease.holder === 'object' ? { pid: lease.holder.pid ?? null, host: lease.holder.host ?? null, runId: lease.holder.runId ?? null } : null;
    return { code: 1, result: body('denied', { reason: 'lease-held', holder }) };
  }
  try {
    let worktrees: Map<string, string>;
    try { worktrees = listWorktrees(root, execFileSync, execOptions); }
    catch { return { code: 1, result: body('denied', { reason: 'facts-unreadable', rule: 'cleanup/facts', unreadable: ['worktrees'] }) }; }
    const develop = worktrees.get('refs/heads/develop');
    if (!develop) return { code: 1, result: body('denied', { reason: 'no-develop-worktree' }) };
    const worktree = worktrees.get(`refs/heads/feat/${slug}`) || null;
    let featureHead: string | null = null;
    try { featureHead = String(execFileSync('git', ['-C', root, 'rev-parse', '--verify', `refs/heads/feat/${slug}`], execOptions)).trim(); }
    catch { /* branch already gone: only a leftover worktree can remain */ }
    if (featureHead === null && worktree === null) return { code: 0, result: body('cleaned', { already: true, artifacts: { copied: 0, skipped: [], conflicts: [] } }) };
    const artifacts: any = {};
    // The loop cleans a row only on trailer evidence (loop.ts, merged rows with no intent): a branch
    // whose tip merely sits inside develop (a row claimed a moment ago) is not a merged feature.
    const evidence = mergeEvidence({ root, slug, fsImpl });
    if (evidence.error) return { code: 1, result: body('denied', { reason: evidence.error, rule: 'cleanup/merge-evidence', unreadable: evidence.unreadable }) };
    if (!evidence.merged) { artifacts.kept = 'not-merged'; return { code: 1, result: body('kept', { reason: artifacts.kept, artifacts }) }; }
    // Removing the directory the caller stands in would strand its session.
    if (callerInside(worktree, options.cwd ?? process.cwd(), fsImpl)) {
      artifacts.kept = 'cwd-inside-worktree';
      return { code: 1, result: body('kept', { reason: artifacts.kept, artifacts }) };
    }
    const cleaned = cleanupFeature({ intent: { featureWorktree: worktree, featureBranch: `feat/${slug}`, featureHead },
      root, develop, execFileSync, execOptions, fsImpl, report: artifacts });
    if (cleaned) return { code: 0, result: body('cleaned', { artifacts }) };
    return { code: 1, result: body('kept', { reason: artifacts.kept || 'git-failed', artifacts }) };
  } finally {
    releaseLease(dir, me, fsImpl);
  }
}

/** The CLI handler: `--action cleanup --slug <slug> [--json]`; any other action is usage. */
function handleWorktreeCommand(options: any = {}): number {
  const json = Boolean(options.json);
  const usage = (detail: string): number => {
    if (json) console.log(JSON.stringify({ schema: 1, error: 'usage', detail }));
    else console.error(`doflow worktree: error: ${detail}`);
    process.exitCode = 2;
    return 2;
  };
  if (options.action !== 'cleanup') return usage('--action cleanup is the only action');
  const extra = ((options.flags || []) as string[]).map((flag) => flag.split('=')[0]).find((flag) => !ALLOWED_FLAGS.has(flag));
  if (extra !== undefined) return usage(`unsupported flag ${extra}; only --action, --slug and --json apply`);
  const { code, result } = cleanupWorktree({ slug: options.slug, cwd: options.cwd, env: options.env, root: options.root });
  if (result.error === 'usage') return usage(result.detail);
  if (json) console.log(JSON.stringify(result));
  else if (result.outcome === 'cleaned') console.log(`cleaned ${result.slug}${result.already ? ' (already gone)' : ''}`);
  else {
    const failure = result.artifacts?.failure ? ` (${result.artifacts.failure})` : '';
    console.log(`${result.outcome} ${result.slug}: ${result.reason}${failure}`);
  }
  process.exitCode = code;
  return code;
}

module.exports = { cleanupWorktree, handleWorktreeCommand };
