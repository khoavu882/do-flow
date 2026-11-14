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
  assert.match(out, /<td>R1<\/td><td><code>a\|b<\/code><\/td>/);
  // A short row is padded to the header's width.
  assert.match(out, /<td>R2<\/td><td><\/td>/);
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
  assert.match(page, /<li><a href="#requirement-1-summary">1\. Summary<\/a><\/li>/);
  assert.match(page, /3 documents · 3 diagrams shown as source · generated 2026-11-14 10:20 UTC/);
  assert.match(page, /A\[&quot;&lt;b&gt;x&lt;\/b&gt;&quot;\]/);
  // A source page carries no script at all.
  assert.ok(!page.includes('<script'));
  assert.deepEqual(fs.readdirSync(path.join(root, dir)).filter((f: string) => f.endsWith('.tmp')), []);
});

test('buildPage in cdn mode loads the pinned Mermaid build, and only when the page has a diagram', () => {
  const withDiagram = feature({ 'design/design.md': `# Design\n\n${DIAGRAM}` });
  const page = fs.readFileSync(buildPage({ paths: withDiagram.paths, root: withDiagram.root, mode: 'cdn', now: NOW }).file, 'utf8');
  assert.match(page, /<pre class="mermaid">flowchart LR/);
  assert.equal(page.split('<script').length - 1, 2);
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
  assert.ok(!plain.includes('<script'));
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
  assert.match(page, /1 of 2 diagrams rendered/);
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
