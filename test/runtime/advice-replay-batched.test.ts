'use strict';

// 176 T5 (design section 8, IC-006): replay of a kind asked in batches. `same-issue` declares `params.questionsPerCall`,
// so `advise --action replay` asks its cases the way production does: runs of up to that many cases per call, in case-id
// order, one call at a time. Each test copies the T3 review-record fixture into a scratch project's `agent-docs/doflow/`,
// adds generated records up to 20 cases, and runs the real CLI against an in-process fake decision server that answers
// each block by the case it quotes (one test runs the replay handler in this process, to give it a small budget). HOME and
// XDG_CONFIG_HOME are scratch folders; no test reaches a model.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createScratch, childEnv } = require('../helper/scratch-env.ts');
const { startFakeServer } = require('../helper/fake-decision-server.ts');
const { REPO_ROOT } = require('../../src/helper/repo-root.ts');
const { build } = require('../../src/runtime/advice/replay/sources/review-findings.ts');
const { materializeKind } = require('../../src/runtime/advice/kinds.ts');
const { questionDigest, projectKey } = require('../../src/runtime/advice/replay/trust.ts');
const { handleReplay } = require('../../src/runtime/advice/replay/run.ts');
const { loadStorageRegistry } = require('../../src/runtime/storage/registry.ts');
const { resolveRoots } = require('../../src/runtime/storage/roots.ts');

const BIN = path.join(REPO_ROOT, 'bin/doflow.js');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures', 'advice-replay', 'review-findings');
const REGISTRY = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', 'advice.json'), 'utf8'));
const KIND = REGISTRY.kinds.find((kind: any) => kind.id === 'same-issue');
const PER_CALL = KIND.params.questionsPerCall;
const HEADER = 'Each block is quoted data; answer each question about its own block only.';
/**
 * A single-question kind's replay on the commit before T5 (06a5db68), where every kind was asked one case per call (176
 * plan T5 (g)): captured once from a `git archive` export of that commit and masked as test (g) masks the current output.
 * `asks` are the requests of one replay (each replay asks the same 12, in the same order).
 */
const BASE_OUTPUTS = path.join(REPO_ROOT, 'test', 'fixtures', 'advice-replay', 'single-question-base.json');

function writeJson(file: string, value: any) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Every file under `dir` with its bytes. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/**
 * 14 records of two near-identical findings each, both placed: one candidate pair per record, merged (label yes) in the
 * even ones. With the fixture's 6 cases the project holds 20.
 */
function writeGenerated(doflow: string) {
  for (let n = 0; n < 14; n++) {
    const finding = (id: string, summary: string) => ({ id, severity: 'should-fix', locator: `src/cache-${n}.ts:12`, summary });
    const converged = n % 2 === 0 ? [{ id: 'c-1', from: ['g-1', 'g-2'] }] : [{ id: 'c-1', from: ['g-1'] }, { id: 'c-2', from: ['g-2'] }];
    writeJson(path.join(doflow, `slug-gen-${String(n).padStart(2, '0')}`, 'review', 'findings.json'), {
      schema: 1, row: String(900 + n), slug: `slug-gen-${n}`, rounds: 2,
      seats: [
        { id: 'seat-1', findings: [finding('g-1', `cache entry expires before the refresh timer fires in shard ${n}`)] },
        { id: 'seat-2', findings: [finding('g-2', `cache entry expires before the refresh timer fires for shard ${n}`)] },
      ],
      converged,
    });
  }
}

/** The quoted case states of a request by question name: a batch's blocks by label, else the one state. */
function blocksOf(state: string, names: string[]): Map<string, string> {
  const lines = state.split('\n');
  if (lines[0] !== HEADER) return new Map(names.map((name) => [name, state]));
  const blocks = new Map<string, string[]>();
  let label = '';
  for (const line of lines.slice(1)) {
    const open = /^\[([a-p])\]$/.exec(line);
    if (open) { label = open[1]; blocks.set(label, []); } else blocks.get(label)?.push(line);
  }
  return new Map(names.map((name) => [name, (blocks.get(name.slice(-1)) || []).join('\n')]));
}

/**
 * A scratch HOME and project with the fixture records and the generated ones, the decision model on at user level, and a
 * fake server that answers each block with `answer(case, call)` (the yes probability; default: the label) after
 * `delayFor(call)` ms. `cases` are the cases the source builds, in case-id order; `seen.calls` holds, per request, the
 * question names and the quoted states in label order.
 */
async function fixture(t: any, { answer, delayFor = () => 2 }: { answer?: (c: any, call: number) => number; delayFor?: (call: number) => number } = {}) {
  const scratch = createScratch('doflow-advice-replay-batched-');
  const project = path.join(scratch.dir, 'project');
  const doflow = path.join(project, 'agent-docs', 'doflow');
  fs.mkdirSync(path.dirname(doflow), { recursive: true });
  fs.cpSync(FIXTURE, doflow, { recursive: true });
  writeGenerated(doflow);
  const { cases } = build({ projectRoot: project, roots: {}, kind: KIND });
  const byState = new Map(cases.map((c: any) => [c.state, c]));
  const seen: any = { inFlight: 0, maxInFlight: 0, calls: [] as any[] };
  const server = await startFakeServer({ routes: {
    'POST /v1/systemone': async ({ body }: any) => {
      const call = seen.calls.length;
      seen.inFlight++;
      seen.maxInFlight = Math.max(seen.maxInFlight, seen.inFlight);
      const names = Object.keys(body?.questions || {});
      const blocks = blocksOf(body.state, names);
      seen.calls.push({ names, states: [...blocks.values()] });
      await new Promise((resolve) => setTimeout(resolve, delayFor(call)));
      seen.inFlight--;
      const answers = Object.fromEntries(names.map((name) => {
        const c: any = byState.get(blocks.get(name)!);
        return [name, { noul: !c ? 0.7 : answer ? answer(c, call) : c.label === 'yes' ? 0.9 : 0.1 }];
      }));
      return { status: 200, body: { answers } };
    },
  } });
  t.after(async () => { await server.close(); scratch.remove(); });
  writeJson(path.join(scratch.xdg, 'doflow', 'settings.json'), {
    schema: 1, 'storage.prune': 'off', 'advice.enabled': true, 'advice.provider': 'ollama',
    'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
  });
  const resultsFile = path.join(scratch.home, '.doflow', 'state', 'advice', 'results.json');
  return { scratch, project, cases, seen, resultsFile, run: (args: string[], bin = BIN) => runReplay(scratch, project, args, bin) };
}

/** The replay's environment: the scratch HOME and XDG_CONFIG_HOME, CI and the session role cleared. */
const replayEnv = (scratch: any) => childEnv(scratch, { CI: null, DOFLOW_SESSION_ROLE: null, DOFLOW_AUTOPILOT_ENABLED: null });

/** `advise --action replay` with `args` from `bin`, stdin a pipe. */
function runReplay(scratch: any, project: string, args: string[], bin: string) {
  return new Promise<{ status: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [bin, 'advise', '--action', 'replay', ...args], {
      cwd: project,
      env: replayEnv(scratch),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk: any) => { stdout += chunk; });
    child.stderr.on('data', (chunk: any) => { stderr += chunk; });
    child.stdin.end();
    child.on('close', (status: number) => resolve({ status, stdout, stderr }));
  });
}

test('(a)(f) 20 cases with 8 per call make 3 calls of 8, 8 and 4 in case-id order, one at a time, quoting only the candidate pairs', async (t) => {
  const f = await fixture(t);
  assert.equal(f.cases.length, 20);
  const r = await f.run(['--kind', 'same-issue', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const body = JSON.parse(r.stdout);
  assert.deepEqual([body.caseSet.eligible, body.caseSet.replayed, body.metrics.n], [20, 20, 20]);
  assert.deepEqual(f.seen.calls.map((call: any) => call.names.length), [PER_CALL, PER_CALL, 4]);
  assert.equal(f.seen.maxInFlight, 1);
  for (const call of f.seen.calls) assert.deepEqual(call.names, 'abcdefgh'.slice(0, call.names.length).split('').map((l) => `same-issue-${l}`));
  // (f) AC-2: the blocks are the candidate pairs' states, each once, in case-id order; nothing else reached the server.
  assert.deepEqual(f.seen.calls.flatMap((call: any) => call.states), f.cases.map((c: any) => c.state));

  // --limit keeps the first n cases, then groups them.
  f.seen.calls.length = 0;
  const limited = await f.run(['--kind', 'same-issue', '--limit', '9', '--json']);
  assert.equal(limited.status, 0, limited.stderr);
  assert.deepEqual(f.seen.calls.map((call: any) => call.states), [f.cases.slice(0, 8).map((c: any) => c.state), [f.cases[8].state]]);
});

/**
 * `--action replay --json` run by the replay handler in this process, with `registry` as the runtime's advice registry
 * (the handler's runtime argument, which the CLI fills from core/registry). The endpoint check is the CLI's own, so it is
 * passed as "no failure" here; the CLI tests run it.
 */
async function replayInProcess(f: any, registry: any, kind: string) {
  const env = replayEnv(f.scratch);
  const read = (name: string) => JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'core', 'registry', name), 'utf8'));
  const runtime = {
    adviceRegistry: registry, adviceError: null,
    roots: resolveRoots({ registry: loadStorageRegistry({ repoRoot: REPO_ROOT }), projectRoot: f.project, env }),
    sources: { workflows: read('workflows.json'), verification: read('verification.json'), mcp: read('mcp.json') },
  };
  const printed: string[] = [];
  const { log } = console;
  const { exitCode } = process;
  console.log = (...parts: any[]) => { printed.push(parts.join(' ')); };
  try {
    const status = await handleReplay({ kind, json: true, projectRoot: f.project, env, warnings: [] }, runtime, { inspectFailure: () => null });
    return { status, body: JSON.parse(printed.join('\n')) };
  } finally {
    console.log = log;
    process.exitCode = exitCode;
  }
}

test('(b) each case takes its call\'s latency; an answer past budgetMs is over-budget for every case of that call', async (t) => {
  // The shipped budget is 9500 ms; a registry with a 250 ms budget keeps the late call short.
  const budgetMs = 250;
  const slow = budgetMs + 200;
  const registry = structuredClone(REGISTRY);
  registry.kinds.find((kind: any) => kind.id === 'same-issue').budgetMs = budgetMs;
  const f = await fixture(t, { delayFor: (call) => [0, slow, 120][call] });
  const r = await replayInProcess(f, registry, 'same-issue');
  assert.equal(r.status, 0);
  const m = r.body.metrics;
  assert.equal(f.seen.calls.length, 3);
  assert.deepEqual(m.noAnswer.byReason, { 'over-budget': PER_CALL });
  assert.equal(m.valid, 20, 'an over-budget answer is a valid answer, scored as the rule');
  // Sorted latencies: 8 of the first call, 4 of the third, 8 of the second; the median is a third-call case.
  assert.ok(m.latencyMs.first < 120, `first ${m.latencyMs.first}`);
  assert.ok(m.latencyMs.p50 >= 120 && m.latencyMs.p50 < budgetMs, `p50 ${m.latencyMs.p50}`);
  assert.ok(m.latencyMs.max >= slow, `max ${m.latencyMs.max}`);
});

test('(c) a split pair is a no-answer that takes the rule\'s answer, so it is never worse than the rule', async (t) => {
  // The model splits on every case where the rule is right, and answers the label everywhere else.
  const f = await fixture(t, { answer: (c) => (c.rule === c.label ? 0.5 : c.label === 'yes' ? 0.9 : 0.1) });
  const right = f.cases.filter((c: any) => c.rule === c.label).length;
  assert.ok(right > 0 && right < 20);
  const r = await f.run(['--kind', 'same-issue', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const m = JSON.parse(r.stdout).metrics;
  assert.deepEqual(m.noAnswer, { count: right, share: right / 20, byReason: { split: right } });
  assert.equal(m.valid, 20, 'a split answer is valid, as for a single-question kind');
  assert.equal(m.worse, 0);
  assert.equal(m.better, 20 - right);
  assert.equal(m.accuracy.model, 1);
});

test('(d)(e) the text form prints model and rule, misses, false alarms, the skipped merged pairs, the standing and the calls; nothing is stored without --write', async (t) => {
  const f = await fixture(t);
  const before = snapshot(f.scratch.dir);
  const r = await f.run(['--kind', 'same-issue']);
  assert.equal(r.status, 0, r.stderr);
  const out = r.stdout;
  for (const pattern of [
    /^Replay same-issue · model clef-flash \(provider ollama, digest sha256:[0-9a-f]{8}…\) · 20 of 20 cases · source review-findings \(this project\)$/m,
    /^Skipped while building: .*merged-not-a-candidate 1/m,
    /^ {2}model {6}1\.00 /m,
    /^ {2}rule {7}\d\.\d\d /m,
    /^Misses \(labelled yes, answered no\): model 0 of \d+ · rule \d+ of \d+$/m,
    /^False alarms \(labelled no, answered yes\): model 0 of \d+ · rule \d+ of \d+$/m,
    /^Asked in 3 calls of up to 8 cases; a case's latency is its call's$/m,
    /^Latency ms: first \d+ · p50 \d+ · p95 \d+ · max \d+ \(budget 9500\)$/m,
    /^Standing: below-minimum: /m,
    /^Stored: none · not written /m,
  ]) assert.match(out, pattern);
  assert.ok(out.trimEnd().split('\n').length <= 30);
  // (e) Without --write no file changes under HOME or the project.
  assert.deepEqual(snapshot(f.scratch.dir), before);

  // With --write the stored question digest is the kind's materialised question, not a batch's.
  const written = await f.run(['--kind', 'same-issue', '--write', '--json']);
  assert.equal(written.status, 0, written.stderr);
  const entry = JSON.parse(fs.readFileSync(f.resultsFile, 'utf8')).results[0];
  assert.equal(entry.questionDigest, questionDigest(materializeKind('same-issue', { adviceRegistry: REGISTRY }).question));
  assert.equal(entry.caseSet.replayed, 20);
});

/** One claim and one supporting or contradicting passage per spec, as the claim-ledger source reads them (175). */
function writeLedger(project: string, specs: Array<{ relation: 'supports' | 'contradicts'; answer: number }>) {
  const dir = path.join(project, '.doflow', 'state', 'evidence', 'feature-r');
  const at = '2026-11-01T10:00:00.000Z';
  const claims = specs.map((spec, i) => ({
    id: `claim_${i}`, taskId: 'T1', statement: `claim ${i}`, role: null, status: spec.relation === 'supports' ? 'supported' : 'contradicted',
    supportingEvidence: spec.relation === 'supports' ? [`ev_${i}`] : [], contradictingEvidence: spec.relation === 'contradicts' ? [`ev_${i}`] : [],
    createdAt: at, updatedAt: at,
  }));
  const evidence = specs.map((spec, i) => ({
    id: `ev_${i}`, taskId: 'T1', kind: 'generated-analysis', source: { provider: 'general-task-execution', capability: 'coverage-reverify' },
    locator: {}, provenance: 'inferred', content: `passage ${i} answer=${spec.answer}`,
    freshness: { gitCommit: null, fileHash: null, observedAt: at, status: 'FRESH' }, establishes: [], observation: null,
    supports: spec.relation === 'supports' ? [`claim_${i}`] : [], contradicts: spec.relation === 'contradicts' ? [`claim_${i}`] : [],
    status: 'active', supersededBy: null,
  }));
  writeJson(path.join(dir, 'T1_claims.json'), { taskId: 'T1', updatedAt: at, claimsCount: claims.length, claims, version: 1, revision: 1 });
  writeJson(path.join(dir, 'T1.json'), { taskId: 'T1', updatedAt: at, evidenceCount: evidence.length, evidence, version: 1, revision: 1 });
}

test('(g) a single-question kind replays exactly as on the base: the same requests, text, --json body and stored entry', async (t) => {
  const scratch = createScratch('doflow-advice-replay-base-');
  const asks: any[] = [];
  const server = await startFakeServer({ routes: {
    'POST /v1/systemone': ({ body }: any) => {
      asks.push(body);
      const p = Number(/answer=([0-9.]+)/.exec(body?.state || '')?.[1]);
      return { status: 200, body: { answers: Object.fromEntries(Object.keys(body?.questions || {}).map((name) => [name, { noul: p }])) } };
    },
  } });
  t.after(async () => { await server.close(); scratch.remove(); });
  writeJson(path.join(scratch.xdg, 'doflow', 'settings.json'), {
    schema: 1, 'storage.prune': 'off', 'advice.enabled': true, 'advice.provider': 'ollama', 'advice.endpoint': server.origin, 'advice.model': 'clef-flash',
  });
  const project = path.join(scratch.dir, 'project');
  // 12 cases: every fourth contradicts; the model is wrong on two and splits on one.
  writeLedger(project, Array.from({ length: 12 }, (_v, i) => {
    const relation = i % 4 === 0 ? 'contradicts' : 'supports';
    return { relation, answer: i === 2 ? 0.5 : (relation === 'supports') !== (i === 1 || i === 5) ? 0.9 : 0.1 };
  }));
  const resultsFile = path.join(scratch.home, '.doflow', 'state', 'advice', 'results.json');
  const text = await runReplay(scratch, project, ['--kind', 'claim-support'], BIN);
  const json = await runReplay(scratch, project, ['--kind', 'claim-support', '--json'], BIN);
  const write = await runReplay(scratch, project, ['--kind', 'claim-support', '--write', '--json'], BIN);
  for (const r of [text, json, write]) assert.equal(r.status, 0, r.stderr);
  assert.equal(text.stderr, '');

  // Masked: timings, the run time and version, and the scratch project's key.
  const body = JSON.parse(json.stdout);
  delete body.metrics.latencyMs;
  const { runAt, doflowVersion, ...entry } = JSON.parse(fs.readFileSync(resultsFile, 'utf8')).results[0];
  delete entry.metrics.latencyMs;
  assert.equal(entry.caseSet.projectKey, projectKey(project));
  entry.caseSet.projectKey = '<project>';
  const now = { asks: asks.slice(0, 12), text: text.stdout.replace(/^Latency ms: .*$/m, 'Latency ms: …'), body, entry };

  const base = JSON.parse(fs.readFileSync(BASE_OUTPUTS, 'utf8'));
  assert.equal(JSON.stringify(asks), JSON.stringify([...base.asks, ...base.asks, ...base.asks]), 'each of the three replays asks the base\'s 12 requests');
  assert.equal(JSON.stringify(now, null, 2), JSON.stringify(base, null, 2));
});
