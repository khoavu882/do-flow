'use strict';

/**
 * Feature status deriver (IC-021, DEC-022, DEC-044, DEC-030, DEC-035). A tracked feature is
 * `finished`, `awaiting-release`, `in-progress` or `unknown`, derived on every read from git and the
 * release records, and never written. A later read can change a status (design R9).
 *
 * The git facts that are not about one feature (the integration ref, the feature branch prefixes,
 * the release tags and the base tag) come from `do-git-state.sh --lifecycle`, so bash and Node never
 * derive them twice. The rest is a fixed number of plain `git` calls, however many features are
 * tracked: one `rev-parse` pins the ref, one `for-each-ref` lists the branches, one
 * `git log --first-parent --merges` lists the merges, one `git tag --list` (tagged mode) gives the
 * release tags' commits, and one `git rev-list --parents` reads the commit graph of the pinned ref
 * and those tags. Every ancestry question (which merge brought a branch tip in, which tag contains a
 * merge) is then answered from that graph in memory, not by a git call per feature.
 *
 * Nothing here writes, fetches or reaches a network.
 *
 * Accepted ceilings, stated rather than hidden: a feature's merge evidence is only as good as the
 * merge commit's subject and the branch name (a squash, a rebase and a fast-forward leave none,
 * so they reach the user through `notDetected` and `lifecycle --action merged`); the merge log and
 * the graph are read in full, without `--since` or a lower cut (a skewed clock must not hide a
 * merge), so their cost grows with the history of the integration ref, once per call; git dates
 * have one-second resolution, so the lower bound is floored to the second.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { REPO_ROOT } = require('../../helper/repo-root');
const { resolveBashHelper } = require('../../helper/bash-helper');

const MAX_BUFFER = 256 * 1024 * 1024;

/** Where `do-git-state.sh` is: the shared resolver (package copy first, else the one projected beside the runtime). */
function resolveGitStateHelper(repoRoot = REPO_ROOT, existsImpl = fs.existsSync) {
  return resolveBashHelper('do-git-state.sh', repoRoot, existsImpl);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
}

/**
 * The facts from `do-git-state.sh --lifecycle`, read in `root`; `runtimeRoot` is where the runtime
 * lives, which only a test moves.
 * @returns {{integration_ref:string|null, feature_prefixes:string[], release_tags:string[], base_tag:string|null}
 *   |{error:string}}
 */
function readGitFacts(root, runtimeRoot = REPO_ROOT) {
  const helper = resolveGitStateHelper(runtimeRoot);
  if (!helper) return { error: 'git-state-helper-missing' };
  try {
    const out = execFileSync('bash', [helper, '--lifecycle'], { cwd: root, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] });
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

/** Branch refs by short name (`feat/x`, `origin/feat/x`) with their tips; local branches first. */
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

/** The commit a tag names, peeled through any number of tag objects, or null when it is no commit. */
function peelTag(root, refname) {
  try { return git(root, ['rev-parse', '--verify', '--quiet', `${refname}^{commit}`]).trim() || null; } catch { return null; }
}

/**
 * The `v*` tags named in `wanted` with their commits, in the order `git tag` lists them (it honours
 * `tag.sort`, as `git tag --contains` did), so the first containing tag is the one it would name.
 * @returns {Array<{name:string, commit:string|null}>}
 */
function readTagCommits(root, wanted) {
  const out = git(root, ['tag', '--list', 'v*', '--format=%(refname)%09%(objecttype)%09%(objectname)%09%(*objecttype)%09%(*objectname)']);
  const tags = [];
  for (const line of out.split('\n').filter(Boolean)) {
    const [refname, type, object, peeledType, peeled] = line.split('\t');
    const name = refname.slice('refs/tags/'.length);
    if (!wanted.has(name)) continue;
    let commit = null;
    if (type === 'commit') commit = object;
    else if (type === 'tag' && peeledType === 'commit') commit = peeled;
    else if (type === 'tag') commit = peelTag(root, refname); // a tag of a tag: rare, one call each
    tags.push({ name, commit });
  }
  return tags;
}

/**
 * The commit graph reachable from `pinned` and `revs`, read by one `git rev-list --parents`, with the
 * ancestry questions the status and the release ask answered in memory.
 *
 * The first-parent chain of `pinned` is numbered oldest first. Each commit is marked with the oldest
 * chain commit whose history holds it (its `introducer`): for a commit that came in through a merge
 * that is the merge, and for a commit on the chain it is the commit itself. Each commit also knows the
 * newest chain commit in its own history (`chainMax`), so "is chain commit C an ancestor of X" is one
 * comparison: the chain commits in X's history are always a prefix of the chain.
 *
 * Every commit asked about must be in the read: `pinned`, one of `revs`, or an ancestor of one.
 * @param {string} root
 * @param {string} pinned a full commit sha
 * @param {string[]} [revs] further full commit shas whose history is read too
 */
function readHistory(root, pinned, revs = []) {
  const input = `${[pinned, ...revs].join('\n')}\n`;
  const out = execFileSync('git', ['rev-list', '--parents', '--topo-order', '--stdin'], { cwd: root, input, encoding: 'utf8', maxBuffer: MAX_BUFFER, stdio: ['pipe', 'pipe', 'ignore'] });
  const parents = new Map();
  const order = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [sha, ...rest] = line.split(' ');
    parents.set(sha, rest);
    order.push(sha);
  }
  const chain = [];
  for (let sha = pinned; parents.has(sha); sha = parents.get(sha)[0]) chain.push(sha);
  chain.reverse();
  const chainIndex = new Map(chain.map((sha, i) => [sha, i]));

  const introducer = new Map();
  for (const head of chain) {
    const stack = [head];
    while (stack.length) {
      const sha = stack.pop();
      if (introducer.has(sha) || !parents.has(sha)) continue;
      introducer.set(sha, head);
      stack.push(...parents.get(sha));
    }
  }

  // --topo-order lists no parent before its children, so walking it backwards meets parents first.
  const chainMax = new Map();
  for (let i = order.length - 1; i >= 0; i -= 1) {
    const sha = order[i];
    let max = chainIndex.has(sha) ? chainIndex.get(sha) : -1;
    if (max === -1) for (const parent of parents.get(sha)) max = Math.max(max, chainMax.get(parent) ?? -1);
    chainMax.set(sha, max);
  }

  const reached = new Map();
  function ancestorsOf(sha) {
    let seen = reached.get(sha);
    if (seen) return seen;
    seen = new Set();
    const stack = [sha];
    while (stack.length) {
      const next = stack.pop();
      if (seen.has(next) || !parents.has(next)) continue;
      seen.add(next);
      stack.push(...parents.get(next));
    }
    reached.set(sha, seen);
    return seen;
  }

  return {
    /** The chain commit that brought `sha` into `pinned`'s history, or undefined when it is not in it. */
    introducer: (sha) => introducer.get(sha),
    /** `a` is `b` or an ancestor of it; `a` must be in the read. */
    isAncestor(a, b) {
      const index = chainIndex.get(a);
      if (index !== undefined) return index <= (chainMax.get(b) ?? -1);
      return ancestorsOf(b).has(a);
    },
  };
}

/**
 * The merge that brought `tip` into the chain, if the evidence rule holds: the oldest first-parent
 * merge having the tip as an ancestor, committed at or after the lower bound, with the tip on a
 * non-first parent and not already on the first. A tip that lies on the first-parent chain itself
 * (a fast-forward, or a branch with no commits of its own) is its own introducer, so it never counts;
 * a tip the merge holds but its first parent does not came in on a non-first parent.
 */
function introducingMerge(history, mergeBySha, tip, lowerBound) {
  const merge = mergeBySha.get(history().introducer(tip));
  if (!merge || merge.sha === tip || merge.ct < lowerBound) return null;
  return merge;
}

/** Evidence of a merge of `slug` into the pinned ref, tried in IC-021's order, or null. */
function findEvidence({ slug, lowerBound, merges, mergeBySha, newestCt, history, tips, prefixes, confirmed }) {
  const branchNames = new Set(prefixes.map((prefix) => `${prefix}/${slug}`));
  // No merge is recent enough for this feature: no branch can have one, so the graph need not be read for it.
  const branchTips = newestCt < lowerBound ? [] : tips.filter((t) => branchNames.has(t.local));
  for (const tip of branchTips) {
    const merge = introducingMerge(history, mergeBySha, tip.sha, lowerBound);
    if (merge) return { kind: 'branch', ref: tip.short, commit: merge.sha };
  }
  for (let i = merges.length - 1; i >= 0; i -= 1) {
    if (merges[i].ct >= lowerBound && subjectNames(merges[i].subject, slug)) return { kind: 'merge-subject', ref: merges[i].sha.slice(0, 7), commit: merges[i].sha };
  }
  if (confirmed) return { kind: 'confirmed', ref: null, commit: null };
  return null;
}

/** A value computed on first use, so a call that needs no graph never reads one. */
function lazy(make) {
  let value;
  let made = false;
  return () => {
    if (!made) { value = make(); made = true; }
    return value;
  };
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
 *   integrationSha:string|null (the commit the ref was pinned to; absent when nothing was derived),
 *   evidenceCommits:Object<string,string|null> (slug to the full merge commit of its evidence; absent when nothing was derived),
 *   statuses:Object<string,{status:string, evidence:{kind:string,ref:string|null}|null, release:string|null}>,
 *   features:Object<string,string[]>, notDetected:string[],
 *   failure?:'git-state-failed' (git itself failed while deriving: an environment fault the caller refuses on)}}
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
  if (tracked.length === 0) {
    let sha = null;
    try { sha = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim(); } catch { /* the ref does not name a commit */ }
    return { ...result(releaseMode, ref, null, {}, [], behind), integrationSha: sha, evidenceCommits: {} };
  }

  try {
    // Pin the ref once: every query below names the same commit.
    const pinned = git(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
    const merges = readMerges(root, pinned);
    const mergeBySha = new Map(merges.map((m) => [m.sha, m]));
    const newestCt = merges.reduce((max, m) => Math.max(max, m.ct), -Infinity);
    const tips = readBranchTips(root);
    const mergedSlugs = new Set(fold.merged.map((m) => m.slug));
    const recorded = new Map();
    for (const release of fold.releases) for (const f of release.features) if (!recorded.has(f.slug)) recorded.set(f.slug, release.tag);
    const recordedTags = new Set(fold.releases.map((r) => r.tag));
    const unrecordedTags = new Set(facts.release_tags.filter((tag) => !recordedTags.has(tag)));
    // Only a tag with no release record can finish a feature by containment (DEC-030), so only those are read.
    const tags = lazy(() => (releaseMode === 'tagged' && unrecordedTags.size > 0 ? readTagCommits(root, unrecordedTags) : []));
    const history = lazy(() => readHistory(root, pinned, tags().map((t) => t.commit).filter(Boolean)));

    const statuses = {};
    const evidenceCommits = {};
    const notDetected = [];
    for (const feature of tracked) {
      const lowerBound = Math.floor(Date.parse(feature.trackedAt) / 1000);
      const evidence = findEvidence({
        slug: feature.slug, lowerBound, merges, mergeBySha, newestCt, history, tips, prefixes: facts.feature_prefixes, confirmed: mergedSlugs.has(feature.slug),
      });
      const shown = evidence && { kind: evidence.kind, ref: evidence.ref };
      evidenceCommits[feature.slug] = evidence ? evidence.commit : null;
      let status;
      let release = null;
      if (releaseMode === 'untagged') {
        status = evidence ? 'finished' : 'in-progress';
      } else if (recorded.has(feature.slug)) {
        // A record finishes the feature by itself: no containment is looked for.
        status = 'finished';
        release = recorded.get(feature.slug);
      } else {
        // DEC-030: a merge inside a `v*` tag that has no release record also finishes the feature. A
        // tag with a record uses only that record, and a feature excluded from it is already outside it.
        // The evidence commit is a first-parent merge of the pinned ref, so it is in the graph read.
        const containing = evidence && evidence.commit && unrecordedTags.size > 0
          ? tags().filter((t) => t.commit && history().isAncestor(evidence.commit, t.commit)).map((t) => t.name)
          : [];
        if (containing.length > 0) { status = 'finished'; release = containing[0]; }
        else status = evidence ? 'awaiting-release' : 'in-progress';
      }
      if (status === 'in-progress') notDetected.push(feature.slug);
      statuses[feature.slug] = { status, evidence: shown, release };
    }
    // `integrationSha` and `evidenceCommits` are for the release preview, which must use the very commit
    // pinned here (DEC-044) and the full merge commit an evidence names, not its 7-character `ref`.
    return { ...result(releaseMode, ref, null, statuses, notDetected, behind), integrationSha: pinned, evidenceCommits };
  } catch (error) {
    // A git failure is an environment fault, not a DoFlow defect: it is reported, never thrown.
    // `failure` lets a caller refuse instead of showing the unknown statuses as an answer.
    return { ...unknown(`git could not answer (git-state-failed): ${String(error.message).split('\n')[0]}`), failure: 'git-state-failed' };
  }
}

module.exports = { deriveStatuses, readGitFacts, resolveGitStateHelper, bucketize, subjectNames, behindNote, readMerges, readBranchTips, readHistory };
