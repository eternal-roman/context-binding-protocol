import { describe, it, expect, beforeEach } from "vitest";
import { DecayEngine } from "../../src/decay/engine.js";
import { GraphStore } from "../../src/graph/store.js";
import type { CbpNode } from "../../src/types/node.js";

describe("DecayEngine (G2)", () => {
  let store: GraphStore;
  let engine: DecayEngine;

  const frameNode: CbpNode = {
    id: "f0000001",
    type: "frame",
    val: { name: "test" },
    w: 1.0,
    decay: "epoch",
    ttl: null,
    lineage: null,
    tags: ["domain:accounts"],
    v: 1,
    prev: null,
  };

  const entityNode: CbpNode = {
    id: "a0000001",
    type: "entity",
    val: "Acme Corp",
    w: 1.0,
    decay: "epoch",
    ttl: null,
    lineage: "f0000001",
    tags: [],
    v: 1,
    prev: null,
  };

  const eventNode: CbpNode = {
    id: "b0000001",
    type: "state",
    val: { price: 68420 },
    w: 0.9,
    decay: "event",
    ttl: null,
    lineage: "a0000001",
    tags: [],
    v: 1,
    prev: null,
  };

  const noneNode: CbpNode = {
    id: "c0000001",
    type: "prior",
    val: { renewal_outlook: "at_risk" },
    w: 0.5,
    decay: "none",
    ttl: null,
    lineage: "f0000001",
    tags: [],
    v: 1,
    prev: null,
  };

  beforeEach(() => {
    store = new GraphStore({ maxNodesPerFrame: 100, maxDepth: 8 });
    engine = new DecayEngine({ decayFactor: 0.85, gcThreshold: 0.1 });
    store.loadNode(frameNode);
    store.loadNode(entityNode);
    store.loadNode(eventNode);
    store.loadNode(noneNode);
  });

  describe("epoch counter", () => {
    it("starts at 0", () => {
      expect(engine.currentEpoch).toBe(0);
    });

    it("advances by 1 on each sweep", () => {
      engine.sweep(store);
      expect(engine.currentEpoch).toBe(1);
      engine.sweep(store);
      expect(engine.currentEpoch).toBe(2);
    });
  });

  describe("weight decay", () => {
    it("decays epoch-type nodes by decay_factor", () => {
      engine.sweep(store);
      const acme = store.getNode("a0000001");
      expect(acme?.w).toBeCloseTo(0.85, 10);
    });

    it("does NOT decay event-type nodes", () => {
      engine.sweep(store);
      const price = store.getNode("b0000001");
      expect(price?.w).toBe(0.9);
    });

    it("does NOT decay none-type nodes", () => {
      engine.sweep(store);
      const renewal_outlook = store.getNode("c0000001");
      expect(renewal_outlook?.w).toBe(0.5);
    });

    it("compounds decay across multiple epochs", () => {
      engine.sweep(store);
      engine.sweep(store);
      const acme = store.getNode("a0000001");
      expect(acme?.w).toBeCloseTo(1.0 * 0.85 * 0.85, 10);
    });

    it("bumps v on each decay", () => {
      engine.sweep(store);
      const acme = store.getNode("a0000001");
      expect(acme?.v).toBe(2);
    });
  });

  describe("pruning", () => {
    it("prunes nodes below gc_threshold", () => {
      // Set a low weight that will go below 0.1 after one decay
      store.upsertNode("a0000001", { w: 0.1 }, 1);
      engine.sweep(store); // w becomes 0.1 * 0.85 = 0.085 < 0.1
      expect(store.getNode("a0000001")).toBeUndefined();
    });

    it("never prunes frame roots", () => {
      // Frame root has decay:epoch, so it decays. But it should never be pruned.
      // Run enough sweeps to get frame weight very low
      for (let i = 0; i < 50; i++) {
        engine.sweep(store);
      }
      // Frame should still exist even though w is astronomically small
      expect(store.getNode("f0000001")).toBeDefined();
    });

    it("cascades edge removal when a node is pruned", () => {
      store.loadEdge({
        id: "e0000001",
        src: "a0000001",
        tgt: "c0000001",
        rel: "correlates",
        strength: 0.85,
        conditional: "always",
        w: 1.0,
        decay: "none",
        ttl: null,
        v: 1,
        prev: null,
      });

      store.upsertNode("a0000001", { w: 0.1 }, 1);
      engine.sweep(store);
      expect(store.getEdge("e0000001")).toBeUndefined();
    });

    it("returns GcResult with correct counts", () => {
      const result = engine.sweep(store);
      expect(result.epoch).toBe(1);
      expect(result.nodesDecayed).toBeGreaterThan(0);
      expect(result.nodesPruned).toBeInstanceOf(Array);
      expect(result.edgesPruned).toBeInstanceOf(Array);
    });
  });

  describe("event-based decay", () => {
    it("resets weight on event trigger for event-type nodes", () => {
      // Manually lower the weight
      store.upsertNode("b0000001", { w: 0.3 }, 1);
      const updated = engine.triggerEvent(store, "price_update", ["b0000001"], 1.0);
      expect(updated).toBe(1);
      expect(store.getNode("b0000001")?.w).toBe(1.0);
    });

    it("ignores non-event nodes on event trigger", () => {
      const updated = engine.triggerEvent(store, "price_update", ["a0000001"], 1.0);
      expect(updated).toBe(0);
    });

    it("does not let one broken-lineage node abort the whole event batch (A12)", () => {
      // An orphan whose lineage points at a non-existent ancestor: resolving its
      // inheritance throws. That must not abort processing of the rest of the
      // batch (the valid event node after it must still reset).
      store.loadNode({
        id: "d0000001",
        type: "state",
        val: { x: 1 },
        w: 0.2,
        decay: "event",
        ttl: null,
        lineage: "zzzzzzzz",
        tags: [],
        v: 1,
        prev: null,
      });
      store.upsertNode("b0000001", { w: 0.3 }, 1); // valid event node, lowered

      let updated = 0;
      expect(() => {
        updated = engine.triggerEvent(store, "evt", ["d0000001", "b0000001"], 1.0);
      }).not.toThrow();
      expect(updated).toBe(2);
      expect(store.getNode("b0000001")?.w).toBe(1.0);
      expect(store.getNode("d0000001")?.w).toBe(1.0);
    });
  });

  describe("deterministic replay", () => {
    it("produces identical state when sweeps are replayed", () => {
      const store2 = new GraphStore({ maxNodesPerFrame: 100, maxDepth: 8 });
      const engine2 = new DecayEngine({ decayFactor: 0.85, gcThreshold: 0.1 });
      store2.loadNode({ ...frameNode });
      store2.loadNode({ ...entityNode });
      store2.loadNode({ ...eventNode });
      store2.loadNode({ ...noneNode });

      // Run 5 sweeps on both
      for (let i = 0; i < 5; i++) {
        engine.sweep(store);
        engine2.sweep(store2);
      }

      // Both stores should have identical node weights
      for (const node of store.getAllNodes()) {
        const node2 = store2.getNode(node.id);
        expect(node2).toBeDefined();
        expect(node.w).toBeCloseTo(node2?.w ?? -1, 10);
      }
    });
  });
});
