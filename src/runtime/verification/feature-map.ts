'use strict';

/**
 * 181 C6 (IC-007): the feature map reader and validator. A feature map lists user-facing flows, each
 * with the observable outcome expected of it and, where a means exists, how to drive it. Two files
 * are read: the project's `.doflow/feature-map.json` and the feature's `<feature dir>/test/feature-map.json`.
 * A flow id in both is a finding and neither copy is used. DoFlow never writes either file.
 *
 * `readFeatureMap` answers `{ featureMap: 'present' | 'absent' | 'invalid', flows, problems }`: `flows`
 * are the valid flows (a flow with a finding is left out), and `problems` is one line per finding.
 * Any problem makes the map `invalid`; the run verb then refuses, and `compileRunEvidence` shows the
 * flows that are valid.
 *
 * 181 C6 (IC-008, IC-009): `handleFeatureMapCommand` is `verify --action feature-map`. It runs each
 * `command` flow with the verify runner (its timeout and log directory) and writes an extracted
 * evidence item; lists each `browser` flow for the agent, with whether `agent-browser` is present;
 * writes an asserted `unreached` item for a flow it has no means to drive; and files one follow-up
 * per critical flow that proposes a property-based check or a formal specification. It never drives a
 * browser and never writes a property test or a proof (NFR-005).
 */

const nodeFs = require('node:fs');
const path = require('node:path');

const FLOW_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
const LINE_MAX = 200;
const MAX_FLOWS = 64;
const FLOW_KEYS = ['id', 'title', 'expect', 'drive', 'critical', 'property', 'concurrency'];
const COMMAND_KEYS = ['kind', 'argv'];
const BROWSER_KEYS = ['kind', 'start', 'steps'];

const isObject = (value: any): boolean => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** `{state:'absent'}`, `{state:'invalid', reason}` or `{state:'ok', value}` for one JSON file. */
function readJson(file: string, fsImpl: any): any {
  let text: string;
  try { text = fsImpl.readFileSync(file, 'utf8'); } catch (error: any) {
    return error && error.code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid', reason: `${path.basename(file)} cannot be read (${error?.message ?? error})` };
  }
  try { return { state: 'ok', value: JSON.parse(text) }; } catch (error: any) {
    return { state: 'invalid', reason: `${path.basename(file)} is not valid JSON (${error?.message ?? error})` };
  }
}

/** The text is a non-empty line of at most `LINE_MAX` characters; otherwise the reason it is not. */
function lineProblem(value: any): string | null {
  if (typeof value !== 'string' || value.trim() === '') return 'must be a non-empty string';
  if (/[\r\n]/.test(value)) return 'must be one line';
  if (value.length > LINE_MAX) return `must be at most ${LINE_MAX} characters`;
  return null;
}

function unknownKeys(value: any, allowed: string[]): string[] {
  return Object.keys(value).filter((key) => !allowed.includes(key));
}

/** The reasons `drive` is invalid; empty when it is a `command` or a `browser` drive of the right shape. */
function driveProblems(drive: any): string[] {
  if (!isObject(drive)) return ['drive must be an object'];
  if (drive.kind === 'command') {
    const out = unknownKeys(drive, COMMAND_KEYS).map((key) => `drive has unknown key '${key}'`);
    if (!Array.isArray(drive.argv) || drive.argv.length === 0 || drive.argv.some((word: any) => typeof word !== 'string')
      || drive.argv[0] === '') out.push('drive.argv must be a non-empty array of strings starting with the program');
    return out;
  }
  if (drive.kind === 'browser') {
    const out = unknownKeys(drive, BROWSER_KEYS).map((key) => `drive has unknown key '${key}'`);
    if (typeof drive.start !== 'string' || drive.start.trim() === '') out.push('drive.start must be a non-empty url or path');
    if (typeof drive.steps !== 'string' || drive.steps.trim() === '') out.push('drive.steps must be a non-empty paragraph');
    else if (/\n\s*\n/.test(drive.steps)) out.push('drive.steps must be one paragraph');
    return out;
  }
  return ["drive.kind must be 'command' or 'browser'"];
}

/** A flow's own findings, or its normalised form when it has none. */
function checkFlow(raw: any): { flow: any; problems: string[] } {
  if (!isObject(raw)) return { flow: null, problems: ['is not an object'] };
  const problems = unknownKeys(raw, FLOW_KEYS).map((key) => `has unknown key '${key}'`);
  if (typeof raw.id !== 'string' || !FLOW_ID.test(raw.id)) problems.push('id must match ^[a-z0-9][a-z0-9-]{0,47}$');
  for (const key of ['title', 'expect']) { const reason = lineProblem(raw[key]); if (reason) problems.push(`${key} ${reason}`); }
  if (raw.drive !== undefined) problems.push(...driveProblems(raw.drive));
  if (raw.property !== undefined) { const reason = lineProblem(raw.property); if (reason) problems.push(`property ${reason}`); }
  for (const key of ['critical', 'concurrency']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') problems.push(`${key} must be true or false`);
  if (problems.length) return { flow: null, problems };
  return {
    flow: {
      id: raw.id, title: raw.title, expect: raw.expect, drive: raw.drive ?? null,
      critical: raw.critical === true, property: raw.property ?? null, concurrency: raw.concurrency === true,
    },
    problems,
  };
}

/** The valid flows of one map file, or why it is invalid. */
function readFlows(file: string, label: string, fsImpl: any): { state: 'absent' | 'ok' | 'invalid'; flows: any[]; problems: string[] } {
  const read = readJson(file, fsImpl);
  if (read.state === 'absent') return { state: 'absent', flows: [], problems: [] };
  if (read.state === 'invalid') return { state: 'invalid', flows: [], problems: [`${label}: ${read.reason}`] };
  const doc = read.value;
  if (!isObject(doc) || doc.version !== 1 || !Array.isArray(doc.flows)) {
    return { state: 'invalid', flows: [], problems: [`${label}: expected { "version": 1, "flows": [...] }`] };
  }
  const problems = unknownKeys(doc, ['version', 'flows']).map((key) => `${label}: unknown key '${key}'`);
  if (doc.flows.length > MAX_FLOWS) {
    return { state: 'invalid', flows: [], problems: [...problems, `${label}: ${doc.flows.length} flows; at most ${MAX_FLOWS} are allowed`] };
  }
  const flows: any[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of doc.flows.entries()) {
    const checked = checkFlow(raw);
    const name = typeof raw?.id === 'string' && raw.id !== '' ? `flow '${raw.id}'` : `flow ${i + 1}`;
    for (const problem of checked.problems) problems.push(`${label}: ${name} ${problem}`);
    if (!checked.flow) continue;
    if (seen.has(checked.flow.id)) problems.push(`${label}: flow id '${checked.flow.id}' appears twice`);
    else { seen.add(checked.flow.id); flows.push(checked.flow); }
  }
  return { state: problems.length ? 'invalid' : 'ok', flows, problems };
}

/**
 * Both map files. A flow id in both files is a finding and neither copy is used (IC-007).
 * @param {{root: string, featureDir?: string|null, fsImpl?: Object}} options
 * @returns {{featureMap: 'present'|'absent'|'invalid', flows: Array<Object>, problems: Array<string>}}
 */
function readFeatureMap({ root, featureDir, fsImpl = nodeFs }: any): { featureMap: string; flows: any[]; problems: string[] } {
  const parts = [readFlows(path.join(root, '.doflow', 'feature-map.json'), '.doflow/feature-map.json', fsImpl)];
  if (featureDir) parts.push(readFlows(path.join(featureDir, 'test', 'feature-map.json'), 'test/feature-map.json', fsImpl));
  const present = parts.filter((p) => p.state !== 'absent');
  if (present.length === 0) return { featureMap: 'absent', flows: [], problems: [] };
  const problems = present.flatMap((p) => p.problems);
  let flows = present.flatMap((p) => p.flows);
  const counts = new Map<string, number>();
  for (const flow of flows) counts.set(flow.id, (counts.get(flow.id) ?? 0) + 1);
  for (const [id, n] of counts) if (n > 1) problems.push(`flow id '${id}' is in both feature maps; neither copy is used`);
  flows = flows.filter((flow) => counts.get(flow.id) === 1);
  return { featureMap: problems.length ? 'invalid' : 'present', flows, problems };
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────

/** One argv word as the shell reads it: unchanged when plain, else quoted for the platform's shell. */
function quoteWord(word: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) return word;
  return process.platform === 'win32' ? `"${word.replace(/"/g, '\\"')}"` : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** `present` when the registry's status command for `agent-browser` answers, else `absent` (`doflow tools --action status`, read only). */
async function agentBrowserStatus(): Promise<'present' | 'absent'> {
  const { loadRegistry } = require('../../registry/index.ts');
  const { inspectTool } = require('../../install/tool-lifecycle.ts');
  const { REPO_ROOT } = require('../../helper/repo-root.ts');
  const tool = loadRegistry({ repoRoot: REPO_ROOT }).externalTools.find((entry: any) => entry.id === 'agent-browser');
  return tool && (await inspectTool(tool)).state === 'installed' ? 'present' : 'absent';
}

/** The outcome of a command flow on one line: its exit and the last line it printed. */
function observedLine(result: any): string {
  const { maskBody } = require('../mask.ts');
  const out = String((result.status === 'FAIL' ? result.stderr || result.stdout : result.stdout || result.stderr) || '');
  const last = out.split('\n').map((line: string) => line.trim()).filter(Boolean).pop() ?? '';
  const head = result.error === 'TimeoutExpired' ? `timed out (exit ${result.exitCode})` : `exit ${result.exitCode}`;
  return maskBody(last ? `${head}: ${last}` : head).text.replace(/\s+/g, ' ').slice(0, 200);
}

/** Runs one `command` flow through the verify runner; its evidence item and the part of the answer it gives. */
function runCommandFlow({ flow, runner, cwd, head }: any): { item: any; part: any } {
  const command = flow.drive.argv.map(quoteWord).join(' ');
  const result = runner.runCheck(`flow-${flow.id}`, command);
  const logPath = result.logPath ?? runner.persistLog(`flow-${flow.id}`, command, result.stdout, result.stderr);
  const rel = typeof logPath === 'string' ? path.relative(cwd, logPath) : '';
  const locator = rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel.split(path.sep).join('/') : null;
  const exitCode = Number.isInteger(result.exitCode) && result.exitCode >= 0 ? result.exitCode : 1;
  const content = observedLine(result);
  return {
    item: {
      kind: 'runtime-observation', provenance: 'extracted', source: { provider: 'doflow', capability: 'feature-map' },
      ...(locator ? { locator } : {}), content, establishes: [`flow:${flow.id}`], observation: { command, exitCode },
    },
    part: { id: flow.id, title: flow.title, critical: flow.critical, status: exitCode === 0 ? 'passed' : 'failed', action: command, observed: content, locator, commit: head, reason: null },
  };
}

/** The asserted item and part for a flow that could not be driven (IC-009). */
function unreachedFlow({ flow, reason, head }: any): { item: any; part: any } {
  return {
    item: { kind: 'runtime-observation', provenance: 'asserted', source: { provider: 'doflow', capability: 'feature-map' }, content: `unreached: ${reason}`, establishes: [`flow:${flow.id}`] },
    part: { id: flow.id, title: flow.title, critical: flow.critical, status: 'unreached', action: null, observed: `unreached: ${reason}`, locator: null, commit: head, reason },
  };
}

/** The follow-up statement of a critical flow (IC-008), kept to the follow-up store's 280 characters. */
function proposalOf(flow: any): { kind: string; statement: string } {
  if (!flow.property) return { kind: 'property-needed', statement: `Critical flow ${flow.id} needs its property named before a check can be proposed` };
  const formal = flow.concurrency === true;
  const lead = `${formal ? 'Formal specification' : 'Property check'} proposed for flow ${flow.id}: `;
  const room = 280 - lead.length;
  return { kind: formal ? 'formal' : 'property-based', statement: lead + (flow.property.length > room ? `${flow.property.slice(0, room - 1)}…` : flow.property) };
}

/** Files one follow-up per proposal unless the same-issue rule flags it against an open one; the follow-up id each names. */
function fileProposals({ flows, taskId, cwd, featureSlug, findings }: any): any[] {
  const followup = require('../lifecycle/followup.ts');
  const root = require('../lifecycle/root.ts').projectRoot(cwd);
  let taskClass = 'feature';
  try {
    const found = require('../readiness-record.ts').readReadinessRecord({ stateRoot: cwd, taskId, slug: featureSlug });
    if (found.status === 'found' && /^[A-Za-z0-9._-]+$/.test(found.record?.taskClass ?? '')) taskClass = found.record.taskClass;
  } catch { /* no readable record: the class a feature map belongs to */ }
  const proposals: any[] = [];
  for (const flow of flows.filter((entry: any) => entry.critical)) {
    const { kind, statement } = proposalOf(flow);
    try {
      const params = followup.sameIssueParams();
      const open = params ? followup.ruleMatchesOnAdd({ created: [{ id: 'FU-candidate', statement }], followups: followup.loadFollowups(root).followups, params }).get('FU-candidate') ?? [] : [];
      if (open.length > 0) { proposals.push({ flow: flow.id, kind, statement, followup: open[0].id }); continue; }
      const out = followup.addFollowups({ root, cwd, items: [{ statement, stage: 'verification', source: { kind: 'run', taskClass, taskId } }] });
      if (out.ok) proposals.push({ flow: flow.id, kind, statement, followup: out.created[0].id });
      else findings.push(`follow-up for flow '${flow.id}' not filed: ${out.message}`);
    } catch (error: any) {
      findings.push(`follow-up for flow '${flow.id}' not filed: ${error.message}`);
    }
  }
  return proposals;
}

/** Writes the items to the task's evidence ledger through the same path as `evidence --action add`. */
function writeItems({ items, taskId, cwd, featureSlug, treeState }: any): void {
  if (items.length === 0) return;
  const { EvidenceLedger } = require('../evidence-ledger.ts');
  const { toEvidence } = require('../candidate.ts');
  const ledger = new EvidenceLedger({ repoRoot: cwd, slug: featureSlug });
  ledger.load(taskId);
  const providerFreshness = new Map();
  const records = items.map((item: any) => toEvidence({ item }, { taskId, root: cwd, treeState, probeRoot: cwd, sourceRoot: cwd, slug: featureSlug, providerFreshness, sourceModeOf: null }));
  for (const record of records) ledger.addEvidence(record);
  ledger.save(taskId);
}

/**
 * `verify --action feature-map` (IC-008). Exit 0 when the map was read, including when flows failed;
 * 1 when it is invalid or absent; 2 for usage.
 * @param {{taskId: string, flows?: string[], json?: boolean, projectRoot: string, slug?: string|null, env?: Object, fsImpl?: Object, browserTool?: Function}} options
 *   `browserTool` answers `present` or `absent` for `agent-browser`; the registry's status read when omitted.
 */
async function handleFeatureMapCommand({ taskId, flows: only = [], json = false, projectRoot, slug = null, env = process.env, fsImpl = nodeFs, browserTool = agentBrowserStatus }: any): Promise<number> {
  const { finishRuntime, usageError } = require('../cli-result.ts');
  const { measureTreeState } = require('../source-version.ts');
  const { featureSlugFor } = require('../implementation-gate.ts');
  const { resolveActiveFeature } = require('../feature-resolve.ts');
  const cwd = path.resolve(projectRoot);
  const featureSlug = featureSlugFor({ projectRoot: cwd, taskId, slug });
  const treeState = measureTreeState(cwd);
  const head = treeState.gitCommit;
  const found = resolveActiveFeature({ projectRoot: cwd, slug: featureSlug });
  const map = readFeatureMap({ root: cwd, featureDir: found.error ? null : found.featureDir, fsImpl });
  if (map.featureMap !== 'present') {
    const findings = map.featureMap === 'absent' ? ['no feature map: write .doflow/feature-map.json or <feature dir>/test/feature-map.json'] : map.problems;
    if (json) console.log(JSON.stringify({ ok: false, action: 'feature-map', error: map.featureMap === 'absent' ? 'map-absent' : 'map-invalid', head, findings }));
    else for (const finding of findings) console.error(`doflow verify: ${finding}`);
    return finishRuntime(1);
  }
  const unknown = only.filter((id: string) => !map.flows.some((flow: any) => flow.id === id));
  if (unknown.length) return usageError('verify', `--flow ${unknown.join(', ')} names no flow in the feature map (flows: ${map.flows.map((flow: any) => flow.id).join(', ')})`, json);
  const chosen = only.length ? map.flows.filter((flow: any) => only.includes(flow.id)) : map.flows;

  const { VerificationContractRunner } = require('./contract-runner.ts');
  const { verifyStateRoot } = require('./engine.ts');
  const runner = new VerificationContractRunner({ cwd, logDir: path.join(verifyStateRoot({ start: cwd, env, fsImpl }).configDir, 'state', 'verification', 'logs'), fsImpl });
  const toolState = chosen.some((flow: any) => flow.drive?.kind === 'browser') ? await browserTool() : null;

  const items: any[] = [];
  const ran: any[] = [];
  const agent: any[] = [];
  const unreached: any[] = [];
  for (const flow of chosen) {
    let done: { item: any; part: any } | null = null;
    if (!flow.drive) done = unreachedFlow({ flow, reason: 'no drive in the feature map', head });
    else if (flow.drive.kind === 'command') done = runCommandFlow({ flow, runner, cwd, head });
    else {
      agent.push({ id: flow.id, start: flow.drive.start, steps: flow.drive.steps, browserTool: toolState });
      if (toolState !== 'present') done = unreachedFlow({ flow, reason: 'agent-browser not found', head });
    }
    if (!done) continue;
    items.push(done.item);
    ran.push(done.part);
    if (done.part.status === 'unreached') unreached.push({ id: flow.id, reason: done.part.reason });
  }
  const findings: string[] = [];
  try { writeItems({ items, taskId, cwd, featureSlug, treeState }); } catch (error: any) { return usageError('verify', error.message, json, error); }
  const proposals = fileProposals({ flows: chosen, taskId, cwd, featureSlug, findings });

  if (json) console.log(JSON.stringify({ ok: true, action: 'feature-map', head, ran, agent, unreached, proposals, findings }));
  else {
    console.log(`Feature map [${taskId}] on ${head ? head.slice(0, 7) : 'no commit'}: ${chosen.length} flow(s)`);
    for (const part of ran) console.log(`  ${part.id}: ${part.status}${part.action ? ` · ${part.action}` : ''} · ${part.observed}${part.locator ? ` · ${part.locator}` : ''}`);
    for (const flow of agent) console.log(`  ${flow.id}: for the agent (browser tool ${flow.browserTool}) · start ${flow.start} · ${flow.steps}`);
    for (const proposal of proposals) console.log(`  proposal ${proposal.followup}: ${proposal.statement}`);
    for (const finding of findings) console.error(`doflow verify: ${finding}`);
  }
  return finishRuntime(0);
}

module.exports = { readFeatureMap, handleFeatureMapCommand };
