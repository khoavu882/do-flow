'use strict';

// The reference and the generated histories of the derivation differential (IC-020, IC-021), shared
// by the two test files that each compare half of the family, so `node --test` runs the halves in
// parallel. The reference is the per-feature semantics as they stood before the derivation read
// history once per call: it asks git one ancestry question at a time (answered from an exact parent
// map), scans the merges linearly, and keeps `git tag --contains` per feature and `rev-list --not` for
// the merges inside X as real git calls. Both sides get the same git facts and the same fold, so a
// difference is a difference in the derivation alone.
//
// The histories are generated from a fixed seed and written with one `git fast-import` each; dates
// only move forward, so no ancestry walk meets clock skew. Nothing runs at require time.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { historyBuilder } = require('./lifecycle-git-fixtures');
const store = require('../../src/runtime/lifecycle/event-store');
const { deriveStatuses, readGitFacts, bucketize, subjectNames, behindNote } = require('../../src/runtime/lifecycle/status');
const { releaseFeatures } = require('../../src/runtime/lifecycle/release');

// A fixed clock after every generated date: the fold leaves out events dated over 24 hours ahead of it (DEC-045).
const CLOCK = new Date('2027-01-01T00:00:00.000Z');
const SEED = 0x46d1ff;
const HISTORIES = 40;

// ── the reference ──────────────────────────────────────────────────────────────────────────────

// A history never changes once written, so the reference asks git each question once per repository.
const asked = new Map();
function refGit(root, args) {
  const out = refGitOut(root, args, true);
  if (out === null) throw new Error(`git ${args.join(' ')} failed`);
  return out;
}
function refGitOut(root, args, raw = false) {
  const key = `${root}\0${args.join('\0')}`;
  if (!asked.has(key)) {
    const run = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    asked.set(key, run.status === 0 ? run.stdout : null);
  }
  const out = asked.get(key);
  return out === null || raw ? out : out.trim();
}

// A history never changes once written, so the reference reads each fact of a repository once.
const readOnce = new Map();
function once(key, read) {
  if (!readOnce.has(key)) readOnce.set(key, read());
  return readOnce.get(key);
}

/** `a` is `b` or an ancestor of it: a walk over the parents of every commit a ref reaches. */
function exactAncestry(root) {
  return once(`ancestry ${root}`, () => readAncestry(root));
}

function readAncestry(root) {
  const parents = new Map();
  for (const line of refGit(root, ['rev-list', '--all', '--parents']).split('\n').filter(Boolean)) {
    const [sha, ...rest] = line.split(' ');
    parents.set(sha, rest);
  }
  const reached = new Map();
  return (a, b) => {
    let seen = reached.get(b);
    if (!seen) {
      seen = new Set();
      const stack = [b];
      while (stack.length) {
        const sha = stack.pop();
        if (seen.has(sha)) continue;
        seen.add(sha);
        stack.push(...(parents.get(sha) || []));
      }
      reached.set(b, seen);
    }
    return seen.has(a);
  };
}

function refMerges(root, ref) {
  return once(`merges ${root} ${ref}`, () => readRefMerges(root, ref)).slice();
}

function readRefMerges(root, ref) {
  return refGit(root, ['log', '--first-parent', '--merges', '--format=%H%x09%P%x09%ct%x09%s', ref]).split('\n').filter(Boolean).map((line) => {
    const [sha, parents, ct, ...subject] = line.split('\t');
    return { sha, parents: parents.split(' ').filter(Boolean), ct: Number(ct), subject: subject.join('\t') };
  }).reverse();
}

function refTips(root) {
  return once(`tips ${root}`, () => readRefTips(root));
}

function readRefTips(root) {
  const tips = [];
  for (const line of refGit(root, ['for-each-ref', '--format=%(refname)%09%(objectname)', 'refs/heads', 'refs/remotes']).split('\n').filter(Boolean)) {
    const [refname, sha] = line.split('\t');
    if (refname.startsWith('refs/heads/')) tips.push({ short: refname.slice(11), local: refname.slice(11), sha });
    else if (refname.startsWith('refs/remotes/')) { const short = refname.slice(13); tips.push({ short, local: short.slice(short.indexOf('/') + 1), sha }); }
  }
  return tips;
}

/** The oldest first-parent merge with the tip in its history, when the tip came in on a non-first parent at or after the bound. */
function refIntroducingMerge(anc, merges, tip, lowerBound) {
  const merge = merges.find((m) => anc(tip, m.sha));
  if (!merge || merge.ct < lowerBound) return null;
  const [first, ...others] = merge.parents;
  if (anc(tip, first)) return null;
  return others.some((parent) => anc(tip, parent)) ? merge : null;
}

function refEvidence(anc, { slug, lowerBound, merges, tips, prefixes, confirmed }) {
  const names = new Set(prefixes.map((prefix) => `${prefix}/${slug}`));
  for (const tip of tips.filter((t) => names.has(t.local))) {
    const merge = refIntroducingMerge(anc, merges, tip.sha, lowerBound);
    if (merge) return { kind: 'branch', ref: tip.short, commit: merge.sha };
  }
  for (let i = merges.length - 1; i >= 0; i -= 1) {
    if (merges[i].ct >= lowerBound && subjectNames(merges[i].subject, slug)) return { kind: 'merge-subject', ref: merges[i].sha.slice(0, 7), commit: merges[i].sha };
  }
  return confirmed ? { kind: 'confirmed', ref: null, commit: null } : null;
}

function refResult(releaseMode, integrationRef, reason, statuses, notDetected = [], behind = 0) {
  return { releaseMode, integrationRef, integrationBehind: behind, reason, statuses, features: bucketize(statuses), notDetected };
}

function refDerive({ root, fold, facts }) {
  const tracked = fold.features;
  const unknown = (reason) => refResult('unknown', facts.integration_ref ?? null, reason,
    Object.fromEntries(tracked.map((f) => [f.slug, { status: 'unknown', evidence: null, release: null }])));
  if (facts.error) return unknown(`git facts unavailable: ${facts.error}`);
  if (!facts.integration_ref) return unknown('no integration ref resolves (develop, main, master, origin/HEAD)');
  const ref = facts.integration_ref;
  const releaseMode = facts.release_tags.length > 0 ? 'tagged' : 'untagged';
  const behind = Number(facts.integration_local_behind_remote) || 0;
  const pinned = refGit(root, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  if (tracked.length === 0) return { ...refResult(releaseMode, ref, null, {}, [], behind), integrationSha: pinned, evidenceCommits: {} };
  const anc = exactAncestry(root);
  const merges = refMerges(root, pinned);
  const tips = refTips(root);
  const mergedSlugs = new Set(fold.merged.map((m) => m.slug));
  const recorded = new Map();
  for (const release of fold.releases) for (const f of release.features) if (!recorded.has(f.slug)) recorded.set(f.slug, release.tag);
  const recordedTags = new Set(fold.releases.map((r) => r.tag));
  const unrecordedTags = new Set(facts.release_tags.filter((tag) => !recordedTags.has(tag)));
  const statuses = {};
  const evidenceCommits = {};
  const notDetected = [];
  for (const feature of tracked) {
    const lowerBound = Math.floor(Date.parse(feature.trackedAt) / 1000);
    const evidence = refEvidence(anc, { slug: feature.slug, lowerBound, merges, tips, prefixes: facts.feature_prefixes, confirmed: mergedSlugs.has(feature.slug) });
    evidenceCommits[feature.slug] = evidence ? evidence.commit : null;
    let status;
    let release = null;
    if (releaseMode === 'untagged') status = evidence ? 'finished' : 'in-progress';
    else if (recorded.has(feature.slug)) { status = 'finished'; release = recorded.get(feature.slug); } else {
      const containing = evidence && evidence.commit
        ? refGit(root, ['tag', '--contains', evidence.commit, '--list', 'v*']).split('\n').filter((tag) => unrecordedTags.has(tag))
        : [];
      if (containing.length > 0) { status = 'finished'; release = containing[0]; } else status = evidence ? 'awaiting-release' : 'in-progress';
    }
    if (status === 'in-progress') notDetected.push(feature.slug);
    statuses[feature.slug] = { status, evidence: evidence && { kind: evidence.kind, ref: evidence.ref }, release };
  }
  return { ...refResult(releaseMode, ref, null, statuses, notDetected, behind), integrationSha: pinned, evidenceCommits };
}

/** The release preview (no `--confirm`, no `--feature`, no `--exclude`), as IC-020 reads it. */
function refRelease({ root, tag, fold, facts }) {
  const otherTags = { ...facts, release_tags: facts.release_tags.filter((name) => name !== tag) };
  const derived = refDerive({ root, fold, facts: otherTags });
  const anc = exactAncestry(root);
  const tagCommit = refGitOut(root, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]) || null;
  const bound = tagCommit || derived.integrationSha;
  const known = new Set(facts.release_tags);
  let previousTag;
  if (facts.base_tag && facts.base_tag !== tag && known.has(facts.base_tag)
    && anc(refGit(root, ['rev-parse', '--verify', `refs/tags/${facts.base_tag}^{commit}`]).trim(), bound)) previousTag = facts.base_tag;
  else previousTag = (refGitOut(root, ['tag', '--list', 'v*', '--sort=-v:refname', '--merged', bound]) || '').split('\n').find((name) => name && name !== tag && known.has(name)) || null;
  const atTag = tagCommit && tagCommit !== derived.integrationSha ? refDerive({ root, fold, facts: { ...otherTags, integration_ref: tagCommit } }) : null;
  const all = refMerges(root, derived.integrationSha).reverse();
  const outside = new Set((refGitOut(root, ['rev-list', '--first-parent', '--merges', derived.integrationSha, '--not', bound]) || '').split('\n').filter(Boolean));
  const mergesOfX = all.filter((m) => !outside.has(m.sha));
  const branchTip = (ref) => refGitOut(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${ref}^{commit}`]) || refGitOut(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${ref}^{commit}`]) || null;
  const recorded = new Set(fold.releases.flatMap((r) => r.features.map((f) => f.slug)));
  const tagged = derived.releaseMode === 'tagged';
  const candidates = [];
  const notDetected = [];
  for (const feature of fold.features) {
    const { slug } = feature;
    if (recorded.has(slug)) continue;
    const entry = derived.statuses[slug];
    const hotfix = atTag && atTag.statuses[slug];
    if (tagged && (entry.status === 'finished' || (hotfix && hotfix.status === 'finished'))) continue;
    const evidence = entry.evidence;
    let found = null;
    if (evidence) {
      const commit = derived.evidenceCommits[slug];
      if (evidence.kind === 'confirmed' || (commit && anc(commit, bound))) found = evidence;
    }
    if (!found && hotfix && hotfix.evidence) found = hotfix.evidence;
    if (!found && evidence) {
      const lowerBound = Math.floor(Date.parse(feature.trackedAt) / 1000);
      const tip = evidence.kind === 'branch' ? branchTip(evidence.ref) : null;
      if (tip && anc(tip, bound)) found = { ...evidence };
      for (const merge of tip && anc(tip, bound) ? [] : mergesOfX) {
        if (merge.ct < lowerBound) continue;
        const [first, ...others] = merge.parents;
        if (tip && others.some((parent) => anc(parent, tip) && !anc(parent, first)) && !anc(merge.sha, tip)) { found = { ...evidence }; break; }
        if (subjectNames(merge.subject, slug)) { found = { kind: 'merge-subject', ref: merge.sha.slice(0, 7) }; break; }
      }
    }
    if (found) candidates.push({ slug, evidence: found.kind, ref: found.ref }); else notDetected.push(slug);
  }
  const finishing = new Set(candidates.map((c) => c.slug));
  const followupsDone = fold.followups.filter((item) => item.state === 'taken' && finishing.has(item.takenBy)).map((item) => item.id);
  const out = { ok: true, action: 'release', tag, previousTag, bound: tagCommit ? tag : facts.integration_ref, integrationRef: facts.integration_ref };
  if (derived.integrationBehind > 0) out.note = behindNote(facts.integration_ref, derived.integrationBehind);
  const addHint = 'add --feature <slug> for a feature listed under notDetected that shipped';
  return {
    ...out, recorded: false, candidates, added: [], excluded: [], notDetected, followupsDone,
    next: [tagCommit
      ? `Record it: doflow-run lifecycle --action release --tag ${tag} --confirm (${addHint}; --exclude <slug> leaves one out)`
      : `After git tag ${tag}: doflow-run lifecycle --action release --tag ${tag} --confirm (${addHint})`],
  };
}

// ── the generated histories ────────────────────────────────────────────────────────────────────

/** mulberry32: a small deterministic generator, so a failing history can be rebuilt from its index. */
function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const KINDS = ['merge', 'squash', 'rebase', 'fast-forward', 'cherry-pick', 'older-commits', 'twice', 'hotfix', 'unmerged', 'empty-branch'];
const SETUPS = ['develop', 'develop-main', 'main-only', 'origin-develop', 'stale-origin'];
/** What the brief asks the family to cover; each must appear in at least one history. */
const REQUIRED = [...KINDS, ...SETUPS, 'empty-branch-at-merge', 'redundant-merge', 'deleted-branch', 'origin-only-branch', 'vnext-tag', 'non-v-tag', 'no-release-tag', 'several-tags',
  'annotated-tag', 'recorded', 'excluded', 'confirmed', 'tracked-after-merge', 'preview-existing-tag', 'preview-new-tag'];

/**
 * One generated history: the builder calls, the store events and the tag to preview.
 * @returns {{h:Object, events:Array<{type:string, data:Object, at:string}>, tag:string, covers:Set<string>}}
 */
function scenario(index, rng) {
  const pick = (list) => list[Math.floor(rng() * list.length)];
  const chance = (p) => rng() < p;
  const covers = new Set();
  const setup = SETUPS[index % SETUPS.length];
  covers.add(setup);
  const integ = setup === 'main-only' ? 'main' : 'develop';
  const head = setup === 'origin-develop' ? 'trunk' : integ;
  const h = historyBuilder({ initial: head });
  h.commit(head, 'init');
  if (head !== integ) h.branch(integ, head);
  const prod = setup === 'develop-main' || (setup !== 'main-only' && chance(0.3)) ? 'main' : null;
  if (prod) h.branch(prod, integ);

  const events = [];
  const tracked = [];
  const track = (slug) => { events.push({ type: 'feature.tracked', data: { slug }, at: h.iso() }); tracked.push(slug); };
  const releaseTags = [];
  const between = []; // tags cut between two merges of one branch: the preview prefers them
  let [major, minor, patch] = [1, chance(0.5) ? 8 : 0, 0];
  const cut = (onProd = Boolean(prod)) => {
    minor += 1 + Math.floor(rng() * 3);
    patch = 0;
    const name = `v${major}.${minor}.${patch}`;
    if (onProd) h.merge(prod, integ);
    const annotated = chance(0.4);
    if (annotated) covers.add('annotated-tag');
    h.tag(name, onProd ? prod : integ, { annotated });
    releaseTags.push(name);
    if (chance(0.4)) {
      const named = tracked.filter(() => chance(0.5));
      const excluded = tracked.filter((s) => !named.includes(s) && chance(0.3));
      if (excluded.length) covers.add('excluded');
      covers.add('recorded');
      events.push({ type: 'release.recorded', data: { tag: name, commit: 'c', features: named.map((slug) => ({ slug, evidence: 'branch', ref: 'r' })), excluded }, at: h.iso(5) });
    }
  };

  const count = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < count; i += 1) {
    const slug = `${200 + i}-h${index}`;
    let kind = i === 0 ? KINDS[index % KINDS.length] : pick(KINDS);
    if (kind === 'hotfix' && !prod) kind = 'merge';
    covers.add(kind);
    const branch = `${chance(0.8) ? 'feat' : 'feature'}/${slug}`;
    const afterMerge = kind !== 'older-commits' && chance(0.15);
    if (!afterMerge && kind !== 'older-commits') track(slug);
    const work = (n = 1 + Math.floor(rng() * 2)) => { for (let k = 1; k <= n; k += 1) h.commit(branch, `work ${k} on ${slug}`); };
    if (kind === 'hotfix') {
      h.branch(branch, prod);
      work();
      h.merge(prod, branch);
      patch += 1;
      const name = `v${major}.${minor}.${patch}`;
      h.tag(name, prod);
      releaseTags.push(name);
    } else {
      if (kind === 'empty-branch' && chance(0.6)) {
        // Cut from develop after a merge made since tracking: the tip is that merge, on the chain itself.
        covers.add('empty-branch-at-merge');
        h.branch(`chore/${slug}`, integ).commit(`chore/${slug}`, `chore before ${slug}`).merge(integ, `chore/${slug}`).deleteBranch(`chore/${slug}`);
      }
      h.branch(branch, integ);
      if (kind !== 'empty-branch') work();
      if (chance(0.3)) h.commit(integ, `unrelated work ${i}`);
      if (kind === 'merge') h.merge(integ, branch);
      else if (kind === 'squash') h.commit(integ, chance(0.5) ? `Squash ${slug}` : 'Add the cart total handling');
      else if (kind === 'rebase') { h.commit(integ, 'develop moved on'); h.rebase(branch, integ, 2); h.fastForward(integ, branch); } else if (kind === 'fast-forward') h.fastForward(integ, branch);
      else if (kind === 'cherry-pick') h.commit(integ, `work 1 on ${slug}`);
      else if (kind === 'older-commits') { h.wait(3600); track(slug); h.wait(600); h.merge(integ, branch); } else if (kind === 'twice') {
        h.merge(integ, branch);
        const redundant = chance(0.5);
        if (redundant) {
          // A second merge of the same, already merged tip: its merged side is not new history.
          covers.add('redundant-merge');
          h.merge(integ, branch);
        }
        if (redundant || chance(0.6)) { cut(); between.push(releaseTags[releaseTags.length - 1]); }
        work(1);
        h.merge(integ, branch);
      }
    }
    if (afterMerge) { covers.add('tracked-after-merge'); track(slug); }
    if (h.has(branch) && chance(0.3)) { covers.add('deleted-branch'); h.deleteBranch(branch); } else if (h.has(branch) && chance(0.25)) {
      covers.add('origin-only-branch');
      h.remote(branch);
      if (chance(0.7)) h.deleteBranch(branch);
    }
    if (chance(0.15)) { covers.add('confirmed'); events.push({ type: 'feature.merged', data: { slug, reason: 'by hand' }, at: h.iso(10) }); }
    if (chance(0.35)) cut();
    if (chance(0.1)) { covers.add('vnext-tag'); h.tag('vnext', integ); }
    if (chance(0.08)) { covers.add('non-v-tag'); h.tag(`${major}.${minor}.${patch + 9}`, integ); }
  }

  if (setup === 'stale-origin') {
    // A merge only origin/<integ> has: local is behind, and the feature has no evidence on the pinned local ref.
    const slug = `299-h${index}`;
    track(slug);
    h.branch('origin-side', integ).branch(`feat/${slug}`, integ).commit(`feat/${slug}`, `work on ${slug}`).merge('origin-side', `feat/${slug}`);
    h.remote(integ, 'origin-side').deleteBranch('origin-side');
  }
  if (setup === 'origin-develop') h.remote(integ).deleteBranch(integ);

  if (releaseTags.length === 0) covers.add('no-release-tag');
  if (releaseTags.length >= 2) covers.add('several-tags');
  let tag;
  if (releaseTags.length && chance(0.65)) { tag = between.length && chance(0.7) ? pick(between) : pick(releaseTags); covers.add('preview-existing-tag'); } else { tag = `v${major + 1}.0.0`; covers.add('preview-new-tag'); }
  return { h, events, tag, covers };
}

function writeEvents(root, events) {
  for (const e of events) {
    const out = store.appendEvents(root, [{ type: e.type, by: 'agent', data: e.data }], { now: new Date(e.at) });
    assert.ok(out.ok, out.message);
  }
}

/**
 * Generates every history of the family (so the seed's sequence never depends on the split) and
 * compares the derivation with the reference on those whose index is `part` modulo `parts`.
 * @returns {{covered: Map<string, number>, outcomes: Set<string>}} the kinds over the whole family; the
 *   status and evidence outcomes over the compared histories
 */
function compareHistories(scratch, { part, parts }) {
  const rng = seeded(SEED);
  const covered = new Map();
  const outcomes = new Set();
  for (let index = 0; index < HISTORIES; index += 1) {
    const { h, events, tag, covers } = scenario(index, rng);
    for (const c of covers) covered.set(c, (covered.get(c) || 0) + 1);
    if (index % parts !== part) continue;
    const repo = h.write(scratch, `history-${index}`);
    writeEvents(repo.dir, events);
    const facts = readGitFacts(repo.dir);
    const fold = store.readFold(repo.dir, { now: CLOCK });
    const label = `history ${index} (${[...covers].join(', ')}; preview ${tag})`;
    assert.equal(facts.error, undefined, label);
    const derived = deriveStatuses({ root: repo.dir, fold, facts });
    assert.deepEqual(derived, refDerive({ root: repo.dir, fold, facts }), `${label}: deriveStatuses`);
    for (const entry of Object.values(derived.statuses)) outcomes.add(`${entry.status}:${entry.evidence ? entry.evidence.kind : 'none'}`);
    assert.deepEqual(releaseFeatures({ root: repo.dir, tag, now: CLOCK, facts }), refRelease({ root: repo.dir, tag, fold, facts }), `${label}: release preview`);
  }
  return { covered, outcomes };
}

/** Every status and evidence kind a non-trivial half of the family turns up. */
const OUTCOMES = ['finished:branch', 'finished:merge-subject', 'finished:confirmed', 'awaiting-release:branch', 'awaiting-release:merge-subject', 'in-progress:none'];

module.exports = { compareHistories, writeEvents, REQUIRED, OUTCOMES, HISTORIES, CLOCK };
