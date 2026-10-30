'use strict';

/**
 * `doflow rules`: the read-only view of the values the runtime owns for a project, each with its source, so
 * guidance and policy text can point here instead of copying numbers. Four sections:
 *   review    the protocol `review --action start` resolves per task class, attended and unattended (the real
 *             `resolveProtocol`; nothing is copied from the registries)
 *   gates     per class and gate `autopilot` and `minSeats` from the packaged gates.json, and the loop limits
 *   tiers     owner -> tier, and tier -> model per worker from `workers.models`
 *   settings  the effective value and layer of the keys above
 * A value that cannot be resolved prints as `unresolved:<reason>`. The verb writes nothing and spawns only `git`
 * (to say whether develop holds a committed gate policy).
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../helper/repo-root.ts');
const { finishRuntime, usageError, captureCaught } = require('./cli-result.ts');
const { resolveProtocol } = require('./review/resolve-protocol.ts');
const { invalidProjectCandidate, invalidPresetCandidate } = require('./review/findings.ts');

const REGISTRY = (file: string) => path.join(REPO_ROOT, 'core', 'registry', file);
const PROTOCOLS_FILE = 'core/registry/protocols.json';
const GATES_FILE = 'core/registry/gates.json';
const MODELS_FILE = 'core/registry/models.json';
const SETTINGS_FILE = 'core/registry/settings.json';
const VERIFICATION_FILE = 'core/registry/verification.json';
// Keys of the settings section, beyond the ones `resolveProtocol` reads.
const REPORT_SETTINGS = ['review.preset', 'review.rounds', 'review.sameFamily', 'autopilot.enabled'];
const GIT_LOCATION_KEYS = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_COMMON_DIR', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'];

const unresolved = (reason: unknown): string => `unresolved:${String(reason instanceof Error ? reason.message : reason).split('\n')[0].slice(0, 160)}`;
const isUnresolved = (value: unknown): boolean => typeof value === 'string' && value.startsWith('unresolved:');

/** Where an origin or layer name comes from: a registry file for a registry value, else the settings layer. */
function sourceOf(origin: string): string {
  switch (origin) {
    case 'registry': return PROTOCOLS_FILE;
    case 'floor': return GATES_FILE;
    case 'risk': return VERIFICATION_FILE;
    case 'default': return SETTINGS_FILE;
    case 'env': return 'environment';
    default: return `settings:${origin}`;
  }
}

const readJson = (file: string): any => JSON.parse(fs.readFileSync(REGISTRY(file), 'utf8'));

/** The effective `{ value, layer, source }` of a setting, or `{ value: 'unresolved:…' }` when the resolver cannot say. */
function settingEntry(settings: any, key: string, view?: string): any {
  try {
    const resolution = view ? settings.get(key, view) : settings.get(key);
    // As the protocol loader judges them: a preset key refuses any invalid layer, another review.* key an invalid project or local one.
    const invalid = key.endsWith('.preset') ? invalidPresetCandidate(resolution) : key.startsWith('review.') ? invalidProjectCandidate(resolution) : undefined;
    if (resolution.state === 'invalid' || invalid) {
      const candidate = invalid ?? resolution.candidates.find((c: any) => c.status === 'invalid');
      return { value: unresolved(`invalid ${key}${candidate ? ` in ${candidate.source}: ${candidate.reason}` : ''}`), layer: null, source: null };
    }
    const layer = resolution.origin?.layer ?? 'default';
    return { value: resolution.value ?? null, layer, source: sourceOf(layer) };
  } catch (error) {
    return { value: unresolved(error), layer: null, source: null };
  }
}

/** The keys `resolveProtocol` reads from the settings, from the registry's own `consumers` lists. */
function protocolSettingKeys(): string[] {
  return Object.entries<any>(readJson('settings.json').keys)
    .filter(([key, spec]) => key.startsWith('review.') && (spec.consumers ?? []).some((c: string) => c.endsWith('review/resolve-protocol.ts')))
    .map(([key]) => key);
}

function gitShow(project: string, args: string[]): { status: number | null; stdout: string } {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const key of GIT_LOCATION_KEYS) delete env[key];
  const res = spawnSync('git', ['-C', project, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
  return { status: res.status, stdout: typeof res.stdout === 'string' ? res.stdout : '' };
}

/** Whether the project's local develop holds a committed gate policy, and whether it is the packaged one. The working tree is never read. */
function projectPolicyState(project: string, packagedText: string): string {
  const develop = gitShow(project, ['rev-parse', '--verify', '-q', 'refs/heads/develop']);
  if (develop.status === null) return unresolved('git cannot run');
  if (develop.status !== 0) return unresolved('no local develop branch');
  const blob = gitShow(project, ['show', `refs/heads/develop:${GATES_FILE}`]);
  if (blob.status !== 0) return 'absent';
  return blob.stdout === packagedText ? 'committed on develop, same as packaged' : 'committed on develop, differs from packaged';
}

type LoadedPolicy = { policy: any; override: string; reason: string | null };

/** The gate policy as `review --action start` reads it (shipped gates.json narrowed by the project's override), and what the override did. */
function loadPolicyFor(project: string | null): LoadedPolicy {
  try {
    const loaded = require('./review/start.ts').loadGatePolicy(project);
    if (!loaded.ok) return { policy: null, override: `invalid:${loaded.reason}`, reason: loaded.reason };
    return { policy: loaded.policy, override: loaded.override, reason: null };
  } catch (error) {
    const reason = unresolved(error).slice('unresolved:'.length);
    return { policy: null, override: `invalid:${reason}`, reason };
  }
}

function gatesSection(taskClasses: string[], project: string | null, loaded: LoadedPolicy): any {
  let packagedText = '';
  try { packagedText = fs.readFileSync(REGISTRY('gates.json'), 'utf8'); } catch { /* the policy load has failed the same way */ }
  const head = {
    source: GATES_FILE, override: loaded.override,
    projectPolicy: project ? projectPolicyState(project, packagedText) : unresolved('no project'),
  };
  const policy = loaded.policy;
  if (!policy) return { policy: null, section: { ...head, classes: unresolved(loaded.reason), loop: unresolved(loaded.reason) } };
  const classes: any = {};
  for (const name of taskClasses) {
    const gates: any = {};
    for (const [gate, rule] of Object.entries<any>(policy.classes?.[name] ?? {})) {
      gates[gate] = {
        autopilot: typeof rule?.autopilot === 'string' ? rule.autopilot : unresolved('autopilot not declared'),
        minSeats: Number.isInteger(rule?.minSeats) && rule.minSeats > 0 ? rule.minSeats : 0,
      };
    }
    classes[name] = gates;
  }
  return {
    policy,
    section: {
      ...head,
      classes,
      loop: { maxSteps: policy.loop?.maxSteps ?? unresolved('loop.maxSteps not declared'), wip: policy.loop?.wip ?? unresolved('loop.wip not declared') },
    },
  };
}

function protocolRow(registry: any, protocol: any): any {
  const preset = registry.presets[protocol.id];
  const origin = protocol.origins.seats === 'floor' ? 'floor' : protocol.origins.id;
  return {
    preset: protocol.id,
    seats: { count: protocol.seats.length, roles: protocol.seats.map((seat: any) => seat.agent) },
    rounds: { min: preset.rounds.min, max: registry.hardRoundCap, default: preset.rounds.default, effective: protocol.rounds },
    crossAnswer: protocol.crossAnswer,
    synthesizer: protocol.synthesizer,
    origin,
    source: sourceOf(origin),
    ...(protocol.disagreements.length ? { disagreements: protocol.disagreements } : {}),
  };
}

/** The review section: `resolveProtocol` per class, attended (floor 0) and unattended (the class's gate-b floor). */
function reviewSection(taskClasses: string[], settings: any, gatePolicy: any, gatesReason: string | null): any {
  const classes: any = {};
  let inputs: any;
  try {
    const protocols = require('./review/protocols.ts').loadProtocols();
    if (!protocols.ok) throw new Error(protocols.errors.join('; '));
    const { loadVerificationRegistry, reviewDepthPolicy } = require('./verification/registry.ts');
    const verification = loadVerificationRegistry({ repoRoot: REPO_ROOT });
    const settingsView: any = {};
    for (const key of protocolSettingKeys()) {
      const entry = settingEntry(settings, key);
      if (isUnresolved(entry.value)) throw new Error(String(entry.value).slice('unresolved:'.length));
      settingsView[key] = { value: entry.value, layer: entry.layer };
    }
    inputs = { registry: protocols.registry, settingsView, risk: verification.policy.defaultRiskLevel, riskPolicy: reviewDepthPolicy(verification) };
  } catch (error) {
    for (const name of taskClasses) classes[name] = { attended: unresolved(error), unattended: unresolved(error) };
    return { classes };
  }
  for (const name of taskClasses) {
    const row = (unattended: boolean): any => {
      if (unattended && gatesReason) return unresolved(gatesReason);
      try {
        const resolved = resolveProtocol({
          kind: 'review', taskClass: name, risk: inputs.risk, paths: null, runPreset: null, advicePick: null,
          settingsView: inputs.settingsView, gatePolicy, unattended, registry: inputs.registry, riskPolicy: inputs.riskPolicy,
        });
        return resolved.ok ? protocolRow(inputs.registry, resolved.protocol) : unresolved(`${resolved.reason}:${resolved.field}`);
      } catch (error) {
        return unresolved(error);
      }
    };
    classes[name] = { attended: row(false), unattended: row(true) };
  }
  return { classes };
}

function tiersSection(env: Record<string, string | undefined>): any {
  let tiers: any;
  try {
    tiers = readJson('models.json').dispatchTiers;
    if (!tiers) throw new Error(`${MODELS_FILE} has no dispatchTiers`);
  } catch (error) {
    return unresolved(error);
  }
  let models: any;
  try {
    const { readBindings } = require('./worker/models.ts');
    const bindings = readBindings({ env, projectRoot: null });
    const { knownWorkerIds } = require('../registry/worker-ids.ts');
    const workers: string[] = knownWorkerIds({ registry: { harnesses: readJson('harnesses.json').harnesses } }).ids;
    models = bindings.state === 'invalid'
      ? unresolved(`workers.models ${bindings.reason}`)
      : Object.fromEntries(workers.map((worker) => [worker, Object.fromEntries(tiers.tiers.map((tier: string) => [tier, bindings.map?.[worker]?.[tier] ?? 'unset']))]));
  } catch (error) {
    models = unresolved(error);
  }
  return {
    source: MODELS_FILE, default: tiers.default, tiers: tiers.tiers, byOwner: tiers.byOwner,
    modelsSource: 'settings:user workers.models (global-only)', models,
  };
}

/** The report for `project` (null with `global`: the user layer only). */
function buildRulesReport({ taskClass = null, global = false, project = null, env = process.env }: { taskClass?: string | null; global?: boolean; project?: string | null; env?: Record<string, string | undefined> } = {}): any {
  let taskClasses: string[];
  try {
    taskClasses = Object.keys(readJson('gates.json').classes);
  } catch (error) {
    return { schema: 1, review: unresolved(error), gates: unresolved(error), tiers: tiersSection(env), settings: {} };
  }
  if (taskClass) taskClasses = taskClasses.filter((name) => name === taskClass);

  let settings: any = null;
  let settingsReason: string | null = null;
  try {
    settings = require('./settings/resolve.ts').loadSettings({ projectRoot: project, global, env: { ...env } });
  } catch (error) {
    settingsReason = unresolved(error);
  }

  let globalSettings: any = settings;
  if (settings && !global) {
    try { globalSettings = require('./settings/resolve.ts').loadSettings({ global: true, env: { ...env } }); } catch (error) { globalSettings = null; }
  }
  const loadedPolicy = loadPolicyFor(global ? null : project);
  const gates = gatesSection(taskClasses, global ? null : project, loadedPolicy);
  const report: any = { schema: 1 };
  report.review = settings
    ? reviewSection(taskClasses, settings, gates.policy, loadedPolicy.reason)
    : { classes: Object.fromEntries(taskClasses.map((name) => [name, { attended: settingsReason, unattended: settingsReason }])) };
  report.review.override = loadedPolicy.override;
  report.gates = gates.section;
  report.tiers = tiersSection(env);
  report.settings = {};
  for (const key of REPORT_SETTINGS) {
    // The autopilot switch is global-only: read it from the global view whatever the project says.
    const view = key === 'autopilot.enabled' ? globalSettings : settings;
    report.settings[key] = view
      ? settingEntry(view, key, key === 'autopilot.enabled' ? 'global' : undefined)
      : { value: settingsReason ?? unresolved('settings unreadable'), layer: null, source: null };
  }
  return report;
}

function seatsText(seats: any): string {
  const counts = new Map<string, number>();
  for (const role of seats.roles) counts.set(role, (counts.get(role) ?? 0) + 1);
  return `${seats.count} seat${seats.count === 1 ? '' : 's'} (${[...counts].map(([role, n]) => (n > 1 ? `${role} x${n}` : role)).join(', ')})`;
}

function protocolText(row: any): string {
  if (typeof row === 'string') return row;
  return `${row.preset}: ${seatsText(row.seats)}, rounds ${row.rounds.effective} (min ${row.rounds.min}, max ${row.rounds.max}), cross-answer ${row.crossAnswer ? 'on' : 'off'}, synthesizer ${row.synthesizer}, origin=${row.origin}${row.disagreements ? ` [ignored: ${row.disagreements.map((d: any) => `${d.field}=${d.value} ${d.reason}`).join('; ')}]` : ''}`;
}

/** The compact text form (about 45 lines for all nine classes). */
function rulesLines(report: any): string[] {
  const lines: string[] = [];
  if (typeof report.review === 'string') lines.push(`review: ${report.review}`);
  else lines.push(`review: protocol per task class, as \`review --action start\` resolves it (origin: registry=${PROTOCOLS_FILE}, floor=${GATES_FILE} gate-b minSeats, user|project|local=settings layer; gate override: ${report.review.override ?? 'none'})`);
  for (const [name, rows] of Object.entries<any>(report.review.classes ?? {})) {
    lines.push(`  ${name} attended:   ${protocolText(rows.attended)}`);
    lines.push(`  ${name} unattended: ${protocolText(rows.unattended)}`);
  }
  lines.push('');
  if (typeof report.gates === 'string') lines.push(`gates: ${report.gates}`);
  else {
    lines.push(`gates: ${report.gates.source}; override: ${report.gates.override}; develop policy: ${report.gates.projectPolicy}`);
    const none: string[] = [];
    if (typeof report.gates.classes === 'string') lines.push(`  ${report.gates.classes}`);
    else for (const [name, gates] of Object.entries<any>(report.gates.classes)) {
      const entries = Object.entries<any>(gates);
      if (entries.length === 0) none.push(name);
      for (const [gate, rule] of entries) lines.push(`  ${name} ${gate}: autopilot=${rule.autopilot} minSeats=${rule.minSeats}`);
    }
    if (none.length) lines.push(`  no gates declared: ${none.join(', ')}`);
    if (typeof report.gates.loop !== 'string') lines.push(`  loop: maxSteps=${report.gates.loop.maxSteps} wip=${report.gates.loop.wip}`);
  }
  lines.push('');
  if (typeof report.tiers === 'string') lines.push(`tiers: ${report.tiers}`);
  else {
    lines.push(`tiers: owner -> tier from ${report.tiers.source} (default ${report.tiers.default}; tiers ${report.tiers.tiers.join(', ')})`);
    lines.push(`  ${Object.entries(report.tiers.byOwner).map(([owner, tier]) => `${owner}=${tier}`).join(' ')}`);
    if (typeof report.tiers.models === 'string') lines.push(`  models: ${report.tiers.models}`);
    else {
      const set = Object.entries<any>(report.tiers.models).filter(([, byTier]) => Object.values(byTier).some((model) => model !== 'unset'));
      lines.push(`  model per worker and tier (${report.tiers.modelsSource}): ${set.length === 0 ? `unset for all ${Object.keys(report.tiers.models).length} workers` : ''}`.trimEnd());
      for (const [worker, byTier] of set) lines.push(`    ${worker}: ${Object.entries(byTier).map(([tier, model]) => `${tier}=${model}`).join(' ')}`);
    }
  }
  lines.push('');
  lines.push('settings: effective value and layer');
  for (const [key, entry] of Object.entries<any>(report.settings)) {
    lines.push(`  ${key} = ${isUnresolved(entry.value) ? entry.value : JSON.stringify(entry.value)}${entry.layer ? ` (${entry.layer}, ${entry.source})` : ''}`);
  }
  return lines;
}

function handleRulesCommand({ taskClass, json = false, global = false, positional = [], env = process.env, cwd = process.cwd(), out = (line: string) => console.log(line) }: any = {}): number {
  const usage = (message: string): number => usageError('rules', message, false);
  try {
    if (positional.length > 1) return usage(`unexpected positional argument '${positional[1]}'`);
    if (global && positional.length > 0) return usage('-g reads the user layer only and takes no project');
    let project: string | null = null;
    if (!global) {
      project = path.resolve(cwd, positional[0] ?? '.');
      if (!fs.existsSync(project) || !fs.statSync(project).isDirectory()) return usage(`project '${positional[0]}' is not a directory`);
    }
    if (taskClass != null) {
      let known: string[] = [];
      try { known = Object.keys(readJson('gates.json').classes); } catch { /* every class is then unchecked; the report says unresolved */ }
      if (known.length > 0 && !known.includes(taskClass)) return usage(`--task-class '${taskClass}' is not a task class (${known.join(', ')})`);
    }
    const report = buildRulesReport({ taskClass, global, project, env });
    if (json) out(JSON.stringify(report));
    else for (const line of rulesLines(report)) out(line);
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'rules', 1);
    console.error(`[ERROR] rules: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

module.exports = { handleRulesCommand, buildRulesReport, rulesLines };
