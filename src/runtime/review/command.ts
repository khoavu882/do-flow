'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validateFindings, countFindings, reviewAdvisories, invalidProjectCandidate, invalidPresetCandidate, telemetryProtocol } = require('./findings.ts');
const { resolveActiveFeature } = require('../feature-resolve.ts');
const { TelemetryWriter } = require('../trace/telemetry.ts');
const { finishRuntime } = require('../cli-result.ts');
const { printSafe } = require('../mask.ts');
const { handleReviewStart, validSlug } = require('./start.ts');
const { crossCheckAuthor, authoringIdentities } = require('./identity.ts');
const { isQualifiedId } = require('../../helper/package-ids.ts');

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

function defaultGit(args: string[], cwd: string, env: Env): { status: number | null } {
  const gitEnv = { ...env };
  // Inherited location variables would point the check at another repository (C-8); the list is verification's.
  for (const key of require('../dispatch/verify-run.ts').REPO_ENV) delete gitEnv[key];
  return spawnSync('git', ['-C', cwd, ...args], { cwd, env: gitEnv, stdio: 'ignore' });
}

/** The project's `review.sameFamily` (119 L-C3), read for the checkout the verb runs in. A settings view that cannot
 * load, or an invalid project or local value for the key (C-6: the resolver would fall back to the default without a
 * word), is `warn` plus `unread`; the caller turns `unread` into an error. Never a crash, never a silent `refuse`. */
function readSameFamily(load: (options: { projectRoot: string; env: Env }) => any, cwd: string, env: Env): { value: 'warn' | 'refuse'; unread: boolean } {
  try {
    const resolution = load({ projectRoot: path.resolve(cwd), env }).get('review.sameFamily');
    if (invalidProjectCandidate(resolution)) return { value: 'warn', unread: true };
    return { value: resolution.value === 'refuse' ? 'refuse' : 'warn', unread: false };
  } catch {
    return { value: 'warn', unread: true };
  }
}

/** The effective `review.preset` (C-2 closure), read for the checkout the verb runs in. A settings view that cannot
 * load, or an invalid user, project or local value (the resolver would fall back to `auto` without a word), is `unread`;
 * the caller turns `unread` into an error, so a broken setting never relaxes the check. */
function readPreset(load: (options: { projectRoot: string; env: Env }) => any, cwd: string, env: Env): { value: string; unread: boolean } {
  try {
    const resolution = load({ projectRoot: path.resolve(cwd), env }).get('review.preset');
    if (invalidPresetCandidate(resolution)) return { value: 'auto', unread: true };
    return { value: typeof resolution.value === 'string' ? resolution.value : 'auto', unread: false };
  } catch {
    return { value: 'auto', unread: true };
  }
}

// A preset id: a core one as protocols.ts validates it (`^[a-z][a-z0-9-]*$`), or a package preset's qualified id
// (`<package>.<preset>`, 122 IC-003). Whether it is available and strict enough is the resolver's answer (IC-014).
const CORE_PRESET_ID = /^[a-z][a-z0-9-]*$/;
const presetIdShape = (value: unknown): boolean => typeof value === 'string' && (CORE_PRESET_ID.test(value) || isQualifiedId(value));

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

/** The text of one What ran line: a check of the verify run, or a flow that has an outcome on the head. */
function inputRunLines(what: any): string[] {
  const line = (...cells: any[]): string => `- ${cells.map((cell) => String(printSafe(String(cell ?? ''))).replace(/\s+/g, ' ').trim()).join(' · ')}`;
  const short = (sha: any): string => (typeof sha === 'string' && sha ? sha.slice(0, 8) : 'none recorded');
  const NONE = 'none recorded';
  const lines: string[] = [];
  for (const c of what.verify?.checks ?? []) lines.push(line(c.tier, c.command ?? NONE, c.status, `exit ${c.exitCode ?? NONE}`, `commit ${short(what.head)}`));
  for (const f of what.flows.filter((flow: any) => flow.status !== 'not-run')) {
    lines.push(line(`flow ${f.id}`, f.action ?? NONE, f.status, f.observed ?? NONE, f.locator ?? NONE, `commit ${short(f.commit)}`));
  }
  return lines.length ? lines : [`- ${NONE}`];
}

/**
 * 181 IC-011 `review --action input`: what ran on the head commit (the latest verify run's checks and each
 * feature-map flow's result), then the flows that did not run. It never refuses on evidence and writes nothing:
 * exit 0 whenever git answers, 1 when the head or the base cannot be resolved, 2 for usage.
 */
function handleReviewInput({ slug, base, json, cwd, env, resolve, out }: any): number {
  const fail = (error: string, message: string): number => {
    out(json ? JSON.stringify({ ok: false, action: 'input', error, message }) : `doflow review: ${error}: ${message}`);
    return finishRuntime(1);
  };
  let feature: any = null;
  try { feature = (resolve as FeatureResolver)({ projectRoot: cwd, slug }); } catch { feature = null; }
  const resolved = feature && !feature.error && typeof feature.featureFolder === 'string' && feature.featureFolder ? feature : null;
  const taskId: string | null = slug ?? (validSlug(feature?.paths?.feature_slug) ? feature.paths.feature_slug : null);
  if (!taskId) return usage('--slug is required when no active feature resolves', json, out);

  const gitEnv = { ...env };
  for (const key of require('../dispatch/verify-run.ts').REPO_ENV) delete gitEnv[key];
  const rev = spawnSync('git', ['-C', cwd, 'rev-parse', '--verify', 'HEAD'], { cwd, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 });
  const head = rev.status === 0 ? String(rev.stdout).trim() : '';
  if (!/^[0-9a-f]{40,64}$/.test(head)) return fail('head-unresolved', 'HEAD could not be resolved');
  const { resolveExplicitBaseline, resolveIntegrationBase } = require('../verification/scope-bound.ts');
  let baseSha: string | null = null;
  let reason = '';
  if (base !== null) {
    const explicit = resolveExplicitBaseline({ cwd, ref: base });
    baseSha = explicit.ok ? explicit.sha : null;
    reason = explicit.ok ? '' : String(explicit.reason);
  } else {
    const integration = resolveIntegrationBase({ cwd });
    baseSha = typeof integration.mergeBase === 'string' && integration.mergeBase ? integration.mergeBase : null;
    reason = baseSha ? '' : String(integration.reason ?? 'no integration branch');
  }
  if (!baseSha) return fail('base-unresolved', reason);

  const what = require('../run-evidence.ts').compileRunEvidence({
    root: resolved ? resolved.featureRoot : cwd, taskId, head, fsImpl: fs, featureDir: resolved ? resolved.featureFolder : null,
  });
  const notRun = what.flows.filter((flow: any) => flow.status === 'not-run').map((flow: any) => ({ id: flow.id, title: flow.title }));
  if (json) {
    out(JSON.stringify({ ok: true, action: 'input', head, base: baseSha, whatRan: what, notRun }));
    return finishRuntime(0);
  }
  const cut = (sha: string): string => sha.slice(0, 8);
  const lines = [`What ran on ${cut(head)} (base ${cut(baseSha)}):`, ...inputRunLines(what)];
  if (what.verify && !what.verify.onHead) lines.push('The latest verify run is not on the head commit; its checks are not shown as evidence for this head.');
  else if (what.verify && what.verify.clean !== true) lines.push('The latest verify run was on a tree with uncommitted changes; its checks are not shown as evidence for this head.');
  lines.push('', 'Not run:');
  if (what.featureMap === 'absent') lines.push('- No feature map: no user-facing flow is shown as run.');
  else if (notRun.length === 0) lines.push('- none');
  for (const flow of notRun) lines.push(`- Flow ${flow.id} (${flow.title}): not run on ${cut(head)}`);
  if (what.featureMap === 'invalid') lines.push('- The feature map is invalid: a flow it lists is not shown as run unless it has a result on the head.');
  for (const problem of what.problems) lines.push(`- Run evidence: ${problem}`);
  for (const line of lines) out(String(printSafe(line, { keepLineBreaks: false })));
  return finishRuntime(0);
}

function handleReviewCommand({
  action,
  slug,
  path: recordPath,
  base,
  preset,
  seats,
  outFile,
  adviceClient,
  json = false,
  cwd = process.cwd(),
  env = process.env,
  git = defaultGit,
  loadSettings = (options: { projectRoot: string; env: Env }) => require('../settings/resolve.ts').loadSettings(options),
  writer,
  teamWriter,
  resolve = resolveActiveFeature,
  out = (line: string) => console.log(line),
}: any = {}): number | Promise<number> {
  if (action !== 'check' && action !== 'start' && action !== 'similar' && action !== 'input') return usage('action must be check, start, similar or input', json, out);
  if ([slug, recordPath, base, preset, seats, outFile].some(emptyValue)) return usage('flag values must not be empty', json, out);
  if (action === 'similar') {
    // 176 IC-007: the seats file and --out replace the record path; the slug names the feature.
    if (hasValue(recordPath) || hasValue(base) || hasValue(preset)) return usage('--path, --base and --preset are not valid with --action similar', json, out);
    if (hasValue(slug) && !validSlug(slug)) return usage('--slug must be a plain feature name', json, out);
    if ([seats, outFile].some((value) => hasValue(value) && typeof value !== 'string')) return usage('--seats and --out values must be strings', json, out);
    // Required here, so `check` and `start` load no decision client.
    return require('./similar.ts').handleReviewSimilar({ slug: hasValue(slug) ? slug : null, seats: hasValue(seats) ? seats : null, outFile: hasValue(outFile) ? outFile : null, json, cwd, env, resolve, out });
  }
  if (hasValue(seats) || hasValue(outFile)) return usage('--seats and --out are valid only with --action similar', json, out);
  if (action === 'input') {
    if (hasValue(recordPath) || hasValue(preset)) return usage('--path and --preset are not valid with --action input', json, out);
    if ((hasValue(slug) && !validSlug(slug)) || (hasValue(base) && typeof base !== 'string')) {
      return usage('--slug must be a plain feature name and --base a string', json, out);
    }
    return handleReviewInput({ slug: hasValue(slug) ? slug : null, base: hasValue(base) ? base : null, json, cwd, env, resolve, out });
  }
  if (action === 'start') {
    // 095b IC-001: the start verb reads no record path, and the slug becomes a file name.
    if (hasValue(recordPath)) return usage('--path is not valid with --action start', json, out);
    if ((hasValue(slug) && !validSlug(slug)) || (hasValue(base) && typeof base !== 'string')) {
      return usage('--slug must be a plain feature name and --base a string', json, out);
    }
    if (hasValue(preset) && !presetIdShape(preset)) {
      return usage('--preset must be a preset id (lower-case letters, digits and hyphens, or <package>.<preset> for a package preset)', json, out);
    }
    return handleReviewStart({ slug: hasValue(slug) ? slug : null, base: hasValue(base) ? base : null, preset: hasValue(preset) ? preset : null, json, cwd, env, resolve, adviceClient, out, teamWriter });
  }
  if (Array.isArray(recordPath)) return usage('--path may be given only once', json, out);
  if (hasValue(base)) return usage('--base is valid only with --action start', json, out);
  if (hasValue(preset)) return usage('--preset is valid only with --action start', json, out);
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
  const identityAdvisories: string[] = [];
  let sameFamily: 'warn' | 'refuse' = 'warn';
  let reviewPreset = 'auto';
  let authors: any[] = [];
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
      // Settings are read only for a record that declares an author: nothing else depends on them (L-C3).
      let peek: any = null;
      try { peek = JSON.parse(raw); } catch { /* validateFindings reports `json` */ }
      if (peek !== null && typeof peek === 'object' && Object.hasOwn(peek, 'author')) {
        const read = readSameFamily(loadSettings, cwd, env);
        sameFamily = read.value;
        if (read.unread) errors.push('same-family-setting-unread');
      }
      // A record that omits `protocol` is held to the effective `review.preset` (C-2 closure), so it is read for every record.
      if (peek !== null && typeof peek === 'object') {
        const read = readPreset(loadSettings, cwd, env);
        reviewPreset = read.value;
        if (read.unread) errors.push('review-preset-setting-unread');
      }
      authors = authoringIdentities({ slug: peek?.slug, cwd, env, record: peek, fsImpl: fs });
      const validation = validateFindings(raw, { sameFamily, preset: reviewPreset, authors });
      for (const error of validation.errors) errors.push(error); // a spread overflows the stack at ~200k errors (C-6)
      if (!validation.errors.includes('json')) {
        try { record = JSON.parse(raw); } catch { record = null; }
      }
      if (validation.ok && record) {
        if (Object.hasOwn(record, 'author')) identityAdvisories.push(...crossCheckAuthor({ record, cwd, env }));
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

  const advisories = (record && validateFindings(record, { sameFamily, preset: reviewPreset, authors }).ok
    ? reviewAdvisories(record, { sameFamily, authors }).concat(identityAdvisories)
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
  if (counts && record) Object.assign(telemetryRecord, counts, { depth: record.depth ?? null, risk: record.risk ?? null, protocol: telemetryProtocol(record.protocol?.id), head: record.reviewedHead });
  try { telemetryWriter.write([telemetryRecord]); } catch { /* telemetry never changes the check result */ }

  return finishRuntime(valid ? 0 : 1);
}

module.exports = { handleReviewCommand };

