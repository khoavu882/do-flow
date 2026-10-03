'use strict';

/**
 * `lifecycle --action release` and `--action merged` (IC-020, IC-021, DEC-021, DEC-022, DEC-030,
 * DEC-044). A release is previewed from git and recorded, on `--confirm`, as one local
 * `release.recorded` event; nothing is written into the release commit, nothing is staged or
 * committed, and no ignore rule is written. Each function returns a result object without printing.
 *
 * The integration ref is `facts.integration_ref` from `do-git-state.sh --lifecycle`, the very value
 * the status deriver pins, so a preview before the tag and the overview agree about one ref and this
 * module never resolves a ref a second way.
 *
 * Candidate choice reuses `deriveStatuses` with the release tags minus the tag being recorded: a
 * feature then reads `finished` only when a record names it or an OTHER unrecorded `v*` tag contains
 * its merge (DEC-030), which is the "ignore containment in `--tag`" rule without a change to status.js.
 *
 * Accepted ceiling: `deriveStatuses` hands back the evidence as `{kind, ref}`, not the merge commit,
 * so "evidence into X" is tested on the branch tip (`branch`) or the merge commit (`merge-subject`).
 * A branch whose tip reached X by another route than the merge that introduced it to the integration
 * ref would count; no flow of this tool makes that happen.
 */

const nodeFs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { isSafeSlug, invalidSlugRefusal } = require('../task-scope');
const { appendEvents, readFold } = require('./event-store');
const { deriveStatuses, readGitFacts, behindNote } = require('./status');
const { FollowupUsageError, oneLine, channelBy } = require('./followup');

/** The release-tag pattern of IC-020, the one `git-state` filters by. */
const RELEASE_TAG = /^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

const refusal = (action, finding, message) => ({ ok: false, action, finding, message });

/** Trimmed stdout of a git call, or null when git exits non-zero. */
function gitOut(root, args) {
  const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return run.status === 0 ? run.stdout.trim() : null;
}

function commitOf(root, ref) { return gitOut(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]) || null; }

/** `a` is an ancestor of (or equal to) `b`. */
function isAncestor(root, a, b) {
  return spawnSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: root, stdio: 'ignore' }).status === 0;
}

/** The commit a derived evidence names: a branch tip, a merge commit, or null for a user confirmation. */
function evidenceCommit(root, evidence) {
  if (evidence.kind === 'branch') return commitOf(root, `refs/heads/${evidence.ref}`) || commitOf(root, `refs/remotes/${evidence.ref}`);
  if (evidence.kind === 'merge-subject') return commitOf(root, evidence.ref);
  return null;
}

/**
 * The tag a release follows: the base tag `git-state` proposes versions from, other than `tag`, when
 * it lies in X's history; else the newest `v*` tag other than `tag` merged into X (git's version order).
 */
function previousTagOf(root, { tag, facts, bound }) {
  if (facts.base_tag && facts.base_tag !== tag && isAncestor(root, `refs/tags/${facts.base_tag}`, bound)) return facts.base_tag;
  const known = new Set(facts.release_tags);
  const merged = gitOut(root, ['tag', '--list', 'v*', '--sort=-v:refname', '--merged', bound]);
  return (merged || '').split('\n').find((name) => name && name !== tag && known.has(name)) || null;
}

function slugList(raw, label) {
  const list = [...new Set((Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).map(String))];
  for (const slug of list) if (!isSafeSlug(slug)) throw new FollowupUsageError(`${label}: ${invalidSlugRefusal(slug).message}`);
  return list;
}

/**
 * IC-020. Without `confirm` nothing is written; with it one `release.recorded` event is.
 * @param {Object} options
 * @param {string} options.root the IC-001 root
 * @param {string} options.tag `vX.Y.Z[-pre]`
 * @param {boolean} [options.confirm]
 * @param {string[]} [options.features] `--feature` slugs to add
 * @param {string[]} [options.exclude] `--exclude` slugs to leave out
 * @param {string} [options.channel]
 */
function releaseFeatures({ root, tag, confirm = false, features, exclude, channel, now = new Date(), fsImpl = nodeFs }) {
  if (typeof tag !== 'string' || !RELEASE_TAG.test(tag)) throw new FollowupUsageError(`--tag is required and must look like v1.2.3 or v1.2.3-rc.1 (got '${tag ?? ''}')`);
  const added = slugList(features, '--feature');
  const excluded = slugList(exclude, '--exclude');
  const by = channelBy(channel);

  const facts = readGitFacts(root);
  if (facts.error) return refusal('release', 'no-integration-ref', `git facts are unavailable (${facts.error}), so no release can be previewed or recorded. Nothing was written.`);
  if (!facts.integration_ref) return refusal('release', 'no-integration-ref', 'no integration ref resolves (develop, main, master, origin/HEAD), so no release can be previewed or recorded. Nothing was written.');

  const fold = readFold(root, { fsImpl, now });
  const trackedSlugs = new Set(fold.features.map((f) => f.slug));
  const untracked = added.filter((slug) => !trackedSlugs.has(slug));
  if (untracked.length) {
    return refusal('release', 'untracked-feature', `${untracked.join(', ')} ${untracked.length === 1 ? 'is' : 'are'} not tracked, so ${untracked.length === 1 ? 'it' : 'they'} cannot be added to a release; run doflow-run lifecycle --action init --slug <slug> first. Nothing was written.`);
  }

  // X: the tag's commit once it exists, else the integration ref, which the status view pins too (DEC-044).
  const tagCommit = commitOf(root, `refs/tags/${tag}`);
  const bound = tagCommit || commitOf(root, facts.integration_ref);
  if (!bound) return refusal('release', 'no-integration-ref', `${facts.integration_ref} does not resolve to a commit. Nothing was written.`);
  const previousTag = previousTagOf(root, { tag, facts, bound });
  const previousCommit = previousTag && commitOf(root, `refs/tags/${previousTag}`);

  // DEC-030: containment in the tag being recorded never finishes a feature before its record exists.
  const derived = deriveStatuses({ root, fold, facts: { ...facts, release_tags: facts.release_tags.filter((name) => name !== tag) } });
  if (derived.releaseMode === 'unknown') return refusal('release', 'no-integration-ref', `${derived.reason}. Nothing was written.`);

  const recorded = new Set(fold.releases.flatMap((release) => release.features.map((f) => f.slug)));
  const candidates = [];
  const notDetected = [];
  for (const feature of fold.features) {
    if (recorded.has(feature.slug)) continue;
    const entry = derived.statuses[feature.slug];
    // With another v* tag in play, `finished` here means an unrecorded tag already contains the merge.
    if (derived.releaseMode === 'tagged' && entry.status === 'finished') continue;
    const evidence = entry.evidence;
    if (!evidence) { notDetected.push(feature.slug); continue; }
    if (evidence.kind !== 'confirmed') {
      const commit = evidenceCommit(root, evidence);
      if (!commit || !isAncestor(root, commit, bound)) { notDetected.push(feature.slug); continue; }
      if (previousCommit && isAncestor(root, commit, previousCommit)) continue; // merged before the previous release
    }
    candidates.push({ slug: feature.slug, evidence: evidence.kind, ref: evidence.ref });
  }

  const shipped = [...candidates];
  for (const slug of added) if (!shipped.some((c) => c.slug === slug)) shipped.push({ slug, evidence: 'confirmed', ref: null });
  const finishing = shipped.filter((c) => !excluded.includes(c.slug));
  const finishingSlugs = new Set(finishing.map((c) => c.slug));
  const followupsDone = fold.followups.filter((item) => item.state === 'taken' && finishingSlugs.has(item.takenBy)).map((item) => item.id);

  const base = { ok: true, action: 'release', tag, previousTag, bound: tagCommit ? tag : facts.integration_ref, integrationRef: facts.integration_ref };
  if (derived.integrationBehind > 0) base.note = behindNote(facts.integration_ref, derived.integrationBehind);

  if (!confirm) {
    const addHint = 'add --feature <slug> for a feature listed under notDetected that shipped';
    return {
      ...base, recorded: false, candidates, added, excluded, notDetected, followupsDone,
      next: [tagCommit
        ? `Record it: doflow-run lifecycle --action release --tag ${tag} --confirm (${addHint}; --exclude <slug> leaves one out)`
        : `After git tag ${tag}: doflow-run lifecycle --action release --tag ${tag} --confirm (${addHint})`],
    };
  }
  if (!tagCommit) return refusal('release', 'tag-missing', `${tag} does not exist; create the tag first, then confirm. Nothing was written.`);
  const out = appendEvents(root, [{ type: 'release.recorded', by, data: { tag, commit: tagCommit, features: finishing, excluded } }], { now, fsImpl });
  if (!out.ok) return refusal('release', out.finding, out.message);
  return { ...base, recorded: true, candidates, added, excluded, notDetected, followupsDone, events: out.written.map((w) => w.file), next: [] };
}

/**
 * IC-021 `merged`: the user's confirmation of a merge git cannot show (squash, rebase, fast-forward,
 * cherry-pick). It records an observed fact after the merge, one `feature.merged` event, and the
 * status stays derived from events on read, so nothing is written ahead of the fact (DEC-022).
 */
function recordMerged({ root, slug, reason, channel, now = new Date(), fsImpl = nodeFs }) {
  if (!slug) throw new FollowupUsageError('--slug is required for --action merged');
  if (!isSafeSlug(slug)) throw new FollowupUsageError(invalidSlugRefusal(slug).message);
  const problems = [];
  const cleanReason = reason === undefined ? null : oneLine(reason, '--reason', problems);
  if (!problems.length && !cleanReason) problems.push('--reason is required for --action merged: how the merge happened, for example "squash-merged by hand"');
  if (problems.length) throw new FollowupUsageError(problems.join('; '));
  const by = channelBy(channel);

  const fold = readFold(root, { fsImpl, now });
  if (!fold.features.some((f) => f.slug === slug)) {
    return refusal('merged', 'untracked-feature', `${slug} is not a tracked feature, so no merge can be confirmed for it; run doflow-run lifecycle --action init --slug ${slug} first. Nothing was written.`);
  }
  const before = deriveStatuses({ root, fold }).statuses[slug];
  if (before.status === 'unknown') return refusal('merged', 'no-integration-ref', `git cannot answer here, so a merge cannot be confirmed against an integration ref. Nothing was written.`);
  if (before.evidence) {
    return refusal('merged', 'already-merged', `${slug} already has merge evidence (${before.evidence.kind}${before.evidence.ref ? ` ${before.evidence.ref}` : ''}); nothing to confirm. Nothing was written.`);
  }
  const out = appendEvents(root, [{ type: 'feature.merged', by, data: { slug, reason: cleanReason } }], { now, fsImpl });
  if (!out.ok) return refusal('merged', out.finding, out.message);
  const after = deriveStatuses({ root, fold: readFold(root, { fsImpl, now }) }).statuses[slug];
  return { ok: true, action: 'merged', slug, status: after.status, evidence: after.evidence, release: after.release, events: out.written.map((w) => w.file), next: [] };
}

module.exports = { releaseFeatures, recordMerged, RELEASE_TAG };
