/**
 * Prototypal inheritance resolver.
 *
 * Walks a node's lineage chain upward, filling in inherited fields
 * from parent nodes. A child node inherits all fields from its parent
 * except those it explicitly declares.
 *
 * @see cbp-architecture.html Section II — Inheritance Resolution
 */

import type { CbpNode, ResolvedNode } from "../types/node.js";
import type { InheritanceMode } from "../types/frame.js";
import type { GraphStore } from "../graph/store.js";

/**
 * Inheritable VALUE fields: when a child omits one (undefined), it is
 * inherited from the nearest ancestor that declares it, falling back to a
 * spec default. An explicitly declared value overrides. (Tags are handled
 * separately — they MERGE rather than replace.)
 */
const INHERITABLE_VALUE_FIELDS: ReadonlyArray<keyof CbpNode> = [
  "w",
  "decay",
  "ttl",
];

/**
 * Spec defaults for inheritable fields. Used when neither the node
 * nor any ancestor in the lineage chain declares a value.
 *
 * @see cbp-architecture.html Section II — Node Taxonomy (default values)
 */
const SPEC_DEFAULTS: Record<string, unknown> = {
  w: 1.0,
  decay: "epoch",
  ttl: null,
};

/**
 * Resolve a single node by applying inheritance, producing a node whose
 * inheritable fields (w/decay/ttl/tags) are concrete.
 *
 * - `prototypal` (default): a field the child omits is inherited from the
 *   nearest ancestor that declares it (walking lineage to the frame root),
 *   falling back to a spec default. Tags merge across the chain.
 * - `override_only`: no inheritance — the child uses only its own values;
 *   omitted fields get spec defaults, tags are the child's own.
 *
 * @returns A ResolvedNode with w/decay/ttl guaranteed concrete.
 */
export function resolveInheritance(
  nodeId: string,
  store: GraphStore,
  mode: InheritanceMode = "prototypal"
): ResolvedNode {
  const chain = store.walkLineage(nodeId);

  if (chain.length === 0) {
    throw new Error(`Empty lineage chain for node ${nodeId}`);
  }

  const node = chain[0];
  if (!node) {
    throw new Error(`Node ${nodeId} not found at start of chain`);
  }

  const resolved: Record<string, unknown> = { ...node };

  // Ancestors participate in inheritance only in prototypal mode.
  const ancestors = mode === "prototypal" ? chain.slice(1) : [];

  // Tags: merge child + ancestor tags (prototypal); own tags only otherwise.
  if (mode === "prototypal") {
    const tagSet = new Set(node.tags);
    for (const ancestor of ancestors) {
      for (const tag of ancestor.tags) tagSet.add(tag);
    }
    resolved.tags = [...tagSet];
  }

  // Value fields: fill any the child omitted, from the nearest ancestor
  // that declares it, else the spec default. Explicit values are kept.
  for (const field of INHERITABLE_VALUE_FIELDS) {
    if (resolved[field] !== undefined) continue; // explicit override wins
    let filled = false;
    for (const ancestor of ancestors) {
      const value = (ancestor as Record<string, unknown>)[field];
      if (value !== undefined) {
        resolved[field] = value;
        filled = true;
        break;
      }
    }
    if (!filled) resolved[field] = SPEC_DEFAULTS[field];
  }

  return resolved as ResolvedNode;
}

/**
 * Resolve all LIVE nodes in a store, applying inheritance under `mode`.
 *
 * Superseded historical versions are retained in the store for audit/replay
 * but never appear in a resolved frame — that would surface stale
 * duplicates to the LLM.
 *
 * @returns A Map of node id → ResolvedNode.
 */
export function resolveAllInheritance(
  store: GraphStore,
  mode: InheritanceMode = "prototypal"
): Map<string, ResolvedNode> {
  const resolved = new Map<string, ResolvedNode>();
  for (const node of store.getLiveNodes()) {
    resolved.set(node.id, resolveInheritance(node.id, store, mode));
  }
  return resolved;
}
