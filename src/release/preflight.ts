'use strict';

// Local release checks for a tagged package cut. No registry state is changed.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REPO_ROOT } = require('../helper/repo-root.ts');
const { changelogSection } = require('./changelog-section.ts');

const PACKAGE_NAME = '@khoavu882/doflow';
const PLUGIN_MANIFESTS = [
  'core/.codex-plugin/plugin.json',
  'core/.claude-plugin/plugin.json',
  'core/.plugin/plugin.json',
];

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

function publishPolicyValid(workflow: string): boolean {
  const publishStep = workflow.slice(workflow.indexOf('- name: Publish'));
  const match = publishStep.match(/case\s+"\$GITHUB_REF_NAME"\s+in([\s\S]*?)\besac\b/);
  if (!match) return false;
  const prerelease = match[1].match(/(?:^|\n)\s*\*-\*\)([\s\S]*?)\s*;;/);
  const stable = match[1].match(/(?:^|\n)\s*\*\)([\s\S]*?)\s*;;/);
  if (!prerelease || !stable) return false;
  const prereleaseBody = prerelease[1];
  const stableBody = stable[1];
  return /npm\s+publish\b[\s\S]*--tag\s+beta\b/.test(prereleaseBody)
    && !/--tag\s+latest\b/.test(prereleaseBody)
    && /npm\s+publish\b/.test(stableBody)
    && !/--tag\s+beta\b/.test(stableBody);
}

/**
 * Evaluates the local release preflight. The command runner is injectable so fixtures never use
 * Git or npm and cannot contact the network.
 */
function runPreflight({
  repoRoot = REPO_ROOT,
  tag: requestedTag = null,
  offline = false,
  fsImpl = fs,
  execFileSyncImpl = execFileSync,
}: {
  repoRoot?: string,
  tag?: string | null,
  offline?: boolean,
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
  } catch (error) {
    packageError = error;
  }
  const version = packageJson?.version || null;
  const tag = requestedTag || (version ? `v${version}` : null);

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

  const tagMatches = Boolean(version && tag === `v${version}`);
  addCheck(checks, 'tag-matches-version', tagMatches,
    tagMatches ? `${tag} matches package.json ${version}`
      : `requested tag ${tag || '(none)'} must be v${version || '(unavailable)'}`);

  if (tag) {
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

  if (offline) {
    addCheck(checks, 'npm-unpublished', true, 'skipped (--offline; registry publication state was not checked)', true);
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

  if (version) {
    try {
      const changelog = fsImpl.readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
      const section = changelogSection(changelog, tag || version);
      addCheck(checks, 'changelog', section !== null,
        section !== null ? `non-empty CHANGELOG section exists for ${version}`
          : `no non-empty CHANGELOG section exists for ${version}`);
    } catch (error: any) {
      addCheck(checks, 'changelog', false, `could not read CHANGELOG.md: ${String(error.message).split('\n')[0]}`);
    }
  } else {
    addCheck(checks, 'changelog', false, 'cannot check CHANGELOG without package.json version');
  }

  try {
    const workflow = fsImpl.readFileSync(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8');
    const valid = publishPolicyValid(workflow);
    addCheck(checks, 'publish-dist-tag', valid,
      valid ? 'hyphenated prereleases publish with --tag beta and never latest'
        : 'release workflow must publish hyphenated prereleases with --tag beta and keep them off latest');
  } catch (error: any) {
    addCheck(checks, 'publish-dist-tag', false, `could not read release workflow: ${String(error.message).split('\n')[0]}`);
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

function parseArgs(args: string[]): { tag: string | null, offline: boolean } {
  let tag: string | null = null;
  let offline = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--offline') {
      offline = true;
    } else if (args[i] === '--tag' && args[i + 1] && !args[i + 1].startsWith('--')) {
      tag = args[++i];
    } else {
      throw new Error(`usage: node src/release/preflight.ts [--tag vX] [--offline]`);
    }
  }
  return { tag, offline };
}

if (require.main === module) {
  let options: { tag: string | null, offline: boolean } | undefined;
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
