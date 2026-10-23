'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateFindings, countFindings, reviewAdvisories } = require('./findings.ts');
const { resolveActiveFeature } = require('../feature-resolve.ts');
const { TelemetryWriter } = require('../trace/telemetry.ts');
const { finishRuntime } = require('../cli-result.ts');
const { handleReviewStart, validSlug } = require('./start.ts');

type ReviewRecord = Record<string, any>;
type Env = Record<string, string | undefined>;
type GitRunner = (args: string[], cwd: string, env: Env) => { status: number | null };
type ReviewWriter = { write: (records: ReviewRecord[]) => void };
type FeatureResolver = (options: { projectRoot: string; slug?: string | null }) => any;

const TELEMETRY_COUNT_KEYS = Object.freeze([
  'rounds', 'seats', 'seat_findings', 'converged', 'blocker', 'should_fix', 'note',
  'open', 'fixed', 'refuted', 'user_accepted', 'pre_existing', 'escaped', 'confirmed',
  'plausible', 'unverified_blockers', 'bug_classes',
]);

// Inherited location variables would point the check at another repository (C-8).
const GIT_LOCATION_KEYS = Object.freeze([
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
]);

function defaultGit(args: string[], cwd: string, env: Env): { status: number | null } {
  const gitEnv = { ...env };
  for (const key of GIT_LOCATION_KEYS) delete gitEnv[key];
  return spawnSync('git', ['-C', cwd, ...args], { cwd, env: gitEnv, stdio: 'ignore' });
}

function usage(message: string, json: boolean, out: (line: string) => void): number {
  out(json
    ? JSON.stringify({ ok: false, error: 'usage', message })
    : `doflow review: ${message}`);
  return finishRuntime(2);
}

function hasValue(value: unknown): boolean {
  return value !== undefined && value !== null;
}

function emptyValue(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length === 0;
}

function handleReviewCommand({
  action,
  slug,
  path: recordPath,
  base,
  adviceClient,
  json = false,
  cwd = process.cwd(),
  env = process.env,
  git = defaultGit,
  writer,
  resolve = resolveActiveFeature,
  out = (line: string) => console.log(line),
}: any = {}): number | Promise<number> {
  if (action !== 'check' && action !== 'start') return usage('action must be check or start', json, out);
  if (emptyValue(slug) || emptyValue(recordPath) || emptyValue(base)) return usage('flag values must not be empty', json, out);
  if (action === 'start') {
    // 095b IC-001: the start verb reads no record path, and the slug becomes a file name.
    if (hasValue(recordPath)) return usage('--path is not valid with --action start', json, out);
    if ((hasValue(slug) && !validSlug(slug)) || (hasValue(base) && typeof base !== 'string')) {
      return usage('--slug must be a plain feature name and --base a string', json, out);
    }
    return handleReviewStart({ slug: hasValue(slug) ? slug : null, base: hasValue(base) ? base : null, json, cwd, env, resolve, adviceClient, out });
  }
  if (hasValue(base)) return usage('--base is valid only with --action start', json, out);
  if (hasValue(slug) && hasValue(recordPath)) return usage('use either --slug or --path, not both', json, out);
  if ((hasValue(slug) && typeof slug !== 'string') || (hasValue(recordPath) && typeof recordPath !== 'string')) {
    return usage('--slug and --path values must be strings', json, out);
  }

  const telemetryWriter: ReviewWriter = writer || new TelemetryWriter({ env, start: cwd });
  let file: string | null = null;
  let resolverMessage: string | null = null;
  if (hasValue(recordPath)) {
    file = path.resolve(cwd, recordPath);
  } else {
    let feature: any;
    try {
      feature = (resolve as FeatureResolver)({ projectRoot: cwd, slug: hasValue(slug) ? slug : null });
    } catch (error: any) {
      feature = { error: 'resolver-failed', message: error?.message || String(error) };
    }
    if (feature?.error || typeof feature?.featureFolder !== 'string' || !feature.featureFolder) {
      resolverMessage = typeof feature?.message === 'string' && feature.message
        ? feature.message
        : (typeof feature?.error === 'string' && feature.error ? feature.error : 'feature could not be resolved');
    } else {
      file = path.resolve(feature.featureFolder, 'review', 'findings.json');
    }
  }

  const errors: string[] = [];
  const errorDetails = new Map<string, string>();
  const ancestryAdvisories: string[] = [];
  let record: ReviewRecord | null = null;
  if (file === null) {
    errors.push('missing');
    errorDetails.set('missing', resolverMessage || 'feature record could not be located');
  } else {
    let raw: string;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (error: any) {
      if (error?.code === 'ENOENT') errors.push('missing');
      else errors.push('unreadable');
      if (error?.message) errorDetails.set(errors[0], error.message);
      raw = '';
    }

    if (errors.length === 0) {
      const validation = validateFindings(raw);
      for (const error of validation.errors) errors.push(error); // a spread overflows the stack at ~200k errors (C-6)
      if (!validation.errors.includes('json')) {
        try { record = JSON.parse(raw); } catch { record = null; }
      }
      if (validation.ok && record) {
        for (const finding of record.converged) {
          if (typeof finding.preExistingAt !== 'string') continue;
          let status: number | null | undefined;
          try {
            status = (git as GitRunner)(
              ['merge-base', '--is-ancestor', finding.preExistingAt, record.reviewedHead],
              path.dirname(file),
              env,
            )?.status;
          } catch {
            status = null;
          }
          if (status === 1) errors.push(`preExistingAt-not-ancestor:${finding.id}`);
          else if (status !== 0) ancestryAdvisories.push(`ancestry-unchecked:${finding.id}`);
        }
      }
    }
  }

  const advisories = (record && validateFindings(record).ok
    ? reviewAdvisories(record)
    : []).concat(ancestryAdvisories).sort();
  const valid = errors.length === 0;
  const counts = valid && record ? countFindings(record) : null;
  const result = { schema: 1, path: file, valid, errors, advisories, counts };

  if (json) {
    out(JSON.stringify(result));
  } else {
    out(`review check: ${valid ? 'valid' : 'invalid'} (${errors.length} errors, ${advisories.length} advisories)`);
    for (const error of errors) {
      const detail = errorDetails.get(error);
      out(`error: ${error}${detail ? `: ${detail}` : ''}`);
    }
    for (const advisory of advisories) out(`advisory: ${advisory}`);
    if (counts) out(Object.entries(counts).map(([key, value]) => `${key}=${value}`).join(' '));
  }

  // Only a validated slug is a feature slug; an invalid record's slug can hold anything (C-1, IC-004).
  const task = valid && record && typeof record.slug === 'string' ? record.slug : null;
  const telemetryRecord: ReviewRecord = {
    kind: 'review.run',
    task,
    depth: null,
    risk: null,
    protocol: null,
    head: null,
    ...Object.fromEntries(TELEMETRY_COUNT_KEYS.map((key) => [key, null])),
    advisories: advisories.length,
    errors: errors.length,
  };
  if (counts && record) Object.assign(telemetryRecord, counts, { depth: record.depth ?? null, risk: record.risk ?? null, protocol: record.protocol?.id ?? null, head: record.reviewedHead });
  try { telemetryWriter.write([telemetryRecord]); } catch { /* telemetry never changes the check result */ }

  return finishRuntime(valid ? 0 : 1);
}

module.exports = { handleReviewCommand };

