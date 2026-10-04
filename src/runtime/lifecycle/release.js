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
 * A feature is dropped for exactly three reasons (IC-020): a release record names it, another
 * unrecorded `v*` tag contains it, or no evidence of its merge reaches X.
 *
 * Evidence into X is looked for in two places: the derivation against the pinned integration ref
 * (the normal case: features merge into develop, the tag is cut from it) and, when the tag exists, a
 * second derivation against the tag's own first-parent chain (a hotfix merged only into the
 * production branch). Each gives the full merge commit, which must be an ancestor of X. When a branch
 * was merged more than once, the newest merge may lie after the tag; an earlier merge of the same
 * branch (or of a merge naming the slug) that X contains then counts. The ancestry questions about X
 * are answered from one graph read (`readHistory`) of the pinned ref, X and the evidence branch tips,
 * so the preview costs a fixed number of git calls however many features and merges there are.
 * Accepted ceiling: the search for an earlier merge walks, in memory, the integration ref's
 * first-parent merges inside X once per feature that needs it.
 *
 * `evidence.commit` and the pinned sha come from `deriveStatuses` (`evidenceCommits`, `integrationSha`),
 * so this module neither re-resolves the integration ref nor an abbreviated sha.
 */

const nodeFs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { isSafeSlug, invalidSlugRefusal } = require('../task-scope');
const { appendEvents, readFold } = require('./event-store');
const { deriveStatuses, readGitFacts, behindNote, subjectNames, readMerges, readBranchTips, readHistory } = require('./status');
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

/**
 * Evidence of an earlier merge of a branch that was merged more than once: a merge X contains, committed
 * since tracking, whose subject names the slug or whose non-first parent is an ancestor of the branch tip.
 * `merges` are the pinned ref's first-parent merges inside X, newest first; `history` holds X and the tip.
 */
function earlierMerge({ slug, evidence, tip, lowerBound, merges, bound, history }) {
  if (tip && history.isAncestor(tip, bound)) return { ...evidence };
  for (const merge of merges) {
    if (merge.ct < lowerBound) continue;
    // The merged side is this branch's own when it is an ancestor of the tip and the merge itself is not: a
    // branch cut from the integration ref after that merge has the merge in its history and did not make it.
    // A parent outside the first parent's history is one this merge introduced.
    const own = (parent) => history.introducer(parent) === merge.sha && history.isAncestor(parent, tip);
    if (tip && merge.parents.slice(1).some(own) && !history.isAncestor(merge.sha, tip)) return { ...evidence };
    if (subjectNames(merge.subject, slug)) return { kind: 'merge-subject', ref: merge.sha.slice(0, 7) };
  }
  return null;
}

/**
 * The tag a release follows (it only feeds the output): the base tag `git-state` proposes versions
 * from, other than `tag`, when it is a release tag lying in X's history; else the newest release tag
 * other than `tag` merged into X (git's version order). A `v*` tag that is not a release (`vnext`)
 * never qualifies.
 */
function previousTagOf(root, { tag, facts, bound }) {
  const known = new Set(facts.release_tags);
  if (facts.base_tag && facts.base_tag !== tag && known.has(facts.base_tag) && isAncestor(root, `refs/tags/${facts.base_tag}`, bound)) return facts.base_tag;
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
 * @param {Object} [options.facts] `readGitFacts` output, for a caller that already has it
 */
function releaseFeatures({ root, tag, confirm = false, features, exclude, channel, now = new Date(), fsImpl = nodeFs, facts: givenFacts }) {
  if (typeof tag !== 'string' || !RELEASE_TAG.test(tag)) throw new FollowupUsageError(`--tag is required and must look like v1.2.3 or v1.2.3-rc.1 (got '${tag ?? ''}')`);
  const added = slugList(features, '--feature');
  const excluded = slugList(exclude, '--exclude');
  const by = channelBy(channel);

  const facts = givenFacts || readGitFacts(root);
  if (facts.error) return refusal('release', 'no-integration-ref', `git facts are unavailable (${facts.error}), so no release can be previewed or recorded. Nothing was written.`);
  if (!facts.integration_ref) return refusal('release', 'no-integration-ref', 'no integration ref resolves (develop, main, master, origin/HEAD), so no release can be previewed or recorded. Nothing was written.');

  const fold = readFold(root, { fsImpl, now });
  const trackedSlugs = new Set(fold.features.map((f) => f.slug));
  // An exclusion is permanent for its tag, so a mistyped slug must not be recorded any more than a mistyped addition.
  const untracked = [...new Set([...added, ...excluded])].filter((slug) => !trackedSlugs.has(slug));
  if (untracked.length) {
    return refusal('release', 'untracked-feature', `${untracked.join(', ')} ${untracked.length === 1 ? 'is' : 'are'} not tracked, so ${untracked.length === 1 ? 'it' : 'they'} cannot be added to or excluded from a release; run doflow-run lifecycle --action init --slug <slug> first. Nothing was written.`);
  }

  // DEC-030: containment in the tag being recorded never finishes a feature before its record exists.
  const otherTags = { ...facts, release_tags: facts.release_tags.filter((name) => name !== tag) };
  const derived = deriveStatuses({ root, fold, facts: otherTags });
  if (derived.releaseMode === 'unknown' || !derived.integrationSha) return refusal('release', 'no-integration-ref', `${derived.reason || `${facts.integration_ref} does not resolve to a commit`}. Nothing was written.`);

  // X: the tag's commit once it exists, else the commit the status view pinned the integration ref to (DEC-044).
  const tagCommit = commitOf(root, `refs/tags/${tag}`);
  const bound = tagCommit || derived.integrationSha;
  const previousTag = previousTagOf(root, { tag, facts, bound });
  // A hotfix merged only into the tag's own history has no evidence on the integration chain: derive against the tag as well.
  const atTag = tagCommit && tagCommit !== derived.integrationSha ? deriveStatuses({ root, fold, facts: { ...otherTags, integration_ref: tagCommit } }) : null;

  const recorded = new Set(fold.releases.flatMap((release) => release.features.map((f) => f.slug)));
  const tagged = derived.releaseMode === 'tagged';
  // While X is the pinned commit, every evidence commit is in its history. Once X is a tag elsewhere, one
  // graph read of the pinned ref, X and the evidence branch tips answers every ancestry question about X.
  let read = null;
  const readOfX = () => {
    if (read) return read;
    const branchRefs = new Set(fold.features.map((f) => derived.statuses[f.slug].evidence).filter((e) => e && e.kind === 'branch').map((e) => e.ref));
    // Local branches are listed first, so a ref resolves as refs/heads/<ref> before refs/remotes/<ref>.
    const tips = new Map();
    for (const t of readBranchTips(root)) if (branchRefs.has(t.short) && !tips.has(t.short)) tips.set(t.short, t.sha);
    const history = readHistory(root, derived.integrationSha, [bound, ...tips.values()]);
    const merges = readMerges(root, derived.integrationSha).filter((m) => history.isAncestor(m.sha, bound)).reverse();
    read = { history, merges, tips };
    return read;
  };
  const inX = (commit) => bound === derived.integrationSha || readOfX().history.isAncestor(commit, bound);
  const candidates = [];
  const notDetected = [];
  for (const feature of fold.features) {
    const { slug } = feature;
    if (recorded.has(slug)) continue;
    const entry = derived.statuses[slug];
    const hotfix = atTag && atTag.statuses[slug];
    // With another v* tag in play, `finished` here means an unrecorded tag already contains the merge.
    if (tagged && (entry.status === 'finished' || (hotfix && hotfix.status === 'finished'))) continue;
    const evidence = entry.evidence;
    let found = null;
    if (evidence) {
      const commit = derived.evidenceCommits[slug];
      if (evidence.kind === 'confirmed' || (commit && inX(commit))) found = evidence;
    }
    if (!found && hotfix && hotfix.evidence) found = hotfix.evidence;
    if (!found && evidence) {
      const { history, merges, tips } = readOfX();
      const tip = evidence.kind === 'branch' ? tips.get(evidence.ref) || null : null;
      const lowerBound = Math.floor(Date.parse(feature.trackedAt) / 1000);
      found = earlierMerge({ slug, evidence, tip, lowerBound, merges, bound, history });
    }
    if (found) candidates.push({ slug, evidence: found.kind, ref: found.ref }); else notDetected.push(slug);
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
