'use strict';

// Diagram legibility (feature 133). Runs the budget and edge-crossing rules of scripts/check-diagrams.ts over the nine
// shipped web/diagrams/<class>.svg files and, as controls, over planted SVGs: each rule must fail on its own bad
// input and a good diagram must pass.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { OUT_DIR } = require('../scripts/build-diagrams.ts');
const { MAX_NODES, MAX_EDGES, legibilityErrors, checkAll } = require('../scripts/check-diagrams.ts');

const REPO = path.join(__dirname, '..', '..');
/** The classes of the core's registry, read from the registry file itself, as diagrams.test.ts does. */
const CLASSES: string[] = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8')).classes);

// ---- planted SVGs, in the structure Pele writes (g.pele-edge / g.pele-node, rect nodes 100x72, translate = centre) ----

type Box = [id: string, cx: number, cy: number];
const node = ([id, cx, cy]: Box) => `<g class="pele-node pele-shape-rounded" data-id="${id}" transform="translate(${cx},${cy})"><rect x="-50" y="-36" width="100" height="72" rx="12"/></g>`;
const edge = (from: string, to: string, d: string, n = 0) => `<g class="pele-edge" data-id="L_${from}_${to}_${n}"><path d="${d}"/><path class="pele-marker" d="M0,0L1,1L1,0Z"/></g>`;
const svg = (edges: string[], nodes: Box[]) => `<svg xmlns="http://www.w3.org/2000/svg" class="pele pele-flowchart"><g class="pele-edges">${edges.join('')}</g><g class="pele-nodes">${nodes.map(node).join('')}</g></svg>`;

/** A row of n nodes (s0..s<n-1>), 200 apart, joined in order. */
const row = (n: number) => {
  const boxes: Box[] = Array.from({ length: n }, (_, i) => [`s${i}`, 100 + i * 200, 50]);
  const edges = boxes.slice(1).map((box, i) => edge(`s${i}`, box[0], `M${150 + i * 200},50L${50 + (i + 1) * 200},50`));
  return { boxes, edges };
};

test('the shipped diagrams are the nine task classes', () => {
  assert.deepEqual(fs.readdirSync(OUT_DIR).sort(), CLASSES.map((taskClass) => `${taskClass}.svg`).sort());
  assert.equal(CLASSES.length, 9);
});

for (const taskClass of CLASSES) {
  test(`${taskClass}: at most ${MAX_NODES} nodes, ${MAX_EDGES} edges, and no edge crosses a node`, () => {
    const text = fs.readFileSync(path.join(OUT_DIR, `${taskClass}.svg`), 'utf8');
    assert.deepEqual(legibilityErrors(text), []);
  });
}

// ---- controls ------------------------------------------------------------------------------------

test('control: a good diagram passes', () => {
  const { boxes, edges } = row(4);
  assert.deepEqual(legibilityErrors(svg(edges, boxes)), []);
});

test('control: exactly the budget passes (12 nodes, 11 edges)', () => {
  const { boxes, edges } = row(MAX_NODES);
  assert.deepEqual(legibilityErrors(svg(edges, boxes)), []);
});

test('control: a 13-node diagram fails the node budget', () => {
  const { boxes, edges } = row(MAX_NODES + 1);
  const errors = legibilityErrors(svg(edges, boxes));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^nodes: 13 nodes/);
});

test('control: a 17-edge diagram fails the edge budget', () => {
  const { boxes } = row(3);
  const edges = Array.from({ length: MAX_EDGES + 1 }, (_, n) => edge('s0', 's1', 'M150,50L250,50', n));
  const errors = legibilityErrors(svg(edges, boxes));
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^edges: 17 edges/);
});

test('control: an edge that passes through a third node fails', () => {
  const { boxes, edges } = row(3);
  const through = edge('s0', 's2', 'M150,50L450,50', 1);
  assert.deepEqual(legibilityErrors(svg([...edges, through], boxes)), ['crossing: edge s0 -> s2 passes through node s1']);
});

test('control: a bent edge that goes around the third node passes, one that cuts its corner fails', () => {
  const { boxes, edges } = row(3);
  const around = edge('s0', 's2', 'M150,50L150,-20L450,-20L450,50', 1);
  assert.deepEqual(legibilityErrors(svg([...edges, around], boxes)), []);
  const cut = edge('s0', 's2', 'M150,50L200,10L450,50', 1);
  assert.deepEqual(legibilityErrors(svg([...edges, cut], boxes)), ['crossing: edge s0 -> s2 passes through node s1']);
});

test('control: a curve sampled through a third node fails', () => {
  const { boxes, edges } = row(3);
  const curve = edge('s0', 's2', 'M150,50C250,50 350,50 450,50', 1);
  assert.deepEqual(legibilityErrors(svg([...edges, curve], boxes)), ['crossing: edge s0 -> s2 passes through node s1']);
});

test('control: a line only touching a node outline is not a crossing, and a diamond is tested by its shape, not its box', () => {
  const touching = svg([edge('a', 'c', 'M150,-36L450,-36')], [['a', 100, 50], ['b', 300, 50], ['c', 500, 50]]);
  assert.deepEqual(legibilityErrors(touching), []);
  const diamond = `<g class="pele-node pele-shape-diam" data-id="d" transform="translate(300,50)"><polygon points="0,-40 100,0 0,40 -100,0"/></g>`;
  const through = (d: string) => `<svg xmlns="http://www.w3.org/2000/svg"><g class="pele-edges">${edge('a', 'c', d)}</g><g class="pele-nodes">${node(['a', 100, 50])}${diamond}${node(['c', 500, 50])}</g></svg>`;
  // the diamond spans x 200..400, y 10..90: a line at y=14 reaches x=250 inside its box but never touches the diamond
  assert.deepEqual(legibilityErrors(through('M150,14L250,14')), []);
  assert.deepEqual(legibilityErrors(through('M150,50L450,50')), ['crossing: edge a -> c passes through node d']);
});

test('control: node ids with underscores (g0_0) are told apart from the edge-id separators', () => {
  const boxes: Box[] = [['s0', 100, 50], ['g0_0', 300, 50], ['s1', 500, 50]];
  const edges = [edge('s0', 'g0_0', 'M150,50L250,50'), edge('g0_0', 's1', 'M350,50L450,50'), edge('s0', 's1', 'M150,50L450,50', 1)];
  assert.deepEqual(legibilityErrors(svg(edges, boxes)), ['crossing: edge s0 -> s1 passes through node g0_0']);
});

test('control: an edge whose ends are not nodes of the diagram is reported, not skipped', () => {
  const { boxes } = row(2);
  assert.match(legibilityErrors(svg([edge('s0', 'ghost', 'M150,50L250,50')], boxes))[0], /^edge-ends: L_s0_ghost_0/);
});

// ---- fail closed: a parser that sees nothing must not pass ---------------------------------------

test('control: an empty SVG fails (no nodes parsed)', () => {
  const errors = legibilityErrors('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  assert.equal(errors.length > 0, true);
  assert.match(errors.join('; '), /^no-nodes:/);
});

test('control: renamed Pele classes fail instead of parsing to nothing', () => {
  const { boxes, edges } = row(4);
  const renamed = svg(edges, boxes).replaceAll('pele-node', 'diagram-node').replaceAll('pele-edge', 'diagram-edge');
  assert.match(legibilityErrors(renamed).join('; '), /no-nodes:/);
});

test('control: nodes without edges fail when there are two or more nodes', () => {
  const { boxes } = row(3);
  assert.match(legibilityErrors(svg([], boxes)).join('; '), /no-edges:/);
});

test('control: a node of an unknown shape fails (a circle is not understood)', () => {
  const { boxes, edges } = row(3);
  const bad = svg(edges, boxes).replace('<rect x="-50" y="-36" width="100" height="72" rx="12"/>', '<circle r="40"/>');
  assert.match(legibilityErrors(bad).join('; '), /node-shape: s0/);
});

test('control: an edge without a parseable path fails', () => {
  const { boxes, edges } = row(3);
  const bad = svg([edges[0], edge('s1', 's2', '')], boxes);
  assert.match(legibilityErrors(bad).join('; '), /edge-path: L_s1_s2_0/);
  const noPath = svg(edges, boxes).replace(/<g class="pele-edge" data-id="L_s1_s2_0">.*?<\/g>/, '<g class="pele-edge" data-id="L_s1_s2_0"></g>');
  assert.match(legibilityErrors(noPath).join('; '), /edge-path: L_s1_s2_0/);
});

test('control: a directory with no SVG files fails', () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'doflow-diagrams-'));
  try {
    assert.equal(checkAll(dir).ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
