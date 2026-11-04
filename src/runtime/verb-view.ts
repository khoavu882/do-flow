'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

/**
 * The shared view helper for verbs that answer in a brief or a full view (feature 137, IC-002, IC-003, IC-007,
 * IC-008). A verb declares its own brief spec beside its handler; this module resolves the view a call asked for,
 * projects a full answer onto a keep-path list, pages an ordered item list by cursor, builds next lines from
 * validated parsed options, and serializes JSON compact off a terminal and indented on one.
 *
 * Like `cli-result.ts`, this module requires nothing from src/runtime/ at load time, so any handler can require
 * it without a cycle. It requires nothing at all.
 */

type View = 'brief' | 'full';

/** One verb's brief view, declared beside its handler. */
interface BriefSpec {
  readonly verb: string;
  readonly action?: string;
  readonly keep: readonly string[];
  readonly carry: readonly string[];
}

/** The ordering key of a pageable item: the creating event's time in milliseconds, then its event id. */
interface CursorKey {
  readonly atMs: number;
  readonly event: string;
}

/** A caller mistake in a view option: the handler reports it as a usage error (exit 2). */
class ViewUsageError extends Error {}

const VIEWS: readonly string[] = ['brief', 'full'];

function resolveView(raw: unknown, defaultView: View): View {
  if (raw === undefined || raw === null) return defaultView;
  if (typeof raw === 'string' && VIEWS.includes(raw)) return raw as View;
  throw new ViewUsageError(`--view must be brief or full (got '${String(raw)}')`);
}

// ---------------------------------------------------------------------------------------------- keep paths

interface KeepNode {
  all: boolean;
  children: Map<string, { array: boolean; node: KeepNode }>;
}

const KEEP_PATH = /^\$(?:\.[A-Za-z_][A-Za-z0-9_]*(?:\[\])?)+$/;
const KEEP_SEGMENT = /\.([A-Za-z_][A-Za-z0-9_]*)(\[\])?/g;
const keepTrees = new Map<string, KeepNode>();

/** Builds the tree of a keep list; a malformed path, or one name used both as an array and not, throws. */
function keepTree(keep: readonly string[]): KeepNode {
  const cacheKey = keep.join('\n');
  const cached = keepTrees.get(cacheKey);
  if (cached) return cached;
  const root: KeepNode = { all: false, children: new Map() };
  for (const path of keep) {
    if (!KEEP_PATH.test(path)) throw new Error(`malformed keep path '${path}'`);
    let node = root;
    for (const match of path.matchAll(KEEP_SEGMENT)) {
      const [, name, brackets] = match;
      const array = brackets !== undefined;
      let child = node.children.get(name);
      if (!child) {
        child = { array, node: { all: false, children: new Map() } };
        node.children.set(name, child);
      } else if (child.array !== array) {
        throw new Error(`keep path '${path}' uses '${name}' both as an array and as a single value`);
      }
      node = child.node;
    }
    node.all = true;
  }
  keepTrees.set(cacheKey, root);
  return root;
}

function projectValue(value: any, node: KeepNode): any {
  if (node.all) return value;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    const child = node.children.get(key);
    if (!child || value[key] === undefined) continue;
    let part;
    if (child.array) {
      part = Array.isArray(value[key])
        ? value[key].map((element: any) => (child.node.all || element === null || typeof element !== 'object' || Array.isArray(element)
          ? element : (projectValue(element, child.node) ?? {})))
        : undefined;
    } else {
      part = projectValue(value[key], child.node);
      // An object none of whose kept paths exist is absent, not an empty shell.
      if (part !== undefined && !child.node.all && Object.keys(part).length === 0) part = undefined;
    }
    if (part !== undefined) out[key] = part;
  }
  return out;
}

/**
 * Projects a full answer onto keep paths: `$` then segments `.name` or `.name[]`; a path keeps the whole value at
 * its last segment, `[]` maps over an array (order and length kept), an absent path is skipped, and output keys
 * follow the full answer's key order.
 */
function projectBrief(full: Record<string, unknown>, keep: readonly string[]): Record<string, unknown> {
  return projectValue(full, keepTree(keep)) ?? {};
}

// -------------------------------------------------------------------------------------------------- cursor

const CURSOR = /^([0-9]{1,15}):([0-9]{8}T[0-9]{9}Z-[0-9a-hjkmnp-tv-z]{6})$/;
const DIGITS = /^[0-9]+$/;

function encodeCursor(key: CursorKey): string {
  if (!Number.isSafeInteger(key.atMs) || key.atMs < 0 || String(key.atMs).length > 15) {
    throw new ViewUsageError(`cursor time must be 0 to 15 digits of milliseconds (got ${key.atMs})`);
  }
  return `${key.atMs}:${key.event}`;
}

/** The key a cursor names, or null when the text is not a cursor of this format. */
function decodeCursor(text: unknown): CursorKey | null {
  const match = typeof text === 'string' ? CURSOR.exec(text) : null;
  return match ? { atMs: Number(match[1]), event: match[2] } : null;
}

/** True when key `a` orders after key `b`: later time, or the same time and a greater event id. */
function keyAfter(a: CursorKey, b: CursorKey): boolean {
  return a.atMs > b.atMs || (a.atMs === b.atMs && a.event > b.event);
}

/**
 * Pages an item list already in ascending key order. Items at or before the cursor are dropped, then the first
 * `limit` are kept. `nextCursor` is the last shown item's key when items remain after it, else null.
 */
function pageItems<T>(items: readonly T[], opts: {
  cursor?: string; limit?: string | number; defaultLimit: number | null; maxLimit: number;
  key(item: T): CursorKey;
}): { items: T[]; shown: number; nextCursor: string | null } {
  let limit = opts.defaultLimit;
  if (opts.limit !== undefined) {
    const text = String(opts.limit);
    if (!DIGITS.test(text) || Number(text) < 1) {
      throw new ViewUsageError(`--limit must be a whole number of 1 or more (at most ${opts.maxLimit} are returned)`);
    }
    limit = Math.min(opts.maxLimit, Number(text));
  }
  let rest = items;
  if (opts.cursor !== undefined) {
    const after = decodeCursor(opts.cursor);
    if (after === null) throw new ViewUsageError('--cursor must be the nextCursor of an earlier list');
    rest = items.filter((item) => keyAfter(opts.key(item), after));
  }
  const page = limit === null ? rest.slice() : rest.slice(0, limit);
  const more = page.length < rest.length;
  return {
    items: page,
    shown: page.length,
    nextCursor: more && page.length > 0 ? encodeCursor(opts.key(page[page.length - 1])) : null,
  };
}

// ----------------------------------------------------------------------------------------------- next lines

const SAFE_VALUE = /^[A-Za-z0-9._:@,/-]{1,200}$/;
const LABELS = { page: 'Next page', 'page-full': 'Full view of this page', full: 'Full view' } as const;
const VIEW_FLAGS: readonly string[] = ['cursor', 'limit', 'view'];

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

/**
 * `doflow-run <verb>[ --action <action>]( --<flag>[ <value>])*`, flags in the order of `carried`. A value renders
 * only when it is `true` (bare flag) or a short safe token (or finite number); any other value renders as the
 * placeholder `<flag>`, so free text is never carried. `false`, null and undefined are omitted.
 */
function commandLine(verb: string, action: string | undefined, carried: Record<string, unknown>): string {
  const parts = ['doflow-run', verb];
  if (action !== undefined) parts.push('--action', action);
  for (const [name, value] of Object.entries(carried)) {
    if (value === undefined || value === null || value === false) continue;
    const flag = kebab(name);
    parts.push(`--${flag}`);
    if (value === true) continue;
    const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
    parts.push(typeof text === 'string' && SAFE_VALUE.test(text) ? text : `<${flag}>`);
  }
  return parts.join(' ');
}

/**
 * The next line of one kind: `page` (the page after this one), `page-full` (this page in the full view, carrying
 * the input cursor and `--limit <shown>`) or `full` (the verb's whole, bounded, full answer). The options echoed
 * are those the spec's `carry` names, in that order, then `--cursor`, `--limit`, `--view` (a `page` line names
 * `--view full` only when the caller's `view` is `full`). Returns no line when
 * the kind has nothing to point at (`page` without a nextCursor, `page-full` with nothing shown). In a JSON answer
 * (`json: true`) every line ends with `--json`, so the command as written prints the same JSON shape; a text
 * answer's lines carry no `--json`.
 */
function viewLines(kind: 'page' | 'page-full' | 'full', ctx: {
  spec: BriefSpec; carried: Record<string, unknown>; cursor?: string | null;
  nextCursor?: string | null; shown?: number; view?: View; json?: boolean;
}): string[] {
  const args: Record<string, unknown> = {};
  for (const name of ctx.spec.carry) {
    if (!VIEW_FLAGS.includes(name)) args[name] = ctx.carried[name];
  }
  if (kind === 'page') {
    if (!ctx.nextCursor) return [];
    args.cursor = ctx.nextCursor;
    args.limit = ctx.spec.carry.includes('limit') ? ctx.carried.limit : undefined;
    // A walk stays in the view it started in: brief is the default, so only the full view is named.
    if (ctx.view === 'full') args.view = 'full';
  } else if (kind === 'page-full') {
    if (!ctx.shown || ctx.shown < 1) return [];
    args.cursor = ctx.cursor ?? undefined;
    args.limit = ctx.shown;
    args.view = 'full';
  } else {
    args.view = 'full';
  }
  const asJson = ctx.json === true ? ' --json' : '';
  return [`${LABELS[kind]}: ${commandLine(ctx.spec.verb, ctx.spec.action, args)}${asJson}`];
}

/**
 * Adds the envelope to an answer body: `view` first; `shown` and `nextCursor` directly after `count` when the body
 * has one, else after `view`; `next` last (replacing a `next` the body already carries).
 */
function withEnvelope(body: Record<string, unknown>, env: {
  view: View; shown?: number; nextCursor?: string | null; next?: readonly string[];
}): Record<string, unknown> {
  const paging: Record<string, unknown> = {};
  if (env.shown !== undefined) paging.shown = env.shown;
  if (env.nextCursor !== undefined) paging.nextCursor = env.nextCursor;
  const out: Record<string, unknown> = { view: env.view };
  const hasCount = 'count' in body;
  if (!hasCount) Object.assign(out, paging);
  for (const [key, value] of Object.entries(body)) {
    if (key === 'view' || key === 'shown' || key === 'nextCursor' || key === 'next') continue;
    out[key] = value;
    if (key === 'count') Object.assign(out, paging);
  }
  const next = env.next ?? (body.next as readonly string[] | undefined);
  if (next !== undefined) out.next = next;
  return out;
}

// --------------------------------------------------------------------------------------------- serialization

/** Compact JSON off a terminal, two-space indented on one; `isTTY` defaults to `process.stdout.isTTY === true`. */
function serializeJson(value: unknown, opts: { isTTY?: boolean } = {}): string {
  const isTTY = opts.isTTY ?? process.stdout.isTTY === true;
  return isTTY === true ? JSON.stringify(value, null, 2) : JSON.stringify(value);
}

function emitJson(value: unknown, opts: { isTTY?: boolean } = {}): void {
  console.log(serializeJson(value, opts));
}

module.exports = {
  ViewUsageError, resolveView, projectBrief, pageItems, encodeCursor, decodeCursor,
  commandLine, viewLines, withEnvelope, serializeJson, emitJson,
};
