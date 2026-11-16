'use strict';

// G83 — every list of harness ids is derived from core/registry/harnesses.json or inventoried here (row 171,
// D8-D9). Five checks, each a pure function of a root directory and an id list, run once on the shipped tree
// and once against a registry that holds a ninth harness:
//
//   G83.1 inventory: each row of LITERAL_LISTS names a literal in a source file that stays hand-written (a
//         per-id fact pin, a per-id code map); the ids pulled out of that literal satisfy the row's relation
//         to the registry's active ids
//   G83.2 no stray list: no array or object literal in src/, test/ or console/src/ holds every active id unless
//         the inventory names it (a planted literal makes the scanner fail: the negative control). The inventory
//         holds exactly one `equal` list in test/: the registry pin "the active harnesses are exactly these" in
//         test/registry/harness-ids.test.ts; every other test reads the ids from test/helper/harness-ids.ts. Its
//         one other `equal` row is console/src/project.ts `harnessIds` (a separate package that ships without
//         the registry). A literal that holds every id only through an inventoried literal nested in it is not
//         stray. G41's harness count is a number, not a list, and is not scanned
//   G83.3 docs and vocabulary: the README "Tool support" table, the docs/setup.md `--target` table and
//         telemetry.json `vocabularies.harness` carry every active id
//   G83.4 audit: the table in docs/adding-a-harness.md equals the per-harness modules on disk
//   G83.5 ninth harness: with `ninth` added to a copy of the registry, G83.1, G83.2, G83.4 and the worker
//         validator pass with no list edited; the derived src lists (targets.ts VALID, coverage.ts
//         HARNESS_ORDER, view.ts LIFECYCLE_HARNESSES, probes HARNESS_BINARIES), loaded against that root, take
//         in `ninth`; and a planted stale list (the shipped ids without `ninth`) is caught
//
// This file holds no literal list of the active ids: it would trip G83.2.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { activeIds, idsFrom } = require('../../src/registry/harness-ids.ts');
const { validateWorker } = require('../../src/registry/index.ts');
const { spawnSync } = require('node:child_process');
const { tempDir } = require('../helper/tmp.ts');

const REPO = path.resolve(__dirname, '../..');
const SCAN_DIRS = ['src', 'test', 'console/src'];
const AUDIT_PAGE = 'docs/adding-a-harness.md';

// ---- text scanning ---------------------------------------------------------------------------------------

/** `code` hides comments, regex bodies and the inside of strings (same length as the source, so offsets
 * agree); `plain` keeps strings and hides only comments. */
function blank(text: string): { code: string; plain: string } {
  const code = text.split('');
  const plain = text.split('');
  const hide = (arr: string[], from: number, to: number) => { for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' '; };
  const n = text.length;
  let lastSignificant = '';
  let i = 0;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (c === '/' && next === '/') {
      let end = i; while (end < n && text[end] !== '\n') end++;
      hide(code, i, end); hide(plain, i, end); i = end; continue;
    }
    if (c === '/' && next === '*') {
      let end = text.indexOf('*/', i + 2); end = end < 0 ? n : end + 2;
      hide(code, i, end); hide(plain, i, end); i = end; continue;
    }
    if (c === "'" || c === '"') {
      let end = i + 1;
      while (end < n && text[end] !== c && text[end] !== '\n') { if (text[end] === '\\') end++; end++; }
      hide(code, i + 1, end); i = end + 1; lastSignificant = c; continue;
    }
    if (c === '`') {
      let end = i + 1;
      while (end < n && text[end] !== '`') {
        if (text[end] === '\\') end += 2;
        else if (text[end] === '$' && text[end + 1] === '{') { let depth = 1; end += 2; while (end < n && depth) { if (text[end] === '{') depth++; else if (text[end] === '}') depth--; end++; } }
        else end++;
      }
      hide(code, i + 1, end); i = end + 1; lastSignificant = c; continue;
    }
    if (c === '/' && (lastSignificant === '' || '(,=:[!&|?{};+-*%<>~^'.includes(lastSignificant))) {
      let end = i + 1; let inClass = false;
      while (end < n && text[end] !== '\n') {
        if (text[end] === '\\') end++;
        else if (text[end] === '[') inClass = true;
        else if (text[end] === ']') inClass = false;
        else if (text[end] === '/' && !inClass) break;
        end++;
      }
      hide(code, i + 1, end); hide(plain, i + 1, end); i = end + 1; lastSignificant = '/'; continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i++;
  }
  return { code: code.join(''), plain: plain.join('') };
}

interface Literal { open: number; close: number; ch: string }

/** Every array or object literal: a `[` or `{` whose own body (nested brackets and parentheses aside) holds no
 * `;`, which is what tells a literal from a function or block body. */
function literalsOf(code: string): Literal[] {
  const out: Literal[] = [];
  const stack: { open: number; ch: string; semi: boolean }[] = [];
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '[' || c === '{' || c === '(') stack.push({ open: i, ch: c, semi: false });
    else if (c === ';' && stack.length) stack[stack.length - 1].semi = true;
    else if (c === ']' || c === '}' || c === ')') {
      const top = stack.pop();
      if (top && top.ch !== '(' && !top.semi) out.push({ open: top.open, close: i, ch: top.ch });
    }
  }
  return out.sort((a, b) => a.open - b.open);
}

const quoted = (id: string) => new RegExp(`(['"])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\1|[\\s{,]${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`);

/** The top-level entries of a literal (split at commas outside nested brackets). */
function entriesOf(code: string, plain: string, lit: Literal): string[] {
  const entries: string[] = [];
  let depth = 0; let from = lit.open + 1;
  for (let i = lit.open + 1; i < lit.close; i++) {
    const c = code[i];
    if ('[{('.includes(c)) depth++;
    else if (']})'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { entries.push(plain.slice(from, i)); from = i + 1; }
  }
  entries.push(plain.slice(from, lit.close));
  return entries.map((e) => e.trim()).filter(Boolean);
}

const STRING = /^(['"])((?:(?!\1).)*)\1/;

/** The ids a literal names, by `take`: `keys` (`id: value`), `items` (`'id'`), `values` (`key: 'id'`), `first`
 * (the first string of each nested array) or `harness` (the `harness: 'id'` field each nested object opens
 * with). The default follows the opening bracket. */
function takeIds(code: string, plain: string, lit: Literal, take?: string): string[] {
  const mode = take ?? (lit.ch === '{' ? 'keys' : 'items');
  const out: string[] = [];
  for (const entry of entriesOf(code, plain, lit)) {
    let m: RegExpMatchArray | null = null;
    if (mode === 'items') m = entry.match(STRING);
    else if (mode === 'keys') m = entry.match(/^(?:(['"])(.*?)\1|([A-Za-z_$][\w$]*))\s*:/);
    else if (mode === 'values') m = entry.match(/^[^:]+:\s*(['"])(.*?)\1\s*$/);
    else if (mode === 'first') m = entry.match(/^\[\s*(['"])(.*?)\1/);
    else if (mode === 'harness') m = entry.match(/^\{\s*harness:\s*(['"])(.*?)\1/);
    if (m) out.push(m[2] ?? m[3]);
  }
  return out;
}

function readScanned(root: string, rel: string) {
  const text = fs.readFileSync(path.join(root, rel), 'utf8');
  return { text, ...blank(text) };
}

function sourceFiles(root: string, dir: string): string[] {
  const base = path.join(root, dir);
  if (!fs.existsSync(base)) return [];
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx|js|cjs|mjs)$/.test(entry.name)) out.push(path.relative(root, full).split(path.sep).join('/'));
    }
  };
  walk(base);
  return out.sort();
}

// ---- G83.1 inventory ---------------------------------------------------------------------------------------

interface Row { file: string; symbol: string; relation: 'subset' | 'equal' | 'superset'; reason: string; take?: string }

// A per-id fact pin ties a value to one harness and the registry cannot check it against itself; a per-id code
// map ties an id to code, and an explicit `require` keeps reachability checkable. The symbol is the declared name
// (`const NAME`), or else a text anchor that ends just before the literal. `subset`: every id the literal names
// is an active id; `superset`: the literal holds every active id and others; `equal`: exactly the active ids.
const LITERAL_LISTS: Row[] = [
  { file: 'test/guards/worker-descriptors.test.ts', symbol: 'PARSER_BY_HARNESS', relation: 'subset', reason: 'per-id fact pin (G41.3): each parser id is an evidence-backed fact about one harness' },
  { file: 'test/guards/worker-descriptors.test.ts', symbol: 'ACCEPTED_KEYS', relation: 'subset', reason: 'per-id fact pin (G41.4): the supported capability keys of each harness' },
  { file: 'test/guards/worker-descriptors.test.ts', symbol: 'MAIN_SESSION_PARSER_BY_HARNESS', relation: 'subset', reason: 'per-id fact pin (G41.3, 165): the parser each supported mainSession declares' },
  { file: 'test/registry/worker-block.test.ts', symbol: 'BINARIES', relation: 'subset', reason: 'per-id fact pin: the binary each harness is launched by' },
  { file: 'test/registry/worker-block.test.ts', symbol: 'MODEL_HARNESSES', relation: 'subset', reason: 'per-id fact pin: the harnesses whose model entry cites a cli-check' },
  { file: 'test/registry/worker-block.test.ts', symbol: 'FREE_CHECK_HARNESSES', relation: 'subset', reason: 'per-id fact pin: the harnesses recorded by a free cli-check alone' },
  { file: 'test/registry/worker-isolated-edit.test.ts', symbol: 'BINARIES', relation: 'subset', reason: 'per-id fact pin: the binary each harness is launched by' },
  { file: 'test/registry/agent-limits.test.ts', symbol: 'assert.deepEqual(status, ', relation: 'subset', reason: 'per-id fact pin: the IC-003 readOnly status of each harness' },
  { file: 'test/registry/harness-ids.test.ts', symbol: 'assert.deepEqual(activeIds(), ', relation: 'equal', reason: 'THE pin: the one hand-written list of the active ids in tests, and their registry order (row 171 A-1, A-3)' },
  { file: 'console/src/project.ts', symbol: 'harnessIds: Object.freeze(', relation: 'equal', reason: 'the console closed set: a separate package that ships without the registry, so it holds a copy, checked equal here' },
  { file: 'test/registry/worker-ladder-max.test.ts', symbol: 'const nineIds = ', relation: 'superset', reason: 'a nine-id ladder fixture: every active id plus two that are not harnesses' },
  { file: 'test/guards/lifecycle-bridges.test.ts', symbol: 'SYNTAX_CASES', relation: 'subset', take: 'first', reason: 'per-id fact pin: the bridge events a harness blocks on' },
  { file: 'test/e2e/runtime-reach.e2e.test.ts', symbol: 'PLACEMENT', relation: 'subset', reason: 'per-id fact pin: where each harness puts the do-git skill and the locator shim' },
  { file: 'test/fixtures/transcripts/v8/scan.ts', symbol: 'const LOCATION_ROOTS: Record<string, string[]> = ', relation: 'subset', reason: 'fixture: where each harness fixture directory belongs under a scratch HOME' },
  { file: 'test/fixtures/transcripts/v8/scan.ts', symbol: 'const FIXTURES: Fixture[] = ', relation: 'subset', take: 'harness', reason: 'fixture: the transcript files on disk under v8/, one row per file' },
  { file: 'test/helper/hook-fixtures.ts', symbol: 'MODEL_PAYLOADS', relation: 'subset', reason: 'per-id fact pin: the native hook payload each harness sends with a model' },
  { file: 'test/install/mcp-selection-line.test.ts', symbol: 'const targets = view(', relation: 'subset', take: 'harness', reason: 'fixture: per-harness MCP selections the expected grouping is written for' },
  { file: 'test/runtime/rollout-profiles.test.ts', symbol: 'EXPECTED_CONTEXT_PROFILES', relation: 'subset', reason: 'per-id fact pin: the empirical context profile of each harness' },
  { file: 'test/runtime/rollout-profiles.test.ts', symbol: 'EXPECTED_TELEMETRY', relation: 'subset', reason: 'per-id fact pin: the native telemetry block of each harness' },
  { file: 'test/registry/transcripts-registry.test.ts', symbol: "'none']);\n  assert.deepEqual(", relation: 'subset', reason: 'per-id fact pin (the reader ruling): the reader each harness with a transcript reader names' },
  { file: 'src/install/targets.ts', symbol: 'DEFAULT_TARGETS', relation: 'subset', reason: 'the one harness `--target` falls back to, a product choice' },
  { file: 'src/install/targets.ts', symbol: 'TARGET_ALIASES', relation: 'subset', take: 'values', reason: 'per-id fact pin: the short name a harness answers to' },
  { file: 'src/install/targets.ts', symbol: "const root = global ? os.homedir() : canonicalPath(projectRoot);\n  return ", relation: 'subset', reason: 'per-id code map: the tool directory each harness installs into (toolDirs)' },
  { file: 'src/runtime/worker/probes/index.ts', symbol: 'RELOGIN_HINTS', relation: 'subset', reason: 'per-id fact pin: the login command a harness documents (row 172 moves it into the login recipe)' },
  { file: 'src/runtime/worker/probes/index.ts', symbol: 'const PROBES: Record<string, HarnessProbeRunner> = ', relation: 'subset', reason: 'per-id code map: each probe parses its own CLI output' },
  { file: 'src/runtime/fleet/tree.ts', symbol: 'ENCODE', relation: 'subset', reason: 'per-id code map: how a harness encodes a cwd into its transcript directory' },
  { file: 'src/cli/shared.ts', symbol: 'createAdapterRegistry(', relation: 'subset', reason: 'per-id code map: the adapter constructions, one explicit require each' },
  { file: 'src/lifecycle/view.ts', symbol: 'createAdapterRegistry(', relation: 'subset', reason: 'per-id code map: the adapter constructions, kept literal beside buildAdapterRegistry' },
];

/** Where a row's literal is: the declared name or text anchor, then the first literal after it. */
function locateLiteral(root: string, row: Row): { problem?: string; code?: string; plain?: string; lit?: Literal } {
  const file = path.join(root, row.file);
  if (!fs.existsSync(file)) return { problem: `${row.file}: no such file` };
  const { code, plain } = readScanned(root, row.file);
  let end = -1;
  if (/^[A-Za-z_$][\w$]*$/.test(row.symbol)) {
    const m = new RegExp(`\\b(?:const|let|var)\\s+${row.symbol}\\b`).exec(plain);
    if (m) end = m.index + m[0].length;
  } else {
    const at = plain.indexOf(row.symbol);
    if (at >= 0) end = at + row.symbol.length;
  }
  if (end < 0) return { problem: `${row.file}: symbol ${JSON.stringify(row.symbol)} not found` };
  const lit = literalsOf(code).find((l) => l.open >= end);
  if (!lit) return { problem: `${row.file}: no literal after ${JSON.stringify(row.symbol)}` };
  return { code, plain, lit };
}

function locateRow(root: string, row: Row): { problem?: string; ids?: string[] } {
  const found = locateLiteral(root, row);
  return found.problem ? { problem: found.problem } : { ids: takeIds(found.code!, found.plain!, found.lit!, row.take) };
}

/** The offset of each inventoried literal, for G83.2 to leave alone. */
function inventoryStarts(root: string, rows: Row[]): Map<string, Set<number>> {
  const starts = new Map<string, Set<number>>();
  for (const row of rows) {
    const found = locateLiteral(root, row);
    if (found.problem) continue;
    if (!starts.has(row.file)) starts.set(row.file, new Set());
    starts.get(row.file)!.add(found.lit!.open);
  }
  return starts;
}

function inventoryProblems(root: string, rows: Row[], ids: readonly string[]): string[] {
  const problems: string[] = [];
  for (const row of rows) {
    const found = locateRow(root, row);
    if (found.problem) { problems.push(found.problem); continue; }
    const named = new Set(found.ids);
    if (named.size === 0) { problems.push(`${row.file} ${row.symbol}: names no id`); continue; }
    const outside = [...named].filter((id) => !ids.includes(id));
    const missing = ids.filter((id) => !named.has(id));
    if (row.relation === 'subset' && outside.length) problems.push(`${row.file} ${row.symbol}: ${outside.join(', ')} not an active id`);
    if (row.relation === 'equal' && (outside.length || missing.length)) problems.push(`${row.file} ${row.symbol}: not equal to the active ids (outside: ${outside.join(', ')}; missing: ${missing.join(', ')})`);
    if (row.relation === 'superset' && missing.length) problems.push(`${row.file} ${row.symbol}: lacks ${missing.join(', ')}`);
  }
  return problems;
}

// ---- G83.2 no stray list -----------------------------------------------------------------------------------

/** Literals under `dirs` of `root` that hold every id of `ids` outside the inventoried literals, as `file:line`. */
function scanStrayLists(root: string, ids: readonly string[], rows: Row[], dirs: string[] = SCAN_DIRS): string[] {
  const allowed = inventoryStarts(root, rows);
  const stray: string[] = [];
  for (const dir of dirs) {
    for (const rel of sourceFiles(root, dir)) {
      const { code, plain } = readScanned(root, rel);
      const literals = literalsOf(code);
      const inventoried = literals.filter((lit) => allowed.get(rel)?.has(lit.open));
      for (const lit of literals) {
        if (allowed.get(rel)?.has(lit.open)) continue;
        // An id counts only outside the inventoried literals nested in this one: a wrapper of an allowed list is not stray.
        const chars = plain.slice(lit.open, lit.close + 1).split('');
        for (const inner of inventoried) if (inner.open > lit.open && inner.close < lit.close) for (let k = inner.open; k <= inner.close; k++) chars[k - lit.open] = ' ';
        const body = chars.join('');
        if (!ids.every((id) => quoted(id).test(body))) continue;
        stray.push(`${rel}:${plain.slice(0, lit.open).split('\n').length}`);
      }
    }
  }
  return stray;
}

// ---- G83.3 docs and vocabulary -----------------------------------------------------------------------------

function tableRows(markdown: string, heading: RegExp): string[][] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => heading.test(line));
  if (start < 0) return [];
  const rows: string[][] = [];
  let inTable = false;
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\|/.test(line)) {
      inTable = true;
      const cells = line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((cell) => cell.trim());
      if (cells.every((cell) => /^:?-{3,}:?$/.test(cell))) continue;
      rows.push(cells);
    } else if (inTable) break;
  }
  return rows.slice(1);
}

function docsProblems(root: string, harnesses: any[]): string[] {
  const problems: string[] = [];
  const ids = harnesses.map((h) => h.id);
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  const toolRows = tableRows(readme, /^##\s+Tool support\s*$/);
  for (const h of harnesses) {
    if (!toolRows.some((cells) => cells[0].startsWith(h.displayName))) problems.push(`README.md Tool support: no row starts with '${h.displayName}'`);
  }
  const setup = fs.readFileSync(path.join(root, 'docs/setup.md'), 'utf8');
  const targets = tableRows(setup, /^###\s+Coding agents\s*$/).map((cells) => cells[1].replace(/`/g, ''));
  if (JSON.stringify([...targets].sort()) !== JSON.stringify([...ids].sort())) problems.push(`docs/setup.md --target column is [${targets.join(', ')}], registry has [${ids.join(', ')}]`);
  const telemetry = JSON.parse(fs.readFileSync(path.join(root, 'core/registry/telemetry.json'), 'utf8'));
  const vocabulary: string[] = telemetry.vocabularies.harness;
  if (JSON.stringify([...vocabulary].sort()) !== JSON.stringify([...ids].sort())) problems.push(`telemetry.json vocabularies.harness is [${vocabulary.join(', ')}], registry has [${ids.join(', ')}]`);
  return problems;
}

// ---- G83.4 audit -------------------------------------------------------------------------------------------

interface AuditEntry { module: string; harnesses: string[] }

const stem = (file: string) => file.replace(/\.[jt]s$/, '');
const listDir = (root: string, dir: string, keep: (e: any) => boolean) => {
  const full = path.join(root, dir);
  return fs.existsSync(full) ? fs.readdirSync(full, { withFileTypes: true }).filter(keep).map((e: any) => e.name).sort() : [];
};

/** The per-harness modules on disk, as the rows the audit table must hold. A harness cell of `all` means every
 * entry of the group (each is checked to be an active id). */
function auditFromDisk(root: string, ids: readonly string[]): { rows: AuditEntry[]; problems: string[] } {
  const rows: AuditEntry[] = [];
  const problems: string[] = [];
  const inIds = (group: string, list: string[]) => { for (const id of list) if (!ids.includes(id)) problems.push(`${group}: '${id}' is not an active id`); };
  const parsersSource = fs.readFileSync(path.join(root, 'src/runtime/worker/parsers.ts'), 'utf8');
  if (/function createJsonlV1\b/.test(parsersSource)) rows.push({ module: 'parsers.ts createJsonlV1', harnesses: ["(DoFlow's own)"] });
  for (const file of listDir(root, 'src/runtime/worker/parsers', (e) => e.isFile() && e.name.endsWith('.ts') && !['common.ts', 'field-map.ts'].includes(e.name))) {
    rows.push({ module: `parsers/${file}`, harnesses: [stem(file)] }); inIds(`parsers/${file}`, [stem(file)]);
  }
  const probes = locateRow(root, { file: 'src/runtime/worker/probes/index.ts', symbol: 'const PROBES: Record<string, HarnessProbeRunner> = ', relation: 'subset', reason: '' });
  if (probes.problem) problems.push(probes.problem);
  else { rows.push({ module: `probes/index.ts PROBES (${probes.ids!.length})`, harnesses: ['all'] }); inIds('PROBES', probes.ids!); }
  const readers = listDir(root, 'src/runtime/transcripts/readers', (e) => e.isFile() && e.name.endsWith('.ts'));
  const readerHarnesses = readers.map((file: string) => stem(file).split('-')[0]).sort();
  rows.push({ module: `transcripts/readers/*.ts (${readers.length})`, harnesses: readerHarnesses }); inIds('transcripts/readers', readerHarnesses);
  const adapters = listDir(root, 'src/adapters', (e) => e.isDirectory());
  rows.push({ module: `src/adapters/<id>/ (${adapters.length})`, harnesses: ['all'] }); inIds('src/adapters', adapters);
  for (const file of listDir(root, 'core/harnesses/shared/hooks/adapters', (e) => e.isFile() && e.name.endsWith('.js'))) {
    rows.push({ module: `hooks/adapters/${file}`, harnesses: [stem(file)] }); inIds(`hooks/adapters/${file}`, [stem(file)]);
  }
  const tree = readScanned(root, 'src/runtime/fleet/tree.ts');
  const fleet = new Set<string>([...tree.plain.matchAll(/harness === '([a-z0-9-]+)'/g)].map((m) => m[1]));
  const encode = locateRow(root, { file: 'src/runtime/fleet/tree.ts', symbol: 'ENCODE', relation: 'subset', reason: '' });
  if (encode.problem) problems.push(encode.problem); else for (const id of encode.ids!) fleet.add(id);
  rows.push({ module: 'fleet/tree.ts branches and ENCODE', harnesses: [...fleet].sort() }); inIds('fleet/tree.ts', [...fleet]);
  return { rows, problems };
}

/** The audit table of the docs page, one entry per row: the Module cell with backticks removed, and its Harness cell. */
function auditFromPage(markdown: string): AuditEntry[] {
  return tableRows(markdown, /^#\s+/).map((cells) => ({
    module: cells[0].replace(/`/g, '').replace(/\s+/g, ' ').trim(),
    harnesses: cells[1].replace(/`/g, '').split(',').map((cell) => cell.trim()).filter(Boolean).sort(),
  }));
}

function auditProblems(root: string, ids: readonly string[], markdown: string): string[] {
  const disk = auditFromDisk(root, ids);
  const problems = [...disk.problems];
  const page = auditFromPage(markdown);
  for (const want of disk.rows) {
    const have = page.find((row) => row.module === want.module);
    if (!have) { problems.push(`audit table has no row '${want.module}'`); continue; }
    if (JSON.stringify(have.harnesses) !== JSON.stringify([...want.harnesses].sort())) problems.push(`audit row '${want.module}' names [${have.harnesses.join(', ')}], disk has [${want.harnesses.join(', ')}]`);
  }
  for (const have of page) if (!disk.rows.some((row) => row.module === have.module)) problems.push(`audit table row '${have.module}' matches no module on disk`);
  return problems;
}

// ---- G83.5 helpers -----------------------------------------------------------------------------------------

/** A copy of core/registry/ in a scratch root whose harnesses.json holds a ninth harness: the first harness's
 * worker block, with a field-map structuredOutput (the grammar's own minimal valid map) in place of a parser. */
function ninthRoot(t: any): { root: string; registry: any } {
  const root = tempDir(t, 'doflow-g83-ninth-');
  fs.cpSync(path.join(REPO, 'core', 'registry'), path.join(root, 'core', 'registry'), { recursive: true });
  const file = path.join(root, 'core', 'registry', 'harnesses.json');
  const registry = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ninth = structuredClone(registry.harnesses[0]);
  ninth.id = 'ninth';
  ninth.displayName = 'Ninth';
  const { parser: _parser, ...rest } = ninth.worker.structuredOutput;
  ninth.worker.structuredOutput = {
    ...rest, status: 'supported', argv: ['--json'], evidence: ['core/registry/harnesses.json'], verification: 'Scratch.', verifiedOn: '2026-11-16',
    fieldMap: {
      id: 'ninth-run-v1', format: 'jsonl-field-map-v1', eventType: ['type'], missingTerminal: 'no-end',
      rules: [
        { when: [{ path: ['type'], equals: 'msg' }, { path: ['text'], is: 'string' }], then: { final: ['text'] } },
        { when: [{ path: ['type'], equals: 'done' }], then: { terminal: { outcome: 'completed' } } },
      ],
    },
  };
  registry.harnesses.push(ninth);
  fs.writeFileSync(file, JSON.stringify(registry));
  return { root, registry };
}

/** `ninthRoot` plus a copy of src/: a module loaded from <root>/src resolves REPO_ROOT (src/helper/repo-root.ts,
 * from its own location) to <root>, so the src lists read the scratch registry exactly as they read the shipped
 * one, with no test-only parameter. The ninth harness gets its own binary so HARNESS_BINARIES can show it. */
function ninthMirror(t: any): string {
  const { root, registry } = ninthRoot(t);
  registry.harnesses[registry.harnesses.length - 1].worker.cli.binary = 'ninth-cli';
  fs.writeFileSync(path.join(root, 'core', 'registry', 'harnesses.json'), JSON.stringify(registry));
  fs.cpSync(path.join(REPO, 'src'), path.join(root, 'src'), { recursive: true });
  return root;
}

/** The four src lists design §7 A derives from the registry, as a module loaded from `<root>/src` sees them. */
function derivedLists(root: string): Record<string, readonly string[]> {
  const load = (rel: string) => require(path.join(root, 'src', rel));
  return {
    'targets.ts VALID': load('install/targets.ts').VALID,
    'coverage.ts HARNESS_ORDER': load('lifecycle/coverage.ts').HARNESS_ORDER,
    'view.ts LIFECYCLE_HARNESSES': load('lifecycle/view.ts').LIFECYCLE_HARNESSES,
    'probes HARNESS_BINARIES': Object.keys(load('runtime/worker/probes/index.ts').HARNESS_BINARIES),
  };
}

/** Each derived list that is not exactly `ids` in order, as `name: [ids]`. */
function derivedProblems(root: string, ids: readonly string[]): string[] {
  return Object.entries(derivedLists(root))
    .filter(([, list]) => JSON.stringify([...list]) !== JSON.stringify([...ids]))
    .map(([name, list]) => `${name}: [${list.join(', ')}]`);
}

const harnessesOf = (root: string): any[] => JSON.parse(fs.readFileSync(path.join(root, 'core/registry/harnesses.json'), 'utf8')).harnesses;
const page = () => fs.readFileSync(path.join(REPO, AUDIT_PAGE), 'utf8');

// ---- the tests ---------------------------------------------------------------------------------------------

test('G83.1: every inventoried literal exists and satisfies its relation to the active ids', () => {
  assert.deepEqual(inventoryProblems(REPO, LITERAL_LISTS, activeIds()), []);
});

test('G83.1 control: a missing symbol, an id outside the registry and a failed equal or superset relation are each reported', () => {
  const ids = activeIds();
  const at = 'test/registry/worker-block.test.ts';
  assert.match(inventoryProblems(REPO, [{ file: at, symbol: 'NO_SUCH_LIST', relation: 'subset', reason: 'x' }], ids).join('\n'), /symbol "NO_SUCH_LIST" not found/);
  assert.match(inventoryProblems(REPO, [{ file: 'test/guards/no-such-file.ts', symbol: 'X', relation: 'subset', reason: 'x' }], ids).join('\n'), /no such file/);
  assert.match(inventoryProblems(REPO, [{ file: at, symbol: 'BINARIES', relation: 'subset', reason: 'x' }], ids.slice(1)).join('\n'), /not an active id/);
  assert.match(inventoryProblems(REPO, [{ file: at, symbol: 'FREE_CHECK_HARNESSES', relation: 'equal', reason: 'x' }], ids).join('\n'), /not equal to the active ids/);
  assert.match(inventoryProblems(REPO, [{ file: at, symbol: 'FREE_CHECK_HARNESSES', relation: 'superset', reason: 'x' }], ids).join('\n'), /lacks /);
});

test('G83.2: no array or object literal under src, test or console/src holds every active id outside the inventory', () => {
  assert.deepEqual(scanStrayLists(REPO, activeIds(), LITERAL_LISTS), []);
});

test('G83.2 control: a planted file holding a literal of every id is reported, unless the inventory names it', (t) => {
  const ids = activeIds();
  const root = tempDir(t, 'doflow-g83-plant-');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'planted.ts'), `const LIST = [${ids.map((id: string) => `'${id}'`).join(', ')}];\nconst MAP = { ${ids.map((id: string) => `${id}: 1`).join(', ')} };\n`);
  assert.deepEqual(scanStrayLists(root, ids, []), ['src/planted.ts:1', 'src/planted.ts:2']);
  const named: Row[] = [{ file: 'src/planted.ts', symbol: 'LIST', relation: 'equal', reason: 'x' }, { file: 'src/planted.ts', symbol: 'MAP', relation: 'equal', reason: 'x' }];
  assert.deepEqual(scanStrayLists(root, ids, named), []);
  assert.deepEqual(inventoryProblems(root, named, ids), []);
  fs.writeFileSync(path.join(root, 'src', 'planted.ts'), `const FEW = [${ids.slice(1).map((id: string) => `'${id}'`).join(', ')}];\nfunction f() { const a = 1; return ['${ids.join("', '")}']; }\n`);
  assert.deepEqual(scanStrayLists(root, ids, []), ['src/planted.ts:2'], 'a literal missing one id is not stray; one inside a function still is');
});

test('G83.3: the README Tool support table, the docs/setup.md target table and the telemetry vocabulary carry every active id', () => {
  assert.deepEqual(docsProblems(REPO, harnessesOf(REPO)), []);
});

test('G83.3 control: a harness with no README row, no target row or no vocabulary entry is reported', (t) => {
  const root = tempDir(t, 'doflow-g83-docs-');
  for (const rel of ['README.md', 'docs/setup.md', 'core/registry/telemetry.json']) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.copyFileSync(path.join(REPO, rel), path.join(root, rel));
  }
  const harnesses = harnessesOf(REPO);
  assert.deepEqual(docsProblems(root, harnesses), []);
  const message = docsProblems(root, [...harnesses, { id: 'ninth', displayName: 'Ninth' }]).join('\n');
  assert.match(message, /README.md Tool support: no row starts with 'Ninth'/);
  assert.match(message, /docs\/setup.md --target column/);
  assert.match(message, /telemetry.json vocabularies.harness/);
});

test('G83.4: the audit table of docs/adding-a-harness.md equals the per-harness modules on disk', () => {
  assert.deepEqual(auditProblems(REPO, activeIds(), page()), []);
});

test('G83.4 control: a table missing a row, holding an extra row or naming the wrong harnesses is reported', () => {
  const ids = activeIds();
  const lines = page().split('\n');
  const rowAt = lines.findIndex((line: string) => line.startsWith('| `parsers/claude.ts`'));
  assert.ok(rowAt > 0, 'the table has a parsers/claude.ts row');
  const without = [...lines.slice(0, rowAt), ...lines.slice(rowAt + 1)].join('\n');
  assert.deepEqual(auditProblems(REPO, ids, without), ["audit table has no row 'parsers/claude.ts'"]);
  const extra = [...lines.slice(0, rowAt), '| `parsers/ghost.ts` | ghost | parser | x |', ...lines.slice(rowAt)].join('\n');
  assert.deepEqual(auditProblems(REPO, ids, extra), ["audit table row 'parsers/ghost.ts' matches no module on disk"]);
  const wrong = lines.map((line: string, i: number) => (i === rowAt ? line.replace('| claude |', '| codex |') : line)).join('\n');
  assert.match(auditProblems(REPO, ids, wrong).join('\n'), /audit row 'parsers\/claude.ts' names \[codex\], disk has \[claude\]/);
});

test('G83.5: with a ninth harness in the registry, the inventory, the stray scan, the audit and the worker validator pass with no list edited', (t) => {
  const { root, registry } = ninthRoot(t);
  const ids = activeIds(root);
  assert.equal(ids.length, activeIds().length + 1);
  assert.equal(ids[ids.length - 1], 'ninth');
  assert.deepEqual(idsFrom(registry).active, ids);
  assert.deepEqual(inventoryProblems(REPO, LITERAL_LISTS.filter((row) => row.relation === 'subset'), ids), []);
  assert.deepEqual(scanStrayLists(REPO, ids, LITERAL_LISTS), []);
  assert.deepEqual(auditProblems(REPO, ids, page()), []);
  const errors: string[] = [];
  validateWorker(harnessesOf(root).find((h: any) => h.id === 'ninth').worker, "harness 'ninth'", errors);
  assert.deepEqual(errors, []);
  // The derived src lists, loaded against that root, take in `ninth` (and probes binds it to its own binary).
  const mirror = ninthMirror(t);
  assert.deepEqual(activeIds(mirror), ids);
  assert.deepEqual(derivedProblems(mirror, ids), []);
  assert.equal(require(path.join(mirror, 'src', 'runtime/worker/probes/index.ts')).HARNESS_BINARIES.ninth, 'ninth-cli');
  // Left out for `ninth`, by design: G83.3 (its README and setup rows, and its telemetry vocabulary entry, are content
  // written with the harness) and every `equal` relation row (an equal row names the shipped ids; G83.1 fails on it
  // until the pin and console/src/project.ts name `ninth`, which is the edit adding a harness makes). Conform is row 171 T6's.
});

test('G83.5 control: a stale hand-written list planted in place of VALID misses the ninth harness and G83.2 catches it', (t) => {
  const shipped = activeIds();
  const mirror = ninthMirror(t);
  const file = path.join(mirror, 'src', 'install', 'targets.ts');
  const text = fs.readFileSync(file, 'utf8');
  const derived = 'const VALID: readonly string[] = activeIds();';
  assert.ok(text.includes(derived), 'targets.ts derives VALID from activeIds()');
  fs.writeFileSync(file, text.replace(derived, `const VALID: readonly string[] = [${shipped.map((id: string) => `'${id}'`).join(', ')}];`));
  const line = text.slice(0, text.indexOf(derived)).split('\n').length;
  assert.deepEqual(derivedProblems(mirror, activeIds(mirror)), [`targets.ts VALID: [${shipped.join(', ')}]`]);
  assert.deepEqual(scanStrayLists(mirror, shipped, LITERAL_LISTS, ['src']), [`src/install/targets.ts:${line}`]);
});
