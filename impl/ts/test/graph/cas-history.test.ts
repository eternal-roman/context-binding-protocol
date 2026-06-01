/**
 * CAS History Tests — CBP-004 fix validation.
 *
 * Verifies that upsertNode correctly handles the two code paths:
 * 1. Content mutation (val, type, lineage, tags) → new BLAKE3 id, old node preserved
 * 2. Metadata-only update (w, decay, ttl) → same id, in-place update
 *
 * @see cbp-architecture.html Section X Invariant 6 (append-mostly)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";

describe("CAS history (CBP-004)", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore({ maxNodesPerFrame: 100, maxDepth: 8 });
  });

  describe("content mutation produces a new node", () => {
    it("changing val creates a new node with a new id", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: ["domain:accounts"],
      });

      const updated = store.upsertNode(
        original.id,
        { val: "Globex Inc" },
        original.v
      );

      // New node must have a different id (new BLAKE3 hash)
      expect(updated.id).not.toBe(original.id);
      // prev must point to the OLD node's id
      expect(updated.prev).toBe(original.id);
      // v must be bumped
      expect(updated.v).toBe(original.v + 1);
      // Content must reflect the update
      expect(updated.val).toBe("Globex Inc");
      // Metadata should carry over
      expect(updated.w).toBe(0.9);
      expect(updated.decay).toBe("epoch");
      expect(updated.tags).toEqual(["domain:accounts"]);
    });

    it("changing type creates a new node with a new id", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { type: "state" },
        original.v
      );

      expect(updated.id).not.toBe(original.id);
      expect(updated.prev).toBe(original.id);
      expect(updated.type).toBe("state");
    });

    it("changing tags creates a new node with a new id", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { tags: ["important"] },
        original.v
      );

      expect(updated.id).not.toBe(original.id);
      expect(updated.prev).toBe(original.id);
      expect(updated.tags).toEqual(["important"]);
    });

    it("changing lineage creates a new node with a new id", () => {
      const parent = store.insertNode({
        type: "frame",
        val: { name: "root" },
        w: 1.0,
        decay: "none",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { lineage: parent.id },
        original.v
      );

      expect(updated.id).not.toBe(original.id);
      expect(updated.prev).toBe(original.id);
      expect(updated.lineage).toBe(parent.id);
    });

    it("preserves old node in store after content mutation (append-mostly)", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { val: "Globex Inc" },
        original.v
      );

      // Both nodes must exist in the store
      const oldNode = store.getNode(original.id);
      const newNode = store.getNode(updated.id);

      if (!oldNode || !newNode) {
        throw new Error("Expected both old and new nodes to exist");
      }
      expect(oldNode.id).toBe(original.id);
      expect(newNode.id).toBe(updated.id);
      expect(oldNode.val).toBe("Acme Corp");
      expect(newNode.val).toBe("Globex Inc");

      // Store should have one more node than before
      // (parent frame if any + original + new = depends on setup)
      // Just check both are present and distinct
      expect(store.nodeCount).toBe(2);
    });

    it("content mutation at capacity supersedes in place (live count unchanged)", () => {
      const smallStore = new GraphStore({ maxNodesPerFrame: 2, maxDepth: 8 });

      const n1 = smallStore.insertNode({
        type: "entity",
        val: "A",
        w: 1,
        decay: "none",
        ttl: null,
        lineage: null,
        tags: [],
      });

      smallStore.insertNode({
        type: "entity",
        val: "B",
        w: 1,
        decay: "none",
        ttl: null,
        lineage: null,
        tags: [],
      });

      // The cap bounds the LIVE working set. A content mutation supersedes
      // the old version (it becomes history) and adds one head — net live
      // count is unchanged, so it must NOT trip the cap.
      expect(() =>
        smallStore.upsertNode(n1.id, { val: "A-updated" }, n1.v)
      ).not.toThrow();
      expect(smallStore.liveNodeCount).toBe(2);
      expect(smallStore.nodeCount).toBe(3); // history retained
    });
  });

  describe("metadata-only update keeps the same id", () => {
    it("changing w keeps the same id and updates in place", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { w: 0.5 },
        original.v
      );

      expect(updated.id).toBe(original.id);
      // prev is the content-history link, not the version counter: a
      // metadata-only change creates no new content version, so prev is
      // preserved (null here — original was a fresh insert), never self.
      expect(updated.prev).toBeNull();
      expect(updated.prev).not.toBe(updated.id);
      expect(updated.v).toBe(original.v + 1);
      expect(updated.w).toBe(0.5);

      // Only one node in store — in-place update
      expect(store.nodeCount).toBe(1);
    });

    it("changing decay keeps the same id", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { decay: "none" },
        original.v
      );

      expect(updated.id).toBe(original.id);
      expect(updated.decay).toBe("none");
    });

    it("changing ttl keeps the same id", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { ttl: 3600 },
        original.v
      );

      expect(updated.id).toBe(original.id);
      expect(updated.ttl).toBe(3600);
    });

    it("changing multiple metadata fields keeps the same id", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { w: 0.5, decay: "none", ttl: 7200 },
        original.v
      );

      expect(updated.id).toBe(original.id);
      expect(updated.w).toBe(0.5);
      expect(updated.decay).toBe("none");
      expect(updated.ttl).toBe(7200);
    });
  });

  describe("mixed content + metadata update", () => {
    it("content + metadata change together creates a new node", () => {
      const original = store.insertNode({
        type: "entity",
        val: "Acme Corp",
        w: 0.9,
        decay: "epoch",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const updated = store.upsertNode(
        original.id,
        { val: "Globex Inc", w: 0.5 },
        original.v
      );

      // Content changed → new id
      expect(updated.id).not.toBe(original.id);
      expect(updated.prev).toBe(original.id);
      // Metadata from the update is applied
      expect(updated.w).toBe(0.5);
      expect(updated.val).toBe("Globex Inc");

      // Both nodes in store
      expect(store.getNode(original.id)).toBeDefined();
      expect(store.getNode(updated.id)).toBeDefined();
    });
  });

  describe("CAS chain traversal", () => {
    it("can follow prev pointers through multiple content mutations", () => {
      const v1 = store.insertNode({
        type: "state",
        val: { price: 100 },
        w: 0.9,
        decay: "event",
        ttl: null,
        lineage: null,
        tags: [],
      });

      const v2 = store.upsertNode(
        v1.id,
        { val: { price: 200 } },
        v1.v
      );

      const v3 = store.upsertNode(
        v2.id,
        { val: { price: 300 } },
        v2.v
      );

      // All three versions should exist
      expect(store.getNode(v1.id)).toBeDefined();
      expect(store.getNode(v2.id)).toBeDefined();
      expect(store.getNode(v3.id)).toBeDefined();
      expect(store.nodeCount).toBe(3);

      // Chain: v3.prev → v2.id, v2.prev → v1.id, v1.prev → null
      expect(v3.prev).toBe(v2.id);
      expect(v2.prev).toBe(v1.id);
      expect(v1.prev).toBeNull();
    });
  });
});
