'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

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

/** Resolves span attributes per IC-008 rules 1-5 and 7. */
function resolveAttributes(span: any, spanSpec: any, registry: any, lists: Record<string, string[]>): any[] {
  const attrs: any[] = [];
  const exportAttrs = registry?.export?.attributes || {};
  const spanAttrs = span.attrs || {};

  for (const [key, rawValue] of Object.entries(spanAttrs)) {
    if (rawValue === null || rawValue === undefined) continue;
    if (!Object.hasOwn(exportAttrs, key)) continue;

    const attrSpec = exportAttrs[key];
    const exportKey =
      attrSpec.export ||
      registry?.kinds?.[span.kind]?.fields?.[key]?.name ||
      `doflow.${span.kind}.${key}`;

    let valueObj: any = null;

    if (attrSpec.id) {
      // rule 2: id: true exports the value unchanged only when it passes SAFE_TOKEN
      if (typeof rawValue === 'string' && SAFE_TOKEN.test(rawValue)) {
        valueObj = { stringValue: rawValue };
      }
    } else if (attrSpec.vocabulary) {
      // rule 3: vocabulary exports the value when it is a member of the named list, else "other"
      const listName = attrSpec.vocabulary;
      const list = lists[listName] || registry?.vocabularies?.[listName] || [];
      if (typeof rawValue === 'string' && list.includes(rawValue)) {
        valueObj = { stringValue: rawValue };
      } else {
        valueObj = { stringValue: 'other' };
      }
    } else if (attrSpec.measure) {
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

  // Index root spans per trace for link resolution
  const traceRoots = new Map<string, string>();
  for (const trace of traces) {
    const tId = String(trace.traceId || '').toLowerCase();
    for (const span of trace.spans || []) {
      if (span.start != null && (span.parentSpanId == null || span.parentSpanId === '')) {
        traceRoots.set(tId, String(span.spanId || '').toLowerCase());
        break;
      }
    }
  }

  const mappedSpans: any[] = [];

  for (const trace of traces) {
    const traceId = String(trace.traceId || '').toLowerCase();
    const traceLink = trace.traceLink ? String(trace.traceLink).toLowerCase() : null;

    for (const span of trace.spans || []) {
      if (span.start == null) {
        skippedNoStart++;
        continue;
      }

      const spanId = String(span.spanId || '').toLowerCase();
      const parentSpanId =
        span.parentSpanId != null && span.parentSpanId !== ''
          ? String(span.parentSpanId).toLowerCase()
          : undefined;

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

      let links: any = undefined;
      if (!parentSpanId && traceLink && traceRoots.has(traceLink)) {
        links = [{ traceId: traceLink, spanId: traceRoots.get(traceLink) }];
      }

      const otlpSpan: any = {
        traceId,
        spanId,
        ...(parentSpanId !== undefined ? { parentSpanId } : {}),
        name,
        kind,
        startTimeUnixNano,
        endTimeUnixNano,
        attributes: attributes.sort((a: any, b: any) => cmp(a.key, b.key)),
        ...(status !== undefined ? { status } : {}),
        ...(links !== undefined ? { links } : {}),
      };

      mappedSpans.push(otlpSpan);
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
  buildOtlpRequests,
  ownedLists,
};
