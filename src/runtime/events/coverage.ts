'use strict';

// Feature 161 IC-003 (FR-009, AC-5): the `coverage` section of a `layers:<pk>` channel, and the
// fixed table of the audit records each harness's DoFlow hooks write.
//
// One row per harness of `core/registry/harnesses.json`, in registry order, each source
// `{observed: true}` or `{observed: false, reason}`:
//   main         a main session is attributed to the harness by a hook model observation
//                (the registry's `primaryProbe.model` is `payload`, as `context/primary.ts` reads it)
//   subagents    the harness's front door runs `subagent-audit` (AUDIT below)
//   transcript   the transcript registry has a reader for it and a join that is not `none`
//   permissions  the harness's front door runs `permission-audit` (AUDIT below; claude only, D8)
//   questions    never: no harness writes a record of a question or a pending prompt (D7)
//
// AUDIT is checked against the front-door hooks on disk by test/runtime/events-layers.test.ts:
// a hook added or removed without this table moving fails that test. Read-only; no path leaves.

const fs = require('node:fs');
const path = require('node:path');
const { loadTranscriptRegistry } = require('../transcripts/registry.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

/** The harnesses whose DoFlow front doors write `subagent-audit.log` and `permission-audit.log`. */
const AUDIT: Readonly<{ subagents: readonly string[]; permissions: readonly string[] }> = Object.freeze({
  subagents: Object.freeze(['claude', 'codex', 'copilot']),
  permissions: Object.freeze(['claude']),
});

type Observed = { observed: true } | { observed: false; reason: string };
const yes = (): Observed => ({ observed: true });
const no = (reason: string): Observed => ({ observed: false, reason });

/** The registry harnesses and whether their hooks observe the model (`primary.ts`'s rule); read once per process. */
let harnesses: Array<{ id: string; payload: boolean }> | null = null;
function registryHarnesses(): Array<{ id: string; payload: boolean }> {
  if (harnesses === null) {
    const parsed = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'harnesses.json'), 'utf8'));
    harnesses = parsed.harnesses.map((h: any) => ({ id: h.id, payload: h.primaryProbe?.model === 'payload' }));
  }
  return harnesses as Array<{ id: string; payload: boolean }>;
}

/** The IC-003 `coverage` body: one row per registry harness. */
function coverageBody(): any[] {
  const loaded = loadTranscriptRegistry();
  const transcripts: Record<string, any> = {};
  for (const entry of loaded.ok ? loaded.registry.entries : []) transcripts[entry.harness] = entry;
  return registryHarnesses().map(({ id, payload }) => {
    const t = transcripts[id];
    return {
      harness: id,
      main: payload ? yes() : no('no-model-observation'),
      subagents: AUDIT.subagents.includes(id) ? yes() : no('no-audit-hook'),
      transcript: !t || t.reader === null ? no('no-reader') : t.join === 'none' ? no('not-linked') : yes(),
      permissions: AUDIT.permissions.includes(id) ? yes() : no('no-harness-record'),
      questions: no('no-harness-record'),
    };
  });
}

module.exports = { coverageBody, AUDIT };
