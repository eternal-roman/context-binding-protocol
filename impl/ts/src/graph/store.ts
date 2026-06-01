/**
 * Graph Store — in-memory node and edge storage with append-mostly semantics.
 *
 * Implements:
 * - Node/edge storage indexed by id
 * - BLAKE3 id derivation on insert (G1)
 * - Optimistic concurrency via v field (G7)
 * - Lineage chain traversal for inheritance resolution
 * - Append-mostly upserts with prev pointer (invariant #6, G9)
 *
 * @see cbp-architecture.html Section II (Node Taxonomy)
 * @see cbp-architecture.html Section X Invariant 6 (append-mostly)
 */

import type { CbpNode } from "../types/node.js";
import type { CbpEdge } from "../types/edge.js";
import { CONTENT_FIELDS } from "../types/node.js";
import { deriveUniqueId, computeFullHash } from "./id.js";

export class ConflictError extends Error {
  constructor(
    public readonly nodeId: string,
    public readonly expectedV: number,
    public readonly actualV: number
  ) {
    super(
      `Optimistic concurrency conflict on node ${nodeId}: expected v=${expectedV}, actual v=${actualV}`
    );
    this.name = "ConflictError";
  }
}

export class NodeNotFoundError extends Error {
  constructor(public readonly nodeId: string) {
    super(`Node not found: ${nodeId}`);
    this.name = "NodeNotFoundError";
  }
}

export class LineageCycleError extends Error {
  constructor(public readonly nodeId: string, public readonly atId: string) {
    super(`Lineage chain for ${nodeId} contains a cycle at ${atId}`);
    this.name = "LineageCycleError";
  }
}

export class MaxNodesExceededError extends Error {
  constructor(
    public readonly frameId: string,
    public readonly limit: number
  ) {
    super(`Frame ${frameId} exceeds max_nodes_per_frame limit of ${limit}`);
    this.name = "MaxNodesExceededError";
  }
}

export interface StoreConfig {
  maxNodesPerFrame: number;
  maxDepth: number;
}

const DEFAULT_CONFIG: StoreConfig = {
  maxNodesPerFrame: 500,
  maxDepth: 8,
};

export class GraphStore {
  private readonly nodes = new Map<string, CbpNode>();
  private readonly edges = new Map<string, CbpEdge>();
  private readonly config: StoreConfig;

  // Full 64-char content hash -> stored node id. Enables collision-CORRECT
  // content dedup: deriveUniqueId may extend a colliding 8-char prefix, so an
  // 8-char `getNode(deriveId(...))` lookup misses a node stored under 9+ chars
  // and creates a duplicate. Self-heals stale entries on lookup.
  private readonly byContentHash = new Map<string, string>();

  // Ids superseded by a newer content version. MAINTAINED (not re-derived from
  // `prev` each call) so that (a) deleting a head never resurrects its
  // superseded predecessor as live, and (b) liveNodeCount can never diverge
  // from getLiveNodes(). Populated on upsert (old id) and load (the `prev` id).
  private readonly superseded = new Set<string>();

  // nodeId -> ids of edges touching it (as src or tgt). Avoids an O(edges) scan
  // on removeNode / getEdgesForNode.
  private readonly edgesByNode = new Map<string, Set<string>>();

  constructor(config: Partial<StoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Get a node by id, or undefined if not found. */
  getNode(id: string): CbpNode | undefined {
    return this.nodes.get(id);
  }

  /** Get an edge by id, or undefined if not found. */
  getEdge(id: string): CbpEdge | undefined {
    return this.edges.get(id);
  }

  /**
   * Get all nodes in the store, including superseded historical versions.
   * Use for persistence snapshots and history walks. For live operations
   * (serialization, decay, capacity), use {@link getLiveNodes}.
   */
  getAllNodes(): CbpNode[] {
    return [...this.nodes.values()];
  }

  /**
   * Get the LIVE (head) nodes — every stored node not superseded by a newer
   * content version. This is the working set the resolver, serializer, decay
   * engine, and capacity check operate on.
   */
  getLiveNodes(): CbpNode[] {
    return [...this.nodes.values()].filter((n) => !this.superseded.has(n.id));
  }

  /** Get all edges in the store. */
  getAllEdges(): CbpEdge[] {
    return [...this.edges.values()];
  }

  /** Total count of stored nodes, including superseded history. */
  get nodeCount(): number {
    return this.nodes.size;
  }

  /** Count of LIVE (head) nodes — the working-set size the cap bounds. */
  get liveNodeCount(): number {
    let count = 0;
    for (const id of this.nodes.keys()) {
      if (!this.superseded.has(id)) count++;
    }
    return count;
  }

  /**
   * Whether adding `additional` brand-new live nodes would exceed the
   * configured cap. The REST write surface uses {@link loadNode} (which is
   * intentionally unguarded so persistence hydrate and conformance-vector
   * loading can restore freely), so the network paths must consult this
   * before accepting an *insert*. Supersedes/metadata updates keep the live
   * count constant and need not check.
   */
  wouldExceedLiveCap(additional = 1): boolean {
    return this.liveNodeCount + additional > this.config.maxNodesPerFrame;
  }

  /** Get the count of edges currently stored. */
  get edgeCount(): number {
    return this.edges.size;
  }

  /**
   * Find a stored node with byte-identical content (type/val/lineage/tags),
   * via the full-hash index — collision-correct, unlike an 8-char prefix
   * lookup. Used by the ingest path to dedup re-ingested facts.
   */
  getNodeByContent(content: Pick<CbpNode, "type" | "val" | "lineage" | "tags">): CbpNode | undefined {
    const hash = computeFullHash(content);
    const id = this.byContentHash.get(hash);
    if (id === undefined) return undefined;
    const node = this.nodes.get(id);
    if (!node) {
      this.byContentHash.delete(hash); // self-heal a stale entry (node was deleted)
      return undefined;
    }
    return node;
  }

  /**
   * Insert a new node. Derives the id from content fields via BLAKE3.
   * Returns the node with its computed id.
   *
   * @throws MaxNodesExceededError if the store is at capacity.
   */
  insertNode(
    input: Omit<CbpNode, "id" | "v" | "prev">
  ): CbpNode {
    // The cap bounds the LIVE working set (GLOBAL — across all frames in this
    // store, not a per-frame quota; see ServerConfig.max_nodes_per_frame), not
    // lifetime mutations — a new node adds one live node, so compare against
    // liveNodeCount.
    if (this.liveNodeCount >= this.config.maxNodesPerFrame) {
      throw new MaxNodesExceededError("(global)", this.config.maxNodesPerFrame);
    }

    const existingIds = new Set(this.nodes.keys());
    const id = deriveUniqueId(input, existingIds);

    const node: CbpNode = {
      ...input,
      id,
      v: 1,
      prev: null,
    };

    this.nodes.set(id, node);
    this.superseded.delete(id); // a freed (deleted-tombstone) id reused for a new node is live again
    this.byContentHash.set(computeFullHash(input), id);
    return node;
  }

  /**
   * Insert a node with a pre-computed id (for loading from vectors/storage).
   * Skips id derivation. Used when loading conformance vectors or
   * restoring from persistence where ids are already known.
   */
  loadNode(node: CbpNode): void {
    this.nodes.set(node.id, node);
    // Rebuild the superseded set from prev pointers during hydrate/load. Order-
    // independent: every node that is some other node's prev is superseded. Do
    // NOT delete node.id here — a legitimately-superseded node may load after
    // the head that supersedes it.
    if (node.prev !== null && node.prev !== node.id) this.superseded.add(node.prev);
    this.byContentHash.set(computeFullHash(node), node.id);
  }

  /**
   * Upsert a node with optimistic concurrency.
   *
   * The caller provides the expected v (the version they last read).
   * If the current v matches, the node is updated with v+1 and the
   * previous version's id is stored in prev.
   *
   * @throws ConflictError if v doesn't match (409 in REST).
   * @throws NodeNotFoundError if the node doesn't exist.
   */
  upsertNode(
    id: string,
    update: Partial<Omit<CbpNode, "id" | "v" | "prev">>,
    expectedV: number
  ): CbpNode {
    const existing = this.nodes.get(id);
    if (!existing) {
      throw new NodeNotFoundError(id);
    }
    if (existing.v !== expectedV) {
      throw new ConflictError(id, expectedV, existing.v);
    }

    // Determine whether any content fields (type, val, lineage, tags) are
    // being changed. Content fields are hashed into the node id, so changes
    // to them require a new BLAKE3-derived id (append-mostly semantics).
    const hasContentChange = CONTENT_FIELDS.some(
      (field) => field in update && update[field] !== undefined
    );

    if (hasContentChange) {
      // --- Content mutation: new id, preserve old node ---
      // No capacity check here: superseding a node keeps the LIVE count
      // constant (old version becomes history, new version is the head).
      // The cap is enforced on insertNode, which adds a live node.
      // (Bounding total history is a separate retention concern.)
      const merged: Omit<CbpNode, "id" | "v" | "prev"> = {
        type: (update.type ?? existing.type) as CbpNode["type"],
        val: update.val ?? existing.val,
        w: update.w ?? existing.w,
        decay: (update.decay ?? existing.decay) as CbpNode["decay"],
        ttl: "ttl" in update ? (update.ttl as CbpNode["ttl"]) : existing.ttl,
        lineage: "lineage" in update ? (update.lineage as CbpNode["lineage"]) : existing.lineage,
        tags: update.tags ?? existing.tags,
      };

      const existingIds = new Set(this.nodes.keys());
      const newId = deriveUniqueId(merged, existingIds);

      const newNode: CbpNode = {
        ...merged,
        id: newId,
        v: existing.v + 1,
        prev: existing.id,
      };

      // Keep old node in store (append-mostly invariant)
      this.nodes.set(newId, newNode);
      this.superseded.add(existing.id); // the prior version is now history
      this.superseded.delete(newId);    // the new head is live (even if newId reused a freed id)
      this.byContentHash.set(computeFullHash(merged), newId);
      return newNode;
    } else {
      // --- Metadata-only update: same id, in-place ---
      // `v` bumps for optimistic concurrency, but `prev` is the
      // content-history link and MUST be preserved unchanged. Metadata
      // (w/decay/ttl) is not content and creates no new content version,
      // so pointing prev at this node's own id would both fabricate a
      // self-referential (un-walkable) history link and destroy the real
      // prior-version pointer. Keep existing.prev. Content is unchanged, so
      // the byContentHash entry already points here.
      const updated: CbpNode = {
        ...existing,
        ...update,
        id,
        v: existing.v + 1,
        prev: existing.prev,
      };

      this.nodes.set(id, updated);
      return updated;
    }
  }

  /** Remove a node and all edges referencing it (cascade). */
  removeNode(id: string): boolean {
    const existed = this.nodes.delete(id);
    if (existed) {
      // Cascade edge removal via the reverse index (O(degree), not O(edges)).
      const eids = this.edgesByNode.get(id);
      if (eids) {
        for (const eid of [...eids]) {
          const edge = this.edges.get(eid);
          if (edge) {
            this.edges.delete(eid);
            this.unindexEdge(edge);
          }
        }
      }
      // Deliberately keep `id` in `superseded` if it was already there: removing
      // a head must NOT resurrect its superseded predecessor as live (the
      // predecessor's tombstone, added at upsert time, persists here).
    }
    return existed;
  }

  private indexEdge(edge: CbpEdge): void {
    for (const n of [edge.src, edge.tgt]) {
      let set = this.edgesByNode.get(n);
      if (!set) {
        set = new Set<string>();
        this.edgesByNode.set(n, set);
      }
      set.add(edge.id);
    }
  }

  private unindexEdge(edge: CbpEdge): void {
    for (const n of [edge.src, edge.tgt]) {
      const set = this.edgesByNode.get(n);
      if (set) {
        set.delete(edge.id);
        if (set.size === 0) this.edgesByNode.delete(n);
      }
    }
  }

  /** Insert an edge with a pre-computed id (for loading). */
  loadEdge(edge: CbpEdge): void {
    const prev = this.edges.get(edge.id);
    if (prev) this.unindexEdge(prev); // an overwrite may change src/tgt — reindex
    this.edges.set(edge.id, edge);
    this.indexEdge(edge);
  }

  /** Remove an edge by id. */
  removeEdge(id: string): boolean {
    const edge = this.edges.get(id);
    if (!edge) return false;
    this.edges.delete(id);
    this.unindexEdge(edge);
    return true;
  }

  /**
   * Walk the lineage chain from a node upward to the frame root.
   * Returns the chain from the given node to the root (inclusive).
   *
   * @throws NodeNotFoundError if any node in the chain is missing.
   * @throws LineageCycleError if a node is revisited (a true cycle), independent
   *   of depth.
   * @throws Error if the chain length exceeds maxDepth (a structural bound,
   *   distinct from a cycle).
   */
  walkLineage(nodeId: string): CbpNode[] {
    const chain: CbpNode[] = [];
    const visited = new Set<string>();
    let currentId: string | null = nodeId;

    while (currentId !== null) {
      if (visited.has(currentId)) {
        throw new LineageCycleError(nodeId, currentId);
      }
      if (chain.length > this.config.maxDepth) {
        throw new Error(
          `Lineage chain for ${nodeId} exceeds max_depth of ${this.config.maxDepth}`
        );
      }
      visited.add(currentId);

      const node = this.nodes.get(currentId);
      if (!node) {
        throw new NodeNotFoundError(currentId);
      }

      chain.push(node);
      currentId = node.lineage;
    }

    return chain;
  }

  /**
   * Get all children of a node (nodes whose lineage points to this id).
   */
  getChildren(parentId: string): CbpNode[] {
    const children: CbpNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.lineage === parentId) {
        children.push(node);
      }
    }
    return children;
  }

  /**
   * Get all edges where the given node is either src or tgt.
   */
  getEdgesForNode(nodeId: string): CbpEdge[] {
    const ids = this.edgesByNode.get(nodeId);
    if (!ids) return [];
    const result: CbpEdge[] = [];
    for (const eid of ids) {
      const edge = this.edges.get(eid);
      if (edge) result.push(edge);
    }
    return result;
  }

  /** Clear all nodes and edges. */
  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.byContentHash.clear();
    this.superseded.clear();
    this.edgesByNode.clear();
  }
}
