'use strict';

/**
 * `doflow fleet` (093 V8): the cross-project, read-only Fleet verb. `--action projects` prints
 * `listProjects` (IC-019). It writes nothing: no state, no config home, no upkeep.
 */

const { finishRuntime, captureCaught } = require('../cli-result.ts');

const ALLOWED_FLAGS = new Set(['--action', '--json']);

function dash(value: unknown): string {
  return value === null || value === undefined ? '-' : String(value);
}

/** The text form: one line per project, no path (`root` is for the Console server only). */
function projectLines(body: any): string[] {
  const { excluded } = body;
  return [
    `store: ${body.store}`,
    ...body.projects.map((p: any) => `project ${p.projectKey} ${p.label}${p.current ? ' current' : ''} checkouts ${p.checkouts} sources ${p.sources.join(',')} last-record ${dash(p.lastRecordAt)}`),
    `excluded: missing ${excluded.missing} temp ${excluded.temp} not-doflow ${excluded.notDoflow} unreadable ${excluded.unreadable}`,
    ...(body.truncated ? ['truncated: true'] : []),
  ];
}

function handleFleetCommand({ action, json = false, flags = [], env = process.env, cwd = process.cwd(), exec, tempRoots, out = (line: string) => console.log(line) }: any = {}): number {
  const usage = (message: string): number => {
    out(json ? JSON.stringify({ ok: false, error: 'usage', message }) : `doflow fleet: ${message}`);
    return finishRuntime(2);
  };
  if (action !== 'projects') return usage('action must be projects');
  const extra = (flags as string[]).map((flag) => flag.split('=')[0]).find((flag) => !ALLOWED_FLAGS.has(flag));
  if (extra !== undefined) return usage(`unsupported flag ${extra}; only --action and --json apply`);

  try {
    const { listProjects } = require('./projects.ts');
    const listed = listProjects({ env, cwd, ...(exec ? { exec } : {}), ...(tempRoots ? { tempRoots } : {}) });
    if (!listed.ok) {
      if (json) out(JSON.stringify({ v: 1, error: listed.error }));
      else console.error('[ERROR] fleet: cannot list projects');
      return finishRuntime(1);
    }
    if (json) out(JSON.stringify(listed.body));
    else for (const line of projectLines(listed.body)) out(line);
    return finishRuntime(0);
  } catch (error: any) {
    captureCaught(error, 'fleet', 1);
    console.error(`[ERROR] fleet: ${error?.message || String(error)}`);
    return finishRuntime(1);
  }
}

module.exports = { handleFleetCommand };
