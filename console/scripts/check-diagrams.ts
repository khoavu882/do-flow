'use strict';

// Diagram legibility check (feature 133). Dev only, like build-diagrams.ts: console/scripts/ is not in the
// package's `files`. It reads the nine shipped web/diagrams/<class>.svg files (no Pele, no dependency, string
// parsing only) and fails a diagram that is too busy or whose lines run through a box they do not belong to.
//
//   node console/scripts/check-diagrams.ts      one line per diagram; exit 1 when any diagram fails
//
// The rules (DIAGRAM_GUIDE.md section 3, "Complexity budget", flowcharts):
//   nodes:  at most MAX_NODES (12). Subgraph containers do not count; a Pele subgraph container is not a
//           `pele-node` group (not verified against Pele, as it is not installed here and no shipped diagram has one).
//   edges:  at most MAX_EDGES (16).
//   cross:  no edge's path may pass through a node that it neither starts nor ends at.
//
// Structure read from the shipped files: each node is `<g class="pele-node ..." data-id="s0" transform="translate(x,y)">`
// holding one `<rect x y width height>` or `<polygon points>` in the node's own coordinates; each edge is
// `<g class="pele-edge" data-id="L_<from>_<to>_<n>">` holding a `<path d>` (plus a `pele-marker` path, the arrowhead,
// which is skipped) in page coordinates. The endpoints come from the edge's data-id by finding the split of
// `<from>_<to>` into two known node ids (ids may contain underscores, e.g. g0_0).
//
// Approximations (ceiling): a node is its rect, or its polygon for a diamond or hexagon; a rounded corner (rx) is
// ignored, so a line grazing a rounded corner can count as crossing. Pele's edges are M/L polylines, which are exact.
// For completeness C and Q curves are sampled at CURVE_STEPS points and joined by chords, so a curve can bulge at most
// a chord error beyond the samples; an arc (A) is not supported and is treated as its end point. A line must run
// more than MIN_OVERLAP px inside a node to count, so touching or grazing an outline is not a crossing.

const fs = require('node:fs');
const path = require('node:path');
const { OUT_DIR } = require('./build-diagrams.ts');

const MAX_NODES = 12;
const MAX_EDGES = 16;
const CURVE_STEPS = 16;
const MIN_OVERLAP = 1;

type Point = [number, number];
interface Node { id: string, polygon: Point[] }
interface Edge { id: string, from: string | null, to: string | null, points: Point[] }

const attr = (tag: string, name: string): string | null => {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(tag);
  return match ? match[1] : null;
};
const numbers = (text: string): number[] => (text.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);

/** Every `<g class="pele-<kind> ...">` group: its attributes and the markup up to the next group of the same kind or of the other kind. */
function groups(svg: string, kind: 'node' | 'edge'): Array<{ tag: string, body: string }> {
  const opens: Array<{ index: number, tag: string }> = [];
  const re = /<g\b([^>]*)>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(svg)) !== null) {
    const cls = attr(match[1], 'class') ?? '';
    if (cls.split(/\s+/).includes(`pele-${kind}`)) opens.push({ index: match.index, tag: match[1] });
  }
  const stops = [...svg.matchAll(/<g\b[^>]*class="pele-(?:nodes|edges|node|edge)\b[^"]*"/g)].map((m) => m.index as number);
  return opens.map((open) => {
    const next = stops.find((stop) => stop > open.index) ?? svg.length;
    return { tag: open.tag, body: svg.slice(open.index, next) };
  });
}

/** Cubic (C, 4 points) or quadratic (Q, 3 points) Bezier sampled at CURVE_STEPS points after the start. */
function sample(control: Point[]): Point[] {
  const out: Point[] = [];
  for (let step = 1; step <= CURVE_STEPS; step++) {
    const t = step / CURVE_STEPS;
    let level = control;
    while (level.length > 1) level = level.slice(1).map((p, i): Point => [level[i][0] * (1 - t) + p[0] * t, level[i][1] * (1 - t) + p[1] * t]);
    out.push(level[0]);
  }
  return out;
}

/** The vertices of an SVG path `d`: M L H V Z exact; C and Q sampled; S, T and A reduced to their end point. Absolute and relative. */
function pathPoints(d: string): Point[] {
  const points: Point[] = [];
  let cur: Point = [0, 0];
  let start: Point = [0, 0];
  for (const [, cmd, args] of d.matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)) {
    const rel = cmd === cmd.toLowerCase();
    const n = numbers(args);
    const abs = (x: number, y: number): Point => (rel ? [cur[0] + x, cur[1] + y] : [x, y]);
    const op = cmd.toUpperCase();
    const size: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, A: 7, Z: 0 };
    const step = size[op];
    if (step === undefined) continue;
    if (op === 'Z') { cur = start; points.push(cur); continue; }
    for (let i = 0; i + step <= n.length; i += step) {
      const a = n.slice(i, i + step);
      if (op === 'M' || op === 'L' || op === 'T') {
        cur = abs(a[0], a[1]);
        if (op === 'M' && i === 0) start = cur;
        points.push(cur);
      } else if (op === 'H') { cur = [rel ? cur[0] + a[0] : a[0], cur[1]]; points.push(cur); }
      else if (op === 'V') { cur = [cur[0], rel ? cur[1] + a[0] : a[0]]; points.push(cur); }
      else if (op === 'C') { const c = [cur, abs(a[0], a[1]), abs(a[2], a[3]), abs(a[4], a[5])]; points.push(...sample(c)); cur = c[3]; }
      else if (op === 'Q') { const c = [cur, abs(a[0], a[1]), abs(a[2], a[3])]; points.push(...sample(c)); cur = c[2]; }
      else if (op === 'S') { cur = abs(a[2], a[3]); points.push(cur); }
      else { cur = abs(a[5], a[6]); points.push(cur); }
    }
  }
  return points;
}

function readNodes(svg: string): Node[] {
  return groups(svg, 'node').map(({ tag, body }, index): Node => {
    const id = attr(tag, 'data-id') ?? `node#${index}`;
    const move = /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(attr(tag, 'transform') ?? '');
    const [dx, dy] = move ? [Number(move[1]), Number(move[2])] : [0, 0];
    const poly = /<polygon\b[^>]*\bpoints="([^"]*)"/.exec(body);
    const rect = /<rect\b([^>]*)>/.exec(body);
    let polygon: Point[] = [];
    if (poly) {
      const n = numbers(poly[1]);
      for (let i = 0; i + 1 < n.length; i += 2) polygon.push([n[i] + dx, n[i + 1] + dy]);
    } else if (rect) {
      const [x, y, w, h] = ['x', 'y', 'width', 'height'].map((name) => Number(attr(rect[1], name) ?? 0));
      polygon = [[x + dx, y + dy], [x + w + dx, y + dy], [x + w + dx, y + h + dy], [x + dx, y + h + dy]];
    }
    return { id, polygon };
  });
}

function readEdges(svg: string, nodeIds: string[]): Edge[] {
  return groups(svg, 'edge').map(({ tag, body }, index): Edge => {
    const id = attr(tag, 'data-id') ?? `edge#${index}`;
    const known = new Set(nodeIds);
    const rest = /^L_(.+)_\d+$/.exec(id)?.[1] ?? '';
    let from: string | null = null;
    let to: string | null = null;
    for (let cut = 1; cut < rest.length && from === null; cut++) {
      if (rest[cut] === '_' && known.has(rest.slice(0, cut)) && known.has(rest.slice(cut + 1))) { from = rest.slice(0, cut); to = rest.slice(cut + 1); }
    }
    const line = [...body.matchAll(/<path\b([^>]*)>/g)].find((m) => !(attr(m[1], 'class') ?? '').includes('pele-marker'));
    return { id, from, to, points: line ? pathPoints(attr(line[1], 'd') ?? '') : [] };
  });
}

/** Length of the part of the segment a-b inside the convex polygon (Cyrus-Beck clipping; either winding). */
function insideLength(a: Point, b: Point, polygon: Point[]): number {
  let area = 0;
  polygon.forEach((p, i) => { const q = polygon[(i + 1) % polygon.length]; area += p[0] * q[1] - q[0] * p[1]; });
  const sign = area >= 0 ? 1 : -1;
  let t0 = 0;
  let t1 = 1;
  const d: Point = [b[0] - a[0], b[1] - a[1]];
  for (let i = 0; i < polygon.length; i++) {
    const p = polygon[i];
    const q = polygon[(i + 1) % polygon.length];
    // inward normal of edge p-q; the point is inside when dot(normal, x - p) >= 0
    const nx = -sign * (q[1] - p[1]);
    const ny = sign * (q[0] - p[0]);
    const num = nx * (a[0] - p[0]) + ny * (a[1] - p[1]);
    const den = nx * d[0] + ny * d[1];
    if (den === 0) { if (num < 0) return 0; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t0 >= t1) return 0;
  }
  return (t1 - t0) * Math.hypot(d[0], d[1]);
}

/** The legibility failures of one SVG text (empty = legible). */
function legibilityErrors(svgText: string): string[] {
  const errors: string[] = [];
  const nodes = readNodes(svgText);
  const edges = readEdges(svgText, nodes.map((node) => node.id));
  if (nodes.length > MAX_NODES) errors.push(`nodes: ${nodes.length} nodes, the budget is ${MAX_NODES}`);
  if (edges.length > MAX_EDGES) errors.push(`edges: ${edges.length} edges, the budget is ${MAX_EDGES}`);
  for (const edge of edges) {
    if (edge.from === null || edge.to === null) { errors.push(`edge-ends: ${edge.id}: cannot tell which nodes it joins`); continue; }
    for (const node of nodes) {
      if (node.id === edge.from || node.id === edge.to || node.polygon.length < 3) continue;
      for (let i = 0; i + 1 < edge.points.length; i++) {
        const inside = insideLength(edge.points[i], edge.points[i + 1], node.polygon);
        if (inside > MIN_OVERLAP) { errors.push(`crossing: edge ${edge.from} -> ${edge.to} passes through node ${node.id}`); break; }
      }
    }
  }
  return errors;
}

/** One line per diagram file of OUT_DIR, and whether every one passed. */
function checkAll(dir: string = OUT_DIR): { lines: string[], ok: boolean } {
  let ok = true;
  const lines = fs.readdirSync(dir).filter((name: string) => name.endsWith('.svg')).sort().map((name: string) => {
    const text = fs.readFileSync(path.join(dir, name), 'utf8');
    const errors = legibilityErrors(text);
    if (errors.length > 0) ok = false;
    return `${errors.length === 0 ? 'ok  ' : 'FAIL'} ${name}${errors.length === 0 ? '' : `: ${errors.join('; ')}`}`;
  });
  return { lines, ok };
}

if (require.main === module) {
  const { lines, ok } = checkAll();
  console.log(lines.join('\n'));
  process.exit(ok ? 0 : 1);
}

module.exports = { MAX_NODES, MAX_EDGES, legibilityErrors, checkAll, pathPoints };
