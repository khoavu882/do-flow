'use strict';

// G94 — the modules row 181 adds make no paid model call, widen no permission and read no credential (NFR-002, FR-018, D12).
//   G94.1  the static require closure of each row module (`run-evidence.ts`, `review/workarounds.ts`, `lifecycle/check-proposal.ts`,
//          `verification/feature-map.ts`, `verification/inner-loop.ts`, `guidance/rule-ledger.ts`, all under `src/runtime/`)
//          reaches no model client (`advice/client.ts`, `shadow-dispatcher.ts`, `shadow-runner.ts`), no `same-issue/ask.ts`,
//          no `followup-similar.ts` and no `node:http`, `node:https` or `node:net`. Modelled on G89.1.
//   G94.2  no file of that closure under `src/runtime/` holds a permission-widening flag (`--dangerously-skip-permissions`,
//          `--yolo`, `bypassPermissions`, `--allow-all`, `--sandbox=off`, `danger-full-access`) or a credential read
//          (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, an env read of a `*_TOKEN` or `*_SECRET` name, `.netrc`,
//          `.npmrc`, `.aws`, `keychain`), comments stripped.
//   Which edges count: every require, eager or lazy (a require inside a function is still a call path), in every file of the walk,
//   row modules and pre-existing files alike, as G89.1's `closureOf` does. The one exception is KNOWN_LAZY_EDGES: a named list of
//   the lazy requires in pre-existing files this row did not add that lead to the model client today (advise shadow mode and the
//   advise doctor, opt-in paths that run only when the user turns them on). Each is the edge where the chain enters advice/; the
//   walk stops at it and nowhere else. An eager edge or an edge in a row module may never be listed. G94.3 keeps the list honest: a
//   listed edge that no longer exists as a lazy require fails, so the list only shrinks. A new lazy require anywhere else in a
//   closure is followed, so one that reaches a model client fails G94.1.
//   G94.3  every KNOWN_LAZY_EDGES entry is a lazy require in a pre-existing (non row module) file that still exists.
//   Controls: each check fails on a planted-bad in-memory copy, never on the tree.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');

const ROW_MODULES = [
  'src/runtime/run-evidence.ts',
  'src/runtime/review/workarounds.ts',
  'src/runtime/lifecycle/check-proposal.ts',
  'src/runtime/verification/feature-map.ts',
  'src/runtime/verification/inner-loop.ts',
  'src/runtime/guidance/rule-ledger.ts',
];
const FORBIDDEN_FILES = [
  'src/runtime/advice/client.ts', 'src/runtime/advice/shadow-dispatcher.ts', 'src/runtime/advice/shadow-runner.ts',
  'src/runtime/advice/same-issue/ask.ts', 'src/runtime/lifecycle/followup-similar.ts',
];
/** Lazy requires in pre-existing files that reach the model client; the walk does not follow these and nothing else. */
const KNOWN_LAZY_EDGES: Array<{ from: string; to: string; why: string }> = [
  { from: 'src/runtime/health.ts', to: './advice/doctor.ts', why: 'the advise doctor report (`doflow health` advise section), an opt-in probe of the advise services' },
  { from: 'src/runtime/claims.ts', to: './advice/registry.ts', why: 'advise shadow mode: a claim decision point loads the advice registry, opt-in' },
  { from: 'src/runtime/claims.ts', to: './advice/shadow-dispatcher.ts', why: 'advise shadow mode: a claim decision point is intercepted by the shadow dispatcher, opt-in' },
  { from: 'src/runtime/claims.ts', to: './advice/services.ts', why: 'advise shadow mode: a claim decision point builds the advice services, opt-in' },
  { from: 'src/runtime/review/start.ts', to: '../advice/registry.ts', why: 'advise at review start: loads the advice registry when advise is enabled, opt-in' },
  { from: 'src/runtime/review/start.ts', to: '../advice/services.ts', why: 'advise at review start: resolves the advice roots when advise is enabled, opt-in' },
  { from: 'src/runtime/review/start.ts', to: '../advice/client.ts', why: 'advise at review start: creates the advice client when advise is enabled, opt-in' },
  { from: 'src/runtime/review/start.ts', to: '../advice/shadow-dispatcher.ts', why: 'advise shadow mode at review start: intercepts the review decision point, opt-in' },
];
const FORBIDDEN_MODULES = ['node:http', 'node:https', 'node:net'];
const FORBIDDEN_TEXT: Array<[string, RegExp]> = [
  ['--dangerously-skip-permissions', /--dangerously-skip-permissions/],
  ['--yolo', /--yolo\b/],
  ['bypassPermissions', /bypassPermissions/],
  ['--allow-all', /--allow-all/],
  ['--sandbox=off', /--sandbox=off/],
  ['danger-full-access', /danger-full-access/],
  ['ANTHROPIC_API_KEY', /ANTHROPIC_API_KEY/],
  ['OPENAI_API_KEY', /OPENAI_API_KEY/],
  ['GEMINI_API_KEY', /GEMINI_API_KEY/],
  ['a *_TOKEN or *_SECRET env read', /\b(?:env|environ)(?:\.|\[\s*['"])[A-Z0-9_]*_(?:TOKEN|SECRET)\b/],
  ['.netrc', /\.netrc/],
  ['.npmrc', /\.npmrc/],
  ['.aws', /\.aws\b/],
  ['keychain', /keychain/i],
];

const read = (file: string): string => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');

/** Every repo-relative file and bare module the require closure of `entry` reaches; `overlay` replaces a file's text. */
function closureOf(entry: string, overlay: Map<string, string> = new Map(), known = KNOWN_LAZY_EDGES): { files: Set<string>; modules: Set<string> } {
  const files = new Set<string>();
  const modules = new Set<string>();
  const exists = (file: string) => overlay.has(file) || (fs.existsSync(path.join(REPO_ROOT, file)) && fs.statSync(path.join(REPO_ROOT, file)).isFile());
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = stripComments(overlay.get(file) ?? read(file));
    for (const [, specifier] of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!specifier.startsWith('.')) { modules.add(specifier.startsWith('node:') ? specifier : `node:${specifier}`); continue; }
      if (known.some((edge) => edge.from === file && edge.to === specifier)) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const found = [base, `${base}.ts`, `${base}/index.ts`].find(exists);
      if (found) visit(found);
    }
  };
  visit(entry);
  return { files, modules };
}

/** What the closure of each row module reaches that it must not: forbidden files and modules, by name. */
function closureFindings(overlay?: Map<string, string>, known = KNOWN_LAZY_EDGES): string[] {
  return ROW_MODULES.flatMap((entry) => {
    const { files, modules } = closureOf(entry, overlay, known);
    return [
      ...FORBIDDEN_FILES.filter((file) => files.has(file)).map((file) => `${entry} reaches ${file}`),
      ...FORBIDDEN_MODULES.filter((module) => modules.has(module)).map((module) => `${entry} reaches ${module}`),
    ];
  });
}

/** Every file under src/runtime/ in some row module's closure that holds a widening flag or a credential read, by name. */
function textFindings(overlay: Map<string, string> = new Map()): string[] {
  const files = new Set<string>();
  for (const entry of ROW_MODULES) for (const file of closureOf(entry, overlay).files) if (file.startsWith('src/runtime/')) files.add(file);
  return [...files].sort().flatMap((file) => {
    const text = stripComments(overlay.get(file) ?? read(file));
    return FORBIDDEN_TEXT.filter(([, pattern]) => pattern.test(text)).map(([label]) => `${file} holds ${label}`);
  });
}

/** The KNOWN_LAZY_EDGES entries that are not, today, a lazy (indented) require in a file this row did not add. */
function staleEdges(overlay: Map<string, string> = new Map()): string[] {
  return KNOWN_LAZY_EDGES.filter(({ from, to }) => {
    if (ROW_MODULES.includes(from) || !(overlay.has(from) || fs.existsSync(path.join(REPO_ROOT, from)))) return true;
    const escaped = to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return !new RegExp(`^[ \\t]+.*require\\(\\s*['"]${escaped}['"]\\s*\\)`, 'm').test(stripComments(overlay.get(from) ?? read(from)));
  }).map(({ from, to }) => `${from} -> ${to}`);
}

const plant = (spec: string) => `require('${spec}')`; // built, so G16 does not read it as a real require
const relative = (from: string, to: string) => path.posix.relative(path.posix.dirname(from), to).replace(/^(?=[^.])/, './');

test('G94.1: the require closure of every row 181 module reaches no model client, ask, followup-similar or network module', () => {
  assert.deepEqual(closureFindings(), []);
  for (const entry of ROW_MODULES) assert.ok(closureOf(entry).files.size > 1 || entry.endsWith('rule-ledger.ts'), `${entry} closure was walked`);
});

test('G94.1 control: a planted model-client require in a row module, a lazy one and a transitive one are each found, naming the module', () => {
  assert.deepEqual(closureFindings(new Map(ROW_MODULES.map((file) => [file, read(file)]))), [], 'the copies are clean before the plant');
  const client = 'src/runtime/advice/client.ts';
  for (const entry of ROW_MODULES) {
    const planted = `${read(entry)}\nconst plantedClient = ${plant(relative(entry, client))};\n`;
    assert.ok(closureFindings(new Map([[entry, planted]])).includes(`${entry} reaches ${client}`), `${entry}: top-level plant`);
    const lazy = `${read(entry)}\nfunction plantedLazy() {\n  return ${plant(relative(entry, client))};\n}\n`;
    assert.ok(closureFindings(new Map([[entry, lazy]])).includes(`${entry} reaches ${client}`), `${entry}: lazy plant`);
  }
  const http = `${read('src/runtime/guidance/rule-ledger.ts')}\nconst plantedHttp = require('http');\n`;
  assert.deepEqual(closureFindings(new Map([['src/runtime/guidance/rule-ledger.ts', http]])), ['src/runtime/guidance/rule-ledger.ts reaches node:http']);
  const through = 'src/runtime/command-detect.ts'; // reached by check-proposal.ts, not a row module
  const viaReader = `${read(through)}\nconst plantedClient = ${plant('./advice/client.ts')};\n`;
  assert.ok(closureFindings(new Map([[through, viaReader]])).includes(`src/runtime/lifecycle/check-proposal.ts reaches ${client}`));
  const ask = `${read(through)}\nconst plantedAsk = ${plant('./advice/same-issue/ask.ts')};\nconst plantedSimilar = ${plant('./lifecycle/followup-similar.ts')};\n`;
  const found = closureFindings(new Map([[through, ask]]));
  assert.ok(found.includes('src/runtime/lifecycle/check-proposal.ts reaches src/runtime/advice/same-issue/ask.ts'));
  assert.ok(found.includes('src/runtime/lifecycle/check-proposal.ts reaches src/runtime/lifecycle/followup-similar.ts'));
});

test('G94.2: no file in the closure of a row 181 module holds a permission-widening flag or a credential read', () => {
  assert.deepEqual(textFindings(), []);
});

test('G94.2 control: a planted widening flag or credential read is found, naming the file', () => {
  const rows = new Map(ROW_MODULES.map((file) => [file, read(file)]));
  assert.deepEqual(textFindings(rows), [], 'the copies are clean before the plant');
  const flag = ['--dangerously', 'skip-permissions'].join('-'); // built, so no guard reads this file as a widening-flag site
  const file = 'src/runtime/run-evidence.ts';
  assert.deepEqual(textFindings(new Map([[file, `${read(file)}\nconst plantedFlag = '${flag}';\n`]])), [`${file} holds --dangerously-skip-permissions`]);
  const dep = 'src/runtime/command-detect.ts'; // a pre-existing file the closure reaches
  assert.deepEqual(textFindings(new Map([[dep, `${read(dep)}\nconst plantedKey = process.env.ANTHROPIC_API_KEY;\n`]])), [`${dep} holds ANTHROPIC_API_KEY`]);
  assert.deepEqual(textFindings(new Map([[dep, `${read(dep)}\nconst plantedToken = process.env.GITHUB_TOKEN;\n`]])), [`${dep} holds a *_TOKEN or *_SECRET env read`]);
  assert.deepEqual(textFindings(new Map([[dep, `${read(dep)}\n// --yolo in a comment is not code\n`]])), [], 'a comment is stripped');
});

test('G94.3: every KNOWN_LAZY_EDGES entry is still a lazy require in a pre-existing file', () => {
  assert.deepEqual(staleEdges(), [], 'remove it from KNOWN_LAZY_EDGES');
  for (const edge of KNOWN_LAZY_EDGES) assert.ok(edge.why.length > 0, `${edge.from} -> ${edge.to} says why`);
});

test('G94.1 and G94.3 control: a planted lazy client require in a pre-existing file is found, and a removed listed edge fails G94.3', () => {
  const client = 'src/runtime/advice/client.ts';
  const engine = 'src/runtime/verification/engine.ts'; // pre-existing, reached by run-evidence.ts and inner-loop.ts
  const lazy = `${read(engine)}\nfunction plantedLazy() {\n  return ${plant(relative(engine, client))};\n}\n`;
  const found = closureFindings(new Map([[engine, lazy]]));
  assert.ok(found.includes(`src/runtime/run-evidence.ts reaches ${client}`));
  assert.ok(found.includes(`src/runtime/verification/inner-loop.ts reaches ${client}`));
  assert.ok(!found.includes(`src/runtime/guidance/rule-ledger.ts reaches ${client}`), 'a module whose closure lacks the file is not named');
  for (const edge of KNOWN_LAZY_EDGES) {
    const removed = read(edge.from).split(`require('${edge.to}')`).join('(void 0)');
    assert.notEqual(removed, read(edge.from), `${edge.from} holds ${edge.to}`);
    assert.deepEqual(staleEdges(new Map([[edge.from, removed]])), [`${edge.from} -> ${edge.to}`]);
  }
  const hoisted = 'src/runtime/claims.ts'; // the same require moved to the start of a line is eager, not a lazy edge
  const eager = `${read(hoisted).split("require('./advice/registry.ts')").join('(void 0)')}\nconst plantedEager = ${plant('./advice/registry.ts')};\n`;
  assert.deepEqual(staleEdges(new Map([[hoisted, eager]])), [`${hoisted} -> ./advice/registry.ts`]);
});
