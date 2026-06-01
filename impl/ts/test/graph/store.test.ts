import { describe, it, expect, beforeEach } from "vitest";
import {
  GraphStore,
  ConflictError,
  NodeNotFoundError,
  MaxNodesExceededError,
} from "../../src/graph/store.js";
import type { CbpNode } from "../../src/types/node.js";
import type { CbpEdge } from "../../src/types/edge.js";

describe("GraphStore", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore({ maxNodesPerFrame: 10, maxDepth: 5 });
  });

  const frameNode: CbpNode = {
    id: "f0d2e8a1",
    type: "frame",
    val: { name: "test_frame" },
    w: 1.0,
    decay: "epoch",
    ttl: null,
    lineage: null,
    tags: ["domain:trading"],
    v: 1,
    prev: null,
  };

  const btcNode: CbpNode = {
    id: "a7c3f1e2",
    type: "entity",
    val: "BTC",
    w: 0.9,
    decay: "epoch",
    ttl: null,
    lineage: "f0d2e8a1",
    tags: [],
    v: 1,
    prev: null,
  };

  describe("loadNode / getNode", () => {
    it("loads and retrieves a node", () => {
      store.loadNode(frameNode);
      expect(store.getNode("f0d2e8a1")).toEqual(frameNode);
    });

    it("returns undefined for unknown id", () => {
      expect(store.getNode("nonexistent")).toBeUndefined();
    });
  });

  describe("insertNode", () => {
    it("derives id from content fields and returns node with v=1", () => {
      const result = store.insertNode({
        type: "entity",
        val: "BTC",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: ["domain:trading"],
      });
      expect(result.id).toMatch(/^[0-9a-f]{8,}$/);
      expect(result.v).toBe(1);
      expect(result.prev).toBeNull();
    });

    it("throws MaxNodesExceededError at capacity", () => {
      const smallStore = new GraphStore({ maxNodesPerFrame: 2, maxDepth: 5 });
      smallStore.insertNode({ type: "entity", val: "A", w: 1, decay: "none", ttl: null, lineage: null, tags: [] });
      smallStore.insertNode({ type: "entity", val: "B", w: 1, decay: "none", ttl: null, lineage: null, tags: [] });
      expect(() =>
        smallStore.insertNode({ type: "entity", val: "C", w: 1, decay: "none", ttl: null, lineage: null, tags: [] })
      ).toThrow(MaxNodesExceededError);
    });
  });

  describe("upsertNode (optimistic concurrency, G7)", () => {
    it("updates node when v matches", () => {
      store.loadNode(btcNode);
      const updated = store.upsertNode("a7c3f1e2", { w: 0.5 }, 1);
      expect(updated.v).toBe(2);
      expect(updated.w).toBe(0.5);
      // Metadata-only update preserves the content-history link; it must
      // not fabricate a self-referential prev.
      expect(updated.prev).toBe(btcNode.prev);
      expect(updated.prev).not.toBe(updated.id);
    });

    it("throws ConflictError when v doesn't match", () => {
      store.loadNode(btcNode);
      expect(() => store.upsertNode("a7c3f1e2", { w: 0.5 }, 99)).toThrow(
        ConflictError
      );
    });

    it("throws NodeNotFoundError for unknown id", () => {
      expect(() => store.upsertNode("unknown", { w: 0.5 }, 1)).toThrow(
        NodeNotFoundError
      );
    });
  });

  describe("removeNode (cascade)", () => {
    it("removes node and cascades to edges", () => {
      store.loadNode(frameNode);
      store.loadNode(btcNode);
      const edge: CbpEdge = {
        id: "e1e2e3e4",
        src: "a7c3f1e2",
        tgt: "f0d2e8a1",
        rel: "requires",
        strength: 1,
        conditional: "always",
        w: 1,
        decay: "none",
        ttl: null,
        v: 1,
        prev: null,
      };
      store.loadEdge(edge);

      store.removeNode("a7c3f1e2");
      expect(store.getNode("a7c3f1e2")).toBeUndefined();
      expect(store.getEdge("e1e2e3e4")).toBeUndefined();
    });
  });

  describe("walkLineage", () => {
    it("walks from leaf to frame root", () => {
      store.loadNode(frameNode);
      store.loadNode(btcNode);
      const priceNode: CbpNode = {
        id: "b2c4d5e6",
        type: "state",
        val: { price: 68420 },
        w: 0.9,
        decay: "event",
        ttl: null,
        lineage: "a7c3f1e2",
        tags: [],
        v: 1,
        prev: null,
      };
      store.loadNode(priceNode);

      const chain = store.walkLineage("b2c4d5e6");
      expect(chain.map((n) => n.id)).toEqual([
        "b2c4d5e6", // price state
        "a7c3f1e2", // BTC entity
        "f0d2e8a1", // frame root
      ]);
    });

    it("throws on missing node in chain", () => {
      store.loadNode(btcNode); // lineage points to f0d2e8a1 which is not loaded
      expect(() => store.walkLineage("a7c3f1e2")).toThrow(NodeNotFoundError);
    });

    it("detects a true cycle via the visited set, independent of depth", () => {
      // Cycle: A → B → C → D → A
      const deepStore = new GraphStore({ maxNodesPerFrame: 100, maxDepth: 3 });
      deepStore.loadNode({ ...frameNode, id: "aaaa0001", lineage: "aaaa0002" });
      deepStore.loadNode({ ...frameNode, id: "aaaa0002", lineage: "aaaa0003" });
      deepStore.loadNode({ ...frameNode, id: "aaaa0003", lineage: "aaaa0004" });
      deepStore.loadNode({ ...frameNode, id: "aaaa0004", lineage: "aaaa0001" });

      expect(() => deepStore.walkLineage("aaaa0001")).toThrow(/cycle/i);
    });

    it("throws a distinct max_depth error for an over-long but acyclic chain", () => {
      const deepStore = new GraphStore({ maxNodesPerFrame: 100, maxDepth: 2 });
      deepStore.loadNode({ ...frameNode, id: "bbbb0001", lineage: "bbbb0002" });
      deepStore.loadNode({ ...frameNode, id: "bbbb0002", lineage: "bbbb0003" });
      deepStore.loadNode({ ...frameNode, id: "bbbb0003", lineage: "bbbb0004" });
      deepStore.loadNode({ ...frameNode, id: "bbbb0004", lineage: null });

      expect(() => deepStore.walkLineage("bbbb0001")).toThrow(/max_depth/);
    });
  });

  describe("getChildren", () => {
    it("returns nodes whose lineage is the given id", () => {
      store.loadNode(frameNode);
      store.loadNode(btcNode);
      const ethNode: CbpNode = { ...btcNode, id: "d4e5f6a7", val: "ETH" };
      store.loadNode(ethNode);

      const children = store.getChildren("f0d2e8a1");
      expect(children.map((n) => n.id).sort()).toEqual(["a7c3f1e2", "d4e5f6a7"]);
    });
  });

  describe("getEdgesForNode", () => {
    it("returns edges where node is src or tgt", () => {
      store.loadNode(frameNode);
      store.loadNode(btcNode);
      const edge: CbpEdge = {
        id: "e1e2e3e4",
        src: "a7c3f1e2",
        tgt: "f0d2e8a1",
        rel: "correlates",
        strength: 0.85,
        conditional: "always",
        w: 1,
        decay: "none",
        ttl: null,
        v: 1,
        prev: null,
      };
      store.loadEdge(edge);

      expect(store.getEdgesForNode("a7c3f1e2")).toHaveLength(1);
      expect(store.getEdgesForNode("f0d2e8a1")).toHaveLength(1);
      expect(store.getEdgesForNode("nonexistent")).toHaveLength(0);
    });
  });
});
