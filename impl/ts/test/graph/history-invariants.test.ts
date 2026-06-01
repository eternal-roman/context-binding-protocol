/**
 * Append-mostly history invariants (root causes A + B).
 *
 * These guard the store's write model against two defects the original
 * suite did not catch (it asserted the buggy behavior):
 *   B. metadata-only upsert must not set prev = self (corrupt, un-walkable
 *      history) — prev is the content-history link, not the version counter.
 *   A. the store must distinguish LIVE (head) nodes from superseded history
 *      so the node cap and live operations count only the working set.
 *
 * @see cbp-architecture.html Section X Invariant 6 (append-mostly)
 */

import { describe, it, expect, beforeEach } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import type { CbpNode } from "../../src/types/node.js";

describe("append-mostly history invariants", () => {
  let store: GraphStore;

  beforeEach(() => {
    store = new GraphStore({ maxNodesPerFrame: 100, maxDepth: 8 });
  });

  function insertEntity(val: unknown, w = 0.9): CbpNode {
    return store.insertNode({
      type: "entity",
      val,
      w,
      decay: "epoch",
      ttl: null,
      lineage: null,
      tags: [],
    });
  }

  describe("prev is never self-referential", () => {
    it("metadata-only update preserves prev (does not point to self)", () => {
      const original = insertEntity("Acme Corp"); // prev = null
      const updated = store.upsertNode(original.id, { w: 0.5 }, original.v);

      expect(updated.id).toBe(original.id);
      expect(updated.prev).not.toBe(updated.id); // KEY invariant: no self-loop
      expect(updated.prev).toBeNull(); // fresh node had no prior content version
      expect(updated.v).toBe(original.v + 1); // v still bumps for CAS
      expect(updated.w).toBe(0.5);
    });

    it("metadata update after a content mutation preserves the content prev", () => {
      const v1 = insertEntity("Acme Corp");
      const v2 = store.upsertNode(v1.id, { val: "Globex Inc" }, v1.v); // content → new id
      expect(v2.prev).toBe(v1.id);

      const v2meta = store.upsertNode(v2.id, { w: 0.3 }, v2.v); // metadata-only
      expect(v2meta.id).toBe(v2.id);
      expect(v2meta.prev).toBe(v1.id); // preserved, NOT reset to self
      expect(v2meta.prev).not.toBe(v2meta.id);
    });

    it("prev chain terminates (no cycle) after repeated metadata edits", () => {
      let node = insertEntity("Acme Corp");
      for (let i = 0; i < 5; i++) {
        node = store.upsertNode(node.id, { w: (node.w ?? 1) * 0.9 }, node.v);
      }

      const seen = new Set<string>();
      let cursor: ReturnType<typeof store.getNode> = node;
      let hops = 0;
      while (cursor && cursor.prev !== null) {
        expect(seen.has(cursor.id)).toBe(false); // no cycle
        seen.add(cursor.id);
        cursor = store.getNode(cursor.prev);
        if (++hops > 100) throw new Error("prev chain did not terminate");
      }
      expect(hops).toBeLessThan(100);
    });
  });

  describe("live vs historical nodes", () => {
    it("content mutation supersedes the old version (excluded from live set)", () => {
      const v1 = insertEntity("Acme Corp");
      const v2 = store.upsertNode(v1.id, { val: "Globex Inc" }, v1.v);

      // both retained — append-mostly
      expect(store.getNode(v1.id)).toBeDefined();
      expect(store.getNode(v2.id)).toBeDefined();
      expect(store.nodeCount).toBe(2); // total includes history

      const liveIds = store.getLiveNodes().map((n) => n.id);
      expect(liveIds).toContain(v2.id);
      expect(liveIds).not.toContain(v1.id);
      expect(store.liveNodeCount).toBe(1);
    });

    it("content mutation does not count against the live-node cap", () => {
      const small = new GraphStore({ maxNodesPerFrame: 2, maxDepth: 8 });
      const a = small.insertNode({
        type: "entity",
        val: "A",
        w: 1,
        decay: "none",
        ttl: null,
        lineage: null,
        tags: [],
      });
      small.insertNode({
        type: "entity",
        val: "B",
        w: 1,
        decay: "none",
        ttl: null,
        lineage: null,
        tags: [],
      });

      // live = 2 (at cap). Editing A's content supersedes old A — live stays 2.
      expect(() => small.upsertNode(a.id, { val: "A2" }, a.v)).not.toThrow();
      expect(small.liveNodeCount).toBe(2);

      // a genuinely new live node exceeds the cap
      expect(() =>
        small.insertNode({
          type: "entity",
          val: "C",
          w: 1,
          decay: "none",
          ttl: null,
          lineage: null,
          tags: [],
        })
      ).toThrow();
    });

    it("getLiveNodes reconstructs heads after a bulk load (hydrate path)", () => {
      const v1 = insertEntity("Acme Corp");
      const v2 = store.upsertNode(v1.id, { val: "Globex Inc" }, v1.v);
      const snapshot = store.getAllNodes();

      const fresh = new GraphStore();
      for (const n of snapshot) fresh.loadNode(n);

      const liveIds = fresh.getLiveNodes().map((n) => n.id);
      expect(liveIds).toContain(v2.id);
      expect(liveIds).not.toContain(v1.id);
    });
  });
});
