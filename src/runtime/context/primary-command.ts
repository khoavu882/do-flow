'use strict';

/**
 * `doflow primary` (120 IC-008): the read-only view of which harness and model the main session runs.
 * `--action resolve` prints `resolvePrimary` (IC-007). It writes nothing: no state, no config home, no upkeep.
 * Loaded only when the verb, `status` or `doctor` prints the primary, never on an install path.
 */

const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { loadRegistry } = require('../../registry/index.ts');
const { finishRuntime, captureCaught } = require('../cli-result.ts');
const { resolvePrimary } = require('./primary.ts');

const ALLOWED_FLAGS = new Set(['--action', '--json']);

function dash(value: unknown): string {
  return value === null || value === undefined ? '-' : String(value);
}

/** The text form: one line per field, then each warning. */
function primaryLines(primary: any): string[] {
  const { declared, observed } = primary;
  const declaredText = declared
    ? `${declared.harness}/${dash(declared.model)} (${declared.origin.harness}${declared.origin.model ? `, model ${declared.origin.model}` : ''})`
    : '-';
  const observedText = observed ? `${observed.model} (${observed.event}, ${observed.observedAt}, sessions ${observed.sessions})` : '-';
  return [
    `state: ${primary.state}`,
    `harness: ${dash(primary.harness)}`,
    `model: ${dash(primary.model)}`,
    `family: ${primary.family}`,
    `declared: ${declaredText}`,
    `observed: ${observedText}`,
    `probe: ${primary.probe}`,
    `reason: ${dash(primary.reason)}`,
    ...primary.warnings.map((warning: string) => `warning: ${warning}`),
  ];
}

/** The origin layer of the declared harness; `default` when nothing declared one. */
function primaryOrigin(primary: any): string {
  return primary.declared?.origin?.harness ?? 'default';
}

/** `<state> <harness>/<model> (<origin>)`, the line `status` and `doctor` share. */
function primarySummary(primary: any): string {
  return `${primary.state} ${dash(primary.harness)}/${dash(primary.model)} (${primaryOrigin(primary)})`;
}

/** The `doctor` object: the probe label is `declared-only` without a probe, else the harness's recorded probe status. */
function primaryDoctorView({ primary, registry }: { primary: any; registry: any }): any {
  const entry = (registry.harnesses || []).find((harness: any) => harness?.id === primary.harness);
  const probe = primary.probe === 'none' ? 'declared-only' : (entry?.primaryProbe?.status ?? 'unverified');
  return { state: primary.state, harness: primary.harness, model: primary.model, origin: primaryOrigin(primary), probe };
}

function handlePrimaryCommand({ action, json = false, flags = [], env = process.env, cwd = process.cwd(), registry, out = (line: string) => console.log(line) }: any = {}): number {
  const usage = (message: string): number => {
    out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow primary: ${message}`);
    return finishRuntime(2);
  };
  if (action !== 'resolve') return usage('action must be resolve');
  const extra = (flags as string[]).map((flag) => flag.split('=')[0]).find((flag) => !ALLOWED_FLAGS.has(flag));
  if (extra !== undefined) return usage(`unsupported flag ${extra}; only --action and --json apply`);

  try {
    const primary = resolvePrimary({ env, projectRoot: cwd, registry });
    if (json) out(JSON.stringify(primary));
    else for (const line of primaryLines(primary)) out(line);
    return finishRuntime(primary.state === 'refused' ? 1 : 0);
  } catch (error: any) {
    captureCaught(error, 'primary', 1);
    console.error(`[ERROR] primary: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

/** The `status` and `doctor` reader: one resolution with the shipped registry; the caller handles a fault. */
function resolveForReport({ env, projectRoot, repoRoot = REPO_ROOT }: { env: any; projectRoot: string; repoRoot?: string }): { primary: any; registry: any } {
  const registry = loadRegistry({ repoRoot });
  return { primary: resolvePrimary({ env, projectRoot, registry }), registry };
}

module.exports = { handlePrimaryCommand, primaryLines, primarySummary, primaryDoctorView, resolveForReport };
