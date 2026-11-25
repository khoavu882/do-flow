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
//   Which edges count: a row module's own requires all count, lazy ones too (a require inside a function is still a call path
//   the row added). In every other file only the requires at the start of a line count, the ones that run when the module
//   loads. Ceiling accepted: a lazy require inside a pre-existing file is not followed (`claims.ts` and `instructs-reader.ts`
//   lazily reach the model client, and verification/engine.ts reaches them, so a full walk would fail on code this row did
//   not write); G89.1 and the advice guards own those files.
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
function closureOf(entry: string, overlay: Map<string, string> = new Map()): { files: Set<string>; modules: Set<string> } {
  const files = new Set<string>();
  const modules = new Set<string>();
  const exists = (file: string) => overlay.has(file) || (fs.existsSync(path.join(REPO_ROOT, file)) && fs.statSync(path.join(REPO_ROOT, file)).isFile());
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = stripComments(overlay.get(file) ?? read(file));
    for (const line of text.split('\n')) {
      if (!ROW_MODULES.includes(file) && !/^\S/.test(line)) continue; // outside a row module only requires that run on load
      for (const [, specifier] of line.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
        if (!specifier.startsWith('.')) { modules.add(specifier.startsWith('node:') ? specifier : `node:${specifier}`); continue; }
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
        const found = [base, `${base}.ts`, `${base}/index.ts`].find(exists);
        if (found) visit(found);
      }
    }
  };
  visit(entry);
  return { files, modules };
}

/** What the closure of each row module reaches that it must not: forbidden files and modules, by name. */
function closureFindings(overlay?: Map<string, string>): string[] {
  return ROW_MODULES.flatMap((entry) => {
    const { files, modules } = closureOf(entry, overlay);
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
