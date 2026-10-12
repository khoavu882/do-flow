'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * MCP consultation resolver (062 CH4, IC-005 and IC-007 to IC-011).
 *
 * At a stage handoff this decides which MCP servers the stage run names, resolves one outcome per
 * server in a fixed order, reads `Tools used:` lines out of the reports briefs named, and returns
 * the record to store, the warnings and notices to print, and the evidence items to add.
 *
 * Pure: it reads only what the caller injects (ledger, research-request store, brief records,
 * report reader, reach object) and writes nothing. No model call, no network, no server or
 * provider name in code: every id comes from the registry argument (NFR-001, NFR-008). Text an MCP
 * server returned never reaches here as anything but a flag token, a claim attribution or an
 * install fact, so it cannot decide a state or a warning (NFR-006).
 */

const OUTCOME_STATES = Object.freeze(['consulted-used', 'consulted-nothing-usable', 'skipped', 'unavailable']);

/** Five distinct labels (NFR-007). `no-outcome` is derived, never stored. A skipped outcome's
 * text surfaces append its reason: see `outcomeLabel`. */
const OUTCOME_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'consulted-used': 'consulted, used',
  'consulted-nothing-usable': 'consulted, nothing usable',
  skipped: 'skipped',
  unavailable: 'unavailable',
  'no-outcome': 'no outcome recorded',
});

const FLAG_TOKEN_STATE: Readonly<Record<string, string>> = Object.freeze({
  used: 'consulted-used',
  'nothing-usable': 'consulted-nothing-usable',
  unavailable: 'unavailable',
});

const SERVER_FLAG_ID = /^[a-z][a-z0-9-]*$/;
const TOOL_NAME = /^[A-Za-z0-9_.:/-]+$/;
const REASON = /^[^,\r\n]{1,120}$/;
const CONTENT_LIMIT = 500;
const SCHEMA = 1;

// used > nothing usable > unavailable > skipped (IC-008 rule 2).
const PRECEDENCE: Readonly<Record<string, number>> = Object.freeze({
  'consulted-used': 4, 'consulted-nothing-usable': 3, unavailable: 2, skipped: 1,
});

function outcomeLabel(outcome: any): string {
  const label = OUTCOME_LABELS[outcome.state];
  return outcome.state === 'skipped' && outcome.reason ? `${label}: ${outcome.reason}` : label;
}

/**
 * Parse one outcome token (IC-005 flag token). Returns `{ state, reason? }` or `{ error }`.
 * @param {string} token
 */
function parseOutcomeToken(token: any): any {
  const text = String(token ?? '').trim();
  if (Object.hasOwn(FLAG_TOKEN_STATE, text)) return { state: FLAG_TOKEN_STATE[text] };
  if (text === 'skipped' || text === 'skipped:') return { error: 'skipped needs a reason: skipped:<reason>' };
  if (text.startsWith('skipped:')) {
    const reason = text.slice('skipped:'.length).trim();
    if (!REASON.test(reason)) return { error: 'skipped reason must be 1 to 120 characters with no comma or newline' };
    return { state: 'skipped', reason };
  }
  return { error: `unknown outcome '${text}'; use used, nothing-usable, unavailable or skipped:<reason>` };
}

/**
 * Parse the repeatable `--mcp-outcome` values (IC-006). A bad value is returned in `ignored`
 * with its reason and never in `outcomes`; the first value for a server wins.
 * @param {string[]|string|undefined} values
 * @returns {{ outcomes: Map<string, {state: string, reason?: string}>, ignored: Array<{value: string, reason: string}> }}
 */
function parseMcpOutcomeFlags(values?: string[] | string | null): { outcomes: Map<string, any>; ignored: Array<{ value: string; reason: string }> } {
  const list: any[] = values === undefined || values === null ? [] : ([] as any[]).concat(values);
  const outcomes = new Map<string, any>();
  const ignored: Array<{ value: string; reason: string }> = [];
  for (const raw of list) {
    const value = String(raw);
    const at = value.indexOf('=');
    const server = at === -1 ? '' : value.slice(0, at).trim();
    if (at === -1 || !SERVER_FLAG_ID.test(server)) {
      ignored.push({ value, reason: 'expected <server>=<outcome> with a lowercase server id' });
      continue;
    }
    const parsed = parseOutcomeToken(value.slice(at + 1));
    if (parsed.error) { ignored.push({ value, reason: parsed.error }); continue; }
    if (outcomes.has(server)) { ignored.push({ value, reason: `outcome for '${server}' was already given` }); continue; }
    outcomes.set(server, parsed);
  }
  return { outcomes, ignored };
}

/** Strip a leading `- `, `**...**` emphasis and a line-wide pair of backticks, so
 * `- **Tools used:** a` and `` `Tools used: a` `` both read as `Tools used: a`. */
function plainLine(line: string): string {
  let text = line.trim().replace(/^-\s+/, '');
  if (text.startsWith('**')) text = text.slice(2).replace('**', '');
  if (text.startsWith('`Tools used:') && text.endsWith('`')) text = text.slice(1, -1);
  return text;
}

/** Split on commas outside parentheses, so a note like `(a, b)` stays with its entry. */
function splitEntries(body: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of body) {
    if (char === '(') depth += 1;
    else if (char === ')' && depth > 0) depth -= 1;
    if (char === ',' && depth === 0) { pieces.push(current); current = ''; } else current += char;
  }
  pieces.push(current);
  return pieces;
}

/** One entry with a trailing ` (note)` and a surrounding pair of backticks removed. */
function plainEntry(piece: string): string {
  let text = piece.trim().replace(/\s+\([^()]*\)$/, '').trim();
  if (text.length > 1 && text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1).trim();
  return text;
}

/**
 * Parse the last `Tools used:` line of a report (IC-009).
 * @param {string} text report text
 * @returns {null | { line: number, raw: string, entries: Array<{name: string, state?: string, reason?: string, raw: string, valid: boolean}> }}
 */
function parseToolsUsed(text: any): any {
  const lines = String(text ?? '').split('\n');
  let found = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (plainLine(lines[i]).startsWith('Tools used:')) found = i;
  }
  if (found === -1) return null;
  const raw = lines[found].replace(/\s+$/, '').trim();
  const body = plainLine(lines[found]).slice('Tools used:'.length).trim();
  const entries: any[] = [];
  if (body !== '' && body !== 'none') {
    for (const piece of splitEntries(body)) {
      const entry = plainEntry(piece);
      if (entry === '') continue;
      const at = entry.indexOf('=');
      const name = at === -1 ? entry : entry.slice(0, at).trim();
      if (!TOOL_NAME.test(name)) { entries.push({ name: entry, raw: entry, valid: false }); continue; }
      if (at === -1) { entries.push({ name, state: 'consulted-used', raw: entry, valid: true }); continue; }
      const parsed = parseOutcomeToken(entry.slice(at + 1));
      if (parsed.error) { entries.push({ name, raw: entry, valid: false }); continue; }
      entries.push({ name, ...parsed, raw: entry, valid: true });
    }
  }
  return { line: found + 1, raw, entries };
}

/** Server ids the registry knows: `mcp` servers plus every provider's `mcp.server`. */
function knownServerIds(registry: any): Set<string> {
  const ids = new Set<string>((registry?.mcp || []).map((server: any) => server.id));
  for (const capability of Object.values(registry?.capabilities || {}) as any[]) {
    for (const provider of capability?.providers || []) {
      if (provider?.mcp?.server) ids.add(provider.mcp.server);
    }
  }
  return ids;
}

/**
 * Servers a stage run names (IC-001 meaning). Sorted.
 * @param {{registry: object, skill: string, stageId?: string, taskId?: string, requests?: {list: Function}}} input
 */
function namedServers({ registry, skill, stageId, taskId, requests }: any): string[] {
  let researchRequested: boolean | undefined;
  const hasRequest = (): boolean => {
    if (researchRequested === undefined) {
      let list: any = [];
      try { list = requests && taskId ? requests.list(taskId) : []; } catch { list = []; }
      researchRequested = Array.isArray(list) && list.some((request: any) => request && request.stageId === stageId);
    }
    return researchRequested;
  };
  const named = new Set<string>();
  for (const server of registry?.mcp || []) {
    for (const step of server.steps || []) {
      if (step.expectedWhen === 'research-request') {
        if (hasRequest()) named.add(server.id);
      } else if (step.skill === skill) {
        named.add(server.id);
      }
    }
  }
  return [...named].sort();
}

const bySortKey = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Resolve a stage run's MCP consultations (IC-008).
 *
 * Injected readers (all optional; a missing one contributes nothing):
 * - `ledger.queryEvidence({taskId})` -> evidence items (active ones count)
 * - `requests.list(taskId)` -> research requests
 * - `briefRecords` -> IC-018 records already parsed, each `{ runTaskId, stage, tasks, expected }`
 * - `readReport(path)` -> report text, or null when the file is missing
 * - `reach.anyHarnessHas(server)` -> true | false | null (unknown); never decides an outcome
 * - `reach.harnessWith(server)` -> the display name of a harness that has the server, or null
 * - `harnessName(id)` -> a harness id's display name (for a brief record's `harness`)
 * - `addCommand(server)` -> the text after "add it:" in the unavailable notice
 * - `since` -> ISO time of the previous stage's completion (or the run start); rule 3 counts only
 *   evidence observed after it
 *
 * @returns {{ record: object, warnings: object[], notices: object[], evidenceToAdd: object[] }}
 */
function resolveConsultations({
  taskId = null, stageId = null, skill, flags, registry, ledger, requests,
  briefRecords = [], readReport, reach, addCommand, harnessName, since = null,
}: any = {}): { record: any; warnings: any[]; notices: any[]; evidenceToAdd: any[] } {
  const warnings: any[] = [];
  const notices: any[] = [];
  const evidenceToAdd: any[] = [];
  const registered = new Set((registry?.mcp || []).map((server: any) => server.id));
  const known = knownServerIds(registry);
  const named = namedServers({ registry, skill, stageId, taskId, requests });

  // Rule 1: flags.
  const parsedFlags = parseMcpOutcomeFlags(flags);
  for (const bad of parsedFlags.ignored) {
    warnings.push({
      kind: 'ignored-flag',
      text: `[WARN] mcp: ignored --mcp-outcome '${bad.value}': ${bad.reason}`,
    });
  }

  // Rule 2: Tools used lines in the reports of this run's briefs. Records with no stage are never
  // ingested (design A6).
  const toolsUsed: any[] = [];
  const fromReports = new Map<string, any[]>();
  const records = (Array.isArray(briefRecords) ? briefRecords : [])
    .filter((record: any) => record && stageId && taskId && record.stage === stageId && record.runTaskId === taskId);
  const reports: Array<{ id: string; report: string }> = [];
  for (const record of records) {
    for (const task of record.tasks || []) {
      if (task && typeof task.id === 'string' && typeof task.report === 'string') reports.push({ id: task.id, report: task.report });
    }
  }
  reports.sort((a, b) => bySortKey(a.id, b.id) || bySortKey(a.report, b.report));
  const existing = new Map<string, any[]>();
  const existingFor = (id: string): any[] => {
    if (!existing.has(id)) {
      let items: any[] = [];
      try { items = ledger ? ledger.queryEvidence({ taskId: id }) : []; } catch { items = []; }
      existing.set(id, items.filter((item: any) => item && item.status === 'active'));
    }
    return existing.get(id) as any[];
  };
  for (const { id, report } of reports) {
    let text: any = null;
    try { text = typeof readReport === 'function' ? readReport(report) : null; } catch { text = null; }
    if (typeof text !== 'string') {
      toolsUsed.push({ taskId: id, status: 'no-report', report });
      warnings.push({
        kind: 'tools-used-no-report', taskId: id,
        text: `[WARN] tools-used: task ${id} has no report at ${report}`,
      });
      continue;
    }
    const parsed = parseToolsUsed(text);
    if (!parsed) {
      toolsUsed.push({ taskId: id, status: 'no-line', report });
      warnings.push({
        kind: 'tools-used-missing', taskId: id,
        text: `[WARN] tools-used: task ${id} report ${report} has no "Tools used:" line`,
      });
      continue;
    }
    const source = { provider: 'dispatched-agent', capability: 'tools-used' };
    const content = parsed.raw.slice(0, CONTENT_LIMIT);
    const duplicate = existingFor(id).find((item: any) => item.source?.provider === source.provider
      && item.source?.capability === source.capability && item.content === content);
    const inBatch = evidenceToAdd.some((item: any) => item.taskId === id && item.content === content);
    if (duplicate) {
      toolsUsed.push({ taskId: id, status: 'already-recorded', evidenceId: duplicate.id });
    } else if (inBatch) {
      toolsUsed.push({ taskId: id, status: 'already-recorded' });
    } else {
      toolsUsed.push({ taskId: id, status: 'recorded' });
      evidenceToAdd.push({
        taskId: id, kind: 'generated-analysis', provenance: 'asserted', source, content,
        locator: { file: report, line: parsed.line }, establishes: [],
      });
    }
    for (const entry of parsed.entries) {
      if (!entry.valid && known.has(entry.name)) {
        warnings.push({ kind: 'tools-used-unparsed', taskId: id, text: `[WARN] tools-used: unparsed entry '${entry.raw}'` });
      }
      if (!entry.valid || !known.has(entry.name)) continue;
      const list = fromReports.get(entry.name) || [];
      list.push({ state: entry.state, reason: entry.reason, taskId: id });
      fromReports.set(entry.name, list);
    }
  }

  // Rule 3: evidence attributed to a server by `source.provider`, observed during this stage run:
  // after `since` (the previous stage's completion or the run start) when the caller knows it.
  const evidenceServers = new Set<string>();
  const inThisStage = (item: any): boolean => since === null || (typeof item.freshness?.observedAt === 'string' && item.freshness.observedAt > since);
  if (ledger && taskId) {
    let items: any[] = [];
    try { items = ledger.queryEvidence({ taskId }); } catch { items = []; }
    for (const item of items) {
      if (item && item.status === 'active' && known.has(item.source?.provider) && inThisStage(item)) evidenceServers.add(item.source.provider);
    }
  }

  // Rule 4: a brief record for this stage that expected the server and found it unreachable. The
  // brief writes `unreachable` only where every config the harness merges was read (IC-017).
  const unreachable = new Map<string, any>();
  const reachableOn = new Map<string, any>();
  for (const record of records) {
    for (const expected of record.expected || []) {
      if (!expected || typeof expected.server !== 'string') continue;
      if (expected.reach === 'unreachable' && !unreachable.has(expected.server)) unreachable.set(expected.server, record.tasks?.[0]?.id);
      if (expected.reach === 'reachable' && !reachableOn.has(expected.server)) reachableOn.set(expected.server, record.harness ?? null);
    }
  }

  /** Who has a server the run asserted unavailable: the brief's harness, else an installed one. */
  const nameOf = (id: any): string => (typeof harnessName === 'function' && harnessName(id)) || id;
  const contradiction = (server: string): string | null => {
    if (reachableOn.has(server)) {
      const id = reachableOn.get(server);
      return id ? nameOf(id) : 'an installed harness';
    }
    let has: any = null;
    try { has = reach && typeof reach.anyHarnessHas === 'function' ? reach.anyHarnessHas(server) : null; } catch { has = null; }
    if (has !== true) return null;
    let name: any = null;
    try { name = typeof reach.harnessWith === 'function' ? reach.harnessWith(server) : null; } catch { name = null; }
    return name || 'an installed harness';
  };

  const candidates = new Set([
    ...named, ...parsedFlags.outcomes.keys(), ...fromReports.keys(), ...evidenceServers, ...unreachable.keys(),
  ]);
  const outcomes: any[] = [];
  for (const server of [...candidates].sort()) {
    let outcome: any = null;
    const flag = parsedFlags.outcomes.get(server);
    if (flag) {
      outcome = { server, state: flag.state, ...(flag.reason ? { reason: flag.reason } : {}), source: 'flag' };
    } else if (fromReports.has(server)) {
      const best = (fromReports.get(server) as any[]).reduce((a: any, b: any) => (PRECEDENCE[b.state] > PRECEDENCE[a.state] ? b : a));
      outcome = {
        server, state: best.state, ...(best.reason ? { reason: best.reason } : {}), source: 'tools-used', taskId: best.taskId,
      };
    } else if (evidenceServers.has(server)) {
      outcome = { server, state: 'consulted-used', source: 'evidence' };
    } else if (unreachable.has(server)) {
      const firstTask = unreachable.get(server);
      outcome = { server, state: 'unavailable', source: 'brief', ...(firstTask ? { taskId: firstTask } : {}) };
    }
    // Install facts alone never decide an outcome (rule 5): a server DoFlow does not see may still
    // be loaded from a config it cannot read, so the no-outcome warning asks instead.

    if (flag && !registered.has(server)) {
      notices.push({
        kind: 'unregistered-server', server,
        text: `[INFO] mcp: ${server} is not in DoFlow's MCP registry; recorded as given`,
      });
    }
    if (!outcome) {
      warnings.push({
        kind: 'no-outcome', server,
        text: `[WARN] mcp: ${skill} recorded no outcome for ${server}; pass --mcp-outcome ${server}=used|nothing-usable|skipped:<reason>|unavailable`,
      });
      continue;
    }
    outcomes.push(outcome);
    if (outcome.state === 'unavailable') {
      const has = outcome.source === 'flag' || outcome.source === 'tools-used' ? contradiction(server) : null;
      if (has) {
        warnings.push({
          kind: 'unavailable-contradicted', server,
          text: `[WARN] mcp: ${server} reported unavailable but ${has} has it configured`,
        });
      }
      const add = !has && typeof addCommand === 'function' ? addCommand(server) : null;
      notices.push({
        kind: 'unavailable', server,
        text: `[INFO] mcp: ${server} unavailable to ${skill}${add ? `; add it: ${add}` : ''}`,
      });
    }
  }

  toolsUsed.sort((a, b) => bySortKey(a.taskId, b.taskId));
  return {
    record: { schema: SCHEMA, skill, named, outcomes, toolsUsed },
    warnings,
    notices,
    evidenceToAdd,
  };
}

module.exports = {
  OUTCOME_STATES,
  OUTCOME_LABELS,
  outcomeLabel,
  parseOutcomeToken,
  parseMcpOutcomeFlags,
  parseToolsUsed,
  namedServers,
  resolveConsultations,
};
