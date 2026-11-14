'use strict';

// Run directly by Node native type-stripping.

/**
 * The one key-sorted JSON in `src/runtime`. Two shapes, because the callers' bytes differ:
 * `canonicalJson` builds the compact text itself (a digest input), `sortKeysDeep` returns a tree for
 * `JSON.stringify` to print (indented output, or a digest over the plain stringify of that tree).
 */

/**
 * JSON text with object keys sorted at every depth, arrays in their order, and no whitespace.
 * An `undefined` leaf comes out as `undefined` (what `JSON.stringify(undefined)` gives); with
 * `undefinedAsNull` it is `null`, as the dispatch envelope and the task-run acknowledgement digest
 * have always written it.
 */
function canonicalJson(value: any, { undefinedAsNull = false }: { undefinedAsNull?: boolean } = {}): string {
  const walk = (node: any): string => {
    if (Array.isArray(node)) return `[${node.map((item) => walk(item)).join(',')}]`;
    if (node && typeof node === 'object') {
      return `{${Object.keys(node).sort().map((key) => `${JSON.stringify(key)}:${walk(node[key])}`).join(',')}}`;
    }
    return JSON.stringify(undefinedAsNull && node === undefined ? null : node);
  };
  return walk(value);
}

/** A copy of `value` with object keys sorted at every depth; arrays keep their order, other values are returned as they are. */
function sortKeysDeep(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])]));
  return value;
}

module.exports = { canonicalJson, sortKeysDeep };
