'use strict';

/**
 * Check proposals (181 IC-014, IC-015, IC-016): `propose` turns a cluster of open follow-ups that the same-issue rule
 * flags into one proposal for a check in the person's project, with the five-rung ladder and the cheapest available
 * rung offered; `decide` records the person's answer (accept, decline, built). Both return a result object and print
 * nothing, so the verb layer only parses flags and prints; `exitCode` on every result is the verb's exit status
 * (0 recorded or answered, 1 refused). A caller mistake throws `FollowupUsageError`, which the verb maps to exit 2.
 *
 * The recurrence signal is the same-issue RULE only (NFR-002): this file requires `followup.ts` and `rule.ts`, never
 * `followup-similar.ts` or an advice client, because the core path may not ask a model. It writes lifecycle events and
 * nothing else: the check itself is written into the project by the agent after an accept (NFR-005).
 */

const nodeFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { maskLine } = require('../mask.ts');
const { detectCommands } = require('../command-detect.ts');
const { itemText, score, candidatePairs } = require('../advice/same-issue/rule.ts');
const { appendEvents } = require('./event-store.ts');
const followup = require('./followup.ts');

const { FollowupUsageError, loadFollowups, sameIssueParams, comparedItems, parseIds, oneLine, channelBy } = followup;

/** The ladder, cheapest first (FR-002). */
const KINDS = ['type-or-api', 'static-check', 'test', 'advisory-hook', 'prose'];
const PROPOSAL_ID = /^CP-[0-9a-f]{6}$/;
const REASON_MAX = 200;
const ALTERNATIVE_MAX = 200;
const CHECK_FILE_MAX_BYTES = 1024 * 1024;

/** What each rung is for, as its reason when the rung is available. */
const FITS: Record<string, string> = {
  'type-or-api': 'a typecheck command is detected, so a type or API change can make the mistake fail to compile',
  'static-check': 'a lint command is detected, so a lint rule can flag the pattern and carry the correction in its message',
  test: 'a test command is detected, so a test can fail on the violating input and carry the correction in its message',
  'advisory-hook': 'a hook can advise on the pattern in every session, but it cannot block',
  prose: 'a guidance line states the correction when no check can express it',
};
/** The detected roles that make a rung available; a rung with none is always available. */
const ROLES: Record<string, string[]> = { 'type-or-api': ['typecheck'], 'static-check': ['lint'], test: ['test', 'testTargeted'] };

function refusal(action: string, finding: string, message: string) { return { ok: false, action, finding, message, exitCode: 1 }; }

/** The refusal for a store write that failed: a fold conflict keeps its own word, as the follow-up verbs do. */
function refusedWrite(action: string, failed: any) {
  return refusal(action, failed.conflict && ['unknown-id', 'reason-required'].includes(failed.conflict.code) ? failed.conflict.code : failed.finding, failed.message);
}

/** `CP-` plus the first 6 hex characters of the sha256 of the sorted member ids joined by newlines (IC-014). */
function proposalIdFor(members: string[]): string {
  return `CP-${crypto.createHash('sha256').update([...members].sort().join('\n')).digest('hex').slice(0, 6)}`;
}

/** The five rungs with their availability, from the verify detection's `commands` (IC-014). */
function buildLadder(commands: Record<string, any>) {
  return KINDS.map((kind) => {
    const roles = ROLES[kind];
    if (!roles || roles.some((role) => commands[role])) return { kind, available: true, reason: FITS[kind] };
    return { kind, available: false, reason: `no ${roles[0]} command detected` };
  });
}

/** One sentence naming why the cheaper rungs do not fit (FR-002). */
function offeredReason(ladder: any[], offered: string): string {
  const cheaper = ladder.slice(0, KINDS.indexOf(offered)).map((rung) => rung.reason);
  const own = ladder.find((rung) => rung.kind === offered).reason;
  return cheaper.length === 0 ? `it is the cheapest kind and ${own}` : `${cheaper.join(' and ')}, so ${offered} is the cheapest kind left: ${own}`;
}

/** The score bar's pairs at `flagAtPct` or more among `items`, uncapped. */
function flaggedPairs(items: any[], params: any) {
  return candidatePairs(items, { ...params, perItem: Infinity, maxPairs: Infinity, candidateAtPct: params.flagAtPct });
}

/** Connected components of the flagged pairs, each a sorted id list of two or more, ordered by their first id. */
function clustersOf(pairs: any[]): string[][] {
  const parent = new Map<string, string>();
  const find = (id: string): string => { let root = id; while (parent.get(root) !== root) root = parent.get(root) as string; return root; };
  for (const { a, b } of pairs) {
    for (const id of [a, b]) if (!parent.has(id)) parent.set(id, id);
    parent.set(find(a), find(b));
  }
  const groups = new Map<string, string[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()].map((ids) => ids.sort()).sort((x, y) => (x[0] < y[0] ? -1 : 1));
}

/** The member created last (event time, then event id); its masked statement is the correction. */
function newestOf(members: any[]): any {
  const created = (item: any) => item.history[0];
  return [...members].sort((x, y) => Date.parse(created(x).at) - Date.parse(created(y).at) || (created(x).event < created(y).event ? -1 : 1)).at(-1);
}

/** The newest declined proposal that shares a member with the cluster or whose correction the rule flags against it. */
function declinedBefore({ checks, members, correction, params }: any) {
  const own = { id: 'own', text: itemText(correction, params.itemBytes) };
  const bar = params.flagAtPct / 100;
  const hits = Object.values(checks as Record<string, any>).filter((check: any) => check.state === 'declined'
    && (check.members.some((id: string) => members.includes(id))
      || score(own, { id: 'other', text: itemText(check.correction, params.itemBytes) }, params) >= bar));
  const declinedAt = (check: any) => check.history.at(-1);
  const newest = hits.sort((x: any, y: any) => Date.parse(declinedAt(x).at) - Date.parse(declinedAt(y).at) || (x.proposal < y.proposal ? -1 : 1)).at(-1) as any;
  return newest ? { id: newest.proposal, at: declinedAt(newest).at, reason: newest.reason } : null;
}

/**
 * IC-014 `propose`. Without `ids`, every cluster of open follow-ups whose pairs reach the same-issue rule's `flagAtPct`;
 * with `ids`, exactly those items form one cluster and at least one pair must reach the bar. With `record`, each new
 * proposal is appended as `check.proposed`; without it nothing is written and the same store gives the same answer.
 * `projectDir` is where verify detection reads the project's commands (default `root`; a linked worktree passes its own).
 * @returns {{ok: true, action: 'propose', status: 'no-recurrence'|'proposed'|'already-proposed', proposals: Object[], events: string[], exitCode: 0}
 *   | {ok: false, action: 'propose', finding: 'not-open'|'unknown-id'|'no-flagged-pair'|'rule-unreadable'|string, message: string, exitCode: 1}}
 */
function proposeChecks({ root, projectDir = root, ids, record = false, channel, now = new Date(), fsImpl = nodeFs, detection }: any) {
  const wanted = ids === undefined ? null : parseIds(ids);
  const by = channelBy(channel);
  const params = sameIssueParams();
  if (!params) return refusal('propose', 'rule-unreadable', 'core/registry/advice.json could not be read, so the same-issue rule has no thresholds. Nothing was written.');
  const { fold, followups } = loadFollowups(root, { fsImpl, now });
  const open = followups.filter((item: any) => item.state === 'open');
  const checks = fold.checks;
  const byId = new Map<string, any>(followups.map((item: any) => [item.id, item]));

  let clusters: string[][];
  if (wanted) {
    const unknown = wanted.filter((id: string) => !byId.has(id));
    if (unknown.length) return refusal('propose', 'unknown-id', `${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a follow-up in this store. Nothing was written.`);
    const notOpen = wanted.filter((id: string) => byId.get(id).state !== 'open');
    if (notOpen.length) return refusal('propose', 'not-open', `${notOpen.map((id: string) => `${id} is ${byId.get(id).state}`).join(', ')}; only open follow-ups can be proposed as a check. Nothing was written.`);
    const items = wanted.map((id: string) => ({ id, text: itemText(byId.get(id).statement, params.itemBytes) }));
    if (flaggedPairs(items, params).length === 0) return refusal('propose', 'no-flagged-pair', `no pair among ${wanted.join(', ')} reaches the same-issue rule's ${params.flagAtPct}% bar, so there is no recurrence to propose a check for. Nothing was written.`);
    clusters = [[...wanted].sort()];
  } else {
    clusters = clustersOf(flaggedPairs(comparedItems(open, params), params));
  }

  const commands = (detection ?? detectCommands({ projectRoot: projectDir, fsImpl })).commands ?? {};
  const ladder = buildLadder(commands);
  const offered = ladder.find((rung) => rung.available)!.kind;
  const proposals = clusters.map((members) => {
    const correction = maskLine(newestOf(members.map((id) => byId.get(id))).statement).text.trim();
    const id = proposalIdFor(members);
    const declined = declinedBefore({ checks, members, correction, params });
    const existing = checks[id];
    const status = declined ? 'declined-before' : existing ? 'already-proposed' : 'new';
    return {
      id, members, correction, ladder,
      offered: declined ? null : offered,
      offeredReason: declined ? null : offeredReason(ladder, offered),
      declinedBefore: declined,
      status,
      ...(existing && !declined ? { recorded: { state: existing.state, kind: existing.kind, checkPath: existing.checkPath } } : {}),
    };
  }).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const fresh = proposals.filter((proposal) => proposal.status === 'new');
  let events: string[] = [];
  if (record && fresh.length) {
    const drafts = fresh.map((p) => ({ type: 'check.proposed', by, data: { proposal: p.id, members: p.members, correction: p.correction, offered: p.offered, ladder: p.ladder } }));
    const out = appendEvents(root, drafts, { now, fsImpl });
    if (!out.ok) return refusedWrite('propose', out);
    events = out.written.map((w: any) => w.file);
  }
  const status = proposals.length === 0 ? 'no-recurrence'
    : record && fresh.length === 0 && proposals.some((p) => p.status === 'already-proposed') ? 'already-proposed' : 'proposed';
  return { ok: true, action: 'propose', status, proposals, events, exitCode: 0 };
}

// ── decide ─────────────────────────────────────────────────────────────────────────────────────

/** `<correction>. Use <alternative> instead.` (IC-015); a trailing full stop of the correction is not doubled. */
function composeMessage(correction: string, alternative: string): string {
  return `${correction.replace(/[.\s]+$/, '')}. Use ${alternative} instead.`;
}

/**
 * Whether the answer is coming from a channel nobody is watching (autopilot or a worker run). The signal is the runtime's own
 * `attendance` source (src/runtime/roadmap/attendance.ts: `resolveAttendance`), read lazily so only an accept pays for it;
 * `attendance` injects an already resolved answer. Without a `taskId` only its worker-role rule can say `unattended`.
 */
function isUnattended({ attendance, taskId, env, cwd, by }: any): boolean {
  if (by === 'autopilot') return true;
  const answer = attendance ?? require('../roadmap/attendance.ts').resolveAttendance({ taskId, env, cwd });
  return answer.attendance === 'unattended';
}

/** The project-relative path of `file` when it names a regular file inside `projectDir`, else a refusal message. */
function checkFileIn(projectDir: string, file: any, fsImpl: any): { rel?: string; abs?: string; problem?: string } {
  if (typeof file !== 'string' || file.trim() === '') return { problem: '--check names no file' };
  if (path.isAbsolute(file)) return { problem: `${file} is not repository-relative` };
  const abs = path.resolve(projectDir, file);
  const rel = path.relative(projectDir, abs);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return { problem: `${file} is outside the project` };
  try {
    const real = fsImpl.realpathSync(abs);
    const realRoot = fsImpl.realpathSync(projectDir);
    const inside = path.relative(realRoot, real);
    if (inside.startsWith('..') || path.isAbsolute(inside)) return { problem: `${file} resolves outside the project` };
    const st = fsImpl.statSync(real);
    if (!st.isFile()) return { problem: `${file} is not a regular file` };
    if (st.size > CHECK_FILE_MAX_BYTES) return { problem: `${file} is larger than ${CHECK_FILE_MAX_BYTES / 1024} KiB` };
    return { rel: rel.split(path.sep).join('/'), abs: real };
  } catch {
    return { problem: `${file} does not exist` };
  }
}

/**
 * IC-015 `decide`. `accept` (with `kind` and `alternative`; a `reason` when the kind is below the offered rung) returns the
 * composed `message` for the agent to put in the check, and is refused `unattended-accept` from an unattended channel;
 * `decline` needs a `reason`; `built` needs `check`, a path inside `projectDir` (default `root`; a linked worktree passes its
 * own) whose file holds the composed message, and settles every still-open member follow-up `fix`.
 */
function decideCheck({ root, projectDir = root, proposal, decision, kind, alternative, reason, check, channel, attendance, taskId, env = process.env, cwd = process.cwd(), now = new Date(), fsImpl = nodeFs }: any) {
  if (typeof proposal !== 'string' || !PROPOSAL_ID.test(proposal)) throw new FollowupUsageError(`--proposal must be a check proposal id (CP- and six hex characters; got '${proposal ?? ''}')`);
  if (!['accept', 'decline', 'built'].includes(decision)) throw new FollowupUsageError(`--decision must be accept, decline or built${decision ? ` (got '${decision}')` : ''}`);
  const by = channelBy(channel);
  const problems: string[] = [];
  const cleanReason = reason === undefined ? null : oneLine(reason, '--reason', problems, { max: REASON_MAX });
  let cleanAlternative: string | null = null;
  if (decision === 'accept') {
    if (!KINDS.includes(kind)) problems.push(`--kind is required for accept and must be one of ${KINDS.join(', ')}${kind ? ` (got '${kind}')` : ''}`);
    if (alternative === undefined) problems.push('--alternative is required for accept');
    else cleanAlternative = oneLine(alternative, '--alternative', problems, { max: ALTERNATIVE_MAX });
  } else if (kind !== undefined || alternative !== undefined) problems.push(`--kind and --alternative apply to accept only, not ${decision}`);
  if (decision === 'built' && (check === undefined || check === true || String(check).trim() === '')) problems.push('--check <path> is required for built');
  if (decision !== 'built' && check !== undefined) problems.push(`--check applies to built only, not ${decision}`);
  if (problems.length) throw new FollowupUsageError(problems.join('; '));

  // An unattended accept is refused before the store is read: nobody watching can choose a kind for the person.
  if (decision === 'accept' && isUnattended({ attendance, taskId, env, cwd, by })) {
    return refusal('decide', 'unattended-accept', `${proposal} cannot be accepted from an unattended channel (autopilot or a worker run); a person accepts a check. Nothing was written.`);
  }
  const { fold, followups } = loadFollowups(root, { fsImpl, now });
  const record = fold.checks[proposal];
  if (!record) return refusal('decide', 'unknown-id', `${proposal} is not a recorded check proposal; run followup --action propose --record first. Nothing was written.`);
  const needs = decision === 'built' ? 'accepted' : 'proposed';
  if (record.state !== needs) return refusal('decide', 'illegal-transition', `${proposal} is ${record.state}; only a ${needs} check can be ${decision === 'accept' ? 'accepted' : decision === 'decline' ? 'declined' : 'built'}. Nothing was written.`);

  if (decision === 'decline') {
    if (!cleanReason) return refusal('decide', 'reason-missing', '--reason is required to decline a proposal, so the same one is not offered again without it. Nothing was written.');
    const out = appendEvents(root, [{ type: 'check.declined', by, data: { proposal, reason: cleanReason } }], { now, fsImpl });
    if (!out.ok) return refusedWrite('decide', out);
    return { ok: true, action: 'decide', proposal, decision, state: 'declined', events: out.written.map((w: any) => w.file), exitCode: 0 };
  }

  if (decision === 'accept') {
    if (KINDS.indexOf(kind) > KINDS.indexOf(record.offered) && !cleanReason) {
      return refusal('decide', 'reason-missing', `${kind} is below the offered ${record.offered}; --reason says why the cheaper kind does not fit. Nothing was written.`);
    }
    const message = composeMessage(record.correction, cleanAlternative as string);
    const data = { proposal, kind, alternative: cleanAlternative, message, ...(cleanReason ? { reason: cleanReason } : {}) };
    const out = appendEvents(root, [{ type: 'check.accepted', by, data }], { now, fsImpl });
    if (!out.ok) return refusedWrite('decide', out);
    return { ok: true, action: 'decide', proposal, decision, state: 'accepted', kind, alternative: cleanAlternative, message, events: out.written.map((w: any) => w.file), exitCode: 0 };
  }

  // built: the file must hold the message the person accepted.
  const found = checkFileIn(projectDir, check, fsImpl);
  if (found.problem) return refusal('decide', 'message-missing', `${found.problem}, so it cannot hold the message "${record.message}". Nothing was written.`);
  if (!fsImpl.readFileSync(found.abs, 'utf8').includes(record.message)) {
    return refusal('decide', 'message-missing', `${found.rel} does not contain the accepted message "${record.message}"; a check whose failure does not state the correction and the alternative is not built. Nothing was written.`);
  }
  const openIds = record.members.filter((id: string) => followups.find((item: any) => item.id === id)?.state === 'open');
  const drafts: any[] = [
    { type: 'check.built', by, data: { proposal, path: found.rel } },
    ...openIds.map((id: string) => ({ type: 'followup.settled', by, data: { id, as: 'fix', reason: `check built at ${found.rel} (${proposal})`, evidence: null } })),
  ];
  const out = appendEvents(root, drafts, { now, fsImpl });
  if (!out.ok) return refusedWrite('decide', out);
  return {
    ok: true, action: 'decide', proposal, decision, state: 'built', path: found.rel, settled: openIds,
    skipped: record.members.filter((id: string) => !openIds.includes(id)), events: out.written.map((w: any) => w.file), exitCode: 0,
  };
}

module.exports = { proposeChecks, decideCheck, composeMessage, proposalIdFor, buildLadder, KINDS };
