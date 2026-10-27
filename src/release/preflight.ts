'use strict';

// Local release checks for a tagged package cut. No registry state is changed.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REPO_ROOT } = require('../helper/repo-root.ts');
const { parseSemVer, compareSemVer } = require('../helper/semver.ts');
const { changelogSection } = require('./changelog-section.ts');
const { releaseWorkflowFindings } = require('./release-workflow.ts');

const PACKAGE_NAME = '@khoavu882/doflow';
const PLUGIN_MANIFESTS = [
  'core/.codex-plugin/plugin.json',
  'core/.claude-plugin/plugin.json',
  'core/.plugin/plugin.json',
];
const RELEASE_TAG_PATTERN = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

type Check = { id: string, ok: boolean, skipped?: boolean, message: string };

function addCheck(checks: Check[], id: string, ok: boolean, message: string, skipped = false): void {
  checks.push({ id, ok, message, ...(skipped ? { skipped: true } : {}) });
}

function readJson(fsImpl: typeof fs, file: string): any {
  return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
}

function offlineError(error: any): boolean {
  const detail = `${error?.code || ''} ${error?.message || ''} ${String(error?.stderr || '')}`;
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|ECONNRESET|ENETUNREACH|network|offline/i.test(detail);
}

function releaseChannel(version: string): 'beta' | 'latest' {
  const parsed = parseSemVer(version);
  return parsed && parsed.prerelease.length > 0 ? 'beta' : 'latest';
}

function namedMergeIds(subjects: string): string[] {
  const ids = new Set<string>();
  for (const subject of subjects.split(/\r?\n/)) {
    const match = subject.match(/^merge: (\d{3}[a-z]?(?:-[A-Z]+)?)\b/);
    if (match) ids.add(match[1]);
  }
  return [...ids];
}

function hasToken(text: string, token: string): boolean {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?<![A-Za-z0-9-])' + escaped + '(?![A-Za-z0-9])').test(text);
}

function previousReleaseTag(tagsText: string, cutTag: string): string | null {
  const tags = tagsText.split(/\r?\n/).map((tag) => tag.trim()).filter((tag) =>
    tag !== cutTag && RELEASE_TAG_PATTERN.test(tag) && parseSemVer(tag.slice(1)) !== null);
  let previous: string | null = null;
  for (const tag of tags) {
    if (!previous || compareSemVer(tag.slice(1), previous.slice(1))! > 0) previous = tag;
  }
  return previous;
}

function addChangelogMergeCheck({
  checks,
  repoRoot,
  cutTag,
  section,
  execFileSyncImpl,
}: {
  checks: Check[],
  repoRoot: string,
  cutTag: string | null,
  section: string | null,
  execFileSyncImpl: typeof execFileSync,
}): void {
  if (!section) {
    addCheck(checks, 'changelog-names-merges', true,
      'skipped (no non-empty changelog section to check)', true);
    return;
  }

  try {
    const tags = String(execFileSyncImpl('git', ['tag', '--merged', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));
    const previous = previousReleaseTag(tags, cutTag || '');
    if (!previous) {
      addCheck(checks, 'changelog-names-merges', true,
        'skipped (no earlier release tag is merged into HEAD)', true);
      return;
    }

    const subjects = String(execFileSyncImpl('git', [
      'log', '--merges', '--format=%s', previous + '..HEAD',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));
    const missing = namedMergeIds(subjects).filter((id) => !hasToken(section, id));
    addCheck(checks, 'changelog-names-merges', missing.length === 0,
      missing.length
        ? `CHANGELOG section for ${cutTag || '(release)'} must name merged feature ids: ${missing.join(', ')}`
        : `CHANGELOG section for ${cutTag || '(release)'} names every merged feature id`);
  } catch (error: any) {
    addCheck(checks, 'changelog-names-merges', false,
      `could not inspect release merge ids: ${String(error.message).split('\n')[0]}`);
  }
}

/**
 * Evaluates the local release preflight. The command runner is injectable so fixtures never use
 * Git or npm and cannot contact the network.
 */
function runPreflight({
  repoRoot = REPO_ROOT,
  tag: requestedTag = null,
  offline = false,
  tagPushed = false,
  allowStable = false,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
}: {
  repoRoot?: string,
  tag?: string | null,
  offline?: boolean,
  tagPushed?: boolean,
  allowStable?: boolean,
  fsImpl?: typeof fs,
  execFileSyncImpl?: typeof execFileSync,
} = {}): { ok: boolean, checks: Check[] } {
  const checks: Check[] = [];
  let packageJson: any = null;
  let packageError: any = null;
  try {
    packageJson = readJson(fsImpl, path.join(repoRoot, 'package.json'));
    if (typeof packageJson.version !== 'string' || packageJson.version.trim() === '') {
      throw new Error('package.json has no version');
    }
  } catch (error: any) {
    packageError = error;
  }
  const version: string | null = packageJson?.version || null;
  const tag = requestedTag || (version ? 'v' + version : null);

  if (!packageError) {
    const mismatches: string[] = [];
    for (const rel of PLUGIN_MANIFESTS) {
      try {
        if (readJson(fsImpl, path.join(repoRoot, rel)).version !== version) mismatches.push(rel);
      } catch {
        mismatches.push(rel);
      }
    }
    addCheck(checks, 'manifest-versions', mismatches.length === 0,
      mismatches.length ? `version mismatch or unreadable manifest: ${mismatches.join(', ')}`
        : `package.json and all three plugin manifests are ${version}`);
  } else {
    addCheck(checks, 'manifest-versions', false, `cannot read package version: ${packageError.message}`);
  }

  const tagMatches = Boolean(version && tag === 'v' + version);
  addCheck(checks, 'tag-matches-version', tagMatches,
    tagMatches ? `${tag} matches package.json ${version}`
      : `requested tag ${tag || '(none)'} must be v${version || '(unavailable)'}`);

  if (tagPushed) {
    if (!tag) {
      addCheck(checks, 'tag-at-head', false, 'no release tag can be derived without package.json version');
    } else {
      try {
        const taggedCommit = String(execFileSyncImpl('git', [
          'rev-parse', '--verify', tag + '^{commit}',
        ], { cwd: repoRoot, encoding: 'utf8' })).trim();
        const headCommit = String(execFileSyncImpl('git', ['rev-parse', 'HEAD'], {
          cwd: repoRoot,
          encoding: 'utf8',
        })).trim();
        const atHead = taggedCommit !== '' && headCommit !== '' && taggedCommit === headCommit;
        addCheck(checks, 'tag-at-head', atHead,
          atHead ? `${tag} resolves to HEAD (${headCommit})`
            : `${tag} must resolve to HEAD (tag: ${taggedCommit || '(unavailable)'}, HEAD: ${headCommit || '(unavailable)'})`);
      } catch (error: any) {
        addCheck(checks, 'tag-at-head', false, `could not verify release tag at HEAD: ${error.message}`);
      }
    }
  } else if (tag) {
    try {
      const tags = String(execFileSyncImpl('git', ['tag', '--list'], { cwd: repoRoot, encoding: 'utf8' }));
      const exists = tags.split(/\r?\n/).some((entry) => entry.trim() === tag);
      addCheck(checks, 'tag-unused', !exists,
        exists ? `${tag} already exists locally` : `${tag} is not an existing local tag`);
    } catch (error: any) {
      addCheck(checks, 'tag-unused', false, `could not inspect local tags: ${error.message}`);
    }
  } else {
    addCheck(checks, 'tag-unused', false, 'no release tag can be derived without package.json version');
  }

  const parsedVersion = version ? parseSemVer(version) : null;
  const stableAllowed = Boolean(parsedVersion?.prerelease.length) || allowStable;
  addCheck(checks, 'stable-allowed', stableAllowed,
    stableAllowed ? `version ${version || '(unavailable)'} is permitted for this cut`
      : `stable releases require --allow-stable (version ${version || '(unavailable)'})`);

  if (offline) {
    addCheck(checks, 'npm-unpublished', true,
      'skipped (--offline; registry publication state was not checked)', true);
  } else if (!version) {
    addCheck(checks, 'npm-unpublished', false, 'cannot check publication state without package.json version');
  } else {
    try {
      const output = execFileSyncImpl('npm', ['view', PACKAGE_NAME, 'versions', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      const publishedVersions = JSON.parse(String(output));
      if (!Array.isArray(publishedVersions)) throw new Error('npm view did not return a version list');
      const published = publishedVersions.includes(version);
      addCheck(checks, 'npm-unpublished', !published,
        published ? `${PACKAGE_NAME}@${version} is already published`
          : `${PACKAGE_NAME}@${version} is not published`);
    } catch (error: any) {
      if (offlineError(error)) {
        addCheck(checks, 'npm-unpublished', true,
          `skipped (registry unavailable: ${String(error.message).split('\n')[0]})`, true);
      } else {
        addCheck(checks, 'npm-unpublished', false, `could not check npm publication state: ${String(error.message).split('\n')[0]}`);
      }
    }
  }

  if (offline) {
    addCheck(checks, 'version-ahead', true,
      'skipped (--offline; registry dist-tags were not checked)', true);
  } else if (!version) {
    addCheck(checks, 'version-ahead', false, 'cannot check channel ordering without package.json version');
  } else {
    const channel = releaseChannel(version);
    try {
      const output = execFileSyncImpl('npm', ['view', PACKAGE_NAME, 'dist-tags', '--json'], {
        cwd: repoRoot,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
      });
      const distTags = JSON.parse(String(output));
      if (!distTags || typeof distTags !== 'object' || Array.isArray(distTags)) {
        throw new Error('npm view did not return a dist-tag object');
      }
      const channelVersion = distTags[channel];
      if (channelVersion === undefined || channelVersion === null || channelVersion === '') {
        addCheck(checks, 'version-ahead', true, `npm ${channel} dist-tag is not set`);
      } else {
        const order = compareSemVer(version, String(channelVersion));
        const ahead = order !== null && order > 0;
        addCheck(checks, 'version-ahead', ahead,
          ahead ? `${version} is ahead of npm ${channel} ${channelVersion}`
            : `${version} must be greater than npm ${channel} ${channelVersion} by SemVer precedence`);
      }
    } catch (error: any) {
      if (offlineError(error)) {
        addCheck(checks, 'version-ahead', true,
          `skipped (registry unavailable: ${String(error.message).split('\n')[0]})`, true);
      } else {
        addCheck(checks, 'version-ahead', false,
          `could not check npm ${channel} dist-tag: ${String(error.message).split('\n')[0]}`);
      }
    }
  }

  let section: string | null = null;
  if (version) {
    try {
      const changelog = fsImpl.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
      section = changelogSection(changelog, tag || version);
      addCheck(checks, 'changelog', section !== null,
        section !== null ? `non-empty CHANGELOG section exists for ${version}`
          : `no non-empty CHANGELOG section exists for ${version}`);
    } catch (error: any) {
      addCheck(checks, 'changelog', false, `could not read CHANGELOG.md: ${String(error.message).split('\n')[0]}`);
    }
  } else {
    addCheck(checks, 'changelog', false, 'cannot check CHANGELOG without package.json version');
  }

  addChangelogMergeCheck({ checks, repoRoot, cutTag: tag, section, execFileSyncImpl });

  try {
    const workflow = fsImpl.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    const nodeFloor = String(packageJson?.engines?.node ?? '').match(/\d+\.\d+\.\d+/)?.[0] ?? null;
    const findings = releaseWorkflowFindings(workflow, { nodeFloor });
    addCheck(checks, 'release-workflow', findings.length === 0,
      findings.length ? findings.join('; ') : 'release workflow satisfies R1-R14');
  } catch (error: any) {
    addCheck(checks, 'release-workflow', false,
      `could not read release workflow: ${String(error.message).split('\n')[0]}`);
  }

  try {
    const status = String(execFileSyncImpl('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }));
    const clean = status.trim() === '';
    addCheck(checks, 'clean-tree', clean,
      clean ? 'working tree is clean' : 'working tree has tracked or untracked changes');
  } catch (error: any) {
    addCheck(checks, 'clean-tree', false, `could not inspect working tree: ${error.message}`);
  }

  return { ok: checks.every((check) => check.ok || check.skipped), checks };
}

function parseArgs(args: string[]): {
  tag: string | null,
  offline: boolean,
  tagPushed: boolean,
  allowStable: boolean,
} {
  let tag: string | null = null;
  let offline = false;
  let tagPushed = false;
  let allowStable = false;
  const usage = 'usage: node src/release/preflight.ts [--tag vX] [--offline] [--tag-pushed] [--allow-stable]';
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--offline') {
      offline = true;
    } else if (args[index] === '--tag-pushed') {
      tagPushed = true;
    } else if (args[index] === '--allow-stable') {
      allowStable = true;
    } else if (args[index] === '--tag' && args[index + 1] && !args[index + 1].startsWith('--')) {
      tag = args[++index];
    } else {
      throw new Error(usage);
    }
  }
  return { tag, offline, tagPushed, allowStable };
}

if (require.main === module) {
  let options: {
    tag: string | null,
    offline: boolean,
    tagPushed: boolean,
    allowStable: boolean,
  } | undefined;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error: any) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
  if (options) {
    const result = runPreflight(options);
    for (const check of result.checks) {
      const status = check.skipped ? 'SKIP' : check.ok ? 'PASS' : 'FAIL';
      process.stdout.write(`${status} ${check.id}: ${check.message}\n`);
    }
    if (!result.ok) process.exitCode = 1;
  }
}

module.exports = { parseArgs, runPreflight };
