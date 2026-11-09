'use strict';

// Path placement and bounded text (feature 151, IC-006; FR-027, NFR-002; DEC-025, DEC-036, D12).
// A path reaches a body only as `{anchor, rel}`: under the project, the project layers, the config
// home or the home folder with a checked relative path, `core/registry/` as `registry`, else the last
// segment alone under `other`. Free text has every anchor value replaced in the whole string, longest
// first, and is then masked whole with `maskLite` (mask-lite.ts:91), whose home rule (:47) does not
// cover a project root outside a home folder. A bounded text over its cap is withheld whole, never
// cut, so no pass ever masks a part of a line (150 review R-1). Anchor values never leave the server.

const fs = require('node:fs');
const { maskLite } = require('./mask-lite.ts');

type Anchors = { project: string[]; projectLayers: string[]; configHome: string[]; home: string[] };
type AnchorName = 'project' | 'project-layers' | 'config-home' | 'home' | 'registry' | 'other';
type Placed = { anchor: AnchorName; rel: string };

const WITHHELD = '(withheld)';
const TOO_LONG = '(withheld: too long)';
const REL_MAX_BYTES = 512;
const SEGMENT = /^[A-Za-z0-9._@+-]{1,128}$/;
const REGISTRY_PREFIX = 'core/registry/';
/** An absolute value once `\` reads as `/`: a leading `/` or a drive prefix. */
const ABSOLUTE = /^\/|^[A-Za-z]:/;

/** Anchor groups in the order they are tried when two values have the same length (IC-006). */
const GROUPS: ReadonlyArray<readonly [keyof Anchors, AnchorName, string]> = Object.freeze([
  ['projectLayers', 'project-layers', '<project layers>'],
  ['configHome', 'config-home', '<config home>'],
  ['project', 'project', '<project>'],
  ['home', 'home', '~'],
] as const);

/** A projector refuses the whole body on this (a contract mismatch); project.ts catches it. */
class Mismatch extends Error {}

const slashed = (value: string): string => value.replace(/\\/g, '/');

/** The value and its realpath form when that differs and resolves; short values and `/` are dropped. */
function forms(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  const add = (form: string) => {
    const trimmed = form.replace(/[\\/]+$/, '');
    if (trimmed.length >= 2 && !out.includes(trimmed)) out.push(trimmed);
  };
  add(value);
  if (value.length >= 2 && value !== '/') {
    try {
      add(fs.realpathSync(value));
    } catch {
      // A value that does not resolve is kept as given only.
    }
  }
  return out;
}

function anchorsOf(input: { projectRoot: string; home: string; configHome?: string | null; layersFrom?: string | null }): Anchors {
  return {
    project: forms(input.projectRoot),
    projectLayers: forms(input.layersFrom),
    configHome: forms(input.configHome),
    home: forms(input.home),
  };
}

/** Every anchor value with its group, longest first, ties in group order. */
function ordered(anchors: Anchors): Array<{ value: string; name: AnchorName; label: string }> {
  const list: Array<{ value: string; name: AnchorName; label: string }> = [];
  for (const [key, name, label] of GROUPS) for (const value of anchors[key]) list.push({ value, name, label });
  return list.sort((a, b) => b.value.length - a.value.length);
}

/** `rel` as it is when it is short, every segment is safe and none is `..`, and the mask keeps it. */
function checkedRel(rel: string): string {
  if (rel === '') return '';
  if (Buffer.byteLength(rel, 'utf8') > REL_MAX_BYTES) return WITHHELD;
  if (!rel.split('/').every((segment) => SEGMENT.test(segment) && segment !== '..')) return WITHHELD;
  return maskLite(rel) === rel ? rel : WITHHELD;
}

function placePath(value: unknown, anchors: Anchors): Placed | null {
  if (typeof value !== 'string' || value === '') return null;
  const target = slashed(value);
  for (const { value: anchor, name } of ordered(anchors)) {
    const base = slashed(anchor);
    if (target === base) return { anchor: name, rel: '' };
    if (target.startsWith(`${base}/`)) return { anchor: name, rel: checkedRel(target.slice(base.length + 1)) };
  }
  if (!ABSOLUTE.test(target)) {
    if (target.startsWith(REGISTRY_PREFIX)) return { anchor: 'registry', rel: checkedRel(target.slice(REGISTRY_PREFIX.length)) };
    if (checkedRel(target) === target) return { anchor: 'project', rel: target };
  }
  const segments = target.split('/').filter((segment) => segment !== '');
  return { anchor: 'other', rel: checkedRel(segments.length ? segments[segments.length - 1] : '') };
}

/**
 * `text` with every occurrence of each anchor value, longest first, replaced by its label, in the
 * value's own separators and in the other separator form, then masked whole with `maskLite`.
 */
function placeText(text: string, anchors: Anchors): string {
  if (typeof text !== 'string') throw new TypeError('placeText takes a string');
  const pairs: Array<{ value: string; label: string }> = [];
  for (const { value, label } of ordered(anchors)) {
    for (const form of [value, slashed(value), value.replace(/\//g, '\\')]) {
      if (!pairs.some((pair) => pair.value === form)) pairs.push({ value: form, label });
    }
  }
  let out = text;
  for (const { value, label } of pairs) out = out.split(value).join(label);
  return maskLite(out);
}

/**
 * A projector Check: a string is placed and masked whole, and a result over `cap` bytes becomes
 * `(withheld: too long)`, never a prefix. A non-string is a contract mismatch.
 */
function boundedText(cap: number, anchors: Anchors): (value: unknown) => string {
  return (value: unknown): string => {
    if (typeof value !== 'string') throw new Mismatch('bounded text is not a string');
    const placed = placeText(value, anchors);
    return Buffer.byteLength(placed, 'utf8') > cap ? TOO_LONG : placed;
  };
}

module.exports = { Mismatch, TOO_LONG, WITHHELD, anchorsOf, boundedText, placePath, placeText };
