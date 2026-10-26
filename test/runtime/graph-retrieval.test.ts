'use strict';

// Feature 083 — Graph Rerank Ablation (Phase P3) test suite.
// Covers IC-001 (bounded traversal), IC-002 (freshness & safe fallback),
// IC-003 (offline ablation harness), and IC-004 (G-P3 gate & RTK compression).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { suiteTempDir } = require('../helper/tmp.ts');

const {
  traverseGraphRelationships,
} = require('../../src/runtime/knowledge/graph-adapter.ts');

const {
  evaluateGraphFreshness,
  executeLexicalSearch,
  resolveRelationshipQuery,
} = require('../../src/runtime/knowledge/graph-fallback.ts');

const {
  evaluateGP3Gate,
} = require('../../src/runtime/knowledge/gp3-gate.ts');

const {
  formatWithRTK,
} = require('../../src/runtime/knowledge/rtk-compress.ts');

const {
  runGraphAblation,
} = require('../../bench/retrieval/graph-ablation.ts');

describe('IC-001: traverseGraphRelationships (Bounded Graph Traversal)', () => {
  test('traverses linear relationships respecting maxHops and default bounds', async () => {
    const graphData = {
      nodes: [
        { id: 'node-1', label: 'entrypoint', file: 'src/main.ts', line: 10 },
        { id: 'node-2', label: 'serviceA', file: 'src/serviceA.ts', line: 20 },
        { id: 'node-3', label: 'serviceB', file: 'src/serviceB.ts', line: 30 },
        { id: 'node-4', label: 'serviceC', file: 'src/serviceC.ts', line: 40 },
        { id: 'node-5', label: 'serviceD', file: 'src/serviceD.ts', line: 50 },
      ],
      edges: [
        { source: 'node-1', target: 'node-2', relation: 'calls' },
        { source: 'node-2', target: 'node-3', relation: 'calls' },
        { source: 'node-3', target: 'node-4', relation: 'calls' },
        { source: 'node-4', target: 'node-5', relation: 'calls' },
      ],
    };

    const res = await traverseGraphRelationships({
      projectRoot: process.cwd(),
      seeds: ['node-1'],
      bounds: { maxHops: 2, maxNodes: 50 },
      graphData,
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.seeds, ['node-1']);
    const ids = res.nodes.map((n: any) => n.id);
    assert.ok(ids.includes('node-1'));
    assert.ok(ids.includes('node-2'));
    assert.ok(ids.includes('node-3'));
    assert.equal(ids.includes('node-4'), false, 'node at hop 3 must not be reached when maxHops is 2');
    assert.equal(ids.includes('node-5'), false, 'node at hop 4 must not be reached when maxHops is 2');
    assert.equal(res.metrics.hopsTraversed, 2);
    assert.equal(res.metrics.truncated, false);
  });

  test('detects cycles and terminates cleanly without infinite loops', async () => {
    const graphData = {
      nodes: [
        { id: 'A', label: 'ModuleA' },
        { id: 'B', label: 'ModuleB' },
        { id: 'C', label: 'ModuleC' },
      ],
      edges: [
        { source: 'A', target: 'B', relation: 'calls' },
        { source: 'B', target: 'C', relation: 'calls' },
        { source: 'C', target: 'A', relation: 'calls' },
      ],
    };

    const res = await traverseGraphRelationships({
      projectRoot: process.cwd(),
      seeds: ['A'],
      bounds: { maxHops: 3, maxNodes: 50 },
      graphData,
    });

    assert.equal(res.ok, true);
    assert.equal(res.nodes.length, 3);
    const uniqueIds = new Set(res.nodes.map((n: any) => n.id));
    assert.equal(uniqueIds.size, 3);
    assert.ok(uniqueIds.has('A') && uniqueIds.has('B') && uniqueIds.has('C'));
    assert.equal(res.metrics.truncated, false);
  });

  test('truncates traversal and sets truncated flag when maxNodes limit is hit', async () => {
    const nodes = [{ id: 'root', label: 'root' }];
    const edges = [];
    for (let i = 1; i <= 10; i++) {
      const id = `child-${i}`;
      nodes.push({ id, label: `child ${i}` });
      edges.push({ source: 'root', target: id, relation: 'calls' });
    }

    const res = await traverseGraphRelationships({
      projectRoot: process.cwd(),
      seeds: ['root'],
      bounds: { maxHops: 2, maxNodes: 4 },
      graphData: { nodes, edges },
    });

    assert.equal(res.ok, true);
    assert.equal(res.nodes.length, 4);
    assert.equal(res.metrics.truncated, true);
  });

  test('hard clamps maxHops > 3 down to 3', async () => {
    const nodes = [];
    const edges = [];
    for (let i = 0; i <= 6; i++) {
      nodes.push({ id: `step-${i}`, label: `step ${i}` });
      if (i > 0) {
        edges.push({ source: `step-${i - 1}`, target: `step-${i}`, relation: 'calls' });
      }
    }

    const res = await traverseGraphRelationships({
      projectRoot: process.cwd(),
      seeds: ['step-0'],
      bounds: { maxHops: 5, maxNodes: 50 },
      graphData: { nodes, edges },
    });

    assert.equal(res.ok, true);
    assert.ok(res.metrics.hopsTraversed <= 3);
    const ids = res.nodes.map((n: any) => n.id);
    assert.ok(ids.includes('step-0'));
    assert.ok(ids.includes('step-1'));
    assert.ok(ids.includes('step-2'));
    assert.ok(ids.includes('step-3'));
    assert.equal(ids.includes('step-4'), false, 'step-4 exceeds hard cap of 3 hops');
    assert.equal(ids.includes('step-5'), false);
  });

  test('filters traversal by edgeTypes and direction', async () => {
    const graphData = {
      nodes: [
        { id: 'caller', label: 'caller' },
        { id: 'target', label: 'target' },
        { id: 'callee', label: 'callee' },
        { id: 'imported', label: 'imported' },
      ],
      edges: [
        { source: 'caller', target: 'target', relation: 'calls' },
        { source: 'target', target: 'callee', relation: 'calls' },
        { source: 'target', target: 'imported', relation: 'imports' },
      ],
    };

    const callsOnly = await traverseGraphRelationships({
      projectRoot: process.cwd(),
      seeds: ['target'],
      direction: 'downstream',
      bounds: { edgeTypes: ['calls'], maxHops: 1 },
      graphData,
    });
    const ids = callsOnly.nodes.map((n: any) => n.id);
    assert.ok(ids.includes('target'));
    assert.ok(ids.includes('callee'));
    assert.equal(ids.includes('imported'), false, 'edge type imports must be excluded');

    const upstreamOnly = await traverseGraphRelationships({
      projectRoot: process.cwd(),
      seeds: ['target'],
      direction: 'upstream',
      bounds: { maxHops: 1 },
      graphData,
    });
    const upstreamIds = upstreamOnly.nodes.map((n: any) => n.id);
    assert.ok(upstreamIds.includes('target'));
    assert.ok(upstreamIds.includes('caller'));
    assert.equal(upstreamIds.includes('callee'), false, 'downstream nodes excluded in upstream traversal');
  });

  test('handles unknown seeds gracefully returning empty nodes', async () => {
    const res = await traverseGraphRelationships({
      projectRoot: process.cwd(),
      seeds: ['nonexistent-seed'],
      graphData: { nodes: [], edges: [] },
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.nodes, []);
    assert.deepEqual(res.edges, []);
  });
});

describe('IC-002: evaluateGraphFreshness & resolveRelationshipQuery', () => {
  function setupProject(tName: string, files: Record<string, string>): string {
    const root = path.join(suiteTempDir(`doflow-test-${tName}-`), 'proj');
    fs.mkdirSync(root, { recursive: true });
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(root, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    return root;
  }

  test('freshness: returns MISSING when graph.json does not exist', () => {
    const root = setupProject('missing', {
      'src/index.ts': 'export const x = 1;\n',
    });
    const info = evaluateGraphFreshness(root);
    assert.equal(info.status, 'MISSING');
    assert.equal(info.graphMtimeMs, null);
  });

  test('freshness: returns CORRUPT when graph.json is malformed JSON', () => {
    const root = setupProject('corrupt', {
      'src/index.ts': 'export const x = 1;\n',
      'graphify-out/graph.json': '{ invalid json content\n',
    });
    const info = evaluateGraphFreshness(root);
    assert.equal(info.status, 'CORRUPT');
  });

  test('freshness: returns STALE when source files are newer than graph.json', () => {
    const root = setupProject('stale', {
      'src/index.ts': 'export const x = 1;\n',
      'graphify-out/graph.json': JSON.stringify({ nodes: [], edges: [] }),
    });

    const now = Date.now();
    const oldTime = (now - 50000) / 1000;
    const newTime = now / 1000;
    fs.utimesSync(path.join(root, 'graphify-out/graph.json'), oldTime, oldTime);
    fs.utimesSync(path.join(root, 'src/index.ts'), newTime, newTime);

    const info = evaluateGraphFreshness(root);
    assert.equal(info.status, 'STALE');
    assert.ok(info.newestSourceMtimeMs! > info.graphMtimeMs!);
  });

  test('freshness: returns FRESH when graph.json is newer than all source files', () => {
    const root = setupProject('fresh', {
      'src/index.ts': 'export const x = 1;\n',
      'graphify-out/graph.json': JSON.stringify({ nodes: [], edges: [] }),
    });

    const now = Date.now();
    const oldTime = (now - 50000) / 1000;
    const newTime = now / 1000;
    fs.utimesSync(path.join(root, 'src/index.ts'), oldTime, oldTime);
    fs.utimesSync(path.join(root, 'graphify-out/graph.json'), newTime, newTime);

    const info = evaluateGraphFreshness(root);
    assert.equal(info.status, 'FRESH');
  });

  test('resolveRelationshipQuery: FRESH graph routes to graphify.query as HEALTHY', async () => {
    const graphData = {
      nodes: [
        { id: 'symA', label: 'symA', file: 'src/a.ts', line: 10 },
        { id: 'symB', label: 'symB', file: 'src/b.ts', line: 20 },
      ],
      edges: [{ source: 'symA', target: 'symB', relation: 'calls' }],
    };
    const root = setupProject('route-fresh', {
      'src/a.ts': 'export function symA() { symB(); }\n',
      'src/b.ts': 'export function symB() {}\n',
      'graphify-out/graph.json': JSON.stringify(graphData),
    });

    const now = Date.now();
    fs.utimesSync(path.join(root, 'src/a.ts'), (now - 20000) / 1000, (now - 20000) / 1000);
    fs.utimesSync(path.join(root, 'graphify-out/graph.json'), now / 1000, now / 1000);

    const res = await resolveRelationshipQuery({
      projectRoot: root,
      symbol: 'symA',
      intent: 'estimate-blast-radius',
    });

    assert.equal(res.provider, 'graphify.query');
    assert.equal(res.status, 'HEALTHY');
    assert.equal(res.freshness, 'FRESH');
    assert.ok(res.candidates.length > 0);
  });

  test('resolveRelationshipQuery: STALE or MISSING graph falls back to native.rg as FALLBACK', async () => {
    const root = setupProject('route-stale', {
      'src/a.ts': 'export function calculateTax() { return 10; }\n',
      'src/b.ts': 'import { calculateTax } from "./a"; calculateTax();\n',
    });

    const res = await resolveRelationshipQuery({
      projectRoot: root,
      symbol: 'calculateTax',
      intent: 'estimate-blast-radius',
    });

    assert.equal(res.provider, 'native.rg');
    assert.equal(res.status, 'FALLBACK');
    assert.equal(res.freshness, 'MISSING');
    assert.equal(res.fallbackReason, 'index-missing');
    assert.ok(res.candidates.length > 0);
    assert.equal(res.candidates[0].source, 'native.rg');
  });

  test('Negative Absence Invariant: stale graph never emits isAbsence: true when dependents exist in code', async () => {
    const root = setupProject('negative-absence', {
      'src/lib.ts': 'export function targetFunction() {}\n',
      'src/app.ts': 'import { targetFunction } from "./lib"; targetFunction();\n',
      'graphify-out/graph.json': JSON.stringify({ nodes: [], edges: [] }), // Stale empty graph
    });

    const now = Date.now();
    fs.utimesSync(path.join(root, 'graphify-out/graph.json'), (now - 10000) / 1000, (now - 10000) / 1000);
    fs.utimesSync(path.join(root, 'src/app.ts'), now / 1000, now / 1000);

    const res = await resolveRelationshipQuery({
      projectRoot: root,
      symbol: 'targetFunction',
      intent: 'estimate-blast-radius',
    });

    assert.equal(res.freshness, 'STALE');
    assert.equal(res.provider, 'native.rg');
    assert.equal(res.isAbsence, false, 'must not claim absence on stale graph when lexical dependents exist');
    assert.ok(res.candidates.some((c: any) => c.locator.file.includes('app.ts')));
  });

  test('estimate-blast-radius on a FRESH graph returns the callers of the symbol, not its callees', async () => {
    const graphData = {
      nodes: [
        { id: 'symA', label: 'symA', file: 'src/a.ts', line: 1 },
        { id: 'symB', label: 'symB', file: 'src/b.ts', line: 1 },
        { id: 'symC', label: 'symC', file: 'src/c.ts', line: 1 },
      ],
      // symA calls symB, symB calls symC: changing symB affects symA.
      edges: [
        { source: 'symA', target: 'symB', relation: 'calls' },
        { source: 'symB', target: 'symC', relation: 'calls' },
      ],
    };
    const root = setupProject('blast-upstream', {
      'src/b.ts': 'export function symB() {}\n',
      'graphify-out/graph.json': JSON.stringify(graphData),
    });
    const now = Date.now();
    fs.utimesSync(path.join(root, 'src/b.ts'), (now - 20000) / 1000, (now - 20000) / 1000);
    fs.utimesSync(path.join(root, 'graphify-out/graph.json'), now / 1000, now / 1000);

    const res = await resolveRelationshipQuery({ projectRoot: root, symbol: 'symB', intent: 'estimate-blast-radius' });
    const files = res.candidates.map((c: any) => c.locator.file);
    assert.equal(res.provider, 'graphify.query');
    assert.ok(files.includes('src/a.ts'), `the caller src/a.ts is affected: ${files.join(',')}`);
    assert.ok(!files.includes('src/c.ts'), `the callee src/c.ts is not affected: ${files.join(',')}`);
  });

  test('a failed lexical fallback is UNAVAILABLE, never a confirmed absence', async () => {
    const root = setupProject('lexical-fails', { 'src/a.ts': 'export const x = 1;\n' });
    const injected = await resolveRelationshipQuery(
      { projectRoot: root, symbol: 'calculateTax', intent: 'estimate-blast-radius' },
      { rgSearchImpl: async () => { throw new Error('rg: spawn ENOENT'); } },
    );
    assert.equal(injected.status, 'UNAVAILABLE');
    assert.equal(injected.fallbackReason, 'lexical-failed');
    assert.equal(injected.isAbsence, false);
    assert.deepEqual(injected.candidates, []);

    // The real rg path: a search that cannot run (its cwd does not exist) is a failure, not zero matches.
    const real = await resolveRelationshipQuery({
      projectRoot: path.join(root, 'does-not-exist'), symbol: 'calculateTax', intent: 'estimate-blast-radius',
    });
    assert.equal(real.status, 'UNAVAILABLE');
    assert.equal(real.isAbsence, false);
  });

  test('a lexical search that runs and finds nothing still confirms absence', async () => {
    const root = setupProject('lexical-none', { 'src/a.ts': 'export const x = 1;\n' });
    const res = await resolveRelationshipQuery({ projectRoot: root, symbol: 'neverDefinedAnywhere', intent: 'estimate-blast-radius' });
    assert.equal(res.provider, 'native.rg');
    assert.equal(res.isAbsence, true);
    assert.deepEqual(res.candidates, []);
  });

  test('a lexical search that finds a match but meets an unreadable directory keeps the match', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const root = setupProject('lexical-partial', { 'src/a.ts': 'export const partialMatchSymbol = 1;\n', 'locked/b.ts': 'x\n' });
    const locked = path.join(root, 'locked');
    fs.chmodSync(locked, 0o000);
    try {
      const res = await executeLexicalSearch('partialMatchSymbol', root);
      assert.equal(res.ok, true);
      assert.deepEqual(res.matches.map((m: any) => m.file), ['src/a.ts']);
    } finally {
      fs.chmodSync(locked, 0o755);
    }
  });
});

describe('IC-004: evaluateGP3Gate (Activation Gate)', () => {
  function makeReport(overrides: any = {}): any {
    return {
      timestamp: new Date().toISOString(),
      commit: 'abc1234',
      arms: {
        lexical: {
          arm: 'lexical',
          tasksEvaluated: 10,
          missedDependenciesRate: 0.35,
          recallAt10: 0.60,
          ndcgAt10: 0.55,
          meanLatencyMs: 40,
          p95LatencyMs: 80,
          unreachedCount: 2,
          ...(overrides.lexical || {}),
        },
        graphImpact: {
          arm: 'graph-impact',
          tasksEvaluated: 10,
          missedDependenciesRate: 0.25,
          recallAt10: 0.75,
          ndcgAt10: 0.70,
          meanLatencyMs: 120,
          p95LatencyMs: 210,
          unreachedCount: 2,
          ...(overrides.graphImpact || {}),
        },
      },
      delta: {
        missedDependenciesReduction: 0.2857, // (0.35 - 0.25) / 0.35 = 28.6% >= 15%
        recallDelta: 0.15,
        latencyDeltaMs: 80,
        ...(overrides.delta || {}),
      },
    };
  }

  test('emits KEEP when missedDependenciesReduction >= 0.15 and latencyDeltaMs <= 250', () => {
    const report = makeReport();
    const verdict = evaluateGP3Gate(report);

    assert.equal(verdict.gate, 'G-P3');
    assert.equal(verdict.verdict, 'KEEP');
    assert.equal(verdict.passed, true);
    assert.equal(verdict.criteria.missedDependenciesReductionMet, true);
    assert.equal(verdict.criteria.latencyOverheadMet, true);
    assert.equal(verdict.criteria.zeroUnreachedRegression, true);
  });

  test('emits DISABLE when missedDependenciesReduction < 0.15 regardless of recall improvement', () => {
    const report = makeReport({
      delta: {
        missedDependenciesReduction: 0.08, // 8% < 15%
        recallDelta: 0.40, // large recall improvement
        latencyDeltaMs: 50,
      },
    });
    const verdict = evaluateGP3Gate(report);

    assert.equal(verdict.verdict, 'DISABLE');
    assert.equal(verdict.passed, false);
    assert.equal(verdict.criteria.missedDependenciesReductionMet, false);
    assert.match(verdict.rationale, /missedDependenciesReduction/);
  });

  test('emits DISABLE when latencyDeltaMs > 250 due to latency overhead budget', () => {
    const report = makeReport({
      delta: {
        missedDependenciesReduction: 0.30, // 30% >= 15%
        latencyDeltaMs: 320, // exceeds 250ms cap
      },
    });
    const verdict = evaluateGP3Gate(report);

    assert.equal(verdict.verdict, 'DISABLE');
    assert.equal(verdict.passed, false);
    assert.equal(verdict.criteria.latencyOverheadMet, false);
    assert.match(verdict.rationale, /latency/);
  });

  test('emits DISABLE when unreachedCount regresses compared to baseline', () => {
    const report = makeReport({
      graphImpact: { unreachedCount: 5 }, // regressed from baseline 2
    });
    const verdict = evaluateGP3Gate(report);

    assert.equal(verdict.verdict, 'DISABLE');
    assert.equal(verdict.passed, false);
    assert.equal(verdict.criteria.zeroUnreachedRegression, false);
  });
});

describe('IC-004: formatWithRTK (RTK Token Compression)', () => {
  test('compresses formatted graph traversal while verifying file:line locators remain intact', () => {
    const resolution: any = {
      query: 'handlePayment',
      intent: 'estimate-blast-radius',
      provider: 'graphify.query',
      status: 'HEALTHY',
      freshness: 'FRESH',
      candidates: [
        {
          locator: { file: 'src/billing/payment.ts', line: 42, symbol: 'handlePayment' },
          rank: 1,
          score: 0.98,
          source: 'graphify.query',
          relation: 'defines',
        },
        {
          locator: { file: 'src/routes/checkout.ts', line: 85, symbol: 'submitOrder' },
          rank: 2,
          score: 0.89,
          source: 'graphify.query',
          relation: 'called_by',
        },
        {
          locator: { file: 'test/payment.test.ts', line: 120, symbol: 'testPaymentFlow' },
          rank: 3,
          score: 0.82,
          source: 'graphify.query',
          relation: 'called_by',
        },
      ],
      isAbsence: false,
    };

    const result = formatWithRTK(resolution);

    assert.ok(result.rawChars > 0);
    assert.ok(result.compressedChars > 0);
    assert.ok(result.ratio <= 1.0, 'compressed output must be equal or smaller in characters');
    assert.equal(result.locatorsPreserved, true);
    assert.ok(result.formattedOutput.includes('src/billing/payment.ts:42'));
    assert.ok(result.formattedOutput.includes('src/routes/checkout.ts:85'));
    assert.ok(result.formattedOutput.includes('test/payment.test.ts:120'));
  });
});

describe('IC-003: runGraphAblation (Retrieval Ablation Harness)', () => {
  test('executes offline ablation comparison between Arm A and Arm A+Graph on impact tasks', async () => {
    const root = path.join(suiteTempDir('doflow-test-ablation-'), 'proj');
    fs.mkdirSync(root, { recursive: true });

    const graphData = {
      nodes: [
        { id: 'fnA', label: 'fnA', file: 'src/a.ts', line: 10 },
        { id: 'fnB', label: 'fnB', file: 'src/b.ts', line: 20 },
      ],
      edges: [{ source: 'fnA', target: 'fnB', relation: 'calls' }],
    };

    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'graphify-out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src/a.ts'), 'export function fnA() { fnB(); }\n');
    fs.writeFileSync(path.join(root, 'src/b.ts'), 'export function fnB() {}\n');
    fs.writeFileSync(path.join(root, 'graphify-out/graph.json'), JSON.stringify(graphData));

    const tasks = [
      {
        id: 'task-test-1',
        symbol: 'fnA',
        targetFile: 'src/a.ts',
        expectedDependents: ['src/b.ts'],
      },
    ];

    const report = await runGraphAblation(tasks, { projectRoot: root, timeoutMs: 5000 });

    assert.equal(typeof report.timestamp, 'string');
    assert.equal(typeof report.commit, 'string');
    assert.equal(report.arms.lexical.arm, 'lexical');
    assert.equal(report.arms.lexical.tasksEvaluated, 1);
    assert.equal(report.arms.graphImpact.arm, 'graph-impact');
    assert.equal(report.arms.graphImpact.tasksEvaluated, 1);
    assert.equal(typeof report.delta.missedDependenciesReduction, 'number');
    assert.equal(typeof report.delta.recallDelta, 'number');
    assert.equal(typeof report.delta.latencyDeltaMs, 'number');
    assert.equal(
      report.delta.latencyDeltaMs,
      report.arms.graphImpact.meanLatencyMs - report.arms.lexical.meanLatencyMs
    );
  });
});
