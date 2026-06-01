import { describe, it, expect } from "vitest";
import { GraphStore } from "../../src/graph/store.js";

const N = (val: string): Parameters<GraphStore["insertNode"]>[0] =>
  ({ type: "state", val, lineage: null, tags: [], w: 1, decay: "none", ttl: null });

describe("liveNodeCount consistency (cap-bypass / unbounded-growth guard)", () => {
  it("stays consistent with getLiveNodes() after deleting a superseded predecessor", () => {
    const store = new GraphStore({ maxNodesPerFrame: 2 });
    const a = store.insertNode(N("v1"));
    const b = store.upsertNode(a.id, { val: "v2" }, a.v); // content change → b.prev = a, a superseded
    expect(b.prev).toBe(a.id);
    expect(store.liveNodeCount).toBe(1);

    // Delete the now-superseded predecessor (DELETE /v1/node and decay GC both do this).
    expect(store.removeNode(a.id)).toBe(true);

    // b is still the one live head; the orphaned prev pointer must NOT make the
    // count diverge from the authoritative getLiveNodes().
    expect(store.getLiveNodes().length).toBe(1);
    expect(store.liveNodeCount).toBe(1);            // was 0 before the fix → cap bypass
    expect(store.wouldExceedLiveCap(1)).toBe(false);

    // The cap is honored exactly: one more live node fills it, the next would exceed.
    store.insertNode(N("v3"));
    expect(store.liveNodeCount).toBe(2);
    expect(store.wouldExceedLiveCap(1)).toBe(true);
  });
});
