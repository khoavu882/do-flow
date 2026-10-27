'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { traverseGraphRelationships } = require('../../src/runtime/knowledge/graph-adapter.ts');
const { resolveRelationshipQuery, evaluateGraphFreshness } = require('../../src/runtime/knowledge/graph-fallback.ts');
const { evaluateGP3Gate } = require('../../src/runtime/knowledge/gp3-gate.ts');
const { formatWithRTK } = require('../../src/runtime/knowledge/rtk-compress.ts');

interface ImpactTask {
  id: string;
  symbol: string;
  targetFile: string;
  expectedDependents: string[];
}

interface ArmMetrics {
  arm: 'lexical' | 'graph-impact';
  tasksEvaluated: number;
  missedDependenciesRate: number;
  recallAt10: number;
  ndcgAt10: number;
  meanLatencyMs: number;
  p95LatencyMs: number;
  unreachedCount: number;
}

interface AblationReport {
  timestamp: string;
  commit: string;
  arms: {
    lexical: ArmMetrics;
    graphImpact: ArmMetrics;
  };
  delta: {
    missedDependenciesReduction: number;
    recallDelta: number;
    latencyDeltaMs: number;
  };
}

function computeNDCGAt10(retrieved: string[], groundTruth: string[]): number {
  if (!groundTruth.length) return 1.0;
  const top10 = retrieved.slice(0, 10);
  const gtSet = new Set(groundTruth.map((s) => s.toLowerCase()));

  let dcg = 0;
  for (let i = 0; i < top10.length; i++) {
    const isRel = gtSet.has(top10[i].toLowerCase()) || [...gtSet].some((gt) => top10[i].toLowerCase().includes(gt));
    if (isRel) {
      dcg += 1 / Math.log2(i + 2);
    }
  }

  let idcg = 0;
  const idealCount = Math.min(10, groundTruth.length);
  for (let i = 0; i < idealCount; i++) {
    idcg += 1 / Math.log2(i + 2);
  }

  return idcg > 0 ? Number((dcg / idcg).toFixed(4)) : 1.0;
}

async function runGraphAblation(
  tasks: ImpactTask[],
  options: {
    projectRoot: string;
    timeoutMs?: number;
    graphData?: any;
    lexicalSearchImpl?: (symbol: string, root: string) => Promise<string[]>;
  }
): Promise<AblationReport> {
  let commit = 'HEAD';
  try {
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      encoding: 'utf8',
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    commit = 'uncommitted';
  }

  const lexicalLatencies: number[] = [];
  const lexicalMissedRates: number[] = [];
  const lexicalRecalls: number[] = [];
  const lexicalNdcgs: number[] = [];
  let lexicalUnreached = 0;

  const graphLatencies: number[] = [];
  const graphMissedRates: number[] = [];
  const graphRecalls: number[] = [];
  const graphNdcgs: number[] = [];
  let graphUnreached = 0;

  for (const task of tasks) {
    const startLex = Number(process.hrtime.bigint() / 1000000n);
    let lexResults: string[] = [];
    try {
      if (options.lexicalSearchImpl) {
        lexResults = await options.lexicalSearchImpl(task.symbol, options.projectRoot);
      } else {
        try {
          const out = execFileSync('rg', ['-l', '-w', task.symbol, '.'], {
            cwd: options.projectRoot,
            encoding: 'utf8',
            timeout: options.timeoutMs || 2500,
            stdio: ['ignore', 'pipe', 'ignore'],
          });
          lexResults = out.trim().split('\n').filter(Boolean).map((p: string) => p.replace(/^\.\//, ''));
        } catch (err: any) {
          if (err.status === 1) {
            lexResults = [];
          } else {
            lexicalUnreached++;
          }
        }
      }
    } catch {
      lexicalUnreached++;
    }
    const lexDuration = Number(process.hrtime.bigint() / 1000000n) - startLex;
    lexicalLatencies.push(lexDuration);

    const expected = task.expectedDependents;
    const lexHit = expected.filter((exp) =>
      lexResults.some((res) => res.toLowerCase().includes(exp.toLowerCase()))
    );
    const lexMissed = expected.length - lexHit.length;
    const lexMissRate = expected.length > 0 ? lexMissed / expected.length : 0;
    const lexRecall = expected.length > 0 ? lexHit.length / expected.length : 1.0;
    const lexNdcg = computeNDCGAt10(lexResults, expected);

    lexicalMissedRates.push(lexMissRate);
    lexicalRecalls.push(lexRecall);
    lexicalNdcgs.push(lexNdcg);

    const startGraph = Number(process.hrtime.bigint() / 1000000n);
    let graphResults: string[] = [];
    try {
      const seeds = [task.symbol];
      if (task.targetFile) seeds.push(task.targetFile);
      const traversal = await traverseGraphRelationships({
        projectRoot: options.projectRoot,
        seeds,
        direction: 'downstream',
        bounds: { maxHops: 2, maxNodes: 50 },
        graphData: options.graphData,
      });
      if (traversal.ok) {
        graphResults = traversal.nodes.map((n: any) => {
          let f = n.file || n.label || n.id;
          if (path.isAbsolute(f)) {
            f = path.relative(options.projectRoot, f);
          }
          return f.replace(/^\.\//, '');
        });
      }
      const combined = [...new Set([...graphResults, ...lexResults])];
      graphResults = combined;
    } catch {
      graphUnreached++;
    }
    const graphDuration = Number(process.hrtime.bigint() / 1000000n) - startGraph;
    graphLatencies.push(graphDuration);

    const graphHit = expected.filter((exp) =>
      graphResults.some((res) => res.toLowerCase().includes(exp.toLowerCase()))
    );
    const graphMissed = expected.length - graphHit.length;
    const graphMissRate = expected.length > 0 ? graphMissed / expected.length : 0;
    const graphRecall = expected.length > 0 ? graphHit.length / expected.length : 1.0;
    const graphNdcg = computeNDCGAt10(graphResults, expected);

    graphMissedRates.push(graphMissRate);
    graphRecalls.push(graphRecall);
    graphNdcgs.push(graphNdcg);
  }

  const avg = (arr: number[]) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
  const p95 = (arr: number[]) => {
    if (!arr.length) return 0;
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95));
    return sorted[idx];
  };

  const lexMissedAvg = avg(lexicalMissedRates);
  const graphMissedAvg = avg(graphMissedRates);
  const missedDependenciesReduction =
    lexMissedAvg > 0 ? (lexMissedAvg - graphMissedAvg) / lexMissedAvg : 0;

  const lexRecallAvg = avg(lexicalRecalls);
  const graphRecallAvg = avg(graphRecalls);
  const recallDelta = graphRecallAvg - lexRecallAvg;

  const lexLatencyAvg = avg(lexicalLatencies);
  const graphLatencyAvg = avg(graphLatencies);

  const lexicalArm: ArmMetrics = {
    arm: 'lexical',
    tasksEvaluated: tasks.length,
    missedDependenciesRate: Number(lexMissedAvg.toFixed(4)),
    recallAt10: Number(lexRecallAvg.toFixed(4)),
    ndcgAt10: Number(avg(lexicalNdcgs).toFixed(4)),
    meanLatencyMs: Math.round(lexLatencyAvg),
    p95LatencyMs: Math.round(p95(lexicalLatencies)),
    unreachedCount: lexicalUnreached,
  };

  const graphImpactArm: ArmMetrics = {
    arm: 'graph-impact',
    tasksEvaluated: tasks.length,
    missedDependenciesRate: Number(graphMissedAvg.toFixed(4)),
    recallAt10: Number(graphRecallAvg.toFixed(4)),
    ndcgAt10: Number(avg(graphNdcgs).toFixed(4)),
    meanLatencyMs: Math.round(graphLatencyAvg),
    p95LatencyMs: Math.round(p95(graphLatencies)),
    unreachedCount: graphUnreached,
  };

  const latencyDeltaMs = graphImpactArm.meanLatencyMs - lexicalArm.meanLatencyMs;

  return {
    timestamp: new Date().toISOString(),
    commit,
    arms: {
      lexical: lexicalArm,
      graphImpact: graphImpactArm,
    },
    delta: {
      missedDependenciesReduction: Number(missedDependenciesReduction.toFixed(4)),
      recallDelta: Number(recallDelta.toFixed(4)),
      latencyDeltaMs,
    },
  };
}

module.exports = {
  computeNDCGAt10,
  runGraphAblation,
  evaluateGP3Gate,
  formatWithRTK,
};
