'use strict';

/**
 * The `followup` and `lifecycle` verb handlers (IC-006, IC-007, IC-008, IC-009). Both work on the
 * project store at the IC-001 root, so `-g` is refused with exit 2. `--json` prints the result
 * object unmodified; exit 0 = answered or written, 1 = a refusal, 2 = usage. A refusal is returned
 * by the service and printed here, never thrown, so it cannot reach failure capture (NFR-005).
 */

const { finishRuntime, usageError } = require('../cli-result');
const { projectRoot } = require('./root');
const followup = require('./followup');
const { buildOverview, initFeature, featureStatus } = require('./overview');
const { releaseFeatures, recordMerged } = require('./release');

const FOLLOWUP_ACTIONS = ['add', 'list', 'take', 'settle', 'promote', 'report'];
const LIFECYCLE_ACTIONS = ['overview', 'init', 'release', 'status', 'merged'];

function sourceText(source) {
  return [source.kind, source.feature, source.taskClass, source.taskId, source.release, source.stage, source.ref].filter(Boolean).join(' ');
}

function followupLines(result) {
  const lines = [];
  switch (result.action) {
    case 'add': for (const c of result.created) lines.push(`added ${c.id} (${sourceText(c.source)}): ${c.statement}`); break;
    case 'list':
      if (result.items.length === 0) lines.push(`No ${result.state === 'all' ? '' : `${result.state} `}follow-ups.`);
      for (const i of result.items) lines.push(`${i.id}  ${i.state}${i.takenBy ? ` by ${i.takenBy}` : ''}${i.intent ? ` -> ${i.intent}` : ''}  (${sourceText(i.source)}, ${i.added})  ${i.statement}`);
      break;
    case 'take': lines.push(`${result.feature} took ${result.ids.join(', ')}`); break;
    case 'settle': lines.push(`settled ${result.ids.join(', ')} as ${result.as}`); break;
    case 'promote': lines.push(`created ${result.intent} from ${result.ids.join(', ')}`); break;
    case 'report':
      for (const c of result.created) lines.push(`reported ${c.id} (${sourceText(c.source)}): ${c.statement}`, `  body ${c.body} (${c.bodyBytes} bytes), excerpt ${c.excerptBytes} bytes, ${c.masked} value${c.masked === 1 ? '' : 's'} masked`);
      for (const line of result.next) lines.push(`next: ${line}`);
      break;
    default: break;
  }
  return lines;
}

function overviewLines(r) {
  const lines = [`${r.mode} overview: ${r.followups.open} open follow-up${r.followups.open === 1 ? '' : 's'}, ${r.followups.shown} shown (release mode ${r.releaseMode}${r.integrationRef ? `, integration ref ${r.integrationRef}` : ''})`];
  for (const i of r.followups.items) lines.push(`  ${i.id}  (${sourceText(i.source)}, ${i.added})${i.promoted ? ` promoted to ${i.intent}` : ''}${i.pending === false ? ' settled this run' : ''}  ${i.statement}`);
  if (Array.isArray(r.failures)) {
    lines.push(`failures: ${r.failures.length} new or regressed`);
    for (const f of r.failures) lines.push(`  ${f.fp}  ${f.status}  x${f.count}  ${f.command} ${f.kind}${f.message ? `: ${f.message}` : ''}  (last seen ${f.lastSeen}, ${f.lastVersion})`);
  }
  for (const g of r.goals) lines.push(`goal ${g.goal}: ${g.items.met}/${g.items.total} items met${g.proposeDone ? ' (propose done)' : ''}`, ...g.nudges.map((n) => `  ${n}`));
  const f = r.features;
  const names = [['finished', f.finished], ['awaiting release', f.awaitingRelease], ['in progress', f.inProgress], ['unknown', f.unknown]].filter(([, list]) => list.length);
  for (const [label, list] of names) lines.push(`${label}: ${list.join(', ')}`);
  if (r.mode === 'maintain') lines.push(`pending: ${r.pending}`);
  if (r.note) lines.push(`note: ${r.note}`);
  if (r.conflicts.length) lines.push(`${r.conflicts.length} event conflict${r.conflicts.length === 1 ? '' : 's'} (see --json)`);
  if (r.unreadable.length) lines.push(`unreadable event files: ${r.unreadable.join(', ')}`);
  for (const line of r.next) lines.push(`next: ${line}`);
  return lines;
}

function releaseLines(r) {
  const lines = [`${r.recorded ? 'recorded' : 'preview of'} release ${r.tag} (previous ${r.previousTag || 'none'}, bound ${r.bound})`];
  for (const c of r.candidates) if (!r.excluded.includes(c.slug)) lines.push(`  ships ${c.slug}  (${c.evidence}${c.ref ? ` ${c.ref}` : ''})`);
  if (r.added.length) lines.push(`added: ${r.added.join(', ')}`);
  if (r.excluded.length) lines.push(`excluded: ${r.excluded.join(', ')}`);
  if (r.notDetected.length) lines.push(`not detected: ${r.notDetected.join(', ')}`);
  if (r.followupsDone.length) lines.push(`follow-ups done: ${r.followupsDone.join(', ')}`);
  if (r.note) lines.push(`note: ${r.note}`);
  for (const line of r.next) lines.push(`next: ${line}`);
  return lines;
}

function lifecycleLines(result) {
  switch (result.action) {
    case 'init': return [`${result.slug}: tracked ${result.tracked}${result.taken.length ? `, took ${result.taken.join(', ')}` : ''}${result.goal ? `, serves ${result.goal}` : ''}`, ...result.next];
    case 'status': return [`${result.slug}: ${result.status}${result.evidence ? ` (${result.evidence.kind}${result.evidence.ref ? ` ${result.evidence.ref}` : ''})` : ''}${result.release ? `, release ${result.release}` : ''}`, ...(result.note ? [`note: ${result.note}`] : [])];
    case 'release': return releaseLines(result);
    case 'merged': return [`${result.slug}: merge confirmed, now ${result.status}`];
    default: return result.mode ? overviewLines(result) : [];
  }
}

/** Prints a result and sets the exit status; shared by both verbs. */
function emit(result, json, lines) {
  if (json) console.log(JSON.stringify(result, null, 2));
  else if (result.ok === false) console.log(`${result.finding}: ${result.message}`);
  else for (const line of lines(result)) console.log(line);
  return finishRuntime(result.ok === false ? 1 : 0);
}

/** Runs `fn`, turning a caller mistake into the exit-2 usage result. */
function guarded(verb, json, fn) {
  try {
    return fn();
  } catch (error) {
    if (error instanceof followup.FollowupUsageError) return usageError(verb, error.message, json);
    throw error;
  }
}

function refuseGlobal(verb, global, json) {
  return global ? usageError(verb, `${verb} works on the project store at the repository root and refuses -g`, json) : null;
}

/**
 * `followup` verb. Actions: add, list, take, settle, promote, report.
 * @param {Object} options
 * @param {string} [options.action] absent when --action was not given
 * @param {string} options.cwd directory the verb runs from (the project, or a subfolder of it)
 * @param {Object} options.flags parsed flag values: statement, stage, source, taskClass, taskId, release,
 *   batch, channel, state, ids, as, reason, evidence, title; for report also file, stdin, text, feature
 */
function handleFollowupCommand({ action, cwd, global = false, slug = null, json = false, flags = {} } = {}) {
  const refused = refuseGlobal('followup', global, json);
  if (refused !== null) return refused;
  return guarded('followup', json, () => {
    if (!FOLLOWUP_ACTIONS.includes(action)) throw new followup.FollowupUsageError(`--action is required: one of ${FOLLOWUP_ACTIONS.join(', ')} (got '${action}')`);
    if (action !== 'report') {
      for (const name of ['file', 'stdin', 'text', 'feature']) {
        if (flags[name] !== undefined && flags[name] !== false) throw new followup.FollowupUsageError(`--${name} applies to --action report only`);
      }
    }
    for (const name of ['tag', 'confirm', 'exclude']) {
      if (flags[name] !== undefined && flags[name] !== false) throw new followup.FollowupUsageError(`--${name} applies to the lifecycle verb's --action release only, not to followup`);
    }
    const root = projectRoot(cwd || process.cwd());
    let result;
    if (action === 'report') {
      if (flags.statement === undefined) throw new followup.FollowupUsageError('--statement is required for --action report');
      result = followup.reportFollowup({
        root, statement: flags.statement, input: { file: flags.file, stdin: Boolean(flags.stdin), text: flags.text },
        release: flags.release, feature: flags.feature, channel: flags.channel,
      });
    } else if (action === 'add') {
      const batch = flags.batch !== undefined;
      if (batch && flags.statement !== undefined) throw new followup.FollowupUsageError('--batch cannot be combined with --statement');
      if (!batch && flags.statement === undefined) throw new followup.FollowupUsageError('--statement is required for --action add (or pass --batch <file.json>)');
      result = followup.addFollowups({
        root, cwd: cwd || process.cwd(), channel: flags.channel,
        items: batch ? followup.readBatchFile(flags.batch) : [{ statement: flags.statement }],
        defaults: { stage: flags.stage, slug, source: flags.source, taskClass: flags.taskClass, taskId: flags.taskId, release: flags.release, batch },
      });
    } else if (action === 'list') {
      result = followup.listFollowups({ root, state: flags.state });
    } else if (action === 'take') {
      result = followup.takeFollowups({ root, ids: flags.ids, slug, channel: flags.channel });
    } else if (action === 'settle') {
      result = followup.settleFollowups({ root, ids: flags.ids, as: flags.as, reason: flags.reason, evidence: flags.evidence, channel: flags.channel });
    } else {
      if (flags.title === undefined) throw new followup.FollowupUsageError('--title is required for --action promote');
      result = followup.promoteFollowups({ root, ids: flags.ids, title: flags.title, channel: flags.channel });
    }
    return emit(result, json, followupLines);
  });
}

/**
 * `lifecycle` verb. Actions: overview, init, release, status, merged.
 * @param {Object} options.flags parsed flag values: take, intent, goal, maintain, since, tag, confirm,
 *   feature, exclude, reason, channel
 */
function handleLifecycleCommand({ action, cwd, global = false, slug = null, json = false, flags = {} } = {}) {
  const refused = refuseGlobal('lifecycle', global, json);
  if (refused !== null) return refused;
  return guarded('lifecycle', json, () => {
    // The bare verb is the overview; the router passes no action unless --action was given.
    const act = action === undefined ? 'overview' : action;
    if (!LIFECYCLE_ACTIONS.includes(act)) throw new followup.FollowupUsageError(`--action is required: one of ${LIFECYCLE_ACTIONS.join(', ')} (got '${action}')`);
    if (flags.maintain && act !== 'overview') throw new followup.FollowupUsageError('--maintain applies to --action overview only');
    if (flags.since !== undefined && !flags.maintain) throw new followup.FollowupUsageError('--since applies to --action overview --maintain only');
    if (act !== 'release') {
      for (const name of ['tag', 'confirm', 'feature', 'exclude']) {
        if (flags[name] !== undefined && flags[name] !== false) throw new followup.FollowupUsageError(`--${name} applies to --action release only`);
      }
    }
    if (flags.reason !== undefined && act !== 'merged') throw new followup.FollowupUsageError('--reason applies to --action merged only');
    const root = projectRoot(cwd || process.cwd());
    let result;
    if (act === 'overview') result = buildOverview({ root, maintain: Boolean(flags.maintain), since: flags.since });
    else if (act === 'init') result = initFeature({ root, slug, take: flags.take, intent: flags.intent, goal: flags.goal });
    else if (act === 'release') result = releaseFeatures({ root, tag: flags.tag, confirm: Boolean(flags.confirm), features: flags.feature, exclude: flags.exclude, channel: flags.channel });
    else if (act === 'merged') result = recordMerged({ root, slug, reason: flags.reason, channel: flags.channel });
    else result = featureStatus({ root, slug });
    return emit(result, json, lifecycleLines);
  });
}

module.exports = { handleFollowupCommand, handleLifecycleCommand, FOLLOWUP_ACTIONS, LIFECYCLE_ACTIONS };
