'use strict';

// Workflow diagrams (feature 093, F.1; IC-011, FR-012). Runs without Pele: it regenerates each class's
// Mermaid text from the core's `workflow` verb and compares its hash with the `source-sha256` stamp of the
// shipped web/diagrams/<class>.svg, so a diagram that no longer matches the registry fails here. The SVG
// checks run on the shipped files and, as controls, on planted bad SVGs.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { mermaidFor, sourceHash, readStamp, checkSvg, readWorkflow, OUT_DIR, DEFAULT_CORE, MAX_SVG_BYTES } = require('../scripts/build-diagrams.ts');

const REPO = path.join(__dirname, '..', '..');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
/** The classes of the core's registry, read from the registry file itself (not from the Console's copy). */
const CLASSES: string[] = Object.keys(JSON.parse(fs.readFileSync(path.join(REPO, 'core', 'registry', 'workflows.json'), 'utf8')).classes);

const fileFor = (taskClass: string) => path.join(OUT_DIR, `${taskClass}.svg`);
const bodies = new Map<string, any>();
const workflowOf = (taskClass: string) => {
  if (!bodies.has(taskClass)) bodies.set(taskClass, readWorkflow(DEFAULT_CORE, taskClass));
  return bodies.get(taskClass);
};

/** The drift rule as one function: the failures of a shipped diagram text against the current Mermaid text (empty = in step). */
function driftErrors(fileText: string, mermaid: string): string[] {
  const stamp = readStamp(fileText);
  if (!stamp) return ['stamp: the first line is not <!-- source-sha256: <64 hex> pele: <version> -->'];
  const errors: string[] = [];
  if (stamp.hash !== sourceHash(mermaid)) errors.push(`drift: stamp ${stamp.hash} but the registry's Mermaid text hashes to ${sourceHash(mermaid)}`);
  if (stamp.pele !== MANIFEST.devDependencies?.pele) errors.push(`pele: stamped ${stamp.pele}, package.json pins ${MANIFEST.devDependencies?.pele}`);
  return errors;
}

test('the registry has the nine task classes the Console lists', () => {
  assert.deepEqual(CLASSES, ['feature', 'bug', 'refactor', 'review', 'research', 'documentation', 'dependency-change', 'operations', 'trivial-edit']);
});

for (const taskClass of CLASSES) {
  test(`${taskClass}: a diagram file exists, is in step with the registry and passes the SVG checks`, () => {
    assert.ok(fs.existsSync(fileFor(taskClass)), `web/diagrams/${taskClass}.svg exists`);
    const text = fs.readFileSync(fileFor(taskClass), 'utf8');
    assert.deepEqual(driftErrors(text, mermaidFor(workflowOf(taskClass))), []);
    assert.deepEqual(checkSvg(text), []);
    assert.match(text.slice(text.indexOf('\n') + 1), /^<svg\b[^>]*\bxmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  });
}

test('web/diagrams holds the nine diagrams and nothing else', () => {
  assert.ok(fs.existsSync(OUT_DIR), 'web/diagrams exists');
  assert.deepEqual(fs.readdirSync(OUT_DIR).sort(), CLASSES.map((c) => `${c}.svg`).sort());
});

// ---- controls ------------------------------------------------------------------------------------

test('control: a changed stage purpose changes the Mermaid text, so a diagram stamped from the old text reads as drift', () => {
  const mermaid = mermaidFor(workflowOf('feature'));
  const stamped = `<!-- source-sha256: ${sourceHash(mermaid)} pele: ${MANIFEST.devDependencies?.pele ?? 'unpinned'} -->\n<svg xmlns="http://www.w3.org/2000/svg"/>\n`;
  const drift = (text: string, current: string) => driftErrors(text, current).filter((error) => error.startsWith('drift:'));
  assert.deepEqual(drift(stamped, mermaid), []);
  const edited = structuredClone(workflowOf('feature'));
  edited.stages[1].purpose = `${edited.stages[1].purpose} (edited)`;
  assert.notEqual(mermaidFor(edited), mermaid);
  assert.equal(drift(stamped, mermaidFor(edited)).length, 1);
});

test('control: the stamp is required and the Pele version must be the pinned one', () => {
  const mermaid = mermaidFor(workflowOf('feature'));
  assert.match(driftErrors('<svg xmlns="http://www.w3.org/2000/svg"/>', mermaid)[0], /^stamp:/);
  assert.match(driftErrors(`<!-- source-sha256: ${sourceHash(mermaid)} pele: 0.0.0 -->\n<svg/>`, mermaid)[0], /^pele:/);
});

test('Mermaid text: stages rounded, approval gates diamonds, clarification gates hexagons, optional stages dashed, program order', () => {
  const feature = mermaidFor(workflowOf('feature'));
  assert.match(feature, /^flowchart LR\n/);
  assert.match(feature, /\n {2}s0\("discovery<br\/>do-brainstorm"\)\n/);
  assert.match(feature, /\n {2}g0_0\{\{"gate-0<br\/>[^"]+"\}\}\n/);
  assert.match(feature, /\n {2}g2_0\{"gate-a<br\/>[^"]+"\}\n/);
  assert.match(feature, /\n {2}s0 --> g0_0 --> s1 --> s2 --> g2_0 --> s3 --> s4 --> s5 --> g5_0\n/);
  assert.doesNotMatch(feature, /classDef optional/);
  const bug = mermaidFor(workflowOf('bug'));
  assert.match(bug, /\n {2}classDef optional stroke-dasharray:5 3\n {2}class s4 optional\n$/);
  assert.equal(sourceHash(mermaidFor(workflowOf('bug'))), sourceHash(bug));
});

test('Mermaid text: a gate of an unknown kind is refused, text with Mermaid syntax characters is flattened', () => {
  const odd = structuredClone(workflowOf('feature'));
  odd.stages[0].gatesAfter[0].kind = 'sparkle';
  assert.throws(() => mermaidFor(odd), /unknown kind/);
  const quoted = structuredClone(workflowOf('feature'));
  quoted.stages[0].purpose = 'say "hi" {now}\n<b>x</b>';
  const text = mermaidFor(quoted);
  assert.match(text, /: say 'hi' \(now\) bx\/b\n/);
  assert.equal(text.split('\n').filter((line: string) => /^ {2}\}$/.test(line)).length, 1);
});

const SAFE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g style="fill:var(--a,#fff)"><text>x</text></g><use href="#a"/></svg>';
const PLANTED: Array<[string, string, string]> = [
  ['script', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', 'script'],
  ['uppercase script', '<svg xmlns="http://www.w3.org/2000/svg"><SCRIPT>x</SCRIPT></svg>', 'script'],
  ['on* attribute', '<svg xmlns="http://www.w3.org/2000/svg" onload="x()"></svg>', 'event-attribute'],
  ['on* attribute after another', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" onclick = "x()"/></svg>', 'event-attribute'],
  ['http href', '<svg xmlns="http://www.w3.org/2000/svg"><a href="https://example.invalid/">x</a></svg>', 'href'],
  ['xlink href', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="x.svg#a"/></svg>', 'href'],
  ['javascript href', '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:x()">x</a></svg>', 'href'],
  ['external image', '<svg xmlns="http://www.w3.org/2000/svg"><image src="https://example.invalid/a.png"/></svg>', 'external-url'],
  ['network path', '<svg xmlns="http://www.w3.org/2000/svg"><image src="//example.invalid/a.png"/></svg>', 'external-url'],
  ['css url', '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(x.png)"/></svg>', 'css-url'],
  ['css import', '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "x.css";</style></svg>', 'css-import'],
  ['oversize', `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${'x'.repeat(MAX_SVG_BYTES)} --></svg>`, 'size'],
];

test('control: checkSvg passes a clean SVG with the namespace identifiers, fragment links and var() fallbacks', () => {
  assert.deepEqual(checkSvg(SAFE), []);
  assert.deepEqual(checkSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(#g)"/></svg>'), []);
});

for (const [name, svg, rule] of PLANTED) {
  test(`control: checkSvg refuses a planted ${name}`, () => {
    const errors = checkSvg(svg);
    assert.ok(errors.some((error: string) => error.startsWith(`${rule}:`)), `${rule} in ${JSON.stringify(errors)}`);
  });
}
