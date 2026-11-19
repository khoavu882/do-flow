'use strict';

// `doflow advise --action flags [--limit <n>] [--json] [-g]` (177 IC-010; FR-012): the one surface that shows a
// per-document instructs-reader flag. It reads recorded picks and never asks a model for an answer; it writes nothing and
// never prints passage text (a pick line holds none: record.ts cleanInstructsReader keeps ids, counts and flags only).
//
// Gate order, first failure wins and prints one line, `Flags are recorded and not shown: <reason>`, exit 0, with no flag
// and no count:
//   1. the kind's setting, capped by the rollout profile, is show or act and set by a settings layer;
//   2. `evaluateTrust` for the configured model (one listing call) stands at show or act;
//   3. the certifying result (project key, kind, model digest) gives `runAt`. Listed: this kind's picks with `pick: yes`,
//      `model` equal to the configured name and `at >= runAt`, newest first, at most `--limit` (default 20, at most 200),
//      from the 90-day partitions the report reads (record.ts readWindow). A pick before `runAt` may come from another
//      build of the same name, so it is never listed.

const fs = require('node:fs');
const { readWindow } = require('./record.ts');
const { resolveSetting } = require('./config.ts');
const { resolveShadowConfig } = require('./shadow-config.ts');
const { profileAdvisorCap, capMode } = require('./mode.ts');
const { materializeKind } = require('./kinds.ts');
const { evaluateTrust, projectKey } = require('./replay/trust.ts');
const { readResults } = require('./replay/results.ts');
const { maskBody } = require('../mask.ts');

const KIND = 'instructs-reader';
const MAX_AGE_DAYS = 90;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const NOT_SHOWN = 'Flags are recorded and not shown: ';
const FILTER_SENTENCE = 'A filter, not a defence: a passage not listed here can still try to instruct its reader, and nothing relies on this list for safety.';

// The closed shapes of a pick line's `instructsReader` object (record.ts cleanInstructsReader), checked again on read so a
// line written by hand cannot put text on the surface.
const ENTRY_KINDS = ['hand-back', 'retrieved', 'tool'];
const SITES = ['dispatch', 'prompt-frame'];
const REF_SHAPE = /^[A-Za-z0-9 ._/#:=-]{1,128}$/;
const BRIEF_SHAPE = /^(?:d-[0-9a-f]{12}|[A-Za-z0-9._-]{1,128})$/;
const PICK_ID = /^adv-[0-9]{13}-[0-9a-f]{6}$/;
const ISO_TIME = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?Z$/;
const STRENGTHS = ['clear', 'leaning', 'split'];

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

/** One listed flag from a pick line, or null when its screen object is not the recorded shape. */
function flagOf(record: any): any | null {
  const screen = record.instructsReader;
  if (!screen || typeof screen !== 'object' || Array.isArray(screen)) return null;
  if (!ENTRY_KINDS.includes(screen.entry) || !SITES.includes(screen.site)) return null;
  if (!count(screen.passageBytes) || !count(screen.totalBytes) || typeof screen.truncated !== 'boolean') return null;
  const ref = typeof screen.ref === 'string' ? maskBody(screen.ref).text : '';
  return {
    pickId: typeof record.pickId === 'string' && PICK_ID.test(record.pickId) ? record.pickId : null,
    at: record.at,
    site: screen.site,
    brief: typeof screen.brief === 'string' && BRIEF_SHAPE.test(screen.brief) ? screen.brief : null,
    entry: screen.entry,
    ref: REF_SHAPE.test(ref) ? ref : '(withheld)',
    passageBytes: screen.passageBytes,
    totalBytes: screen.totalBytes,
    truncated: screen.truncated,
    strength: STRENGTHS.includes(record.strength) ? record.strength : null,
  };
}

/** Gate 1: null when the kind is set by a layer to show or act under the profile's cap, else the reason. */
function settingProblem(config: any, capped: string): string | null {
  if (config.decidedBy?.mode == null && config.diagnostics?.length === 0) return 'the kind is unset';
  if (config.decidedBy?.mode == null || (capped !== 'show' && capped !== 'act')) {
    return capped === config.mode ? `the kind is ${capped}` : `the kind is ${capped} under the rollout profile (set to ${config.mode})`;
  }
  return null;
}

/**
 * The flags answer for the options given; prints nothing and writes nothing. `{exit: 0, json, total}` (`total` the
 * matching picks before `--limit`, for the text form), or `{exit: 2, message}` on a usage error. `client` is the advice
 * client whose `modelDigest` listing the trust lookup reads.
 */
async function flagsAnswer({
  registry, roots, sources = {}, projectRoot = null, env = process.env, global = false, limit: limitGiven, kind: kindGiven,
  client, now = () => new Date(), fsImpl = fs,
}: any): Promise<any> {
  if (kindGiven !== undefined && kindGiven !== null && kindGiven !== KIND) {
    return { exit: 2, message: `--action flags lists ${KIND} only; got --kind '${kindGiven}'` };
  }
  let limit = DEFAULT_LIMIT;
  if (limitGiven !== undefined && limitGiven !== null) {
    const text = String(limitGiven);
    limit = Number(text);
    if (!/^[1-9][0-9]*$/.test(text) || limit > MAX_LIMIT) return { exit: 2, message: `--limit must be a whole number from 1 to ${MAX_LIMIT}; got '${text}'` };
  }

  const deciding = projectRoot || process.cwd();
  const config = resolveShadowConfig(KIND, { projectRoot: projectRoot || undefined, env, roots, global, fsImpl });
  const model: string | null = config.model ?? null;
  const notShown = (standing: string | null, reason: string) => ({
    exit: 0, total: 0, json: { schema: 1, kind: KIND, model, shown: false, standing, reason, flags: [] },
  });

  // 1. The kind's setting under the rollout profile's cap.
  const capped = capMode(profileAdvisorCap({ projectRoot: projectRoot || undefined, env, fsImpl }), config.mode);
  const problem = settingProblem(config, capped);
  if (problem) return notShown(null, problem);

  // 2. The configured model's local result, re-judged now.
  const setting = resolveSetting({ adviceRegistry: registry, roots, env, fsImpl });
  const built = materializeKind(KIND, { adviceRegistry: registry, sources });
  const trust = await evaluateTrust({
    kind: KIND, model, provider: setting?.provider ?? undefined, endpoint: setting?.endpoint ?? undefined,
    question: built.ok ? built.question : null, registry, roots, client, projectRoot: deciding,
    timeoutMs: registry.probeTimeoutMs, fsImpl,
  });
  if (trust.standing !== 'show' && trust.standing !== 'act') return notShown(trust.standing, `${trust.standing}: ${trust.reason}`);

  // 3. The certifying result's runAt, then the picks recorded by that model name since.
  const key = projectKey(deciding, fsImpl);
  const entry = readResults({ roots, fsImpl })
    .find((item: any) => item.kind === KIND && item.modelDigest === trust.modelDigest && item.caseSet?.projectKey === key);
  const runAt = typeof entry?.runAt === 'string' && ISO_TIME.test(entry.runAt) ? Date.parse(entry.runAt) : NaN;
  if (Number.isNaN(runAt)) return notShown(trust.standing, `${trust.standing}: the certifying result has no run time`);

  const { records } = readWindow({ roots, now, maxAgeDays: MAX_AGE_DAYS, fsImpl });
  const flags = records
    .map(({ record }: any) => record)
    .filter((record: any) => record.type === 'pick' && record.kind === KIND && record.pick === 'yes' && record.model === model
      && typeof record.at === 'string' && ISO_TIME.test(record.at) && Date.parse(record.at) >= runAt)
    .map(flagOf)
    .filter(Boolean)
    .sort((a: any, b: any) => Date.parse(b.at) - Date.parse(a.at) || ((b.pickId ?? '') < (a.pickId ?? '') ? -1 : (b.pickId ?? '') > (a.pickId ?? '') ? 1 : 0));
  return {
    exit: 0, total: flags.length, runAt: entry.runAt,
    json: { schema: 1, kind: KIND, model, shown: true, standing: trust.standing, reason: trust.reason, flags: flags.slice(0, limit) },
  };
}

const minute = (iso: string) => `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;

/** The text form: one line when not shown; else a header, one line per flag and the filter sentence. */
function renderFlagsText(answer: any): string {
  const body = answer.json;
  if (!body.shown) return `${NOT_SHOWN}${body.reason}`;
  const n = body.flags.length;
  const counted = answer.total > n ? `${n} of ${answer.total}` : String(n);
  const lines = [`Flags · ${body.kind} · model ${body.model} · standing ${body.standing} · ${counted} since ${minute(answer.runAt)} UTC`];
  for (const f of body.flags) {
    const bytes = f.truncated ? `${f.passageBytes} of ${f.totalBytes} B` : `${f.totalBytes} B`;
    lines.push([minute(f.at), f.site, f.brief ?? '-', `${f.entry} ${f.ref}`, bytes, `strength ${f.strength ?? '-'}`].join('  '));
  }
  lines.push(FILTER_SENTENCE);
  return lines.join('\n');
}

module.exports = { flagsAnswer, renderFlagsText, FILTER_SENTENCE, NOT_SHOWN, KIND };
