'use strict';

// 035 B.5 — fixtures for the C4-to-Mermaid projector (specs.md IC-002, IC-004).
//
// The projector is the only component of this feature that can produce a silently WRONG answer:
// every other failure is loud. These fixtures pin the two properties that make its output
// trustworthy — that it is deterministic, and that it refuses rather than degrades.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PROJECTOR = path.join(__dirname, '..', '..', 'src', 'runtime', 'c4-project.js');

// Required directly as well as executed: the CLI tests above pin the process contract, these pin
// the module's own surface. Both matter -- render-puml.sh shells out, but the recognized sets are
// the contract IC-002 states, and asserting them through a subprocess would be asserting a shape
// through a keyhole.
const { project: projectInProcess, parse, ELEMENTS, BOUNDARIES, RELATIONS, Refused } = require('../../src/runtime/c4-project');

/** Run the projector over a source body. Returns {code, stdout, stderr}. */
function project(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c4proj-'));
  const file = path.join(dir, 't.puml');
  fs.writeFileSync(file, `@startuml\n!include <C4/C4_Component>\n${body}\n@enduml\n`);
  try {
    const stdout = execFileSync('node', [PROJECTOR, file], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (err) {
    return { code: err.status, stdout: err.stdout || '', stderr: err.stderr || '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('035: every element family projects to exactly one node', () => {
  // One representative per kind plus an _Ext and a Db variant: the variant carries type information
  // the projection deliberately drops, so all of them must still yield a plain node.
  const r = project([
    'Person(p, "A person")',
    'System_Ext(s, "A system")',
    'ContainerDb(d, "A store")',
    'ComponentQueue(q, "A queue")',
  ].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  for (const [alias, label] of [['p', 'A person'], ['s', 'A system'], ['d', 'A store'], ['q', 'A queue']]) {
    assert.ok(r.stdout.includes(`${alias}["${label}"]`), `missing node for ${alias}:\n${r.stdout}`);
  }
});

test('035: a boundary projects to a subgraph holding its members', () => {
  const r = project([
    'System_Boundary(b, "Bounded") {',
    '  Container(x, "Inside")',
    '}',
    'Container(y, "Outside")',
  ].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /subgraph b\["Bounded"\]/);
  const sub = r.stdout.slice(r.stdout.indexOf('subgraph b'), r.stdout.indexOf('    end'));
  assert.ok(sub.includes('x["Inside"]'), 'the member belongs inside the subgraph');
  assert.ok(!sub.includes('y["Outside"]'), 'a non-member must not be captured by the subgraph');
});

test('035: the direction suffix is discarded, not projected', () => {
  // Rel_D and Rel are the same edge to a renderer that declares its own direction. A projection
  // that carried the suffix through would be importing PlantUML's layout, which is exactly what
  // the guide's own anti-pattern list forbids.
  const body = ['Container(a, "A")', 'Container(b, "B")'].join('\n');
  const plain = project(`${body}\nRel(a, b, "uses")`);
  const directed = project(`${body}\nRel_D(a, b, "uses")`);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal(directed.code, 0, directed.stderr);
  // Strip BOTH volatile lines: the hash (same source, so it matches anyway) and the temp path,
  // which differs by construction because the harness gives each run its own directory.
  const strip = (s) => s.split('\n')
    .filter((l) => !l.includes('source-hash') && !l.includes('generated from'))
    .join('\n');
  assert.equal(strip(plain.stdout), strip(directed.stdout),
    'Rel and Rel_D must project identically once the hash line is set aside');
});

test('035: a bidirectional relation projects to a bidirectional edge', () => {
  const r = project(['Container(a, "A")', 'Container(b, "B")', 'BiRel(a, b, "syncs")'].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /a <-->\|"syncs"\| b/);
});

test('035: an unrecognized macro refuses, naming the macro and the line', () => {
  // The defining property. Skipping would emit a diagram carrying fewer elements than its source
  // with nothing in the output revealing the loss.
  const r = project(['Container(a, "A")', 'NotARealMacro(a, "x")'].join('\n'));
  assert.equal(r.code, 1, 'an unrecognized macro must exit 1, never 0 with a shrunken diagram');
  assert.match(r.stderr, /NotARealMacro/, 'the refusal names the macro');
  assert.match(r.stderr, /:4:/, 'the refusal names the line it was found on');
  assert.equal(r.stdout, '', 'nothing is written when the projection refuses');
});

test('035: skipped macros are skipped by name, not by catch-all', () => {
  // SHOW_LEGEND is on the skip list; a macro that merely looks similar is not.
  const ok = project(['Container(a, "A")', 'SHOW_LEGEND()'].join('\n'));
  assert.equal(ok.code, 0, ok.stderr);
  const notOk = project(['Container(a, "A")', 'SHOW_LEGENDARY()'].join('\n'));
  assert.equal(notOk.code, 1, 'a near-miss name must refuse, proving the list is not a prefix match');
});

test('035: the projection is deterministic and hash-stamped', () => {
  const body = ['Person(u, "User")', 'Container(a, "API")', 'Rel(u, a, "calls")'].join('\n');
  const first = project(body);
  const second = project(body);
  assert.equal(first.code, 0, first.stderr);
  // The harness writes each run to its own temp dir, and the block names its source path, so the
  // path line differs by construction. Normalise it: what determinism means here is that the same
  // BYTES yield the same projection and the same hash, not that two temp dirs share a name.
  const norm = (s) => s.replace(/generated from \S+ by/, 'generated from <src> by');
  assert.equal(norm(first.stdout), norm(second.stdout), 'the same source must yield byte-identical output');
  assert.match(first.stdout, /source-hash: [0-9a-f]{12}/, 'the block records which revision produced it');
  assert.match(first.stdout, /^<!-- generated from /m, 'the block names its source file');
  assert.match(first.stdout, /<!-- end generated -->/, 'the block is delimited so a re-run can replace it');
});

test('035: a different source yields a different hash', () => {
  const a = project('Container(a, "A")');
  const b = project('Container(a, "B")');
  const h = (s) => s.match(/source-hash: ([0-9a-f]+)/)[1];
  assert.notEqual(h(a.stdout), h(b.stdout), 'the hash must track the source, or staleness is undetectable');
});

test('035: the recognized sets match the counts IC-002 states', () => {
  // Verified against PlantUML 1.2026.8 during planning, which is how the RelIndex family was found
  // absent from all six bundled includes despite appearing in the published API reference.
  assert.equal(ELEMENTS.size, 20, 'twenty element macros');
  assert.equal(BOUNDARIES.size, 4, 'four boundary macros, including the generic Boundary');
  assert.equal(RELATIONS.size, 18, 'eighteen relationship macros');
  for (const absent of ['RelIndex', 'RelIndex_Back', 'RelIndex_Neighbor']) {
    assert.ok(!RELATIONS.has(absent), `${absent} is not in the bundled library and must not be recognized`);
  }
  for (const present of ['BiRel_D', 'BiRel_U', 'BiRel_L', 'BiRel_R']) {
    assert.ok(RELATIONS.has(present), `${present} is in the bundled library and must be recognized`);
  }
  assert.ok(BOUNDARIES.has('Boundary'), 'the generic Boundary is defined and must be recognized');
});

test('035: parse refuses in-process too, not only across the CLI boundary', () => {
  assert.throws(
    () => parse('Container(a, "A")\nMadeUpMacro(a, b)\n', 'x.puml'),
    (err) => err instanceof Refused && /MadeUpMacro/.test(err.message) && /:2:/.test(err.message),
    'the refusal is a property of the parser, not of its command-line wrapper',
  );
});

test('035: project returns the digest it stamps into the block', () => {
  const { block, digest } = projectInProcess('Container(a, "A")\n', 'x.puml');
  assert.match(digest, /^[0-9a-f]{12}$/);
  assert.ok(block.includes(`source-hash: ${digest}`), 'the stamped hash is the one the caller gets back');
});

// ── Regressions from the 035 code review ─────────────────────────────────────────────────────────
// Each of these projected a plausible diagram and exited 0 before the fix. They are grouped here
// because they share one failure mode: the projector degrading silently, which is the single
// property the fixtures above exist to deny it.

test('035-R1: an omitted middle argument stays omitted in place, it does not shift the rest left', () => {
  // Every relationship macro is ($from, $to, $label, $techn, ...), so dropping the empty label
  // promoted the technology into its place: the edge read "HTTPS/JSON" where the source says
  // nothing at all. Position is meaning here.
  const r = project([
    'Container(a, "A")',
    'Container(b, "B")',
    'Rel(a, b, "", "HTTPS/JSON")',
  ].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('HTTPS/JSON'), `the technology must not become the label:\n${r.stdout}`);
  assert.match(r.stdout, /a --> b/, 'an empty label projects to an unlabelled edge');
});

test('035-R2: a block comment hides its contents instead of contributing them', () => {
  // IC-002 lists comments among the constructs the projection ignores by name. Matching only the
  // line that OPENS the block left the body parsed, so an element commented out while iterating on
  // a diagram came back as a real node -- the silent-addition mirror of a silently dropped one.
  const r = project([
    'Container(a, "A")',
    "/'",
    'Container(ghost, "Removed on purpose")',
    'Rel(a, ghost, "no longer happens")',
    "'/",
  ].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(!r.stdout.includes('ghost'), `a commented-out element must not be projected:\n${r.stdout}`);
  assert.ok(!r.stdout.includes('no longer happens'), 'nor its commented-out relation');
});

test('035-R3: an unrecognized macro inside a block comment does not refuse', () => {
  // The same gap in the other direction: commenting a macro out must settle the refusal, not
  // trigger it, or a source cannot be edited incrementally.
  const r = project(['Container(a, "A")', "/'", 'NotARealMacro(x, "y")', "'/"].join('\n'));
  assert.equal(r.code, 0, `a commented-out macro must not refuse:\n${r.stderr}`);
});

test('035-R4: a boundary inside a boundary projects to a nested subgraph', () => {
  // Flattening rendered the outer boundary as an EMPTY subgraph and hoisted the inner one beside
  // it, so the diagram stated no containment at all. Mermaid nests subgraphs natively, so this was
  // a loss the target grammar never forced -- and one the module's own lossy-by-design list omits.
  const r = project([
    'Enterprise_Boundary(e, "Acme") {',
    '  System_Boundary(s, "Platform") {',
    '    Container(x, "Inside")',
    '  }',
    '}',
  ].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^ {4}subgraph e\["Acme"\]$/m, 'the outer boundary is a top-level subgraph');
  assert.match(r.stdout, /^ {8}subgraph s\["Platform"\]$/m, 'the inner boundary nests inside it');
  assert.match(r.stdout, /^ {12}x\["Inside"\]$/m, 'and the member nests inside that');
  assert.ok(!/subgraph e\["Acme"\]\n {4}end/.test(r.stdout), 'the outer boundary must not render empty');
});

test('035-R5: a label carrying the quote character survives into valid Mermaid', () => {
  // splitArgs treated every quote as a delimiter, so an escaped one ended the argument early and
  // emit interpolated the remains straight into ["..."] -- an unbalanced quote that stops the whole
  // fence parsing, at exit 0.
  const r = project(['Container(b, "Bob\\"s proxy")'].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes('b["Bob&quot;s proxy"]'), `the quote must be escaped, not dropped:\n${r.stdout}`);
  const fence = r.stdout.slice(r.stdout.indexOf('flowchart'), r.stdout.lastIndexOf('```'));
  assert.equal((fence.match(/"/g) || []).length % 2, 0, 'every quote in the fence is balanced');
});

test('035-R6: a redefined alias refuses rather than silently keeping the last definition', () => {
  // Map.set made the second declaration win and the first vanish, which is a dropped element by
  // another route. The projector states that it refuses rather than degrades; this is that.
  const r = project(['Container(a, "First")', 'Container(a, "Second")'].join('\n'));
  assert.equal(r.code, 1, 'a duplicate alias must refuse');
  assert.match(r.stderr, /already defined/, 'the refusal says what is wrong');
  assert.match(r.stderr, /:4:/, 'and names the line the redefinition is on');
});

// ── Regressions from the 035 re-review ───────────────────────────────────────────────────────────
// The first two were introduced BY the block-comment fix above and were worse than what they
// replaced: each swallowed the remainder of the source at exit 0. Their shared cause was the
// projector deciding "am I inside a string?" in two places that never consulted each other, so the
// third -- which predates both -- fell out of unifying them and is pinned here alongside.

test('035-R7: a block-comment opener inside a quoted label is text, not a comment', () => {
  const r = project([
    `Container(a, "Serves /'api' routes")`,
    'Container(b, "Downstream")',
    'Rel(a, b, "calls")',
  ].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes(`a["Serves /'api' routes"]`), `the label must survive intact:\n${r.stdout}`);
  assert.ok(r.stdout.includes('b["Downstream"]'), 'and must not swallow the declarations after it');
  assert.match(r.stdout, /a -->\|"calls"\| b/, 'nor the relation between them');
});

test('035-R8: an unclosed block comment refuses, naming the line it was opened on', () => {
  // Leaving it open dropped every later declaration and still exited 0 -- the silent shrinking the
  // unrecognized-macro refusal exists to deny, reached by a different route.
  const r = project([
    'Container(a, "A")',
    `/' TODO: restore this once the API lands`,
    'Container(b, "B")',
  ].join('\n'));
  assert.equal(r.code, 1, 'an unterminated comment must refuse, never emit a shortened diagram');
  assert.match(r.stderr, /never closed/, 'the refusal says what is wrong');
  assert.match(r.stderr, /:4:/, 'and names the line the comment was opened on, not the line it ran out on');
});

test('035-R9: a boundary whose brace block is on one line keeps its own member', () => {
  // One macro was read per line, so the inner element was dropped and the `}` never seen -- which
  // left the boundary open and captured the NEXT line's element into it instead. Two silent errors
  // from one missing token.
  const r = project([
    'System_Boundary(b, "Bounded") { Container(x, "Inside") }',
    'Container(y, "Outside")',
  ].join('\n'));
  assert.equal(r.code, 0, r.stderr);
  const sub = r.stdout.slice(r.stdout.indexOf('subgraph b'), r.stdout.indexOf('    end'));
  assert.ok(sub.includes('x["Inside"]'), `the inner element belongs to the boundary:\n${r.stdout}`);
  assert.ok(!sub.includes('y["Outside"]'), 'and the next line must not be captured into it');
  assert.match(r.stdout, /^ {4}y\["Outside"\]$/m, 'y stays a top-level node');
});

test('035-R10: free text carrying a parenthesis is not read as a macro call', () => {
  // Found while fixing R9: scanning every offset of every line made any `word (` a macro candidate,
  // so `title My Diagram (v2)` refused as an unrecognized macro 'Diagram'. A line is scanned for
  // constructs only when it begins with one.
  const r = project([
    'title My Diagram (v2)',
    'Container(a, "A")',
    'note right of a : handles retries (see ADR-4)',
  ].join('\n'));
  assert.equal(r.code, 0, `free text must not refuse:\n${r.stderr}`);
  assert.match(r.stdout, /a\["A"\]/, 'and the real declaration still projects');
});

// ── Regressions from the 035 third review ────────────────────────────────────────────────────────
// The permitted-alias set and the Mermaid escaping questions were settled by RENDERING with
// mermaid-cli 11.16 rather than by reading its grammar. That mattered twice: two findings the review
// raised turned out not to be defects at all (a pipe inside a QUOTED edge label parses fine, and a
// label ending in a backslash renders fine), and the first guess at a safe alias -- a C-style
// identifier -- would have refused three spellings the renderer accepts.

test('035-R11: an alias Mermaid cannot lex refuses; the ones it can are left alone', () => {
  const bad = project('Container("my alias", "Label")');
  assert.equal(bad.code, 1, 'whitespace in a node id is a Mermaid parse error for the WHOLE diagram');
  assert.match(bad.stderr, /not a usable node id/);

  const ok = project([
    'Container(my-alias, "Dashed")',
    'Container(a.b, "Dotted")',
    'Rel(my-alias, a.b, "calls")',
  ].join('\n'));
  assert.equal(ok.code, 0, `mermaid-cli renders these, so the projector must not refuse them:\n${ok.stderr}`);
  assert.ok(ok.stdout.includes('my-alias["Dashed"]'), 'a dash is a legal node id');
  assert.ok(ok.stdout.includes('a.b["Dotted"]'), 'so is a dot');
});

test('035-R12: prose after a construct is ignored, but a dropped macro refuses', () => {
  // Scanning every offset made prose refuse; stopping blind made a real macro vanish. Neither is
  // acceptable, so the stop is conditional on whether what follows is something recognized.
  const prose = project(['Container(a, "A")', 'Rel(a, a, "self") see cache(x) for details'].join('\n'));
  assert.equal(prose.code, 0, `trailing prose must be ignored:\n${prose.stderr}`);
  assert.match(prose.stdout, /a -->\|"self"\| a/);

  const dropped = project('Container(a, "A") , Container(b, "B")');
  assert.equal(dropped.code, 1, 'a recognized macro must never be silently dropped');
  assert.match(dropped.stderr, /would be dropped/);
});

test('035-R13: an unterminated call refuses, but a continued one still parses', () => {
  const split = project(['Container(a, "label that', 'continues here")'].join('\n'));
  assert.equal(split.code, 1, 'a label split across lines used to be truncated to its first line');
  assert.match(split.stderr, /never closed/);
  assert.match(split.stderr, /:3:/, 'and names the line the call opened on');

  const unclosed = project(['Container(a, "A"', 'Container(b, "B")'].join('\n'));
  assert.equal(unclosed.code, 1, 'a missing paren used to be accepted silently');

  const continued = project(['Container(a, "A long label", \\', '  "Node.js", "desc")'].join('\n'));
  assert.equal(continued.code, 0, `a backslash continuation is not an unterminated call:\n${continued.stderr}`);
  assert.ok(continued.stdout.includes('a["A long label"]'));
});

// ── Regressions from the 035 fourth review ───────────────────────────────────────────────────────

test('035-R14: a backslash inside a label is not a line continuation', () => {
  // Third recurrence of one pattern: a line-level transform running ahead of quote state. Comment
  // stripping did it, then backslash joining did it, and both silently rewrote a quoted label --
  // here into `path  more`. The join moved inside the scanner that already tracks quotes rather
  // than being patched a third time where it stood.
  const inLabel = project(['Container(a, "path \\', 'more")'].join('\n'));
  assert.equal(inLabel.code, 1, 'the call is unterminated, not continued');
  assert.match(inLabel.stderr, /never closed/);

  const outside = project(['Container(a, "A long label", \\', '  "Node.js", "desc")'].join('\n'));
  assert.equal(outside.code, 0, `a backslash outside a quote still continues:\n${outside.stderr}`);
  assert.ok(outside.stdout.includes('a["A long label"]'));
});

test('035-R15: an alias Mermaid would re-read as a link refuses', () => {
  // Measured with mermaid-cli 11.16: `a--b` is a parse error, but `a---b` and `a-.-b` RENDER -- as
  // two nodes joined by a link, because those are Mermaid's own open-link and dotted-link spellings.
  // An alias that quietly becomes an edge is a different diagram that looks fine, which is worse
  // than one that fails.
  for (const bad of ['a--b', 'a---b', 'a-.-b']) {
    const r = project(`Container(${bad}, "L")`);
    assert.equal(r.code, 1, `${bad} must refuse; Mermaid does not read it as a node id`);
    assert.match(r.stderr, /not a usable node id/);
  }
  for (const good of ['my-alias', 'a.b', 'a_b-c', '1abc']) {
    const r = project(`Container(${good}, "L")`);
    assert.equal(r.code, 0, `${good} renders in Mermaid, so the projector must not refuse it:\n${r.stderr}`);
  }
});

test('035-R16: a separator hides a construct, a word makes it prose', () => {
  // The guard cannot tell a mention of `Rel(a)` from a construct, so what sits BETWEEN decides:
  // punctuation is a malformed construct line, anything with a word character is prose.
  const prose = project(['Container(a, "A")', 'Container(b, "B") see Rel(a) in the notes'].join('\n'));
  assert.equal(prose.code, 0, `prose mentioning a macro must be ignored:\n${prose.stderr}`);
  assert.ok(prose.stdout.includes('b["B"]'), 'and the construct that opened the line still projects');

  const separator = project('Container(a, "A") , Container(b, "B")');
  assert.equal(separator.code, 1, 'a construct behind a separator must not vanish');
  assert.match(separator.stderr, /would be dropped/);
});
