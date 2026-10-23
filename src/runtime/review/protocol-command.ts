'use strict';

/**
 * `doflow protocol` (119 IC-004, D-3): the read-only view of the review and debate protocols. `--action list`
 * prints the presets and the invariants; `--action resolve` prints the IC-003 result for a kind, so a debate or
 * review brief can embed the printed protocol verbatim. It writes nothing: no telemetry, no state, no upkeep.
 * The verb has no diff, so the changed paths are unknown and a review resolves to the deep preset.
 */

const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { finishRuntime, captureCaught } = require('../cli-result.ts');
const { resolveProtocol, protocolLines } = require('./resolve-protocol.ts');
const { loadProtocolInputs } = require('./start.ts');
const { loadProtocols, presetIds } = require('./protocols.ts');

const KINDS = ['review', 'debate'];
// A preset id as protocols.ts validates it (`^[a-z][a-z0-9-]*$`).
const PRESET_ID = /^[a-z][a-z0-9-]*$/;

function seatText(seat: any): string {
  return `${seat.id}[${(seat.lenses ?? []).join(',')}]`;
}

function presetEntry(registry: any, id: string): any {
  const preset = registry.presets[id];
  return {
    id, kind: preset.kind, ...(preset.kind === 'review' ? { depth: preset.depth } : {}),
    seats: preset.seats, rounds: preset.rounds, crossAnswer: preset.crossAnswer,
    synthesizer: preset.synthesizer, decider: preset.decider,
  };
}

function presetLine(entry: any): string {
  return `preset ${entry.id}: kind=${entry.kind}${entry.depth ? ` depth=${entry.depth}` : ''} seats=${entry.seats.map(seatText).join(' ')}`
    + ` rounds=${entry.rounds.default} (min ${entry.rounds.min}) crossAnswer=${entry.crossAnswer} synthesizer=${entry.synthesizer} decider=${entry.decider}`;
}

function handleProtocolCommand({ action, kind, taskClass, risk, preset, json = false, cwd = process.cwd(), out = (line: string) => console.log(line) }: any = {}): number {
  const usage = (message: string): number => {
    out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow protocol: ${message}`);
    return finishRuntime(2);
  };
  const refuse = (error: string, message: string): number => {
    out(json ? JSON.stringify({ ok: false, error, message }) : `protocol: ${error}: ${message}`);
    return finishRuntime(1);
  };
  if (action !== 'list' && action !== 'resolve') return usage('action must be list or resolve');
  if (kind !== undefined && kind !== null && !KINDS.includes(kind)) return usage(`--kind must be one of ${KINDS.join(', ')}`);

  try {
    const loaded = loadProtocols();
    if (!loaded.ok) return refuse('protocols-invalid', loaded.errors.join('; '));
    const registry = loaded.registry;

    if (action === 'list') {
      if (taskClass != null || risk != null || preset != null) return usage('--task-class, --risk and --preset are valid only with --action resolve');
      const entries = KINDS.filter((k) => !kind || k === kind).flatMap((k) => presetIds(registry, k)).map((id) => presetEntry(registry, id));
      if (json) out(JSON.stringify({ schema: 1, presets: entries, invariants: registry.invariants }));
      else {
        for (const entry of entries) out(presetLine(entry));
        for (const inv of registry.invariants) out(`invariant ${inv.id}: ${inv.statement} (enforced by ${inv.enforcedBy})`);
      }
      return finishRuntime(0);
    }

    if (!kind) return usage('--kind is required with --action resolve');
    const { WorkflowEngine } = require('../workflow-engine.ts');
    const { loadVerificationRegistry, reviewDepthPolicy } = require('../verification/registry.ts');
    if (taskClass != null && !Object.hasOwn(new WorkflowEngine({ repoRoot: REPO_ROOT }).classes ?? {}, taskClass)) {
      return usage(`--task-class '${taskClass}' is not in the workflows data`);
    }
    const verification = loadVerificationRegistry({ repoRoot: REPO_ROOT });
    if (risk != null && !Object.hasOwn(verification.riskLevels, risk)) {
      return usage(`--risk must be one of ${Object.keys(verification.riskLevels).join(', ')}`);
    }
    if (preset != null && !(typeof preset === 'string' && PRESET_ID.test(preset))) {
      return usage('--preset must be a preset id (lower-case letters, digits and hyphens)');
    }

    const inputs = loadProtocolInputs(taskClass ?? null, cwd);
    if ('error' in inputs) return refuse(inputs.error, inputs.message);
    // No diff: `paths` is unknown, so a review is never `single` and the risk only matters to the scope rule.
    const resolved = resolveProtocol({
      kind, taskClass: taskClass ?? null, risk: risk ?? verification.policy.defaultRiskLevel, paths: null,
      runPreset: preset ?? null, advicePick: null, ...inputs, riskPolicy: reviewDepthPolicy(verification),
    });
    if (!resolved.ok) {
      const messages: Record<string, string> = {
        'preset-unknown': `--preset '${preset}' is not a ${kind} preset`,
        'preset-looser': `--preset '${preset}' is looser than the protocol this ${kind} needs; a run preset can only raise it`,
        'registry-incomplete': `the protocols registry has no ${kind} preset for the decided protocol`,
      };
      return refuse(resolved.reason, messages[resolved.reason] ?? resolved.reason);
    }
    if (json) out(JSON.stringify({ schema: 1, ok: true, protocol: resolved.protocol }));
    else for (const line of protocolLines(resolved.protocol)) out(line);
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'protocol', 1);
    console.error(`[ERROR] protocol: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

module.exports = { handleProtocolCommand };
