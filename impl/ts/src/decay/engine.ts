/**
 * Decay Engine — manages the epoch counter, GC sweeps, and weight decay.
 *
 * The epoch counter is monotonic, advanced by exactly one on each GC sweep.
 * Wall clock drives the sweep interval; the counter is the semantic time.
 * This makes deterministic replay possible.
 *
 * @see spec/schemas/config.schema.json — epoch_interval_seconds, decay_factor, gc_policy
 * @see cbp-architecture.html Section VII — "Epoch semantics (G2)"
 * @see cbp-architecture.html Section X — Invariant #4 (decay is mandatory)
 */

import type { ServerConfig } from "../types/config.js";
import type { CbpNode, DecayPolicy } from "../types/node.js";
import { GraphStore } from "../graph/store.js";
import { resolveInheritance } from "../resolver/inheritance.js";

export interface DecayEngineConfig {
  epochIntervalSeconds: number;
  decayFactor: number;
  gcThreshold: number;
}

export interface GcResult {
  epoch: number;
  nodesDecayed: number;
  nodesPruned: string[];
  edgesPruned: string[];
}

/** Clamp a relevance weight to the schema-mandated range [0,1]. */
function clampWeight(w: number): number {
  if (Number.isNaN(w)) return 0;
  return Math.min(1, Math.max(0, w));
}

export class DecayEngine {
  private epoch = 0;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly config: DecayEngineConfig;

  constructor(config: Partial<DecayEngineConfig> = {}) {
    this.config = {
      epochIntervalSeconds: config.epochIntervalSeconds ?? 3600,
      decayFactor: config.decayFactor ?? 0.85,
      gcThreshold: config.gcThreshold ?? 0.1,
    };
  }

  /**
   * Resolve a node's effective `w`/`decay`, accounting for inheritance.
   *
   * Resolution can fail if the node's lineage is broken (an orphan, or an
   * ancestor pruned earlier in this same sweep). In that case decay must
   * not crash — fall back to the node's own values with spec defaults.
   * (Effective values are resolved in the default prototypal mode.)
   */
  private effectiveValues(
    node: CbpNode,
    store: GraphStore
  ): { w: number; decay: DecayPolicy } {
    try {
      const resolved = resolveInheritance(node.id, store);
      return { w: resolved.w, decay: resolved.decay };
    } catch {
      return { w: node.w ?? 1.0, decay: node.decay ?? "epoch" };
    }
  }

  /** Current epoch counter value. */
  get currentEpoch(): number {
    return this.epoch;
  }

  /** Get the decay configuration. */
  get settings(): Readonly<DecayEngineConfig> {
    return this.config;
  }

  /**
   * Create a DecayEngine from a ServerConfig.
   */
  static fromServerConfig(config: ServerConfig): DecayEngine {
    return new DecayEngine({
      epochIntervalSeconds: config.epoch_interval_seconds,
      decayFactor: config.decay_factor,
      gcThreshold: config.gc_policy.threshold,
    });
  }

  /**
   * Start the automatic GC sweep timer.
   * Advances the epoch counter at the configured interval.
   */
  start(store: GraphStore): void {
    if (this.intervalHandle !== null) return;
    this.intervalHandle = setInterval(() => {
      this.sweep(store);
    }, this.config.epochIntervalSeconds * 1000);
  }

  /** Stop the automatic GC sweep timer. */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Manually advance the epoch by one and run a GC sweep.
   *
   * This is the core operation. Called automatically by the timer,
   * or manually for deterministic testing and replay.
   *
   * Steps:
   * 1. Advance epoch counter by 1.
   * 2. For each node with decay:epoch, multiply w by decay_factor.
   * 3. Prune nodes whose w falls below gc_threshold.
   * 4. Prune edges whose TTL has expired (if TTL-based pruning applies).
   * 5. Cascade: prune edges referencing pruned nodes.
   *
   * @returns Summary of what happened in this sweep.
   */
  sweep(store: GraphStore): GcResult {
    this.epoch++;

    const result: GcResult = {
      epoch: this.epoch,
      nodesDecayed: 0,
      nodesPruned: [],
      edgesPruned: [],
    };

    // Phase 1: Decay weights for epoch-decay nodes.
    // Only LIVE (head) nodes decay — superseded historical versions are
    // frozen and must not be mutated or pruned by a sweep.
    //
    // `w`/`decay` may be inherited (omitted on the stored node), so we use
    // their EFFECTIVE values. Effective values are SNAPSHOT before any
    // mutation, so a parent decaying in this same sweep does not compound
    // into a child that inherits its weight. Decaying an inherited weight
    // MATERIALIZES a concrete `w` on the node (option A): the inherited
    // value is read, decayed, and written back as the node's own weight.
    const liveNodes = store.getLiveNodes();
    const snapshot = liveNodes.map((node) => ({
      node,
      eff: this.effectiveValues(node, store),
    }));
    for (const { node, eff } of snapshot) {
      if (eff.decay === "epoch") {
        const newWeight = clampWeight(eff.w * this.config.decayFactor);
        try {
          store.upsertNode(node.id, { w: newWeight }, node.v);
          result.nodesDecayed++;
        } catch {
          // ConflictError during GC is unexpected but non-fatal — skip
        }
      }
    }

    // Phase 2: Prune live nodes whose effective weight is below threshold.
    const postDecayNodes = store.getLiveNodes();
    for (const node of postDecayNodes) {
      const effectiveW = this.effectiveValues(node, store).w;
      if (effectiveW < this.config.gcThreshold && node.type !== "frame") {
        // Never prune frame roots — they are structural anchors
        store.removeNode(node.id); // cascades to edges
        result.nodesPruned.push(node.id);
      }
    }

    // Phase 3: Prune edges with expired TTL
    const allEdges = store.getAllEdges();
    for (const edge of allEdges) {
      if (edge.ttl !== null && edge.ttl !== undefined && edge.ttl > 0) {
        // TTL is relative to creation — we'd need a created_at timestamp
        // to enforce this properly. For v0.4, TTL on edges is tracked but
        // pruning requires the server to record creation time (deferred
        // to full persistence layer). Skip for now.
      }
      // Check if edge references pruned nodes (already handled by
      // store.removeNode cascade, but belt-and-suspenders)
      if (!store.getNode(edge.src) || !store.getNode(edge.tgt)) {
        if (store.getEdge(edge.id)) {
          store.removeEdge(edge.id);
          result.edgesPruned.push(edge.id);
        }
      }
    }

    return result;
  }

  /**
   * Trigger an event-based decay reset.
   *
   * For nodes with decay:event, an event trigger resets their weight
   * to a specified value (or refreshes their TTL). This is called
   * by the data ingest layer when an external event occurs.
   */
  triggerEvent(
    store: GraphStore,
    _eventName: string,
    nodeIds: string[],
    resetWeight: number = 1.0
  ): number {
    let updated = 0;
    for (const id of nodeIds) {
      const node = store.getNode(id);
      if (!node) continue;
      // Resolve the effective decay through the guarded helper: a node with a
      // broken lineage (orphan, or an ancestor pruned earlier in this run) must
      // NOT throw out of the loop and abort the rest of the batch — it falls
      // back to its own decay policy instead.
      if (this.effectiveValues(node, store).decay === "event") {
        try {
          store.upsertNode(id, { w: clampWeight(resetWeight) }, node.v);
          updated++;
        } catch {
          // ConflictError — skip
        }
      }
    }
    return updated;
  }
}
