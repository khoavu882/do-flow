'use strict';
// page-project.ts turns a feature's markdown documents into one HTML page, and render-page.sh is the
// verb that reaches it. The page is opened in a browser, so what these tests hold hardest is that a
// document's text can only ever arrive as text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { bashPath } = require('../helper/bash-locator.ts');
const { suiteTempDir } = require('../helper/tmp.ts');
const { buildPage, documentHtml, inline, stripComments, splitRow, MERMAID_SCRIPT, MERMAID_INTEGRITY } = require('../../src/runtime/page-project.ts');

const SCRIPT = path.join(__dirname, '..', '..', 'core', 'shared', 'scripts', 'doflow', 'bash', 'render-page.sh');
const NO_JQ = spawnSync('jq', ['--version'], { encoding: 'utf8' }).status !== 0 && 'jq is not on PATH';

const ctx = (extra: any = {}) => ({
  key: 'design', label: 'Design', mode: 'source', dir: '/r/f/design', outDir: '/r/f',
  docs: new Map([['/r/f/design/design.md', 'design'], ['/r/f/design/data-model.md', 'data_model'], ['/r/f/plan.md', 'plan']]),
  diagrams: { mode: 'source', blocks: 0, rendered: 0, failures: 0 }, ...extra,
});
const html = (text: string, extra: any = {}) => documentHtml(text, ctx(extra)).html;

test('document text reaches the page escaped: no element or script from a document', () => {
  const out = html('# T <script>alert(1)</script>\n\nA <img src=x onerror=alert(1)> and `<b>code</b>`.\n\n| a |\n|---|\n| <iframe> |\n');
  assert.ok(!/<script|<img|<iframe|<b>/.test(out), out);
  assert.match(out, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(out, /<code>&lt;b&gt;code&lt;\/b&gt;<\/code>/);
});

test('a link keeps a web address, points a document link at its section and refuses any other scheme', () => {
  const c = ctx();
  assert.equal(inline('[a](https://example.test/x?a=1&b=2)', c), '<a href="https://example.test/x?a=1&amp;b=2">a</a>');
  assert.equal(inline('[a](javascript:alert(1))', c), 'a)');
  assert.equal(inline('[a](data:text/html,x)', c), 'a');
  assert.equal(inline('[a](//example.test/x)', c), 'a');
  assert.equal(inline('[a](./data-model.md#3-lifecycles)', c), '<a href="#data-model-3-lifecycles">a</a>');
  assert.equal(inline('[a](data-model.md)', c), '<a href="#doc-data-model">a</a>');
  assert.equal(inline('[a](#2-system-overview-c4)', c), '<a href="#design-2-system-overview-c4">a</a>');
  // A relative link is read from the document's folder and written from the page's.
  assert.equal(inline('[a](../exec/A.1-brief.md#x)', c), '<a href="exec/A.1-brief.md#x">a</a>');
  assert.equal(inline('[a](../plan.md)', c), '<a href="#doc-plan">a</a>');
  // Same file name in another feature is another file, not this page's plan.
  assert.equal(inline('[a](../../other/plan.md)', c), '<a href="../other/plan.md">a</a>');
  // Browsers drop a leading control character before reading the scheme.
  assert.equal(inline('[a](\x01javascript:alert%281%29)', c), 'a');
  assert.equal(inline('[a](\x1fjavascript:x)', c), 'a');
  assert.equal(inline('[a](\\\\host\\share)', c), 'a');
  assert.equal(inline('[a](https://example.test/?q=&lt;b&gt;)', c), '<a href="https://example.test/?q=&amp;lt;b&amp;gt;">a</a>');
  assert.equal(inline('[a](x" onclick="y)', c), '[a](x&quot; onclick=&quot;y)');
});

test('inline marks: bold, italic, strike, code and the line break the templates use in a cell', () => {
  const c = ctx();
  assert.equal(inline('**Bold:** and *it* and ~~old~~', c), '<strong>Bold:</strong> and <em>it</em> and <del>old</del>');
  assert.equal(inline('a `x * y` b * c', c), 'a <code>x * y</code> b * c');
  assert.equal(inline('one<br/>two<br>three', c), 'one<br>two<br>three');
  assert.equal(inline('snake_case_name and 2 * 3 * 4', c), 'snake_case_name and 2 * 3 * 4');
  assert.equal(inline('**the `close` verb** ends it', c), '<strong>the <code>close</code> verb</strong> ends it');
  assert.equal(inline('**0** means none, **1** means some', c), '<strong>0</strong> means none, <strong>1</strong> means some');
  // No later pattern rewrites what is inside a tag.
  assert.equal(inline('[a](https://example.test/~~y) ~~b~~', c), '<a href="https://example.test/~~y">a</a> <del>b</del>');
});

test('an HTML comment is dropped, a comment inside a fenced block is kept', () => {
  const text = 'a\n<!-- one\n     two -->\nb <!-- c --> d\n```html\n<!-- kept -->\n```\n';
  assert.equal(stripComments(text), 'a\nb  d\n```html\n<!-- kept -->\n```\n');
  assert.match(html(text), /&lt;!-- kept --&gt;/);
  // A marker inside a code span is text, closed or not.
  const spans = '| a |\n|---|\n| `<!-- BEGIN -->` |\n| `<!--` |\n| last |\n';
  assert.equal(stripComments(spans), spans);
  assert.match(html(spans), /<td><code>&lt;!--<\/code><\/td><\/tr>\n<tr><td>last<\/td>/);
});

test('a table row splits on a pipe, but not inside a code span or after a backslash', () => {
  assert.deepEqual(splitRow('| a | `x | y` | b \\| c |'), ['a', '`x | y`', 'b | c']);
  const out = html('| ID | Rule |\n|---|:--|\n| R1 | `a|b` |\n| R2 |\n\nafter\n');
  assert.match(out, /<th>ID<\/th><th>Rule<\/th>/);
  assert.match(out, /<td id="d-R1">R1<\/td><td><code>a\|b<\/code><\/td>/);
  // A short row is padded to the header's width.
  assert.match(out, /<td id="d-R2">R2<\/td><td><\/td>/);
  assert.match(out, /<p>after<\/p>/);
});

test('lists nest by indent, keep a task box, and a one-paragraph item is not wrapped in a paragraph', () => {
  const out = html('- [x] A.1 done\n- [ ] A.2 open\n  - child one\n    continued\n  - child two\n\n1. first\n2. second\n');
  assert.match(out, /<li class="task"><input type="checkbox" disabled checked> A\.1 done<\/li>/);
  assert.match(out, /<li class="task"><input type="checkbox" disabled> A\.2 open\n<ul>\n<li>child one\ncontinued<\/li>\n<li>child two<\/li>\n<\/ul><\/li>/);
  assert.match(out, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
  assert.match(html('3. third\n4. fourth\n'), /<ol start="3">/);
});

test('headings get an id per document, a repeated heading a numbered one, and level 2 feeds the contents', () => {
  const { html: out, sections } = documentHtml('# Design: X\n\n## 1. Approach\n\n### Detail\n\n## 2. `Data` Model\n\n### Detail\n', ctx());
  assert.match(out, /<h1 id="design-design-x">/);
  assert.match(out, /<h3 id="design-detail">Detail<\/h3>/);
  assert.match(out, /<h3 id="design-detail-1">Detail<\/h3>/);
  assert.deepEqual(sections, [{ id: 'design-1-approach', text: '1. Approach' }, { id: 'design-2-data-model', text: '2. Data Model' }]);
});

test('a blockquote, a rule, a plain fenced block and a hard line break', () => {
  const out = html('> **Note.** quoted\n> more\n\n---\n\n```bash\necho "<x>"\n```\n\n**A:** one  \n**B:** two\n');
  assert.match(out, /<blockquote>\n<p><strong>Note\.<\/strong> quoted\nmore<\/p>\n<\/blockquote>/);
  assert.match(out, /<hr>/);
  assert.match(out, /<pre><code>echo &quot;&lt;x&gt;&quot;<\/code><\/pre>/);
  // An info string with more than a word still opens a block, and the text after it stays prose.
  assert.match(html('```ts title="x.ts"\nlet a;\n```\n\nprose\n```c++\nint b;\n```\n'),
    /<pre><code>let a;<\/code><\/pre>\n<p>prose<\/p>\n<pre><code>int b;<\/code><\/pre>/);
  // A line with a pipe above a rule is a paragraph and a rule, not an empty table.
  assert.match(html('a | b\n---\n'), /<p>a \| b<\/p>\n<hr>/);
  assert.match(out, /<p><strong>A:<\/strong> one<br>\n<strong>B:<\/strong> two<\/p>/);
});

function feature(files: Record<string, string>) {
  const root = suiteTempDir('doflow-page-');
  const dir = 'agent-docs/doflow/001-x';
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, dir, rel), body);
  }
  const paths = {
    feature_slug: '001-x', feature_dir: dir,
    requirement: `${dir}/intention/requirement.md`, design: `${dir}/design/design.md`, specs: `${dir}/design/specs.md`,
    data_model: `${dir}/design/data-model.md`, plan: `${dir}/plan.md`, decisions: `${dir}/decisions.md`,
    state: `${dir}/state.md`, audit: `${dir}/audit.md`,
  };
  return { root, dir, paths };
}

const DIAGRAM = '```mermaid\nflowchart LR\n    A["<b>x</b>"] -->|"sends"| B\n```\n';
const NOW = new Date('2026-11-14T10:20:30Z');

test('buildPage writes the documents that exist, in chain order, and reports them', () => {
  const { root, dir, paths } = feature({
    'plan.md': '# Plan\n\n## 8. Tasks\n\n- [ ] A.1 task\n',
    'intention/requirement.md': `# Requirement\n\n## 1. Summary\n\n${DIAGRAM}`,
    'design/design.md': `# Design\n\nSee [the plan](../plan.md).\n\n${DIAGRAM}\n${DIAGRAM}`,
  });
  const result = buildPage({ paths, root, mode: 'source', now: NOW });
  assert.equal(result.ok, true);
  assert.equal(result.file, path.join(root, dir, 'page.html'));
  assert.deepEqual(result.documents.map((d: any) => [d.key, d.diagrams]), [['requirement', 1], ['design', 2], ['plan', 0]]);
  assert.deepEqual(result.diagrams, { mode: 'source', blocks: 3, rendered: 0, failures: 0 });
  const page = fs.readFileSync(result.file, 'utf8');
  assert.ok(page.indexOf('id="doc-requirement"') < page.indexOf('id="doc-design"'));
  assert.ok(page.indexOf('id="doc-design"') < page.indexOf('id="doc-plan"'));
  assert.match(page, /<a href="#doc-plan">the plan<\/a>/);
  assert.match(page, /<li class="nav-sec" data-section="requirement-1-summary"><a href="#requirement-1-summary" data-section-link="requirement-1-summary" data-view="requirement"><span class="num">1\.<\/span> Summary<\/a><\/li>/);
  assert.match(page, /<footer class="foot">Generated 2026-11-14 10:20 UTC from <code>agent-docs\/doflow\/001-x<\/code><\/footer>/);
  assert.match(page, /A\[&quot;&lt;b&gt;x&lt;\/b&gt;&quot;\]/);
  // A source page loads nothing: its only script is its own, inline.
  assert.ok(!/<script[^>]*\ssrc=/.test(page));
  assert.deepEqual(fs.readdirSync(path.join(root, dir)).filter((f: string) => f.endsWith('.tmp')), []);
});

test('buildPage in cdn mode loads the pinned Mermaid build, and only when the page has a diagram', () => {
  const withDiagram = feature({ 'design/design.md': `# Design\n\n${DIAGRAM}` });
  const page = fs.readFileSync(buildPage({ paths: withDiagram.paths, root: withDiagram.root, mode: 'cdn', now: NOW }).file, 'utf8');
  assert.match(page, /<pre class="mermaid">flowchart LR/);
  assert.equal((page.match(/<script[^>]*\ssrc=/g) || []).length, 1);
  assert.ok(page.includes(`<script src="${MERMAID_SCRIPT}" integrity="${MERMAID_INTEGRITY}" crossorigin="anonymous"></script>`));
  assert.match(page, /"securityLevel":"strict"/);
  // One pinned file with its hash, at or past the release that closed GHSA-8gwm-58g9-j8pw (11.10.0).
  const pinned = /^https:\/\/cdn\.jsdelivr\.net\/npm\/mermaid@(\d+)\.(\d+)\.\d+\/dist\/mermaid\.min\.js$/.exec(MERMAID_SCRIPT);
  assert.ok(pinned, MERMAID_SCRIPT);
  const [major, minor] = [Number(pinned?.[1]), Number(pinned?.[2])];
  assert.ok(major > 11 || (major === 11 && minor >= 10), MERMAID_SCRIPT);
  assert.match(MERMAID_INTEGRITY, /^sha384-[A-Za-z0-9+/]{64}$/);

  const without = feature({ 'plan.md': '# Plan\n' });
  const plain = fs.readFileSync(buildPage({ paths: without.paths, root: without.root, mode: 'cdn', now: NOW }).file, 'utf8');
  assert.ok(!/<script[^>]*\ssrc=/.test(plain) && !plain.includes('mermaid.initialize'));
});

test('buildPage in inline mode embeds each rendered diagram, and a block the renderer fails on stays as source', () => {
  const { root, paths } = feature({ 'design/design.md': `# Design\n\n${DIAGRAM}\n${DIAGRAM}` });
  let calls = 0;
  const render = (source: string) => (++calls === 1 ? `<svg xmlns="http://www.w3.org/2000/svg"><!-- ${source.length} --></svg>` : null);
  const result = buildPage({ paths, root, mode: 'inline', render, now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagrams, { mode: 'inline', blocks: 2, rendered: 1, failures: 1 });
  const page = fs.readFileSync(result.file, 'utf8');
  assert.match(page, /<img alt="Design diagram 1" src="data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+">/);
  assert.match(page, /Diagram source, not rendered/);
});

test('buildPage without the renderer shows source and says how to get diagrams, for auto and for inline alike', () => {
  const { root, paths } = feature({ 'design/design.md': `# Design\n\n${DIAGRAM}` });
  for (const mode of ['auto', 'inline']) {
    const result = buildPage({ paths, root, mode, probe: () => false, now: NOW });
    assert.equal(result.ok, true, mode);
    assert.deepEqual(result.diagrams, { mode: 'source', blocks: 1, rendered: 0, failures: 0 }, mode);
    assert.match(result.note, /renderer was not found.*--diagrams=cdn/, mode);
  }
  const themed = buildPage({ paths, root, mode: 'cdn', theme: path.join(root, 'no-theme.json'), now: NOW });
  assert.match(themed.note, /diagram theme was not found/);
});

test('buildPage writes nothing for a feature with no document, honours --out, and refuses a bad argument', () => {
  const empty = feature({});
  assert.deepEqual(buildPage({ paths: empty.paths, root: empty.root, mode: 'source' }),
    { ok: true, written: false, note: 'no chain document found for this feature', documents: [] });
  const { root, paths } = feature({ 'plan.md': '# Plan\n' });
  const out = path.join(root, 'out', 'nested', 'p.html');
  assert.equal(buildPage({ paths, root, out, mode: 'source' }).file, out);
  assert.ok(fs.existsSync(out));
  assert.throws(() => buildPage({ paths, root, mode: 'png' }), TypeError);
  assert.throws(() => buildPage({ paths: null, root }), TypeError);
  // A target that cannot be replaced leaves no temporary file behind.
  const dirTarget = path.join(root, 'out', 'nested');
  assert.throws(() => buildPage({ paths, root, out: dirTarget, mode: 'source' }));
  assert.deepEqual(fs.readdirSync(path.join(root, 'out')).filter((f: string) => f.includes('.tmp')), []);
});

function repo() {
  const root = suiteTempDir('doflow-render-page-');
  const git = (...args: any[]) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('commit', '-q', '--allow-empty', '-m', 'init');
  git('checkout', '-q', '-b', 'feat/001-x');
  const dir = path.join(root, 'agent-docs', 'doflow', '001-x');
  fs.mkdirSync(path.join(dir, 'intention'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'design'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'intention', 'requirement.md'), '# Requirement\n');
  fs.writeFileSync(path.join(dir, 'design', 'design.md'), `# Design\n\n${DIAGRAM}`);
  // The verb looks for the projector in the repository it runs in before the installed runtime.
  fs.mkdirSync(path.join(root, 'src', 'runtime'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '..', '..', 'src', 'runtime', 'page-project.ts'), path.join(root, 'src', 'runtime', 'page-project.ts'));
  fs.copyFileSync(path.join(__dirname, '..', '..', 'src', 'runtime', 'mask.ts'), path.join(root, 'src', 'runtime', 'mask.ts'));
  return { root, dir };
}

/** A directory holding an `mmdc` that writes a fixed SVG to its `-o` argument, put ahead of PATH. */
function stubMmdcDir() {
  const dir = suiteTempDir('doflow-render-page-mmdc-');
  const stub = path.join(dir, 'mmdc');
  fs.writeFileSync(stub, '#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = "-o" ] && out="$2"; shift; done\n[ -n "${out:-}" ] && printf \'<svg xmlns="http://www.w3.org/2000/svg"></svg>\' > "$out"\nexit 0\n');
  fs.chmodSync(stub, 0o755);
  return dir;
}

const run = (root: any, args: string[], extraPath: string | null = null) => spawnSync(bashPath(), [SCRIPT, ...args], {
  cwd: root, encoding: 'utf8',
  env: { ...process.env, ...(extraPath ? { PATH: `${extraPath}${path.delimiter}${process.env.PATH}` } : {}) },
});

test('render-page writes the active feature\'s page and names it', { skip: NO_JQ }, () => {
  const { root, dir } = repo();
  const r = run(root, ['--diagrams=source', '--json']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const body = JSON.parse(r.stdout);
  assert.equal(body.written, true);
  assert.equal(fs.realpathSync(body.file), fs.realpathSync(path.join(dir, 'page.html')));
  assert.deepEqual(body.documents.map((d: any) => d.key), ['requirement', 'design']);
  const text = run(root, ['--diagrams=source']);
  assert.match(text.stdout, /^render-page: 2 document\(s\), 1 diagram\(s\) \(source\) written to /);
});

test('render-page embeds diagrams when the renderer is on PATH', { skip: NO_JQ || (process.platform === 'win32' && 'the stub renderer is a POSIX script') }, () => {
  const { root, dir } = repo();
  const r = run(root, ['--json'], stubMmdcDir());
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).diagrams, { mode: 'inline', blocks: 1, rendered: 1, failures: 0 });
  assert.match(fs.readFileSync(path.join(dir, 'page.html'), 'utf8'), /src="data:image\/svg\+xml;base64,/);
});

test('render-page refuses an unrecognized argument and a bad --diagrams value with exit 2', () => {
  const { root } = repo();
  const spaced = run(root, ['--slug', '001-x']);
  assert.equal(spaced.status, 2);
  assert.match(spaced.stderr, /unrecognized argument\(s\): --slug 001-x/);
  const mode = run(root, ['--diagrams=png']);
  assert.equal(mode.status, 2);
  assert.match(mode.stderr, /--diagrams must be auto, inline, cdn or source, got: png/);
});

// FU-wdq963: block conversion recurses once per quote or list level, so thousands of levels overflowed the stack.
// Past the depth limit the rest of the text is one escaped preformatted block, and the page still builds.
for (const [name, text] of [
  ['blockquote', `${'>'.repeat(5000)} deep <b>end</b>`],
  ['list', `${'- '.repeat(5000)}deep <b>end</b>`],
  ['indented list', `${Array.from({ length: 1000 }, (_v, k) => `${' '.repeat(k * 2)}- level ${k}`).join('\n')}\n`],
] as Array<[string, string]>) {
  test(`${name} nested thousands of levels deep still converts, the remainder as escaped text`, () => {
    const out = html(`# T\n\n${text}\n\nAfter.\n`);
    assert.match(out, /<pre><code>/);
    assert.match(out, /<p>After\.<\/p>/);
    assert.ok(!/<b>/.test(out), 'the remainder is escaped, not markup');
    if (name !== 'indented list') assert.match(out, /deep &lt;b&gt;end&lt;\/b&gt;/);
  });
}

test('ordinary nesting is unchanged by the depth limit', () => {
  const out = html('> a\n> > b\n\n- x\n  - y\n    - z\n');
  assert.ok(!/<pre>/.test(out), out);
  assert.match(out, /<blockquote>\n<p>a<\/p>\n<blockquote>\n<p>b<\/p>\n<\/blockquote>\n<\/blockquote>/);
  assert.match(out, /<li>x\n<ul>\n<li>y\n<ul>\n<li>z<\/li>/);
});

test('an image in a document is embedded; one outside the checkout, of another type or missing is named and left out', () => {
  const root = suiteTempDir('doflow-page-image-');
  const outside = suiteTempDir('doflow-page-image-outside-');
  const dir = path.join(root, 'agent-docs', 'doflow', '001-x', 'design');
  fs.mkdirSync(path.join(dir, 'presentation'), { recursive: true });
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>';
  fs.writeFileSync(path.join(dir, 'presentation', 'overview.drawio.svg'), svg);
  fs.writeFileSync(path.join(outside, 'secret.svg'), svg);
  fs.symlinkSync(path.join(outside, 'secret.svg'), path.join(dir, 'presentation', 'link.svg'));
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(dir, 'design.md'), [
    '# d', '',
    '![Overview "a" <b>](presentation/overview.drawio.svg)', '',
    '![out](presentation/link.svg) ![up](../../../../../secret.svg) ![txt](notes.txt) ![gone](none.png)', '',
    '![web](https://example.test/a.png) ![js](javascript:alert(1))', '',
    '`![code](presentation/overview.drawio.svg)`', '',
  ].join('\n'));
  const result = buildPage({ paths: { feature_dir: 'agent-docs/doflow/001-x', design: 'agent-docs/doflow/001-x/design/design.md' }, root, mode: 'source' });
  assert.equal(result.written, true, JSON.stringify(result));
  assert.deepEqual(result.images, { embedded: 1, skipped: 5 });
  assert.match(result.note, /5 image\(s\) not shown/);
  const html = fs.readFileSync(result.file, 'utf8');
  const data = Buffer.from(svg).toString('base64');
  assert.ok(html.includes(`<img class="image" alt="Overview &quot;a&quot; &lt;b&gt;" src="data:image/svg+xml;base64,${data}">`), 'embedded as a data URI with an escaped alt');
  assert.equal(html.split('data:image/svg+xml;base64,').length - 1, 1, 'only the one image inside the checkout is embedded');
  assert.ok(!html.includes('<script>alert(1)</script>'), 'the SVG text never enters the page as markup');
  assert.ok(html.includes('<a href="https://example.test/a.png">web</a>'), 'a web image becomes a link, not a request');
  assert.ok(!/src="https?:/.test(html.replace(/<script src="https:[^"]*mermaid[^"]*"/, '')), 'the page loads no remote image');
  assert.ok(!html.includes('href="javascript:'), 'a script address is never written as a link');
  assert.ok(html.includes('<code>![code](presentation/overview.drawio.svg)</code>'), 'an image inside a code span stays text');
});


// A fixture checkout with a design folder; `root` may be reached through a symlinked directory.
function imageFixture(prefix: string) {
  const root = suiteTempDir(prefix);
  const dir = path.join(root, 'design');
  fs.mkdirSync(dir, { recursive: true });
  return { root, dir };
}
const imageCtx = (root: string, dir: string, limits: any = {}) =>
  ctx({ root, dir, images: { embedded: 0, skipped: [] as string[], bytes: 0, cache: new Map(), maxImageBytes: 5 * 1024 * 1024, maxPageBytes: 20 * 1024 * 1024, ...limits } });

test('a link named like an image is read for what it points at: a non-image file in the checkout is refused, a real image link is embedded', () => {
  const { root, dir } = imageFixture('doflow-page-imglink-');
  fs.writeFileSync(path.join(root, '.env'), 'TOKEN=hunter2-secret');
  fs.mkdirSync(path.join(dir, 'p'));
  fs.symlinkSync('../../.env', path.join(dir, 'p', 'env.svg'));
  fs.writeFileSync(path.join(dir, 'real.svg'), '<svg/>');
  fs.symlinkSync('real.svg', path.join(dir, 'a.svg'));
  const c = imageCtx(root, dir);
  const out = inline('![e](p/env.svg) ![a](a.svg)', c);
  assert.ok(!out.includes(Buffer.from('TOKEN=hunter2-secret').toString('base64')), 'the file behind the link never enters the page');
  assert.equal(c.images.embedded, 1);
  assert.match(c.images.skipped[0], /env\.svg: not an image type/);
  assert.ok(out.includes(Buffer.from('<svg/>').toString('base64')), 'a link to a real image still embeds');
});

test('a folder with an image name, an oversize image and an unsafe path are each left out with their reason', () => {
  const { root, dir } = imageFixture('doflow-page-imgrefuse-');
  fs.mkdirSync(path.join(dir, 'd.svg'));
  fs.writeFileSync(path.join(dir, 'big.png'), Buffer.alloc(20));
  fs.writeFileSync(path.join(dir, 'a\\b.svg'), '<svg/>');
  fs.writeFileSync(path.join(dir, 'c\x01.svg'), '<svg/>');
  const c = imageCtx(root, dir, { maxImageBytes: 10 });
  const out = inline('![d](d.svg) ![b](big.png) ![s](a\\b.svg) ![c](c\x01.svg)', c);
  assert.ok(!out.includes('<img'), out);
  assert.deepEqual(c.images.skipped.map((s: string) => s.split(': ').pop()), ['not a file', 'larger than 0 MB', 'unsafe path', 'unsafe path']);
});

test('an image is found when the checkout root is reached through a symlinked folder', () => {
  const { root, dir } = imageFixture('doflow-page-imgroot-');
  fs.writeFileSync(path.join(dir, 'i.svg'), '<svg/>');
  const via = path.join(suiteTempDir('doflow-page-imgvia-'), 'checkout');
  fs.symlinkSync(root, via);
  const c = imageCtx(via, path.join(via, 'design'));
  assert.match(inline('![i](i.svg)', c), /<img class="image"/);
  assert.equal(c.images.embedded, 1);
});

test('a file name that starts with two dots is inside the checkout, not above it', () => {
  const { root, dir } = imageFixture('doflow-page-imgdots-');
  fs.writeFileSync(path.join(root, '..foo.svg'), '<svg/>');
  const c = imageCtx(root, root);
  assert.match(inline('![f](..foo.svg)', c), /<img class="image"/);
  const above = path.join(suiteTempDir('doflow-page-imgabove-'), 'x.svg');
  fs.writeFileSync(above, '<svg/>');
  assert.match(inline(`![u](${path.relative(dir, above)})`, imageCtx(root, dir)), /outside the checkout/);
  assert.equal(c.images.embedded, 1);
});

test('control characters in an image address never reach the note or the skipped list', () => {
  const { root } = imageFixture('doflow-page-imgctl-');
  fs.writeFileSync(path.join(root, 'design.md'), '# d\n\n![x](a\x1b]0;X\x07.svg) ![y](b\x9b31m.svg)\n');
  const result = buildPage({ paths: { design: 'design.md' }, root, mode: 'source' });
  assert.equal(result.images.skipped, 2);
  assert.ok(!/[\u0000-\u001f\u007f-\u009f]/.test(result.note), JSON.stringify(result.note));
  assert.match(result.note, /2 image\(s\) not shown/);
});

test('one image shown many times is read once; the page stops at its image budget instead of failing', () => {
  const { root, dir } = imageFixture('doflow-page-imgbudget-');
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.alloc(100, 1));
  const reads: string[] = [];
  const read = fs.readFileSync;
  fs.readFileSync = ((p: any, ...rest: any[]) => { if (String(p).endsWith('a.png')) reads.push(p); return read(p, ...rest); }) as any;
  try {
    const c = imageCtx(root, dir, { maxPageBytes: 250 });
    const out = inline('![1](a.png) ![2](a.png) ![3](a.png) ![4](a.png)', c);
    assert.equal(out.split('<img').length - 1, 2);
    assert.equal(c.images.embedded, 2);
    assert.equal(c.images.skipped.length, 2);
    assert.match(c.images.skipped[0], /a\.png: page image budget reached/);
    assert.equal(reads.length, 1, 'the file is read once, whatever the number of references');
  } finally { fs.readFileSync = read; }
});

test('a page with more image data than the page budget is still written, with the rest named as left out', () => {
  const { root } = imageFixture('doflow-page-imgwhole-');
  fs.writeFileSync(path.join(root, 'one.png'), Buffer.alloc(1024 * 1024, 7));
  fs.writeFileSync(path.join(root, 'design.md'), `# d\n\n${Array.from({ length: 30 }, (_v, i) => `![i${i}](one.png)`).join(' ')}\n`);
  const started = Date.now();
  const result = buildPage({ paths: { design: 'design.md' }, root, mode: 'source' });
  assert.equal(result.written, true);
  assert.deepEqual(result.images, { embedded: 20, skipped: 10 });
  assert.match(result.note, /10 image\(s\) not shown/);
  assert.ok(Date.now() - started < 2000);
});

test('an image alt keeps the text of a code span, and an address written as a code span is not an image', () => {
  const { root, dir } = imageFixture('doflow-page-imgalt-');
  fs.writeFileSync(path.join(dir, 'i.svg'), '<svg/>');
  const c = imageCtx(root, dir);
  const out = inline('![the `build` step](i.svg)', c);
  assert.match(out, /<img class="image" alt="the build step" src=/);
  assert.ok(!out.includes('\u0000'));
  const code = inline('![alt](`i.svg`) ![b](i.svg)', c);
  assert.ok(!code.includes('\u0000'));
  assert.equal(code.split('<img').length - 1, 1, 'only the plain address is an image');
  assert.ok(code.includes('![alt](<code>i.svg</code>)'), code);
});

// The old reader gave the same page after about a minute, so the time is what this test measures.
// (A node:test timeout cannot stop synchronous code; the elapsed time is asserted instead.)
test('a long run of blank lines inside a list item is read once, not once per blank line', () => {
  const started = Date.now();
  const page = html(['- first', ...Array(200000).fill(''), '  still the first item', '- second'].join('\n'));
  const elapsed = Date.now() - started;
  assert.match(page, /<li>[\s\S]*first[\s\S]*still the first item[\s\S]*<\/li>\s*<li>second<\/li>/);
  assert.ok(elapsed < 5000, `read in ${elapsed} ms`);
});

// Row 179: ids link to their definitions, status words are labels, History starts closed.
test('ids are defined by an id table row, an id-led heading, a bold id-led bullet and a numbered word heading', () => {
  const out = html([
    '# Doc', '',
    '| ID | Text |', '|---|---|', '| AB-1 | first |', '',
    '| Key | Text |', '|---|---|', '| G1 | one |', '| G2 | two |', '',
    '### CD-2: second', '',
    '- **EF-3:** third', '',
    '### Item 4: fourth', '',
    'Mentions AB-1, CD-2, EF-3, G1 and Item 4; not `AB-1` or [AB-1](https://example.test/a).', '',
    '- **AB-1:** detail of the first', '',
  ].join('\n'));
  assert.match(out, /<td id="d-AB-1"><a class="ref" href="#d-AB-1-2">AB-1<\/a><\/td>/, 'the primary row links down to the later definition');
  assert.match(out, /<td id="d-G1">G1<\/td>/, 'a first column of ids defines without an ID header');
  assert.match(out, /<h3 id="design-cd-2-second"><span id="d-CD-2"><\/span>CD-2: second<\/h3>/);
  assert.match(out, /<li id="d-EF-3"><strong>EF-3:<\/strong> third<\/li>/, 'the defining spot is not a link');
  assert.match(out, /<h3 id="design-item-4-fourth"><span id="d-Item_4"><\/span>Item 4: fourth<\/h3>/);
  assert.match(out, /<li id="d-AB-1-2"><strong>AB-1:<\/strong> detail/);
  for (const [id, anchor] of [['AB-1', 'd-AB-1'], ['CD-2', 'd-CD-2'], ['EF-3', 'd-EF-3'], ['G1', 'd-G1'], ['Item 4', 'd-Item_4']]) {
    assert.ok(out.includes(`<a class="ref" href="#${anchor}">${id}</a>`), id);
  }
  assert.ok(out.includes('not <code>AB-1</code> or <a href="https://example.test/a">AB-1</a>.'), 'no link inside code or a link');
});

test('a leading run of ids in a bold bullet or an id-led heading defines every id of the run', () => {
  const { root, paths } = feature({
    'design/design.md': '# D\n\n- **IC-060, IC-061:** Before, the path said one thing\n\n### CD-2 and CD-3 — a heading\n\nSee IC-061 and CD-3.\n',
  });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  const data = JSON.parse(/id="page-ids">([\s\S]*?)<\/script>/.exec(page)![1]);
  for (const [first, second, summary] of [['IC-060', 'IC-061', 'Before, the path said one thing'], ['CD-2', 'CD-3', 'a heading']]) {
    assert.equal(data[first]?.[0].summary, summary, first);
    assert.equal(data[second]?.[0].summary, summary, second);
    assert.ok(page.includes(`id="d-${first}"`) && page.includes(`id="d-${second}"`), `${first} and ${second} anchors`);
  }
  assert.ok(page.includes('<li id="d-IC-060">'), 'the first id keeps its anchor');
  assert.ok(page.includes('See <a class="ref" href="#d-IC-061">IC-061</a> and <a class="ref" href="#d-CD-3">CD-3</a>.'), 'a later id of the run is linked to');
});

test('a mention links to the definition in its own document, else to the first one on the page', () => {
  const { root, paths } = feature({
    'intention/requirement.md': '# R\n\n| ID | Text |\n|---|---|\n| AB-1 | first |\n',
    'design/design.md': '# D\n\n- **AB-1:** again\n\nSee AB-1.\n',
    'plan.md': '# P\n\nSee AB-1.\n',
  });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  const doc = (key: string) => page.slice(page.indexOf(`id="doc-${key}"`), page.indexOf('</section>', page.indexOf(`id="doc-${key}"`)));
  assert.ok(doc('design').includes('See <a class="ref" href="#d-AB-1">AB-1</a>.'), doc('design'));
  assert.ok(doc('plan').includes('See <a class="ref" href="#r-AB-1">AB-1</a>.'), doc('plan'));
});

test('an undefined id and an unhyphenated short id defined in two documents stay plain', () => {
  const { root, paths } = feature({
    'intention/requirement.md': '# R\n\n| ID | Text |\n|---|---|\n| K1 | one |\n| S1 | only here |\n',
    'design/design.md': '# D\n\n| ID | Text |\n|---|---|\n| K1 | another one |\n',
    'plan.md': '# P\n\nK1, S1 and ZZ-9 here.\n',
  });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  assert.ok(page.includes('<p>K1, <a class="ref" href="#r-S1">S1</a> and ZZ-9 here.</p>'), page);
});

test('a run of ids renders as one compact row and drops an empty item', () => {
  const out = html('| ID | Text |\n|---|---|\n| AB-1 | first |\n| AB-2 | second |\n\n| Covers |\n|---|\n| AB-1; . |\n| AB-2, ZZ-9 |\n');
  assert.ok(out.includes('<td><span class="ids"><a class="ref" href="#d-AB-1">AB-1</a></span></td>'), out);
  assert.ok(out.includes('<td><span class="ids"><a class="ref" href="#d-AB-2">AB-2</a> ZZ-9</span></td>'), out);
});

test('the page carries one JSON block mapping each id to its document, summary and status', () => {
  const long = 'word '.repeat(60).trim();
  const { root, paths } = feature({
    'intention/requirement.md': `# R\n\n| ID | Text | Status |\n|---|---|---|\n| AB-1 | first </script> <b>x</b> | Live |\n| AB-2 | ${long} | Draft |\n`,
    'design/design.md': '# D\n\n### CD-2: a heading\n',
  });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  const blocks = page.match(/<script type="application\/json" id="page-ids">([\s\S]*?)<\/script>/g) || [];
  assert.equal(blocks.length, 1);
  assert.ok(!blocks[0].slice(0, -9).includes('<', 10), 'every < inside the block is escaped');
  const data = JSON.parse(/id="page-ids">([\s\S]*?)<\/script>/.exec(page)![1]);
  assert.deepEqual(data['AB-1'], [{ doc: 'Requirement', anchor: 'r-AB-1', summary: 'first </script> <b>x</b>', status: 'Live' }]);
  assert.deepEqual(data['CD-2'], [{ doc: 'Design', anchor: 'd-CD-2', summary: 'a heading' }]);
  assert.ok(data['AB-2'][0].summary.length <= 140 && data['AB-2'][0].summary.endsWith('…'), data['AB-2'][0].summary);
});

test('a status word and the values of an enumerated column render as labels', () => {
  const out = html([
    '| Item | State | Kind | Note | Size |', '|---|---|---|---|---|',
    '| a | Live | alpha | a long note that runs well past twenty four characters | 3 |',
    '| b | Superseded → AB-9 | beta | short | 12 |',
    '| c | In review | alpha | short | 7 |', '',
  ].join('\n'));
  assert.ok(out.includes('<td><span class="tag tag--good">Live</span></td>'), out);
  assert.ok(out.includes('<td><span class="tag tag--quiet">Superseded → AB-9</span></td>'), out);
  assert.ok(out.includes('<td><span class="tag tag--info">In review</span></td>'), out);
  const alpha = out.match(/<span class="tag tag--(n\d)">alpha<\/span>/g) || [];
  assert.equal(alpha.length, 2);
  assert.equal(alpha[0], alpha[1], 'one value always takes the same tone');
  assert.match(out, /<span class="tag tag--n\d">beta<\/span>/);
  assert.ok(out.includes('<td>short</td>'), 'a column with a long value is not enumerated');
  assert.ok(out.includes('<td>12</td>'), 'a number column is not enumerated');
  assert.ok(out.includes('<td>a</td>'), 'the first column is never a set of labels');
  assert.match(out, /<div class="table-wrap" data-cols="5"><table>/);
});

test('a History section, up to the next heading of its level, starts closed', () => {
  const out = html('# D\n\n## 3. History\n\nfirst\n\n### Older\n\n```text\n## not a heading\n```\n\n## 4. Next\n\n### History\n\nlast\n');
  assert.match(out, /<details class="history"><summary><h2 id="design-3-history"><span class="num">3\.<\/span> History<\/h2><\/summary>\n<p>first<\/p>\n<h3 id="design-older">Older<\/h3>\n<pre><code>## not a heading<\/code><\/pre>\n<\/details>\n<h2 id="design-4-next"><span class="num">4\.<\/span> Next<\/h2>/);
  assert.match(out, /<details class="history"><summary><h3 id="design-history">History<\/h3><\/summary>\n<p>last<\/p>\n<\/details>$/);
});

test('buildPage collects per-document counts on a field the --json result does not carry', () => {
  const { root, paths } = feature({
    'intention/requirement.md': '# R\n\n## 1. One\n\nfour words of text\n\n| ID | Text |\n|---|---|\n| AB-1 | x |\n| AB-2 | y |\n\n## 2. Two\n\n### Item 1: z\n\n- **R1:** w\n',
    'design/design.md': `# D\n\n${DIAGRAM}`,
  });
  const result = buildPage({ paths, root, mode: 'source', now: NOW });
  assert.deepEqual(result.counts, [
    { key: 'requirement', label: 'Requirement', h2: 2, words: 20, tables: 1, diagrams: 0, ids: { AB: 2, Item: 1, R: 1 }, open: 0 },
    { key: 'design', label: 'Design', h2: 0, words: 1, tables: 0, diagrams: 1, ids: {}, open: 0 },
  ]);
  assert.ok(!('counts' in JSON.parse(JSON.stringify(result))), 'the --json result shape is unchanged');
});

// Row 179: the page opens on an overview of the feature; state.md is the overview, not a document view.
const STATE = [
  '# State: 001-x (Pay with a code)', '',
  '**Updated:** 2026-11-19 · **Stage:** design; FR-001 settled · **Next:** data-team meeting', '',
  'The design was rebuilt.', '',
  '## Status', '', '| Stage | State |', '|---|---|', '| Requirement | Baseline |', '',
  '## Open, for decision owners', '', '| Item | Owner |', '|---|---|',
  ...Array.from({ length: 9 }, (_v, k) => `| question ${k} | Product |`), '',
  '## Next steps', '', '1. Meet the data team.', '2. Design the next part.', '',
].join('\n');
const REQUIREMENT = [
  '# Feature Requirement: Pay with a <b>code</b>', '',
  '**Feature:** 001-x · **Maturity:** Draft  ', '**Created:** 2026-11-04 · **Owner:** Kai', '',
  '## 1. Summary', '', '| ID | Text |', '|---|---|', '| FR-001 | one |', '| FR-002 | two |', '| NFR-001 | fast |', '',
  '## 7. Open Questions', '', '- first open question', '- second open question', '',
].join('\n');
const between = (page: string, from: string, to: string) => page.slice(page.indexOf(from), page.indexOf(to, page.indexOf(from)));

test('the overview is the first view of main: name from an H1, state facts, Next and Open cards, one card per document', () => {
  const { root, paths } = feature({
    'state.md': STATE, 'intention/requirement.md': REQUIREMENT,
    'design/design.md': '# Design: Pay with a code\n\n**Maturity:** In review\n\n## 1. Approach\n\n- **R1:** risk\n',
  });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  const main = page.slice(page.indexOf('<main'));
  assert.match(main, /^<main id="main">\n<section class="view overview" id="overview" data-view="overview">/);
  const overview = between(main, 'id="overview"', '</section>');
  assert.ok(overview.includes('<h1 id="overview-name">Pay with a &lt;b&gt;code&lt;/b&gt;</h1>'), 'the name is the requirement title after its kind, escaped');
  assert.ok(overview.includes('<code>001-x</code>'), 'the slug shows small');
  assert.match(page, /<title>Pay with a &lt;b&gt;code&lt;\/b&gt;<\/title>/);
  assert.ok(overview.includes('<div class="fact"><dt>Updated</dt><dd>2026-11-19</dd></div>'), overview);
  assert.ok(overview.includes('<dt>Stage</dt><dd>design; <a class="ref" href="#r-FR-001">FR-001</a> settled</dd>'), 'an id in a fact links to its definition');
  assert.ok(overview.includes('<dt>Next</dt><dd>data-team meeting</dd>'));
  // The chain strip: one step per document, with its maturity label.
  assert.match(overview, /<ol class="chain"[^>]*><li><a href="#doc-requirement" data-view-link="requirement">Requirement<span class="tag tag--warn">Draft<\/span><\/a><\/li><li><a href="#doc-design" data-view-link="design">Design<span class="tag tag--info">In review<\/span><\/a><\/li><\/ol>/);
  // Next before Open, each its state section rendered in place; the long Open card clamps with a control that needs no script.
  const next = overview.indexOf('data-card="next"');
  const open = overview.indexOf('data-card="open"');
  assert.ok(next > 0 && open > next, 'Next card then Open card');
  assert.match(overview, /<div class="card card--next" data-card="next">\n<div class="clamp">\n<h2 id="state-next-steps">Next steps<\/h2>\n<ol>\n<li>Meet the data team\.<\/li>/);
  assert.match(overview, /<div class="card card--open card--long" data-card="open">[\s\S]*question 8[\s\S]*<details class="more"><summary>/);
  // One card per document, with ids per prefix and open items.
  const cards = overview.match(/<a class="doc-card"[\s\S]*?<\/a>/g) || [];
  assert.equal(cards.length, 2);
  const [requirement = '', design = ''] = cards;
  assert.ok(requirement.includes('<ul class="id-counts" aria-label="Ids defined"><li>FR <b>2</b></li><li>NFR <b>1</b></li></ul>'), requirement);
  assert.ok(requirement.includes('<li>2 open</li>'), 'the items under Open Questions are counted');
  assert.ok(requirement.includes('<li>2 sections</li>'));
  assert.match(design, /<li>R <b>1<\/b><\/li>/);
  // The rest of state.md follows, in its own order; the cards' sections are not repeated.
  const rest = between(overview, '<div class="state-rest">', '</div>\n</section>');
  assert.ok(rest.includes('The design was rebuilt.') && rest.includes('id="state-status"'), rest);
  assert.ok(!rest.includes('state-next-steps') && !rest.includes('state-open-for-decision-owners'));
});

test('state.md is the overview, not a document view or a sidebar entry', () => {
  const { root, paths } = feature({ 'state.md': STATE, 'intention/requirement.md': REQUIREMENT });
  const result = buildPage({ paths, root, mode: 'source', now: NOW });
  const page = fs.readFileSync(result.file, 'utf8');
  assert.ok(!page.includes('id="doc-state"'));
  assert.ok(!page.includes('data-view="state"') && !page.includes('data-view-link="state"'));
  assert.equal(page.split('<h1 id="state-').length - 1, 0, 'the state title is not rendered');
  assert.deepEqual(result.documents.map((d: any) => d.key), ['requirement', 'state'], 'the --json result still lists it');
});

test('a page without state or design still opens on an overview with the name, the chain and the document cards', () => {
  const { root, paths } = feature({ 'intention/requirement.md': REQUIREMENT, 'plan.md': '# Plan\n\n## 1. Tasks\n' });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  const overview = between(page, 'id="overview"', '</section>');
  assert.ok(overview.includes('<h1 id="overview-name">Pay with a &lt;b&gt;code&lt;/b&gt;</h1>'));
  assert.ok(overview.includes('<dt>Created</dt><dd>2026-11-04</dd>'), 'without state, the requirement header facts');
  assert.equal((overview.match(/<a class="doc-card"/g) || []).length, 2);
  assert.ok(!overview.includes('data-card='), 'no Next or Open card without state');
  const bare = feature({ 'plan.md': '# Plan\n' });
  const plain = fs.readFileSync(buildPage({ paths: bare.paths, root: bare.root, mode: 'source', now: NOW }).file, 'utf8');
  assert.ok(plain.includes('<h1 id="overview-name">001-x</h1>'), 'a title without a name falls back to the slug');
});

test('a document opens on a header band: label, its own H1 promoted once, its facts, maturity label and path', () => {
  const { root, paths } = feature({ 'intention/requirement.md': REQUIREMENT });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  const doc = between(page, 'id="doc-requirement"', '</section>');
  assert.match(doc, /^id="doc-requirement" data-view="requirement">\n<header class="doc-head">\n<p class="kicker">Requirement<\/p>\n<h1 id="requirement-feature-requirement-pay-with-a-bcodeb">Feature Requirement: Pay with a &lt;b&gt;code&lt;\/b&gt;<\/h1>/);
  assert.equal(doc.split('<h1').length - 1, 1, 'the H1 is not repeated in the body');
  assert.ok(doc.includes('<dl class="facts"><div class="fact"><dt>Feature</dt><dd>001-x</dd></div><div class="fact"><dt>Created</dt>'), 'facts strip without the maturity');
  assert.ok(doc.includes('<p class="doc-meta"><span class="tag tag--warn">Draft</span><code class="path">intention/requirement.md</code></p>'));
  assert.ok(!doc.includes('**Feature:**') && !doc.includes('<p><strong>Feature:'), 'the facts paragraph is not in the body');
  assert.match(doc, /<h2 id="requirement-1-summary"><span class="num">1\.<\/span> Summary<\/h2>/);
  // Sidebar: the document with its level-2 sections, marked for the next task's script.
  assert.match(page, /<li class="nav-doc" data-view="requirement"><a href="#doc-requirement" data-view-link="requirement"><span>Requirement<\/span><span class="tag tag--warn">Draft<\/span><\/a><ol class="nav-secs">/);
});

test('the app bar carries the name, the slug and the controls, and no render counts or generation details', () => {
  const { root, paths } = feature({ 'intention/requirement.md': REQUIREMENT, 'design/design.md': `# Design\n\n${DIAGRAM}` });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  const bar = between(page, '<header class="appbar">', '</header>');
  assert.ok(bar.includes('<span class="name">Pay with a &lt;b&gt;code&lt;/b&gt;</span><code class="slug">001-x</code>'));
  assert.ok(bar.includes('placeholder="Filter sections and ids"') && bar.includes('data-theme-toggle'));
  assert.ok(!/document|diagram|generated|UTC|\d{4}-\d{2}-\d{2}/i.test(bar.replace(/data-[a-z-]+/g, '')), bar);
  assert.match(page, /<footer class="foot">Generated 2026-11-14 10:20 UTC/);
});

// Row 179: the page's own script moves the reader through it; without the script every view stays visible.
const pageScript = (page: string) => /<script>\n([\s\S]*?)\n<\/script>/.exec(page)?.[1] ?? '';

test('the page carries exactly one inline script, holding view switching, scroll tracking, the filter and the viewer', () => {
  const { root, paths } = feature({
    'intention/requirement.md': REQUIREMENT,
    'design/design.md': `# Design\n\nA <img src=x onerror=alert(1)> and <a href="#" onclick="x()">y</a>.\n\n${DIAGRAM}`,
  });
  const render = () => '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
  for (const mode of ['source', 'inline']) {
    const page = fs.readFileSync(buildPage({ paths, root, mode, render, now: NOW }).file, 'utf8');
    const executable = (page.match(/<script\b[^>]*>/g) || []).filter((tag: string) => !tag.includes('type="application/json"'));
    assert.deepEqual(executable, ['<script>'], mode);
    assert.ok(!/<script[^>]*\ssrc=/.test(page), 'no external script outside cdn');
    const body = pageScript(page);
    assert.doesNotThrow(() => new Function(body), 'the script parses');
    for (const piece of ["'until-found'", "'beforematch'", "addEventListener('scroll'", "'[data-filter]'", 'showModal()', 'Open full size', "'wheel'"]) {
      assert.ok(body.includes(piece), `${mode}: ${piece}`);
    }
    assert.ok(!/\beval\(|new Function|innerHTML|outerHTML|insertAdjacentHTML|document\.write/.test(body), 'text reaches the page only through textContent');
    // The views ship visible; only the script hides all but the current one.
    assert.ok(!/<section class="view[^>]*\shidden/.test(page));
    const markup = page.replace(/<script>[\s\S]*?<\/script>/, '');
    assert.ok(!/<[a-z][^>]*\son[a-z]+\s*=/i.test(markup), 'no inline event-handler attribute');
  }
});

test('the filter and theme controls ship hidden and the script shows them; the theme applies before the body', () => {
  const { root, paths } = feature({ 'intention/requirement.md': REQUIREMENT });
  const page = fs.readFileSync(buildPage({ paths, root, mode: 'source', now: NOW }).file, 'utf8');
  const bar = between(page, '<header class="appbar">', '</header>');
  assert.match(bar, /<input class="filter" type="search"[^>]*data-filter hidden>/);
  assert.match(bar, /<button class="theme" type="button"[^>]*data-theme-toggle hidden>/);
  assert.match(bar, /<a class="nav-toggle" href="#sidebar"[^>]*data-nav-toggle>/, 'the drawer opens through :target without the script');
  const body = pageScript(page);
  assert.ok(body.includes("filter.removeAttribute('hidden')") && body.includes("toggle.removeAttribute('hidden')"));
  // The script sits in the head and applies the stored theme before it waits for the document.
  assert.ok(page.indexOf('<script>') < page.indexOf('<body>'));
  assert.ok(body.indexOf('applyTheme(storedTheme())') < body.indexOf("'DOMContentLoaded'"));
  assert.match(body, /try \{ var t = localStorage\.getItem/, 'storage is guarded: a file page may refuse it');
});
