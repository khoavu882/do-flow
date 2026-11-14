'use strict';

// drawio-project.ts turns a C4-PlantUML source into an editable draw.io draft. These pin the parts a
// person relies on when they open the file: what each macro becomes, where it sits, what an icon
// folder may and may not do, and that the same input gives the same bytes.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const { project, makeIconResolver, iconKeys, renderLevels, MAX_ICON_BYTES } = require('../../src/runtime/drawio-project.ts');
const { Refused } = require('../../src/runtime/c4-project.ts');

const WORK = suiteTempDir('doflow-drawio-project-');
let n = 0;
const scratch = () => { const d = path.join(WORK, String(n++)); fs.mkdirSync(d); return fs.realpathSync(d); };
const puml = (body: string) => `@startuml\n!include <C4/C4_Container>\n${body}\n@enduml\n`;
/** The attribute text of one cell, found by id. */
const cellOf = (xml: string, id: string) => {
  const m = new RegExp(`<mxCell id="${id}"[^>]*>`).exec(xml);
  if (!m) throw new assert.AssertionError({ message: `no cell ${id} in:\n${xml}` });
  return m[0];
};
const attr = (cell: string, name: string) => new RegExp(` ${name}="([^"]*)"`).exec(cell)?.[1];

// 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8"/></svg>';

test('the file is a draw.io document with the two root cells', () => {
  const { xml } = project(puml('Container(a, "A", "Go")'), { name: 'container' });
  assert.match(xml, /^<mxfile>\n {2}<diagram id="c4-container" name="container">\n {4}<mxGraphModel /);
  assert.match(xml, /<root>\n {8}<mxCell id="0"\/>\n {8}<mxCell id="1" parent="0"\/>/);
  assert.ok(xml.endsWith('</mxfile>\n'));
});

test('an element is a vertex labelled name, [technology], description; variants pick a shape and a fill', () => {
  const { xml, counts } = project(puml([
    'Person(u, "User", "Someone")',
    'Container(api, "API", "Go", "Serves it")',
    'ContainerDb(db, "Store", "PostgreSQL")',
    'ContainerQueue(q, "Events", "Kafka")',
    'System_Ext(mail, "Mail", "Sends mail")',
  ].join('\n')));
  assert.deepEqual(counts, { elements: 5, boundaries: 0, edges: 0 });
  assert.equal(attr(cellOf(xml, 'el-api'), 'value'), '&lt;b&gt;API&lt;/b&gt;&lt;br&gt;[Go]&lt;br&gt;Serves it');
  assert.match(attr(cellOf(xml, 'el-u'), 'style') as string, /shape=umlActor/);
  assert.match(attr(cellOf(xml, 'el-db'), 'style') as string, /shape=cylinder3/);
  assert.match(attr(cellOf(xml, 'el-q'), 'style') as string, /^rounded=1;/);
  assert.match(attr(cellOf(xml, 'el-mail'), 'style') as string, /fillColor=#e6e6e6/, 'an external element is grey');
  assert.match(attr(cellOf(xml, 'el-api'), 'style') as string, /fillColor=#dae8fc/, 'an internal one is not');
  // Person and System take (descr, sprite), Container and Component put a technology first.
  assert.equal(attr(cellOf(xml, 'el-u'), 'value'), '&lt;b&gt;User&lt;/b&gt;&lt;br&gt;Someone');
});

test('named arguments are read by name wherever they sit', () => {
  const { xml } = project(puml('Container(a, "A", $descr="Does it", $techn="Rust")'));
  assert.equal(attr(cellOf(xml, 'el-a'), 'value'), '&lt;b&gt;A&lt;/b&gt;&lt;br&gt;[Rust]&lt;br&gt;Does it');
});

test('nested boundaries are swimlane containers; children are placed relative to their parent', () => {
  const { xml, counts } = project(puml([
    'System_Boundary(outer, "Outer") {',
    '  Container(a, "A")',
    '  Container_Boundary(inner, "Inner") {',
    '    Container(b, "B")',
    '  }',
    '}',
    'Container(c, "C")',
  ].join('\n')));
  assert.equal(counts.boundaries, 2);
  const outer = cellOf(xml, 'bd-outer');
  assert.equal(attr(outer, 'style'), 'swimlane;startSize=30;html=1;');
  assert.equal(attr(outer, 'parent'), '1');
  assert.equal(attr(cellOf(xml, 'bd-inner'), 'parent'), 'bd-outer');
  assert.equal(attr(cellOf(xml, 'el-a'), 'parent'), 'bd-outer');
  assert.equal(attr(cellOf(xml, 'el-b'), 'parent'), 'bd-inner');
  assert.equal(attr(cellOf(xml, 'el-c'), 'parent'), '1');
  // Relative coordinates: the first child sits inside the container's padding and header, not at the page origin.
  assert.match(xml, /id="el-a"[^>]*>\n\s+<mxGeometry x="30" y="60" /);
  // A container is sized to hold its children.
  const w = Number(/id="bd-outer"[^>]*>\n\s+<mxGeometry x="\d+" y="\d+" width="(\d+)"/.exec(xml)?.[1]);
  assert.ok(w >= 200 + 60, `container width ${w} holds a 200-wide child plus padding`);
});

test('an edge sits in the innermost container holding both ends, else on the page', () => {
  const { xml } = project(puml([
    'System_Boundary(sys, "Sys") {',
    '  Container(a, "A")',
    '  Container(b, "B")',
    '  Container_Boundary(inner, "Inner") {',
    '    Container(d, "D")',
    '  }',
    '}',
    'Container(c, "C")',
    'Rel(a, b, "reads", "SQL")',
    'Rel(a, d, "calls")',
    'Rel(a, c, "sends")',
    'BiRel(b, c, "syncs")',
  ].join('\n')));
  const within = cellOf(xml, 'rel-1-a-b');
  assert.equal(attr(within, 'parent'), 'bd-sys');
  assert.equal(attr(within, 'source'), 'el-a');
  assert.equal(attr(within, 'target'), 'el-b');
  assert.equal(attr(within, 'value'), 'reads&lt;br&gt;[SQL]');
  assert.match(attr(within, 'style') as string, /^edgeStyle=orthogonalEdgeStyle;html=1;/);
  assert.equal(attr(cellOf(xml, 'rel-2-a-d'), 'parent'), 'bd-sys', 'one end in a nested container: the outer one holds both');
  assert.equal(attr(cellOf(xml, 'rel-3-a-c'), 'parent'), '1');
  assert.match(attr(cellOf(xml, 'rel-4-b-c'), 'style') as string, /startArrow=block/, 'a BiRel points both ways');
});

test('a relation naming an alias the source never defines is refused with the line', () => {
  assert.throws(() => project(puml('Container(a, "A")\nRel(a, ghost, "x")'), { sourcePath: 'c.puml' }),
    (e: any) => e instanceof Refused && /c\.puml:4: Rel names 'ghost'/.test(e.message));
});

test('<, >, & and " in a label survive as text, in the attribute and in the HTML inside it', () => {
  const { xml } = project(puml('Container(a, "A <b> & \\"c\\"", "T<1>", "d & e")\nContainer(b, "B")\nRel(a, b, "x < y & \\"z\\"")'));
  const value = attr(cellOf(xml, 'el-a'), 'value') as string;
  assert.ok(!/[<>"]/.test(value), 'no raw <, > or " inside an attribute value');
  assert.equal(value, '&lt;b&gt;A &amp;lt;b&amp;gt; &amp;amp; &quot;c&quot;&lt;/b&gt;&lt;br&gt;[T&amp;lt;1&amp;gt;]&lt;br&gt;d &amp;amp; e');
  assert.equal(attr(cellOf(xml, 'rel-1-a-b'), 'value'), 'x &amp;lt; y &amp;amp; &quot;z&quot;');
});

test('the same source gives the same bytes, with ids drawn from the aliases', () => {
  const body = puml('System_Boundary(s, "S") {\nContainer(a, "A", "Go")\nContainer(b, "B")\n}\nRel(a, b, "x")');
  const one = project(body, { name: 'container' }).xml;
  assert.equal(project(body, { name: 'container' }).xml, one);
  assert.deepEqual([...one.matchAll(/<mxCell id="([^"]+)"/g)].map((m) => m[1]), ['0', '1', 'bd-s', 'el-a', 'el-b', 'rel-1-a-b']);
});

test('an unrecognized macro is refused, naming macro, file and line', () => {
  assert.throws(() => project(puml('Container(a, "A")\nMadeUpMacro(a, b)'), { sourcePath: 'x.puml' }),
    (e: any) => e instanceof Refused && /x\.puml:4: unrecognized macro 'MadeUpMacro'/.test(e.message));
});

test('the icon keys are the sprite, then each technology phrase and its words from the last', () => {
  assert.deepEqual(iconKeys('kafka', 'Apache Kafka'), ['kafka', 'apachekafka', 'apache']);
  assert.deepEqual(iconKeys(undefined, 'Apache Kafka'), ['apachekafka', 'kafka', 'apache']);
  assert.deepEqual(iconKeys(undefined, 'Spring Boot, Java/Kotlin'), ['springboot', 'boot', 'spring', 'java', 'kotlin']);
  assert.deepEqual(iconKeys(undefined, 'Node.js'), ['nodejs']);
  assert.deepEqual(iconKeys(undefined, undefined), []);
});

test('an icon is matched by $sprite, else by technology, and becomes an image shape with no ";base64" in the style', () => {
  const root = scratch();
  const icons = path.join(root, 'icons');
  fs.mkdirSync(icons);
  fs.writeFileSync(path.join(icons, 'PostgreSQL.svg'), SVG);
  fs.writeFileSync(path.join(icons, 'kafka.png'), PNG);
  fs.writeFileSync(path.join(icons, 'goland.svg'), SVG);
  const resolver = makeIconResolver(icons, [root]);
  const { xml, icons: report } = project(puml([
    'ContainerDb(db, "Store", "PostgreSQL")',
    'ContainerQueue(q, "Events", "Apache Kafka")',
    'Container(api, "API", "Go", $sprite="goland")',
    'Container(web, "Web", "React")',
  ].join('\n')), { icons: resolver });
  assert.deepEqual(report.used, [
    { element: 'db', file: 'PostgreSQL.svg' },
    { element: 'q', file: 'kafka.png' },
    { element: 'api', file: 'goland.svg' },
  ]);
  assert.deepEqual(report.missing, [{ element: 'web', keys: ['react'] }]);
  const png = attr(cellOf(xml, 'el-q'), 'style') as string;
  assert.ok(png.startsWith('shape=image;image=data:image/png,'), png);
  assert.ok(png.includes(PNG.toString('base64')));
  assert.match(png, /;verticalLabelPosition=bottom;verticalAlign=top;imageAspect=0;aspect=fixed;html=1;$/);
  const svg = attr(cellOf(xml, 'el-db'), 'style') as string;
  assert.ok(svg.startsWith('shape=image;image=data:image/svg+xml,'), svg);
  // The style is split on ";", so a ";base64" in the data URI would cut the image off.
  assert.ok(!/;base64/.test(png + svg));
  assert.deepEqual(png.split(';').filter((k) => !k.startsWith('image=')), ['shape=image', 'verticalLabelPosition=bottom', 'verticalAlign=top', 'imageAspect=0', 'aspect=fixed', 'html=1', '']);
});

test('an element with no technology and no sprite has nothing to look up and is not reported missing', () => {
  const root = scratch();
  const { icons } = project(puml('Person(u, "User")'), { icons: makeIconResolver(path.join(root, 'none'), [root]) });
  assert.deepEqual(icons, { used: [], missing: [], skipped: [] });
});

test('an icon over the size cap is skipped and named; a smaller later candidate still wins', () => {
  const root = scratch();
  const icons = path.join(root, 'icons');
  fs.mkdirSync(icons);
  fs.writeFileSync(path.join(icons, 'apachekafka.svg'), Buffer.alloc(MAX_ICON_BYTES + 1, 'a'));
  const resolver = makeIconResolver(icons, [root]);
  const big = project(puml('ContainerQueue(q, "Events", "Apache Kafka")'), { icons: resolver });
  assert.deepEqual(big.icons.skipped, [{ element: 'q', file: 'apachekafka.svg', why: 'larger than 256 KB' }]);
  assert.deepEqual(big.icons.used, []);
  assert.deepEqual(big.icons.missing, [{ element: 'q', keys: ['apachekafka', 'kafka', 'apache'] }]);
  assert.match(attr(cellOf(big.xml, 'el-q'), 'style') as string, /^rounded=1;/, 'the element stays a plain box');
  fs.writeFileSync(path.join(icons, 'kafka.svg'), SVG);
  const next = project(puml('ContainerQueue(q, "Events", "Apache Kafka")'), { icons: makeIconResolver(icons, [root]) });
  assert.deepEqual(next.icons.used, [{ element: 'q', file: 'kafka.svg' }]);
  assert.equal(next.icons.skipped.length, 1);
});

test('an icons folder that resolves outside the checkout is refused, and so is a symlink out of it', () => {
  const root = scratch();
  const outside = scratch();
  fs.writeFileSync(path.join(outside, 'kafka.svg'), SVG);
  assert.throws(() => makeIconResolver(outside, [root]), (e: any) => e instanceof Refused && /outside the checkout/.test(e.message));
  // ..-hopping and a symlinked folder resolve to the same place.
  assert.throws(() => makeIconResolver(path.join(root, '..', path.basename(outside)), [root]), Refused);
  const link = path.join(root, 'linked');
  try { fs.symlinkSync(outside, link, 'dir'); } catch { return; } // no symlinks on this platform: the checks above stand
  assert.throws(() => makeIconResolver(link, [root]), Refused);
  const icons = path.join(root, 'icons');
  fs.mkdirSync(icons);
  fs.symlinkSync(path.join(outside, 'kafka.svg'), path.join(icons, 'kafka.svg'));
  const r = project(puml('ContainerQueue(q, "Events", "Kafka")'), { icons: makeIconResolver(icons, [root]) });
  assert.deepEqual(r.icons.used, []);
  assert.deepEqual(r.icons.skipped, [{ element: 'q', file: 'kafka.svg', why: 'outside the checkout' }]);
});

test('renderLevels refuses an outside icons folder before it writes anything', async () => {
  const root = scratch();
  const outside = scratch();
  const src = path.join(root, 'c4');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'context.puml'), puml('Person(u, "U")'));
  await assert.rejects(async () => renderLevels({ srcDir: src, outDir: path.join(root, 'out'), iconsDir: outside, roots: [root], base: root }), Refused);
  assert.equal(fs.existsSync(path.join(root, 'out')), false);
});

test('renderLevels skips a source with no C4 elements instead of writing an empty file', async () => {
  const root = scratch();
  const src = path.join(root, 'c4');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'flow-x.puml'), '@startuml\nA -> B: hi\n@enduml\n');
  const out = path.join(root, 'out');
  const r = await renderLevels({ srcDir: src, outDir: out, iconsDir: path.join(root, 'icons'), roots: [root], base: root });
  assert.equal(r.levels[0].status, 'skipped');
  assert.equal(r.ok, true);
  assert.equal(fs.existsSync(out), false);
});

test('a label with control characters XML forbids still gives a well-formed attribute', () => {
  const { xml } = project(puml('Container(a, "A\u000bB\u0001C", "T\u0008", "d\u001fe")'));
  assert.ok(!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(xml), 'no forbidden control character in the file');
  assert.equal(attr(cellOf(xml, 'el-a'), 'value'), '&lt;b&gt;ABC&lt;/b&gt;&lt;br&gt;[T]&lt;br&gt;de');
});

test('a boundary alias reused by a member is refused instead of looping', () => {
  assert.throws(() => project(puml('System_Boundary(a, "Outer") {\nContainer(a, "Inner")\n}\nRel(a, a, "x")'), { sourcePath: 'x.puml' }),
    (e: any) => e instanceof Refused && /x\.puml:4: alias 'a' is already defined/.test(e.message));
});

test('an svg icon wins over a png of the same name', () => {
  const root = scratch();
  const icons = path.join(root, 'icons');
  fs.mkdirSync(icons);
  fs.writeFileSync(path.join(icons, 'kafka.png'), PNG);
  fs.writeFileSync(path.join(icons, 'kafka.svg'), SVG);
  const r = project(puml('ContainerQueue(q, "Events", "Kafka")'), { icons: makeIconResolver(icons, [root]) });
  assert.deepEqual(r.icons.used, [{ element: 'q', file: 'kafka.svg' }]);
});

test('an icon name that is a folder is skipped as not a file', () => {
  const root = scratch();
  const icons = path.join(root, 'icons');
  fs.mkdirSync(path.join(icons, 'kafka.svg'), { recursive: true });
  const r = project(puml('ContainerQueue(q, "Events", "Kafka")'), { icons: makeIconResolver(icons, [root]) });
  assert.deepEqual(r.icons.skipped, [{ element: 'q', file: 'kafka.svg', why: 'not a file' }]);
  assert.deepEqual(r.icons.used, []);
});

// Output paths: a link planted in design/presentation must not carry a write out of the checkout.
function outputFixture() {
  const root = scratch();
  const outside = scratch();
  const victim = path.join(outside, 'victim.txt');
  fs.writeFileSync(victim, 'keep me');
  const src = path.join(root, 'c4');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'context.puml'), puml('Person(u, "U")'));
  const out = path.join(root, 'presentation');
  const render = () => renderLevels({ srcDir: src, outDir: out, iconsDir: path.join(root, 'icons'), roots: [root], base: root, timeoutSec: 5 });
  return { root, outside, victim, out, render };
}
const linkOrSkip = (target: string, at: string): boolean => { try { fs.symlinkSync(target, at); return true; } catch { return false; } };

for (const [name, file] of [['sidecar', 'context.drawio.sha'], ['.drawio', 'context.drawio'], ['exported svg', 'context.drawio.svg']]) {
  test(`a symlinked ${name} is refused, naming it, and the file it points at is not written`, async () => {
    const f = outputFixture();
    fs.mkdirSync(f.out);
    if (!linkOrSkip(f.victim, path.join(f.out, file))) return;
    const r = await f.render();
    assert.equal(r.ok, false);
    assert.equal(r.levels[0].status, 'refused-symlink');
    assert.ok(r.levels[0].message.includes(file), r.levels[0].message);
    assert.equal(fs.readFileSync(f.victim, 'utf8'), 'keep me');
    assert.deepEqual(fs.readdirSync(f.out), [file], 'nothing else was written either');
  });
}

test('an output folder that is a symlink out of the checkout is refused and nothing lands outside', async () => {
  const f = outputFixture();
  const target = path.join(f.outside, 'dest');
  fs.mkdirSync(target);
  if (!linkOrSkip(target, f.out)) return;
  await assert.rejects(f.render(), (e: any) => e instanceof Refused && /outside the checkout/.test(e.message));
  assert.deepEqual(fs.readdirSync(target), []);
  // A folder that does not exist yet is judged by its nearest existing parent, which here is a link out.
  fs.rmSync(f.out);
  const parent = path.join(f.root, 'linked-parent');
  fs.symlinkSync(target, parent);
  const src = path.join(f.root, 'c4');
  await assert.rejects(async () => renderLevels({ srcDir: src, outDir: path.join(parent, 'deeper'), iconsDir: path.join(f.root, 'icons'), roots: [f.root], base: f.root }), Refused);
  assert.deepEqual(fs.readdirSync(target), []);
});

/** The x and y of one cell's geometry. */
const placeOf = (xml: string, id: string) => {
  const m = new RegExp(`<mxCell id="${id}"[^>]*>\\n\\s+<mxGeometry x="(-?\\d+)" y="(-?\\d+)"`).exec(xml);
  if (!m) throw new assert.AssertionError({ message: `no geometry for ${id}` });
  return { x: Number(m[1]), y: Number(m[2]) };
};

test('siblings joined by relations sit in one column per rank, each relation running to a later column', () => {
  const { xml } = project(puml([
    'Container(api, "API")',
    'ContainerDb(db, "DB")',
    'Container(bus, "Bus")',
    'Container(cache, "Cache")',
    'Container(worker, "Worker")',
    'Rel(api, db, "writes")',
    'Rel(api, bus, "publishes")',
    'Rel(api, cache, "reads")',
    'Rel(bus, worker, "feeds")',
  ].join('\n')));
  const at = Object.fromEntries(['api', 'db', 'bus', 'cache', 'worker'].map((a) => [a, placeOf(xml, `el-${a}`)]));
  assert.ok(at.db.x === at.bus.x && at.bus.x === at.cache.x, 'the three targets of api share a column');
  assert.ok(at.api.x + 200 < at.db.x, 'that column is to the right of api, with room for a label');
  assert.ok(at.worker.x > at.bus.x + 200, 'a second hop is one column further');
  assert.ok(at.db.y < at.bus.y && at.bus.y < at.cache.y, 'a column keeps source order, top to bottom');
  // Left to right: out by the right side, in by the left.
  assert.match(attr(cellOf(xml, 'rel-3-api-cache'), 'style') as string, /exitX=1;exitY=0\.5;entryX=0;entryY=0\.5;$/);
  assert.match(attr(cellOf(xml, 'rel-1-api-db'), 'style') as string, /labelBackgroundColor=default;/);
});

test('a relation against the column order leaves by the left, lower than one running with it; one to a container holding its source is not pinned', () => {
  const { xml } = project(puml([
    'System_Boundary(sys, "Sys") {',
    '  Container(a, "A")',
    '  Container(b, "B")',
    '}',
    'Rel(a, b, "calls")',
    'Rel(b, a, "answers")',
    'Rel(a, sys, "reports")',
  ].join('\n')));
  assert.ok(placeOf(xml, 'el-a').x < placeOf(xml, 'el-b').x);
  assert.match(attr(cellOf(xml, 'rel-2-b-a'), 'style') as string, /exitX=0;exitY=0\.75;entryX=1;entryY=0\.75;$/);
  assert.match(attr(cellOf(xml, 'rel-1-a-b'), 'style') as string, /exitX=1;exitY=0\.5;entryX=0;entryY=0\.5;$/);
  assert.doesNotMatch(attr(cellOf(xml, 'rel-3-a-sys'), 'style') as string, /exitX/);
});

test('relations that form a cycle still place every sibling once, each at its own spot', () => {
  const { xml } = project(puml([
    'Container(a, "A")', 'Container(b, "B")', 'Container(c, "C")',
    'Rel(a, b, "1")', 'Rel(b, c, "2")', 'Rel(c, a, "3")',
  ].join('\n')));
  const spots = ['a', 'b', 'c'].map((id) => { const p = placeOf(xml, `el-${id}`); return `${p.x},${p.y}`; });
  assert.equal(new Set(spots).size, 3, spots.join(' '));
});

test('more siblings in one rank than a column holds wrap into a further column', () => {
  const targets = ['t1', 't2', 't3', 't4', 't5'];
  const { xml } = project(puml(['Container(s, "S")', ...targets.map((t) => `Container(${t}, "${t}")`), ...targets.map((t) => `Rel(s, ${t}, "to")`)].join('\n')));
  assert.equal(placeOf(xml, 'el-t1').x, placeOf(xml, 'el-t4').x);
  assert.ok(placeOf(xml, 'el-t5').x > placeOf(xml, 'el-t4').x);
});

/** The route points of one relation, and every shape's rectangle, in the coordinates of the relation's parent. */
const pointsOf = (xml: string, id: string) => {
  const m = new RegExp(`<mxCell id="${id}"[^>]*>\\n\\s+<mxGeometry relative="1" as="geometry">(.*?)</mxGeometry>`).exec(xml);
  return m ? [...m[1].matchAll(/<mxPoint x="(-?[\d.]+)" y="(-?[\d.]+)"\/>/g)].map((p) => ({ x: Number(p[1]), y: Number(p[2]) })) : [];
};
const rectOf = (xml: string, id: string) => {
  const m = new RegExp(`<mxCell id="${id}"[^>]*>\\n\\s+<mxGeometry x="(-?\\d+)" y="(-?\\d+)" width="(\\d+)" height="(\\d+)"`).exec(xml);
  if (!m) throw new assert.AssertionError({ message: `no geometry for ${id}` });
  return { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
};
/** Whether the straight run between two points passes through the inside of a rectangle. Runs are level or upright. */
const runHits = (a: any, b: any, r: any) => Math.max(a.x, b.x) > r.x && Math.min(a.x, b.x) < r.x + r.w && Math.max(a.y, b.y) > r.y && Math.min(a.y, b.y) < r.y + r.h;
/** Every run of a routed relation, from the side it leaves to the side it enters, as its pinned style says. */
const runsOf = (xml: string, id: string, from: string, to: string) => {
  const style = attr(cellOf(xml, id), 'style') as string;
  const pin = (name: string) => Number(new RegExp(`${name}=([\\d.]+);`).exec(style)?.[1]);
  const f = rectOf(xml, `el-${from}`); const t = rectOf(xml, `el-${to}`);
  const path = [{ x: f.x + f.w * pin('exitX'), y: f.y + f.h * pin('exitY') }, ...pointsOf(xml, id), { x: t.x + t.w * pin('entryX'), y: t.y + t.h * pin('entryY') }];
  return path.slice(1).map((p, k) => [path[k], p]);
};
const MIXED = [
  'Person(pp, "User")', 'Container(a, "A")', 'Container(x, "X")', 'Container(y, "Y")', 'Container(b, "B")', 'Container(c, "C")',
  'Rel(pp, a, "1")', 'Rel(a, b, "2")', 'Rel(x, b, "3")', 'Rel(y, b, "4")', 'Rel(b, c, "5")', 'Rel(pp, c, "6")', 'Rel(c, pp, "7")', 'Rel(a, c, "8")',
];

test('a relation that passes over a column has its whole path given, level or upright, through no shape', () => {
  const cases: Array<[string[], string[], Array<[string, string, string]>]> = [
    [['Container(a, "A")', 'Container(b, "B")', 'Container(c, "C")', 'Rel(a, b, "1")', 'Rel(b, c, "2")', 'Rel(a, c, "skips b")', 'Rel(c, a, "back over b")'],
      ['a', 'b', 'c'], [['rel-3-a-c', 'a', 'c'], ['rel-4-c-a', 'c', 'a']]],
    // A person is narrower than its column, with shapes stacked under it: the upright part must not run down through them.
    [MIXED, ['pp', 'a', 'x', 'y', 'b', 'c'], [['rel-3-x-b', 'x', 'b'], ['rel-4-y-b', 'y', 'b'], ['rel-6-pp-c', 'pp', 'c'], ['rel-7-c-pp', 'c', 'pp'], ['rel-8-a-c', 'a', 'c']]],
  ];
  for (const [body, shapes, routed] of cases) {
    const { xml } = project(puml(body.join('\n')));
    for (const [id, from, to] of routed) {
      assert.match(attr(cellOf(xml, id), 'style') as string, /^edgeStyle=none;rounded=0;/, `${id} is not left to a router`);
      const runs = runsOf(xml, id, from, to);
      assert.ok(runs.length >= 3, `${id} has corners`);
      for (const [p, q] of runs) {
        assert.ok(p.x === q.x || p.y === q.y, `${id}: the run ${JSON.stringify([p, q])} is level or upright`);
        for (const shape of shapes) assert.ok(!runHits(p, q, rectOf(xml, `el-${shape}`)), `${id} runs through ${shape}: ${JSON.stringify([p, q])}`);
      }
    }
  }
});

test('two routed relations do not share an upright line or a slot; a neighbouring relation is left to the router', () => {
  const { xml } = project(puml(MIXED.join('\n')));
  const uprights = ['rel-3-x-b', 'rel-4-y-b', 'rel-6-pp-c', 'rel-7-c-pp', 'rel-8-a-c'].flatMap((id) => [...new Set(pointsOf(xml, id).map((p) => p.x))].map((x) => `${x}`));
  assert.equal(new Set(uprights).size, uprights.length, uprights.join(' '));
  assert.deepEqual(pointsOf(xml, 'rel-1-pp-a'), []);
  assert.match(attr(cellOf(xml, 'rel-1-pp-a'), 'style') as string, /^edgeStyle=orthogonalEdgeStyle;.*exitX=1;exitY=0\.5;entryX=0;entryY=0\.5;$/);
});

test('past the slot budget a relation over a column is neither routed nor pinned', () => {
  const n = 70;
  const { xml } = project(puml([
    ...Array.from({ length: n }, (_, i) => `Container(e${i}, "E${i}")`),
    ...Array.from({ length: n - 1 }, (_, i) => `Rel(e${i}, e${i + 1}, "next")`),
    ...Array.from({ length: n - 2 }, (_, i) => `Rel(e0, e${i + 2}, "far")`),
  ].join('\n')));
  const last = cellOf(xml, `rel-${(n - 1) + (n - 2)}-e0-e${n - 1}`);
  assert.doesNotMatch(attr(last, 'style') as string, /exitX|entryX/);
  assert.match(attr(cellOf(xml, `rel-${n}-e0-e2`), 'style') as string, /^edgeStyle=none;/, 'the first far relation is still routed');
});

test('siblings no relation touches stay out of the columns, in a grid below them', () => {
  const { xml } = project(puml([
    'Container(a, "A")', ...['x1', 'x2', 'x3', 'x4'].map((x) => `Container(${x}, "${x}")`), 'Container(b, "B")',
    'Rel(a, b, "calls")',
  ].join('\n')));
  const a = rectOf(xml, 'el-a'); const b = rectOf(xml, 'el-b');
  assert.equal(a.y, b.y);
  for (const x of ['x1', 'x2', 'x3', 'x4']) assert.ok(rectOf(xml, `el-${x}`).y >= a.y + a.h, `${x} is below the related pair`);
});

test('a relation that leaves its container is not pinned', () => {
  const { xml } = project(puml([
    'System_Boundary(s1, "S1") {', '  Container(a, "A")', '  Container(b, "B")', '}',
    'System_Boundary(s2, "S2") {', '  Container(c, "C")', '}',
    'Rel(a, c, "calls")',
  ].join('\n')));
  assert.doesNotMatch(attr(cellOf(xml, 'rel-1-a-c'), 'style') as string, /exitX|entryX/);
  assert.ok(rectOf(xml, 'bd-s1').x + rectOf(xml, 'bd-s1').w < rectOf(xml, 'bd-s2').x, 'the containers themselves are ranked');
});

test('a chain longer than the call stack is deep is laid out, and the same source gives the same bytes', () => {
  const n = 9000;
  const body = [...Array.from({ length: n }, (_, i) => `Container(n${i}, "N${i}")`), ...Array.from({ length: n - 1 }, (_, i) => `Rel(n${i}, n${i + 1}, "next")`)].join('\n');
  const first = project(puml(body)).xml;
  assert.ok(rectOf(first, `el-n${n - 1}`).x > rectOf(first, `el-n${n - 2}`).x);
  const ranked = puml(['Container(a, "A")', 'Container(b, "B")', 'Container(c, "C")', 'Container(d, "D")', 'Rel(a, b, "1")', 'Rel(b, c, "2")', 'Rel(a, c, "3")', 'Rel(c, a, "4")'].join('\n'));
  assert.equal(project(ranked).xml, project(ranked).xml);
});
