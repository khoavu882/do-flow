'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Codex config.toml reconciliation.  This module deliberately manages individual,
// manifest-backed keys rather than serialising a whole TOML document.  The latter would either
// require a TOML dependency or, more importantly, risk reformatting/deleting a user's settings.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseToml, stripComment, tableViolations } = require('../../helper/toml.ts');

const CONFIG_NAME = 'config.toml';
const CONFIG_KIND = 'configuration-entry';

function configPath({ scope, codexDir, projectRoot, paths }: { scope?: string, codexDir?: string, projectRoot?: string, paths?: any } = {}): string {
  // Preferred: the declared path resolved by the adapter (harnesses.json "paths".configFile).
  if (paths?.configFile) return paths.configFile;
  // Legacy derivation for direct callers passing raw scope inputs (tests, reconcileCodexConfig);
  // kept byte-compatible with the declaration the lifecycle path always supplies.
  if (scope === 'global') {
    if (!codexDir) throw new Error('codexDir is required for global Codex configuration');
    return path.join(codexDir, CONFIG_NAME);
  }
  if (scope === 'project') {
    if (!projectRoot) throw new Error('projectRoot is required for project Codex configuration');
    return path.join(projectRoot, '.codex', CONFIG_NAME);
  }
  throw new Error(`Unsupported Codex configuration scope: ${scope}`);
}

function fingerprint(value: any): string {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function commentSuffix(line: string): string {
  const withoutComment = stripComment(line);
  return line.slice(withoutComment.length);
}

function renderValue(value: any): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  throw new Error('Managed Codex config values must be boolean, number, or string');
}

function normaliseDesired(resources: any): Map<string, any> {
  const result = new Map<string, any>();
  for (const resource of resources || []) {
    if (!resource || (resource.kind && resource.kind !== CONFIG_KIND && resource.kind !== 'config-entry')) continue;
    const identity = resource.identity ?? resource.key;
    if (!identity || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(identity)) {
      throw new Error('A managed Codex configuration resource requires a dotted identity');
    }
    if (!Object.hasOwn(resource, 'value')) throw new Error(`Managed Codex configuration '${identity}' requires a value`);
    renderValue(resource.value);
    if (result.has(identity)) throw new Error(`Duplicate desired Codex configuration resource '${identity}'`);
    result.set(identity, { ...resource, identity, kind: resource.kind ?? CONFIG_KIND });
  }
  return result;
}

/** The comment on a line DoFlow added to a table the user opened with no entry: it is how removal
 * knows to keep the user's header and restore the file's exact bytes. */
function addedMarker(table: string): string { return ` # DoFlow added this to your [${table}] table`; }

/** Where a new entry `<table>.<key>` goes in the parsed file: after the last entry of its table;
 * on the line right after the table's empty header, marked; as a root dotted line after the last
 * root dotted line of that table; refused (`valueEntry`) when the table or a parent of it is set as
 * a value, which TOML cannot extend; otherwise in a new table (no `at`). */
function placeEntry(identity: string, value: any, parsed: any): any {
  const parts = identity.split('.');
  const table = parts.slice(0, -1).join('.');
  const rendered = renderValue(value);
  const assignment = `${parts.at(-1)} = ${rendered}`;
  const entries: any[] = [...parsed.entries];
  const after = (items: any[]) => Math.max(...items.map(([, entry]: any) => entry.line)) + 1;
  const inTable = entries.filter(([, entry]: any) => entry.table === table);
  if (inTable.length) return { table, at: after(inTable), line: assignment };
  const header = parsed.headers.find((item: any) => item.table === table);
  if (header) return { table, at: header.line + 1, line: `${assignment}${addedMarker(table)}` };
  const dotted = entries.filter(([key, entry]: any) => entry.table === '' && key.startsWith(`${table}.`));
  if (dotted.length) return { table, at: after(dotted), line: `${identity} = ${rendered}` };
  const valueEntry = entries.find(([key]: any) => key === table || table.startsWith(`${key}.`));
  if (valueEntry) return { table, valueEntry };
  return { table, line: assignment };
}

/** Whether a managed entry's line is one placeEntry put into the user's own table: marked, or
 * written as a dotted key outside its table. */
function placedLine(identity: string, entry: any, lines: any[]): boolean {
  const table = identity.split('.').slice(0, -1).join('.');
  return entry.table !== table || lines[entry.line].trimEnd().endsWith(addedMarker(table));
}

/** A conflict when `content` breaks a TOML table rule that `original` did not already break, so a
 * file that was valid is never written invalid; null otherwise. */
function newViolation({ file, original, content, identities }: { file: string, original: string, content: string, identities: string[] }): string | null {
  const refused = (reason: string) => `${file}: DoFlow cannot write ${identities.map((identity) => `'${identity}'`).join(', ')} without making the file invalid TOML (${reason}). Nothing was written.`;
  const before = tableViolations(original);
  let after;
  try { after = tableViolations(content); } catch (error: any) { return refused(error.message); }
  const added = after.find((item: any) => !before.some((known: any) => known.kind === item.kind && known.table === item.table));
  return added ? refused(`${added.kind} '${added.table}' on line ${added.line}`) : null;
}

function isOwnedRecord(resource: any, scope: any): boolean {
  return resource && resource.target === 'codex' && resource.scope === scope &&
    (resource.kind === CONFIG_KIND || resource.kind === 'config-entry') && typeof resource.identity === 'string';
}

/**
 * @param {Object} options
 * @param {boolean} [options.adopt=false] accept a config entry that exists with no ledger record,
 *   recording ownership of it instead of refusing. Distinct from `force`, which overrides a record
 *   that *disagrees* with the file: adoption only ever covers the no-record case, and a resource
 *   whose record contradicts its bytes stays a conflict here whatever `adopt` says. Without this,
 *   entries written before the neutral ledger existed could never be re-adopted — the condition
 *   blocking the install was the same condition an install had to run to clear.
 */
function planCodexConfig({ file, scope, managedResources = [], desiredResources = [], adopt = false }: { file: string, scope?: any, managedResources?: any[], desiredResources?: any[], adopt?: boolean }): any {
  const original = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  let parsed;
  try { parsed = parseToml(original); } catch (error: any) {
    return { ok: false, status: 'malformed', file, original, changes: [], conflicts: [error.message], managedResources };
  }
  let desired;
  try { desired = normaliseDesired(desiredResources); } catch (error: any) {
    return { ok: false, status: 'invalid-request', file, original, changes: [], conflicts: [error.message], managedResources };
  }
  const owned = new Map<string, any>(managedResources.filter((resource: any) => isOwnedRecord(resource, scope)).map((resource: any) => [resource.identity, resource]));
  const changes: any[] = [];
  const conflicts: string[] = [];
  const placements = new Map<string, any>();
  const all = new Set([...desired.keys(), ...owned.keys()]);
  for (const identity of all) {
    const entry = parsed.entries.get(identity);
    const record = owned.get(identity);
    const wanted = desired.get(identity);
    if (!record && entry && !adopt) {
      conflicts.push(`'${identity}' exists but is not owned by DoFlow`);
      continue;
    }
    // Adopting: no `continue`, so the entry goes through ordinary planning below. Ownership is
    // recorded either way — `nextManagedResources` is rebuilt from `desired` regardless of what was
    // owned before — so adoption needs nothing beyond not refusing here.
    if (record && entry && record.fingerprint !== fingerprint(entry.value)) {
      conflicts.push(`'${identity}' was modified outside DoFlow`);
      continue;
    }
    if (wanted && (!entry || fingerprint(entry.value) !== fingerprint(wanted.value))) {
      changes.push({ type: entry ? 'update' : 'create', identity, value: wanted.value, line: entry?.line });
      if (!entry) {
        const placement = placeEntry(identity, wanted.value, parsed);
        if (placement.valueEntry) {
          const [prefix, held] = placement.valueEntry;
          conflicts.push(`${file}: '${prefix}' is set as a value on line ${held.line + 1}, so DoFlow cannot add '${identity}' to it. Write it as a [${prefix}] table and run the command again. Nothing was written.`);
        }
        placements.set(identity, placement);
      }
    } else if (!wanted && entry) {
      changes.push({ type: 'remove', identity, line: entry.line });
    }
  }
  if (conflicts.length) return { ok: false, status: 'conflict', file, original, changes: [], conflicts, managedResources };
  const nextLines = [...parsed.lines];
  for (const change of changes.filter((change: any) => change.type === 'update')) {
    const key = change.identity.split('.').at(-1);
    const originalLine = nextLines[change.line];
    const indentation = originalLine.match(/^\s*/)![0];
    // A user comment beside an owned value is still user content. Retain it even though the
    // owned scalar changes, so reconciliation does not silently erase unrelated explanation.
    const suffix = commentSuffix(originalLine);
    nextLines[change.line] = `${indentation}${key} = ${renderValue(change.value)}${suffix && !/^\s/.test(suffix) ? ' ' : ''}${suffix}`;
  }
  // A line DoFlow placed in the user's own table (marker or dotted form) is deleted outright and its
  // header kept, so the file returns to its exact bytes. Any other removal leaves a blank line.
  const removals = changes.filter((change: any) => change.type === 'remove');
  const placedInUserTable = removals.filter((change: any) => placedLine(change.identity, parsed.entries.get(change.identity), parsed.lines));
  for (const change of removals) nextLines[change.line] = placedInUserTable.includes(change) ? null : '';
  dropEmptiedTables(nextLines, changes.filter((change: any) => !placedInUserTable.includes(change)), parsed.headers);
  // A new key must land INSIDE its own table. Appending at end-of-file only happens to be
  // correct when that table is the file's last one — otherwise the key silently joins whichever
  // table trails the file, so `features.hooks` written after an `[mcp_servers.x]` block becomes
  // `mcp_servers.x.hooks`. placeEntry chooses the spot; genuinely new tables are appended once
  // each, with all of their keys grouped under a single header.
  const insertions: { at: number, line: string }[] = [];
  const newTables = new Map<string, string[]>();
  for (const change of changes.filter((change: any) => change.type === 'create')) {
    const placement = placements.get(change.identity);
    if (placement.at !== undefined) insertions.push({ at: placement.at, line: placement.line });
    else newTables.set(placement.table, [...(newTables.get(placement.table) || []), placement.line]);
  }
  // Descending, so an earlier insertion never shifts the index of one still pending.
  for (const insertion of insertions.sort((a, b) => b.at - a.at)) nextLines.splice(insertion.at, 0, insertion.line);
  // Dropped lines were kept as null placeholders so the insertion indices above stayed valid.
  for (let index = nextLines.length - 1; index >= 0; index--) if (nextLines[index] === null) nextLines.splice(index, 1);
  for (const [table, lines] of newTables) {
    // `''.split(/\r?\n/)` is [`''`]; drop that synthetic line so a brand-new file does
    // not start with an unintended blank line.
    if (nextLines.length === 1 && nextLines[0] === '') nextLines.pop();
    if (nextLines.length && nextLines.at(-1) !== '') nextLines.push('');
    nextLines.push(`[${table}]`, ...lines);
  }
  let content = nextLines.join('\n');
  if (content && !content.endsWith('\n')) content += '\n';
  const invalid = newViolation({ file, original, content, identities: changes.map((change: any) => change.identity) });
  if (invalid) return { ok: false, status: 'conflict', file, original, changes: [], conflicts: [invalid], managedResources };
  const nextManagedResources = managedResources.filter((resource: any) => !isOwnedRecord(resource, scope) || desired.has(resource.identity));
  for (const resource of desired.values()) {
    const index = nextManagedResources.findIndex((item: any) => isOwnedRecord(item, scope) && item.identity === resource.identity);
    const updated = { ...resource, target: 'codex', scope, kind: CONFIG_KIND, fingerprint: fingerprint(resource.value) };
    if (index >= 0) nextManagedResources[index] = updated;
    else nextManagedResources.push(updated);
  }
  return { ok: true, status: changes.length ? 'change' : 'unchanged', file, original, content, changes, conflicts: [], managedResources: nextManagedResources };
}

/** A table whose every key this plan removed, with nothing else under its header (no user key or
 * comment), is DoFlow's own leftover: its header and removed lines become null placeholders. When
 * it was the file's last table, the blank line the table append puts before a new header goes too.
 * A table that also receives a created key, or whose header line carries a comment, is kept.
 * Headers come from the parser's own records, never from re-reading lines. */
function dropEmptiedTables(lines: any[], changes: any[], headerRecords: any[]): void {
  const tableOf = (identity: string) => identity.split('.').slice(0, -1).join('.');
  const removedTables = new Map<number, string>(changes.filter((change) => change.type === 'remove').map((change): [number, string] => [change.line, tableOf(change.identity)]));
  const createdTables = new Set<string>(changes.filter((change) => change.type === 'create').map((change) => tableOf(change.identity)));
  const headers: number[] = headerRecords.map((header) => header.line);
  headers.forEach((start, position) => {
    const end = headers[position + 1] ?? lines.length;
    if (stripComment(lines[start]) !== lines[start]) return;
    const body = lines.slice(start + 1, end).map((_: any, offset: number) => start + 1 + offset);
    const removedHere = body.filter((index) => removedTables.has(index));
    if (!removedHere.length || removedHere.some((index) => createdTables.has(removedTables.get(index) as string))) return;
    if (body.some((index) => !removedTables.has(index) && lines[index] !== null && lines[index].trim() !== '')) return;
    lines[start] = null;
    for (const index of removedHere) lines[index] = null;
    if (end === lines.length && start > 0 && lines[start - 1] === '') lines[start - 1] = null;
  });
}

/** Replace a file through a sibling temporary file, keeping the existing file's permission bits so
 * a config kept private stays so. A file this creates gets the process's default mode. */
function atomicWrite(file: string, content: string, fsImpl: any = fs): void {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const mode = fsImpl.existsSync(file) ? fsImpl.statSync(file).mode & 0o7777 : null;
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fsImpl.writeFileSync(temporary, content, { flag: 'wx', ...(mode === null ? {} : { mode }) });
    if (mode !== null) fsImpl.chmodSync(temporary, mode);
    fsImpl.renameSync(temporary, file);
  } finally {
    if (fsImpl.existsSync(temporary)) fsImpl.unlinkSync(temporary);
  }
}

function applyCodexConfig(plan: any, { dryRun = false, fsImpl = fs }: { dryRun?: boolean, fsImpl?: any } = {}): any {
  if (!plan.ok) return { ...plan, applied: false };
  if (dryRun || plan.status === 'unchanged') return { ...plan, applied: false };
  // A removal that leaves nothing behind deletes the file rather than leaving it empty.
  if (plan.content === '') { if (fsImpl.existsSync(plan.file)) fsImpl.unlinkSync(plan.file); }
  else atomicWrite(plan.file, plan.content, fsImpl);
  return { ...plan, applied: true };
}

function reconcileCodexConfig(options: any): any {
  const file = options.file ?? configPath(options);
  const plan = planCodexConfig({ ...options, file });
  return applyCodexConfig(plan, options);
}

module.exports = { CONFIG_NAME, CONFIG_KIND, configPath, fingerprint, parseToml, newViolation, planCodexConfig, applyCodexConfig, reconcileCodexConfig, atomicWrite };
