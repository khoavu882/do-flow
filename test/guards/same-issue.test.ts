'use strict';

// G89 — the same-issue kind (row 176, design §13) stays rule-only on `add`, pinned, neutral and advisory.
//   G89.1  add is rule-only: the static require closure of `lifecycle/followup.ts` (relative requires followed
//          transitively) reaches no model client (`advice/client.ts`, `shadow-dispatcher.ts`, `shadow-runner.ts`),
//          no `same-issue/ask.ts`, no `followup-similar.ts` (the `--similar` model check, required lazily by
//          `lifecycle/cli.ts`) and no `node:http`, `node:https` or `node:net`. `node:child_process` is not listed: the
//          closure already reached it on develop through `feature-resolve.ts`, `status.ts` and `tool-lifecycle.ts`
//          (git), and no model call goes through it.
//   G89.2  pin: `CODE_DIGEST` of `replay/sources/review-findings.ts` equals `computeCodeDigest()`; the message says to
//          set the pin to the computed digest (moving a pin moves the builder digest, so stored results go stale).
//   G89.3  neutral: no vendor name (`vendorNames`), provider word or `name:tag` model literal in `same-issue/**`,
//          `advice/batch.ts`, `replay/sources/review-findings.ts`, `review/similar.ts`,
//          `lifecycle/followup-similar.ts`, nor in the same-issue kind's texts in `core/registry/advice.json`.
//   G89.4  advisory: `review/similar.ts`, `same-issue/**` and `lifecycle/followup-similar.ts` hold no write call
//          except the `--out` writer in `review/similar.ts`, the block from `if (check.shown && outFile) {` to
//          `result.out = target;`, which holds exactly one write, one rename and one temp-file cleanup.
//   Controls: each check fails on a planted-bad in-memory copy, never on the tree.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { CODE_DIGEST, computeCodeDigest } = require('../../src/runtime/advice/replay/sources/review-findings.ts');

const FOLLOWUP = 'src/runtime/lifecycle/followup.ts';
const SAME_ISSUE_DIR = 'src/runtime/advice/same-issue';
const SIMILAR = 'src/runtime/review/similar.ts';
const ASK = `${SAME_ISSUE_DIR}/ask.ts`;
const RULE = `${SAME_ISSUE_DIR}/rule.ts`;
const FOLLOWUP_SIMILAR = 'src/runtime/lifecycle/followup-similar.ts';

const ADVICE = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'advice.json'), 'utf8'));
const VENDORS: string[] = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'test/guards/prompt-frame-sites.json'), 'utf8')).vendorNames;
const PROVIDER_WORDS: string[] = [...new Set<string>((ADVICE.providers || []).flatMap((p: any) => [p.id, p.adapter, p.modelProvider]).filter((w: any) => typeof w === 'string' && w))];

const read = (file: string): string => fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const stripComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
const sameIssueFiles = (): string[] => fs.readdirSync(path.join(REPO_ROOT, SAME_ISSUE_DIR)).filter((name: string) => name.endsWith('.ts')).sort().map((name: string) => `${SAME_ISSUE_DIR}/${name}`);

// ---------------------------------------------------------------- G89.1

const FORBIDDEN_FILES = [
  'src/runtime/advice/client.ts', 'src/runtime/advice/shadow-dispatcher.ts', 'src/runtime/advice/shadow-runner.ts',
  ASK, FOLLOWUP_SIMILAR,
];
const FORBIDDEN_MODULES = ['node:http', 'node:https', 'node:net'];

/** Every repo-relative file and bare module the require closure of `entry` reaches; `overlay` replaces a file's text. */
function closureOf(entry: string, overlay: Map<string, string> = new Map()): { files: Set<string>; modules: Set<string> } {
  const files = new Set<string>();
  const modules = new Set<string>();
  const exists = (file: string) => overlay.has(file) || (fs.existsSync(path.join(REPO_ROOT, file)) && fs.statSync(path.join(REPO_ROOT, file)).isFile());
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    const text = stripComments(overlay.get(file) ?? read(file));
    for (const [, specifier] of text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      if (!specifier.startsWith('.')) { modules.add(specifier.startsWith('node:') ? specifier : `node:${specifier}`); continue; }
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      const found = [base, `${base}.ts`, `${base}/index.ts`].find(exists);
      if (found) visit(found);
    }
  };
  visit(entry);
  return { files, modules };
}

/** What the closure reaches that add must not: the forbidden files and modules, by name. */
function addFindings(overlay?: Map<string, string>): string[] {
  const { files, modules } = closureOf(FOLLOWUP, overlay);
  return [
    ...FORBIDDEN_FILES.filter((file) => files.has(file)).map((file) => `${FOLLOWUP} reaches ${file}`),
    ...FORBIDDEN_MODULES.filter((module) => modules.has(module)).map((module) => `${FOLLOWUP} reaches ${module}`),
  ];
}

test('G89.1: the require closure of followup.ts reaches no model client, ask, --similar check or network module', () => {
  assert.deepEqual(addFindings(), []);
});

test('G89.1 control: a planted require of same-issue/ask.ts, a lazy-looking http require and a transitive one are each found', () => {
  assert.deepEqual(addFindings(new Map([[FOLLOWUP, read(FOLLOWUP)]])), [], 'the copy is clean before the plant');
  const planted = `${read(FOLLOWUP)}\nconst { checkPairs: planted } = require('../advice/same-issue/ask.ts');\n`;
  assert.ok(addFindings(new Map([[FOLLOWUP, planted]])).includes(`${FOLLOWUP} reaches ${ASK}`));
  const http = `${read(FOLLOWUP)}\nconst plantedHttp = require('http');\n`;
  assert.deepEqual(addFindings(new Map([[FOLLOWUP, http]])), [`${FOLLOWUP} reaches node:http`]);
  const viaReader = `${read('src/runtime/lifecycle/status.ts')}\nconst plantedClient = require('../advice/client.ts');\n`;
  assert.ok(addFindings(new Map([['src/runtime/lifecycle/status.ts', viaReader]])).includes(`${FOLLOWUP} reaches src/runtime/advice/client.ts`));
});

// ---------------------------------------------------------------- G89.2

/** What is wrong with the `computed` digest against the pin; the message says to set the pin. */
function pinFindings(computed: string | null, pin: string): string[] {
  return computed === pin ? [] : [`the code digest differs from CODE_DIGEST: set CODE_DIGEST to ${computed}`];
}

test('G89.2: CODE_DIGEST equals computeCodeDigest()', () => {
  assert.deepEqual(pinFindings(computeCodeDigest(), CODE_DIGEST), []);
});

test('G89.2 control: one changed byte of rule.ts moves the digest off the pin, and the message says to set the pin', () => {
  const reading = (change: boolean) => ({
    readFileSync: (file: string, encoding?: string) => {
      const data: Buffer = fs.readFileSync(file);
      if (!change || path.relative(REPO_ROOT, file) !== RULE) return encoding ? data.toString(encoding) : data;
      const changed = Buffer.from(data);
      changed[changed.length - 2] ^= 0x01;
      return encoding ? changed.toString(encoding) : changed;
    },
  });
  assert.deepEqual(pinFindings(computeCodeDigest(reading(false)), CODE_DIGEST), [], 'the copy is clean before the plant');
  const moved = computeCodeDigest(reading(true));
  assert.notEqual(moved, CODE_DIGEST);
  assert.deepEqual(pinFindings(moved, CODE_DIGEST), [`the code digest differs from CODE_DIGEST: set CODE_DIGEST to ${moved}`]);
});

// ---------------------------------------------------------------- G89.3

// A model literal `name:tag`: a lowercase name and a tag that starts with a digit or is `latest`, as in `name:8b`.
const MODEL_LITERAL = /\b[a-z][a-z0-9._-]*:(?:\d[\w.-]*|latest)\b/;

/** What is not neutral in `text`: a vendor name, a provider word or a `name:tag` literal, as classes only. */
function neutralFindings(label: string, text: string): string[] {
  const found: string[] = [];
  if (VENDORS.some((word) => new RegExp(`\\b${escapeRegex(word)}\\b`, 'i').test(text))) found.push(`${label}: vendor name`);
  if (PROVIDER_WORDS.some((word) => new RegExp(`\\b${escapeRegex(word)}\\b`, 'i').test(text))) found.push(`${label}: provider word`);
  if (MODEL_LITERAL.test(text)) found.push(`${label}: name:tag model literal`);
  return found;
}

const NEUTRAL_FILES = (): string[] => [
  ...sameIssueFiles(), 'src/runtime/advice/batch.ts', 'src/runtime/advice/replay/sources/review-findings.ts', SIMILAR, FOLLOWUP_SIMILAR,
];
const kindTexts = (registry: any): string => {
  const kind = registry.kinds.find((entry: any) => entry.id === 'same-issue');
  return ['description', 'instructions', 'no', 'yes', 'staticFrom'].map((key) => String(kind?.[key] ?? '')).join('\n');
};

test('G89.3: the same-issue sources and the kind\'s texts hold no vendor name, provider word or model literal', () => {
  assert.ok(sameIssueFiles().length >= 2, 'same-issue/** has its files');
  const found = NEUTRAL_FILES().flatMap((file) => neutralFindings(file, read(file)));
  found.push(...neutralFindings('core/registry/advice.json same-issue texts', kindTexts(ADVICE)));
  assert.deepEqual(found, []);
});

test('G89.3 control: a planted vendor name, provider word and model literal are each found, in a source and in a kind text', () => {
  const clean = read(ASK);
  assert.deepEqual(neutralFindings(ASK, clean), [], 'the copy is clean before the plant');
  assert.deepEqual(neutralFindings(ASK, `${clean}\n// ask ${VENDORS[0]}\n`), [`${ASK}: vendor name`]);
  assert.deepEqual(neutralFindings(ASK, `${clean}\n// use ${PROVIDER_WORDS[0]}\n`), [`${ASK}: provider word`]);
  assert.deepEqual(neutralFindings(ASK, `${clean}\nconst model = 'alpha:8b';\n`), [`${ASK}: name:tag model literal`]);
  const registry = JSON.parse(JSON.stringify(ADVICE));
  registry.kinds.find((entry: any) => entry.id === 'same-issue').instructions += ` ${VENDORS[0]}`;
  assert.deepEqual(neutralFindings('kind', kindTexts(registry)), ['kind: vendor name']);
});

// ---------------------------------------------------------------- G89.4

const WRITE_CALL = /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|renameSync|rename|rmSync|rm|unlinkSync|unlink|mkdirSync|mkdir|createWriteStream|truncateSync|copyFileSync|symlinkSync)\s*\(|\bopenSync\s*\([^)]*['"`][^'"`]*[wa+][^'"`]*['"`]|\bfs\.promises\b|\bfsp\./;
const OUT_BLOCK_START = 'if (check.shown && outFile) {';
const OUT_BLOCK_END = 'result.out = target;';

/** Split the --out writer block from `code`; the rest and the block are checked separately. */
function splitOutBlock(code: string): { rest: string; block: string } | null {
  const start = code.indexOf(OUT_BLOCK_START);
  const end = code.indexOf(OUT_BLOCK_END, start);
  if (start < 0 || end < 0) return null;
  return { rest: code.slice(0, start) + code.slice(end + OUT_BLOCK_END.length), block: code.slice(start, end + OUT_BLOCK_END.length) };
}

/** Write calls outside the allowed --out writer, by file; `overlay` replaces a file's text. */
function writeFindings(overlay: Map<string, string> = new Map()): string[] {
  const found: string[] = [];
  for (const file of [SIMILAR, ...sameIssueFiles(), FOLLOWUP_SIMILAR]) {
    let code = stripComments(overlay.get(file) ?? read(file));
    if (file === SIMILAR) {
      const parts = splitOutBlock(code);
      if (!parts) { found.push(`${file}: the --out writer block is not found`); continue; }
      const counts = ['writeFileSync', 'renameSync', 'rmSync'].map((name) => (parts.block.match(new RegExp(`\\b${name}\\s*\\(`, 'g')) || []).length);
      const others = parts.block.replace(/\bfs\.(?:writeFileSync|renameSync|rmSync)\s*\(/g, '');
      if (counts.join() !== '1,1,1') found.push(`${file}: the --out writer holds ${counts.join(',')} write, rename, cleanup calls, not 1,1,1`);
      if (WRITE_CALL.test(others)) found.push(`${file}: the --out writer holds a further write call`);
      code = parts.rest;
    }
    if (WRITE_CALL.test(code)) found.push(`${file}: a write call`);
  }
  return found;
}

test('G89.4: review/similar.ts, same-issue/** and followup-similar.ts write nothing but the --out file', () => {
  assert.deepEqual(writeFindings(), []);
});

test('G89.4 control: a planted writeFileSync in ask.ts, a second write site in similar.ts and a planted createWriteStream are each found', () => {
  assert.deepEqual(writeFindings(new Map([[SIMILAR, read(SIMILAR)]])), [], 'the copy is clean before the plant');
  assert.deepEqual(writeFindings(new Map([[ASK, `${read(ASK)}\nfs.writeFileSync('x', 'y');\n`]])), [`${ASK}: a write call`]);
  assert.deepEqual(writeFindings(new Map([[SIMILAR, `${read(SIMILAR)}\nfunction extra() { fs.appendFileSync('x', 'y'); }\n`]])), [`${SIMILAR}: a write call`]);
  assert.deepEqual(writeFindings(new Map([[FOLLOWUP_SIMILAR, `${read(FOLLOWUP_SIMILAR)}\nconst s = fs.createWriteStream('x');\n`]])), [`${FOLLOWUP_SIMILAR}: a write call`]);
  const second = read(SIMILAR).replace('fs.renameSync(temp, target);', 'fs.renameSync(temp, target);\n      fs.writeFileSync(`${target}.bak`, \'\');');
  assert.ok(writeFindings(new Map([[SIMILAR, second]])).some((finding) => finding.includes('not 1,1,1')));
});
