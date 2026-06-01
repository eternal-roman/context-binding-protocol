/**
 * Frame Resolver — the minimal reference resolver for CBP v0.3.
 *
 * Resolves a frame by:
 * 1. Loading nodes and edges into a GraphStore
 * 2. Applying prototypal inheritance to all nodes
 * 3. Evaluating conditional edges to determine active/dormant state
 * 4. Optionally applying a CBQ query to filter the result
 *
 * This is the "minimal reference resolver" described in CHANGELOG.md
 * for v0.3. The full Serializer (three-tier output) lands in v0.4.
 *
 * @see cbp-architecture.html Section II (inheritance)
 * @see cbp-architecture.html Section III (conditional edges)
 */

import type { CbpNode, ResolvedNode } from "../types/node.js";
import type { CbpEdge } from "../types/edge.js";
import type { FrameConfig } from "../types/frame.js";
import { GraphStore } from "../graph/store.js";
import { resolveAllInheritance } from "./inheritance.js";
import { evaluateCondition } from "./condition-eval.js";
import { parseCbq } from "../cbq/parser.js";
import type { CbqPredicate } from "../cbq/parser.js";

export interface FrameInput {
  frame: FrameConfig;
  nodes: CbpNode[];
  edges: CbpEdge[];
}

export interface ResolvedEdge extends CbpEdge {
  active: boolean;
}

export interface ResolvedFrame {
  frame: FrameConfig;
  nodes: ResolvedNode[];
  edges: ResolvedEdge[];
}

/**
 * Resolve a frame: apply inheritance, evaluate conditionals.
 */
export function resolveFrame(input: FrameInput): ResolvedFrame {
  const store = new GraphStore();

  // Load all nodes
  for (const node of input.nodes) {
    store.loadNode(node);
  }

  // Load all edges
  for (const edge of input.edges) {
    store.loadEdge(edge);
  }

  // Step 1: Apply inheritance under the frame's configured mode
  const resolvedNodes = resolveAllInheritance(store, input.frame.inheritance_mode);

  // Step 2: Evaluate conditional edges
  const resolvedEdges: ResolvedEdge[] = input.edges.map((edge) => ({
    ...edge,
    active: evaluateCondition(edge.conditional, resolvedNodes),
  }));

  return {
    frame: input.frame,
    nodes: [...resolvedNodes.values()],
    edges: resolvedEdges,
  };
}

/**
 * Resolve a frame and apply a CBQ query to filter the result.
 */
export function resolveFrameWithQuery(
  input: FrameInput,
  cbq: string
): ResolvedFrame {
  const resolved = resolveFrame(input);
  const query = parseCbq(cbq);

  if (query.predicates.length === 0) return resolved;

  let filteredNodes = resolved.nodes;
  let filteredEdges = resolved.edges;
  let edgeFilter: "active" | "all" | "dormant" = "active"; // default

  for (const pred of query.predicates) {
    switch (pred.kind) {
      case "weight":
        filteredNodes = filterByWeight(filteredNodes, pred);
        break;
      case "tag":
        filteredNodes = filteredNodes.filter((n) =>
          n.tags.some((t) => t === pred.tag || t.startsWith(pred.tag))
        );
        break;
      case "type":
        filteredNodes = filteredNodes.filter((n) => n.type === pred.nodeType);
        break;
      case "root":
        filteredNodes = filterByRoot(filteredNodes, pred.nodeId, resolved, query.predicates);
        break;
      case "depth":
        // depth is handled inside filterByRoot
        break;
      case "edges":
        edgeFilter = pred.filter;
        break;
      case "id":
        filteredNodes = filteredNodes.filter((n) => n.id === pred.nodeId);
        break;
    }
  }

  // Apply edge filter
  switch (edgeFilter) {
    case "active":
      filteredEdges = filteredEdges.filter((e) => e.active);
      break;
    case "dormant":
      filteredEdges = filteredEdges.filter((e) => !e.active);
      break;
    case "all":
      // no filtering
      break;
  }

  // Result-consistency invariant: an edge may only be returned if both of
  // its endpoints survived node filtering. Node predicates (weight, tag,
  // type, id, root/depth) can remove a node while leaving edges that point
  // at it; emitting those would serialize edges to nonexistent nodes.
  const survivingIds = new Set(filteredNodes.map((n) => n.id));
  filteredEdges = filteredEdges.filter(
    (e) => survivingIds.has(e.src) && survivingIds.has(e.tgt)
  );

  return {
    frame: resolved.frame,
    nodes: filteredNodes,
    edges: filteredEdges,
  };
}

function filterByWeight(
  nodes: ResolvedNode[],
  pred: { op: string; value: number }
): ResolvedNode[] {
  return nodes.filter((n) => {
    switch (pred.op) {
      case ">": return n.w > pred.value;
      case ">=": return n.w >= pred.value;
      case "<": return n.w < pred.value;
      case "<=": return n.w <= pred.value;
      case "=": return n.w === pred.value;
      case "!=": return n.w !== pred.value;
      default: return true;
    }
  });
}

function filterByRoot(
  nodes: ResolvedNode[],
  rootId: string,
  resolved: ResolvedFrame,
  predicates: CbqPredicate[]
): ResolvedNode[] {
  const depthPred = predicates.find((p) => p.kind === "depth");
  const maxDepth = depthPred?.kind === "depth" ? depthPred.value : Infinity;

  // BFS from root, collecting nodes up to maxDepth
  const rootNode = resolved.nodes.find((n) => n.id === rootId);
  if (!rootNode) return [];

  const result = new Set<string>();
  const queue: Array<{ id: string; depth: number }> = [
    { id: rootId, depth: 0 },
  ];

  while (queue.length > 0) {
    const item = queue.shift();
    if (!item) break;
    if (item.depth > maxDepth) continue;
    if (result.has(item.id)) continue;

    result.add(item.id);

    // Find children (nodes whose lineage points to this id)
    const children = resolved.nodes.filter((n) => n.lineage === item.id);
    for (const child of children) {
      queue.push({ id: child.id, depth: item.depth + 1 });
    }
  }

  return nodes.filter((n) => result.has(n.id));
}
