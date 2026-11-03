'use strict';

// Leaf-walk helpers for the brief-is-a-projection check of guard G80 (feature 137, IC-009).
//
// `keepPathsOf` reads a verb's keep list from the source that declares it, so the guard never keeps a
// second copy. `resolvesPath` says whether a keep path finds a value in a full answer. `subsetViolations`
// walks every leaf of a brief answer and reports each one that is missing from, or differs in, the full
// answer at the same path.

const fs = require('node:fs');

/**
 * The keep paths of the spec constant `constName` declared in `file`: the string literals of its
 * `keep: Object.freeze([...])` list.
 * @param {string} file
 * @param {string} constName
 * @returns {string[]}
 */
function keepPathsOf(file: string, constName: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  const start = text.indexOf(`const ${constName} =`);
  if (start < 0) throw new Error(`${file}: no spec constant ${constName}`);
  const keep = /keep:\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(text.slice(start));
  if (!keep) throw new Error(`${file}: ${constName} has no keep list`);
  const body = keep[1].replace(/\/\/[^\n]*/g, '');
  const literal = /(['"])([^'"\n]+)\1/g;
  const paths = [...body.matchAll(literal)].map((m) => m[2]);
  // Anything left once the string literals, commas and whitespace are gone is a computed entry the check cannot read.
  const unparsed = body.replace(literal, '').replace(/[\s,]/g, '');
  if (unparsed) throw new Error(`${file}: ${constName} keep list has an entry that is not a plain string literal: ${unparsed}`);
  if (!paths.length) throw new Error(`${file}: ${constName} keep list is empty`);
  return paths;
}

/** True when keep path `keepPath` (`$.a.b[].c`) finds at least one value in `full`. */
function resolvesPath(full: unknown, keepPath: string): boolean {
  const segments = keepPath.replace(/^\$/, '').split('.').slice(1);
  if (!segments.length) throw new Error(`malformed keep path ${keepPath}`);
  const walk = (value: any, i: number): boolean => {
    if (i === segments.length) return true;
    const seg = segments[i];
    const each = seg.endsWith('[]');
    const key = each ? seg.slice(0, -2) : seg;
    if (value === null || typeof value !== 'object' || Array.isArray(value) || !(key in value)) return false;
    const next = value[key];
    if (!each) return walk(next, i + 1);
    return Array.isArray(next) && next.some((element: unknown) => walk(element, i + 1));
  };
  return walk(full, 0);
}

/**
 * Every leaf of `brief` (a primitive, null, an empty array or an empty object) outside the root keys in
 * `exclude` that is missing from `full` at the same path or has a different value there.
 * `arrayOffsets` maps a dotted array path (`items`) to the index in `full` that index 0 of the brief array
 * corresponds to, for a paged answer.
 * @returns {string[]} one line per violation, empty when the brief is a subset
 */
function subsetViolations(brief: any, full: any, { exclude = [], arrayOffsets = {} }: { exclude?: readonly string[]; arrayOffsets?: Record<string, number> } = {}): string[] {
  const out: string[] = [];
  const walk = (b: any, f: any, at: string, dotted: string) => {
    if (Array.isArray(b)) {
      if (!Array.isArray(f)) { out.push(`${at}: brief has an array, full has ${describe(f)}`); return; }
      const offset = arrayOffsets[dotted] ?? 0;
      if (!b.length) return;
      b.forEach((element, i) => {
        if (offset + i >= f.length) out.push(`${at}[${i}]: full has only ${f.length} elements`);
        else walk(element, f[offset + i], `${at}[${i}]`, `${dotted}[]`);
      });
      return;
    }
    if (b !== null && typeof b === 'object') {
      if (f === null || typeof f !== 'object' || Array.isArray(f)) { out.push(`${at}: brief has an object, full has ${describe(f)}`); return; }
      for (const key of Object.keys(b)) {
        if (at === '$' && exclude.includes(key)) continue;
        if (!(key in f)) { out.push(`${at}.${key}: absent from the full answer`); continue; }
        walk(b[key], f[key], `${at}.${key}`, dotted ? `${dotted}.${key}` : key);
      }
      return;
    }
    if (!Object.is(b, f)) out.push(`${at}: brief ${JSON.stringify(b)} differs from full ${JSON.stringify(f)}`);
  };
  walk(brief, full, '$', '');
  return out;
}

function describe(value: unknown) {
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  return value === null ? 'null' : typeof value;
}

module.exports = { keepPathsOf, resolvesPath, subsetViolations };
