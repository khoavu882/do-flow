'use strict';

// Workflow diagram build (feature 093, F.1; IC-011, FR-012). Dev only: console/scripts/ is not in the
// package's `files`, and Pele is a devDependency that never ships. For each task class it reads the core's
// `workflow` verb, writes the class as Mermaid text, renders that text with Pele's synchronous `render()`
// (no browser: outside a browser Pele measures text with a built-in width table), checks the SVG, stamps
// the hash of the Mermaid text on it and writes web/diagrams/<class>.svg. Only those files ship, shown with
// <img> (A.1: the page CSP leaves an image document's inline styles alone).
//
//   node console/scripts/build-diagrams.ts [--core <abs path to bin/doflow.js>]    (default: this checkout's bin/doflow.js)
//
// diagrams.test.ts uses the pure functions below (mermaidFor, checkSvg, readStamp) without Pele.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { TASK_CLASSES } = require('../src/routes.ts');

const CONSOLE_ROOT = path.join(__dirname, '..');
const DEFAULT_CORE = path.join(CONSOLE_ROOT, '..', 'bin', 'doflow.js');
const OUT_DIR = path.join(CONSOLE_ROOT, 'web', 'diagrams');
/** IC-011: a diagram above this is a build failure. */
const MAX_SVG_BYTES = 200 * 1024;
/** The XML namespace identifiers an SVG carries; they name no network address. */
const NAMESPACES = ['http://www.w3.org/2000/svg', 'http://www.w3.org/1999/xlink'];
const STAMP = /^<!-- source-sha256: ([0-9a-f]{64}) pele: (\S+) -->\n/;
const GATE_SHAPES: Record<string, [string, string]> = { approval: ['{', '}'], clarification: ['{{', '}}'] };

/** One line of plain label or description text: no quote, angle bracket or brace, which are Mermaid syntax. */
function plain(value: unknown): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().replace(/"/g, "'").replace(/[<>]/g, '').replace(/\{/g, '(').replace(/\}/g, ')');
}

/**
 * IC-011's Mermaid text for one `workflow` body: stages are rounded nodes (an optional stage is dashed
 * through a class), approval gates diamonds, clarification gates hexagons, edges in program order (a stage,
 * then the gates that follow it, then the next stage). The stage list (id, skill and purpose) is also the
 * diagram's accessible description, so the hash covers it: a changed purpose changes the hash.
 */
function mermaidFor(workflow: any): string {
  const lines: string[] = ['flowchart LR', `  accTitle: ${plain(workflow.name)}`, '  accDescr {'];
  workflow.stages.forEach((stage: any, index: number) => {
    lines.push(`    ${index + 1}. ${plain(stage.id)} (${plain(stage.skill)})${stage.optional ? ' [optional]' : ''}: ${plain(stage.purpose)}`);
  });
  lines.push('  }');
  const chain: string[] = [];
  const optional: string[] = [];
  workflow.stages.forEach((stage: any, index: number) => {
    const node = `s${index}`;
    lines.push(`  ${node}("${plain(stage.id)}<br/>${plain(stage.skill)}")`);
    if (stage.optional) optional.push(node);
    chain.push(node);
    (stage.gatesAfter ?? []).forEach((gate: any, position: number) => {
      const shape = GATE_SHAPES[gate.kind];
      if (!shape) throw new Error(`build-diagrams: ${workflow.taskClass}: gate ${gate.id} has the unknown kind ${JSON.stringify(gate.kind)}`);
      const id = `g${index}_${position}`;
      lines.push(`  ${id}${shape[0]}"${plain(gate.id)}<br/>${plain(gate.name)}"${shape[1]}`);
      chain.push(id);
    });
  });
  lines.push(`  ${chain.join(' --> ')}`);
  if (optional.length > 0) {
    lines.push('  classDef optional stroke-dasharray:5 3');
    lines.push(`  class ${optional.join(',')} optional`);
  }
  return `${lines.join('\n')}\n`;
}

function sourceHash(mermaid: string): string {
  return crypto.createHash('sha256').update(mermaid, 'utf8').digest('hex');
}

/** `{ hash, pele }` from the first line of a shipped diagram, or null when the stamp is missing or malformed. */
function readStamp(svgFileText: string): { hash: string, pele: string } | null {
  const match = STAMP.exec(svgFileText);
  return match ? { hash: match[1], pele: match[2] } : null;
}

/** IC-011's checks as a list of failures (empty = pass). Runs on the SVG Pele returned and on every shipped file. */
function checkSvg(svg: string): string[] {
  const errors: string[] = [];
  if (Buffer.byteLength(svg, 'utf8') >= MAX_SVG_BYTES) errors.push(`size: ${Buffer.byteLength(svg, 'utf8')} bytes, the bound is under ${MAX_SVG_BYTES}`);
  if (/<script/i.test(svg)) errors.push('script: has a <script element');
  if (/<[^>]*\son[a-z]+\s*=/i.test(svg)) errors.push('event-attribute: has an on* attribute');
  for (const match of svg.matchAll(/\b(?:xlink:)?href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const value = match[1] ?? match[2] ?? '';
    if (!value.startsWith('#')) errors.push(`href: ${JSON.stringify(value)} is not a fragment`);
  }
  let rest = svg;
  for (const namespace of NAMESPACES) rest = rest.split(namespace).join('');
  if (/\b[a-z][a-z0-9+.-]*:\/\//i.test(rest) || /["'(\s]\/\/[^\s"')]/.test(rest)) errors.push('external-url: has a URL or network path');
  for (const match of rest.matchAll(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi)) {
    if (!match[2].startsWith('#')) errors.push(`css-url: url(${JSON.stringify(match[2])}) is not a fragment`);
  }
  if (/@import/i.test(rest)) errors.push('css-import: has @import');
  return errors;
}

/** The core's `workflow` body for one class, spawned against `core` with a scratch HOME. Throws when the verb fails. */
function readWorkflow(core: string, taskClass: string): any {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-ui-diagrams-'));
  try {
    const run = spawnSync(process.execPath, [core, 'workflow', '--task-class', taskClass, '--json'], {
      cwd: home, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config') },
    });
    if (run.status !== 0) throw new Error(`build-diagrams: workflow --task-class ${taskClass} exited ${run.status}: ${String(run.stderr || run.stdout).slice(0, 300)}`);
    return JSON.parse(run.stdout);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

/** Pele is loaded by name at run time (it is ESM and a devDependency), so this file type-checks before it is installed. */
async function loadPele(): Promise<{ render: (source: string, options?: Record<string, unknown>) => { svg: string }, version: string }> {
  const name = 'pele';
  const pele: any = await import(name);
  const manifest = JSON.parse(fs.readFileSync(path.join(CONSOLE_ROOT, 'node_modules', name, 'package.json'), 'utf8'));
  return { render: pele.render, version: manifest.version };
}

async function main(argv: readonly string[]): Promise<number> {
  let core = DEFAULT_CORE;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--core' && argv[index + 1] !== undefined) { core = argv[index + 1]; index += 1; }
    else { console.error('usage: build-diagrams.ts [--core <absolute path to bin/doflow.js>]'); return 2; }
  }
  if (!path.isAbsolute(core)) { console.error('build-diagrams: --core must be an absolute path'); return 2; }
  const { render, version } = await loadPele();
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const taskClass of TASK_CLASSES as string[]) {
    const mermaid = mermaidFor(readWorkflow(core, taskClass));
    // idPrefix keeps element ids unique and the output a pure function of the text.
    const { svg } = render(mermaid, { idPrefix: taskClass });
    const errors = checkSvg(svg);
    if (errors.length > 0) throw new Error(`build-diagrams: ${taskClass}: ${errors.join('; ')}`);
    fs.writeFileSync(path.join(OUT_DIR, `${taskClass}.svg`), `<!-- source-sha256: ${sourceHash(mermaid)} pele: ${version} -->\n${svg}\n`);
    console.log(`${taskClass}.svg ${Buffer.byteLength(svg, 'utf8')} bytes`);
  }
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => { console.error(error.message); process.exit(1); });
}

module.exports = { MAX_SVG_BYTES, OUT_DIR, DEFAULT_CORE, mermaidFor, sourceHash, readStamp, checkSvg, readWorkflow };
