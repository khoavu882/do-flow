'use strict';

const fs = require('node:fs');
const path = require('node:path');

interface GraphNode {
  id: string;
  label: string;
  file?: string;
  line?: number;
  kind?: string;
}

interface GraphEdge {
  source: string;
  target: string;
  relation: 'calls' | 'called_by' | 'imports' | 'imported_by' | 'defines' | 'depends_on' | string;
  weight?: number;
}

interface GraphBounds {
  maxHops: number;   // Clamped: 1 <= maxHops <= 3 (default: 2)
  maxSeeds: number;  // Clamped: 1 <= maxSeeds <= 10 (default: 1)
  maxNodes: number;  // Clamped: 1 <= maxNodes <= 100 (default: 50)
  edgeTypes?: string[]; // Allowed relations; default: all
}

interface GraphTraversalOptions {
  projectRoot: string;
  seeds: string[];          // Symbol names, node IDs, or file paths
  direction?: 'upstream' | 'downstream' | 'both'; // default: 'both'
  bounds?: Partial<GraphBounds>;
  graphData?: { nodes: GraphNode[]; edges: GraphEdge[] }; // Optional in-memory inject for tests
  fsImpl?: any;
}

interface GraphTraversalResult {
  ok: boolean;
  seeds: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  metrics: {
    durationMs: number;
    nodesScanned: number;
    hopsTraversed: number;
    truncated: boolean;
  };
  error?: string;
}

function clampBounds(bounds?: Partial<GraphBounds>): GraphBounds {
  const maxHops = Math.min(3, Math.max(1, bounds?.maxHops ?? 2));
  const maxSeeds = Math.min(10, Math.max(1, bounds?.maxSeeds ?? 1));
  const maxNodes = Math.min(100, Math.max(1, bounds?.maxNodes ?? 50));
  return {
    maxHops,
    maxSeeds,
    maxNodes,
    edgeTypes: bounds?.edgeTypes,
  };
}

async function traverseGraphRelationships(
  options: GraphTraversalOptions
): Promise<GraphTraversalResult> {
  const started = Number(process.hrtime.bigint() / 1000000n);
  const bounds = clampBounds(options.bounds);
  const direction = options.direction || 'both';
  const fsImpl = options.fsImpl || fs;

  let graphData: { nodes: GraphNode[]; edges: GraphEdge[] };
  if (options.graphData) {
    graphData = options.graphData;
  } else {
    const graphFile = path.join(options.projectRoot, 'graphify-out', 'graph.json');
    try {
      if (!fsImpl.existsSync(graphFile)) {
        return {
          ok: false,
          seeds: options.seeds,
          nodes: [],
          edges: [],
          metrics: {
            durationMs: Math.round(Number(process.hrtime.bigint() / 1000000n) - started),
            nodesScanned: 0,
            hopsTraversed: 0,
            truncated: false,
          },
          error: `Graph file not found at ${graphFile}`,
        };
      }
      const raw = fsImpl.readFileSync(graphFile, 'utf8');
      graphData = JSON.parse(raw);
    } catch (err: any) {
      return {
        ok: false,
        seeds: options.seeds,
        nodes: [],
        edges: [],
        metrics: {
          durationMs: Math.round(Number(process.hrtime.bigint() / 1000000n) - started),
          nodesScanned: 0,
          hopsTraversed: 0,
          truncated: false,
        },
        error: `Failed to load graph file: ${err.message}`,
      };
    }
  }

  const nodes: GraphNode[] = Array.isArray(graphData.nodes) ? graphData.nodes : [];
  const edges: GraphEdge[] = Array.isArray(graphData.edges) ? graphData.edges : [];

  const nodeById = new Map<string, GraphNode>();
  const nodesByLabel = new Map<string, GraphNode[]>();
  const nodesByFile = new Map<string, GraphNode[]>();

  for (const node of nodes) {
    nodeById.set(node.id, node);
    if (node.label) {
      const list = nodesByLabel.get(node.label) || [];
      list.push(node);
      nodesByLabel.set(node.label, list);
    }
    if (node.file) {
      const list = nodesByFile.get(node.file) || [];
      list.push(node);
      nodesByFile.set(node.file, list);
    }
  }

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();

  for (const edge of edges) {
    if (!edge.source || !edge.target) continue;
    const outList = outgoing.get(edge.source) || [];
    outList.push(edge);
    outgoing.set(edge.source, outList);

    const inList = incoming.get(edge.target) || [];
    inList.push(edge);
    incoming.set(edge.target, inList);
  }

  const inputSeeds = options.seeds.slice(0, bounds.maxSeeds);
  const resolvedSeedNodes: GraphNode[] = [];
  const resolvedSeedIds = new Set<string>();

  for (const seed of inputSeeds) {
    if (nodeById.has(seed)) {
      const n = nodeById.get(seed)!;
      if (!resolvedSeedIds.has(n.id)) {
        resolvedSeedIds.add(n.id);
        resolvedSeedNodes.push(n);
      }
    } else if (nodesByLabel.has(seed)) {
      for (const n of nodesByLabel.get(seed)!) {
        if (!resolvedSeedIds.has(n.id)) {
          resolvedSeedIds.add(n.id);
          resolvedSeedNodes.push(n);
        }
      }
    } else if (nodesByFile.has(seed)) {
      for (const n of nodesByFile.get(seed)!) {
        if (!resolvedSeedIds.has(n.id)) {
          resolvedSeedIds.add(n.id);
          resolvedSeedNodes.push(n);
        }
      }
    } else {
      for (const node of nodes) {
        if (
          (node.file && node.file.includes(seed)) ||
          (node.label && node.label.toLowerCase() === seed.toLowerCase())
        ) {
          if (!resolvedSeedIds.has(node.id)) {
            resolvedSeedIds.add(node.id);
            resolvedSeedNodes.push(node);
          }
        }
      }
    }
  }

  const visited = new Set<string>();
  const resultNodes: GraphNode[] = [];
  const resultEdges: GraphEdge[] = [];
  const edgeSet = new Set<string>();

  interface QueueItem {
    nodeId: string;
    hop: number;
  }

  const queue: QueueItem[] = [];
  let truncated = false;
  let nodesScanned = 0;
  let hopsTraversed = 0;

  for (const seedNode of resolvedSeedNodes) {
    if (resultNodes.length >= bounds.maxNodes) {
      truncated = true;
      break;
    }
    visited.add(seedNode.id);
    resultNodes.push(seedNode);
    queue.push({ nodeId: seedNode.id, hop: 0 });
  }

  const allowedEdgeTypes = bounds.edgeTypes ? new Set(bounds.edgeTypes) : null;

  while (queue.length > 0) {
    const { nodeId, hop } = queue.shift()!;
    nodesScanned++;
    if (hop > hopsTraversed) {
      hopsTraversed = hop;
    }

    if (hop >= bounds.maxHops) {
      continue;
    }

    const edgesToTraverse: Array<{ edge: GraphEdge; neighborId: string }> = [];

    if (direction === 'downstream' || direction === 'both') {
      const outEdges = outgoing.get(nodeId) || [];
      for (const edge of outEdges) {
        if (allowedEdgeTypes && !allowedEdgeTypes.has(edge.relation)) continue;
        edgesToTraverse.push({ edge, neighborId: edge.target });
      }
    }

    if (direction === 'upstream' || direction === 'both') {
      const inEdges = incoming.get(nodeId) || [];
      for (const edge of inEdges) {
        if (allowedEdgeTypes && !allowedEdgeTypes.has(edge.relation)) continue;
        edgesToTraverse.push({ edge, neighborId: edge.source });
      }
    }

    for (const { edge, neighborId } of edgesToTraverse) {
      const edgeKey = `${edge.source}->${edge.relation}->${edge.target}`;
      if (!edgeSet.has(edgeKey)) {
        edgeSet.add(edgeKey);
        resultEdges.push(edge);
      }

      if (visited.has(neighborId)) {
        continue;
      }

      const neighborNode = nodeById.get(neighborId);
      if (!neighborNode) continue;

      if (resultNodes.length >= bounds.maxNodes) {
        truncated = true;
        break;
      }

      visited.add(neighborId);
      resultNodes.push(neighborNode);
      queue.push({ nodeId: neighborId, hop: hop + 1 });
    }

    if (truncated) break;
  }

  const durationMs = Math.round(Number(process.hrtime.bigint() / 1000000n) - started);

  return {
    ok: true,
    seeds: inputSeeds,
    nodes: resultNodes,
    edges: resultEdges,
    metrics: {
      durationMs,
      nodesScanned,
      hopsTraversed,
      truncated,
    },
  };
}

module.exports = {
  clampBounds,
  traverseGraphRelationships,
};
