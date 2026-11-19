'use strict';

/**
 * The `prompt-frame` verb (row 173, IC-002): composes one prompt from a spec through the one composer
 * in frame.ts, or prints the guide that says how to fill it. `render` takes the spec whole
 * (`--spec-file`) or in parts by path (`--part <key>=<file>`), so a shell script never has to put text
 * into a command line or a JSON document: the files are read here.
 */

const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../helper/repo-root.ts');
const { finishRuntime, usageError, EXIT } = require('../cli-result.ts');
const { composeFrame, FrameSpecError } = require('./frame.ts');

const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const GUIDE = path.join('core', 'shared', 'guidance', 'references', 'PROMPT_FRAME.md');
const DOC_KEY = /^input\.doc:(path|id)=(.+?)(?:;kind=(source|hand-back|retrieved|tool))?$/;
// The key of an `input.doc:` part holds its own `=` (`path=<rel>`, `id=<id>`), so the file begins at the first `=`
// after that value (and after `;kind=...`); a document path or id therefore holds no `=`. Any other key ends at the first `=`.
const DOC_PART = /^input\.doc:(?:path|id)=[^=]+?(?:;kind=(?:source|hand-back|retrieved|tool))?(?==)/;
const CONSTRAINT_PREFIX = 'instructions.constraint:';

/** Reads one input file as UTF-8 text, at most 4 MiB; `code` names the failure for the error shape. */
function readInput(file: string, code: string, cwd: string): string {
  const target = path.resolve(cwd, file);
  try {
    if (fs.statSync(target).size > MAX_INPUT_BYTES) throw new Error('larger than 4 MiB');
    return fs.readFileSync(target, 'utf8');
  } catch (error: any) {
    throw new FrameSpecError(code, `${file}: ${error?.code || error?.message || 'unreadable'}`);
  }
}

class PartUsage extends Error {}

const lines = (body: string): string[] => body.split(/\r?\n/).filter((line) => line.trim() !== '');

/**
 * The FrameSpec of a list of `<key>=<file>` parts. The file is whatever follows the key's end (the first `=`, or for
 * `input.doc:` the first `=` after its path or id and `;kind=`), so a file path may hold `=`; the key is
 * one of header, role, context, instructions.outcome|success|steps|stop, instructions.constraint:<Heading>
 * (repeatable), example, output_format.reader|lines, input.doc:path=<rel>|input.doc:id=<id>[;kind=hand-back|retrieved|tool]
 * (repeatable). Unknown keys and empty parts are the composer's to refuse, as for a spec file.
 */
function specFromParts(parts: string[], { budgetLines, cwd }: { budgetLines?: number, cwd: string }): any {
  const spec: any = {};
  const ins = () => (spec.instructions = spec.instructions || {});
  const fmt = () => (spec.output_format = spec.output_format || {});
  const seen = new Set<string>();
  for (const part of parts) {
    const cut = part.match(DOC_PART)?.[0].length ?? part.indexOf('=');
    if (cut < 1 || cut === part.length - 1) throw new PartUsage(`--part expects <key>=<file>, got '${part}'`);
    const key = part.slice(0, cut);
    const body = () => readInput(part.slice(cut + 1), 'frame-part-unreadable', cwd);
    const once = () => { if (seen.has(key)) throw new PartUsage(`--part ${key} is given once`); seen.add(key); };
    const doc = key.match(DOC_KEY);
    if (doc) {
      (spec.input = spec.input || []).push({ [doc[1]]: doc[2], ...(doc[3] ? { kind: doc[3] } : {}), text: body() });
    } else if (key.startsWith('input.doc:')) {
      throw new FrameSpecError('frame-document-source', `--part ${key} is input.doc:path=<rel> or input.doc:id=<id>, then ;kind=source|hand-back|retrieved|tool`);
    } else if (key.startsWith(CONSTRAINT_PREFIX)) {
      (ins().constraints = ins().constraints || []).push({ heading: key.slice(CONSTRAINT_PREFIX.length), body: body() });
    } else {
      once();
      switch (key) {
        case 'header': spec.header = lines(body()).map((line) => {
          const colon = line.indexOf(':');
          if (colon < 1) throw new FrameSpecError('frame-header-invalid', `header line '${line}' is Key: value`);
          return [line.slice(0, colon), line.slice(colon + 1).trim()];
        }); break;
        case 'role': spec.role = body(); break;
        case 'context': spec.context = lines(body()); break;
        case 'example': spec.example = body(); break;
        case 'instructions.outcome': ins().outcome = body(); break;
        case 'instructions.success': ins().success = lines(body()); break;
        case 'instructions.steps': ins().steps = lines(body()); break;
        case 'instructions.stop': ins().stop = body(); break;
        case 'output_format.reader': fmt().reader = body(); break;
        case 'output_format.lines': fmt().lines = lines(body()); break;
        default: throw new FrameSpecError('frame-unknown-key', `--part ${key} is not a frame part`);
      }
    }
  }
  if (budgetLines !== undefined) fmt().budgetLines = budgetLines;
  return spec;
}

/** Prints `payload` where the caller reads it: stdout under `--json`, else one JSON line on stderr. */
function report(payload: any, exit: number, json: boolean): number {
  if (json) console.log(JSON.stringify(payload));
  else console.error(JSON.stringify(payload));
  return finishRuntime(exit);
}

const specInvalid = (error: any, json: boolean) => report({ error: 'frame-spec-invalid', code: error.code, detail: error.detail }, EXIT.USAGE, json);

function render({ specFile, parts, budgetLines, maxBytes, out, json, cwd }: any): number {
  if (specFile && parts?.length) return usageError('prompt-frame', '--spec-file and --part are two ways to give the same spec; use one', json);
  if (!specFile && !parts?.length) return usageError('prompt-frame', '--action render needs --spec-file <json> or one or more --part <key>=<file>', json);
  if (specFile && budgetLines !== undefined) return usageError('prompt-frame', '--budget-lines goes with --part; a spec file states budgetLines itself', json);
  if (maxBytes !== undefined && !/^\d+$/.test(String(maxBytes))) return usageError('prompt-frame', `--max-bytes expects a non-negative integer, got '${maxBytes}'`, json);
  let result: any;
  try {
    let spec: any;
    if (specFile) {
      try { spec = JSON.parse(readInput(specFile, 'frame-spec-unreadable', cwd)); } catch (error: any) {
        if (error instanceof FrameSpecError) throw error;
        throw new FrameSpecError('frame-spec-json', `${specFile}: ${error.message}`);
      }
    } else spec = specFromParts(parts, { budgetLines, cwd });
    result = composeFrame(spec, { maxBytes: maxBytes === undefined ? null : Number(maxBytes) });
  } catch (error: any) {
    if (error instanceof PartUsage) return usageError('prompt-frame', error.message, json);
    if (error instanceof FrameSpecError) return specInvalid(error, json);
    throw error;
  }
  if (!result.ok) return report({ error: result.code, bytes: result.bytes, maxBytes: result.maxBytes }, EXIT.OVERFLOW, json);
  if (out) {
    const target = path.resolve(cwd, out);
    const temp = `${target}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, result.text);
      fs.renameSync(temp, target);
    } catch (error: any) {
      fs.rmSync(temp, { force: true });
      console.error(`doflow prompt-frame: cannot write ${out}: ${error.message}`);
      return finishRuntime(EXIT.EMPTY);
    }
    if (json) console.log(JSON.stringify({ path: target, bytes: result.bytes, omitted: result.omitted }));
  } else if (json) console.log(JSON.stringify({ text: result.text, bytes: result.bytes, omitted: result.omitted }));
  else process.stdout.write(result.text);
  return finishRuntime(EXIT.OK);
}

function guide({ repoRoot, json }: any): number {
  const file = path.join(repoRoot, GUIDE);
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch {
    return report({ error: 'frame-guide-missing', path: GUIDE }, EXIT.EMPTY, json);
  }
  process.stdout.write(content);
  return finishRuntime(EXIT.OK);
}

/**
 * @param {Object} input
 * @param {string} [input.action] render | guide
 * @param {string} [input.specFile] render: the spec as a JSON file
 * @param {string[]} [input.parts] render: `<key>=<file>` parts, instead of a spec file
 * @param {number} [input.budgetLines] render, with parts: the line budget of the reply
 * @param {string} [input.maxBytes] render: refuse a frame larger than this many bytes (exit 3)
 * @param {string} [input.out] render: write the frame here, by temp file and rename
 * @param {boolean} [input.json]
 * @returns {number} the exit status
 */
function handlePromptFrameCommand({ action, specFile, parts, budgetLines, maxBytes, out, json = false, repoRoot = REPO_ROOT, cwd = process.cwd() }: any = {}): number {
  if (action === 'render') return render({ specFile, parts, budgetLines, maxBytes, out, json, cwd });
  if (action === 'guide') return guide({ repoRoot, json });
  return usageError('prompt-frame', `--action is render or guide${action ? `, got '${action}'` : ''}`, json);
}

module.exports = { handlePromptFrameCommand, specFromParts };
