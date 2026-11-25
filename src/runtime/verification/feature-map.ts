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

module.exports = { readFeatureMap };
