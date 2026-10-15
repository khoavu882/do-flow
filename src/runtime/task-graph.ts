'use strict';

// TypeScript migration (agent-docs/BRIEF_GOAL_DOFLOW.md): run directly by Node native type-stripping.

// Task graph (feature 080, design C2): the plan's tasks as a dependency graph, validated before any
// ledger rule reads it.
//
// Pure over `parsePlan` output: no file is read and nothing is written here. `buildGraph` collects
// every IC-003 problem before it returns, so one refusal names everything wrong with a plan rather
// than the first thing. The cycle search covers the explicit `depends-on:` task edges and the
// implicit phase edges together (a task with no task dependency waits on every task of an earlier
// phase, IC-005 row 9): validating explicit edges alone accepts a plan whose phase order and
// declared dependencies wait on each other forever (design debate A-M1).

const crypto = require('node:crypto');

/** IC-008 / DEC-002: the attempt budget of a task that declares no `budget:`. */
const DEFAULT_TASK_ATTEMPTS = 20;

/** IC-001 acceptance grammar: a requirement, interface contract, story or scenario id. */
const ACCEPTANCE = [/^(FR|NFR|IC)-\d{3}$/, /^US\d+$/, /^S-[a-z0-9]+(-[a-z0-9]+)*$/];

/** DEC-008: only the `**Task graph:** v1` header makes a plan a graph plan. Accepts a parsed plan
 * or a graph, both of which carry `graphHeader`. */
function isGraphPlan(planOrGraph: any) {
  return Boolean(planOrGraph) && planOrGraph.graphHeader === 'v1';
}

/** IC-016: a `files:` entry compared after trimming and dropping a leading `./`. */
function normalizeFile(file: string) {
  return String(file).trim().replace(/^(\.\/)+/, '');
}

/**
 * Explicit and implicit edges out of each task, in plan order. An edge `from -> to` means `from`
 * waits on `to`. Explicit: each known `taskDeps` value. Implicit (`phase: true`): a task with no
 * `taskDeps` waits on every task of an earlier phase. Unknown dependencies have no edge; they are
 * reported as `unknown-dependency` instead.
 */
function outEdges(tasks: any[], byId: Map<string, any>) {
  const edges = new Map<string, Array<{ to: string, phase: boolean }>>();
  for (const task of tasks) {
    if (edges.has(task.id)) continue; // a duplicate id: the first occurrence stands for it
    const out: Array<{ to: string, phase: boolean }> = [];
    if (task.taskDeps.length) {
      for (const dep of [...new Set(task.taskDeps as string[])]) if (byId.has(dep)) out.push({ to: dep, phase: false });
    } else {
      for (const other of tasks) {
        if (other.phaseIndex < task.phaseIndex && !out.some((e) => e.to === other.id)) out.push({ to: other.id, phase: true });
      }
    }
    edges.set(task.id, out);
  }
  return edges;
}

/**
 * Iterative three-colour depth-first search over `edges`, roots and successors in plan order, so
 * the cycles reported and their order are deterministic. Returns every distinct cycle closed by a
 * back edge, and a topological order (dependencies first) that is valid when no cycle exists.
 */
function searchCycles(ids: string[], edges: Map<string, Array<{ to: string, phase: boolean }>>) {
  const WHITE = 0, GREY = 1, BLACK = 2;
  const colour = new Map<string, number>(ids.map((id) => [id, WHITE]));
  const order: string[] = [];
  const cycles: any[] = [];
  const seenCycles = new Set<string>();

  for (const root of ids) {
    if (colour.get(root) !== WHITE) continue;
    // Each frame: the node, the index of its next edge, and the edge that entered it.
    const stack: Array<{ id: string, next: number }> = [{ id: root, next: 0 }];
    const entered: Array<{ to: string, phase: boolean } | null> = [null];
    colour.set(root, GREY);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const out = edges.get(frame.id) || [];
      if (frame.next >= out.length) {
        colour.set(frame.id, BLACK);
        order.push(frame.id);
        stack.pop();
        entered.pop();
        continue;
      }
      const edge = out[frame.next++];
      const state = colour.get(edge.to);
      if (state === WHITE) {
        colour.set(edge.to, GREY);
        stack.push({ id: edge.to, next: 0 });
        entered.push(edge);
      } else if (state === GREY) {
        const start = stack.findIndex((f) => f.id === edge.to);
        const cycleIds = stack.slice(start).map((f) => f.id);
        const via: string[] = [];
        for (let i = start + 1; i < stack.length; i += 1) {
          via.push(`${stack[i - 1].id}->${stack[i].id}${entered[i]!.phase ? ':phase' : ''}`);
        }
        via.push(`${frame.id}->${edge.to}${edge.phase ? ':phase' : ''}`);
        const key = via.join('|');
        if (!seenCycles.has(key)) {
          seenCycles.add(key);
          cycles.push({ kind: 'cycle', ids: cycleIds, via });
        }
      }
    }
  }
  return { cycles, order };
}

/**
 * IC-003: `parsePlan` output → `{ ok: true, graph, warnings }` or `{ ok: false, problems }`, with
 * every problem collected first. The graph keeps the parsed tasks in plan order with `phaseIndex`
 * (phase order is first appearance), plus `order`, a topological order with dependencies first.
 */
function buildGraph(parsed: any) {
  const graphHeader = parsed.graphHeader === undefined ? null : parsed.graphHeader;
  const graphPlan = graphHeader === 'v1';
  const phases: string[] = [...new Set<string>(parsed.tasks.map((t: any) => t.phase))];
  const tasks = parsed.tasks.map((t: any) => ({
    ...t,
    phaseIndex: phases.indexOf(t.phase),
    taskDeps: t.taskDeps || [],
    nearMissDeps: t.nearMissDeps || [],
    acceptance: t.acceptance || [],
    budget: t.budget === undefined ? null : t.budget,
    parallel: Boolean(t.parallel),
  }));
  const problems: any[] = [];
  const warnings: any[] = [];

  if (graphHeader && typeof graphHeader === 'object') problems.push({ kind: 'bad-header', ids: [], value: graphHeader.invalid });

  const byId = new Map<string, any>();
  const reported = new Set<string>();
  for (const task of tasks) {
    if (!byId.has(task.id)) { byId.set(task.id, task); continue; }
    if (!reported.has(task.id)) { reported.add(task.id); problems.push({ kind: 'duplicate-id', ids: [task.id] }); }
  }

  for (const task of tasks) {
    for (const dep of task.taskDeps) {
      if (!byId.has(dep)) problems.push({ kind: 'unknown-dependency', ids: [task.id, dep] });
    }
    for (const value of task.nearMissDeps) {
      if (graphPlan) problems.push({ kind: 'bad-dependency', ids: [task.id], value });
      else warnings.push({ kind: 'near-miss-dependency', ids: [task.id], value });
    }
    for (const value of task.acceptance) {
      if (!ACCEPTANCE.some((pattern) => pattern.test(value))) problems.push({ kind: 'bad-acceptance', ids: [task.id], value });
    }
    if (task.budget && typeof task.budget === 'object' && 'invalid' in task.budget) {
      problems.push({ kind: 'bad-budget', ids: [task.id], value: task.budget.invalid });
    }
  }

  const ids = [...byId.keys()];
  const { cycles, order } = searchCycles(ids, outEdges(tasks, byId));
  problems.push(...cycles);

  if (problems.length) return { ok: false, problems };
  return { ok: true, graph: { graphHeader, graphPlan, phases, tasks, order }, warnings };
}

/** IC-004: one tuple per task in plan order — the structure and declared files, never the
 * description or the checkbox. */
function graphTuples(graph: any) {
  return graph.tasks.map((t: any) => [t.id, t.phase, t.owner, t.taskDeps, t.parallel, t.acceptance, t.budget, t.files]);
}

/** IC-004: `sha256:` over the tuples' canonical JSON (arrays and one-key objects only, so
 * `JSON.stringify` is already canonical). */
function graphDigest(graph: any) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(graphTuples(graph))).digest('hex')}`;
}

/** IC-016: every pair of tasks, in plan order, declaring the same `files:` entry after
 * normalisation, with the shared entries in the first task's declaration order. */
function overlaps(graph: any) {
  const declared = graph.tasks.map((t: any) => ({ id: t.id, files: [...new Set<string>((t.files || []).map(normalizeFile))].filter(Boolean) }));
  const pairs: Array<{ a: string, b: string, files: string[] }> = [];
  for (let i = 0; i < declared.length; i += 1) {
    for (let j = i + 1; j < declared.length; j += 1) {
      const other = new Set(declared[j].files);
      const files = declared[i].files.filter((f: string) => other.has(f));
      if (files.length) pairs.push({ a: declared[i].id, b: declared[j].id, files });
    }
  }
  return pairs;
}

/** IC-008: the task's attempt limit and where it came from. An invalid `budget:` is refused by
 * `buildGraph`, so here it can only mean the default. */
function taskAttemptLimit(task: any) {
  const attempts = task && task.budget && Number.isInteger(task.budget.attempts) ? task.budget.attempts : null;
  return attempts === null ? { limit: DEFAULT_TASK_ATTEMPTS, source: 'default' } : { limit: attempts, source: 'plan' };
}

module.exports = {
  DEFAULT_TASK_ATTEMPTS, buildGraph, isGraphPlan, graphTuples, graphDigest, overlaps, taskAttemptLimit,
};
