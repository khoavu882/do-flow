'use strict';

/**
 * The one composer of a DoFlow prompt (row 173, IC-001): six sections in a fixed order, an optional
 * header above them, and nothing else. A caller states what each section holds; this module owns the
 * tags, the escaping, the omission of empty parts and the check that nothing the caller supplied was
 * lost on the way to the text. It is pure: no file, no environment, no clock.
 *
 * The only prose it writes itself is the two sentences of `output_format` (the reader line and the
 * line budget). Every other word of a prompt is the caller's.
 */

/** The six sections, in the order they are rendered. */
const SECTIONS = Object.freeze(['role', 'context', 'input', 'instructions', 'example', 'output_format']);
/** The sections a spec cannot leave out. */
const REQUIRED = Object.freeze(['instructions', 'output_format']);

/** A spec the composer cannot render; `code` is one of the `frame-*` codes of design §5.1. */
class FrameSpecError extends Error {
  code: string;
  detail: string;
  constructor(code: string, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'FrameSpecError';
    this.code = code;
    this.detail = detail;
  }
}

const EMPTY_BODY = /^(?:none|n\/a|tbd|todo|-+|—|…|\.\.\.|\(none\)|\[none\])\.?$/i;
const HEADER_KEY = /^[A-Z][A-Za-z ]{0,31}$/;
const FRAME_TAG = /<(\s*\/?\s*)(role|context|input|instructions|example|output_format|document)(?=[\s>/]|$)/gi;

const TOP_KEYS = ['header', 'role', 'context', 'input', 'instructions', 'example', 'output_format'];
const INSTRUCTION_KEYS = ['outcome', 'success', 'constraints', 'steps', 'stop'];
const BLOCK_KEYS = ['heading', 'body'];
/**
 * One document of `input`.
 * @typedef {Object} Doc
 * @property {string} [path] the source path (exactly one of `path` and `id`)
 * @property {string} [id] the document id
 * @property {'source'|'hand-back'|'retrieved'|'tool'} [kind] `hand-back`, `retrieved` and `tool` are screened (SCREENED_KINDS)
 * @property {string} text the body
 * @property {boolean} [keep] the body is a person's own words: a placeholder such as `none` or `N/A` is text, not an
 *   empty part, so it is kept and escaped like any other. Only a blank body is still left out.
 */
/** The kinds of document whose text is named on the result's `screen` list, to be screened before the prompt is used. */
const SCREENED_KINDS = Object.freeze(['hand-back', 'retrieved', 'tool']);
const DOC_KINDS = Object.freeze(['source', ...SCREENED_KINDS]);
const DOC_KEYS = ['path', 'id', 'kind', 'text', 'keep'];
const FORMAT_KEYS = ['reader', 'budgetLines', 'lines'];

/** Whether `s` says nothing: blank, or a placeholder such as `none`, `N/A`, `TBD`, a dash or `(none)`. */
function isEmptyBody(s: any): boolean {
  if (typeof s !== 'string') return true;
  const t = s.trim();
  return t === '' || EMPTY_BODY.test(t);
}

/** CRLF to LF, leading blank lines and trailing whitespace dropped; indentation of the first text line stays. */
const norm = (s: string): string => s.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();

/** A frame tag inside a body is written as text (`&lt;/document>`), so a body cannot close or open a section. */
const escBody = (s: string): string => s.replace(FRAME_TAG, '&lt;$1$2');

function escAttr(value: string, field: string): string {
  if (/[\r\n]/.test(value)) throw new FrameSpecError('frame-attr-newline', `${field} holds a newline`);
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The one place every document passes through. A `hand-back`, `retrieved` or `tool` document renders its `kind`
 * attribute; `source` and no kind render none. With a `sink` and a screened kind it also pushes
 * `{ ref: '<path|id>=<value>', kind, text }` (the normalised body) for the caller to screen; the returned string never
 * depends on the sink.
 */
function renderDocument(doc: any, sink?: Array<{ ref: string, kind: string, text: string }>): string {
  const name = doc.path !== undefined ? 'path' : 'id';
  const body = norm(doc.text);
  const screened = SCREENED_KINDS.includes(doc.kind);
  if (sink && screened) sink.push({ ref: `${name}=${doc[name]}`, kind: doc.kind, text: body });
  const kind = screened ? ` kind="${doc.kind}"` : '';
  return `<document ${name}="${escAttr(String(doc[name]), name)}"${kind}>\n${escBody(body)}\n</document>`;
}

const fail = (code: string, detail: string): never => { throw new FrameSpecError(code, detail); };
const isObject = (v: any): boolean => v !== null && typeof v === 'object' && !Array.isArray(v);

function onlyKeys(value: any, allowed: string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail('frame-unknown-key', `${where}${key} is not a frame field`);
}

function text(value: any, field: string): string {
  return typeof value === 'string' ? value : fail('frame-value-dropped', `${field} is not a string`);
}

/** A required string: present and saying something. */
function required(value: any, field: string): string {
  if (typeof value !== 'string' || isEmptyBody(value)) fail('frame-required-missing', `${field} is required and not empty`);
  return norm(value);
}

type Item = { i: number, value: string };

/** The kept items of a string list, each with its position in the list given; the empty ones are named in `omitted`. */
function items(list: any, field: string, omitted: string[]): Item[] {
  if (list === undefined) return [];
  if (!Array.isArray(list)) return fail('frame-value-dropped', `${field} is not a list`);
  const kept: Item[] = [];
  list.forEach((entry: any, i: number) => {
    if (isEmptyBody(text(entry, `${field}[${i}]`))) omitted.push(`${field}[${i}]`);
    else kept.push({ i, value: norm(entry) });
  });
  return kept;
}

function normalize(spec: any, omitted: string[]): any {
  if (!isObject(spec)) fail('frame-required-missing', 'the spec is not an object');
  onlyKeys(spec, TOP_KEYS, '');
  if (spec.instructions !== undefined) {
    if (!isObject(spec.instructions)) fail('frame-required-missing', 'instructions is not an object');
    onlyKeys(spec.instructions, INSTRUCTION_KEYS, 'instructions.');
    if (Array.isArray(spec.instructions.constraints)) {
      spec.instructions.constraints.forEach((block: any, i: number) => { if (isObject(block)) onlyKeys(block, BLOCK_KEYS, `instructions.constraints[${i}].`); });
    }
  }
  if (spec.output_format !== undefined && isObject(spec.output_format)) onlyKeys(spec.output_format, FORMAT_KEYS, 'output_format.');
  if (Array.isArray(spec.input)) spec.input.forEach((doc: any, i: number) => { if (isObject(doc)) onlyKeys(doc, DOC_KEYS, `input[${i}].`); });
  for (const name of REQUIRED) if (spec[name] === undefined) fail('frame-required-missing', `${name} is required`);

  const n: any = { header: [], context: [], input: [], example: null, role: null };

  if (spec.header !== undefined) {
    if (!Array.isArray(spec.header)) fail('frame-header-invalid', 'header is not a list of [key, value] pairs');
    for (const pair of spec.header) {
      if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== 'string' || typeof pair[1] !== 'string') fail('frame-header-invalid', 'a header entry is not a [key, value] pair');
      const [key, value] = [pair[0], pair[1].trim()];
      if (!HEADER_KEY.test(key)) fail('frame-header-invalid', `header key '${key}' is not a capitalised word group of at most 32 letters`);
      if (value === '' || /[\r\n]/.test(value)) fail('frame-header-invalid', `header '${key}' needs a one-line value`);
      n.header.push([key, value]);
    }
  }

  if (spec.role !== undefined) {
    if (typeof spec.role !== 'string') fail('frame-role-not-sentence', 'role is not a string');
    if (isEmptyBody(spec.role)) omitted.push('role');
    else {
      const role = norm(spec.role);
      const body = role.slice(0, -1);
      if (!role.startsWith('You are ') || !role.endsWith('.') || /\n/.test(role) || /[.!?]\s+\S/.test(body)) {
        fail('frame-role-not-sentence', 'role is one sentence: it starts "You are ", ends with one ".", on one line');
      }
      n.role = role;
    }
  }

  if (typeof spec.context === 'string') {
    if (isEmptyBody(spec.context)) omitted.push('context');
    else n.context = [{ i: 0, value: norm(spec.context) }];
  } else if (spec.context !== undefined) n.context = items(spec.context, 'context', omitted);
  if (spec.context !== undefined && n.context.length === 0 && !omitted.includes('context')) omitted.push('context');

  if (spec.input !== undefined) {
    if (!Array.isArray(spec.input)) fail('frame-value-dropped', 'input is not a list');
    spec.input.forEach((doc: any, i: number) => {
      if (!isObject(doc)) fail('frame-document-source', `input[${i}] is not a document`);
      if ((doc.path !== undefined) === (doc.id !== undefined)) fail('frame-document-source', `input[${i}] needs exactly one of path and id`);
      const name = doc.path !== undefined ? 'path' : 'id';
      if (typeof doc[name] !== 'string' || doc[name].trim() === '') fail('frame-document-source', `input[${i}].${name} is not a non-empty string`);
      if (doc.kind !== undefined && !DOC_KINDS.includes(doc.kind)) fail('frame-document-source', `input[${i}].kind is ${DOC_KINDS.join(', ')}`);
      if (doc.keep !== undefined && typeof doc.keep !== 'boolean') fail('frame-document-source', `input[${i}].keep is true or false`);
      escAttr(doc[name], `input[${i}].${name}`);
      const body = text(doc.text, `input[${i}].text`);
      if (doc.keep === true ? body.trim() === '' : isEmptyBody(body)) omitted.push(`input.document[${i}]`);
      else n.input.push({ i, doc: { [name]: doc[name], ...(doc.kind === undefined ? {} : { kind: doc.kind }), text: norm(doc.text) } });
    });
    if (n.input.length === 0) omitted.push('input');
  }

  const ins = spec.instructions;
  n.instructions = {
    outcome: required(ins.outcome, 'instructions.outcome'),
    success: items(ins.success, 'instructions.success', omitted),
    steps: items(ins.steps, 'instructions.steps', omitted),
    stop: required(ins.stop, 'instructions.stop'),
    constraints: [],
  };
  if (ins.constraints !== undefined) {
    if (!Array.isArray(ins.constraints)) fail('frame-value-dropped', 'instructions.constraints is not a list');
    ins.constraints.forEach((block: any, i: number) => {
      const where = `instructions.constraints[${i}]`;
      if (!isObject(block)) fail('frame-value-dropped', `${where} is not a block`);
      const heading = text(block.heading, `${where}.heading`).trim();
      if (heading === '' || /[\r\n]/.test(heading)) fail('frame-header-invalid', `${where}.heading needs a one-line heading`);
      const lines = Array.isArray(block.body) ? items(block.body, `${where}.body`, omitted) : null;
      const body = lines ? null : isEmptyBody(text(block.body, `${where}.body`)) ? null : norm(block.body);
      if (lines ? lines.length === 0 : body === null) {
        // The `.body[j]` names added above for a list say which lines were empty; the block is named too.
        omitted.push(where);
      } else n.instructions.constraints.push({ i, heading, body, lines });
    });
  }

  if (spec.example !== undefined) {
    if (isEmptyBody(text(spec.example, 'example'))) omitted.push('example');
    else n.example = norm(spec.example);
  }

  const of = spec.output_format;
  if (!isObject(of)) fail('frame-required-missing', 'output_format is not an object');
  if (of.budgetLines !== undefined && !(Number.isInteger(of.budgetLines) && of.budgetLines > 0)) fail('frame-budget-invalid', 'output_format.budgetLines is a positive integer');
  n.output_format = { reader: required(of.reader, 'output_format.reader'), budgetLines: of.budgetLines, lines: items(of.lines, 'output_format.lines', omitted) };
  return n;
}

/** The renderers, one per piece. A caller of `renderWith` may replace any of them. */
const RENDERERS: Record<string, (value: any, r: any) => any> = {
  header: (pairs: any[]) => pairs.map(([k, v]) => `${k}: ${escBody(v)}`).join('\n'),
  role: (role: string) => `<role>\n${escBody(role)}\n</role>`,
  context: (lines: Item[]) => `<context>\n${lines.map((l) => escBody(l.value)).join('\n')}\n</context>`,
  document: (entry: any) => renderDocument(entry.doc),
  input: (docs: any[], r: any) => `<input>\n${docs.map((d) => r.document(d, r)).filter(Boolean).join('\n')}\n</input>`,
  constraint: (block: any) => `## ${escBody(block.heading)}\n${block.lines ? block.lines.map((l: Item) => `- ${escBody(l.value).replace(/\n/g, '\n  ')}`).join('\n') : escBody(block.body)}`,
  instructions: (ins: any, r: any) => {
    const pieces = [escBody(ins.outcome)];
    if (ins.success.length) pieces.push(`## Success criteria\n${ins.success.map((s: Item) => `- ${escBody(s.value).replace(/\n/g, '\n  ')}`).join('\n')}`);
    for (const block of ins.constraints) pieces.push(r.constraint(block, r));
    if (ins.steps.length) pieces.push(`## Steps\n${ins.steps.map((s: Item, k: number) => `${k + 1}. ${escBody(s.value).replace(/\n/g, '\n   ')}`).join('\n')}`);
    pieces.push(`## Stop rule\n${escBody(ins.stop)}`);
    return `<instructions>\n${pieces.filter(Boolean).join('\n\n')}\n</instructions>`;
  },
  example: (example: string) => `<example>\n${escBody(example)}\n</example>`,
  output_format: (of: any) => {
    const lines = [`${escBody(of.reader)} reads this reply; put the conclusion first.`];
    if (of.budgetLines !== undefined) lines.push(`Keep it to at most ${of.budgetLines} lines.`);
    lines.push(...of.lines.map((l: Item) => escBody(l.value)));
    return `<output_format>\n${lines.join('\n')}\n</output_format>`;
  },
};

/** Every non-empty string the caller supplied, in the form the text must hold it: [field, string, whole]. */
function expected(n: any): Array<[string, string, boolean]> {
  const out: Array<[string, string, boolean]> = [];
  for (const [k, v] of n.header) out.push([`header.${k}`, `${k}: ${escBody(v)}`, true]);
  if (n.role) out.push(['role', escBody(n.role), true]);
  for (const l of n.context) out.push([`context[${l.i}]`, escBody(l.value), true]);
  for (const { i, doc } of n.input) {
    const name = doc.path !== undefined ? 'path' : 'id';
    out.push([`input.document[${i}]`, ` ${name}="${escAttr(doc[name], name)}"`, true]);
    out.push([`input.document[${i}]`, escBody(doc.text), true]);
  }
  const ins = n.instructions;
  out.push(['instructions.outcome', escBody(ins.outcome), true], ['instructions.stop', escBody(ins.stop), true]);
  for (const s of ins.success) out.push([`instructions.success[${s.i}]`, escBody(s.value), false]);
  for (const s of ins.steps) out.push([`instructions.steps[${s.i}]`, escBody(s.value), false]);
  for (const b of ins.constraints) {
    out.push([`instructions.constraints[${b.i}]`, `## ${escBody(b.heading)}`, true]);
    if (b.lines) for (const l of b.lines) out.push([`instructions.constraints[${b.i}].body[${l.i}]`, escBody(l.value), false]);
    else out.push([`instructions.constraints[${b.i}].body`, escBody(b.body), true]);
  }
  if (n.example) out.push(['example', escBody(n.example), true]);
  out.push(['output_format.reader', escBody(n.output_format.reader), true]);
  for (const l of n.output_format.lines) out.push([`output_format.lines[${l.i}]`, escBody(l.value), false]);
  return out;
}

/**
 * `composeFrame` with the renderers of the caller's choosing: the test seam of the reverse check, which
 * fails on a renderer that loses a value exactly as it fails on the composer's own bug.
 * @param {*} spec the FrameSpec
 * @param {{maxBytes: number|null}} opts `maxBytes` is required: a number, or null for no bound
 * @param {Object} [renderers] replacements for entries of RENDERERS, by name
 */
function renderWith(spec: any, opts: any, renderers: any = {}): any {
  const bound = opts?.maxBytes;
  if (!isObject(opts) || !('maxBytes' in opts) || !(bound === null || (Number.isInteger(bound) && bound >= 0))) {
    fail('frame-opts-bound', 'opts.maxBytes is required: a non-negative integer, or null for no bound');
  }
  const omitted: string[] = [];
  const n = normalize(spec, omitted);
  const screen: Array<{ field: string, ref: string, kind: string, text: string }> = [];
  const document = (entry: any) => {
    const hits: Array<{ ref: string, kind: string, text: string }> = [];
    const rendered = renderDocument(entry.doc, hits);
    for (const hit of hits) screen.push({ field: `input.document[${entry.i}]`, ...hit });
    return rendered;
  };
  const r = { ...RENDERERS, document, ...renderers };
  const pieces = [
    n.header.length ? r.header(n.header, r) : null,
    n.role ? r.role(n.role, r) : null,
    n.context.length ? r.context(n.context, r) : null,
    n.input.length ? r.input(n.input, r) : null,
    r.instructions(n.instructions, r),
    n.example ? r.example(n.example, r) : null,
    r.output_format(n.output_format, r),
  ];
  const out = `${pieces.filter(Boolean).join('\n\n')}\n`;
  for (const [field, value, whole] of expected(n)) {
    const kept = whole ? out.includes(value) : value.split('\n').every((line) => line === '' || out.includes(line));
    if (!kept) fail('frame-value-dropped', `${field} was supplied and is not in the text`);
  }
  const bytes = Buffer.byteLength(out);
  if (bound !== null && bytes > bound) return { ok: false, code: 'frame-too-large', bytes, maxBytes: bound };
  return { ok: true, text: out, bytes, omitted, screen };
}

/**
 * Composes one prompt from a spec.
 * @param {*} spec the FrameSpec (design §5.1)
 * @param {{maxBytes: number|null}} opts
 * @returns {{ok: true, text: string, bytes: number, omitted: string[], screen: Array<{field: string, ref: string, kind: string, text: string}>} | {ok: false, code: 'frame-too-large', bytes: number, maxBytes: number}}
 * @throws {FrameSpecError} for a spec that cannot be rendered
 */
function composeFrame(spec: any, opts: any): any {
  return renderWith(spec, opts, {});
}

module.exports = { composeFrame, renderWith, renderDocument, isEmptyBody, SCREENED_KINDS, SECTIONS, REQUIRED, FRAME_TAG, FrameSpecError };
