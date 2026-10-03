'use strict';

/**
 * Feature status deriver (IC-021, DEC-022, DEC-029, DEC-030, DEC-035). A tracked feature is
 * `finished`, `awaiting-release`, `in-progress` or `unknown`, derived on every read from git and the
 * release records, and never written. A later read can change a status (design R9).
 *
 * The git facts that are not about one feature (the integration ref, the feature branch prefixes,
 * the release tags and the base tag) come from `do-git-state.sh --lifecycle`, so bash and Node never
 * derive them twice. The rest is a bounded number of plain `git` calls: one `for-each-ref`, one
 * `git log --first-parent --merges` over the pinned ref, and for each candidate branch a binary
 * search over those merges, so a repository with many merges costs a logarithmic number of
 * ancestry tests per branch rather than one per merge.
 *
 * Nothing here writes, fetches or reaches a network.
 *
 * Accepted ceilings, stated rather than hidden: a feature's merge evidence is only as good as the
 * merge commit's subject and the branch name (a squash, a rebase and a fast-forward leave none,
 * so they reach the user through `notDetected` and `lifecycle --action merged`); the merge log is
 * read in full, so its cost grows with the first-parent merges of the integration ref; git dates
 * have one-second resolution, so the lower bound is floored to the second.
 */

const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../../helper/repo-root');

const GIT_STATE = path.join(REPO_ROOT, 'core', 'shared', 'scripts', 'doflow', 'bash', 'do-git-state.sh');
const MAX_BUFFER = 256 * 1024 * 1024;

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** `git merge-base --is-ancestor a b`: true when `a` is an ancestor of (or equal to) `b`. */
function isAncestor(root, a, b) {
  const run = spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root, stdio: 'ignore' });
  if (run.status === 0) return true;
  if (run.status === 1) return false;
  throw new Error(`git merge-base --is-ancestor ${a} ${b} failed`);
}

/**
 * The facts from `do-git-state.sh --lifecycle`.
 * @returns {{integration_ref:string|null, feature_prefixes:string[], release_tags:string[], base_tag:string|null}
 *   |{error:string}}
 */
function readGitFacts(root) {
  try {
    const out = execFileSync('bash', [GIT_STATE, '--lifecycle'], { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
    const facts = JSON.parse(out);
    if (facts.error) return { error: facts.error };
    return facts;
  } catch (error) {
    return { error: error.code === 'ENOENT' ? 'bash-not-found' : 'git-state-failed' };
  }
}

function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** The slug appears in the subject bounded by its ends or by characters outside `[a-z0-9-]`. */
function subjectNames(subject, slug) {
  return new RegExp(`(?:^|[^a-z0-9-])${escapeRegExp(slug)}(?:$|[^a-z0-9-])`).test(subject);
}

/** First-parent merges of `ref`, oldest first. */
function readMerges(root, ref) {
  const out = git(root, ['log', '--first-parent', '--merges', '--format=%H%x09%P%x09%ct%x09%s', ref]);
  return out.split('\n').filter(Boolean).map((line) => {
    const [sha, parents, ct, ...subject] = line.split('\t');
    return { sha, parents: parents.split(' ').filter(Boolean), ct: Number(ct), subject: subject.join('\t') };
  }).reverse();
}

/** Branch refs by short name (`feat/x`, `origin/feat/x`) with their tips. */
function readBranchTips(root) {
  const out = git(root, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes']);
  const tips = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [refname, sha] = line.split('\t');
    if (refname.startsWith('refs/heads/')) tips.push({ short: refname.slice('refs/heads/'.length), local: refname.slice('refs/heads/'.length), sha });
    else if (refname.startsWith('refs/remotes/')) {
      const short = refname.slice('refs/remotes/'.length);
      tips.push({ short, local: short.slice(short.indexOf('/') + 1), sha });
    }
  }
  return tips;
}

/**
 * The merge that brought `tip` into the chain, if the evidence rule holds: the oldest first-parent
 * merge having the tip as an ancestor, committed at or after the lower bound, with the tip on a
 * non-first parent and not already on the first. A tip that lies on the first-parent chain itself
 * (a fast-forward, or a branch with no commits of its own) has the tip as an ancestor of that
 * merge's first parent too, so it never counts.
 */
function introducingMerge(root, merges, tip, lowerBound) {
  if (merges.length === 0 || !isAncestor(root, tip, merges[merges.length - 1].sha)) return null;
  // `tip is an ancestor of merge i` only turns true along the chain, so the first true one can be found by halving.
  let lo = 0;
  let hi = merges.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (isAncestor(root, tip, merges[mid].sha)) hi = mid; else lo = mid + 1;
  }
  const merge = merges[lo];
  if (merge.ct < lowerBound) return null;
  const [first, ...others] = merge.parents;
  if (isAncestor(root, tip, first)) return null;
  return others.some((parent) => isAncestor(root, tip, parent)) ? merge : null;
}

/** Evidence of a merge of `slug` into the pinned ref, tried in IC-021's order, or null. */
function findEvidence(root, { slug, lowerBound, merges, tips, prefixes, confirmed }) {
  const branchNames = new Set(prefixes.map((prefix) => `${prefix}/${slug}`));
  for (const tip of tips.filter((t) => branchNames.has(t.local))) {
    const merge = introducingMerge(root, merges, tip.sha, lowerBound);
    if (merge) return { kind: 'branch', ref: tip.short, commit: merge.sha };
  }
  for (let i = merges.length - 1; i >= 0; i -= 1) {
    if (merges[i].ct >= lowerBound && subjectNames(merges[i].subject, slug)) return { kind: 'merge-subject', ref: merges[i].sha.slice(0, 7), commit: merges[i].sha };
  }
  if (confirmed) return { kind: 'confirmed', ref: null, commit: null };
  return null;
}

const BUCKET = { finished: 'finished', 'awaiting-release': 'awaitingRelease', 'in-progress': 'inProgress', unknown: 'unknown' };

function emptyBuckets() { return { finished: [], awaitingRelease: [], inProgress: [], unknown: [] }; }

/** Slugs grouped in the four buckets IC-007 and IC-022 show. */
function bucketize(statuses, slugs = Object.keys(statuses)) {
  const buckets = emptyBuckets();
  for (const slug of slugs) {
    const entry = statuses[slug];
    if (entry) buckets[BUCKET[entry.status]].push(slug);
  }
  return buckets;
}

function result(releaseMode, integrationRef, reason, statuses, notDetected = [], behind = 0) {
  return { releaseMode, integrationRef, integrationBehind: behind, reason, statuses, features: bucketize(statuses), notDetected };
}

/** The one-line note a stale local integration branch earns (DEC-044), or null. */
function behindNote(ref, behind) {
  return behind > 0
    ? `local ${ref} is ${behind} commit${behind === 1 ? '' : 's'} behind origin/${ref}; a merge that exists only on origin is not seen until you pull`
    : null;
}

/**
 * Derives the status of every tracked feature.
 *
 * @param {Object} options
 * @param {string} options.root the IC-001 root, where git is run
 * @param {Object} options.fold a fold result (tracked features, merge confirmations, release records)
 * @param {Object} [options.facts] `readGitFacts` output, for a caller that already has it
 * @returns {{releaseMode:'tagged'|'untagged'|'unknown', integrationRef:string|null, integrationBehind:number, reason:string|null,
 *   statuses:Object<string,{status:string, evidence:{kind:string,ref:string|null}|null, release:string|null}>,
 *   features:Object<string,string[]>, notDetected:string[]}}
 */
function deriveStatuses({ root, fold, facts = readGitFacts(root) }) {
  const tracked = fold.features;
  const unknown = (reason) => result('unknown', facts.integration_ref ?? null, reason,
    Object.fromEntries(tracked.map((f) => [f.slug, { status: 'unknown', evidence: null, release: null }])));
  if (facts.error) return unknown(`git facts unavailable: ${facts.error}`);
  if (!facts.integration_ref) return unknown('no integration ref resolves (develop, main, master, origin/HEAD)');

  const ref = facts.integration_ref;
  const releaseMode = facts.release_tags.length > 0 ? 'tagged' : 'untagged';
  const behind = Number(facts.integration_local_behind_remote) || 0;
  if (tracked.length === 0) return result(releaseMode, ref, null, {}, [], behind);

  try {
    // Pin the ref once: every query below names the same commit.
    const pinned = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    const merges = readMerges(root, pinned);
    const tips = readBranchTips(root);
    const mergedSlugs = new Set(fold.merged.map((m) => m.slug));
    const recorded = new Map();
    for (const release of fold.releases) for (const f of release.features) if (!recorded.has(f.slug)) recorded.set(f.slug, release.tag);
    const recordedTags = new Set(fold.releases.map((r) => r.tag));
    const unrecordedTags = new Set(facts.release_tags.filter((tag) => !recordedTags.has(tag)));

    const statuses = {};
    const notDetected = [];
    for (const feature of tracked) {
      const lowerBound = Math.floor(Date.parse(feature.trackedAt) / 1000);
      const evidence = findEvidence(root, {
        slug: feature.slug, lowerBound, merges, tips, prefixes: facts.feature_prefixes, confirmed: mergedSlugs.has(feature.slug),
      });
      const shown = evidence && { kind: evidence.kind, ref: evidence.ref };
      let status;
      let release = null;
      if (releaseMode === 'untagged') {
        status = evidence ? 'finished' : 'in-progress';
      } else if (recorded.has(feature.slug)) {
        status = 'finished';
        release = recorded.get(feature.slug);
      } else {
        // DEC-030: a merge inside a `v*` tag that has no release record also finishes the feature. A
        // tag with a record uses only that record, and a feature excluded from it is already outside it.
        const containing = evidence && evidence.commit
          ? git(root, ['tag', '--contains', evidence.commit, '--list', 'v*']).split('\n').filter((tag) => unrecordedTags.has(tag))
          : [];
        if (containing.length > 0) { status = 'finished'; release = containing[0]; }
        else status = evidence ? 'awaiting-release' : 'in-progress';
      }
      if (status === 'in-progress') notDetected.push(feature.slug);
      statuses[feature.slug] = { status, evidence: shown, release };
    }
    return result(releaseMode, ref, null, statuses, notDetected, behind);
  } catch (error) {
    return unknown(`git could not answer: ${String(error.message).split('\n')[0]}`);
  }
}

module.exports = { deriveStatuses, readGitFacts, bucketize, subjectNames, behindNote };
