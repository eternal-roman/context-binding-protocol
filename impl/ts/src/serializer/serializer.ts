/**
 * Three-tier serializer — Full, Condensed, Signal.
 *
 * Invariant #1: TOKEN BUDGET IS LAW.
 * A frame serialization must never exceed its configured token budget.
 * If the graph is too large, the serializer prunes, compresses, or
 * drops tier — never overflows.
 *
 * @see spec/wire-format.md
 * @see cbp-architecture.html Section IV (Serialization Tiers)
 * @see cbp-architecture.html Section X Invariant #1
 */

import type { ResolvedNode } from "../types/node.js";
import type { ResolvedEdge, ResolvedFrame } from "../resolver/resolver.js";
import type { FrameConfig } from "../types/frame.js";
import type { Tokenizer } from "../tokenizer/tokenizer.js";
import { getTokenizer } from "../tokenizer/tokenizer.js";
import { canonicalize } from "../wire/canonical.js";

export type Tier = "full" | "condensed" | "signal";

export interface SerializeOptions {
  tier: Tier;
  tokenizer?: Tokenizer;
  previousFull?: FullPayload;
}

export interface FullPayload {
  frame: { id: string; max_token_budget: number; root_decay: string; root_weight: number; tokenizer: string };
  nodes: ResolvedNode[];
  edges: ResolvedEdge[];
  tier: "full";
  v: number;
}

export interface CondensedPayload {
  frame: { id: string };
  delta: {
    nodes_changed: Array<{ id: string; w: number; v: number }>;
    nodes_added: ResolvedNode[];
    nodes_removed: string[];
    edges_changed: Array<{ id: string; activated: boolean }>;
    edges_added: ResolvedEdge[];
    edges_removed: string[];
  };
  edge_summary: Record<string, number>;
  tier: "condensed";
  base_v: number;
  v: number;
}

export interface SignalPayload {
  frame: { id: string };
  nodes: Array<{ id: string; w: number; trend: "up" | "down" | "stable" }>;
  edges: Record<string, number>;
  tier: "signal";
  base_v: number;
  v: number;
}

export type SerializedPayload = FullPayload | CondensedPayload | SignalPayload;

export class BudgetExceededError extends Error {
  constructor(
    public readonly frameId: string,
    public readonly budget: number,
    public readonly actualTokens: number,
    public readonly tier: Tier
  ) {
    super(
      `Even ${tier} tier (${actualTokens} tokens) exceeds budget of ${budget} for frame ${frameId}`
    );
    this.name = "BudgetExceededError";
  }
}

/**
 * Serialize a resolved frame at the requested tier.
 *
 * Enforces token budget per invariant #1:
 * 1. Try the requested tier.
 * 2. If over budget, prune lowest-weight nodes.
 * 3. If still over, drop to a lower tier.
 * 4. If even Signal exceeds budget, throw BudgetExceededError.
 *
 * @returns The serialized payload and the canonical JSON wire output.
 */
export function serializeFrame(
  resolved: ResolvedFrame,
  frameVersion: number,
  options: SerializeOptions
): { payload: SerializedPayload; wire: string; tokens: number; actualTier: Tier } {
  const tokenizer = options.tokenizer ?? getTokenizer(resolved.frame.tokenizer);
  const budget = resolved.frame.max_token_budget;
  const tiers: Tier[] = buildTierCascade(options.tier);

  // Sort nodes by weight descending for pruning
  const nodes = [...resolved.nodes].sort((a, b) => b.w - a.w);
  const activeEdges = resolved.edges.filter((e) => e.active);

  for (const tier of tiers) {
    // Try with current node set
    const payload = buildPayload(
      tier, resolved.frame, nodes, activeEdges, frameVersion, options.previousFull
    );
    const wire = canonicalize(payload);
    const tokens = tokenizer.countTokens(wire);

    if (tokens <= budget) {
      return { payload, wire, tokens, actualTier: tier };
    }

    // Over budget at this tier — try pruning nodes (only for full tier)
    if (tier === "full" && nodes.length > 1) {
      const pruned = pruneToFit(
        resolved.frame, nodes, activeEdges, frameVersion, tokenizer, budget, options.previousFull
      );
      if (pruned) return pruned;
    }
  }

  // Even signal tier exceeded budget
  const signalPayload = buildPayload(
    "signal", resolved.frame, nodes, activeEdges, frameVersion, options.previousFull
  );
  const signalWire = canonicalize(signalPayload);
  const signalTokens = tokenizer.countTokens(signalWire);

  throw new BudgetExceededError(
    resolved.frame.id, budget, signalTokens, "signal"
  );
}

function buildTierCascade(requested: Tier): Tier[] {
  switch (requested) {
    case "full": return ["full", "condensed", "signal"];
    case "condensed": return ["condensed", "signal"];
    case "signal": return ["signal"];
  }
}

function buildPayload(
  tier: Tier,
  frame: FrameConfig,
  nodes: ResolvedNode[],
  edges: ResolvedEdge[],
  frameVersion: number,
  previousFull?: FullPayload
): SerializedPayload {
  switch (tier) {
    case "full":
      return buildFullPayload(frame, nodes, edges, frameVersion);
    case "condensed":
      return buildCondensedPayload(frame, nodes, edges, frameVersion, previousFull);
    case "signal":
      return buildSignalPayload(frame, nodes, edges, frameVersion, previousFull);
  }
}

function buildFullPayload(
  frame: FrameConfig,
  nodes: ResolvedNode[],
  edges: ResolvedEdge[],
  frameVersion: number
): FullPayload {
  return {
    frame: {
      id: frame.id,
      max_token_budget: frame.max_token_budget,
      root_decay: frame.root_decay,
      root_weight: frame.root_weight,
      tokenizer: frame.tokenizer,
    },
    nodes,
    edges,
    tier: "full",
    v: frameVersion,
  };
}

function buildCondensedPayload(
  frame: FrameConfig,
  nodes: ResolvedNode[],
  edges: ResolvedEdge[],
  frameVersion: number,
  previousFull?: FullPayload
): CondensedPayload {
  const baseV = previousFull?.v ?? 0;
  const prevNodeMap = new Map(previousFull?.nodes.map((n) => [n.id, n]) ?? []);
  const prevEdgeMap = new Map(previousFull?.edges.map((e) => [e.id, e]) ?? []);

  const nodesChanged: Array<{ id: string; w: number; v: number }> = [];
  const nodesAdded: ResolvedNode[] = [];
  const nodesRemoved: string[] = [];

  for (const node of nodes) {
    const prev = prevNodeMap.get(node.id);
    if (!prev) {
      nodesAdded.push(node);
    } else if (prev.w !== node.w || prev.v !== node.v) {
      nodesChanged.push({ id: node.id, w: node.w, v: node.v });
    }
  }

  for (const [id] of prevNodeMap) {
    if (!nodes.find((n) => n.id === id)) {
      nodesRemoved.push(id);
    }
  }

  const edgesChanged: Array<{ id: string; activated: boolean }> = [];
  const edgesAdded: ResolvedEdge[] = [];
  const edgesRemoved: string[] = [];

  for (const edge of edges) {
    const prev = prevEdgeMap.get(edge.id);
    if (!prev) {
      edgesAdded.push(edge);
    } else if (prev.active !== edge.active) {
      edgesChanged.push({ id: edge.id, activated: edge.active });
    }
  }

  for (const [id] of prevEdgeMap) {
    if (!edges.find((e) => e.id === id)) {
      edgesRemoved.push(id);
    }
  }

  // Edge summary: count by rel type
  const edgeSummary: Record<string, number> = {};
  for (const edge of edges) {
    edgeSummary[edge.rel] = (edgeSummary[edge.rel] ?? 0) + 1;
  }

  return {
    frame: { id: frame.id },
    delta: {
      nodes_changed: nodesChanged,
      nodes_added: nodesAdded,
      nodes_removed: nodesRemoved,
      edges_changed: edgesChanged,
      edges_added: edgesAdded,
      edges_removed: edgesRemoved,
    },
    edge_summary: edgeSummary,
    tier: "condensed",
    base_v: baseV,
    v: frameVersion,
  };
}

function buildSignalPayload(
  frame: FrameConfig,
  nodes: ResolvedNode[],
  edges: ResolvedEdge[],
  frameVersion: number,
  previousFull?: FullPayload
): SignalPayload {
  const prevNodeMap = new Map(previousFull?.nodes.map((n) => [n.id, n]) ?? []);

  const signalNodes = nodes.map((node) => {
    const prev = prevNodeMap.get(node.id);
    let trend: "up" | "down" | "stable" = "stable";
    if (prev) {
      if (node.w > prev.w) trend = "up";
      else if (node.w < prev.w) trend = "down";
    }
    return { id: node.id, w: node.w, trend };
  });

  const edgeCounts: Record<string, number> = {};
  for (const edge of edges) {
    edgeCounts[edge.rel] = (edgeCounts[edge.rel] ?? 0) + 1;
  }

  return {
    frame: { id: frame.id },
    nodes: signalNodes,
    edges: edgeCounts,
    tier: "signal",
    base_v: previousFull?.v ?? 0,
    v: frameVersion,
  };
}

function pruneToFit(
  frame: FrameConfig,
  nodes: ResolvedNode[],
  edges: ResolvedEdge[],
  frameVersion: number,
  tokenizer: Tokenizer,
  budget: number,
  _previousFull?: FullPayload
): { payload: SerializedPayload; wire: string; tokens: number; actualTier: Tier } | null {
  // Drop the d lowest-weight non-frame nodes until the RENDERED payload fits.
  // Token count is monotonically non-increasing in d (dropping a node removes
  // its serialized content and any dangling edges), so binary-search the
  // minimal d that fits — O(log n) renders instead of the previous O(n) per-node
  // re-canonicalize. Budget is measured on the actual wire output, so invariant
  // #1 holds exactly. Frame nodes are never prunable.
  const prunable = [...nodes].filter((n) => n.type !== "frame").sort((a, b) => a.w - b.w);

  const renderDropping = (
    d: number
  ): { payload: SerializedPayload; wire: string; tokens: number } => {
    const droppedIds = new Set(prunable.slice(0, d).map((n) => n.id));
    const keptNodes = nodes.filter((n) => !droppedIds.has(n.id));
    const keptEdges = edges.filter((e) => !droppedIds.has(e.src) && !droppedIds.has(e.tgt));
    const payload = buildFullPayload(frame, keptNodes, keptEdges, frameVersion);
    const wire = canonicalize(payload);
    return { payload, wire, tokens: tokenizer.countTokens(wire) };
  };

  // If dropping every prunable node still overflows, the full tier is infeasible.
  if (renderDropping(prunable.length).tokens > budget) return null;

  // Minimal d in [0, prunable.length] whose rendered payload fits the budget.
  let lo = 0;
  let hi = prunable.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (renderDropping(mid).tokens <= budget) hi = mid;
    else lo = mid + 1;
  }
  const final = renderDropping(lo);
  return { payload: final.payload, wire: final.wire, tokens: final.tokens, actualTier: "full" };
}

/**
 * Count tokens for a frame at each tier without enforcing budget.
 * Used by the /v1/frame/{id}/budget endpoint.
 */
export function estimateTokens(
  resolved: ResolvedFrame,
  frameVersion: number,
  tokenizer?: Tokenizer
): { full: number; condensed: number; signal: number } {
  const tok = tokenizer ?? getTokenizer(resolved.frame.tokenizer);
  const activeEdges = resolved.edges.filter((e) => e.active);
  const nodes = resolved.nodes;

  const fullPayload = buildFullPayload(resolved.frame, nodes, activeEdges, frameVersion);
  const condensedPayload = buildCondensedPayload(resolved.frame, nodes, activeEdges, frameVersion);
  const signalPayload = buildSignalPayload(resolved.frame, nodes, activeEdges, frameVersion);

  return {
    full: tok.countTokens(canonicalize(fullPayload)),
    condensed: tok.countTokens(canonicalize(condensedPayload)),
    signal: tok.countTokens(canonicalize(signalPayload)),
  };
}
