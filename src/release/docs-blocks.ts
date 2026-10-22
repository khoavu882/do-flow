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
const MARKER_LINE = /^<!-- (BEGIN|END) GENERATED:(\S+) -->$/gm;
const USAGE = 'usage: node src/release/docs-blocks.ts --write|--check\n';
const DOFLOW_BIN = 'bin/doflow.js';
const DOFLOW_RUN_BIN = 'core/shared/scripts/doflow/bin/doflow-run';

// The llms.txt summary is prose, not registry data, so it is kept here verbatim (IC-009).
const LLMS_SUMMARY = '> DoFlow is a registry-driven installer (`npx @khoavu882/doflow`) that projects one source of engineering guidance, skills, specialist agents, hooks, and MCP configuration into eight AI coding tools: Claude Code, Codex, Gemini CLI, OpenCode, Pi, GitHub Copilot CLI, Kiro, and Antigravity. It needs Node.js ^22.18.0 || >=24.3.0; the runtime is TypeScript run by Node\'s type-stripping, with no build step.';

// Display labels for capability keys; a key without a label is shown capitalized, so a capability
// added to the registry still gets its row.
const CAPABILITY_LABELS: Record<string, string> = {
  instructions: 'Instructions', skills: 'Skills', agents: 'Agents', scripts: 'Scripts', templates: 'Templates',
  modes: 'Modes', settings: 'Settings', hooks: 'Hooks', mcp: 'MCP', plugin: 'Plugin / extension',
};

type Finding = { page: string; id: string; kind: 'stale' | 'orphan' | 'missing' | 'source-unreadable' | 'over-cap' };
type Block = { id: string; page: string; sources: string[]; render: (root: string) => string };

function readJson(root: string, rel: string): any {
  return JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function cell(value: unknown): string {
  return String(value ?? '—').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function table(headers: string[], rows: unknown[][]): string {
  return [
    `| ${headers.join(' | ')} |`,
    `|${headers.map(() => '---').join('|')}|`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ].join('\n');
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
    const label = capitalize(value);
    return target && (value === 'supported' || value === 'different') ? `${label} — \`${target}\`` : label;
  };
  return table(
    ['Capability', ...harnesses.map((harness: any) => harness.displayName)],
    keys.map((key) => [CAPABILITY_LABELS[key] || capitalize(key), ...harnesses.map((harness: any) => status(harness, key))]),
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
      `\`${id}\``,
      workflow.stages.map((stage: any) => stage.id).join(' → '),
      gates || '—',
      templates.has(template) ? `\`${template}\`` : '—',
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
  const code = (value: unknown) => (value === null || value === undefined || value === '' ? '—' : `\`${value}\``);
  return table(['Key', 'Type', 'Default', 'Scope', 'Env', 'Legacy file', 'Description'], Object.entries(raw.keys).map(([key, spec]: [string, any]) => [
    `\`${key}\``,
    spec.type,
    code(resolvedDefault(key, spec, loaded.registry)),
    spec.scope,
    code(spec.env?.name),
    code([...new Set((spec.legacy || []).map((entry: any) => entry.path).filter(Boolean))].join(', ')),
    spec.description || '—',
  ]));
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
}

// A command line in both help texts is two spaces, the verb, then two or more spaces before the
// summary; `doflow` may put an argument hint such as `[path]` between the verb and the gap.
// Continuation lines are indented further and are not read.
const HELP_ROW = /^ {2}([a-z][a-z0-9-]*)(?: [^ ].*?)? {2,}(\S.*?)\s*$/;

function parseDoflowHelp(text: string): { verb: string; summary: string }[] {
  const rows: { verb: string; summary: string }[] = [];
  let inCommands = false;
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (line.trim() === 'Commands:') { inCommands = true; continue; }
    if (!inCommands) continue;
    if (/^\S/.test(line)) break;
    const match = line.match(HELP_ROW);
    if (match) rows.push({ verb: match[1], summary: match[2] });
  }
  return rows;
}

function parseDoflowRunHelp(text: string): { verb: string; group: string; summary: string }[] {
  const rows: { verb: string; group: string; summary: string }[] = [];
  let group = '';
  for (const line of stripAnsi(text).split(/\r?\n/)) {
    if (/^\S.*:$/.test(line)) { group = line.slice(0, -1); continue; }
    if (!group) continue;
    const match = line.match(HELP_ROW);
    if (match) rows.push({ verb: match[1], group, summary: match[2] });
  }
  return rows;
}

/** Both help texts, captured in a pinned environment; a parse that yields no verb throws. */
function captureHelp(root: string): { doflow: { verb: string; summary: string }[]; doflowRun: { verb: string; group: string; summary: string }[] } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'doflow-docs-blocks-home-'));
  try {
    const env = { PATH: process.env.PATH || '', HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), NO_COLOR: '1', COLUMNS: '200', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' };
    const run = (command: string, args: string[]) => spawnSync(command, args, { cwd: root, env, encoding: 'utf8', timeout: 60_000 });
    const doflow = run(process.execPath, [path.join(root, DOFLOW_BIN), '--help']);
    const doflowRun = run('bash', [path.join(root, DOFLOW_RUN_BIN), '--help']);
    const result = {
      doflow: doflow.status === 0 ? parseDoflowHelp(doflow.stdout) : [],
      doflowRun: doflowRun.status === 0 ? parseDoflowRunHelp(doflowRun.stdout) : [],
    };
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
    table(['`doflow` command', 'Summary'], help.doflow.map((row) => [`\`${row.verb}\``, row.summary])),
    '',
    table(['`doflow-run` verb', 'Group', 'Summary'], help.doflowRun.map((row) => [`\`${row.verb}\``, row.group, row.summary])),
  ].join('\n');
}

const BLOCKS: readonly Block[] = Object.freeze([
  { id: 'capability-matrix', page: 'capability-map.md', sources: ['core/registry/harnesses.json'], render: renderCapabilityMatrix },
  { id: 'enforcement-matrix', page: 'capability-map.md', sources: ['core/registry/lifecycle.json'], render: (root: string) => renderEnforcementMatrix(readJson(root, 'core/registry/lifecycle.json').coverage) },
  { id: 'context-behaviour-matrix', page: 'capability-map.md', sources: ['core/registry/lifecycle.json'], render: (root: string) => renderBehaviourMatrix(readJson(root, 'core/registry/lifecycle.json').coverage) },
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
  const lines = ['# DoFlow', '', LLMS_SUMMARY, ''];
  for (const [section, entries] of sections) lines.push(`## ${section}`, '', ...entries, '');
  return `${lines.join('\n').replace(/\n+$/, '')}\n`;
}

// ── Check and write ──────────────────────────────────────────────────────────────────────────────

/** Marker findings for one page: ids that are malformed, unregistered, unpaired, out of order or doubled. */
function markerFindings(page: string, text: string): Finding[] {
  const counts = new Map<string, { begin: number[]; end: number[] }>();
  for (const match of text.matchAll(MARKER_LINE)) {
    const entry = counts.get(match[2]) || { begin: [], end: [] };
    entry[match[1] === 'BEGIN' ? 'begin' : 'end'].push(match.index ?? 0);
    counts.set(match[2], entry);
  }
  const findings: Finding[] = [];
  for (const [id, { begin, end }] of counts) {
    const registered = MARKER_ID.test(id) && BLOCKS.some((block) => block.id === id && block.page === page);
    const paired = begin.length === 1 && end.length === 1 && end[0] > begin[0];
    if (!registered || !paired) findings.push({ page, id, kind: 'orphan' });
  }
  return findings;
}

/** The text between a block's marker lines, or null when the pair is absent or malformed. */
function spanOf(text: string, id: string): { start: number; end: number } | null {
  const begin = `<!-- BEGIN GENERATED:${id} -->\n`;
  const end = `<!-- END GENERATED:${id} -->`;
  const a = text.indexOf(begin);
  if (a < 0 || text.indexOf(begin, a + 1) >= 0) return null;
  const b = text.indexOf(end, a + begin.length);
  if (b < 0 || (b > 0 && text[b - 1] !== '\n' && b !== a + begin.length)) return null;
  return { start: a + begin.length, end: b };
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
    try { expected = block.render(root); } catch { findings.push({ page: block.page, id: block.id, kind: 'source-unreadable' }); continue; }
    if ((text as string).slice(span.start, span.end) !== `${expected}\n`) findings.push({ page: block.page, id: block.id, kind: 'stale' });
  }
  const committed = readDoc(root, 'llms.txt');
  let expected: string | null = null;
  try { expected = renderLlms(root); } catch { findings.push({ page: 'llms.txt', id: 'llms.txt', kind: 'source-unreadable' }); }
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
  for (const finding of findings) process.stderr.write(`docs-blocks: ${finding.page}: ${finding.id}: ${finding.kind}\n`);
  if (findings.length && argv[0] === '--check') process.stderr.write('docs-blocks: run node src/release/docs-blocks.ts --write, then review the diff\n');
  return findings.length ? 1 : 0;
}

module.exports = { BLOCKS, LLMS_CAP, MARKER_ID, renderBlock, renderLlms, readNav, captureHelp, pageDescription, checkAll, writeAll, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));
