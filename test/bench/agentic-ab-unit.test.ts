'use strict';

// With/without-DoFlow A/B (WP-2), offline units: the A/B config and task loaders, the review adapter and
// the run grader (leak, proof, metric extraction). No process is spawned and no model is touched; the
// stream-json inputs are the WP-1 fixtures (test/fixtures/claude-headless) plus small edits of them.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');
const execute = require('../../bench/agentic/execute.ts');
const tasksLib = require('../../bench/agentic/tasks.ts');
const adapter = require('../../bench/agentic/review-adapter.ts');
const grade = require('../../bench/agentic/grade.ts');
const claudeStream = require('../../bench/agentic/ab/claude-stream.ts');
const reportLib = require('../../bench/agentic/report.ts');
const reviewMiss = require('../../bench/review-miss/grade.ts');
const reviewCorpus = require('../../bench/review-miss/corpus.ts');

const REPO = path.join(__dirname, '..', '..');
const REAL_CONFIG = path.join(REPO, 'bench', 'agentic', 'ab', 'config.json');
const FIXTURES = path.join(REPO, 'test', 'fixtures', 'claude-headless');
const TMP = suiteTempDir('doflow-agentic-ab-unit-');
const clone = (v: any) => JSON.parse(JSON.stringify(v));
let dirSeq = 0;
const mkdir = (prefix: string) => {
  const dir = path.join(TMP, `${prefix}${++dirSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const readText = (f: string) => fs.readFileSync(f, 'utf8');

let counter = 0;
/** Loads the real A/B config after `mutate` edited a copy of it (through the real loader). */
function loadWith(mutate: (cfg: any) => void) {
  const cfg = JSON.parse(readText(REAL_CONFIG));
  mutate(cfg);
  const file = path.join(TMP, `config-${++counter}.json`);
  fs.writeFileSync(file, JSON.stringify(cfg));
  return execute.loadConfig(file);
}
const refusal = (mutate: (cfg: any) => void) => {
  try {
    loadWith(mutate);
  } catch (e: any) {
    return e;
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// Config

test('the committed A/B config loads, names two roles and leaves the per-run cap unset', () => {
  const config = execute.loadConfig(REAL_CONFIG);
  assert.equal(config.mode, 'ab');
  assert.deepEqual(config.roles, { baseline: 'A', candidate: 'B' });
  assert.equal(config.maxTokensPerRun, null, 'the user approves the cap at run time');
  assert.equal(config.arms.A.homeSetup, null);
  assert.deepEqual(config.arms.B.homeSetup.argv.slice(-2), ['--mcp', 'none']);
  assert.equal(config.arms.A.paragraph, config.arms.B.paragraph);
  assert.equal(config.recipeData.parser.id, 'claude-stream-json-v1');
  assert.match(config.recipeSha256, /^[0-9a-f]{64}$/);
});

test('config refusals: gemini target, missing --mcp none, unequal paragraphs, model drift, bad cap, wrong proof roles', () => {
  const cases: [string, (c: any) => void, RegExp][] = [
    ['gemini target', (c) => { c.arms.B.homeSetup.argv.push('-t', 'gemini'); }, /gemini|exactly one target/],
    ['no --mcp none', (c) => { c.arms.B.homeSetup.argv = c.arms.B.homeSetup.argv.filter((a: string) => a !== '--mcp' && a !== 'none'); }, /--mcp none/],
    ['not global', (c) => { c.arms.B.homeSetup.argv = c.arms.B.homeSetup.argv.filter((a: string) => a !== '-g'); }, /global install/],
    ['unequal paragraphs', (c) => { c.arms.B.paragraph = 'something else'; }, /paragraph/],
    ['model drift', (c) => { c.model.label = 'claude-other'; }, /model\.label/],
    ['zero cap', (c) => { c.maxTokensPerRun = 0; }, /maxTokensPerRun/],
    ['string cap', (c) => { c.maxTokensPerRun = '1000'; }, /maxTokensPerRun/],
    ['missing homeSetup key', (c) => { delete c.arms.A.homeSetup; }, /homeSetup/],
    ['baseline must prove absent', (c) => { c.roles = { baseline: 'B', candidate: 'A' }; }, /prove DoFlow absent/],
    ['no credential names', (c) => { c.credentialEnv = []; }, /credentialEnv/],
    ['bad regex', (c) => { c.arms.A.leak.push('('); }, /leak/],
  ];
  for (const [name, mutate, re] of cases) {
    const e = refusal(mutate);
    assert.ok(e, `${name} must be refused`);
    assert.equal(e.reason, 'config-invalid', name);
    assert.match(e.message, re, name);
  }
});

test('config refusal: a recipe that passes a forbidden flag (--bare) is rejected', () => {
  const recipe = JSON.parse(readText(path.join(REPO, 'bench', 'agentic', 'ab', 'recipe.json')));
  recipe.argv.push({ flag: '--bare' });
  const recipeFile = path.join(TMP, 'recipe-bare.json');
  fs.writeFileSync(recipeFile, JSON.stringify(recipe));
  const e = refusal((c) => { c.recipe = recipeFile; });
  assert.match(e.message, /forbidden flag --bare/);
});

// ---------------------------------------------------------------------------------------------
// Tasks

test('the committed A/B tasks load: T1 routing, T2 pauses, T3, T4 review, T5, T6, one prompt for both arms', () => {
  const config = execute.loadConfig(REAL_CONFIG);
  const set = tasksLib.loadAbTaskSet({ repoRoot: REPO, config });
  assert.deepEqual(set.tasks.map((t: any) => t.id), ['routing', 'unnecessary-pauses', 'refactor-shared-format', 'review-113', 'doc-options-sync', 'conflicting-instructions']);
  assert.deepEqual(set.tasks.map((t: any) => t.kind), ['edit', 'edit', 'edit', 'review', 'edit', 'edit']);
  assert.equal(set.heldout.length, 0);
  for (const t of set.tasks) assert.match(t.key, /^ab\/[a-z0-9-]+@[0-9a-f]{8}$/);
  const review = set.tasks.find((t: any) => t.kind === 'review');
  assert.equal(review.review.rev, 'a13276a4ab32200b54ad90e8eba9c470cae68f8b');
  assert.equal(review.review.caseIds.length, 7);
  for (const t of set.tasks.filter((x: any) => x.kind === 'edit')) {
    assert.ok(t.checks.length > 0 && Object.keys(t.files).length > 0, `${t.id} takes files and checks from its native case`);
    assert.equal(tasksLib.buildAbPrompt(t, config.arms.A.paragraph), tasksLib.buildAbPrompt(t, config.arms.B.paragraph));
  }
  assert.match(tasksLib.buildAbPrompt(review, 'P'), /review\.json/);
  assert.match(tasksLib.buildAbPrompt(review, 'P'), /Do not edit any source file/);
});

test('task refusals: unknown native case, duplicate id, bad kind, short revision', () => {
  const native = path.join(TMP, 'native.json');
  fs.writeFileSync(native, JSON.stringify({ cases: [{ id: 'one', messages: ['do it'], files: { 'a.js': 'x' }, checks: 'process.exit(0)' }, { id: 'two', messages: ['a', 'b'], files: {}, checks: 'x' }] }));
  const tryTasks = (tasks: any[]) => {
    const file = path.join(TMP, `tasks-${++counter}.json`);
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, tasks }));
    try {
      tasksLib.loadAbTaskSet({ repoRoot: REPO, tasksPath: file, nativePath: native });
    } catch (e: any) {
      return e.reason;
    }
    return null;
  };
  assert.equal(tryTasks([{ id: 'x', name: 'n', kind: 'edit', nativeCase: 'nope' }]), 'native-case-unknown');
  assert.equal(tryTasks([{ id: 'x', name: 'n', kind: 'edit', nativeCase: 'two' }]), 'native-case-shape');
  assert.equal(tryTasks([{ id: 'x', name: 'n', kind: 'edit', nativeCase: 'one' }, { id: 'x', name: 'n', kind: 'edit', nativeCase: 'one' }]), 'duplicate-id');
  assert.equal(tryTasks([{ id: 'x', name: 'n', kind: 'retrieval' }]), 'task-kind');
  assert.equal(tryTasks([{ id: 'x', name: 'n', kind: 'review', review: { rev: 'abc', scope: ['a'], focus: ['a'], caseIds: ['c'] } }]), 'review-shape');
  assert.equal(tryTasks([{ id: 'x', name: 'n', kind: 'edit', nativeCase: 'one' }]), null);
});

// ---------------------------------------------------------------------------------------------
// Review adapter

const REV = 'a'.repeat(40);
const caseOf = (id: string, line: number, split = 'train') => {
  const c: any = { id, rev: REV, scope: ['src/a.ts'], expected: { path: 'src/a.ts', startLine: line, endLine: line, severity: 'should-fix' }, split, source: {} };
  c.key = reviewCorpus.caseKey(c);
  return c;
};
const CORPUS = { kind: 'review-miss', schema: 1, cases: [caseOf('c-1', 10), caseOf('c-2', 40), caseOf('c-3', 80, 'heldout')] };
const REVIEW_TASK = { id: 'rv', kind: 'review', review: { rev: REV, scope: ['src/a.ts'], focus: ['src/a.ts'], caseIds: ['c-1', 'c-2', 'c-3'] } };
const REVIEW_CONFIG = { tolerance: 3, maxSpan: 60 };

test('review adapter: parseReviewJson keeps valid entries, drops and counts the rest, relativises workspace paths', () => {
  const ok = adapter.parseReviewJson(JSON.stringify([
    { path: '/w/space/src/a.ts', startLine: 3, endLine: 4, severity: 'blocker', title: 't' },
    { path: 'src/b.ts', startLine: 0, endLine: 1, severity: 'blocker', title: 't' },
    { path: 'src/b.ts', startLine: 1, endLine: 1, severity: 'catastrophic', title: 't' },
    'junk',
  ]), '/w/space');
  assert.equal(ok.ok, true);
  assert.equal(ok.dropped, 3);
  assert.deepEqual(ok.findings.map((f: any) => f.path), ['src/a.ts']);
  assert.equal(adapter.parseReviewJson(null).reason, 'absent');
  assert.equal(adapter.parseReviewJson('{oops').reason, 'invalid-json');
  assert.equal(adapter.parseReviewJson('{"a":1}').reason, 'not-an-array');
});

function adaptWith(reviewText: string | null, infra: string | null = null) {
  const dir = mkdir('adapt-');
  const runDir = path.join(dir, 'runs', 'rv');
  fs.mkdirSync(runDir, { recursive: true });
  if (reviewText !== null) fs.writeFileSync(path.join(runDir, 'review.json'), reviewText);
  return adapter.adaptIteration({
    entries: [{ task: REVIEW_TASK, runDir, infra, workspaceRoot: '/w' }], corpus: CORPUS, config: REVIEW_CONFIG,
    iterationDir: path.join(dir, 'review-miss', 'ab-x'), name: 'ab-x', meta: { model: 'm', sourceAt: REV }, reviewFile: 'review.json',
  });
}

test('review adapter: findings are scored by the review-miss scorer; malformed output is a miss, not an exclusion', () => {
  const found = adaptWith(JSON.stringify([{ path: 'src/a.ts', startLine: 10, endLine: 11, severity: 'should-fix', title: 'x' }]));
  assert.equal(found.grade.runs[CORPUS.cases[0].key].passRate, 1);
  assert.equal(found.grade.runs[CORPUS.cases[1].key].passRate, 0);
  assert.equal(found.grade.runs[CORPUS.cases[0].key].excluded, null);
  for (const bad of ['not json', '{"a":1}', null]) {
    const { grade: g } = adaptWith(bad);
    for (const c of CORPUS.cases) {
      assert.equal(g.runs[c.key].passRate, 0, `${bad}: a miss`);
      assert.equal(g.runs[c.key].excluded, null, `${bad}: counted, not excluded`);
    }
  }
});

test('review adapter: an infra run is excluded; a corpus at another revision is refused', () => {
  const { grade: g } = adaptWith('[]', 'timeout');
  for (const c of CORPUS.cases) assert.equal(g.runs[c.key].excluded, 'timeout');
  const dir = mkdir('adapt-');
  const wrong = { ...CORPUS, cases: [{ ...CORPUS.cases[0], rev: 'b'.repeat(40) }, CORPUS.cases[1], CORPUS.cases[2]] };
  assert.throws(() => adapter.adaptIteration({
    entries: [{ task: REVIEW_TASK, runDir: dir, infra: null, workspaceRoot: null }], corpus: wrong, config: REVIEW_CONFIG,
    iterationDir: path.join(dir, 'x'), name: 'ab-x', meta: { model: 'm', sourceAt: REV }, reviewFile: 'review.json',
  }), reviewCorpus.UsageError);
  assert.ok(reviewMiss.FILES.grade);
});

// ---------------------------------------------------------------------------------------------
// Grader: leak, proof and metric extraction

const CONFIG = execute.loadConfig(REAL_CONFIG);
const EXPECTED = { skills: ['do', 'do-implement'], agents: ['core-implementer', 'reviewer'] };
const TASK = { id: 't', key: 'ab/t@00000000', split: 'train', kind: 'edit', group: 'success', checks: 'process.exit(0)', expectedSkills: ['do-implement'] };

/** A run directory built from a stream (text), as the executor would leave it. */
function runDirOf(stream: string, extra: any = {}) {
  const dir = mkdir('run-');
  fs.writeFileSync(path.join(dir, 'transcript.jsonl'), stream);
  fs.writeFileSync(path.join(dir, 'run_status.json'), JSON.stringify(extra.status || { status: 'completed', exitCode: 0, signal: null }));
  fs.writeFileSync(path.join(dir, 'timing.json'), JSON.stringify({ duration_ms: 41250, usage: 'reported' }));
  fs.writeFileSync(path.join(dir, 'launch.json'), JSON.stringify({ workspaceRoot: '/scratch/workspace', profileRoot: '/scratch', proofExpected: EXPECTED, ...(extra.launch || {}) }));
  if (extra.homeSetup) fs.writeFileSync(path.join(dir, 'home-setup.json'), JSON.stringify(extra.homeSetup));
  if (extra.segments) fs.writeFileSync(path.join(dir, 'segments.json'), JSON.stringify(extra.segments));
  fs.mkdirSync(path.join(dir, 'workspace'));
  return dir;
}
const fixture = (name: string) => readText(path.join(FIXTURES, `${name}.stream.jsonl`));
const withLineBeforeResult = (stream: string, event: any) => {
  const lines = stream.trimEnd().split('\n');
  lines.splice(lines.length - 1, 0, JSON.stringify(event));
  return `${lines.join('\n')}\n`;
};
const bashEvent = (command: string) => ({ type: 'assistant', message: { id: 'mx', role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: 'tux', name: 'Bash', input: { command } }] }, parent_tool_use_id: null });
const gradeOf = (runDir: string, arm: string, config: any = CONFIG, task: any = TASK) => grade.gradeAbRun({ runDir, task, arm, config });

test('grade: arm B with DoFlow loaded is clean, proven and metered (tokens, cost, tool calls, subagents, questions)', () => {
  const g = gradeOf(runDirOf(fixture('arm-b-doflow'), { homeSetup: { ok: true, exitCode: 0 } }), 'B');
  assert.equal(g.isolation, 'clean', JSON.stringify(g.isolationEvidence));
  assert.equal(g.infra, null);
  assert.equal(g.proof.loaded, true);
  assert.equal(g.proof.p1, true);
  assert.equal(g.pass_rate, 1, 'the checks ran against the workspace copy');
  assert.deepEqual(g.metrics.tokens, { input: 42, output: 1300, cacheCreation: 23000, cacheRead: 98000, total: 122342 });
  assert.equal(g.metrics.subagentTokens, 11430, 'the part outside the main loop');
  assert.deepEqual(Object.keys(g.metrics.byModel).sort(), ['claude-haiku-4-5', 'claude-sonnet-5-5']);
  assert.equal(g.metrics.costUsd, 0.3125);
  assert.equal(g.metrics.wallMs, 41250);
  assert.equal(g.metrics.toolCalls, 7);
  assert.equal(g.metrics.subagentCalls, 1);
  assert.equal(g.metrics.questions.pauses, 0, 'the closing question is an offer ("Shall I also ..."), not a block');
  assert.equal(g.metrics.questions.offers, 1);
  assert.equal(g.routing.routed, true, 'P4: the expected skill was invoked');
});

test('grade: arm A bare Claude is clean and proven absent; its routing is not evaluated', () => {
  const g = gradeOf(runDirOf(fixture('arm-a-plain')), 'A');
  assert.equal(g.isolation, 'clean');
  assert.equal(g.proof.absent, true);
  assert.equal(g.routing, null);
  assert.equal(g.metrics.tokens.total, 5 + 50 + 9000);
});

test('grade: DoFlow in arm A init is a leak; arm B without DoFlow is not-loaded; a failed install is not-loaded and never scored', () => {
  const leak = gradeOf(runDirOf(fixture('arm-b-doflow')), 'A');
  assert.equal(leak.isolation, 'leaked');
  assert.match(leak.isolationEvidence.join('|'), /init lists DoFlow/);
  assert.equal(leak.pass_rate, null, 'an excluded run is never scored');
  const notLoaded = gradeOf(runDirOf(fixture('arm-a-plain'), { homeSetup: { ok: true, exitCode: 0 } }), 'B');
  assert.equal(notLoaded.isolation, 'not-loaded');
  assert.match(notLoaded.isolationEvidence.join('|'), /P2\/P3/);
  const failed = gradeOf(runDirOf('', { homeSetup: { ok: false, exitCode: 1 }, status: { status: 'truncated', evidence: 'homeSetup failed' } }), 'B');
  assert.equal(failed.isolation, 'not-loaded');
  assert.match(failed.isolationEvidence.join('|'), /P1 failed/);
  assert.equal(failed.exclusionReason, 'not-loaded');
});

test('grade: no SessionStart hook is not-loaded even when the skills are listed (P3)', () => {
  const noHook = fixture('arm-b-doflow').split('\n').filter((l: string) => !l.includes('"hook_event":"SessionStart"')).join('\n');
  const g = gradeOf(runDirOf(noHook, { homeSetup: { ok: true, exitCode: 0 } }), 'B');
  assert.equal(g.isolation, 'not-loaded');
  assert.equal(g.proof.sessionStartOk, false);
});

test('grade: network commands, DoFlow paths in arm A, MCP and truth paths, and reads outside the roots are leaks', () => {
  const base = fixture('arm-b-doflow');
  const ofCommand = (command: string, arm: string) => gradeOf(runDirOf(withLineBeforeResult(base, bashEvent(command)), { homeSetup: { ok: true, exitCode: 0 } }), arm).isolation;
  assert.equal(ofCommand('curl http://example.test', 'B'), 'leaked');
  assert.equal(ofCommand('cd x && npm install', 'B'), 'leaked');
  assert.equal(ofCommand('cat bench/runs/agentic/a/b/transcript.jsonl', 'B'), 'leaked');
  assert.equal(ofCommand('cat /Users/someone/secret.txt', 'B'), 'leaked');
  assert.equal(ofCommand('node slug.test.js', 'B'), 'clean');
  const mcp = withLineBeforeResult(base, { type: 'assistant', message: { id: 'my', role: 'assistant', content: [{ type: 'tool_use', id: 'tum', name: 'mcp__srv__tool', input: {} }] }, parent_tool_use_id: null });
  assert.equal(gradeOf(runDirOf(mcp, { homeSetup: { ok: true, exitCode: 0 } }), 'B').isolation, 'leaked');
  const read = withLineBeforeResult(fixture('arm-a-plain'), { type: 'assistant', message: { id: 'mz', role: 'assistant', content: [{ type: 'tool_use', id: 'tur', name: 'Read', input: { file_path: '/repo/core/shared/skills/do/SKILL.md' } }] }, parent_tool_use_id: null });
  assert.equal(gradeOf(runDirOf(read), 'A').isolation, 'leaked');
});

test('grade: an init model other than the pin is unverifiable; no init in a completed run is unverifiable; an infra class wins over it', () => {
  const other = clone(CONFIG);
  other.model.label = 'claude-other-model';
  assert.equal(gradeOf(runDirOf(fixture('arm-a-plain')), 'A', other).isolation, 'unverifiable');
  const result = fixture('arm-a-plain').trimEnd().split('\n').filter((l: string) => l.includes('"type":"result"')).join('\n');
  assert.equal(gradeOf(runDirOf(`${result}\n`), 'A').isolation, 'unverifiable');
  const timedOut = gradeOf(runDirOf('', { status: { status: 'timeout', evidence: 'x' } }), 'A');
  assert.equal(timedOut.infra, 'timeout');
  assert.equal(timedOut.isolation, 'clean');
  assert.equal(timedOut.pass_rate, null);
});

test('grade: a failing check scores 0; a missing workspace copy of a completed edit run is malformed, not a score', () => {
  const dir = runDirOf(fixture('arm-a-plain'));
  const failing = gradeOf(dir, 'A', CONFIG, { ...TASK, checks: 'process.exit(1)' });
  assert.equal(failing.pass_rate, 0);
  assert.equal(failing.checks.exitCode, 1);
  fs.rmSync(path.join(dir, 'workspace'), { recursive: true });
  const missing = gradeOf(dir, 'A');
  assert.equal(missing.infra, 'malformed');
  assert.equal(missing.pass_rate, null);
});

test('grade: serialisation is byte-stable and keeps the fixed key order', () => {
  const dir = runDirOf(fixture('arm-b-doflow'), { homeSetup: { ok: true, exitCode: 0 } });
  const a = grade.serializeAbGrading(gradeOf(dir, 'B'));
  assert.equal(grade.serializeAbGrading(gradeOf(dir, 'B')), a);
  assert.deepEqual(Object.keys(JSON.parse(a)), ['key', 'id', 'split', 'kind', 'group', 'arm', 'run_status', 'infra', 'isolation', 'isolationEvidence', 'exclusionReason', 'proof', 'capped', 'censored', 'pass_rate', 'checks', 'review', 'routing', 'metrics']);
});

test('grade: resumed segments aggregate as running totals when cumulative, and as sums otherwise; a falling total is inconsistent', () => {
  const rep = (tokens: number, cost: number, calls = 1) => ({
    wholeTree: { inputTokens: tokens, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, usage: null, outsideMainLoop: null,
    totalCostUsd: cost, modelUsage: {}, numTurns: 2, toolCounts: { Bash: calls }, toolCalls: Array.from({ length: calls }, () => ({})), subagentCalls: [], questions: { askUserQuestion: 0 },
  });
  const cumulative = grade.aggregateReports([rep(100, 0.1), rep(250, 0.25)], true);
  assert.equal(cumulative.totalTokens, 250);
  assert.equal(cumulative.costUsd, 0.25);
  assert.equal(cumulative.toolCalls, 2, 'tool calls always sum');
  assert.equal(cumulative.inconsistent, false);
  const summed = grade.aggregateReports([rep(100, 0.1), rep(250, 0.25)], false);
  assert.equal(summed.totalTokens, 350);
  assert.ok(Math.abs(summed.costUsd - 0.35) < 1e-9);
  assert.equal(grade.aggregateReports([rep(250, 0.25), rep(100, 0.1)], true).inconsistent, true);
  assert.equal(grade.aggregateReports([{ ...rep(0, 0), wholeTree: null, usage: null }], true).usage, 'unknown');
});

test('the in-flight token watch counts each assistant message once, at its largest usage', () => {
  const watch = execute.makeTokenWatch();
  const line = (id: string, input: number, output = 0) => JSON.stringify({ type: 'assistant', message: { id, usage: { input_tokens: input, output_tokens: output } } });
  assert.equal(watch(line('a', 100)), 100);
  assert.equal(watch(line('a', 100, 50)), 150, 'a later event of the same message adds only the growth');
  assert.equal(watch(line('b', 10)), 160);
  assert.equal(watch('not json'), 160);
  assert.equal(watch(JSON.stringify({ type: 'result' })), 160);
});

// ---------------------------------------------------------------------------------------------
// Fix round 2 (review of the first WP-2 commits)

const claudeStreamOf = (text: string) => claudeStream.parseTranscript(text);
const homeOk = { homeSetup: { ok: true, exitCode: 0 } };
const inA = (event: any) => gradeOf(runDirOf(withLineBeforeResult(fixture('arm-a-plain'), event)), 'A');
const inB = (event: any) => gradeOf(runDirOf(withLineBeforeResult(fixture('arm-b-doflow'), event), homeOk), 'B');

test('fix 2: the arm A leak is an invocation of the doflow binary in command position, never the word doflow in an argument', () => {
  for (const run of [(c: string) => inA(bashEvent(c)), (c: string) => inB(bashEvent(c))]) {
    for (const command of ['rg -n "doflow roadmap" src/', 'grep -rn doflow README.md', 'cat doflow-notes.md', 'echo doflow', 'git log --grep=doflow']) {
      const g = run(command);
      assert.equal(g.isolation, 'clean', `${command}: ${JSON.stringify(g.isolationEvidence)}`);
    }
  }
  for (const command of ['doflow retrieve --query x', 'env X=1 doflow retrieve', 'node ./bin/doflow.js x', 'npx doflow x', 'cd . && doflow x', "sh -c 'doflow x'", 'command doflow x']) {
    assert.equal(inA(bashEvent(command)).isolation, 'leaked', command);
  }
  assert.equal(inB(bashEvent('doflow retrieve --query x')).isolation, 'clean', 'arm B is meant to run doflow');
  assert.equal(inB(bashEvent('cat core/shared/skills/do/SKILL.md')).isolation, 'leaked', 'the source tree is a truth path in both arms');
});

const toolEvent = (name: string, input: any) => ({ type: 'assistant', message: { id: `m-${name}`, role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', id: `tu-${name}`, name, input }] }, parent_tool_use_id: null });

test('fix 4: Grep and Glob targets reach the outside-roots check, and a long Bash command is classified whole', () => {
  const aimed: [string, any][] = [
    ['Grep', { pattern: 'secret', path: '/Users/someone/project' }],
    ['Grep', { pattern: 'secret', path: '../../other' }],
    ['Grep', { pattern: 'secret', glob: '/Users/someone/**/*.ts' }],
    ['Glob', { pattern: '/Users/someone/**/*.ts' }],
    ['Glob', { pattern: '*.ts', path: '/Users/someone' }],
  ];
  for (const [name, input] of aimed) {
    assert.equal(inA(toolEvent(name, input)).isolation, 'leaked', `${name} ${JSON.stringify(input)} in arm A`);
    assert.equal(inB(toolEvent(name, input)).isolation, 'leaked', `${name} ${JSON.stringify(input)} in arm B`);
  }
  assert.equal(inB(toolEvent('Grep', { pattern: '/api/', path: 'src', glob: '*.ts' })).isolation, 'clean', 'inside the workspace, a slash in a Grep pattern is not a path');
  assert.equal(inB(toolEvent('Glob', { pattern: '**/*.ts' })).isolation, 'clean');

  const long = `echo ${'x'.repeat(600)} && curl http://example.test`;
  assert.equal(inB(bashEvent(long)).isolation, 'leaked', 'a network call past the old 300 character cut is still seen');
  const call = claudeStreamOf(withLineBeforeResult(fixture('arm-a-plain'), bashEvent(long))).toolCalls.find((c: any) => c.name === 'Bash');
  assert.ok(call.target.length > 600 && call.target.includes('curl'));
  const grep = claudeStreamOf(withLineBeforeResult(fixture('arm-a-plain'), toolEvent('Grep', { pattern: 'x', path: '/p', glob: '*.md' }))).toolCalls.find((c: any) => c.name === 'Grep');
  assert.deepEqual(grep.paths, ['/p', '*.md']);
});

test('fix 5: the tool export and the OS temp dir are truth paths; $VAR and ~ words are expanded or flagged, not skipped', () => {
  const leaked = [
    'cat $TMPDIR/abc/bin/doflow.js', 'cat "$TMPDIR"/x', 'ls ${TMPDIR}', 'cd $TMPDIR && ls', 'ls $TMP/y',
    'cat /var/folders/zz/T/doflow-agentic-tool-Ab12/src/cli.ts', 'find . -path "*doflow-agentic-tool*"',
    'cat $HOME/../../outside', 'cat ~/../../outside', 'cat ~root/.ssh/id', 'cat $UNKNOWN_BASE/file', 'cat --file=$TMPDIR/x',
  ];
  for (const command of leaked) {
    assert.equal(inB(bashEvent(command)).isolation, 'leaked', `arm B: ${command}`);
    assert.equal(inA(bashEvent(command)).isolation, 'leaked', `arm A: ${command}`);
  }
  for (const command of ['cat $HOME/.claude/settings.json', 'cat ~/.claude/skills/do/SKILL.md', 'echo $? $i', 'echo "$FOO"', 'ls $PWD/src', 'node a.js']) {
    assert.equal(inB(bashEvent(command)).isolation, 'clean', `arm B: ${command} (inside the roots or no path base)`);
  }
  assert.equal(inB(toolEvent('Read', { file_path: '/var/folders/zz/T/doflow-agentic-tool-Ab12/src/cli.ts' })).isolation, 'leaked');
});

const synth = (id: string, over: any = {}) => ({
  id, isolation: 'clean', infra: null, censored: null, capped: false, kind: 'edit',
  metrics: { tokens: { total: 1000 }, costUsd: 0.1, wallMs: 10000, toolCalls: 5, capTokens: null, ...(over.metrics || {}) }, ...Object.fromEntries(Object.entries(over).filter(([k]) => k !== 'metrics')),
});
const COST_TASKS = { tasks: ['t1', 't2', 't3', 't4'].map((id) => ({ id })) };
const costOf = (A: any[], B: any[]) => reportLib.abCostOf({
  A: [Object.fromEntries(A.map((g) => [g.id, g]))], B: [Object.fromEntries(B.map((g) => [g.id, g]))], taskSet: COST_TASKS,
  noiseValid: true, noiseFile: { path: 'x' }, costNoise: { totalTokens: 0, costUsd: 0, wallSeconds: 0, toolCalls: 0 }, noiseConfig: { seed: 96, mde: 0.05, maxInfraShare: 0.1 },
  infraShare: { baseline: 0, candidate: 0 },
  censored: { A: A.filter((g) => g.censored).map((g) => g.id), B: B.filter((g) => g.censored).map((g) => g.id) }, runs: { A: A.length, B: B.length },
});

test('fix 1: capped and timed-out runs stay in cost and wall at a lower bound and withhold the verdict word', () => {
  const ids = ['t1', 't2', 't3', 't4'];
  const A = ids.map((id) => synth(id));
  const cheap = ids.map((id) => synth(id, { metrics: { tokens: { total: 500 }, costUsd: 0.05, wallMs: 5000, toolCalls: 2 } }));
  assert.equal(costOf(A, cheap).totalTokens.verdict, 'gain-above-noise', 'no censored run: the rule gives a word');
  // B's t1 hit the cap after 1,000 reported tokens (cap 50,000); t2 timed out after 90 s.
  const B = [
    synth('t1', { capped: true, infra: 'truncated', censored: 'cap', metrics: { tokens: { total: 1000 }, capTokens: 50000, costUsd: 0.2, wallMs: 30000, toolCalls: 9 } }),
    synth('t2', { infra: 'timeout', censored: 'timeout', metrics: { tokens: { total: 600 }, wallMs: 90000, costUsd: 0.05, toolCalls: 3 } }),
    cheap[2], cheap[3],
  ];
  const cost = costOf(A, B);
  for (const id of ['totalTokens', 'costUsd', 'wallSeconds', 'toolCalls']) {
    assert.equal(cost[id].verdict, 'censored-lower-bound', id);
    assert.match(cost[id].reason, /A 0 of 4 run\(s\), B 2 of 4 run\(s\)/);
  }
  assert.equal(cost.totalTokens.perTask.t1.B, 50000, 'a capped run counts at no less than the cap');
  assert.equal(cost.totalTokens.perTask.t2.B, 600, 'a timeout counts at what it reported');
  assert.equal(cost.wallSeconds.perTask.t2.B, 90, 'a timeout counts at its elapsed time');
  assert.equal(cost.costUsd.perTask.t1.B, 0.2);
});

test('fix 1: the grader marks a capped or timed-out clean run censored and records the cap; a leaked one is not censored', () => {
  const capped = gradeOf(runDirOf(fixture('arm-a-plain'), { status: { status: 'truncated', evidence: 'cap', cap: true }, launch: { maxTokensPerRun: 7777 } }), 'A');
  assert.equal(capped.censored, 'cap');
  assert.equal(capped.metrics.capTokens, 7777);
  assert.equal(capped.pass_rate, null, 'still out of the quality score');
  const timeout = gradeOf(runDirOf('', { status: { status: 'timeout', evidence: 'x' } }), 'A');
  assert.equal(timeout.censored, 'timeout');
  assert.equal(timeout.metrics.wallMs, 41250);
  assert.equal(gradeOf(runDirOf(fixture('arm-a-plain')), 'A').censored, null);
  const leakedAndCapped = gradeOf(runDirOf(withLineBeforeResult(fixture('arm-a-plain'), bashEvent('curl http://x')), { status: { status: 'truncated', evidence: 'cap', cap: true } }), 'A');
  assert.equal(leakedAndCapped.isolation, 'leaked');
  assert.equal(leakedAndCapped.censored, null);
});

test('fix 6: closing offers and blocking questions are told apart; only a blocking question is a pause', () => {
  const kind = claudeStream.closingKind;
  for (const text of ['Done.\n\nWant me to add tests?', 'Done. Should I also add a test file?', '**Would you like me to refactor the helper too?**', 'Finished. Do you want me to continue?', 'Shall I also update the docs?', 'Done. Anything else?', 'Fixed it. If you would like, want me to open a PR?']) {
    assert.equal(kind(text), 'offer', text);
  }
  for (const text of ['I found two a.js files. Which one should I edit?', 'Should I use TypeScript or JavaScript?', 'Is the expected output 2 or 3?', 'Which file?']) {
    assert.equal(kind(text), 'blocking', text);
  }
  for (const text of ['Done.', '', null, 'Done. It is finished.\n\nQuestion for later? No, nothing.']) assert.equal(kind(text as any), null, String(text));
  assert.equal(claudeStreamOf(fixture('arm-b-doflow')).closing, 'offer');
  assert.equal(claudeStreamOf(fixture('arm-b-doflow')).questions.any, true, 'the WP-1 question fields are unchanged');
  assert.equal(CONFIG.resume.reply, 'No further input is available. If the task as stated is complete, stop. Otherwise continue with the task as stated and change nothing outside it.');
});

test('fix 7: the adapter counts the findings a review produced and those that matched no known case', () => {
  const f = (path_: string, line: number, severity = 'should-fix') => ({ path: path_, startLine: line, endLine: line, severity, title: 'x' });
  const run = adaptWith(JSON.stringify([f('src/a.ts', 10), f('src/a.ts', 400), f('src/b.ts', 10), { path: 'src/a.ts' }]));
  const stats = run.parsed[REVIEW_TASK.id];
  assert.equal(stats.findings, 3, 'the invalid entry is dropped, not produced');
  assert.equal(stats.dropped, 1);
  assert.equal(stats.unmatched, 2, 'a far line and another file match no known case');
  assert.equal(adaptWith('not json').parsed[REVIEW_TASK.id].unmatched, 0);
});

test('fix 3: the redactor removes exact credential values (raw and JSON-escaped) and token shapes, and leaves ordinary text alone', () => {
  const redact = execute.makeRedactor(['tok/en+value-123456', 'short', undefined as any]);
  assert.equal(redact('a tok/en+value-123456 b'), 'a [redacted] b');
  assert.equal(redact(JSON.stringify({ v: 'x tok/en+value-123456' })), '{"v":"x [redacted]"}');
  assert.equal(execute.makeRedactor(['ab"cd-12345678'])(JSON.stringify({ v: 'ab"cd-12345678' })), '{"v":"[redacted]"}', 'the JSON-escaped form of a value with a quote');
  assert.equal(redact('key sk-ant-oat01-abcdefgh_ijkl and sk-abcdefghijklmnopqrstuvwx'), 'key [redacted] and [redacted]');
  assert.equal(redact('the short value stays, and so do task-management-framework-document and risk-assessment-framework-document'), 'the short value stays, and so do task-management-framework-document and risk-assessment-framework-document');
  const dir = mkdir('redact-');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'a.txt'), 'x tok/en+value-123456 y');
  fs.writeFileSync(path.join(dir, 'b.bin'), Buffer.from([0, 1, 2, ...Buffer.from('tok/en+value-123456')]));
  assert.equal(execute.redactTree(dir, redact), 1);
  assert.equal(readText(path.join(dir, 'sub', 'a.txt')), 'x [redacted] y');
  assert.ok(fs.readFileSync(path.join(dir, 'b.bin')).includes('tok/en+value-123456'), 'a binary file is not rewritten');
});

test('fix 3: the recipe sets CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 for every run', () => {
  const entry = CONFIG.recipeData.env.perRun.find((e: any) => e.name === 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB');
  assert.equal(entry.value, '1');
  assert.ok(CONFIG.recipeData.unverified.some((u: string) => u.includes('SUBPROCESS_ENV_SCRUB')), 'its CLAUDE_CONFIG_DIR side effect is listed as unverified');
});
