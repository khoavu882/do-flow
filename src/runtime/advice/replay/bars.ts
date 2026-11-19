'use strict';

// The effective bars of a replay kind (175 IC-001, O-3). The package registry (`core/registry/advice.json`) holds the
// default bars; the person may replace them in one file they edit, `<config home>/advice-bars.json` (store
// `advice-bars-user`). DoFlow only reads that file: it never writes it, so an install or an update keeps it. No project
// file is ever read for a bar, so a repository cannot lower the bar it is judged by.
//
// Every block in the file has the registry's block shape and is checked by the registry's own validator. A file that is
// present but unreadable or invalid fails closed: the caller gets `bars-override-invalid` and the messages, never the
// package bars in its place.

const fs = require('node:fs');
const path = require('node:path');
const { validateBars } = require('../registry.ts');

const OVERRIDE_FILE = 'advice-bars.json';
const OVERRIDE_KEYS = ['schema', 'bars', 'kinds'];

type EffectiveBars =
  | { ok: true; bars: any; source: 'override-kind' | 'kind' | 'override' | 'package' }
  | { ok: false; reason: 'bars-override-invalid'; errors: string[] };

const isObject = (value: any): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The parsed override file, `null` when there is none, or the messages that make it invalid. */
function readOverride(registry: any, roots: any, fsImpl: any): { override: any } | { errors: string[] } {
  const home = roots?.['config-home'];
  if (!home) return { override: null };
  const file = path.join(home, OVERRIDE_FILE);
  let text: string;
  try { text = fsImpl.readFileSync(file, 'utf8'); }
  catch (error: any) {
    if (error?.code === 'ENOENT') return { override: null };
    return { errors: [`${OVERRIDE_FILE} could not be read: ${error?.message}`] };
  }
  let override: any;
  try { override = JSON.parse(text); }
  catch (error: any) { return { errors: [`${OVERRIDE_FILE} is not valid JSON: ${error.message}`] }; }
  if (!isObject(override)) return { errors: [`${OVERRIDE_FILE} must be a JSON object`] };

  const errors: string[] = [];
  if (override.schema !== 1) errors.push('schema must be 1');
  for (const key of Object.keys(override)) if (!OVERRIDE_KEYS.includes(key)) errors.push(`${key} is not a known key`);
  if (Object.hasOwn(override, 'bars')) validateBars(override.bars, 'bars', errors);
  if (Object.hasOwn(override, 'kinds')) {
    if (!isObject(override.kinds)) errors.push('kinds must be an object');
    else {
      const known = new Set((registry?.kinds || []).map((kind: any) => kind?.id));
      for (const [id, block] of Object.entries(override.kinds)) {
        if (!known.has(id)) errors.push(`kinds.${id} is not a kind the advice registry declares`);
        else validateBars(block, `kinds.${id}`, errors);
      }
    }
  }
  return errors.length ? { errors } : { override };
}

/**
 * The bars `kind` (an id) is judged by, most specific first, the user before the package at the same level:
 * `override.kinds[kind] ?? kind.bars ?? override.bars ?? registry.bars`. `source` names the level that won.
 */
function effectiveBars({ registry, kind, roots, fsImpl = fs }: { registry: any; kind: string; roots: any; fsImpl?: any }): EffectiveBars {
  const read = readOverride(registry, roots, fsImpl);
  if ('errors' in read) return { ok: false, reason: 'bars-override-invalid', errors: read.errors };
  const override = read.override;
  const kindBars = (registry?.kinds || []).find((entry: any) => entry?.id === kind)?.bars ?? null;
  const own = override?.kinds && Object.hasOwn(override.kinds, kind) ? override.kinds[kind] : null;
  if (own) return { ok: true, bars: own, source: 'override-kind' };
  if (kindBars) return { ok: true, bars: kindBars, source: 'kind' };
  if (override?.bars) return { ok: true, bars: override.bars, source: 'override' };
  return { ok: true, bars: registry.bars, source: 'package' };
}

module.exports = { effectiveBars, OVERRIDE_FILE };
