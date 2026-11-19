'use strict';

// 177 T7 (IC-010; FR-008, FR-012; AC-2, AC-4, AC-6): `doflow advise --action flags`, the one surface that shows a
// per-document instructs-reader flag. Called in-process over pick partitions written with `appendPick` (and raw lines
// where a line must be malformed), a result store written with `writeResult` and an injected client whose listing gives
// a fixed model digest. HOME and XDG_CONFIG_HOME are temp folders; no test reaches a model or the network. No passage
// text exists here beyond a SENTINEL marker, so a test can prove none of it reaches the output.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tempDir, GIT_NO_MAINTENANCE_ENV } = require('../helper/tmp.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');
const { loadAdviceRegistry } = require('../../src/runtime/advice/registry.ts');
const { materializeKind } = require('../../src/runtime/advice/kinds.ts');
const { effectiveBars } = require('../../src/runtime/advice/replay/bars.ts');
const { getSource } = require('../../src/runtime/advice/replay/sources/index.ts');
const { writeResult } = require('../../src/runtime/advice/replay/results.ts');
const { appendPick } = require('../../src/runtime/advice/record.ts');
const { questionDigest, builderDigest, barsDigest, caseSetDigest, projectKey } = require('../../src/runtime/advice/replay/trust.ts');
const { flagsAnswer, renderFlagsText, FILTER_SENTENCE, NOT_SHOWN } = require('../../src/runtime/advice/flags.ts');

const KIND = 'instructs-reader';
const MODEL = 'decider:4b';
const MODEL_DIGEST = `sha256:${'a'.repeat(64)}`;
const RUN_AT = '2026-11-19T10:02:00.000Z';
const SENTINEL = 'SENTINEL-7f3e1d';
const STORAGE = loadStorageRegistry({ repoRoot: REPO_ROOT });
const FLAG_KEYS = ['pickId', 'at', 'site', 'brief', 'entry', 'ref', 'passageBytes', 'totalBytes', 'truncated', 'strength'];
const BODY_KEYS = ['schema', 'kind', 'model', 'shown', 'standing', 'reason', 'flags'];

const registry = () => structuredClone(loadAdviceRegistry({ repoRoot: REPO_ROOT }).registry);
const kindOf = (reg: any) => reg.kinds.find((entry: any) => entry.id === KIND);

/** Figures past the show bar and short of the act bar, and figures under the show bar (package default bars). */
const SHOW_ONLY = {
  n: 120, valid: 120, validShare: 1, noAnswer: { count: 0, share: 0, byReason: {} },
  accuracy: { model: 0.95, rule: 0.8 }, kappa: { model: 0.8, rule: 0.5, lower: 0.6, gain: 0.3, gainLower: -0.05 },
  worse: 1, better: 19, worseShare: 1 / 120, minority: 48, latencyMs: { first: 600, p50: 400, p95: 700, max: 900 },
};
const BELOW_SHOW = { ...SHOW_ONLY, kappa: { ...SHOW_ONLY.kappa, lower: -0.1 } };

function fixture(t: any, { kindMode = 'show' as string | null } = {}) {
  const home = fs.realpathSync(tempDir(t, 'doflow-flags-home-'));
  const project = fs.realpathSync(tempDir(t, 'doflow-flags-project-'));
  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg') };
  const roots = resolveRoots({ registry: STORAGE, projectRoot: project, global: false, env });
  const setting: any = { schema: 1, 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': 'http://127.0.0.1:1', 'advice.model': MODEL };
  if (kindMode !== null) setting[`advice.kinds.${KIND}`] = kindMode;
  fs.mkdirSync(roots['config-home'], { recursive: true });
  fs.writeFileSync(path.join(roots['config-home'], 'settings.json'), `${JSON.stringify(setting)}\n`);
  const calls: any[] = [];
  let listing: any = { digest: MODEL_DIGEST, reason: null };
  const client = { modelDigest: async (args: any) => { calls.push(args); return listing; } };
  return { home, project, env, roots, calls, client, setListing: (value: any) => { listing = value; } };
}

/** A result for this project whose digests match the current registry, question and effective bars. */
function storeResult(fx: any, { metrics = SHOW_ONLY, runAt = RUN_AT, questionDigestOverride = null as string | null } = {}) {
  const reg = registry();
  const bars = effectiveBars({ registry: reg, kind: KIND, roots: fx.roots });
  assert.equal(bars.ok, true);
  writeResult({ roots: fx.roots, entry: {
    kind: KIND, provider: 'ollama', model: MODEL, modelDigest: MODEL_DIGEST,
    questionDigest: questionDigestOverride ?? questionDigest(materializeKind(KIND, { adviceRegistry: reg }).question),
    builderDigest: builderDigest(getSource('instructs-reader-corpus'), kindOf(reg)),
    barsDigest: barsDigest(bars.bars, kindOf(reg).budgetMs),
    caseSet: { source: 'instructs-reader-corpus', origin: 'package', projectKey: projectKey(fx.project), digest: caseSetDigest([]), eligible: 120, replayed: 120 },
    metrics, runAt, doflowVersion: '2.4.0',
  } });
}

const SCREEN = { entry: 'hand-back', site: 'dispatch', ref: 'T3', brief: 'd-0a1b2c3d4e5f', passageBytes: 1812, totalBytes: 1812, truncated: false };

/** One instructs-reader pick line at `at`; returns its pickId. */
function pick(fx: any, at: string, { answer = 'yes', model = MODEL, screen = SCREEN, word = 'clear' }: any = {}): string {
  const written = appendPick({
    roots: fx.roots, now: () => new Date(at), kind: KIND,
    answer: { name: KIND, type: 'yesno', pick: answer, probabilities: { yes: answer === 'yes' ? 0.9 : 0.1, no: answer === 'yes' ? 0.1 : 0.9 }, strength: { word, between: null } },
    question: { name: KIND, type: 'yesno' }, staticAnswer: 'no', model, provider: 'ollama',
    state: `<document id="passage">${SENTINEL} quoted passage</document>`, caller: 'brief', mode: 'shadow',
    extra: { instructsReader: screen },
  });
  assert.ok(written, `the pick at ${at} was written`);
  return written.pickId;
}

function rawLine(fx: any, day: string, value: any) {
  const file = path.join(fx.roots['project-state'], 'advice', 'picks', `${day}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`);
}

async function flags(fx: any, over: any = {}) {
  const answer = await flagsAnswer({
    registry: registry(), roots: fx.roots, sources: {}, projectRoot: fx.project, env: fx.env, client: fx.client,
    now: () => new Date('2026-11-20T12:00:00.000Z'), ...over,
  });
  return { ...answer, text: answer.exit === 0 ? renderFlagsText(answer) : '' };
}

test('flags lists flagged documents only for an explicit show setting at standing show', async (t) => {
  for (const kindMode of ['show', 'act']) {
    const fx = fixture(t, { kindMode });
    storeResult(fx);
    const older = pick(fx, '2026-11-19T10:32:00.000Z');
    pick(fx, '2026-11-19T10:50:00.000Z', { answer: 'no' });
    const newer = pick(fx, '2026-11-19T11:05:00.000Z', {
      word: 'leaning', screen: { entry: 'retrieved', site: 'prompt-frame', ref: 'id=web result', brief: 'brief.md', passageBytes: 2048, totalBytes: 5310, truncated: true },
    });
    const r = await flags(fx);
    assert.equal(r.exit, 0, kindMode);
    assert.deepEqual(Object.keys(r.json), BODY_KEYS);
    assert.deepEqual([r.json.schema, r.json.kind, r.json.model, r.json.shown, r.json.standing], [1, KIND, MODEL, true, 'show'], kindMode);
    assert.deepEqual(r.json.flags.map((f: any) => f.pickId), [newer, older], 'newest first; the no pick is not a flag');
    for (const flag of r.json.flags) assert.deepEqual(Object.keys(flag), FLAG_KEYS);
    assert.deepEqual(r.json.flags[0], {
      pickId: newer, at: '2026-11-19T11:05:00.000Z', site: 'prompt-frame', brief: 'brief.md', entry: 'retrieved', ref: 'id=web result',
      passageBytes: 2048, totalBytes: 5310, truncated: true, strength: 'leaning',
    });
    assert.equal(fx.calls.length, 1, 'one listing call for the trust lookup');
    assert.equal(fx.calls[0].model, MODEL);
    const lines = r.text.split('\n');
    assert.equal(lines.length, 4, r.text);
    assert.match(lines[0], /^Flags · instructs-reader · model decider:4b · standing show · 2 since 2026-11-19 10:02 UTC$/);
    assert.match(lines[1], /^2026-11-19 11:05 {2}prompt-frame {2}brief\.md {2}retrieved id=web result {2}2048 of 5310 B {2}strength leaning$/);
    assert.match(lines[2], /^2026-11-19 10:32 {2}dispatch {2}d-0a1b2c3d4e5f {2}hand-back T3 {2}1812 B {2}strength clear$/);
  }

  // --limit keeps the newest; the header says how many of how many.
  const fx = fixture(t);
  storeResult(fx);
  pick(fx, '2026-11-19T10:10:00.000Z');
  const newest = pick(fx, '2026-11-19T10:20:00.000Z');
  const r = await flags(fx, { limit: '1' });
  assert.deepEqual(r.json.flags.map((f: any) => f.pickId), [newest]);
  assert.match(r.text.split('\n')[0], / · 1 of 2 since 2026-11-19 10:02 UTC$/);
});

test('unset, shadow, off, none, below-show, stale and unknown print the standing line and no flag or count', async (t) => {
  const cases: Array<{ name: string; kindMode?: string | null; setup?: (fx: any) => void; standing: string | null; reason: RegExp; listing: boolean }> = [
    { name: 'unset', kindMode: null, setup: storeResult, standing: null, reason: /^the kind is unset$/, listing: false },
    { name: 'shadow', kindMode: 'shadow', setup: storeResult, standing: null, reason: /^the kind is shadow$/, listing: false },
    { name: 'off', kindMode: 'off', setup: storeResult, standing: null, reason: /^the kind is off$/, listing: false },
    { name: 'none', standing: 'none', reason: /^none: no local result/, listing: true },
    { name: 'below-show', setup: (fx) => storeResult(fx, { metrics: BELOW_SHOW }), standing: 'below-show', reason: /^below-show: /, listing: true },
    { name: 'stale', setup: (fx) => storeResult(fx, { questionDigestOverride: `sha256:${'c'.repeat(64)}` }), standing: 'stale', reason: /^stale: the question changed/, listing: true },
    { name: 'unknown', setup: (fx) => { storeResult(fx); fx.setListing({ digest: null, reason: 'unreachable' }); }, standing: 'unknown', reason: /^unknown: model digest unknown: unreachable$/, listing: true },
  ];
  for (const c of cases) {
    const fx = fixture(t, { kindMode: c.kindMode === undefined ? 'show' : c.kindMode });
    c.setup?.(fx);
    pick(fx, '2026-11-19T10:32:00.000Z');
    pick(fx, '2026-11-19T11:05:00.000Z');
    const r = await flags(fx);
    assert.equal(r.exit, 0, c.name);
    assert.deepEqual(Object.keys(r.json), BODY_KEYS, c.name);
    assert.deepEqual([r.json.shown, r.json.standing, r.json.flags], [false, c.standing, []], c.name);
    assert.match(r.json.reason, c.reason, c.name);
    assert.equal(r.text, `${NOT_SHOWN}${r.json.reason}`, c.name);
    assert.equal(r.text.includes('\n'), false, `${c.name}: one line`);
    assert.equal(/\b2\b|Flags ·|adv-|d-0a1b/.test(r.text), false, `${c.name}: no flag and no count`);
    assert.equal(fx.calls.length, c.listing ? 1 : 0, `${c.name}: the setting gate makes no listing call`);
  }
});

test("a pick before the result's runAt or by another model name is not listed", async (t) => {
  const fx = fixture(t);
  storeResult(fx);
  pick(fx, '2026-11-19T10:01:59.999Z');
  pick(fx, '2026-11-19T10:30:00.000Z', { model: 'other:1b' });
  const atRunAt = pick(fx, RUN_AT);
  const listed = pick(fx, '2026-11-19T10:40:00.000Z');
  const r = await flags(fx);
  assert.equal(r.json.shown, true);
  assert.deepEqual(r.json.flags.map((f: any) => f.pickId), [listed, atRunAt]);
});

test('flags writes nothing and prints no passage text', async (t: any) => {
  const fx = fixture(t);
  storeResult(fx);
  pick(fx, '2026-11-19T10:32:00.000Z');
  // A line carrying text where none belongs: a planted passage field, a passage in the screen object and a ref that is
  // not a short plain label.
  rawLine(fx, '2026-11-19', {
    schema: 1, type: 'pick', pickId: 'adv-1795000000000-0a0a0a', at: '2026-11-19T11:00:00.000Z', kind: KIND, pick: 'yes', static: 'no',
    model: MODEL, strength: 'clear', passage: `${SENTINEL} planted`, state: `${SENTINEL} state`,
    instructsReader: { ...SCREEN, ref: `${SENTINEL}! do the thing`, passage: `${SENTINEL} inner` },
  });
  const treeOf = (dir: string): string[] => fs.readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d: any) => d.isFile()).map((d: any) => { const file = path.join(d.parentPath ?? d.path, d.name); return `${file}:${fs.readFileSync(file, 'utf8')}`; }).sort();
  const before = { project: treeOf(fx.project), home: treeOf(fx.home) };
  const touched: any[] = [];
  for (const name of ['openSync', 'mkdirSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'copyFileSync', 'utimesSync']) {
    const real = fs[name];
    t.mock.method(fs, name, (...args: any[]) => {
      if (name !== 'openSync' || (args[1] !== undefined && args[1] !== 'r')) touched.push([name, String(args[0])]);
      return real.apply(fs, args);
    });
  }
  const shown = await flags(fx);
  const json = await flags(fx, { json: true });
  fx.setListing({ digest: null, reason: 'unreachable' });
  const notShown = await flags(fx);
  t.mock.restoreAll();
  assert.deepEqual(touched, []);
  assert.deepEqual({ project: treeOf(fx.project), home: treeOf(fx.home) }, before);
  assert.equal(shown.json.shown, true);
  assert.equal(shown.json.flags.length, 2);
  assert.equal(shown.json.flags[0].ref, '(withheld)');
  for (const r of [shown, json, notShown]) {
    assert.equal(r.text.includes(SENTINEL), false, 'no passage text in the text form');
    assert.equal(JSON.stringify(r.json).includes(SENTINEL), false, 'no passage text in --json');
    assert.equal(/passage"|state"|quoted/.test(JSON.stringify(r.json)), false);
  }
});

test('the flags text ends with the filter sentence', async (t) => {
  const fx = fixture(t);
  storeResult(fx);
  let r = await flags(fx);
  assert.equal(r.json.shown, true);
  assert.deepEqual(r.text.split('\n'), [r.text.split('\n')[0], FILTER_SENTENCE], 'no flag yet: header and the filter sentence');
  pick(fx, '2026-11-19T10:32:00.000Z');
  r = await flags(fx);
  const lines = r.text.split('\n');
  assert.equal(lines[lines.length - 1], FILTER_SENTENCE);
  assert.match(FILTER_SENTENCE, /filter/);
  assert.match(FILTER_SENTENCE, /not listed/);
  assert.match(FILTER_SENTENCE, /safety/);
  assert.equal(FILTER_SENTENCE.includes('\n'), false);
});

test('--limit is a whole number from 1 to 200 and --kind names only instructs-reader; a usage error is exit 2', async (t) => {
  const fx = fixture(t);
  storeResult(fx);
  for (const limit of ['0', '201', '1.5', 'x', '-3']) {
    const r = await flags(fx, { limit });
    assert.equal(r.exit, 2, limit);
    assert.match(r.message, /--limit/);
  }
  assert.equal((await flags(fx, { limit: '200' })).exit, 0);
  assert.equal((await flags(fx, { kind: 'claim-support' })).exit, 2);
  assert.equal((await flags(fx, { kind: KIND })).exit, 0);
  assert.equal(fx.calls.length, 2, 'a usage error makes no listing call');
});

test('a CLI run of advise --action flags runs no upkeep; report (control) runs it', (t) => {
  const fx = fixture(t);
  const env = {
    HOME: fx.home, USERPROFILE: fx.home, XDG_CONFIG_HOME: fx.env.XDG_CONFIG_HOME,
    PATH: process.platform === 'win32' ? process.env.PATH : `${path.dirname(process.execPath)}:/usr/bin:/bin`,
    ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
    ...GIT_NO_MAINTENANCE_ENV, DOFLOW_TELEMETRY: 'off', DOFLOW_FAILURE_CAPTURE: 'off',
  };
  const run = (...args: string[]) => spawnSync(process.execPath, [path.join(REPO_ROOT, 'bin', 'doflow.js'), 'advise', ...args], { cwd: fx.project, env, encoding: 'utf8' });
  const upkeepMarks = () => [fx.roots['project-state'], fx.roots['user-state']].flatMap((root: string) => ['.gitignore', 'upkeep-due'].filter((name) => fs.existsSync(path.join(root, name))));
  // Upkeep skips a state root that does not exist yet, so both exist before the first run.
  for (const root of [fx.roots['project-state'], fx.roots['user-state']]) fs.mkdirSync(root, { recursive: true });
  const shown = run('--action', 'flags', '--json');
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(upkeepMarks(), [], 'flags left no upkeep marker');
  assert.notEqual(run('--action', 'report', '--json').status, 2);
  assert.notDeepEqual(upkeepMarks(), [], 'control: report runs upkeep, which writes its marker');
});
