'use strict';

/**
 * The worker parser table (IC-016, DEC-027). A descriptor's `structuredOutput.parser` names an entry
 * of `PARSERS`; the supervisor feeds it stdout one line at a time and reads one `Report` at the end.
 *
 *   - `doflow-jsonl-v1`: a line that parses as a JSON object with a string `type` is an event;
 *     every other line, and every event whose type or fields this format does not accept, is counted
 *     in `ignoredLines`.
 *   - Any `permission-denied` event makes the report `denied`, whatever the `result` line says and
 *     whatever the exit status.
 *   - A line over the supervisor's 4 MiB line buffer arrives as one `oversize(looksJson)` event; a
 *     JSON-looking one makes the report `unparsed`, reason `oversize-line`, unless a denial was seen
 *     (DEC-057).
 *   - `unparsed` is the fallback for a null or unknown id, and always reports `status: 'unparsed'`.
 *   - `codex-exec-json-v1` is data: the codex field map in `core/registry/harnesses.json`, compiled when this
 *     module loads (171 FR-008), like every harness whose `worker.structuredOutput` carries a `fieldMap`.
 *
 * Every free-text field is masked before it is kept: `summary` with the body profile, `action` and
 * `detail` with the line profile. Reading harnesses.json at load is the only I/O; an instance does none and
 * keeps no state outside itself.
 */

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { maskLine, maskBody } = require('../mask.ts');
const { validateFieldMap } = require('../../registry/field-map.ts');
const { MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES, cutBytes, cutChars, eventOf, lineText } = require('./parsers/common.ts');

const claude = require('./parsers/claude.ts');
const opencode = require('./parsers/opencode.ts');
const copilot = require('./parsers/copilot.ts');
const kiro = require('./parsers/kiro.ts');
const pi = require('./parsers/pi.ts');
const antigravity = require('./parsers/antigravity.ts');
const { compileFieldMap } = require('./parsers/field-map.ts');
const { canonicalJson } = require('../canonical-json.ts');

import type { Denial, Report } from './parsers/common.ts';

const JSONL_V1 = 'doflow-jsonl-v1';
const UNPARSED = 'unparsed';
const RESULT_STATUSES = new Set(['success', 'failure']);

function createJsonlV1() {
  let result: { status: 'success' | 'failure'; summary: string } | null = null;
  const denials: Denial[] = [];
  let deniedCount = 0;
  let usage: { tokens: number } | null = null;
  let ignoredLines = 0;
  let oversizeJson = false;

  return {
    /** IC-016 (DEC-057): a stdout line over `OUTPUT_MAX_BYTES`, never a line with no denial. */
    oversize(looksJson: boolean): void {
      ignoredLines++;
      if (looksJson) oversizeJson = true;
    },
    line(text: string): void {
      const event = eventOf(lineText(text));
      if (event && event.type === 'result' && RESULT_STATUSES.has(event.status) && typeof event.summary === 'string') {
        result = { status: event.status, summary: event.summary };
      } else if (event && event.type === 'permission-denied' && typeof event.action === 'string' && typeof event.detail === 'string') {
        deniedCount++;
        if (denials.length < MAX_DENIALS) {
          denials.push({ action: maskLine(event.action).text, detail: cutChars(maskLine(event.detail).text, DETAIL_CHARS) });
        }
      } else if (event && event.type === 'usage' && Number.isInteger(event.tokens) && event.tokens >= 0) {
        usage = { tokens: event.tokens };
      } else {
        ignoredLines++;
      }
    },
    end(): Report {
      // Masked first and cut second, so a cut never leaves an unmasked prefix of a secret behind.
      const summary = result ? cutBytes(maskBody(result.summary).text, SUMMARY_BYTES) : null;
      let status: Report['status'];
      let reason: string | null = null;
      if (deniedCount > 0) status = 'denied';
      else if (oversizeJson) { status = 'unparsed'; reason = 'oversize-line'; }
      else if (result) status = result.status;
      else { status = 'unparsed'; reason = 'no-result-line'; }
      return { parser: JSONL_V1, status, reason, summary, denials: denials.slice(), deniedCount, usage, ignoredLines };
    },
  };
}

/** The fallback: reads nothing and reports `unparsed` with the reason it was chosen. */
function unparsedParser(reason: 'no-structured-output-declared' | 'parser-unknown') {
  return {
    id: UNPARSED,
    create() {
      let ignoredLines = 0;
      return {
        line(): void { ignoredLines++; },
        oversize(): void { ignoredLines++; },
        end(): Report {
          return { parser: UNPARSED, status: 'unparsed', reason, summary: null, denials: [], deniedCount: 0, usage: null, ignoredLines };
        },
      };
    },
  };
}

type ParserInstance = { line(text: string): void; oversize(looksJson: boolean): void; lastMessage?: (text: string) => void; end(): Report };
type ParserFactory = { id: string; create(): ParserInstance };

/** 171 FR-008: every active harness's `worker.structuredOutput.fieldMap` in harnesses.json, compiled once here. */
function registryMaps(): ParserFactory[] {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'harnesses.json'), 'utf8'));
  return (registry.harnesses ?? []).map((harness: any) => harness?.worker?.structuredOutput?.fieldMap).filter(Boolean).map(compileFieldMap);
}

/** `doflow-jsonl-v1`, then the registry maps in registry order, then the code parsers; an id is never shadowed. */
function parserTable(): Readonly<Record<string, ParserFactory>> {
  const table: Record<string, ParserFactory> = {};
  const add = (factory: ParserFactory) => {
    if (Object.hasOwn(table, factory.id)) throw new Error(`parser id '${factory.id}' is declared twice`);
    table[factory.id] = factory;
  };
  add(Object.freeze({ id: JSONL_V1, create: createJsonlV1 }));
  for (const factory of registryMaps()) add(factory);
  for (const code of [claude, opencode, copilot, kiro, pi, antigravity]) add(Object.freeze({ id: code.ID, create: code.create }));
  return Object.freeze(table);
}

const PARSERS = parserTable();

/** The parser for `id`; the `unparsed` fallback for a null or unknown one. */
function parserFor(id: string | null | undefined) {
  if (id === null || id === undefined) return unparsedParser('no-structured-output-declared');
  return Object.prototype.hasOwnProperty.call(PARSERS, id) ? PARSERS[id] : unparsedParser('parser-unknown');
}

/** 171 IC-003: the parser id a capability entry names; an inline field map's id wins over `parser`. */
function parserIdOf(entry: any): string | null {
  return entry?.fieldMap?.id ?? entry?.parser ?? null;
}

/** 171 IC-003: compiled field maps keyed by canonical JSON, at most `MAP_CACHE_MAX`, the oldest evicted first. */
const MAP_CACHE_MAX = 64;
const mapCache = new Map<string, ParserFactory>();

function compiledMap(map: any): ParserFactory | null {
  // Validated before the lookup: the key collapses a non-finite number to null, so a hit proves nothing about this map.
  const errors: string[] = [];
  try { validateFieldMap(map, 'fieldMap', errors); } catch { return null; }
  if (errors.length > 0) return null;
  let key: string;
  try { key = canonicalJson(map); } catch { return null; }
  const cached = mapCache.get(key);
  if (cached) return cached;
  let factory: ParserFactory;
  // A stored descriptor whose map no longer validates reads as no map (unparsed), never a throw in a reader.
  try { factory = compileFieldMap(map); } catch { return null; }
  if (mapCache.size >= MAP_CACHE_MAX) mapCache.delete(mapCache.keys().next().value as string);
  mapCache.set(key, factory);
  return factory;
}

/**
 * 171 IC-003: the parser factory for a descriptor's `structuredOutput` (`structured`) or `mainSession` (`main`).
 * `PARSERS` is checked first, so a package map never shadows a core parser (S5); then this descriptor's own
 * `structuredOutput.fieldMap` when its id is the one named; otherwise `parserFor`, the `unparsed` fallback.
 */
function parserOf(descriptor: any, which: 'structured' | 'main'): ParserFactory {
  const id = parserIdOf(which === 'main' ? descriptor?.mainSession : descriptor?.structuredOutput);
  if (typeof id === 'string' && Object.hasOwn(PARSERS, id)) return PARSERS[id];
  const map = descriptor?.structuredOutput?.fieldMap;
  if (id !== null && map?.id === id) {
    const compiled = compiledMap(map);
    if (compiled) return compiled;
  }
  return parserFor(id);
}

module.exports = { PARSERS, parserFor, parserOf, parserIdOf, JSONL_V1, UNPARSED, MAX_DENIALS, DETAIL_CHARS, SUMMARY_BYTES };
