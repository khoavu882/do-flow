'use strict';

/**
 * Project a C4-PlantUML source into the Mermaid flowchart that stands for it (035 IC-002/IC-004).
 *
 * Lives in the JS runtime, not beside the shell helpers, because G12 keeps this repo to ONE runtime
 * implementation: `core/` carries pure bash plus Node, and Python outside the skill-owned analyzers
 * is how a shadow tree grew the first time, one individually-defensible module at a time. The first
 * draft of this projector was that module. `render-puml.sh` shells out to node here, the same way
 * `render-audit.sh` already does.
 *
 * The projection is LOSSY BY DESIGN and deterministic. It keeps nodes, edges, labels, and boundaries
 * with their nesting.
 * It drops element type, technology, description, sprite, tag, link and the legend -- seven things a
 * reader opens the rendered image for, which is why the emitted block names its source.
 *
 * It REFUSES rather than degrades. A macro neither recognized nor explicitly skipped stops the
 * projection, naming the macro, the file and the line. Skipping would emit a diagram carrying fewer
 * elements than its source with nothing revealing the loss.
 *
 * The recognized set was verified by exercising every candidate against PlantUML 1.2026.8's own
 * syntax check, not transcribed from documentation -- which is how the RelIndex family was found
 * absent from all six bundled includes despite appearing in the published API reference.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');

/** 20 element macros. Each projects to one node; the variant carries type the projection drops. */
const ELEMENTS = new Set([
  'Person', 'Person_Ext',
  'System', 'System_Ext', 'SystemDb', 'SystemDb_Ext', 'SystemQueue', 'SystemQueue_Ext',
  'Container', 'Container_Ext', 'ContainerDb', 'ContainerDb_Ext', 'ContainerQueue', 'ContainerQueue_Ext',
  'Component', 'Component_Ext', 'ComponentDb', 'ComponentDb_Ext', 'ComponentQueue', 'ComponentQueue_Ext',
]);

/** 4 boundary macros. Each opens a brace block and projects to one subgraph. */
const BOUNDARIES = new Set(['System_Boundary', 'Container_Boundary', 'Enterprise_Boundary', 'Boundary']);

/**
 * 18 relationship macros. All share ($from, $to, $label, $techn, ...), so one shape matches the
 * family, and the direction suffix is a PlantUML layout hint that does NOT survive the projection --
 * Mermaid declares its own direction, and carrying the hint through would be importing another
 * renderer's layout, which the diagram guide lists as an anti-pattern.
 */
const RELATIONS = new Set([
  'Rel', 'Rel_D', 'Rel_Down', 'Rel_U', 'Rel_Up', 'Rel_L', 'Rel_Left', 'Rel_R', 'Rel_Right',
  'Rel_Back', 'Rel_Back_Neighbor', 'Rel_Neighbor',
  'BiRel', 'BiRel_Neighbor', 'BiRel_D', 'BiRel_U', 'BiRel_L', 'BiRel_R',
]);

/** Explicit, never a prefix match: adding a styling macro is a decision, not a silent no-op. */
const SKIPPED = new Set([
  'SHOW_LEGEND', 'SHOW_FLOATING_LEGEND', 'LAYOUT_TOP_DOWN', 'LAYOUT_LEFT_RIGHT', 'LAYOUT_LANDSCAPE',
  'LAYOUT_WITH_LEGEND', 'HIDE_STEREOTYPE', 'SHOW_PERSON_OUTLINE', 'UpdateElementStyle',
  'UpdateRelStyle', 'UpdateLayoutConfig', 'UpdateBoundaryStyle', 'AddElementTag', 'AddRelTag',
  'AddBoundaryTag', 'SetDefaultLegendEntries', 'title', 'caption', 'header', 'footer', 'skinparam',
  'scale', 'legend', 'endlegend',
]);

// Anchored as a PREFIX, not as a whole line: `parse` applies it at successive offsets so a line
// carrying more than one construct -- `System_Boundary(b, "B") { Container(x, "X") }` -- is read
// whole. Matching once per line dropped everything after the first macro and then captured the NEXT
// line's element into the boundary the lost `}` never closed.
const CALL = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/;

class Refused extends Error {}

/**
 * Split a macro's arguments on commas outside quotes, stopping at its closing paren.
 *
 * Only TRAILING empties are dropped. Filtering every empty argument shifts the later ones left, so
 * `Rel(a, b, "", "HTTPS")` projected the technology as the edge label: a plausible diagram, exit 0,
 * and nothing in the output revealing the substitution. Position IS meaning in a C4 macro -- every
 * relationship shares ($from, $to, $label, $techn, ...) -- so an omitted middle argument has to stay
 * omitted in place rather than closing the gap.
 *
 * A backslash escapes the next character inside a quoted argument, so a label may contain the quote
 * character itself. What survives is escaped for the target grammar by `escapeLabel` at emit time.
 *
 * Returns the arguments AND how many characters the call occupied, so the caller can resume scanning
 * after the closing paren rather than assuming the macro owned the rest of its line.
 */
function splitArgs(text) {
  const args = [];
  let buf = '';
  let depth = 0;
  let quote = null;
  let consumed = text.length;
  let closed = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === '\\' && i + 1 < text.length) { buf += text[i + 1]; i += 1; }
      else if (ch === quote) quote = null;
      else buf += ch;
    } else if (ch === '"') quote = ch;
    else if (ch === '(') { depth += 1; buf += ch; }
    else if (ch === ')' && depth === 0) { consumed = i + 1; closed = true; break; }
    else if (ch === ')') { depth -= 1; buf += ch; }
    else if (ch === ',' && depth === 0) { args.push(buf.trim()); buf = ''; }
    else buf += ch;
  }
  args.push(buf.trim());
  while (args.length && args[args.length - 1] === '') args.pop();
  return { args, consumed, closed };
}

/**
 * Remove PlantUML comments from one line, carrying block state across lines in `state`.
 *
 * ONE notion of what is inside a string, shared with `splitArgs` above: a double-quoted argument is
 * opaque to comment syntax, everything outside one is not. Deciding that question twice -- once in a
 * quote-blind line pass and once in the argument splitter -- is what let a literal `/'` inside a
 * label open a block comment and silently swallow the rest of the source at exit 0. That is the
 * projection's defining failure, and it arrived through the fix for the mirror of itself.
 *
 * `'` outside a quote runs to end of line, and `/' ... '/` spans lines; both are PlantUML's own
 * rules. `state.openedAt` records where an unclosed block began so `parse` can name it.
 *
 * It also reports whether the line CONTINUES onto the next -- a trailing backslash outside any
 * quote. That decision belongs here rather than in a pre-pass over the raw line, because a pre-pass
 * cannot tell a continuation from a backslash inside a label: joining on the raw text turned
 * `Container(a, "path \` + newline + `more")` into the label `path  more`. That is the third time a
 * line-level transform running ahead of quote state has silently rewritten a label, so the transform
 * moved in here rather than being fixed again where it stood.
 */
function stripComments(raw, state, lineno) {
  let out = '';
  let quote = null;
  let i = 0;
  let continues = false;
  while (i < raw.length) {
    const ch = raw[i];
    if (state.inBlock) {
      if (ch === "'" && raw[i + 1] === '/') { state.inBlock = false; i += 2; } else i += 1;
    } else if (quote) {
      out += ch;
      continues = false;
      if (ch === '\\' && i + 1 < raw.length) { out += raw[i + 1]; i += 2; continue; }
      if (ch === quote) quote = null;
      i += 1;
    } else if (ch === '/' && raw[i + 1] === "'") {
      state.inBlock = true;
      state.openedAt = lineno;
      i += 2;
    } else if (ch === "'") {
      break;
    } else {
      if (ch === '"') quote = ch;
      out += ch;
      if (ch === '\\') continues = true;
      else if (!/\s/.test(ch)) continues = false;
      i += 1;
    }
  }
  return { text: continues ? out.replace(/\\\s*$/, ' ') : out, continues };
}

/** Mermaid delimits a node label with double quotes; an unescaped one inside ends it early and the
 *  rest of the fence stops parsing. `&quot;` is the entity Mermaid documents for this. */
function escapeLabel(text) {
  return String(text).replace(/"/g, '&quot;');
}

/**
 * Mermaid takes the alias as a node id, and an id it cannot lex fails the WHOLE diagram rather than
 * the one node -- so this refuses here rather than emitting a fence someone finds broken at render
 * time.
 *
 * Measured against mermaid-cli 11.16 across fifteen spellings, not assumed. Two lessons are baked
 * into the shape below. A C-style identifier -- the first guess -- refuses `a.b`, `1abc` and
 * `a_b-c`, which all render fine. And permitting any run of dots and dashes is worse than wrong:
 * `a--b` is a parse error, but `a---b` and `a-.-b` RENDER, as two nodes joined by a link, because
 * Mermaid reads them as its own open-link and dotted-link syntax. An alias that quietly becomes an
 * edge is the silent-wrong-diagram this projector exists to refuse.
 *
 * So: word-character runs joined by SINGLE dots or dashes. That refuses every dangerous spelling
 * measured and permits every plausible one. It also refuses `-a`, `.a`, `a..b` and a lone `-` or
 * `.`, which do render -- none is a plausible C4 alias, and the cost of permitting them is a class
 * of silent misreading rather than a diagnostic.
 */
const ALIAS = /^[A-Za-z0-9_]+([.-][A-Za-z0-9_]+)*$/;

/** Every refusal carries the file and line, so the one place that formats it owns both. */
function refuse(ctx, lineno, message) {
  throw new Refused(`${ctx.sourcePath}:${lineno}: ${message}`);
}

function requireAlias(ctx, alias, lineno, role) {
  if (!ALIAS.test(alias)) {
    refuse(ctx, lineno, `${role} '${alias}' is not a usable node id. Mermaid fails the whole diagram `
      + 'on one it cannot lex, and silently reads one carrying `--` or `-.-` as a LINK instead, '
      + 'drawing a different diagram that looks fine. Neither is worth emitting.');
  }
}

function acceptElement(ctx, name, args, lineno) {
  if (args.length < 2) refuse(ctx, lineno, `${name} needs an alias and a label`);
  requireAlias(ctx, args[0], lineno, 'alias');
  if (ctx.nodes.has(args[0])) {
    refuse(ctx, lineno, `alias '${args[0]}' is already defined. The projector refuses rather than `
      + 'keeping the last definition, which would drop an element the source declares.');
  }
  ctx.nodes.set(args[0], args[1]);
  if (ctx.stack.length) ctx.stack[ctx.stack.length - 1].members.push(args[0]);
}

// A boundary opened inside another is that one's CHILD, not a second root. Pushing every boundary
// onto one flat list rendered the outer one as an empty subgraph and hoisted the inner one to the
// top level -- dropping a containment the source states and Mermaid supports.
function acceptBoundary(ctx, name, args, lineno) {
  if (args.length < 2) refuse(ctx, lineno, `${name} needs an alias and a label`);
  requireAlias(ctx, args[0], lineno, 'boundary alias');
  const b = { alias: args[0], label: args[1], members: [], children: [] };
  if (ctx.stack.length) ctx.stack[ctx.stack.length - 1].children.push(b); else ctx.boundaries.push(b);
  ctx.stack.push(b);
}

function acceptRelation(ctx, name, args, lineno) {
  if (args.length < 2) refuse(ctx, lineno, `${name} needs a source and a target`);
  requireAlias(ctx, args[0], lineno, 'relation source');
  requireAlias(ctx, args[1], lineno, 'relation target');
  ctx.edges.push({ from: args[0], to: args[1], label: args[2] || '', bi: name.startsWith('BiRel') });
}

function accept(ctx, name, args, lineno) {
  if (SKIPPED.has(name)) return;
  if (ELEMENTS.has(name)) acceptElement(ctx, name, args, lineno);
  else if (BOUNDARIES.has(name)) acceptBoundary(ctx, name, args, lineno);
  else if (RELATIONS.has(name)) acceptRelation(ctx, name, args, lineno);
  else {
    refuse(ctx, lineno, `unrecognized macro '${name}'. The projector refuses rather than skipping `
      + 'it, because a skipped macro would silently shrink the diagram. Add it to the recognized '
      + 'set in src/runtime/c4-project.js if the bundled library defines it.');
  }
}

/**
 * Fold the raw lines into logical ones, each tagged with the line it OPENED on.
 *
 * Every raw line goes through stripComments IN ORDER -- block-comment state is a property of the
 * raw line, so it has to advance one raw line at a time -- and the scanner's own `continues` flag
 * is what joins them. A trailing backslash inside a quoted label is therefore not a continuation,
 * and the call it leaves unterminated refuses in the scan rather than absorbing the next line.
 */
function toLogicalLines(text, state) {
  const rawLines = text.split('\n');
  const logical = [];
  let pending = null;
  for (let n = 0; n < rawLines.length; n += 1) {
    const stripped = stripComments(rawLines[n], state, n + 1);
    if (pending === null) pending = { raw: stripped.text, lineno: n + 1 };
    else pending.raw += stripped.text;
    if (stripped.continues && n + 1 < rawLines.length) continue;
    logical.push(pending);
    pending = null;
  }
  if (pending !== null) logical.push(pending);
  return logical;
}

/** Read every construct one logical line carries, in order. */
function scanLine(ctx, line, lineno) {
  if (!line || /^[#@!]/.test(line)) return;
  // A line is scanned for constructs only when it BEGINS with one. Scanning every offset of every
  // line turned any free text containing `word (` into a macro candidate, so `title My Diagram
  // (v2)` refused as an unrecognized macro 'Diagram'.
  if (!CALL.test(line) && line[0] !== '}' && line[0] !== '{') return;
  let i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === '}') { ctx.stack.pop(); i += 1; continue; }
    if (ch === '{' || ch === ' ' || ch === '\t') { i += 1; continue; }
    const m = CALL.exec(line.slice(i));
    if (!m) {
      // Text trailing a construct is prose and is ignored, the way a line OPENING with prose
      // already is. But stopping blind would silently drop a recognized macro sitting after
      // something unparseable, so that one case refuses instead of vanishing. Only a SEPARATOR
      // hides a construct: if the gap carries any word character it is prose, and prose mentioning
      // `Rel(a)` must be ignored the way prose is everywhere else.
      const rest = line.slice(i);
      const hit = [...rest.matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)]
        .find(([, n]) => ELEMENTS.has(n) || BOUNDARIES.has(n) || RELATIONS.has(n));
      const dropped = hit && !/[A-Za-z0-9]/.test(rest.slice(0, hit.index)) ? hit[1] : null;
      if (dropped) {
        refuse(ctx, lineno, `${dropped}(...) follows text on this line that is not a construct, `
          + 'so it would be dropped from the projection. Put it on its own line.');
      }
      break;
    }
    const { args, consumed, closed } = splitArgs(line.slice(i + m[0].length));
    if (!closed) {
      refuse(ctx, lineno, `the call to ${m[1]} is never closed. Its arguments used to be truncated `
        + 'silently at the end of the line, so a label split across two lines lost everything '
        + 'after the first.');
    }
    accept(ctx, m[1], args, lineno);
    i += m[0].length + consumed;
  }
}

function parse(text, sourcePath) {
  const ctx = { sourcePath, nodes: new Map(), edges: [], boundaries: [], stack: [] };
  const state = { inBlock: false, openedAt: 0 };
  for (const entry of toLogicalLines(text, state)) scanLine(ctx, entry.raw.trim(), entry.lineno);
  // An unclosed block comment used to swallow every later declaration and still exit 0 -- the same
  // silent shrinking the unrecognized-macro refusal exists to deny. A malformed source refuses.
  if (state.inBlock) {
    refuse(ctx, state.openedAt, 'block comment opened here is never closed, so everything after it '
      + "would be dropped from the projection. Close it with '/ or delete it.");
  }
  return { nodes: ctx.nodes, edges: ctx.edges, boundaries: ctx.boundaries };
}

function emit({ nodes, edges, boundaries }, sourceRel, digest) {
  const grouped = new Set();
  const collect = (list) => {
    for (const b of list) {
      for (const a of b.members) grouped.add(a);
      collect(b.children);
    }
  };
  collect(boundaries);
  const out = [
    `<!-- generated from ${sourceRel} by \`doflow-run render-puml\` -- do not edit by hand`,
    `     source-hash: ${digest} -->`,
    '```mermaid',
    'flowchart TB',
  ];
  const renderBoundary = (b, indent) => {
    out.push(`${indent}subgraph ${b.alias}["${escapeLabel(b.label)}"]`);
    for (const a of b.members) out.push(`${indent}    ${a}["${escapeLabel(nodes.get(a) ?? a)}"]`);
    for (const child of b.children) renderBoundary(child, `${indent}    `);
    out.push(`${indent}end`);
  };
  for (const b of boundaries) renderBoundary(b, '    ');
  for (const [alias, label] of nodes) if (!grouped.has(alias)) out.push(`    ${alias}["${escapeLabel(label)}"]`);
  for (const e of edges) {
    const arrow = e.bi ? '<-->' : '-->';
    out.push(e.label
      ? `    ${e.from} ${arrow}|"${escapeLabel(e.label)}"| ${e.to}`
      : `    ${e.from} ${arrow} ${e.to}`);
  }
  out.push('```', '<!-- end generated -->');
  return `${out.join('\n')}\n`;
}

function project(text, sourceRel = '<source>') {
  const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  return { block: emit(parse(text, sourceRel), sourceRel, digest), digest };
}

module.exports = {
  project, parse, splitArgs, stripComments, ELEMENTS, BOUNDARIES, RELATIONS, SKIPPED, Refused,
};

if (require.main === module) {
  const file = process.argv[2];
  if (!file) { process.stderr.write('usage: c4-project.js <file.puml>\n'); process.exit(2); }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (err) { process.stderr.write(`c4-project: cannot read ${file}: ${err.message}\n`); process.exit(2); }
  try { process.stdout.write(project(text, file).block); }
  catch (err) {
    if (err instanceof Refused) { process.stderr.write(`c4-project: ${err.message}\n`); process.exit(1); }
    throw err;
  }
}
