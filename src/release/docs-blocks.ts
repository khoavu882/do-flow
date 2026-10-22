'use strict';

// ── Generated documentation blocks (087b IC-001, IC-002, IC-003, IC-009) ─────────────────────────
//
// Every table whose truth already lives in a registry or in a help text is written into the docs
// between a pair of marker lines, and docs/llms.txt is written whole from the mkdocs.yml nav and
// each nav page's front-matter `description`. Run directly by Node native type-stripping:
//
//   node src/release/docs-blocks.ts --write   rewrite every block span and docs/llms.txt
//   node src/release/docs-blocks.ts --check   write nothing; exit 0 current, 1 findings, 2 usage
//
// A marker pair is `<!-- BEGIN GENERATED:<id> -->` / `<!-- END GENERATED:<id> -->`, each on its own
// line; the span between them is the renderer's output plus one newline, and text outside a span is
// never touched. BLOCKS below is the only list of block ids; the docs guard (G61) derives
// everything from it. Every function takes a repo-shaped `root` so a test can seed a fault in a
// copy. Output depends on no clock, version, locale or terminal width.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { REPO_ROOT } = require('../helper/repo-root.ts');
const { renderEnforcementMatrix, renderBehaviourMatrix } = require('../lifecycle/coverage.ts');
const { loadSettingsRegistry } = require('../runtime/settings/registry.ts');
const { REF_META } = require('../runtime/settings/refs.ts');

const LLMS_CAP = 4096;
const MARKER_ID = /^[a-z][a-z0-9-]*$/;
// A marker is a whole line in exactly this form. MARKER_LIKE also finds one with indentation or
// trailing white space (or a CR), so markerFindings can report a mangled marker instead of passing it.
const MARKER_LINE = /^<!-- (BEGIN|END) GENERATED:(\S+) -->$/gm;
const MARKER_LIKE = /^[ \t]*<!-- (BEGIN|END) GENERATED:(\S+) -->[ \t\r]*$/gm;
const USAGE = 'usage: node src/release/docs-blocks.ts --write|--check\n';
const DOFLOW_BIN = 'bin/doflow.js';
const DOFLOW_RUN_BIN = 'core/shared/scripts/doflow/bin/doflow-run';

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

// Display labels for capability keys; a key without a label is shown capitalized, so a capability
// added to the registry still gets its row.
const CAPABILITY_LABELS: Record<string, string> = {
  instructions: 'Instructions', skills: 'Skills', agents: 'Agents', scripts: 'Scripts', templates: 'Templates',
  modes: 'Modes', settings: 'Settings', hooks: 'Hooks', mcp: 'MCP', plugin: 'Plugin / extension',
};

type Finding = { page: string; id: string; kind: 'stale' | 'orphan' | 'missing' | 'source-unreadable' | 'over-cap'; detail?: string };
type Block = { id: string; page: string; sources: string[]; render: (root: string) => string };

function readJson(root: string, rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

// ── Cell text ─────────────────────────────────────────────────────────────────────────────────────
//
// Every value that reaches a table comes from a registry or a help text. `text()` turns it into
// literal cell text: line breaks become spaces (a newline would end the row); `&`, `<` and `>` become
// entities (else a `<plan path>` operand vanishes as a tag and a `<script>` runs); and a backslash goes
// before `\`, a backtick, `|`, `[`, `]`, `(`, `)`, `!`, `*` and `_` (else a pipe splits the row, a
// backtick opens a code span, and `[x](y)`, `![x](y)`, `*x*` or `_x_` render as a live link, an image
// or emphasis). Python-Markdown and GitHub both read those backslash escapes as the literal character.
// `code()` wraps a value in a code span only when it holds no pipe, backtick or line break (inside a
// code span nothing is interpreted), and otherwise falls back to `text()`. A marker line can never
// appear inside a cell: a cell is part of a `|` row and markers are whole lines.

function oneLine(value: unknown): string {
  return String(value ?? '').replace(/\r?\n|\r/g, ' ');
}

/** Plain cell text with Markdown and HTML made inert; empty is shown as an em dash. */
function text(value: unknown): string {
  const raw = oneLine(value);
  if (raw === '') return '—';
  return raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\\/g, '\\\\')
    .replace(/[`|[\]()!*_]/g, (character) => `\\${character}`);
}

/** A value as a code span; one holding a pipe, backtick or line break is shown as plain text. */
function code(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  const raw = String(value);
  return /[|`\r\n]/.test(raw) ? text(raw) : `\`${raw}\``;
}

/** Headers go through `text()`; row cells are already formatted by `text()` or `code()`. */
function table(headers: string[], rows: string[][]): string {
  return [
    `| ${headers.map(text).join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.join(' | ')} |`),
  ].join('\n');
}

/** A copy of registry data with every string made inert, for renderers that format cells themselves. */
function inert(value: any): any {
  if (typeof value === 'string') return value === '' ? value : text(value);
  if (Array.isArray(value)) return value.map(inert);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, inert(entry)]));
  return value;
}

function capitalize(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

// ── Renderers (one pure function of the root per block id) ──────────────────────────────────────

function renderCapabilityMatrix(root: string): string {
  const harnesses = readJson(root, 'core/registry/harnesses.json').harnesses;
  if (!Array.isArray(harnesses) || harnesses.length === 0) throw new Error('harnesses.json has no harnesses');
  const keys = Object.keys(harnesses[0].capabilities || {});
  if (keys.length === 0) throw new Error('harnesses.json declares no capabilities');
  const status = (harness: any, key: string): string => {
    const value = harness.capabilities?.[key]?.status;
    if (typeof value !== 'string' || !value) return '—';
    const target = harness.nativeTargets?.[key];
    const label = text(capitalize(value));
    return target && (value === 'supported' || value === 'different') ? `${label} — ${code(target)}` : label;
  };
  return table(
    ['Capability', ...harnesses.map((harness: any) => oneLine(harness.displayName))],
    keys.map((key) => [text(CAPABILITY_LABELS[key] || capitalize(key)), ...harnesses.map((harness: any) => status(harness, key))]),
  );
}

function renderTaskClasses(root: string): string {
  const classes = readJson(root, 'core/registry/workflows.json').classes;
  const templates = new Set(Object.keys(readJson(root, 'core/registry/readiness-templates.json').templates || {}));
  if (!classes || typeof classes !== 'object' || Object.keys(classes).length === 0) throw new Error('workflows.json has no classes');
  return table(['Class', 'Stages', 'Gates', 'Readiness'], Object.entries(classes).map(([id, workflow]: [string, any]) => {
    const gates = Array.isArray(workflow.gates) ? workflow.gates.length : 0;
    const template = workflow.stages.find((stage: any) => stage.readinessTemplate)?.readinessTemplate;
    return [
      code(id),
      text(workflow.stages.map((stage: any) => stage.id).join(' → ')),
      gates ? String(gates) : '—',
      templates.has(template) ? code(template) : '—',
    ];
  }));
}

// The Default cell shows the resolved default: a `defaultRef` (the advice endpoint, the retention
// window) is resolved through the settings registry exactly as G44 S2 resolves it.
function resolvedDefault(key: string, spec: any, registry: any, resolving: Set<string> = new Set()): unknown {
  if (Object.hasOwn(spec, 'default')) return spec.default;
  if (!spec.defaultRef || resolving.has(key)) return undefined;
  const next = new Set(resolving).add(key);
  const dependencies = new Set<string>(REF_META[spec.defaultRef]?.dependsOn || []);
  for (const requirement of Array.isArray(spec.requires) ? spec.requires : []) {
    if (typeof requirement?.key === 'string') dependencies.add(requirement.key);
  }
  const deps: Record<string, unknown> = {};
  for (const dependency of dependencies) {
    const dependencySpec = registry.keys.get(dependency);
    if (dependencySpec) deps[dependency] = resolvedDefault(dependency, dependencySpec, registry, next);
  }
  return registry.resolveRef(spec.defaultRef, deps);
}

function renderSettingsKeys(root: string): string {
  // Passing the file system bypasses the loader's per-process cache, so a changed registry is read.
  const loaded = loadSettingsRegistry({ repoRoot: root, fsImpl: fs, verifyRefs: true });
  if (!loaded.ok) throw new Error(loaded.detail);
  const raw = readJson(root, 'core/registry/settings.json');
  return table(['Key', 'Type', 'Default', 'Scope', 'Env', 'Legacy file', 'Description'], Object.entries(raw.keys).map(([key, spec]: [string, any]) => [
    code(key),
    text(spec.type),
    code(resolvedDefault(key, spec, loaded.registry)),
    text(spec.scope),
    code(spec.env?.name),
    code([...new Set((spec.legacy || []).map((entry: any) => entry.path).filter(Boolean))].join(', ')),
    text(spec.description),
  ]));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

// A command row in both help texts is exactly two spaces, the verb, then two or more spaces before
// the summary; `doflow` may put an argument hint such as `[path]` between the verb and the gap. A
// line indented further continues the row above it and is not read. Any other line in a command
// section that is not blank (a verb with no summary, a single-space gap, a tab, a one-space
// sub-header, an example line naming `doflow` or `doflow-run`) is refused, so a help layout the
// parser does not understand fails loudly instead of dropping a verb from the index.
const HELP_ROW = /^ {2}([a-z][a-z0-9-]*)(?: [^ ].*?)? {2,}(\S.*?)\s*$/;
const NOT_A_VERB = new Set(['doflow', 'doflow-run']);

function unreadable(source: string, line: string): Error {
  return new Error(`${source} --help: cannot read the line ${JSON.stringify(line)}`);
}

function helpRow(line: string, source: string): { verb: string; summary: string } | null {
  if (line.trim() === '') return null;
  if (/^ {3,}\S/.test(line)) return null;
  const match = line.match(HELP_ROW);
  // A summary that starts like an argument hint (`  install  [path]`) means the description is missing.
  if (!match || NOT_A_VERB.has(match[1]) || /^[[<]/.test(match[2])) throw unreadable(source, line);
  return { verb: match[1], summary: match[2] };
}

// `Commands:` ends at a blank line followed by an unindented heading; an unindented line straight
// after a command row is a heading inside the section, which this parser does not read, so it fails.
function parseDoflowHelp(text: string): { verb: string; summary: string }[] {
  const rows: { verb: string; summary: string }[] = [];
  let inCommands = false;
  let afterBlank = false;
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (!inCommands) {
      if (line.trim() === 'Commands:' && /^\S/.test(line)) inCommands = true;
      continue;
    }
    if (line.trim() === '') { afterBlank = true; continue; }
    if (/^\S/.test(line)) {
      if (afterBlank) break;
      throw unreadable(DOFLOW_BIN, line);
    }
    afterBlank = false;
    const row = helpRow(line, DOFLOW_BIN);
    if (row) rows.push(row);
  }
  return rows;
}

// Before the first group heading only unindented prose may appear; after it every unindented line
// is a group heading ending in a colon, and every indented line belongs to the current group.
function parseDoflowRunHelp(text: string): { verb: string; group: string; summary: string }[] {
  const rows: { verb: string; group: string; summary: string }[] = [];
  let group = '';
  let seenGroup = false;
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (/^\S/.test(line)) {
      if (/:$/.test(line)) { group = line.slice(0, -1); seenGroup = true; continue; }
      if (seenGroup) throw unreadable(DOFLOW_RUN_BIN, line);
      continue;
    }
    if (!seenGroup) throw unreadable(DOFLOW_RUN_BIN, line);
    const row = helpRow(line, DOFLOW_RUN_BIN);
    if (row) rows.push({ ...row, group });
  }
  return rows;
}

function helpFailure(source: string, run: any): string {
  const stderr = String(run.stderr || '').trim().split(/\r?\n/).slice(0, 3).join(' / ');
  const why = run.error ? run.error.message : `exit ${run.status === null ? `signal ${run.signal}` : run.status}`;
  return `${source} --help failed (${why})${stderr ? `: ${stderr}` : ''}`;
}

/** Both help texts, captured in a pinned environment; a failed run, an unreadable line or no verb throws. */
function captureHelp(root: string): { doflow: { verb: string; summary: string }[]; doflowRun: { verb: string; group: string; summary: string }[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-docs-blocks-home-'));
  try {
    const env = { PATH: process.env.PATH || '', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1', COLUMNS: '200', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
    const run = (command: string, args: string[]) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    const doflow = run(process.execPath, [path.join(root, DOFLOW_BIN), '--help']);
    if (doflow.error || doflow.status !== 0) throw new Error(helpFailure(DOFLOW_BIN, doflow));
    const doflowRun = run('bash', [path.join(root, DOFLOW_RUN_BIN), '--help']);
    if (doflowRun.error || doflowRun.status !== 0) throw new Error(helpFailure(DOFLOW_RUN_BIN, doflowRun));
    const result = { doflow: parseDoflowHelp(doflow.stdout), doflowRun: parseDoflowRunHelp(doflowRun.stdout) };
    if (result.doflow.length === 0) throw new Error(`${DOFLOW_BIN} --help yielded no command`);
    if (result.doflowRun.length === 0) throw new Error(`${DOFLOW_RUN_BIN} --help yielded no verb`);
    return result;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// Cells hold the bare verb under a header naming the command, so no index row starts with
// "| `doflow <verb>" and a reader that finds a verb's full reference row by that prefix still lands
// on the hand-written row below the index.
function renderCommandIndex(root: string): string {
  const help = captureHelp(root);
  return [
    table(['Command (doflow)', 'Summary'], help.doflow.map((row) => [code(row.verb), text(row.summary)])),
    '',
    table(['Verb (doflow-run)', 'Group', 'Summary'], help.doflowRun.map((row) => [code(row.verb), text(row.group), text(row.summary)])),
  ].join('\n');
}

const BLOCKS: readonly Block[] = Object.freeze([
  { id: 'capability-matrix', page: 'capability-map.md', sources: ['core/registry/harnesses.json'], render: renderCapabilityMatrix },
  { id: 'enforcement-matrix', page: 'capability-map.md', sources: ['core/registry/lifecycle.json'], render: (root: string) => renderEnforcementMatrix(inert(readJson(root, 'core/registry/lifecycle.json').coverage)) },
  { id: 'context-behaviour-matrix', page: 'capability-map.md', sources: ['core/registry/lifecycle.json'], render: (root: string) => renderBehaviourMatrix(inert(readJson(root, 'core/registry/lifecycle.json').coverage)) },
  { id: 'task-classes', page: 'how-doflow-work.md', sources: ['core/registry/workflows.json', 'core/registry/readiness-templates.json'], render: renderTaskClasses },
  { id: 'settings-keys', page: 'settings.md', sources: ['core/registry/settings.json'], render: renderSettingsKeys },
  { id: 'command-index', page: 'reference.md', sources: [DOFLOW_BIN, DOFLOW_RUN_BIN], render: renderCommandIndex },
]);

function renderBlock(id: string, root: string): string {
  const block = BLOCKS.find((candidate) => candidate.id === id);
  if (!block) throw new Error(`unknown generated block: ${id}`);
  return block.render(root);
}

// ── Nav and llms.txt ─────────────────────────────────────────────────────────────────────────────

/** The mkdocs.yml nav as leaf pages in nav order; `section` is the leaf's top-level entry. */
function readNav(root: string): { section: string; title: string; path: string }[] {
  const lines: string[] = fs.readFileSync(path.join(root, 'mkdocs.yml'), 'utf8').split(/\r?\n/);
  const start = lines.findIndex((line) => /^nav:\s*$/.test(line));
  if (start < 0) throw new Error('mkdocs.yml has no nav');
  const pages: { section: string; title: string; path: string }[] = [];
  let topIndent = -1;
  let section = '';
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(/^(\s*)-\s+(.+?):\s*(\S.*?)?\s*$/);
    if (!match) continue;
    const indent = match[1].length;
    if (topIndent < 0) topIndent = indent;
    if (indent === topIndent) section = match[2].trim();
    const target = match[3]?.replace(/^["']|["']$/g, '');
    if (target && target.endsWith('.md')) pages.push({ section, title: match[2].trim(), path: target });
  }
  return pages;
}

function siteUrl(root: string): string {
  const match = fs.readFileSync(path.join(root, 'mkdocs.yml'), 'utf8').match(/^site_url:\s*["']?([^\s"']+)/m);
  if (!match) throw new Error('mkdocs.yml has no site_url');
  return match[1].replace(/\/$/, '');
}

/** The front-matter `description` of a page: the block must open the file. */
function pageDescription(text: string): string | null {
  const front = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!front) return null;
  const line = front[1].split(/\r?\n/).find((entry) => /^description:/.test(entry));
  if (!line) return null;
  let value = line.slice('description:'.length).trim();
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) value = value.slice(1, -1);
  return value || null;
}

/**
 * The llms.txt summary line: the prose is fixed, the facts in it come from their sources (harness
 * names from harnesses.json, the package name and Node range from package.json), so a renamed
 * harness or a new Node floor makes llms.txt stale instead of silently wrong.
 */
function llmsSummary(root: string): string {
  const pkg = readJson(root, 'package.json');
  const names = (readJson(root, 'core/registry/harnesses.json').harnesses || []).map((harness: any) => oneLine(harness.displayName)).filter(Boolean);
  const range = pkg?.engines?.node;
  if (!pkg?.name || names.length === 0 || typeof range !== 'string') throw new Error('package.json name or engines.node, or the harness list, is missing');
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')}, and ${names[names.length - 1]}` : names[0];
  const count = NUMBER_WORDS[names.length] || String(names.length);
  return `> DoFlow is a registry-driven installer (\`npx ${pkg.name}\`) that projects one source of engineering guidance, skills, specialist agents, hooks, and MCP configuration into ${count} AI coding tools: ${list}. It needs Node.js ${range}; a source checkout runs its TypeScript through Node's type stripping, and the npm package ships JavaScript built by \`npm run build:package\`.`;
}

function renderLlms(root: string): string {
  const base = siteUrl(root);
  const sections = new Map<string, string[]>();
  for (const page of readNav(root)) {
    const description = pageDescription(fs.readFileSync(path.join(root, 'docs', page.path), 'utf8'));
    if (!description) throw new Error(`docs/${page.path} has no front-matter description`);
    const url = page.path === 'index.md' ? `${base}/` : `${base}/${page.path.replace(/\.md$/, '')}/`;
    if (!sections.has(page.section)) sections.set(page.section, []);
    sections.get(page.section)!.push(`- [${page.title}](${url}): ${description}`);
  }
  const lines = ['# DoFlow', '', llmsSummary(root), ''];
  for (const [section, entries] of sections) lines.push(`## ${section}`, '', ...entries, '');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ── Check and write ──────────────────────────────────────────────────────────────────────────────

/**
 * Marker findings for one page: a marker id that is malformed, not registered for this page, unpaired
 * (a lone BEGIN or END, an END before its BEGIN, a doubled pair) or nested inside another span is an
 * orphan. Markers are whole lines only, so marker-shaped text inside a table row is never one.
 */
function markerFindings(page: string, text: string): Finding[] {
  const markers = [...text.matchAll(MARKER_LIKE)].map((match) => ({ kind: match[1], id: match[2], index: match.index ?? 0, exact: match[0] === `<!-- ${match[1]} GENERATED:${match[2]} -->` }));
  const bad = new Set<string>(markers.filter((marker) => !marker.exact).map((marker) => marker.id));
  const counts = new Map<string, { begin: number; end: number }>();
  let open: string | null = null;
  for (const marker of markers) {
    const entry = counts.get(marker.id) || { begin: 0, end: 0 };
    if (marker.kind === 'BEGIN') {
      entry.begin += 1;
      if (open !== null) { bad.add(open); bad.add(marker.id); }
      open = marker.id;
    } else {
      entry.end += 1;
      if (open !== marker.id) bad.add(marker.id);
      if (open === marker.id) open = null;
    }
    counts.set(marker.id, entry);
  }
  if (open !== null) bad.add(open);
  const findings: Finding[] = [];
  for (const [id, { begin, end }] of counts) {
    const registered = MARKER_ID.test(id) && BLOCKS.some((block) => block.id === id && block.page === page);
    if (!registered || begin !== 1 || end !== 1 || bad.has(id)) findings.push({ page, id, kind: 'orphan' });
  }
  return findings;
}

/** The text between a block's marker lines, or null when the pair is absent or malformed. */
function spanOf(body: string, id: string): { start: number; end: number } | null {
  // Markers count only as whole lines (MARKER_LINE), never as text inside a line.
  const lines = [...body.matchAll(MARKER_LINE)].filter((match) => match[2] === id);
  if (lines.length !== 2 || lines[0][1] !== 'BEGIN' || lines[1][1] !== 'END') return null;
  const start = (lines[0].index ?? 0) + lines[0][0].length + 1;
  const end = lines[1].index ?? 0;
  return end >= start ? { start, end } : null;
}

function readDoc(root: string, page: string): string | null {
  try { return fs.readFileSync(path.join(root, 'docs', page), 'utf8'); } catch { return null; }
}

/** Every finding for the registered blocks and llms.txt; empty when the docs are current. */
function checkAll(root: string): Finding[] {
  const findings: Finding[] = [];
  const pages = [...new Set(BLOCKS.map((block) => block.page))];
  const texts = new Map(pages.map((page) => [page, readDoc(root, page)]));
  for (const page of pages) {
    const text = texts.get(page);
    if (text !== null && text !== undefined) findings.push(...markerFindings(page, text));
  }
  for (const block of BLOCKS) {
    const text = texts.get(block.page);
    const span = typeof text === 'string' ? spanOf(text, block.id) : null;
    if (!span) {
      if (!findings.some((f) => f.page === block.page && f.id === block.id)) findings.push({ page: block.page, id: block.id, kind: 'missing' });
      continue;
    }
    let expected: string;
    try { expected = block.render(root); } catch (error: any) { findings.push({ page: block.page, id: block.id, kind: 'source-unreadable', detail: error?.message }); continue; }
    if ((text as string).slice(span.start, span.end) !== `${expected}\n`) findings.push({ page: block.page, id: block.id, kind: 'stale' });
  }
  const committed = readDoc(root, 'llms.txt');
  let expected: string | null = null;
  try { expected = renderLlms(root); } catch (error: any) { findings.push({ page: 'llms.txt', id: 'llms.txt', kind: 'source-unreadable', detail: error?.message }); }
  if (committed === null) findings.push({ page: 'llms.txt', id: 'llms.txt', kind: 'missing' });
  else {
    if (expected !== null && committed !== expected) findings.push({ page: 'llms.txt', id: 'llms.txt', kind: 'stale' });
    if (Buffer.byteLength(committed) > LLMS_CAP) findings.push({ page: 'llms.txt', id: 'llms.txt', kind: 'over-cap' });
  }
  if (expected !== null && Buffer.byteLength(expected) > LLMS_CAP && !findings.some((f) => f.id === 'llms.txt' && f.kind === 'over-cap')) {
    findings.push({ page: 'llms.txt', id: 'llms.txt', kind: 'over-cap' });
  }
  return findings;
}

/** Rewrites every well-formed span and llms.txt, then returns what `checkAll` still finds. */
function writeAll(root: string): Finding[] {
  for (const block of BLOCKS) {
    const file = path.join(root, 'docs', block.page);
    const text = readDoc(root, block.page);
    if (text === null || markerFindings(block.page, text).some((f) => f.id === block.id)) continue;
    const span = spanOf(text, block.id);
    if (!span) continue;
    let rendered: string;
    try { rendered = block.render(root); } catch { continue; }
    const next = `${text.slice(0, span.start)}${rendered}\n${text.slice(span.end)}`;
    if (next !== text) fs.writeFileSync(file, next);
  }
  try {
    const llms = renderLlms(root);
    if (readDoc(root, 'llms.txt') !== llms) fs.writeFileSync(path.join(root, 'docs', 'llms.txt'), llms);
  } catch { /* reported by checkAll as source-unreadable */ }
  return checkAll(root);
}

/** The CLI: 0 current (or written clean), 1 findings, 2 usage. */
function main(argv: string[], root: string = REPO_ROOT): number {
  if (argv.length !== 1 || (argv[0] !== '--write' && argv[0] !== '--check')) {
    process.stderr.write(USAGE);
    return 2;
  }
  const findings = argv[0] === '--write' ? writeAll(root) : checkAll(root);
  for (const finding of findings) process.stderr.write(`docs-blocks: ${finding.page}: ${finding.id}: ${finding.kind}${finding.detail ? ` (${oneLine(finding.detail)})` : ''}\n`);
  if (findings.length && argv[0] === '--check') process.stderr.write('docs-blocks: run node src/release/docs-blocks.ts --write, then review the diff\n');
  return findings.length ? 1 : 0;
}

module.exports = { BLOCKS, LLMS_CAP, MARKER_ID, markerFindings, text, code, inert, renderBlock, renderLlms, readNav, captureHelp, pageDescription, checkAll, writeAll, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
