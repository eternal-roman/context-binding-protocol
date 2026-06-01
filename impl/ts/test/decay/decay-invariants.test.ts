/**
 * Decay engine invariants (root cause A, weight bound).
 *
 *  - Decay operates only on LIVE (head) nodes; frozen historical versions
 *    must never be mutated or pruned by a sweep.
 *  - Decayed / event-reset weight must stay within the schema bound [0,1].
 *
 * @see cbp-architecture.html Section VII (epoch semantics)
 * @see spec/schemas/node.schema.json (w in [0,1])
 */

import { describe, it, expect } from "vitest";
import { GraphStore } from "../../src/graph/store.js";
import { DecayEngine } from "../../src/decay/engine.js";
import type { CbpNode } from "../../src/types/node.js";

/** Fetch a node that must exist, without a non-null assertion. */
function must(store: GraphStore, id: string): CbpNode {
  const node = store.getNode(id);
  if (!node) throw new Error(`expected node ${id} to exist`);
  return node;
}

describe("decay engine invariants", () => {
  it("does not decay or prune superseded historical versions", () => {
    const store = new GraphStore();
    const v1 = store.insertNode({
      type: "entity",
      val: "Acme Corp",
      w: 0.9,
      decay: "epoch",
      ttl: null,
      lineage: null,
      tags: [],
    });
    const v2 = store.upsertNode(v1.id, { val: "Globex Inc" }, v1.v); // v1 superseded
    const v1wBefore = must(store, v1.id).w;

    const engine = new DecayEngine({ decayFactor: 0.5, gcThreshold: 0 });
    engine.sweep(store);

    // historical version untouched
    expect(must(store, v1.id).w).toBe(v1wBefore);
    // live head decayed
    expect(must(store, v2.id).w).toBeLessThan(0.9);
  });

  it("clamps decayed weight to [0,1] even with a pathological decay factor", () => {
    const store = new GraphStore();
    const n = store.insertNode({
      type: "entity",
      val: "X",
      w: 1.0,
      decay: "epoch",
      ttl: null,
      lineage: null,
      tags: [],
    });

    const engine = new DecayEngine({ decayFactor: 1.5, gcThreshold: 0 });
    engine.sweep(store);

    const after = must(store, n.id);
    expect(after.w).toBeLessThanOrEqual(1);
    expect(after.w).toBeGreaterThanOrEqual(0);
  });

  it("clamps event-reset weight to [0,1]", () => {
    const store = new GraphStore();
    const n = store.insertNode({
      type: "state",
      val: { price: 1 },
      w: 0.4,
      decay: "event",
      ttl: null,
      lineage: null,
      tags: [],
    });

    const engine = new DecayEngine();
    engine.triggerEvent(store, "price_update", [n.id], 5.0); // out-of-range reset

    expect(must(store, n.id).w).toBeLessThanOrEqual(1);
  });
});
