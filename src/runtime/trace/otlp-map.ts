'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');
const { SAFE_TOKEN } = require('./telemetry.ts');
const { REPO_ROOT } = require('../../helper/repo-root.ts');

const cmp = (a: any, b: any): number => (a < b ? -1 : a > b ? 1 : 0);

/** Object keys sorted at every level, so the JSON form is byte-identical for the same inputs. */
function sorted(value: any): any {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort(cmp)
        .map((k) => [k, sorted(value[k])])
    );
  }
  return value;
}

let cachedPkgVersion: string = '';
function packageVersion(): string {
  if (cachedPkgVersion) return cachedPkgVersion;
  try {
    const pkg = JSON.parse(nodeFs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    cachedPkgVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cachedPkgVersion = '0.0.0';
  }
  return cachedPkgVersion;
}

/**
 * Returns the three lists owned outside telemetry.json:
 * - cli-commands: Object.keys(COMMANDS) loaded lazily inside to avoid load cycles.
 * - workflow-stages: stage ids in core/registry/workflows.json.
 * - workflow-classes: class ids in core/registry/workflows.json.
 */
function ownedLists(repoRoot?: string): {
  'cli-commands': string[];
  'workflow-stages': string[];
  'workflow-classes': string[];
} {
  const root = repoRoot || REPO_ROOT;
  const { COMMANDS } = require('../../cli/index.ts');
  const cliCommands = Object.keys(COMMANDS || {});

  let workflowStages: string[] = [];
  let workflowClasses: string[] = [];

  try {
    const workflowsFile = path.join(root, 'core', 'registry', 'workflows.json');
    const workflows = JSON.parse(nodeFs.readFileSync(workflowsFile, 'utf8'));
    workflowClasses = Object.keys(workflows.classes || {});
    const stageSet = new Set<string>();
    for (const cls of Object.values(workflows.classes || {}) as any[]) {
      for (const st of cls.stages || []) {
        if (st && typeof st.id === 'string' && st.id && !stageSet.has(st.id)) {
          stageSet.add(st.id);
          workflowStages.push(st.id);
        }
      }
    }
  } catch {
    // best-effort fallback
  }

  return {
    'cli-commands': cliCommands,
    'workflow-stages': workflowStages,
    'workflow-classes': workflowClasses,
  };
}

/** Resolves the mapped span name per IC-008 rule 6. */
function resolveSpanName(span: any, spanSpec: any, registry: any, lists: Record<string, string[]>): string {
  if (!spanSpec || typeof spanSpec.name !== 'string') {
    return `doflow.${span.kind}`;
  }
  let pattern: string = spanSpec.name;

  if (pattern.includes('{tool}')) {
    const toolList = lists.tool || registry?.vocabularies?.tool || [];
    const raw = span.attrs?.tool;
    if (typeof raw === 'string' && toolList.includes(raw)) {
      pattern = pattern.replace('{tool}', raw);
    } else {
      pattern = pattern.replace(/\s*\{tool\}/, '');
    }
  }

  if (pattern.includes('{harness}')) {
    const harnessList = lists.harness || registry?.vocabularies?.harness || [];
    const raw = span.attrs?.harness;
    if (typeof raw === 'string' && harnessList.includes(raw)) {
      pattern = pattern.replace('{harness}', raw);
    } else {
      pattern = pattern.replace(/\s*\{harness\}/, '');
    }
  }

  if (pattern.includes('{kind}')) {
    pattern = pattern.replace('{kind}', span.kind);
  }

  if (pattern.includes('{name}')) {
    const names = registry?.export?.names || {};
    let nameKey: string | null = null;
    if (span.kind === 'ledger') {
      nameKey = 'verb';
    } else if (Object.hasOwn(names, span.kind)) {
      nameKey = span.kind;
    } else if (span.attrs && typeof span.attrs === 'object') {
      for (const k of Object.keys(names)) {
        if (Object.hasOwn(span.attrs, k) && span.attrs[k] === span.name) {
          nameKey = k;
          break;
        }
      }
    }

    if (!nameKey || !names[nameKey]) {
      pattern = pattern.replace(/\s*\{name\}/, '');
    } else {
      const listName = names[nameKey];
      const list = lists[listName] || registry?.vocabularies?.[listName] || [];
      const raw = span.name;
      if (typeof raw === 'string' && list.includes(raw)) {
        pattern = pattern.replace('{name}', raw);
      } else {
        pattern = pattern.replace(/\s*\{name\}/, '');
      }
    }
  }

  return pattern.trim();
}

const RULE_KEYS = ['id', 'vocabulary', 'measure'];
const SPEC_KEYS = new Set([...RULE_KEYS, 'export']);

/**
 * The one typed check of an `export.attributes` entry (091 C-1), shared by the mapper and G45.7.
 * An entry holds exactly one rule key: `id: true` (boolean, only on `tool_call_id`), `vocabulary:
 * <non-empty list name>` or `measure: true`, plus an optional `export: <non-empty key>`. Anything
 * else is an error, and the mapper drops the attribute (fail closed).
 */
function attributeRule(key: string, attrSpec: any): { rule: 'id' | 'vocabulary' | 'measure'; exportKey: string | null } | { error: string } {
  if (!attrSpec || typeof attrSpec !== 'object' || Array.isArray(attrSpec)) return { error: `'${key}' rule must be an object` };
  const unknown = Object.keys(attrSpec).filter((k) => !SPEC_KEYS.has(k));
  if (unknown.length) return { error: `'${key}' has unknown rule key(s) ${unknown.join(',')}` };
  const rules = RULE_KEYS.filter((k) => Object.hasOwn(attrSpec, k));
  if (rules.length !== 1) return { error: `'${key}' must hold exactly one of id, vocabulary, measure (has ${rules.length})` };
  if (Object.hasOwn(attrSpec, 'export') && (typeof attrSpec.export !== 'string' || attrSpec.export === '')) {
    return { error: `'${key}' export must be a non-empty string` };
  }
  const exportKey = Object.hasOwn(attrSpec, 'export') ? attrSpec.export : null;
  const rule = rules[0] as 'id' | 'vocabulary' | 'measure';
  if (rule === 'id') {
    if (attrSpec.id !== true) return { error: `'${key}' id must be the boolean true` };
    if (key !== 'tool_call_id') return { error: `'${key}' declared id: true but only tool_call_id may declare id: true` };
  } else if (rule === 'vocabulary') {
    if (typeof attrSpec.vocabulary !== 'string' || attrSpec.vocabulary === '') return { error: `'${key}' vocabulary must name a list` };
  } else if (attrSpec.measure !== true) {
    return { error: `'${key}' measure must be the boolean true` };
  }
  return { rule, exportKey };
}

/** Resolves span attributes per IC-008 rules 1-5 and 7. */
function resolveAttributes(span: any, spanSpec: any, registry: any, lists: Record<string, string[]>): any[] {
  const attrs: any[] = [];
  const exportAttrs = registry?.export?.attributes || {};
  const spanAttrs = span.attrs || {};

  for (const [key, rawValue] of Object.entries(spanAttrs)) {
    if (rawValue === null || rawValue === undefined) continue;
    if (!Object.hasOwn(exportAttrs, key)) continue;

    const attrSpec = exportAttrs[key];
    const checked = attributeRule(key, attrSpec);
    if ('error' in checked) continue; // fail closed: a malformed rule exports nothing
    const exportKey =
      checked.exportKey ||
      registry?.kinds?.[span.kind]?.fields?.[key]?.name ||
      `doflow.${span.kind}.${key}`;

    let valueObj: any = null;

    if (checked.rule === 'id') {
      // rule 2: id: true (tool_call_id only) exports the value unchanged only when it passes SAFE_TOKEN
      if (typeof rawValue === 'string' && SAFE_TOKEN.test(rawValue)) {
        valueObj = { stringValue: rawValue };
      }
    } else if (checked.rule === 'vocabulary') {
      // rule 3: vocabulary exports the value when it is a member of the named list, else "other"
      const listName = attrSpec.vocabulary;
      const list = lists[listName] || registry?.vocabularies?.[listName] || [];
      if (typeof rawValue === 'string' && list.includes(rawValue)) {
        valueObj = { stringValue: rawValue };
      } else {
        valueObj = { stringValue: 'other' };
      }
    } else if (checked.rule === 'measure') {
      // rule 4: measure: true exports a number unchanged
      if (typeof rawValue === 'number' && Number.isFinite(rawValue)) {
        if (Math.trunc(rawValue) === rawValue) {
          valueObj = { intValue: String(rawValue) };
        } else {
          valueObj = { doubleValue: rawValue };
        }
      } else if (typeof rawValue === 'bigint') {
        valueObj = { intValue: rawValue.toString() };
      } else if (typeof rawValue === 'boolean') {
        valueObj = { boolValue: rawValue };
      }
    }

    if (valueObj !== null) {
      attrs.push({ key: exportKey, value: valueObj });
    }
  }

  // rule 7: gen_ai.operation.name is set from operation. No other gen_ai.* key is emitted.
  if (spanSpec && typeof spanSpec.operation === 'string' && spanSpec.operation) {
    attrs.push({ key: 'gen_ai.operation.name', value: { stringValue: spanSpec.operation } });
  }

  return attrs;
}

const sha16 = (text: string): string => crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
const byStartThenId = (x: any, y: any): number => {
  const a = BigInt(x.body.startTimeUnixNano);
  const b = BigInt(y.body.startTimeUnixNano);
  return a < b ? -1 : a > b ? 1 : cmp(x.id, y.id);
};

/**
 * Export-time span ids (091 C-4, D-ORCH option a). The local view's span ids are digests of record
 * locators (slug, task id, run key, path hash), so they are never exported. Each exported id is
 * `sha16` of values already in the payload only: the trace id, the remapped parent id, the span's
 * exported body (name, times, attributes, status), and an ordinal among spans whose inputs are equal,
 * ordered by the exported content of their subtrees. A parent that is not exported is dropped.
 * Sets `id` and `parent` (exported id or null) on each entry.
 */
function remapSpanIds(traceId: string, entries: any[]): void {
  const byLocal = new Map<string, any>();
  for (const e of entries) if (e.localId && !byLocal.has(e.localId)) byLocal.set(e.localId, e);
  const parentOf = (e: any): any => {
    const p = e.localParent ? byLocal.get(e.localParent) : undefined;
    return p && p !== e ? p : null;
  };
  const children = new Map<any, any[]>();
  for (const e of entries) {
    const p = parentOf(e);
    if (p) {
      if (!children.has(p)) children.set(p, []);
      children.get(p)!.push(e);
    }
  }
  // Content signature of a subtree, from exported values only (cycle-safe).
  const sig = new Map<any, string>();
  const subtree = (e: any, seen: Set<any>): string => {
    if (sig.has(e)) return sig.get(e)!;
    if (seen.has(e)) return '';
    seen.add(e);
    const kids = (children.get(e) || []).map((c) => subtree(c, seen)).sort(cmp);
    const value = sha16(`${e.content}\n${kids.join(',')}`);
    seen.delete(e);
    sig.set(e, value);
    return value;
  };
  for (const e of entries) subtree(e, new Set());

  const done = new Map<any, string>();
  const assign = (group: any[], parentId: string, pass = ''): void => {
    const bases = new Map<string, any[]>();
    for (const e of group) {
      const base = `${traceId}\n${parentId}\n${e.content}${pass}`;
      if (!bases.has(base)) bases.set(base, []);
      bases.get(base)!.push(e);
    }
    for (const [base, same] of bases) {
      same.sort((x, y) => cmp(sig.get(x), sig.get(y)));
      same.forEach((e, ordinal) => {
        if (done.has(e)) return;
        const id = sha16(`doflow-otlp-span-v1\n${base}\n${ordinal}`);
        done.set(e, id);
        e.id = id;
        e.parent = parentId === '' ? null : parentId;
      });
    }
    for (const e of group) {
      const kids = (children.get(e) || []).filter((c) => !done.has(c));
      if (kids.length) assign(kids, e.id);
    }
  };
  // Roots: no exported parent. Spans caught in a parent cycle are treated as roots.
  assign(entries.filter((e) => parentOf(e) === null), '');
  const rest = entries.filter((e) => !done.has(e));
  // The pass is part of the id input: without it a cycle member equal in content to a root would
  // restart the ordinal at 0 and take the root's id.
  if (rest.length) assign(rest, '', '\ncycle');
}

/**
 * Builds OTLP/HTTP JSON request bodies from a spans view per IC-007 and IC-008.
 *
 * @param {Object} view spans view { v, traces, ungrouped, gaps }
 * @param {Object} registry loaded telemetry.json
 * @param {Object} [meta] { version, lists }
 * @returns {{ requests: any[], skipped: { ungrouped: number, noStart: number } }}
 */
function buildOtlpRequests(
  view: any,
  registry: any,
  meta?: {
    version?: string;
    lists?: {
      'cli-commands'?: string[];
      'workflow-stages'?: string[];
      'workflow-classes'?: string[];
      [key: string]: string[] | undefined;
    };
  }
): { requests: any[]; skipped: { ungrouped: number, noStart: number } } {
  const lists: Record<string, string[]> = {
    ...ownedLists(),
    ...(meta?.lists || {}),
  } as Record<string, string[]>;

  const version = meta?.version || packageVersion();
  const serviceName = registry?.export?.resource?.['service.name'] || 'doflow';
  const schemaUrl = registry?.export?.semconv?.schemaUrl || '';

  let skippedUngrouped = 0;
  for (const group of view?.ungrouped || []) {
    skippedUngrouped += (group?.spans || []).length;
  }

  let skippedNoStart = 0;
  const traces = view?.traces || [];

  // Map every exportable span first (no ids yet), then remap ids from payload values only (C-4).
  const mappedTraces: { traceId: string; traceLink: string | null; spans: any[] }[] = [];
  for (const trace of traces) {
    const traceId = String(trace.traceId || '').toLowerCase();
    const traceLink = trace.traceLink ? String(trace.traceLink).toLowerCase() : null;
    const entries: any[] = [];

    for (const span of trace.spans || []) {
      if (span.start == null) {
        skippedNoStart++;
        continue;
      }

      const kind = 1;
      const startMs = Date.parse(span.start);
      const startTimeUnixNano = (BigInt(startMs) * 1000000n).toString();
      const endMs = span.end != null ? Date.parse(span.end) : startMs;
      const endTimeUnixNano = (BigInt(endMs) * 1000000n).toString();

      const spanSpec = registry?.export?.spans?.[span.kind] || registry?.export?.spans?.['*'];
      const name = resolveSpanName(span, spanSpec, registry, lists);
      const attributes = resolveAttributes(span, spanSpec, registry, lists);

      const statusVal = span.attrs?.status;
      const exitCode = span.attrs?.exit_code;
      const isError =
        statusVal === 'FAIL' ||
        statusVal === 'fail' ||
        statusVal === 'error' ||
        (typeof exitCode === 'number' && exitCode !== 0);

      let status: any = undefined;
      if (isError) {
        status = { code: 2 };
        const errorType =
          statusVal === 'FAIL' || statusVal === 'fail' || statusVal === 'error'
            ? statusVal
            : `exit:${exitCode}`;
        attributes.push({ key: 'error.type', value: { stringValue: errorType } });
      }

      const body: any = {
        name,
        kind,
        startTimeUnixNano,
        endTimeUnixNano,
        attributes: attributes.sort((x: any, y: any) => cmp(x.key, y.key)),
        ...(status !== undefined ? { status } : {}),
      };
      entries.push({
        localId: String(span.spanId || '').toLowerCase(),
        localParent: span.parentSpanId != null && span.parentSpanId !== '' ? String(span.parentSpanId).toLowerCase() : null,
        body,
        content: JSON.stringify(sorted(body)),
      });
    }
    mappedTraces.push({ traceId, traceLink, spans: entries });
  }
  // Remap once per trace id, so spans of two segments that share a trace id never share an id.
  const byTrace = new Map<string, any[]>();
  for (const t of mappedTraces) byTrace.set(t.traceId, [...(byTrace.get(t.traceId) || []), ...t.spans]);
  for (const [traceId, entries] of byTrace) remapSpanIds(traceId, entries);

  // A trace's root for links: the earliest exported span without an exported parent.
  const traceRoots = new Map<string, string>();
  for (const t of mappedTraces) {
    const root = t.spans.filter((e) => e.parent === null).sort(byStartThenId)[0];
    if (root && !traceRoots.has(t.traceId)) traceRoots.set(t.traceId, root.id);
  }

  const mappedSpans: any[] = [];
  for (const t of mappedTraces) {
    for (const e of [...t.spans].sort(byStartThenId)) {
      let links: any = undefined;
      if (e.parent === null && t.traceLink && traceRoots.has(t.traceLink)) {
        links = [{ traceId: t.traceLink, spanId: traceRoots.get(t.traceLink) }];
      }
      mappedSpans.push({
        traceId: t.traceId,
        spanId: e.id,
        ...(e.parent !== null ? { parentSpanId: e.parent } : {}),
        ...e.body,
        ...(links !== undefined ? { links } : {}),
      });
    }
  }

  const requests: any[] = [];
  const CHUNK_SIZE = 512;

  for (let i = 0; i < mappedSpans.length; i += CHUNK_SIZE) {
    const chunk = mappedSpans.slice(i, i + CHUNK_SIZE);
    const req = {
      resourceSpans: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: serviceName } },
              { key: 'service.version', value: { stringValue: version } },
            ],
          },
          schemaUrl,
          scopeSpans: [
            {
              scope: {
                name: 'doflow',
                version,
              },
              schemaUrl,
              spans: chunk,
            },
          ],
        },
      ],
    };
    requests.push(sorted(req));
  }

  return {
    requests,
    skipped: {
      ungrouped: skippedUngrouped,
      noStart: skippedNoStart,
    },
  };
}

module.exports = {
  attributeRule,
  buildOtlpRequests,
  ownedLists,
};
