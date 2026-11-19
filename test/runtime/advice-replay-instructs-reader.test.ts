'use strict';

// 177 T4 (design section 8, AC-3): the `instructs-reader-corpus` case source over the shipped ROT13 corpus. The source
// decodes in memory only: no assertion here prints a decoded passage, and every message names case ids or counts. The
// replay test runs the real CLI against an in-process fake decision server with a scratch HOME, so no model is reached.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createScratch, childEnv } = require('../helper/scratch-env.ts');
const { startFakeServer } = require('../helper/fake-decision-server.ts');
const { tempDir } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { getSource, buildCases, optionNames } = require('../../src/runtime/advice/replay/sources/index.ts');
const { CORPUS_DIGEST, RULE_DIGEST, computeDigests, source, build } = require('../../src/runtime/advice/replay/sources/instructs-reader-corpus.ts');
const { RULE_PATTERNS } = require('../../src/runtime/advice/instructs-reader.ts');

const KIND = 'instructs-reader';
const CORPUS_FILE = path.join(REPO_ROOT, 'src', 'runtime', 'advice', 'replay', 'corpora', 'instructs-reader.json');
const kindEntry = () => loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry.kinds.find((entry: any) => entry.id === KIND);
const input = (over: any = {}) => ({ projectRoot: '/nowhere', roots: {}, kind: kindEntry(), ...over });

test('the corpus source builds 120 cases, both classes past the show minimums, origin package, labelIsRule false', () => {
  assert.equal(getSource('instructs-reader-corpus'), source);
  assert.deepEqual([source.id, source.origin, source.labelIsRule, source.builderVersion], ['instructs-reader-corpus', 'package', false, 1]);
  assert.equal(kindEntry().replay.source, 'instructs-reader-corpus');

  const built = buildCases(source, input(), optionNames({ type: 'yesno' }));
  assert.equal(built.cases.length, 120, `eligible cases, skipped ${JSON.stringify(built.skipped)}`);
  assert.deepEqual(built.skipped, {});
  const yes = built.cases.filter((c: any) => c.label === 'yes').length;
  const no = built.cases.filter((c: any) => c.label === 'no').length;
  assert.deepEqual([yes, no], [48, 72]);
  const bars = loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry.bars;
  assert.ok(Math.min(yes, no) >= bars.show.minMinority, 'the smaller class reaches the show minimum');
  assert.ok(built.cases.length >= bars.show.minCases, 'the case count reaches the show minimum');
  assert.ok(built.cases.every((c: any) => c.rule === 'yes' || c.rule === 'no'));
  assert.ok(built.cases.every((c: any) => typeof c.state === 'string' && c.state.length > 0));
});

test('case ids are sha256 prefixes and sorted', () => {
  const corpus = JSON.parse(fs.readFileSync(CORPUS_FILE, 'utf8'));
  const expected = corpus.cases
    .map((entry: any) => crypto.createHash('sha256').update(`instructs-reader\n${entry.id}`).digest('hex').slice(0, 16))
    .sort();
  const ids = build(input()).cases.map((c: any) => c.id);
  assert.ok(ids.every((id: string) => /^[0-9a-f]{16}$/.test(id)));
  assert.deepEqual(ids, expected);
  assert.equal(new Set(ids).size, ids.length);
});

test('the pinned digests are those of the shipped file and rule, and a changed rule moves its digest', () => {
  assert.match(CORPUS_DIGEST, /^[0-9a-f]{64}$/);
  assert.match(RULE_DIGEST, /^[0-9a-f]{64}$/);
  assert.deepEqual(computeDigests(), { corpus: CORPUS_DIGEST, rule: RULE_DIGEST });
  const hex = (data: string | Buffer) => crypto.createHash('sha256').update(data).digest('hex');
  assert.equal(computeDigests().corpus, hex(fs.readFileSync(CORPUS_FILE)));
  assert.equal(computeDigests().rule, hex(RULE_PATTERNS.map((pattern: RegExp) => pattern.source).join('\n')));
  assert.notEqual(computeDigests([...RULE_PATTERNS, /extra/]).rule, RULE_DIGEST);
});

test('the source reads only the package file, never the project', (t) => {
  const project = tempDir(t, 'doflow-ir-corpus-project-');
  // A planted corpus at the same relative place inside the project, with one case; the package file has 120.
  const planted = path.join(project, 'src', 'runtime', 'advice', 'replay', 'corpora');
  fs.mkdirSync(planted, { recursive: true });
  fs.writeFileSync(path.join(planted, 'instructs-reader.json'), JSON.stringify({ schemaVersion: 1, kind: KIND, corpusVersion: 1, encoding: 'rot13', cases: [{ id: 'planted', category: 'N1', label: 'no', passage: 'abg n qverpgvir' }] }));
  const read: string[] = [];
  const fsImpl = new Proxy(fs, {
    get(target: any, prop: any) {
      const value = target[prop];
      if (typeof value !== 'function') return value;
      return (...args: any[]) => { if (typeof args[0] === 'string') read.push(args[0]); return value.apply(target, args); };
    },
  });
  const built = build(input({ projectRoot: project, fsImpl }));
  assert.equal(built.cases.length, 120);
  assert.deepEqual(read.filter((file) => file.startsWith(`${project}${path.sep}`) || file.startsWith(project)), [], 'no path under the project was touched');
  assert.ok(read.includes(CORPUS_FILE), 'the package corpus file was read');
});

test('an unreadable corpus, a bad entry and an empty passage are skipped and counted, never thrown', (t) => {
  const dir = tempDir(t, 'doflow-ir-corpus-fs-');
  const fileWith = (text: string | null) => ({
    ...fs,
    readFileSync: (file: string, ...rest: any[]) => { if (file === CORPUS_FILE && text !== null) return text; if (file === CORPUS_FILE) throw new Error('gone'); return (fs as any).readFileSync(file, ...rest); },
  });
  assert.deepEqual(build(input({ fsImpl: fileWith(null) })), { cases: [], skipped: { 'unreadable-file': 1 } });
  assert.deepEqual(build(input({ fsImpl: fileWith('{ torn') })), { cases: [], skipped: { 'unreadable-file': 1 } });
  assert.deepEqual(build(input({ fsImpl: fileWith('{"cases": 3}') })), { cases: [], skipped: { 'unreadable-file': 1 } });
  const entries = [null, { id: 'a', label: 'yes' }, { id: 'b', label: 'no', passage: '   ' }, { id: 'c', label: 'no', passage: 'nop' }];
  const odd = build(input({ fsImpl: fileWith(JSON.stringify({ cases: entries })) }));
  assert.deepEqual(odd.skipped, { 'bad-entry': 2, 'empty-passage': 1 });
  assert.deepEqual(odd.cases.map((c: any) => c.label), ['no']);
  assert.deepEqual(build(input({ kind: { params: { passageBytes: 0 } } })).skipped, { 'bad-params': 120 });
  assert.ok(dir);
});

// ---- replay through the CLI ----

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');

/** The fake server answers each yes/no question with the probability the test chose for that case's state. */
async function replayFixture(t: any, probabilityOf: (state: string) => number) {
  const scratch = createScratch('doflow-advice-replay-ir-');
  const project = path.join(scratch.dir, 'project');
  fs.mkdirSync(project);
  const server = await startFakeServer({ routes: {
    'POST /v1/systemone': async ({ body }: any) => ({
      status: 200,
      body: { answers: Object.fromEntries(Object.keys(body?.questions || {}).map((name) => [name, { noul: probabilityOf(String(body?.state || '')) }])) },
    }),
  } });
  t.after(async () => { await server.close(); scratch.remove(); });
  fs.mkdirSync(path.join(scratch.xdg, 'doflow'), { recursive: true });
  fs.writeFileSync(path.join(scratch.xdg, 'doflow', 'settings.json'), JSON.stringify({
    schema: 1, 'storage.prune': 'off', 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
  }));
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [BIN, 'advise', '--action', 'replay', '--kind', KIND], {
      cwd: project, env: childEnv(scratch, { CI: null, DOFLOW_SESSION_ROLE: null, DOFLOW_AUTOPILOT_ENABLED: null }), stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: any) => { stdout += chunk; });
    child.stderr.on('data', (chunk: any) => { stderr += chunk; });
    child.stdin.end();
    child.on('close', (status: number) => resolve({ status, stdout, stderr }));
  });
}

test('replay of instructs-reader with a fake client prints misses apart from false alarms for model and rule', async (t) => {
  const cases = build(input()).cases;
  // The model agrees with every label except two yes cases it answers no (misses) and one no case it answers yes.
  const flipped = new Map<string, number>();
  cases.filter((c: any) => c.label === 'yes').slice(0, 2).forEach((c: any) => flipped.set(c.state, 0.1));
  cases.filter((c: any) => c.label === 'no').slice(0, 1).forEach((c: any) => flipped.set(c.state, 0.9));
  const byState = new Map<string, string>(cases.map((c: any) => [c.state, c.label]));
  const result = await replayFixture(t, (state) => flipped.get(state) ?? (byState.get(state) === 'yes' ? 0.9 : 0.1));
  assert.equal(result.status, 0, result.stderr);

  const ruleMisses = cases.filter((c: any) => c.label === 'yes' && c.rule === 'no').length;
  const ruleFalseAlarms = cases.filter((c: any) => c.label === 'no' && c.rule === 'yes').length;
  const lines = result.stdout.trimEnd().split('\n');
  const perClass = lines.findIndex((line) => line.startsWith('Per class, precision/recall'));
  assert.ok(perClass >= 0, 'the per-class line is printed');
  assert.equal(lines[perClass + 1], `Misses (labelled yes, answered no): model 2 of 48 · rule ${ruleMisses} of 48`);
  assert.equal(lines[perClass + 2], `False alarms (labelled no, answered yes): model 1 of 72 · rule ${ruleFalseAlarms} of 72`);
  assert.match(result.stdout, /^Replay instructs-reader · .* 120 of 120 cases · source instructs-reader-corpus \(the installed package\)$/m);
  assert.match(result.stdout, /^Standing: /m);
  assert.ok(!/measure-only/.test(result.stdout), 'a package source with its own labels is not measure-only');
});
